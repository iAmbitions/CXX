// 实时跟踪 rollout JSONL 文件的追加写入（只读实时查看的数据源）
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { open, stat } from "node:fs/promises";

const SNAPSHOT_MAX_ITEMS = 500;
const READ_CHUNK_BYTES = 1024 * 1024;
// 单条 rollout 偶尔会内嵌大图/巨大工具结果。读取层必须有界，否则一个异常条目就能
// 让 daemon 为整行分配数百 MB；超过此上限的条目按隐藏占位计数，后续消息仍可读取。
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const TRUNCATED_ITEM = Object.freeze({ type: "transport_truncated", payload: { truncated: true } });

// 文件身份指纹：首条目的哈希（对客户端是不透明串，只回传不解读）。
// 断点续传时对不上指纹＝文件已被重写/换代，须退回全量快照
export function rolloutIdent(firstItem) {
  if (firstItem === undefined) return null;
  return createHash("sha256").update(JSON.stringify(firstItem)).digest("base64url").slice(0, 16);
}

function parseRolloutLine(buffer, oversized = false) {
  if (oversized) return TRUNCATED_ITEM;
  const line = buffer.toString("utf8").trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    // 已完整换行但 JSON 损坏：保留一个不可见占位，确保条目 offset/total 不漂移。
    return TRUNCATED_ITEM;
  }
}

function appendBounded(parts, buffer, state) {
  if (!buffer.length || state.oversized) return;
  state.bytes += buffer.length;
  if (state.bytes > MAX_LINE_BYTES) {
    state.oversized = true;
    parts.length = 0;
    return;
  }
  parts.push(buffer);
}

function finishParts(parts, state, reverse = false) {
  if (state.oversized) return TRUNCATED_ITEM;
  if (!parts.length) return null;
  const buffers = reverse ? [...parts].reverse() : parts;
  return parseRolloutLine(buffers.length === 1 ? buffers[0] : Buffer.concat(buffers), false);
}

// 解析 buffer 中的完整 JSONL 行，返回 { items, rest }。
// 保留这个小块 helper 给单元测试/兼容调用；大文件读取走下方有界流式实现。
export function parseJsonlChunk(text) {
  const items = [];
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n");
    if (idx === -1) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      // 半行或损坏行：跳过（追加中的文件可能读到未写完的行，由 rest 缓冲兜底）
    }
  }
  return { items, rest };
}

async function scanRollout(path, {
  offset = 0,
  itemOffset = 0,
  limit = 0,
  initialText = "",
  initialOversized = false,
  mapItem = null,
} = {}) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const startByte = Math.max(0, Math.min(info.size, Number(offset) || 0));
    const wantedStart = Math.max(0, Number(itemOffset) || 0);
    const wantedLimit = Math.max(0, Number(limit) || 0);
    const items = [];
    let total = 0;
    let position = startByte;
    let completeSize = startByte;
    let firstItem;
    let parts = initialText ? [Buffer.from(initialText)] : [];
    let lineState = { bytes: initialText ? Buffer.byteLength(initialText) : 0, oversized: initialOversized };
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    const finishLine = () => {
      const hasRecord = lineState.oversized || lineState.bytes > 0;
      const shouldCollect = total >= wantedStart && items.length < wantedLimit;
      const shouldParse = hasRecord && (firstItem === undefined || shouldCollect);
      const item = shouldParse ? finishParts(parts, lineState) : null;
      parts = [];
      lineState = { bytes: 0, oversized: false };
      if (!hasRecord) return;
      if (firstItem === undefined) firstItem = item ?? TRUNCATED_ITEM;
      if (shouldCollect) {
        const collected = item ?? TRUNCATED_ITEM;
        items.push(mapItem ? mapItem(collected) : collected);
      }
      total++;
    };

    while (position < info.size) {
      const length = Math.min(buffer.length, info.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let from = 0;
      for (;;) {
        const newline = buffer.indexOf(10, from);
        if (newline < 0 || newline >= bytesRead) break;
        appendBounded(parts, buffer.subarray(from, newline), lineState);
        finishLine();
        completeSize = position - bytesRead + newline + 1;
        from = newline + 1;
      }
      appendBounded(parts, buffer.subarray(from, bytesRead), lineState);
    }

    const pendingText = lineState.oversized
      ? ""
      : (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
    return {
      items,
      total,
      ident: rolloutIdent(firstItem),
      size: info.size,
      fileKey: `${info.dev}:${info.ino}:${info.birthtimeMs}`,
      completeSize,
      pendingText,
      pendingOversized: lineState.oversized,
    };
  } finally {
    await handle.close();
  }
}

// 从文件尾部向前只解析最后 limit 条；不会为整个文件分配内存。total/ident 由一次
// 轻量前向扫描计算（只保留首条和末尾半行），因此数 GB 的历史也能有界打开。
async function readTailItems(path, size, limit, mapItem = null) {
  if (!size || limit <= 0) return [];
  const handle = await open(path, "r");
  try {
    const reversed = [];
    let end = size;
    let parts = [];
    let lineState = { bytes: 0, oversized: false };
    while (end > 0 && reversed.length < limit) {
      const start = Math.max(0, end - READ_CHUNK_BYTES);
      const length = end - start;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      if (!bytesRead) break;
      let chunkEnd = bytesRead;
      for (;;) {
        const newline = chunk.lastIndexOf(10, chunkEnd - 1);
        if (newline < 0) break;
        appendBounded(parts, chunk.subarray(newline + 1, chunkEnd), lineState);
        const item = finishParts(parts, lineState, true);
        parts = [];
        lineState = { bytes: 0, oversized: false };
        if (item) reversed.push(mapItem ? mapItem(item) : item);
        if (reversed.length >= limit) break;
        chunkEnd = newline;
      }
      if (reversed.length >= limit) break;
      appendBounded(parts, chunk.subarray(0, chunkEnd), lineState);
      end = start;
    }
    // 文件首条通常没有前导换行；只有扫到 byte 0 时才把剩余片段作为完整行。
    if (end === 0 && reversed.length < limit) {
      const item = finishParts(parts, lineState, true);
      if (item) reversed.push(mapItem ? mapItem(item) : item);
    }
    return reversed.reverse();
  } finally {
    await handle.close();
  }
}

export async function readRolloutTail(path, limit, { mapItem = null } = {}) {
  // 先做有界前向扫描，拿精确 total/ident/末尾半行；再只从尾部解析所需窗口。
  const summary = await scanRollout(path, { limit: 0 });
  const items = await readTailItems(path, summary.completeSize, limit, mapItem);
  return { ...summary, items };
}

// 一次性按条目窗口读取 rollout（offset/limit 为条目序号，非字节）。
// 全程固定大小分块，绝不再按文件尺寸 Buffer.alloc；超大/损坏单行降级成隐藏占位。
export async function readRolloutWindow(path, offset, limit, { mapItem = null } = {}) {
  return scanRollout(path, {
    itemOffset: Math.max(0, offset | 0),
    limit: Math.max(0, limit | 0),
    mapItem,
  });
}

export class RolloutTail {
  #path;
  #onItems;
  #onError;
  #offset = 0;
  #pendingText = "";
  #pendingOversized = false;
  #total = 0;
  #fileKey = null;
  #watcher = null;
  #reading = false;
  #dirty = false;
  #closed = false;
  #resume = null;
  #mapItem = null;
  // 读串行链：resnapshot 与 #readAppended 互斥（并发读会把同一段追加内容
  // 既并进快照又当增量重发，客户端重复渲染且续传游标多计）
  #readChain = Promise.resolve();

  constructor(path, { onItems, onError = () => {}, resume = null, mapItem = null }) {
    this.#path = path;
    this.#onItems = onItems;
    this.#onError = onError;
    this.#resume = resume; // {total, ident}：客户端声明已持有 [0,total) 的尾部窗口（断点续传）
    this.#mapItem = mapItem;
  }

  // 回填尾部最多 SNAPSHOT_MAX_ITEMS 条，然后开始监听增量。
  async start() {
    const snapshot = await this.#serialize(() => readRolloutTail(this.#path, SNAPSHOT_MAX_ITEMS, {
      mapItem: this.#mapItem,
    }));
    if (this.#closed) return;
    this.#applySnapshotState(snapshot);
    const r = this.#resume;
    const gap = r ? snapshot.total - r.total : -1;
    if (r && snapshot.ident && r.ident === snapshot.ident && gap >= 0 && gap <= SNAPSHOT_MAX_ITEMS) {
      this.#onItems(gap ? snapshot.items.slice(-gap) : [], {
        snapshot: true, append: true, total: snapshot.total, ident: snapshot.ident,
      });
    } else {
      this.#onItems(snapshot.items, { snapshot: true, total: snapshot.total, ident: snapshot.ident });
    }
    this.#watcher = watch(this.#path, () => this.#scheduleRead());
    this.#poller = setInterval(() => this.#scheduleRead(), 1500);
    this.#poller.unref?.();
  }

  async resnapshot(limit) {
    await this.#serialize(async () => {
      const snapshot = await readRolloutTail(this.#path, Math.max(1, limit | 0), {
        mapItem: this.#mapItem,
      });
      if (this.#closed) return;
      this.#applySnapshotState(snapshot);
      this.#onItems(snapshot.items, { snapshot: true, total: snapshot.total, ident: snapshot.ident });
    });
  }

  #applySnapshotState(snapshot) {
    this.#offset = snapshot.size;
    this.#pendingText = snapshot.pendingText;
    this.#pendingOversized = snapshot.pendingOversized;
    this.#total = snapshot.total;
    this.#fileKey = snapshot.fileKey ?? null;
  }

  #serialize(fn) {
    const run = this.#readChain.then(fn);
    this.#readChain = run.catch(() => {});
    return run;
  }

  #poller = null;

  #scheduleRead() {
    if (this.#closed) return;
    if (this.#reading) {
      this.#dirty = true;
      return;
    }
    this.#reading = true;
    this.#serialize(() => this.#readAppended())
      .catch((err) => this.#onError(err))
      .finally(() => {
        this.#reading = false;
        if (this.#dirty) {
          this.#dirty = false;
          this.#scheduleRead();
        }
      });
  }

  async #readAppended() {
    const info = await stat(this.#path);
    const fileKey = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (info.size === this.#offset && fileKey === this.#fileKey) return;
    // 文件被截断或原子替换：旧字节游标已失效，直接下发新的尾部快照。
    // OpenCode 适配层会把 API 消息快照写到临时文件后 rename，文件可能比旧文件更大，
    // 因此不能只比较 size，还必须比较 inode/出生时间。
    if (info.size < this.#offset || (this.#fileKey && fileKey !== this.#fileKey)) {
      const snapshot = await readRolloutTail(this.#path, SNAPSHOT_MAX_ITEMS, {
        mapItem: this.#mapItem,
      });
      if (this.#closed) return;
      this.#applySnapshotState(snapshot);
      this.#onItems(snapshot.items, { snapshot: true, total: snapshot.total, ident: snapshot.ident });
      return;
    }
    const result = await scanRollout(this.#path, {
      offset: this.#offset,
      limit: Number.MAX_SAFE_INTEGER,
      initialText: this.#pendingText,
      initialOversized: this.#pendingOversized,
      mapItem: this.#mapItem,
    });
    this.#offset = result.size;
    this.#fileKey = result.fileKey ?? fileKey;
    this.#pendingText = result.pendingText;
    this.#pendingOversized = result.pendingOversized;
    this.#total += result.total;
    if (result.items.length > 0 && !this.#closed) this.#onItems(result.items, { snapshot: false });
  }

  close() {
    this.#closed = true;
    this.#watcher?.close();
    if (this.#poller) clearInterval(this.#poller);
  }
}

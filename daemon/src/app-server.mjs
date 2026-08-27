// 拉起并驱动 codex app-server（JSON-RPC over WebSocket）
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { codexInvocation } from "./codex-path.mjs";
import { killProcessTree, reapStalePids, writePidFile } from "./proc-reap.mjs";
import { CachedProjects } from "./project-index.mjs";
import { readCodexConfiguredModel } from "./codex-models.mjs";

// 清理上一条 daemon 生命周期遗留的 codex（进程被 SIGKILL/崩溃时来不及走 stop 的兜底）。
// 认主 + 命令行验身的通用逻辑在 proc-reap.mjs；这里只提供 codex 的身份正则。
// 启动时在 spawn 新实例之前调用。
export function reapStaleAppServer(pidFile, log = () => {}) {
  reapStalePids(pidFile, /codex\b.*app-server.*--listen ws:\/\/127\.0\.0\.1/, {
    log,
    label: "codex app-server",
  });
}

export function singleFlight(inFlight, key, task) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(task);
  inFlight.set(key, pending);
  pending.finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }).catch(() => {});
  return pending;
}

export function appServerSpawnOptions(env = null) {
  return {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    // launchd 不继承用户 shell 中的 OPENAI_API_KEY / 自定义 provider token。
    // main 在启动时安全采集一次登录 shell 环境并传进来；值绝不写日志。
    ...(env ? { env } : {}),
    // 自成进程组：codex 的 node wrapper 不转发信号给原生子进程，只有成组后
    // stop() 才能用负 pid 把 wrapper+原生一并带走，不留孤儿（见 killProcessTree）。
    detached: true,
  };
}

export class AppServer {
  #command;
  #port;
  #child = null;
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  // Codex 首次 thread/list 会建立/恢复会话索引；同一时刻首页、项目索引和外部同步
  // 可能请求同一页。合并完全相同的请求，避免重复扫描超大会话文件。
  #threadListInFlight = new Map();
  #log;
  #env;
  #closed = false;
  #pidFile = null; // 记录子进程 pid，供下次启动清理崩溃残留（见 reapStaleAppServer）
  // 首页「按项目」聚合缓存：本地全量扫描一次分组，projects.list 命中即 0 往返（见 project-index.mjs）
  #projects = new CachedProjects(() => this.listThreads(5000));

  onNotification = () => {}; // (method, params)
  onServerRequest = () => {}; // (id, method, params) —— 审批等，需调用 respond(id, result)
  onStateChange = () => {}; // (healthy: bool) —— 引擎掉线/恢复时回调（远端诊断用）

  // 引擎当前是否可用（app-server 进程活着且 WS 已连上）
  get healthy() {
    return this.#ws !== null;
  }

  constructor({ command = "codex", port = 19271, log = () => {}, pidFile = null, env = null } = {}) {
    this.#command = command;
    this.#port = port;
    this.#log = log;
    this.#pidFile = pidFile;
    this.#env = env;
  }

  get url() {
    return `ws://127.0.0.1:${this.#port}`;
  }

  // 仅读取当前用户的 Codex 配置，不把 token 或 provider 配置暴露给手机端。
  configuredModelId() {
    return readCodexConfiguredModel();
  }

  async start() {
    this.#closed = false;
    try {
      await this.#spawnAndConnect();
    } catch (err) {
      // 启动阶段失败时必须同时收掉已 spawn 的 wrapper + 原生子进程。否则 launchd
      // 重拉 daemon 时旧子进程还在冷启动，会抢端口并叠成持续重启风暴。
      this.stop();
      throw err;
    }
  }

  async #spawnAndConnect() {
    const invocation = codexInvocation(this.#command, ["app-server", "--listen", this.url]);
    if (invocation.command !== this.#command) {
      this.#log(`codex 是 Node 启动脚本，使用绝对解释器: ${invocation.command}`);
    }
    this.#child = spawn(invocation.command, invocation.args, appServerSpawnOptions(this.#env));
    // 记录 pid：本次若被 SIGKILL/崩溃来不及 stop，下次启动靠它清理残留（reapStaleAppServer）
    if (this.#pidFile && this.#child.pid) {
      writePidFile(this.#pidFile, [this.#child.pid], this.#log);
    }
    const spawnError = new Promise((resolve) => {
      this.#child.once("error", (err) => {
        this.#log(`app-server 启动进程失败: ${err.message}`);
        this.onStateChange(false);
        resolve(err);
      });
    });
    this.#child.stderr?.on("data", (chunk) => this.#log(`[app-server] ${chunk}`.trimEnd()));
    this.#child.on("exit", (code) => {
      this.#log(`app-server 退出（code=${code}）`);
      this.#ws = null;
      this.onStateChange(false);
      if (!this.#closed) {
        // 自动重拉，避免引擎崩溃导致远程永久不可用
        delay(2000).then(() => this.#spawnAndConnect().catch((err) => this.#log(String(err))));
      }
    });

    const err = await Promise.race([this.#waitReady().then(() => null), spawnError]);
    if (err) throw err;
    await this.#connect();
  }

  async #waitReady() {
    // LaunchAgent 使用 Background QoS，系统繁忙或冷启动时 Codex 的插件/配置初始化
    // 可能明显慢于终端直跑。15s 会误杀仍在正常启动的进程并触发 launchd 重启循环。
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.#port}/readyz`);
        if (res.ok) return;
      } catch {
        // 尚未就绪
      }
      await delay(200);
    }
    throw new Error("app-server 启动超时");
  }

  async #connect() {
    const ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("无法连接 app-server"));
    });
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onclose = () => {
      const wasHealthy = this.#ws !== null;
      this.#ws = null;
      for (const [, pending] of this.#pending) {
        pending.reject(new Error("app-server 连接断开"));
      }
      this.#pending.clear();
      if (wasHealthy) this.onStateChange(false);
    };
    this.#ws = ws;
    await this.request("initialize", {
      clientInfo: { name: "cxx-remote-daemon", version: "0.1.0" },
      // 计划模式（collaborationMode）、thread/goal 等在 experimental 能力门之后
      capabilities: { experimentalApi: true },
    });
    // 握手收尾：app-server 需收到 initialized 通知后才服务会话级方法
    // （thread/resume、thread/start、turn/start）；缺此步这些请求会挂起超时。
    this.notify("initialized", {});
    this.onStateChange(true);
  }

  notify(method, params = {}) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 我方请求的响应
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "app-server 错误"));
      else resolve(msg.result);
      return;
    }
    // 服务端主动请求（有 id + method）：审批等，需要我方回 response
    if (msg.id !== undefined && msg.method) {
      try {
        this.onServerRequest(msg.id, msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理服务端请求失败: ${err.message}`);
      }
      return;
    }
    // 通知（有 method 无 id）
    if (msg.method) {
      try {
        this.onNotification(msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理通知失败: ${err.message}`);
      }
    }
  }

  // 应答服务端请求（审批决定）
  respond(id, result) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id, code, message) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (!this.#ws) return Promise.reject(new Error("app-server 未连接"));
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`app-server 请求超时: ${method}`));
        }
      }, timeoutMs).unref?.();
    });
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  // thread/list 的冷启动实测可超过 30 秒（尤其存在数 GB rollout 时）。它只是本地索引读取，
  // 不能沿用普通 RPC 的 15 秒超时；并发相同页必须单飞，否则 projects.list、首页 head page
  // 和外部会话同步会让 Codex 同时重复扫描，反而把一次慢请求放大成持续超时。
  #requestThreadList(params) {
    const key = JSON.stringify(params);
    return singleFlight(this.#threadListInFlight, key, () =>
      this.request("thread/list", params, this.#THREAD_LIST_TIMEOUT));
  }

  // 引擎 thread 条目 → 手机端精简视图（含 rollout path，仅 daemon 内部用）
  #mapThread(t) {
    return {
      id: t.id,
      preview: t.preview ?? "",
      name: t.name ?? null,
      cwd: t.cwd ?? "",
      updatedAt: t.updatedAt ?? null,
      source: t.source ?? "",
      status: t.status?.type ?? "unknown",
      archived: Boolean(t.archived ?? t.archivedAt ?? t.archived_at),
      path: t.path ?? null,
    };
  }

  // 分批拉取（供 sessions.list 分页应答）。无 cwd 时按引擎游标分页；有 cwd 时直接从
  // projects.list 已建立的同一份项目索引分页，避免用户展开项目时再次请求引擎、长时间等待。
  // 单帧仍封顶 2000 条，避免挤爆 relay 的 256KiB 帧上限。
  async listThreadsPage({ cursor = null, limit = 2000, cwd = null } = {}) {
    if (cwd) return this.#projects.page(cwd, { cursor, limit });
    const target = Math.max(1, Math.min(2000, limit | 0)); // 封顶 2000：压缩后仍稳在 256KiB 内
    const items = [];
    let cur = cursor;
    // 引擎单页上限 100，故内部最多翻 ceil(target/100) 页才能凑够 target（+1 容错）
    const maxPages = Math.ceil(target / 100) + 1;
    for (let i = 0; i < maxPages && items.length < target; i++) {
      const params = { limit: 100, archived: false }; // 引擎单页上限；手机端只展示未归档会话
      if (cur) params.cursor = cur;
      const result = await this.#requestThreadList(params);
      const batch = result?.data ?? [];
      items.push(...batch);
      cur = result?.nextCursor ?? null;
      if (!cur || batch.length === 0) break; // 到底了
    }
    return { items: items.map((t) => this.#mapThread(t)), nextCursor: cur };
  }

  // 首页「按项目」聚合：一次本地全量扫描分组（TTL 缓存 + 单飞），一帧回全部项目，
  // 与会话总量无关地只需 1 次往返。运行/审批徽标由 client-session 实时从 hub 叠加。
  aggregateProjects({ fresh = false } = {}) {
    return this.#projects.get({ fresh });
  }

  // 会话集合变化（新建会话等）后调用，令下次 projects.list 重新扫描而非等 TTL 过期。
  invalidateProjects() {
    this.#projects.invalidate();
  }

  // 按 id 直接读单个会话（thread/read 返回含 rollout path 的 Thread）。
  // watch/share 用它解析会话文件路径，不再依赖 listThreads 扫描——排在很深处的
  // 老会话（翻很多页才到）也能被正确解析、打开。
  async readThread(threadId) {
    try {
      const result = await this.request("thread/read", { threadId });
      return result?.thread ? this.#mapThread(result.thread) : null;
    } catch {
      return null;
    }
  }

  async archiveThread(threadId) {
    await this.request("thread/archive", { threadId }, this.#SESSION_TIMEOUT);
    this.invalidateProjects();
    return { ok: true };
  }

  async unarchiveThread(threadId) {
    await this.request("thread/unarchive", { threadId }, this.#SESSION_TIMEOUT);
    this.invalidateProjects();
    return { ok: true };
  }

  // 跨页累计到 limit（daemon 内部用：昵称缓存等）。会去重、按更新时间新→旧排序。
  // 注意：结果体量可能很大，切勿整份塞进单个 E2E 帧发给客户端（用 listThreadsPage）。
  async listThreads(limit = 1000) {
    const target = Math.max(1, limit | 0);
    const pageSize = Math.min(100, target); // 引擎单页上限 100
    const items = [];
    let cursor = null;
    for (let guard = 0; guard < 60 && items.length < target; guard++) {
      const params = { limit: pageSize, archived: false };
      if (cursor) params.cursor = cursor;
      const result = await this.#requestThreadList(params);
      const batch = result?.data ?? [];
      items.push(...batch);
      cursor = result?.nextCursor ?? null;
      if (!cursor || batch.length === 0) break; // 没有下一页了
    }
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      if (it?.id && !seen.has(it.id)) {
        seen.add(it.id);
        unique.push(it);
      }
    }
    unique.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return unique.slice(0, target).map((t) => this.#mapThread(t));
  }

  // thread/list 首次读取会建立本地索引；本机 5.2GB 会话库实测冷读约 30 秒。
  // 留足 75 秒但不无限等待，手机端列表请求使用稍长的 90 秒外层超时。
  #THREAD_LIST_TIMEOUT = 75000;

  // 会话级方法可能因模型初始化/网络（如国内访问模型列表）而较慢，
  // 用更长的超时；实测 resume 在网络不佳时约 16s。
  #SESSION_TIMEOUT = 90000;

  // 恢复会话到本 app-server 实例（幂等，daemon 侧去重）
  resumeThread(threadId, overrides = {}) {
    return this.request("thread/resume", { threadId, ...overrides }, this.#SESSION_TIMEOUT);
  }

  // 手机不再查看且该会话没有运行中的轮次时，主动释放 app-server 对 thread 的订阅。
  // 否则独立的口袋Agent app-server 会继续占着会话，官方桌面端会提示
  // “已在另一个应用中打开”。旧版 Codex 不支持该方法时由 SessionHub 降级处理。
  unsubscribeThread(threadId) {
    return this.request("thread/unsubscribe", { threadId }, this.#SESSION_TIMEOUT);
  }

  // 发起一轮对话（input 为字符串，或 turn/start 输入项数组——文本+图片混合时用后者），
  // 返回 { turnId? }
  startTurn(threadId, input, overrides = {}) {
    const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
    return this.request(
      "turn/start",
      { threadId, input: items, ...overrides },
      this.#SESSION_TIMEOUT,
    );
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  startThread(params = {}) {
    return this.request("thread/start", params, this.#SESSION_TIMEOUT);
  }

  forkThread(threadId) {
    return this.request("thread/fork", { threadId, excludeTurns: true }, this.#SESSION_TIMEOUT);
  }

  stop() {
    this.#closed = true;
    this.#ws?.close();
    killProcessTree(this.#child?.pid, this.#log);
    if (this.#pidFile) {
      try { rmSync(this.#pidFile); } catch {}
    }
  }
}

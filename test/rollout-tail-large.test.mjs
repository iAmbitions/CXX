import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRolloutTail, readRolloutWindow, RolloutTail } from "../daemon/src/rollout-tail.mjs";

async function withTempRollout(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), "pocket-agent-rollout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "rollout.jsonl");
  await fn(path);
}

const item = (n) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `消息 ${n}` } });

test("readRolloutWindow 按条目分页且保留精确 total", async (t) => {
  await withTempRollout(t, async (path) => {
    await writeFile(path, Array.from({ length: 1200 }, (_, i) => item(i)).join("\n") + "\n");
    const result = await readRolloutWindow(path, 500, 3);
    assert.equal(result.total, 1200);
    assert.deepEqual(result.items.map((x) => x.payload.message), ["消息 500", "消息 501", "消息 502"]);
    assert.ok(result.ident);
  });
});

test("尾部读取只返回所需窗口，并忽略尚未换行的半条记录", async (t) => {
  await withTempRollout(t, async (path) => {
    await writeFile(path, Array.from({ length: 700 }, (_, i) => item(i)).join("\n") + "\n" + item(700).slice(0, 20));
    const result = await readRolloutTail(path, 5);
    assert.equal(result.total, 700);
    assert.deepEqual(result.items.map((x) => x.payload.message), ["消息 695", "消息 696", "消息 697", "消息 698", "消息 699"]);
    assert.ok(result.pendingText.length > 0);
    assert.equal(result.completeSize < result.size, true);
  });
});

test("超大单行不会阻断后续会话消息", async (t) => {
  await withTempRollout(t, async (path) => {
    // 17 MiB 超过读取层单行预算。使用稀疏扩展后补换行，避免测试构造同尺寸字符串。
    await writeFile(path, "{\"oversized\":\"");
    await truncate(path, 17 * 1024 * 1024);
    await appendFile(path, "\"}\n" + item(2) + "\n" + item(3) + "\n");
    const result = await readRolloutTail(path, 3);
    assert.equal(result.total, 3);
    assert.equal(result.items[0].payload.truncated, true);
    assert.deepEqual(result.items.slice(1).map((x) => x.payload.message), ["消息 2", "消息 3"]);
  });
});

test("RolloutTail 首屏只发尾部窗口，断点续传只补缺口", async (t) => {
  await withTempRollout(t, async (path) => {
    const all = Array.from({ length: 620 }, (_, i) => item(i));
    await writeFile(path, all.join("\n") + "\n");
    const firstFrames = [];
    const first = new RolloutTail(path, { onItems: (items, meta) => firstFrames.push({ items, meta }) });
    t.after(() => first.close());
    await first.start();
    assert.equal(firstFrames.length, 1);
    assert.equal(firstFrames[0].meta.total, 620);
    assert.equal(firstFrames[0].items.length, 500);
    assert.equal(firstFrames[0].items[0].payload.message, "消息 120");

    const resumeFrames = [];
    const resumed = new RolloutTail(path, {
      resume: { total: 618, ident: firstFrames[0].meta.ident },
      onItems: (items, meta) => resumeFrames.push({ items, meta }),
    });
    t.after(() => resumed.close());
    await resumed.start();
    assert.equal(resumeFrames.length, 1);
    assert.equal(resumeFrames[0].meta.append, true);
    assert.deepEqual(resumeFrames[0].items.map((x) => x.payload.message), ["消息 618", "消息 619"]);
  });
});

test("读取时可先瘦身条目，避免尾部窗口长期持有大 metadata", async (t) => {
  await withTempRollout(t, async (path) => {
    await writeFile(path, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "回答" }], metadata: "x".repeat(2_000_000) } }),
      item(2),
    ].join("\n") + "\n");
    const result = await readRolloutTail(path, 2, {
      mapItem: (entry) => ({ type: entry.type, payload: { type: entry.payload?.type, message: entry.payload?.message } }),
    });
    assert.ok(JSON.stringify(result.items).length < 1000);
    assert.equal(result.total, 2);
  });
});

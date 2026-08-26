import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const webSource = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

function queueSource() {
  const start = webSource.indexOf("// —— 运行中排队：轮次结束（setRunning(false)）后逐条发出 ——");
  const end = webSource.indexOf("// —— 图片附件：选图/拍照 -> 压缩 -> 缩略图预览 -> 分块上传 ——", start);
  assert.ok(start >= 0 && end > start, "queue persistence source should be present");
  return webSource.slice(start, end);
}

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

function makeNode() {
  return {
    children: [],
    innerHTML: "",
    className: "",
    textContent: "",
    title: "",
    disabled: false,
    classList: { add() {}, toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    remove() {},
  };
}

function makeSandbox() {
  const localStorage = makeStorage();
  const input = { value: "" };
  const log = makeNode();
  const queuePanel = makeNode();
  const app = {
    currentId: "thread-1",
    agent: "codex",
    isViewer: false,
    draft: null,
    queue: [],
    queueCollapsed: false,
    session: { info: { id: "daemon-1" } },
    view: "session",
    attachments: [],
  };
  const sandbox = {
    app,
    localStorage,
    MAX_ATTACH: 4,
    net: { link: "ok", daemon: true },
    isDraftSession: () => false,
    $: (id) => id === "input" ? input : id === "queuepanel" ? queuePanel : log,
    document: { createElement: () => makeNode() },
    echoBubble: () => ({ classList: { add() {} }, remove() {}, onclick: null }),
    setEchoNote() {},
    t: (key) => key,
    renderAttachments() {},
    autoGrow() {},
    updateSendState() {},
    scrollToBottom() {},
    dispatch: async () => true,
  };
  vm.runInNewContext(`${queueSource()}\nglobalThis.queueApi = { persistQueue, restoreQueue, flushQueue, queueStoreKey, moveQueuedMessage, removeQueuedMessage, toggleQueuePanel };`, sandbox);
  return { sandbox, app, localStorage };
}

test("排队消息会按电脑、agent 和会话持久化，并能在重进页面后恢复", () => {
  const first = makeSandbox();
  first.app.queue = [{ text: "本轮结束后继续", atts: [], el: null }];
  first.sandbox.queueApi.persistQueue();

  const key = first.sandbox.queueApi.queueStoreKey();
  assert.deepEqual(JSON.parse(first.localStorage.getItem(key)).items, [{ text: "本轮结束后继续", atts: [] }]);

  const second = makeSandbox();
  second.localStorage.data.set(key, first.localStorage.getItem(key));
  second.sandbox.queueApi.restoreQueue();
  assert.equal(second.app.queue.length, 1);
  assert.equal(second.app.queue[0].text, "本轮结束后继续");
});

test("队列收起态会和待发消息一起跨刷新保存", () => {
  const first = makeSandbox();
  first.app.queue = [{ text: "折叠也要记住", atts: [], el: null }];
  first.app.queueCollapsed = true;
  first.sandbox.queueApi.persistQueue();
  const key = first.sandbox.queueApi.queueStoreKey();
  assert.equal(JSON.parse(first.localStorage.getItem(key)).collapsed, true);

  const second = makeSandbox();
  second.localStorage.data.set(key, first.localStorage.getItem(key));
  second.sandbox.queueApi.restoreQueue();
  assert.equal(second.app.queueCollapsed, true);
});

test("队列仅在 daemon 确认接收后才从持久化存储移除", async () => {
  const { sandbox, app, localStorage } = makeSandbox();
  app.queue = [{ text: "不要丢", atts: [], el: null }];
  sandbox.queueApi.persistQueue();
  const key = sandbox.queueApi.queueStoreKey();

  await sandbox.queueApi.flushQueue();
  assert.equal(app.queue.length, 0);
  assert.equal(localStorage.getItem(key), null);
});


test("队列允许上移、下移和删除，且每次操作都会同步持久化", () => {
  const { sandbox, app, localStorage } = makeSandbox();
  const first = { text: "第一条", atts: [], el: null };
  const second = { text: "第二条", atts: [], el: null };
  const third = { text: "第三条", atts: [], el: null };
  app.queue = [first, second, third];
  sandbox.queueApi.persistQueue();

  sandbox.queueApi.moveQueuedMessage(third, -1);
  assert.deepEqual(app.queue.map((q) => q.text), ["第一条", "第三条", "第二条"]);
  const key = sandbox.queueApi.queueStoreKey();
  assert.deepEqual(JSON.parse(localStorage.getItem(key)).items.map((q) => q.text), ["第一条", "第三条", "第二条"]);

  sandbox.queueApi.removeQueuedMessage(third);
  assert.deepEqual(app.queue.map((q) => q.text), ["第一条", "第二条"]);
});

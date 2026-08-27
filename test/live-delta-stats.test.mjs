import assert from "node:assert/strict";
import test from "node:test";

import { SessionHub } from "../daemon/src/session-hub.mjs";

test("hub logs the raw upstream delta cadence at turn completion", async () => {
  const appServer = {};
  const logs = [];
  const hub = new SessionHub(appServer, { log: (line) => logs.push(line) });
  hub.subscribe("thread-1", { pushLiveEvent() {} });
  appServer.onNotification("turn/started", { threadId: "thread-1", turnId: "turn-1" });
  appServer.onNotification("item/agentMessage/delta", {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "a",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  appServer.onNotification("item/agentMessage/delta", {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "b",
  });
  appServer.onNotification("turn/completed", { threadId: "thread-1", turnId: "turn-1" });
  assert.match(logs.at(-1), /delta 采样: agent=codex .* raw=2 .* avgGap=\d+ms/);
});


test("hub normalizes upstream turn errors so old phone clients receive turn/failed", () => {
  const appServer = {};
  const events = [];
  const logs = [];
  const hub = new SessionHub(appServer, { log: (line) => logs.push(line) });
  hub.subscribe("thread-err", { pushLiveEvent: (...args) => events.push(args) });
  appServer.onNotification("turn/started", { threadId: "thread-err", turnId: "turn-err" });
  assert.equal(hub.isRunning("thread-err"), true);
  appServer.onNotification("turn/error", {
    threadId: "thread-err",
    turnId: "turn-err",
    error: { message: "upstream quota exhausted" },
  });
  assert.equal(hub.isRunning("thread-err"), false);
  assert.deepEqual(events.at(-1), [
    "thread-err",
    "turn/failed",
    { threadId: "thread-err", turnId: "turn-err", error: { message: "upstream quota exhausted" } },
  ]);
  assert.ok(logs.some((line) => line.includes("upstream quota exhausted")));
});

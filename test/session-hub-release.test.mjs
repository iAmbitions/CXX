import assert from "node:assert/strict";
import test from "node:test";

import { SessionHub } from "../daemon/src/session-hub.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ unsubscribeError = null } = {}) {
  const calls = [];
  const backend = {
    onNotification: null,
    onServerRequest: null,
    onServerRequestCancel: null,
    resumeThread: async (threadId) => { calls.push(["resume", threadId]); return {}; },
    unsubscribeThread: async (threadId) => {
      calls.push(["unsubscribe", threadId]);
      if (unsubscribeError) throw unsubscribeError;
      return { status: "unsubscribed" };
    },
    startTurn: async (threadId) => ({ turnId: `turn-${threadId}` }),
    invalidateProjects() {},
  };
  return { backend, hub: new SessionHub(backend), calls };
}

test("terminal event releases a resumed thread after its last watcher left", async () => {
  const { backend, hub, calls } = fixture();
  const client = { pushLiveEvent() {} };
  hub.subscribe("s1", client);
  await hub.sendMessage("s1", "hello");
  hub.unsubscribe("s1", client);
  backend.onNotification("turn/completed", { threadId: "s1", turnId: "turn-s1" });
  await tick();
  assert.deepEqual(calls, [["resume", "s1"], ["unsubscribe", "s1"]]);
  assert.equal(hub.hasResumed("s1"), false);
});

test("one phone leaving does not release a thread still watched by another phone", async () => {
  const { backend, hub, calls } = fixture();
  const a = { pushLiveEvent() {} };
  const b = { pushLiveEvent() {} };
  hub.subscribe("s1", a);
  hub.subscribe("s1", b);
  await hub.sendMessage("s1", "hello");
  backend.onNotification("turn/completed", { threadId: "s1", turnId: "turn-s1" });
  hub.unsubscribe("s1", a);
  await tick();
  assert.equal(calls.filter(([name]) => name === "unsubscribe").length, 0);
  hub.unsubscribe("s1", b);
  await tick();
  assert.equal(calls.filter(([name]) => name === "unsubscribe").length, 1);
});

test("a new turn waits for an in-flight unsubscribe and resumes again", async () => {
  let finishRelease;
  const releaseGate = new Promise((resolve) => { finishRelease = resolve; });
  const calls = [];
  const backend = {
    onNotification: null, onServerRequest: null, onServerRequestCancel: null,
    resumeThread: async (id) => { calls.push(["resume", id]); },
    unsubscribeThread: async (id) => { calls.push(["unsubscribe", id]); await releaseGate; },
    startTurn: async (id) => ({ turnId: `turn-${id}` }), invalidateProjects() {},
  };
  const hub = new SessionHub(backend);
  const client = { pushLiveEvent() {} };
  hub.subscribe("s1", client);
  await hub.sendMessage("s1", "first");
  backend.onNotification("turn/completed", { threadId: "s1" });
  hub.unsubscribe("s1", client);
  await tick();

  const next = hub.sendMessage("s1", "second");
  await tick();
  assert.equal(calls.filter(([name]) => name === "resume").length, 1);
  finishRelease();
  await next;
  assert.equal(calls.filter(([name]) => name === "resume").length, 2);
});

test("unsupported unsubscribe is best-effort and next message resumes cleanly", async () => {
  const { backend, hub, calls } = fixture({ unsubscribeError: new Error("method not found") });
  const client = { pushLiveEvent() {} };
  hub.subscribe("s1", client);
  await hub.sendMessage("s1", "first");
  backend.onNotification("turn/completed", { threadId: "s1" });
  hub.unsubscribe("s1", client);
  await tick();
  await hub.sendMessage("s1", "second");
  assert.equal(calls.filter(([name]) => name === "resume").length, 2);
});

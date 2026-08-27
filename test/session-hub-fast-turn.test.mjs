import assert from "node:assert/strict";
import test from "node:test";
import { SessionHub } from "../daemon/src/session-hub.mjs";

test("terminal event arriving before startTurn resolves does not resurrect running state", async () => {
  const backend = {
    onNotification: null, onServerRequest: null, onServerRequestCancel: null,
    resumeThread: async () => ({}), invalidateProjects() {},
    startTurn: async (threadId) => {
      backend.onNotification("turn/started", { threadId, turnId: "fast" });
      backend.onNotification("turn/completed", { threadId, turnId: "fast" });
      return { turnId: "fast" };
    },
  };
  const hub = new SessionHub(backend);
  await hub.sendMessage("s1", "hello");
  assert.equal(hub.isRunning("s1"), false);
});

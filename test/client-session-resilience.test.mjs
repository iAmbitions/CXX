import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClientSession } from "../daemon/src/client-session.mjs";
import { issueDeviceToken, loadOrCreateConfig } from "../daemon/src/config.mjs";
import {
  deriveSessionKey,
  generateKeyPair,
  open,
  privateKeyFromPem,
  seal,
} from "../daemon/src/crypto.mjs";

function createAuthenticatedSession({ listThreadsPage, running = false }) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-agent-client-session-"));
  const rolloutPath = join(dir, "rollout.jsonl");
  writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_complete" },
  })}\n`);
  const configPath = join(dir, "daemon.json");
  const config = loadOrCreateConfig(configPath);
  const { deviceToken } = issueDeviceToken(configPath, config, { name: "Test phone" });
  const freshConfig = loadOrCreateConfig(configPath);
  const clientKeys = generateKeyPair();
  const key = deriveSessionKey(
    privateKeyFromPem(clientKeys.privateKeyPem),
    Buffer.from(freshConfig.publicKey, "base64"),
    freshConfig.daemonId,
  );
  const sent = [];
  let closes = 0;
  const hub = {
    registerClient() {},
    removeClient() {},
    subscribe() {},
    unsubscribe() {},
    hasResumed() { return true; },
    isRunning() { return running; },
    approvalCount() { return 0; },
  };
  const backend = {
    healthy: true,
    listThreadsPage,
    async readThread(id) {
      return { id, path: rolloutPath, cwd: dir, name: "Test", updatedAt: Date.now() / 1000 };
    },
  };
  const session = new ClientSession("test-client", {
    config: freshConfig,
    configPath,
    privateKey: privateKeyFromPem(freshConfig.privateKeyPem),
    appServer: backend,
    backends: { codex: backend },
    hub,
    hubs: { codex: hub },
    log() {},
  }, {
    send(envelope) { sent.push(envelope); },
    close() { closes += 1; },
    getBufferedAmount() { return 0; },
  });

  const encode = (payload, first = false) => {
    const envelope = seal(key, "c2d", payload);
    if (first) {
      envelope.v = 1;
      envelope.k = clientKeys.publicKeyRaw.toString("base64");
    }
    return envelope;
  };
  const decode = (envelope) => open(key, "d2c", envelope);

  return { dir, session, sent, encode, decode, deviceToken, get closes() { return closes; } };
}

test("业务请求超时只返回 RPC 错误，不断开手机连接", async () => {
  const fx = createAuthenticatedSession({
    listThreadsPage: async () => { throw new Error("app-server 请求超时: thread/list"); },
  });
  try {
    await fx.session.onEnvelope(fx.encode({
      id: 1,
      method: "auth",
      params: { deviceToken: fx.deviceToken, protocol: 1, name: "Test phone" },
    }, true));
    assert.equal(fx.closes, 0);
    assert.equal(fx.decode(fx.sent.at(-1)).id, 1);

    await fx.session.onEnvelope(fx.encode({ id: 2, method: "sessions.list", params: { limit: 100 } }));
    assert.equal(fx.closes, 0, "普通后端超时不应关闭 WebSocket");
    assert.deepEqual(fx.decode(fx.sent.at(-1)), {
      id: 2,
      error: { code: 500, message: "app-server 请求超时: thread/list" },
    });

    await fx.session.onEnvelope(fx.encode({ id: 3, method: "ping", params: {} }));
    assert.equal(fx.closes, 0);
    assert.deepEqual(fx.decode(fx.sent.at(-1)), { method: "pong", params: {} });
  } finally {
    fx.session.dispose();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("session.watch returns authoritative daemon running state", async () => {
  for (const running of [false, true]) {
    const fx = createAuthenticatedSession({
      running,
      listThreadsPage: async () => ({ items: [], nextCursor: null }),
    });
    try {
      await fx.session.onEnvelope(fx.encode({
        id: 1,
        method: "auth",
        params: { deviceToken: fx.deviceToken, protocol: 1, name: "Test phone" },
      }, true));
      await fx.session.onEnvelope(fx.encode({
        id: 2,
        method: "session.watch",
        params: { sessionId: "thread-fast", agent: "codex", wt: `watch-${running}` },
      }));
      const reply = fx.sent.map(fx.decode).find((message) => message.id === 2);
      assert.equal(reply.result.mode, "tail");
      assert.equal(reply.result.running, running);
    } finally {
      fx.session.dispose();
      rmSync(fx.dir, { recursive: true, force: true });
    }
  }
});

test("损坏的加密信封仍会立即断开", async () => {
  const fx = createAuthenticatedSession({
    listThreadsPage: async () => ({ items: [], nextCursor: null }),
  });
  try {
    await fx.session.onEnvelope(fx.encode({
      id: 1,
      method: "auth",
      params: { deviceToken: fx.deviceToken, protocol: 1 },
    }, true));
    assert.equal(fx.closes, 0);

    await fx.session.onEnvelope({ n: "broken", c: "broken" });
    assert.equal(fx.closes, 1);
  } finally {
    fx.session.dispose();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

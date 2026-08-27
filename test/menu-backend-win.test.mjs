import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { pair, pairOnce, pairPermanent } from "../daemon/src/menu-backend.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "cxx-menu-win-"));
  const configPath = join(dir, "daemon.json");
  const config = loadOrCreateConfig(configPath);
  config.relayUrl = "wss://relay.wokey.ai";
  config.webUrl = "https://example.test/CXX/";
  saveConfig(configPath, config);
  return {
    dir,
    deps: {
      configPath,
      platform: "win32",
      isRunning: () => false,
      log: () => {},
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Windows pair returns a one-time QR without pre-creating a device", () => {
  const h = harness();
  try {
    const res = pair(h.deps);
    assert.match(res.url, /#p=/);
    assert.ok(res.qrPath);
    assert.equal(existsSync(res.qrPath), true);
    assert.equal(loadOrCreateConfig(h.deps.configPath).devices.length, 0);
    rmSync(res.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});

test("Windows pair-once remains a one-time pairing alias", () => {
  const h = harness();
  try {
    const res = pairOnce(h.deps);
    assert.match(res.url, /#p=/);
    assert.ok(res.qrPath);
    assert.equal(existsSync(res.qrPath), true);
    assert.equal(loadOrCreateConfig(h.deps.configPath).devices.length, 0);
    rmSync(res.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});


test("Windows pair-permanent creates a long-lived device link", () => {
  const h = harness();
  try {
    const res = pairPermanent(h.deps);
    assert.match(res.url, /#d=/);
    assert.ok(res.qrPath);
    assert.equal(existsSync(res.qrPath), true);
    const config = loadOrCreateConfig(h.deps.configPath);
    assert.equal(config.devices.length, 1);
    assert.equal(config.devices[0].lastSeenAt, null);
    rmSync(res.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});

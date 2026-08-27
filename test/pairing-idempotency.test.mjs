import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consumePairToken, issuePairToken, loadOrCreateConfig } from "../daemon/src/config.mjs";

test("re-pairing with an existing device token reuses the device", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-agent-pair-"));
  const path = join(dir, "daemon.json");
  try {
    let config = loadOrCreateConfig(path);
    const firstPair = issuePairToken(path, config);
    const first = consumePairToken(path, firstPair);
    assert.ok(first?.deviceToken);
    assert.equal(first.config.devices.length, 1);

    config = loadOrCreateConfig(path);
    const secondPair = issuePairToken(path, config);
    const second = consumePairToken(path, secondPair, { reuseDeviceToken: first.deviceToken });
    assert.equal(second?.reused, true);
    assert.equal(second?.device.deviceId, first.device.deviceId);
    assert.equal(second?.deviceToken, first.deviceToken);
    assert.equal(second?.config.devices.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

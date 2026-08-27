import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { groupDevices, listDevices, ungroupDevice } from "../daemon/src/menu-backend.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pocket-agent-device-group-"));
  const configPath = join(dir, "daemon.json");
  const config = loadOrCreateConfig(configPath);
  config.devices = [
    { deviceId: "chrome", tokenHash: "a", name: "荣耀 · Chrome", createdAt: 1, lastSeenAt: 10 },
    { deviceId: "wechat", tokenHash: "b", name: "荣耀 · 微信", createdAt: 2, lastSeenAt: 20 },
    { deviceId: "unused", tokenHash: "c", name: "未连接", createdAt: 3, lastSeenAt: null },
  ];
  saveConfig(configPath, config);
  return { configPath, isRunning: () => false, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("手动归并仅添加展示分组，不撤销或合并浏览器凭据", () => {
  const h = harness();
  try {
    const result = groupDevices(h, { primaryId: "chrome", memberId: "wechat", name: "荣耀手机" });
    assert.deepEqual({ ok: result.ok, count: result.count, name: result.name }, { ok: true, count: 2, name: "荣耀手机" });
    const config = loadOrCreateConfig(h.configPath);
    assert.equal(config.devices.length, 3);
    assert.equal(config.devices[0].tokenHash, "a");
    assert.equal(config.devices[1].tokenHash, "b");
    assert.equal(config.devices[0].phoneGroupId, config.devices[1].phoneGroupId);
    assert.equal(config.devices[0].phoneGroupName, "荣耀手机");
    const listed = listDevices(h).devices;
    assert.equal(listed.find((d) => d.deviceId === "wechat").phoneGroupName, "荣耀手机");
  } finally { h.cleanup(); }
});

test("解除归并不会撤销设备", () => {
  const h = harness();
  try {
    assert.equal(groupDevices(h, { primaryId: "chrome", memberId: "wechat" }).ok, true);
    assert.equal(ungroupDevice(h, "wechat").ok, true);
    const config = loadOrCreateConfig(h.configPath);
    assert.equal(config.devices.length, 3);
    assert.equal(config.devices.find((d) => d.deviceId === "wechat").phoneGroupId, undefined);
    assert.ok(config.devices.find((d) => d.deviceId === "chrome").phoneGroupId);
  } finally { h.cleanup(); }
});

test("只允许归并已经成功连接过的真实设备", () => {
  const h = harness();
  try {
    const result = groupDevices(h, { primaryId: "chrome", memberId: "unused" });
    assert.equal(result.ok, false);
    assert.match(result.error, /成功连接/);
  } finally { h.cleanup(); }
});

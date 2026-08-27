import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = join(root, "daemon", "src", "main.mjs");
const jingme = { appKey: "test-app", appSecret: "test-secret", openTeamId: "team-1", robotId: "robot-1" };

function runNotify(configPath, args) {
  return spawnSync(process.execPath, [main, "notify", "--config", configPath, ...args], { cwd: root, encoding: "utf8" });
}

function makeConfig(dir, notifiers = []) {
  const configPath = join(dir, "daemon.json");
  writeFileSync(configPath, JSON.stringify({ v: 1, notifiers, jingme }), { mode: 0o600 });
  return configPath;
}

test("CLI 添加京Me接收人", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  try {
    const configPath = makeConfig(dir);
    const result = runNotify(configPath, ["--add", "jingme", "--erp", "tanchuxiong.1"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers, [{ type: "jingme", erp: "tanchuxiong.1" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI 拒绝旧通知渠道和非法 ERP", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  try {
    const configPath = makeConfig(dir);
    const old = runNotify(configPath, ["--add", "bark", "--key", "x"]);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /仅支持京Me/);
    const invalid = runNotify(configPath, ["--add", "jingme", "--erp", "bad ERP"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /--erp/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

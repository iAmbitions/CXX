import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = join(root, "daemon", "src", "main.mjs");

test("CLI 列表时清理并禁用历史通知渠道", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxx-notify-"));
  const configPath = join(dir, "daemon.json");
  try {
    writeFileSync(configPath, JSON.stringify({
      v: 1,
      jingme: { appKey: "test-app", appSecret: "test-secret", openTeamId: "team-1", robotId: "robot-1" },
      notifiers: [{ type: "bark", key: "legacy" }, { type: "jingme", erp: "tester" }],
    }));
    const result = spawnSync(process.execPath, [main, "notify", "--config", configPath, "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /京Me:tester/);
    assert.doesNotMatch(result.stdout, /bark/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).notifiers, [{ type: "jingme", erp: "tester" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";

import { checkMinVersion, compareVersions, cxxVersion, parseVersionTriple } from "../daemon/src/version.mjs";

test("cxxVersion dev 模式读取仓库 package.json", () => {
  assert.match(cxxVersion(), /^\d+\.\d+\.\d+$/);
});

test("compareVersions 数字比较且容忍 v 前缀/段数不齐", () => {
  assert.ok(compareVersions("0.1.3", "0.1.2") > 0);
  assert.ok(compareVersions("v0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0); // 数字段，非字典序
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
});

test("parseVersionTriple 从任意版本输出提取三元组", () => {
  assert.deepEqual(parseVersionTriple("codex-cli 0.142.5"), { major: 0, minor: 142, patch: 5 });
  assert.deepEqual(parseVersionTriple("2.1.201 (Claude Code)"), { major: 2, minor: 1, patch: 201 });
  assert.equal(parseVersionTriple("nonsense"), null);
  assert.equal(parseVersionTriple(null), null);
});

test("checkMinVersion 只有明确低于下限才拦,读不到/解析不出放行", () => {
  assert.deepEqual(checkMinVersion("codex-cli 0.142.5", "0.142.0"), {
    raw: "codex-cli 0.142.5",
    parsed: { major: 0, minor: 142, patch: 5 },
    ok: true,
    belowMin: false,
  });
  assert.equal(checkMinVersion("1.9.0", "2.0.0").belowMin, true);
  assert.equal(checkMinVersion("1.9.0", "2.0.0").ok, false);
  // 版本串格式变化/读不到:绝不能把新版 CLI 拦在启动之外
  assert.equal(checkMinVersion("future-format", "2.0.0").ok, true);
  assert.equal(checkMinVersion(null, "2.0.0").ok, true);
});

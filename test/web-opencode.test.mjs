import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

test("phone UI exposes OpenCode as a first-class agent and reuses structured transcript rendering", () => {
  assert.match(source, /new Set\(\["codex", "claude", "opencode"\]\)/);
  assert.match(source, /id === "opencode" \? "OpenCode"/);
  assert.match(source, /app\.agent === "claude" \|\| app\.agent === "opencode"/);
  assert.match(source, /o\.permissionPreset = p/);
  assert.match(source, /等待 \$\{agentName\(app\.agent\)\} 继续/);
});

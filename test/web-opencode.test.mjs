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


test("phone UI invalidates the model cache after daemon reconnect", () => {
  const onReady = source.slice(source.indexOf("session.onReady = async"), source.indexOf("session.connect().catch"));
  assert.match(onReady, /app\.models = null;[\s\S]*modelsLoading = false;[\s\S]*prefetchModels\(\)/);
});

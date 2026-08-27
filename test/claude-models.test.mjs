import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeModelCatalog } from "../daemon/src/claude-backend.mjs";

test("Claude 模型列表优先展示本机 alias 到真实模型的映射", () => {
  const models = buildClaudeModelCatalog({
    settings: { model: "haiku" },
    state: {},
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8[1M]",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "kimi-k3-joybuilder",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6[1M]",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "GPT-5.6-Luna-joybuilder",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "GPT-5.5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5[1M]",
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "GLM-5.3-joybuilder",
    },
  });

  assert.deepEqual(models.map((m) => m.id), [
    "claude-haiku-4-5",
    "claude-opus-4-8[1M]",
    "claude-sonnet-4-6[1M]",
    "claude-fable-5[1M]",
  ]);
  assert.equal(models[0].displayName, "GPT-5.5");
  assert.equal(models[0].isDefault, true);
  assert.equal(models[1].displayName, "kimi-k3-joybuilder");
  assert.match(models[1].description, /opus/);
});

test("没有本机 Claude 模型配置时才使用 fallback", () => {
  const models = buildClaudeModelCatalog({ settings: {}, state: {}, env: {} });
  assert.deepEqual(models.map((m) => m.id), [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]);
  assert.match(models[0].description, /fallback/);
});

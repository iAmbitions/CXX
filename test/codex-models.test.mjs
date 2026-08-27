import assert from "node:assert/strict";
import test from "node:test";

import {
  markConfiguredCodexDefault,
  modelMatchesId,
  readCodexConfiguredModel,
  readCodexLocalModelCatalog,
  resolveCodexModels,
} from "../daemon/src/codex-models.mjs";
import { pickCodexDefaultModel as pickFromHub } from "../daemon/src/session-hub.mjs";

test("Codex 读取 config.toml 的本机默认模型", () => {
  assert.equal(
    readCodexConfiguredModel({
      home: "/home/test",
      env: {},
      readFile: () => 'model = "GPT-5.6-Sol-joybuilder"\n',
      exists: () => true,
    }),
    "GPT-5.6-Sol-joybuilder",
  );
});

test("Codex 模型目录按 config.toml 当前 model 标记默认项", () => {
  const models = [
    { model: "kimi-k3-joybuilder", isDefault: true },
    { model: "GPT-5.6-Sol-joybuilder", isDefault: false },
  ];
  const marked = markConfiguredCodexDefault(models, "GPT-5.6-Sol-joybuilder");
  assert.equal(marked[0].isDefault, false);
  assert.equal(marked[1].isDefault, true);
  assert.equal(modelMatchesId(marked[1], "gpt-5.6-sol-joybuilder"), true);
});

test("Codex 默认模型优先使用本机配置，不使用目录硬编码默认项", () => {
  const models = [
    { model: "kimi-k3-joybuilder", isDefault: true },
    { model: "GPT-5.6-Sol-joybuilder", isDefault: false },
  ];
  assert.equal(pickFromHub(models, "GPT-5.6-Sol-joybuilder"), "GPT-5.6-Sol-joybuilder");
});

test("Codex model/list 没有可用模型时不回退到写死模型", () => {
  assert.throws(() => pickFromHub([]), /Codex 未返回可用的本地模型列表/);
});


test("Codex 每次读取本地 model_catalog_json，并以 config.toml 当前 model 标记默认项", () => {
  const config = [
    'model = "local-b"',
    'model_catalog_json = "/tmp/catalog.json"',
  ].join("\n");
  const catalog = JSON.stringify({
    models: [
      {
        slug: "local-a",
        display_name: "Local A",
        description: "first local model",
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }],
        visibility: "list",
      },
      {
        slug: "local-b",
        display_name: "Local B",
        description: "second local model",
        default_reasoning_level: "max",
        supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }],
        visibility: "list",
      },
    ],
  });
  const local = readCodexLocalModelCatalog({
    home: "/home/test",
    env: {},
    exists: () => true,
    readFile: (path) => path.endsWith("config.toml") ? config : catalog,
  });
  assert.deepEqual(local.map((m) => m.model), ["local-a", "local-b"]);
  assert.equal(local[1].isDefault, true);
  assert.deepEqual(local[1].supportedReasoningEfforts.map((e) => e.reasoningEffort), ["high", "max"]);

  const resolved = resolveCodexModels([{ model: "stale-app-server-model", isDefault: true }], {
    configuredModel: "local-b",
    localCatalog: local,
  });
  assert.deepEqual(resolved.map((m) => m.model), ["local-a", "local-b"]);
  assert.equal(resolved[1].isDefault, true);
});

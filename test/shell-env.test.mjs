import assert from "node:assert/strict";
import test from "node:test";

import {
  captureAgentEnv,
  parseEnvOutput,
  resetShellEnvCache,
  sanitize,
} from "../daemon/src/shell-env.mjs";

function markerFromCommand(command) {
  return command.match(/printf '([^']+)\\0'/)?.[1] ?? "";
}

test("parseEnvOutput preserves values containing equals signs", () => {
  assert.deepEqual(parseEnvOutput("A=one=two\0B=three\0"), { A: "one=two", B: "three" });
});

test("sanitize removes Pocket Agent internal secrets without removing provider tokens", () => {
  assert.deepEqual(sanitize({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "provider-secret",
    CXX_APPROVE_TOKEN: "internal-secret",
    LANG: "C",
  }), {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "provider-secret",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  });
});

test("captureAgentEnv reads tokens exported only by an interactive login shell", async () => {
  resetShellEnvCache();
  let invocation;
  const result = await captureAgentEnv({
    cache: false,
    platform: "darwin",
    env: { SHELL: "/bin/zsh", HTTPS_PROXY: "http://proxy.test" },
    fallback: async () => ({ PATH: "/usr/bin:/bin", LOGIN_ONLY: "yes" }),
    exec: (file, args, options, callback) => {
      invocation = { file, args, options };
      const marker = markerFromCommand(args[1]);
      callback(null,
        `theme startup noise\n${marker}\0PATH=/opt/homebrew/bin:/usr/bin\0` +
        "OPENAI_API_KEY=sk-from-zshrc\0CUSTOM_PROVIDER_TOKEN=custom-secret\0" +
        "CXX_APPROVE_TOKEN=must-not-leak\0");
    },
  });

  assert.equal(invocation.file, "/bin/zsh");
  assert.equal(invocation.args[0], "-ilc");
  assert.equal(invocation.options.env.CXX_ENV_CAPTURE, "1");
  assert.equal(result.OPENAI_API_KEY, "sk-from-zshrc");
  assert.equal(result.CUSTOM_PROVIDER_TOKEN, "custom-secret");
  assert.equal(result.HTTPS_PROXY, "http://proxy.test");
  assert.equal(result.LOGIN_ONLY, "yes");
  assert.equal(result.CXX_APPROVE_TOKEN, undefined);
});

test("captureAgentEnv falls back safely when interactive shell initialization fails", async () => {
  resetShellEnvCache();
  const result = await captureAgentEnv({
    cache: false,
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PROCESS_ONLY: "yes" },
    fallback: async () => ({ PATH: "/usr/bin:/bin", LOGIN_ONLY: "yes" }),
    exec: (_file, _args, _options, callback) => callback(new Error("shell timeout"), ""),
  });

  assert.equal(result.PROCESS_ONLY, "yes");
  assert.equal(result.LOGIN_ONLY, "yes");
  assert.equal(result.PATH, "/usr/bin:/bin");
});

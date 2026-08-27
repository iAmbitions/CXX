import assert from "node:assert/strict";
import test from "node:test";
import { openCodeInvocation, resolveOpenCodeCommand } from "../daemon/src/opencode-path.mjs";

const existsSet = (paths) => { const set = new Set(paths); return (path) => set.has(path); };

test("OpenCode resolver finds an npm/nvm shim from the captured Agent PATH", () => {
  const command = "/Users/Ada/.nvm/versions/node/v24/bin/opencode";
  const resolved = resolveOpenCodeCommand("opencode", {
    platform: "darwin", homeDir: "/Users/Ada", env: { PATH: "/Users/Ada/.nvm/versions/node/v24/bin:/usr/bin" },
    exists: existsSet([command]), isRunnable: () => true,
    execFileSync: () => { throw new Error("unused"); },
  });
  assert.equal(resolved, command);
});

test("OpenCode resolver expands explicit home and environment-variable paths", () => {
  const command = "/Users/Ada/custom tools/opencode";
  const options = {
    platform: "darwin", homeDir: "/Users/Ada", env: { OPENCODE_BIN: command },
    exists: existsSet([command]), isRunnable: () => true,
  };
  assert.equal(resolveOpenCodeCommand("$OPENCODE_BIN", options), command);
  assert.equal(resolveOpenCodeCommand("~/custom tools/opencode", options), command);
  assert.equal(resolveOpenCodeCommand('"${OPENCODE_BIN}"', options), command);
});

test("OpenCode resolver probes pnpm and Bun install roots outside the service PATH", () => {
  const pnpm = "/Users/Ada/Library/pnpm/opencode";
  const bun = "/Users/Ada/.bun/bin/opencode";
  const base = { platform: "darwin", homeDir: "/Users/Ada", env: { PATH: "/usr/bin", PNPM_HOME: "/Users/Ada/Library/pnpm", BUN_INSTALL: "/Users/Ada/.bun" } };
  assert.equal(resolveOpenCodeCommand("opencode", {
    ...base, exists: existsSet([pnpm, bun]), isRunnable: (path) => path === pnpm,
  }), pnpm);
  assert.equal(resolveOpenCodeCommand("opencode", {
    ...base, env: { ...base.env, PNPM_HOME: "" }, exists: existsSet([bun]), isRunnable: () => true,
  }), bun);
});

test("OpenCode resolver skips a broken PATH shim and uses a working native install", () => {
  const broken = "/Users/Ada/.nvm/versions/node/v20/bin/opencode";
  const native = "/Users/Ada/.opencode/bin/opencode";
  const resolved = resolveOpenCodeCommand("opencode", {
    platform: "darwin", homeDir: "/Users/Ada", env: { PATH: "/Users/Ada/.nvm/versions/node/v20/bin:/usr/bin" },
    exists: existsSet([broken, native]), isRunnable: (path) => path === native,
  });
  assert.equal(resolved, native);
});

test("OpenCode resolver recognizes Windows npm command shims from the captured PATH", () => {
  const command = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\opencode.cmd";
  const resolved = resolveOpenCodeCommand("opencode", {
    platform: "win32", homeDir: "C:\\Users\\Ada", env: { Path: "C:\\Users\\Ada\\AppData\\Roaming\\npm" },
    exists: existsSet([command]), isRunnable: () => true,
  });
  assert.equal(resolved, command);
});

test("OpenCode invocation pins npm shebang scripts to their sibling Node", () => {
  const command = "/Users/Ada/.nvm/versions/node/v24/bin/opencode";
  const node = "/Users/Ada/.nvm/versions/node/v24/bin/node";
  assert.deepEqual(openCodeInvocation(command, ["serve"], {
    platform: "darwin", env: { PATH: "/usr/bin" }, exists: existsSet([command, node]),
    readHead: () => "#!/usr/bin/env node\n",
  }), { command: node, args: [command, "serve"] });
});

test("OpenCode Windows invocation uses cmd.exe for npm command shims", () => {
  const command = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\opencode.cmd";
  assert.deepEqual(openCodeInvocation(command, ["serve"], {
    platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", command, "serve"],
  });
});

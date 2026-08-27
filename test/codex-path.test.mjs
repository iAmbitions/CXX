import assert from "node:assert/strict";
import test from "node:test";

import { codexInvocation, resolveCodexCommand } from "../daemon/src/codex-path.mjs";

function existsSet(paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

test("macOS resolver falls back to native ChatGPT codex when the Node shim is broken", () => {
  const home = "/Users/Ada";
  const native = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const npmShim = `${home}/.npm-global/bin/codex`;
  const resolved = resolveCodexCommand("codex", {
    platform: "darwin",
    homeDir: home,
    env: { PATH: `${home}/.npm-global/bin:/usr/bin:/bin` },
    exists: existsSet([native, npmShim]),
    isRunnable: (path) => path === native,
  });
  assert.equal(resolved, native);
});

test("macOS resolver keeps a working user CLI ahead of bundled native fallbacks", () => {
  const home = "/Users/Ada";
  const native = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const npmShim = `${home}/.npm-global/bin/codex`;
  const resolved = resolveCodexCommand("codex", {
    platform: "darwin",
    homeDir: home,
    env: { PATH: `${home}/.npm-global/bin:/usr/bin:/bin` },
    exists: existsSet([native, npmShim]),
    isRunnable: () => true,
  });
  assert.equal(resolved, npmShim);
});

test("POSIX invocation runs an env-node codex shim with its sibling Node", () => {
  const bin = "/Users/Ada/.nvm/versions/node/v24.16.0/bin";
  const codex = `${bin}/codex`;
  const node = `${bin}/node`;
  const invocation = codexInvocation(codex, ["app-server", "--listen", "ws://127.0.0.1:19271"], {
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    exists: existsSet([codex, node]),
    readHead: () => "#!/usr/bin/env node\n",
  });
  assert.equal(invocation.command, node);
  assert.deepEqual(invocation.args, [
    codex,
    "app-server",
    "--listen",
    "ws://127.0.0.1:19271",
  ]);
});

test("POSIX invocation resolves env-node through PATH when the shim has no sibling Node", () => {
  const codex = "/Users/Ada/.npm-global/bin/codex";
  const node = "/usr/local/bin/node";
  const invocation = codexInvocation(codex, ["--version"], {
    platform: "darwin",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    exists: existsSet([codex, node]),
    readHead: () => "#!/usr/bin/env -S node --no-warnings\n",
  });
  assert.deepEqual(invocation, { command: node, args: ["--no-warnings", codex, "--version"] });
});

test("POSIX resolver searches the service PATH before invoking a login shell", () => {
  const home = "/Users/Ada";
  const codex = `${home}/.nvm/versions/node/v24.16.0/bin/codex`;
  let shellCalls = 0;
  const resolved = resolveCodexCommand("codex", {
    platform: "darwin",
    homeDir: home,
    env: { PATH: `${home}/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin` },
    exists: existsSet([codex]),
    execFileSync: () => {
      shellCalls++;
      throw new Error("login shell should not run");
    },
    isRunnable: () => true,
  });
  assert.equal(resolved, codex);
  assert.equal(shellCalls, 0);
});

test("POSIX invocation leaves native codex executables untouched", () => {
  const codex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const invocation = codexInvocation(codex, ["--version"], {
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    exists: existsSet([codex]),
    readHead: () => "\u00cf\u00fa\u00ed\u00fe",
  });
  assert.deepEqual(invocation, { command: codex, args: ["--version"] });
});

test("Windows resolver finds the npm codex.cmd shim", () => {
  const home = "C:\\Users\\Ada";
  const appdata = `${home}\\AppData\\Roaming`;
  const shim = `${appdata}\\npm\\codex.cmd`;
  const resolved = resolveCodexCommand("codex", {
    platform: "win32",
    homeDir: home,
    env: {
      APPDATA: appdata,
      LOCALAPPDATA: `${home}\\AppData\\Local`,
      ProgramFiles: "C:\\Program Files",
      Path: "",
    },
    exists: existsSet([shim]),
  });
  assert.equal(resolved, shim);
});

test("Windows resolver prefers executable siblings over an explicit codex.ps1", () => {
  const ps1 = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.ps1";
  const cmd = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
  const resolved = resolveCodexCommand(ps1, {
    platform: "win32",
    env: {},
    exists: existsSet([ps1, cmd]),
  });
  assert.equal(resolved, cmd);
});

test("Windows resolver searches PATH without selecting PowerShell-only shims", () => {
  const dir = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
  const cmd = `${dir}\\codex.cmd`;
  const ps1 = `${dir}\\codex.ps1`;
  const resolved = resolveCodexCommand("codex", {
    platform: "win32",
    env: { Path: dir },
    exists: existsSet([ps1, cmd]),
  });
  assert.equal(resolved, cmd);
});

test("Windows invocation runs command shims through the platform shell", () => {
  const cmd = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
  const cmdInvocation = codexInvocation(cmd, ["app-server", "--listen", "ws://127.0.0.1:19271"], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(cmdInvocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(cmdInvocation.args, [
    "/d",
    "/s",
    "/c",
    cmd,
    "app-server",
    "--listen",
    "ws://127.0.0.1:19271",
  ]);

  const ps1 = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.ps1";
  const ps1Invocation = codexInvocation(ps1, ["--version"], { platform: "win32" });
  assert.equal(ps1Invocation.command, "powershell.exe");
  assert.deepEqual(ps1Invocation.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ps1,
    "--version",
  ]);
});

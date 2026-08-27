// Resolve the official `codex` binary to an absolute path.
//
// A GUI app launched from Finder/Dock inherits a minimal PATH (often just
// /usr/bin:/bin:/usr/sbin:/sbin) — the user's shell PATH (Homebrew, ~/.local/bin,
// nvm, etc.) is NOT present. So a bare spawn("codex") fails for exactly the users we
// target: those who installed the ChatGPT/codex CLI and launch our menu-bar app by clicking it.
// This probes the common install locations directly.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  delimiter as nativeDelimiter,
  dirname as nativeDirname,
  extname as nativeExtname,
  join as nativeJoin,
  win32 as win32Path,
} from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const WINDOWS_SHIM_EXTS = [".exe", ".cmd", ".bat"];
const NODE_NAMES = new Set(["node", "nodejs"]);

function pathApi(os) {
  return os === "win32"
    ? win32Path
    : {
      delimiter: nativeDelimiter,
      dirname: nativeDirname,
      extname: nativeExtname,
      join: nativeJoin,
    };
}

function envValue(env, names) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readHead(path, size = 512) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size);
    const length = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, length).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function windowsCommandVariants(path, api) {
  const ext = api.extname(path).toLowerCase();
  if (ext === ".ps1") {
    const stem = path.slice(0, -ext.length);
    return [...WINDOWS_SHIM_EXTS.map((e) => `${stem}${e}`), path];
  }
  if (ext) return [path];
  return WINDOWS_SHIM_EXTS.map((e) => `${path}${e}`);
}

function context(options = {}) {
  return {
    platform: options.platform || platform(),
    homeDir: options.homeDir || homedir(),
    env: options.env || process.env,
    exists: options.exists || existsSync,
    readHead: options.readHead || readHead,
    execFileSync: options.execFileSync || execFileSync,
    isRunnable: options.isRunnable,
  };
}

// Ordered probe list of likely absolute locations, per platform.
function candidatePaths(ctx) {
  const api = pathApi(ctx.platform);
  const home = ctx.homeDir;
  if (ctx.platform === "win32") {
    const pf = envValue(ctx.env, ["ProgramFiles", "PROGRAMFILES"]) || "C:\\Program Files";
    const local = envValue(ctx.env, ["LOCALAPPDATA"]) || api.join(home, "AppData", "Local");
    const appdata = envValue(ctx.env, ["APPDATA"]) || api.join(home, "AppData", "Roaming");
    return unique([
      api.join(local, "Programs", "codex", "codex.exe"),
      api.join(pf, "codex", "codex.exe"),
      api.join(home, ".codex", "bin", "codex.exe"),
      api.join(appdata, "npm", "codex.exe"),
      api.join(appdata, "npm", "codex.cmd"),
      api.join(local, "pnpm", "codex.exe"),
      api.join(local, "pnpm", "codex.cmd"),
    ]);
  }
  return [
    "/opt/homebrew/bin/codex", // macOS Apple Silicon Homebrew
    "/usr/local/bin/codex", // macOS Intel Homebrew / manual
    api.join(home, ".npm-global", "bin", "codex"),
    api.join(home, ".volta", "bin", "codex"),
    api.join(home, ".asdf", "shims", "codex"),
    api.join(home, ".local", "share", "mise", "shims", "codex"),
    api.join(home, ".local", "bin", "codex"),
    api.join(home, ".codex", "bin", "codex"),
    "/usr/bin/codex",
  ];
}

function nativeMacCandidatePaths(ctx) {
  if (ctx.platform !== "darwin") return [];
  const api = pathApi(ctx.platform);
  const home = ctx.homeDir;
  // The desktop app bundles a native, self-contained codex executable. Prefer it
  // as a fallback when the user's configured CLI/npm package cannot actually run.
  // Both system-wide and per-user Applications folders are supported. The plugin
  // app-server copy is another official native fallback used by newer releases.
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    api.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    api.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    api.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
  ];
}

function viaWindowsPath(command, ctx) {
  const api = pathApi(ctx.platform);
  const pathValue = envValue(ctx.env, ["PATH", "Path", "path"]);
  if (!pathValue) return null;
  for (const dir of pathValue.split(api.delimiter)) {
    for (const candidate of windowsCommandVariants(api.join(dir, command), api)) {
      if (ctx.exists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveExplicitWindowsCommand(command, ctx) {
  const api = pathApi(ctx.platform);
  for (const candidate of windowsCommandVariants(command, api)) {
    if (ctx.exists(candidate)) return candidate;
  }
  return command;
}

function commandOnPath(command, ctx) {
  const api = pathApi(ctx.platform);
  const pathValue = envValue(ctx.env, ["PATH", "Path", "path"]);
  if (!pathValue) return null;
  for (const dir of pathValue.split(api.delimiter)) {
    if (!dir) continue;
    const candidate = api.join(dir, command);
    if (ctx.exists(candidate)) return candidate;
  }
  return null;
}

// Ask the login shell for a command's location. This is intentionally a final
// fallback: rc files can be slow or noisy, while absolute/sibling probes are cheap.
function viaLoginShell(command, ctx) {
  if (ctx.platform === "win32") return null;
  const shell = ctx.env.SHELL || "/bin/sh";
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return null;
  try {
    const out = ctx.execFileSync(shell, ["-lic", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/).at(-1)?.trim();
    return out && ctx.exists(out) ? out : null;
  } catch {
    return null;
  }
}

function nodeForScript(command, ctx) {
  const api = pathApi(ctx.platform);
  const scriptDir = api.dirname(command);
  const candidates = unique([
    // npm/nvm/fnm put the shim and its matching Node binary in the same bin dir.
    api.join(scriptDir, "node"),
    api.join(scriptDir, "nodejs"),
    commandOnPath("node", ctx),
    commandOnPath("nodejs", ctx),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]);
  for (const candidate of candidates) {
    if (ctx.exists(candidate)) return candidate;
  }
  return viaLoginShell("node", ctx);
}

function scriptNodeInvocation(command, ctx) {
  if (!command || !ctx.exists(command)) return null;
  const firstLine = String(ctx.readHead(command) || "").split(/\r?\n/, 1)[0];
  const match = /^#!\s*(\S+)(?:\s+(.+))?$/.exec(firstLine);
  if (!match) return null; // native executable or unreadable file

  const interpreter = match[1];
  const interpreterName = interpreter.split(/[\\/]/).at(-1)?.toLowerCase();
  if (NODE_NAMES.has(interpreterName)) {
    return ctx.exists(interpreter)
      ? { command: interpreter, args: String(match[2] || "").trim().split(/\s+/).filter(Boolean) }
      : null;
  }
  if (interpreterName !== "env") return null;

  // Handles both `#!/usr/bin/env node` and `#!/usr/bin/env -S node ...`.
  const envArgs = String(match[2] || "").replace(/^-S\s+/, "").trim().split(/\s+/);
  if (!NODE_NAMES.has(String(envArgs[0] || "").toLowerCase())) return null;
  const node = nodeForScript(command, ctx);
  return node ? { command: node, args: envArgs.slice(1) } : null;
}

function runnableCodex(command, ctx) {
  if (typeof ctx.isRunnable === "function") return ctx.isRunnable(command);
  try {
    const invocation = codexInvocation(command, ["--version"], ctx);
    ctx.execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: ctx.env,
    });
    return true;
  } catch {
    return false;
  }
}

export function codexInvocation(command, args = [], options = {}) {
  const ctx = context(options);
  if (ctx.platform !== "win32") {
    // Do not rely on `/usr/bin/env node` under launchd/systemd. If codex is an
    // npm-style script, invoke it through an absolute Node path instead.
    const node = scriptNodeInvocation(String(command), ctx);
    return node
      ? { command: node.command, args: [...node.args, command, ...args] }
      : { command, args };
  }
  const ext = pathApi(ctx.platform).extname(String(command)).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return {
      command: options.comspec || envValue(ctx.env, ["ComSpec", "COMSPEC"]) || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  if (ext === ".ps1") {
    return {
      command: options.powershell || "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }
  return { command, args };
}

// Resolve `command` (default "codex") to an absolute path, or return the input
// unchanged if nothing better is found (spawn will then surface a clear ENOENT).
export function resolveCodexCommand(command = "codex", options = {}) {
  const ctx = context(options);
  // An explicit absolute/relative path that exists wins — respects user override.
  if (command && (command.includes("/") || command.includes("\\"))) {
    if (ctx.platform === "win32") return resolveExplicitWindowsCommand(command, ctx);
    return ctx.exists(command) ? command : command;
  }
  if (ctx.platform === "win32") {
    for (const p of candidatePaths(ctx)) {
      if (ctx.exists(p)) return p;
    }
    const pathHit = viaWindowsPath(command, ctx);
    if (pathHit) return pathHit;
    return command;
  }

  // Preserve the user's CLI choice when it works, but do not let a stale/broken
  // npm package make the whole computer appear offline. A bundled native Codex is
  // tried only after ordinary CLI locations, PATH and the login shell fail validation.
  const preferred = unique([
    ...candidatePaths(ctx),
    commandOnPath(command, ctx),
  ]).filter((path) => ctx.exists(path));
  for (const candidate of preferred) {
    if (runnableCodex(candidate, ctx)) return candidate;
  }

  const shellHit = viaLoginShell(command, ctx);
  if (shellHit && !preferred.includes(shellHit) && runnableCodex(shellHit, ctx)) return shellHit;

  const nativeFallbacks = unique(nativeMacCandidatePaths(ctx)).filter((path) => ctx.exists(path));
  for (const candidate of nativeFallbacks) {
    if (runnableCodex(candidate, ctx)) return candidate;
  }
  // Keep the best discovered path for a clear startup error when every installation
  // is broken; otherwise let spawn surface ENOENT for the original command.
  if (preferred[0]) return preferred[0];
  if (shellHit) return shellHit;
  if (nativeFallbacks[0]) return nativeFallbacks[0];
  return command; // let spawn fail loudly
}

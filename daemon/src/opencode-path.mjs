// Resolve the OpenCode CLI to an absolute, runnable path.
//
// Finder/Dock, launchd, systemd and Windows scheduled tasks often provide a much
// smaller PATH than an interactive terminal. OpenCode can also be installed by its
// native installer, Homebrew, npm/nvm/fnm, pnpm, Bun, Volta, asdf or mise. Probe all
// common locations and use the captured Agent environment supplied by main.mjs.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";

import { codexInvocation } from "./codex-path.mjs";

const WINDOWS_SHIM_EXTS = [".exe", ".cmd", ".bat"];

function context(options = {}) {
  return {
    platform: options.platform || platform(),
    homeDir: options.homeDir || homedir(),
    env: options.env || process.env,
    exists: options.exists || existsSync,
    execFileSync: options.execFileSync || execFileSync,
    readHead: options.readHead,
    isRunnable: options.isRunnable,
  };
}

function pathApi(kind) { return kind === "win32" ? path.win32 : path.posix; }

function envValue(env, names) {
  for (const name of names) if (env[name]) return env[name];
  return "";
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function executableAt(value, ctx) {
  if (!value) return [];
  const api = pathApi(ctx.platform);
  const raw = String(value);
  const base = api.basename(raw).toLowerCase();
  if (base === "opencode" || /^opencode\.(?:exe|cmd|bat|ps1)$/i.test(base)) return [raw];
  if (ctx.platform === "win32") {
    return WINDOWS_SHIM_EXTS.map((ext) => api.join(raw, `opencode${ext}`));
  }
  return [api.join(raw, "opencode")];
}

function expandConfiguredCommand(command, ctx) {
  let value = String(command || "opencode").trim();
  // Configuration is JSON/CLI data, not a shell command. Accept pasted wrapping quotes
  // and expand common variable forms without invoking a shell or evaluating code.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/^~(?=$|[\\/])/, ctx.homeDir);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced, plain) => ctx.env[braced || plain] ?? whole);
  if (ctx.platform === "win32") {
    value = value.replace(/%([^%]+)%/g, (whole, name) => ctx.env[name] ?? ctx.env[name.toUpperCase()] ?? whole);
  }
  return value;
}

function windowsCommandVariants(command, ctx) {
  const api = pathApi(ctx.platform);
  const ext = api.extname(command).toLowerCase();
  if (ext === ".ps1") {
    const stem = command.slice(0, -ext.length);
    return [...WINDOWS_SHIM_EXTS.map((suffix) => `${stem}${suffix}`), command];
  }
  if (ext) return [command];
  return WINDOWS_SHIM_EXTS.map((suffix) => `${command}${suffix}`);
}

function candidates(ctx) {
  const api = pathApi(ctx.platform);
  const home = ctx.homeDir;
  const configured = [
    ...executableAt(envValue(ctx.env, ["OPENCODE_BIN", "OPENCODE_BINARY"]), ctx),
    ...executableAt(envValue(ctx.env, ["OPENCODE_INSTALL_DIR"]), ctx),
  ];
  if (ctx.platform === "win32") {
    const local = envValue(ctx.env, ["LOCALAPPDATA"]) || api.join(home, "AppData", "Local");
    const roaming = envValue(ctx.env, ["APPDATA"]) || api.join(home, "AppData", "Roaming");
    const roots = [
      envValue(ctx.env, ["PNPM_HOME"]),
      envValue(ctx.env, ["NVM_SYMLINK", "NVM_HOME"]),
      envValue(ctx.env, ["VOLTA_HOME"]),
      envValue(ctx.env, ["BUN_INSTALL"]),
    ];
    return unique([
      ...configured,
      api.join(local, "Programs", "opencode", "opencode.exe"),
      api.join(home, ".opencode", "bin", "opencode.exe"),
      api.join(roaming, "npm", "opencode.exe"),
      api.join(roaming, "npm", "opencode.cmd"),
      api.join(local, "pnpm", "opencode.exe"),
      api.join(local, "pnpm", "opencode.cmd"),
      ...roots.flatMap((root) => executableAt(root && /(?:volta|bun)$/i.test(root) ? api.join(root, "bin") : root, ctx)),
      api.join(home, ".bun", "bin", "opencode.exe"),
      api.join(home, ".bun", "bin", "opencode.cmd"),
    ]);
  }
  const roots = [
    envValue(ctx.env, ["PNPM_HOME"]),
    envValue(ctx.env, ["NVM_BIN"]),
    envValue(ctx.env, ["FNM_MULTISHELL_PATH"]),
    envValue(ctx.env, ["XDG_BIN_HOME"]),
    envValue(ctx.env, ["VOLTA_HOME"]),
    envValue(ctx.env, ["BUN_INSTALL"]),
  ];
  return unique([
    ...configured,
    api.join(home, ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/home/linuxbrew/.linuxbrew/bin/opencode",
    api.join(home, ".linuxbrew", "bin", "opencode"),
    api.join(home, ".npm-global", "bin", "opencode"),
    api.join(home, "Library", "pnpm", "opencode"),
    api.join(home, ".local", "share", "pnpm", "opencode"),
    api.join(home, ".bun", "bin", "opencode"),
    api.join(home, ".volta", "bin", "opencode"),
    api.join(home, ".asdf", "shims", "opencode"),
    api.join(home, ".local", "share", "mise", "shims", "opencode"),
    api.join(home, ".local", "bin", "opencode"),
    ...roots.flatMap((root) => executableAt(root && /(?:volta|bun)$/i.test(root) ? api.join(root, "bin") : root, ctx)),
    "/usr/bin/opencode",
  ]);
}

function fromPath(command, ctx) {
  const api = pathApi(ctx.platform);
  const dirs = String(envValue(ctx.env, ["PATH", "Path", "path"])).split(api.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const base = api.join(dir, command);
    const variants = ctx.platform === "win32" ? windowsCommandVariants(base, ctx) : [base];
    for (const candidate of variants) if (ctx.exists(candidate)) return candidate;
  }
  return null;
}

function viaLoginShell(command, ctx) {
  if (ctx.platform === "win32" || !/^[A-Za-z0-9._+-]+$/.test(command)) return null;
  try {
    const shell = ctx.env.SHELL || "/bin/sh";
    const found = ctx.execFileSync(shell, ["-lic", `command -v ${command}`], {
      encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env: ctx.env,
    }).trim().split(/\r?\n/).at(-1)?.trim();
    return found && ctx.exists(found) ? found : null;
  } catch {
    return null;
  }
}

function runnable(command, ctx) {
  if (typeof ctx.isRunnable === "function") return ctx.isRunnable(command);
  try {
    const invocation = openCodeInvocation(command, ["--version"], ctx);
    ctx.execFileSync(invocation.command, invocation.args, {
      encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env: ctx.env,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveOpenCodeCommand(command = "opencode", options = {}) {
  const ctx = context(options);
  const expanded = expandConfiguredCommand(command, ctx);
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (ctx.platform === "win32") {
      for (const candidate of windowsCommandVariants(expanded, ctx)) if (ctx.exists(candidate)) return candidate;
    }
    return expanded; // explicit user choice; startup will report a clear error if missing
  }

  const found = unique([
    fromPath(expanded, ctx),
    ...(expanded === "opencode" ? candidates(ctx) : []),
  ]).filter((candidate) => ctx.exists(candidate));
  for (const candidate of found) if (runnable(candidate, ctx)) return candidate;

  const shellHit = viaLoginShell(expanded, ctx);
  if (shellHit && !found.includes(shellHit) && runnable(shellHit, ctx)) return shellHit;

  // Keep the best discovered path so backend startup can produce a useful error if all
  // installations are stale/broken; otherwise preserve the original command.
  return found[0] || shellHit || expanded;
}

export function openCodeInvocation(command, args = [], options = {}) {
  return codexInvocation(command, args, options);
}

export function openCodeAvailable(command = "opencode", options = {}) {
  const ctx = context(options);
  const resolved = resolveOpenCodeCommand(command, options);
  return (resolved.includes("/") || resolved.includes("\\")) && ctx.exists(resolved);
}

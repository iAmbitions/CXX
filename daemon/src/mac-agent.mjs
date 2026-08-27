// macOS (launchd) keepalive layer for the Pocket Agent daemon.
//
// In Model A the daemon runs as an independent LaunchAgent, decoupled from the
// menu-bar shell: the shell shells out (`cxx-daemon enable/disable/status/…`) and
// the daemon lives under launchd, surviving tray quit. This file is the mac half —
// plist generation + launchctl — mirroring codex-zh's launcher/mac/remote-backend.mjs.
//
// Because the Pocket Agent daemon ships as a self-contained SEA binary, the plist points at
// the binary itself via `process.execPath` — whoever runs `cxx-daemon enable` bakes
// that exact binary path into the plist. If the .app moves, re-running enable (the
// tray does this implicitly on pair) rewrites it. No separate `node` is required.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { defaultConfigPath } from "./config.mjs";

export const DAEMON_LABEL = "ai.wokey.cxx.remote";
export const APP_BUNDLE_ID = "ai.wokey.cxx";

// How to invoke this daemon's `start` from launchd.
//   SEA binary (cxx-daemon):   [<cxx-daemon>, "start"]
//   dev (node main.mjs):       [<node>, <main.mjs>, "start"]
// Detected by whether execPath is a plain node binary.
function daemonProgramArguments(configPath) {
  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  const isNode = base === "node" || base === "node.exe";
  const args = isNode && process.argv[1] ? [exec, process.argv[1], "start"] : [exec, "start"];
  // Thread a non-default config path through so the launchd-started daemon reads the
  // same config the shell mutates. Default path needs no flag.
  if (configPath && configPath !== defaultConfigPath()) args.push("--config", configPath);
  return args;
}

// —— plist serialization (minimal subset: string / bool / integer / array / dict) ——
function plistValue(v, indent) {
  const pad = "  ".repeat(indent);
  if (typeof v === "boolean") return `${pad}<${v ? "true" : "false"}/>`;
  if (typeof v === "number") return `${pad}<integer>${v}</integer>`;
  if (Array.isArray(v)) {
    const items = v.map((x) => plistValue(x, indent + 1)).join("\n");
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }
  if (v && typeof v === "object") {
    const rows = Object.entries(v)
      .map(([k, val]) => `${"  ".repeat(indent + 1)}<key>${escapeXml(k)}</key>\n${plistValue(val, indent + 1)}`)
      .join("\n");
    return `${pad}<dict>\n${rows}\n${pad}</dict>`;
  }
  return `${pad}<string>${escapeXml(String(v))}</string>`;
}
function escapeXml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function buildPlist(dict) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(dict, 0)}
</plist>
`;
}

function versionManagerBins(home, readDir = readdirSync) {
  const bins = [];
  const collect = (root, suffix) => {
    try {
      const versions = readDir(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) bins.push(join(root, version, ...suffix));
    } catch {
      // Version manager not installed (the common case).
    }
  };
  collect(join(home, ".nvm", "versions", "node"), ["bin"]);
  collect(join(home, ".fnm", "node-versions"), ["installation", "bin"]);
  return bins;
}

// A generous PATH so the launchd-started daemon can run npm/nvm/fnm/Volta/asdf/mise
// shims even though launchd hands processes a bare /usr/bin:/bin. codexInvocation()
// additionally converts `#!/usr/bin/env node` shims to an absolute Node invocation,
// so this remains useful belt-and-suspenders coverage for other child CLIs.
export function launchdPath(home = homedir(), { env = process.env, readDir = readdirSync } = {}) {
  const inherited = String(env.PATH || "").split(":").filter(Boolean);
  return [...new Set([
    ...inherited,
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".fnm", "current", "bin"),
    ...versionManagerBins(home, readDir),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".codex", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
}

export function daemonPlist({ programArguments, logPath }) {
  return buildPlist({
    Label: DAEMON_LABEL,
    // Tell macOS Background Task Management which app owns this manually installed
    // LaunchAgent, so System Settings and notifications use the app's branded identity.
    AssociatedBundleIdentifiers: [APP_BUNDLE_ID],
    ProgramArguments: programArguments,
    EnvironmentVariables: { PATH: launchdPath() },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    StandardOutPath: logPath,
    StandardErrorPath: logPath,
  });
}

// deps carries: configPath, launchAgentsDir, homeDir, uid, runLaunchctl, log.
export function makeDeps(overrides = {}) {
  const home = overrides.homeDir || homedir();
  return {
    configPath: overrides.configPath || defaultConfigPath(),
    launchAgentsDir: overrides.launchAgentsDir || join(home, "Library", "LaunchAgents"),
    homeDir: home,
    uid: overrides.uid ?? (process.getuid ? process.getuid() : 501),
    runLaunchctl: overrides.runLaunchctl || ((args) => spawnSync("launchctl", args, { encoding: "utf8" })),
    sleep: overrides.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)),
    log: overrides.log || (() => {}),
    isEnabled,
    isRunning,
    enable,
    disable,
    ...overrides,
  };
}

function plistPath(deps) {
  return join(deps.launchAgentsDir, `${DAEMON_LABEL}.plist`);
}

// "Enabled" == the LaunchAgent plist exists on disk.
export function isEnabled(deps) {
  return existsSync(plistPath(deps));
}

// "Running" == launchctl currently knows the label.
export function isRunning(deps) {
  const res = deps.runLaunchctl(["list"]);
  return typeof res.stdout === "string" && res.stdout.includes(DAEMON_LABEL);
}

// enable = write plist + (re)bootstrap the agent. Atomic: on bootstrap failure the
// plist is rolled back so isEnabled never lies (the tray's "daemon 起不来就别出码"
// guard depends on enable returning a real error).
export function enable(deps) {
  if (platform() !== "darwin") return { ok: false, enabled: false, error: "仅支持 macOS" };
  const logPath = join(deps.homeDir, ".cxx", "remote", "daemon.log");
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(deps.launchAgentsDir, { recursive: true });

  const programArguments = daemonProgramArguments(deps.configPath);
  writeFileSync(plistPath(deps), daemonPlist({ programArguments, logPath }));
  deps.runLaunchctl(["bootout", `gui/${deps.uid}/${DAEMON_LABEL}`]); // clear stale, ignore failure
  // launchd may need a short moment to retire the old job after bootout. An immediate
  // bootstrap occasionally returns “Bad request” during app upgrades even though the
  // exact same plist succeeds seconds later. Retry locally before rolling the plist back.
  let res;
  for (const waitMs of [0, 250, 750]) {
    if (waitMs) deps.sleep(waitMs);
    res = deps.runLaunchctl(["bootstrap", `gui/${deps.uid}`, plistPath(deps)]);
    if (res.status === 0) return { ok: true, enabled: true };
  }
  const msg = String(res?.stderr || res?.stdout || "launchctl bootstrap 失败").trim();
  deps.log(`bootstrap ${DAEMON_LABEL}: ${msg}`);
  rmSync(plistPath(deps), { force: true });
  return { ok: false, enabled: false, error: msg };
}

export function disable(deps) {
  deps.runLaunchctl(["bootout", `gui/${deps.uid}/${DAEMON_LABEL}`]);
  rmSync(plistPath(deps), { force: true });
  return { ok: true, enabled: false };
}

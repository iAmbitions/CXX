import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APP_BUNDLE_ID, daemonPlist, enable, launchdPath, makeDeps } from "../daemon/src/mac-agent.mjs";

const buildSource = readFileSync(new URL("../scripts/build-app.mjs", import.meta.url), "utf8");
const backendSource = readFileSync(new URL("../shell/macos/Sources/CXXMenuBar/Backend.swift", import.meta.url), "utf8");

test("macOS app bundles branded main and background executable names", () => {
  assert.match(buildSource, /const appExecutableName = "口袋Agent"/);
  assert.match(buildSource, /const backgroundExecutableName = "口袋Agent"/);
  assert.match(buildSource, /copyFileSync\(daemonBin, bundledDaemonBin\)/);
  assert.match(backendSource, /for name in \["口袋Agent", "cxx-daemon"\]/);
  assert.doesNotMatch(buildSource, /copyFileSync\(daemonBin, join\(resourcesDir, "cxx-daemon"\)\)/);
});

test("LaunchAgent is associated with the Pocket Agent app bundle", () => {
  const plist = daemonPlist({ programArguments: ["/Applications/口袋Agent.app/Contents/Resources/口袋Agent", "start"], logPath: "/tmp/daemon.log" });
  assert.equal(APP_BUNDLE_ID, "ai.wokey.cxx");
  assert.match(plist, /<key>AssociatedBundleIdentifiers<\/key>/);
  assert.match(plist, /<string>ai\.wokey\.cxx<\/string>/);
  assert.match(plist, /<string>\/Applications\/口袋Agent\.app\/Contents\/Resources\/口袋Agent<\/string>/);
});

test("LaunchAgent PATH covers Node version managers and inherited CLI paths", () => {
  const home = "/Users/Ada";
  const path = launchdPath(home, {
    env: { PATH: "/custom/bin:/usr/bin" },
    readDir: (root) => {
      if (root.endsWith("/.nvm/versions/node")) {
        return ["v20.19.0", "v24.16.0"].map((name) => ({ name, isDirectory: () => true }));
      }
      if (root.endsWith("/.fnm/node-versions")) {
        return [{ name: "v22.14.0", isDirectory: () => true }];
      }
      throw new Error("missing");
    },
  }).split(":");
  assert.equal(path[0], "/custom/bin");
  assert.ok(path.includes(`${home}/.npm-global/bin`));
  assert.ok(path.includes(`${home}/.volta/bin`));
  assert.ok(path.includes(`${home}/.asdf/shims`));
  assert.ok(path.includes(`${home}/.local/share/mise/shims`));
  assert.ok(path.includes(`${home}/.nvm/versions/node/v24.16.0/bin`));
  assert.ok(path.includes(`${home}/.fnm/node-versions/v22.14.0/installation/bin`));
  assert.equal(path.filter((entry) => entry === "/usr/bin").length, 1);
});


test("LaunchAgent upgrade retries a transient bootstrap race", () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-agent-mac-brand-"));
  const calls = [];
  const waits = [];
  let attempts = 0;
  try {
    const deps = makeDeps({
      homeDir: home,
      launchAgentsDir: join(home, "Library", "LaunchAgents"),
      configPath: join(home, ".cxx", "remote", "daemon.json"),
      uid: 502,
      sleep: (ms) => waits.push(ms),
      runLaunchctl: (args) => {
        calls.push(args);
        if (args[0] === "bootstrap") {
          attempts++;
          return attempts === 1 ? { status: 5, stderr: "Bootstrap failed: 5: Bad request" } : { status: 0 };
        }
        return { status: 0, stdout: "" };
      },
    });
    assert.deepEqual(enable(deps), { ok: true, enabled: true });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [250]);
    assert.equal(calls[0][0], "bootout");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

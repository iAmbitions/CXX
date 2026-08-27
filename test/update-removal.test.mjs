import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MENU_COMMANDS, runMenuCommand } from "../daemon/src/menu-backend.mjs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("update checking is absent from the daemon command surface", async () => {
  assert.equal(MENU_COMMANDS.has("check-update"), false);
  assert.equal(await runMenuCommand("check-update", [], {}), null);
});

test("desktop menus and help do not expose update checking", () => {
  for (const path of [
    "daemon/src/main.mjs",
    "shell/macos/Sources/CXXMenuBar/AppDelegate.swift",
    "shell/windows/CXXTray.cs",
    "README.md",
    "README.en.md",
  ]) {
    const text = source(path);
    assert.doesNotMatch(text, /check-update|检查更新|Check for updates/i, path);
  }
});

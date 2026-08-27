import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCodexRolloutPath } from "../daemon/src/app-server.mjs";
import { isDesktopRolloutActive } from "../daemon/src/client-session.mjs";
import { readRolloutTail } from "../daemon/src/rollout-tail.mjs";

const THREAD = "01a04361-79cb-7ea2-9258-f1cb140fbcd2";
const TURN = "01a04362-0a5b-72a3-83e1-9ad2e96a65cd";

function event(type) {
  return JSON.stringify({ type: "event_msg", payload: { type } });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cxx-codex-rollout-path-"));
  const oldDir = join(root, "sessions", "2026", "08", "26");
  const newDir = join(root, "sessions", "2026", "08", "27");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const stale = join(oldDir, `rollout-2026-08-26T23-59-00-${THREAD}.jsonl`);
  const current = join(newDir, `rollout-2026-08-27T00-01-00-${THREAD}_${TURN}.jsonl`);
  writeFileSync(stale, `${event("task_started")}\n${event("turn_aborted")}\n`);
  writeFileSync(current, `${event("task_started")}\n`);
  const old = new Date(Date.now() - 120_000);
  const fresh = new Date(Date.now() - 1_000);
  utimesSync(stale, old, old);
  utimesSync(current, fresh, fresh);
  return { root, stale, current, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("resolves a continued Codex thread to the newest rollout instead of the aborted original", async () => {
  const f = fixture();
  try {
    const actual = resolveCodexRolloutPath({ id: THREAD, path: f.stale, updatedAt: Date.now() / 1000 });
    assert.equal(actual, f.current);
    assert.equal(isDesktopRolloutActive(actual), true);
    const tail = await readRolloutTail(actual, 20);
    assert.equal(tail.items.at(-1)?.payload?.type, "task_started");
  } finally {
    f.cleanup();
  }
});

test("keeps the reported rollout when no continuation exists", () => {
  const root = mkdtempSync(join(tmpdir(), "cxx-codex-rollout-single-"));
  const dir = join(root, "sessions", "2026", "08", "27");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-27T10-00-00-${THREAD}.jsonl`);
  writeFileSync(path, `${event("task_complete")}\n`);
  try {
    assert.equal(resolveCodexRolloutPath({ id: THREAD, path, updatedAt: Date.now() / 1000 }), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

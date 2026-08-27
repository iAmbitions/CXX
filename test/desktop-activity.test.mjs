import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isDesktopRolloutActive } from "../daemon/src/client-session.mjs";

function event(type) {
  return JSON.stringify({ type: "event_msg", payload: { type } });
}

function fixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "cxx-desktop-activity-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("desktop activity requires an unfinished task_started boundary", () => {
  const f = fixture([
    event("task_started"),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
  ]);
  try {
    assert.equal(isDesktopRolloutActive(f.path), true);
  } finally {
    f.cleanup();
  }
});

test("a recent rollout completed after task_started is not reported as desktop activity", () => {
  const f = fixture([
    event("task_started"),
    event("task_complete"),
    // Codex may append bookkeeping after task_complete; that must not revive the card.
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed" } }),
  ]);
  try {
    assert.equal(isDesktopRolloutActive(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("old rollout files are never reported as desktop activity", () => {
  const f = fixture([event("task_started")]);
  try {
    const old = new Date(Date.now() - 61_000);
    utimesSync(f.path, old, old);
    assert.equal(isDesktopRolloutActive(f.path), false);
  } finally {
    f.cleanup();
  }
});

test("Codex image protocol markup is removed while the image is retained as an image ref", async () => {
  const { extractImages } = await import("../daemon/src/client-session.mjs");
  const encoded = "A".repeat(4097);
  const out = extractImages({
    type: "response_item",
    payload: {
      type: "message",
      content: [
        { type: "input_text", text: "用户的问题" },
        { type: "input_text", text: '<image name="Image #1" path="/private/tmp/picture.png">' },
        { type: "input_image", image_url: `data:image/png;base64,${encoded}` },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "<image_resize_notice>resized</image_resize_notice>" },
      ],
    },
  }, "thread-1");
  const content = out.payload.content;
  assert.deepEqual(content.filter((c) => c.type === "input_text").map((c) => c.text), ["用户的问题"]);
  assert.ok(content.find((c) => c.type === "input_image")?.imageRef?.id);
});

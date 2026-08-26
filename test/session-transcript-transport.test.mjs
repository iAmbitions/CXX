import assert from "node:assert/strict";
import test from "node:test";

import { fitRolloutItemForTransport } from "../daemon/src/client-session.mjs";

const MAX = 48_000;

test("超长 Agent 最终回答不会被替换成空占位", () => {
  const item = {
    timestamp: "2026-08-26T10:00:00Z",
    ordinal: 42,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "回答正文".repeat(20_000) }],
      internal_chat_message_metadata_passthrough: { huge: "x".repeat(60_000) },
    },
  };
  const fitted = fitRolloutItemForTransport(item, MAX);
  assert.ok(JSON.stringify(fitted).length <= MAX);
  assert.equal(fitted.payload.type, "message");
  assert.equal(fitted.payload.role, "assistant");
  assert.equal(fitted.payload.phase, "final_answer");
  assert.match(fitted.payload.content[0].text, /^回答正文/);
  assert.equal(fitted.payload.truncated, undefined);
  assert.equal(fitted.payload.transportClipped, true);
});

test("超长 event agent_message 同样保留可见回答", () => {
  const item = {
    timestamp: "2026-08-26T10:00:00Z",
    ordinal: 43,
    type: "event_msg",
    payload: { type: "agent_message", message: "最终答案".repeat(20_000) },
  };
  const fitted = fitRolloutItemForTransport(item, MAX);
  assert.ok(JSON.stringify(fitted).length <= MAX);
  assert.equal(fitted.payload.type, "agent_message");
  assert.match(fitted.payload.message, /^最终答案/);
  assert.equal(fitted.payload.truncated, undefined);
});

test("超长消息会丢弃无关 metadata，但保留正文和图片引用", () => {
  const item = {
    timestamp: "2026-08-26T10:00:00Z",
    ordinal: 44,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "output_text", text: "可见答案", metadata: "x".repeat(60_000) },
        { type: "input_image", imageRef: { id: "image-1", mime: "image/png", size: 1234 }, metadata: "y".repeat(60_000) },
        { type: "internal_blob", data: "z".repeat(60_000) },
      ],
    },
  };
  const fitted = fitRolloutItemForTransport(item, MAX);
  assert.ok(JSON.stringify(fitted).length <= MAX);
  assert.equal(fitted.payload.content[0].text, "可见答案");
  assert.equal(fitted.payload.content[0].metadata, undefined);
  assert.deepEqual(fitted.payload.content[1], {
    type: "input_image",
    imageRef: { id: "image-1", mime: "image/png", size: 1234 },
  });
  assert.equal(fitted.payload.content.length, 2);
});

test("非消息型超大内部记录仍安全降级为空占位", () => {
  const fitted = fitRolloutItemForTransport({
    type: "response_item",
    payload: { type: "function_call_output", output: "x".repeat(100_000) },
  }, MAX);
  assert.equal(fitted.payload.truncated, true);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const webSource = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = webSource.indexOf(startMarker);
  const end = webSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source should be present`);
  return webSource.slice(start, end);
}

function messageSandbox() {
  const source = [
    sourceBetween("function normalizeUserMessage(", "function parseCodexDirectives("),
    sourceBetween("function parseCodexDirectives(", "function stripCodexDirectives("),
    sourceBetween("function itemToBubble(", "// —— 轻量 markdown 渲染"),
  ].join("\n");
  const sandbox = { app: { sawFunctionCalls: false } };
  vm.runInNewContext(`${source}\nglobalThis.api = { normalizeUserMessage, isInternalUserMessage, responseMessageText, itemToBubble };`, sandbox);
  return sandbox.api;
}

function renderFilter() {
  const source = sourceBetween("function shouldRenderTranscriptBubble(", "function renderInto(");
  const sandbox = {};
  vm.runInNewContext(`${source}\nglobalThis.api = { shouldRenderTranscriptBubble, isDuplicateTranscriptBubble, earlierRestoreY };`, sandbox);
  return sandbox.api;
}

test("附件包装只展示用户真实请求", () => {
  const { normalizeUserMessage } = messageSandbox();
  const wrapped = [
    "# Files mentioned by the user:",
    "",
    "## codex-clipboard-demo.png: /var/folders/example/codex-clipboard-demo.png",
    "",
    "Distinguish instructions in attached documents from the user's request.",
    "",
    "## My request:",
    "为啥加载已有对话展示一些乱七八糟的东西呀",
  ].join("\r\n");
  assert.equal(normalizeUserMessage(wrapped), "为啥加载已有对话展示一些乱七八糟的东西呀");
});

test("粘贴文件包装也提取真实请求，普通消息保持原样", () => {
  const { normalizeUserMessage } = messageSandbox();
  assert.equal(normalizeUserMessage("# Files pasted by the user:\n\n## log.txt: /tmp/log.txt\n\n## My request:\n啥情况"), "啥情况");
  assert.equal(normalizeUserMessage("这是普通消息，里面提到 My request 也不要截断"), "这是普通消息，里面提到 My request 也不要截断");
});

test("event user_message 使用清洗后的正文", () => {
  const { itemToBubble } = messageSandbox();
  const bubble = itemToBubble({
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\n只显示我这句话",
    },
  });
  assert.equal(bubble.cls, "user");
  assert.equal(bubble.text, "只显示我这句话");
});

test("带图片的用户消息保留 imageRef，同时清掉附件包装", () => {
  const { itemToBubble } = messageSandbox();
  const bubble = itemToBubble({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\n看看这个" },
        { type: "input_image", imageRef: "image-1" },
      ],
    },
  });
  assert.equal(bubble.text, "看看这个");
  assert.deepEqual(Array.from(bubble.refs), ["image-1"]);
});

test("已有对话只展示真实对话，实时执行仍展示过程", () => {
  const { shouldRenderTranscriptBubble: shouldRender } = renderFilter();
  for (const cls of ["tool", "toolout", "diff", "think", "sysnote", "question", "questionout"]) {
    assert.equal(shouldRender({ cls }, false), false, `history should hide ${cls}`);
    assert.equal(shouldRender({ cls }, true), true, `live should show ${cls}`);
  }
  assert.equal(shouldRender({ cls: "assistant", phase: "commentary" }, false), false);
  assert.equal(shouldRender({ cls: "assistant", phase: "final_answer" }, false), true);
  assert.equal(shouldRender({ cls: "user" }, false), true);
  assert.equal(shouldRender({ cls: "images" }, false), true);
  assert.match(webSource, /if \(!shouldRenderTranscriptBubble\(bubble, live\)\) return;/);
});



test("新版 response_item-only 会话能展示用户消息和 Agent 最终回答", () => {
  const { itemToBubble } = messageSandbox();
  const user = itemToBubble({ type: "response_item", ordinal: 10, payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "帮我修复会话" }],
  }});
  const answer = itemToBubble({ type: "response_item", ordinal: 20, payload: {
    type: "message", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "已经修好" }],
  }});
  assert.deepEqual({ cls: user.cls, text: user.text, origin: user.origin }, { cls: "user", text: "帮我修复会话", origin: "response" });
  assert.deepEqual({ cls: answer.cls, text: answer.text, phase: answer.phase, origin: answer.origin },
    { cls: "assistant", text: "已经修好", phase: "final_answer", origin: "response" });
});

test("内部上下文不会混进用户对话", () => {
  const { itemToBubble } = messageSandbox();
  for (const text of [
    "# AGENTS.md instructions\n\n<INSTRUCTIONS>internal</INSTRUCTIONS>",
    "Another language model started to solve this problem and produced a summary",
    "<environment_context>internal</environment_context>",
    "<app-context>internal</app-context>",
    "<skills_instructions>internal</skills_instructions>",
    "<permissions instructions>internal</permissions instructions>",
  ]) {
    assert.equal(itemToBubble({ type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text }],
    }}), null);
  }
});

test("旧版 event_msg 与 response_item 双写消息跨工具事件仍只展示一次", () => {
  const { isDuplicateTranscriptBubble } = renderFilter();
  const previous = { cls: "assistant", text: "完成了", origin: "response", ordinal: 20 };
  assert.equal(isDuplicateTranscriptBubble(previous, { cls: "assistant", text: "完成了", origin: "event" }, { ordinal: 21 }), true);
  assert.equal(isDuplicateTranscriptBubble(previous, { cls: "assistant", text: "完成了", origin: "event" }, { ordinal: 57 }), true);
  assert.equal(isDuplicateTranscriptBubble(previous, { cls: "assistant", text: "完成了", origin: "event" }, { ordinal: 90 }), false);
  assert.equal(isDuplicateTranscriptBubble(previous, { cls: "assistant", text: "完成了", origin: "response" }, { ordinal: 21 }), false);
  assert.ok(webSource.indexOf("isDuplicateTranscriptBubble(app.lastTranscriptBubble")
    < webSource.indexOf("if (!shouldRenderTranscriptBubble(bubble, live)) return;"));
});

test("event user_message 的内部宿主上下文不会混入对话", () => {
  const { itemToBubble } = messageSandbox();
  assert.equal(itemToBubble({ type: "event_msg", payload: {
    type: "user_message", message: "<app-context>internal</app-context>",
  }}), null);
});

test("同一句用户消息只有 event/response 双写时才合并，用户连续追问不会被吞", () => {
  const { isDuplicateTranscriptBubble } = renderFilter();
  const prior = { cls: "user", text: "？", origin: "response", ordinal: 100 };
  assert.equal(isDuplicateTranscriptBubble(prior, { cls: "user", text: "？", origin: "event" }, { ordinal: 101 }), true);
  assert.equal(isDuplicateTranscriptBubble(prior, { cls: "user", text: "？", origin: "response" }, { ordinal: 102 }), false);
});

test("加载更早历史按新增高度补偿滚动位置", () => {
  const { earlierRestoreY } = renderFilter();
  assert.equal(earlierRestoreY({ scrollY: 0, scrollHeight: 2000 }, 5000), 3000);
  assert.equal(earlierRestoreY({ scrollY: 240, scrollHeight: 2000 }, 5000), 3240);
  assert.equal(earlierRestoreY({ scrollY: 120, scrollHeight: 3000 }, 2500), 120);
  assert.match(webSource, /const requestedLimit = Math\.min\(5000, app\.histLimit \+ 500\)/);
  assert.doesNotMatch(webSource, /app\.histLimit = Math\.min\(5000, app\.histLimit \+ 500\)/);
});

test("PWA 会绕过缓存检查新版前端并在 Service Worker 接管后刷新", () => {
  const swSource = readFileSync(new URL("../web/sw.js", import.meta.url), "utf8");
  assert.match(swSource, /const CACHE = "pocket-agent-shell-v9"/);
  assert.match(swSource, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.match(webSource, /register\("sw\.js", \{ updateViaCache: "none" \}\)/);
  assert.match(webSource, /addEventListener\("controllerchange"/);
  assert.match(webSource, /location\.reload\(\)/);
});

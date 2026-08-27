import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpenCodeBackend,
  buildOpenCodeConfiguredModelCatalog,
  buildOpenCodeModelCatalog,
  openCodeMessageToTranscript,
  openCodePermissionRules,
  parseOpenCodeModelRef,
} from "../daemon/src/opencode-backend.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fakeOpenCode({
  configResponse = { model: "p/default", permission: { "*": "ask" } },
  providerResponse = {
    connected: ["p"], default: { p: "default" }, all: [{ id: "p", name: "Provider", models: {
      default: { id: "default", name: "Default", family: "x", variants: { high: {} }, status: "active" },
      disabled: { id: "disabled", name: "Disabled", status: "disabled" },
    } }],
  },
} = {}) {
  const streams = new Set();
  const requests = [];
  const sessions = new Map();
  const messages = new Map();
  const json = (res, value, status = 200) => {
    const body = status === 204 ? "" : JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  const emit = (payload, directory = "/work") => {
    const line = `data: ${JSON.stringify({ directory, project: "global", payload })}\n\n`;
    for (const res of streams) res.write(line);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === "/global/health") return json(res, { healthy: true });
    if (url.pathname === "/global/event") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (url.pathname === "/config") return json(res, configResponse);
    if (url.pathname === "/session/status") return json(res, {});
    if (url.pathname === "/provider") return json(res, providerResponse);
    if (url.pathname === "/experimental/session") return json(res, [...sessions.values()]);
    if (url.pathname === "/session" && req.method === "POST") {
      const id = "ses_test";
      const session = { id, slug: "test", projectID: "global", directory: url.searchParams.get("directory") || "/work", title: body?.title, version: "1", time: { created: Date.now(), updated: Date.now() } };
      sessions.set(id, session); messages.set(id, []); return json(res, session);
    }
    const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (match) {
      const [, id, action] = match; const session = sessions.get(id);
      if (action === "message") return json(res, messages.get(id) || []);
      if (action === "prompt_async") {
        const user = { info: { id: "msg_u", sessionID: id, role: "user", time: { created: Date.now() }, model: body.model, agent: body.agent }, parts: body.parts };
        const assistant = { info: { id: "msg_a", sessionID: id, role: "assistant", time: { created: Date.now(), completed: Date.now() }, providerID: body.model?.providerID, modelID: body.model?.modelID, tokens: { output: 2, reasoning: 1 }, path: { cwd: session.directory } }, parts: [{ type: "text", text: "OK" }] };
        messages.set(id, [user, assistant]);
        emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } }, session.directory);
        emit({ type: "message.part.updated", properties: { sessionID: id, part: { id: "prt_text", type: "text", text: "" } } }, session.directory);
        emit({ type: "message.part.delta", properties: { sessionID: id, partID: "prt_reason", field: "text", delta: "secret reasoning" } }, session.directory);
        emit({ type: "message.part.delta", properties: { sessionID: id, partID: "prt_text", field: "text", delta: "OK" } }, session.directory);
        emit({ type: "session.idle", properties: { sessionID: id } }, session.directory);
        await wait(20); return json(res, null, 204);
      }
      if (action === "abort") return json(res, true);
      if (action === "fork") {
        const forked = { ...session, id: "ses_fork", parentID: id, time: { created: Date.now(), updated: Date.now() } };
        sessions.set(forked.id, forked); messages.set(forked.id, messages.get(id) || []); return json(res, forked);
      }
      if (!action && req.method === "PATCH") {
        const updated = { ...session, ...body, time: { ...session.time, ...(body?.time || {}) } };
        sessions.set(id, updated); return json(res, updated);
      }
      if (!action) return json(res, session || {}, session ? 200 : 404);
    }
    if (/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return json(res, true);
    if (/^\/question\/[^/]+\/reply$/.test(url.pathname)) return json(res, true);
    json(res, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests, sessions, messages, emit,
    close: () => new Promise((resolve) => { for (const res of streams) res.end(); server.close(resolve); }),
  };
}

function makeBackend(fake, baseDir) {
  return new OpenCodeBackend({ baseUrl: fake.url, baseDir, log: () => {} });
}

test("OpenCode model refs, permissions and transcript normalization", () => {
  assert.deepEqual(parseOpenCodeModelRef("jdcloud/model/x"), { providerID: "jdcloud", modelID: "model/x" });
  assert.equal(parseOpenCodeModelRef("invalid"), null);
  assert.equal(openCodePermissionRules("full")[0].action, "allow");
  assert.ok(openCodePermissionRules("readonly").every((rule) => rule.action === "deny"));
  const entry = openCodeMessageToTranscript({
    info: { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 1, completed: 2 }, tokens: { output: 3, reasoning: 4 } },
    parts: [{ type: "tool", callID: "c1", tool: "question", state: { status: "completed", input: { questions: [] }, output: "done" } }],
  });
  assert.equal(entry.message.model, "p/m");
  assert.equal(entry.message.usage.output_tokens, 7);
  assert.equal(entry.message.content[0].name, "AskUserQuestion");
  assert.equal(entry.message.content[1].tool_use_id, "c1");
});

test("OpenCode configured catalog can be built from the small config response alone", () => {
  const models = buildOpenCodeConfiguredModelCatalog({
    model: "custom/chosen",
    provider: { custom: { name: "Custom", models: {
      chosen: { name: "Chosen", family: "x", variants: { high: {} } },
      extra: { name: "Extra" },
    } } },
  });
  assert.deepEqual(models.map((m) => [m.id, m.isDefault]), [
    ["custom/chosen", true],
    ["custom/extra", false],
  ]);
  assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: "high" }]);
});

test("OpenCode model catalog prefers explicitly configured models over full connected catalogs", () => {
  const providers = {
    connected: ["builtin", "custom"],
    all: [
      { id: "builtin", name: "Built in", models: {
        a: { id: "a", name: "A" },
        b: { id: "b", name: "B" },
      } },
      { id: "custom", name: "Custom", models: {
        chosen: { id: "chosen", name: "Chosen", variants: { high: {} } },
        extra: { id: "extra", name: "Extra" },
      } },
    ],
  };
  const models = buildOpenCodeModelCatalog(providers, {
    model: "custom/chosen",
    provider: { custom: { models: { chosen: { name: "Chosen" } } } },
  });
  assert.deepEqual(models.map((m) => [m.id, m.isDefault]), [["custom/chosen", true]]);
  assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: "high" }]);
});

test("OpenCode model catalog keeps the full connected list when no model allowlist is configured", () => {
  const providers = {
    connected: ["p"],
    all: [{ id: "p", name: "Provider", models: {
      a: { id: "a", name: "A" },
      b: { id: "b", name: "B" },
    } }],
  };
  assert.deepEqual(
    buildOpenCodeModelCatalog(providers, { model: "p/b" }).map((m) => [m.id, m.isDefault]),
    [["p/b", true], ["p/a", false]],
  );
});

test("OpenCode backend serves configured models from startup cache without loading the full provider catalog", async (t) => {
  const fake = await fakeOpenCode({
    configResponse: {
      model: "custom/chosen",
      permission: { "*": "ask" },
      provider: { custom: { name: "Custom", models: { chosen: { name: "Chosen" } } } },
    },
  });
  const baseDir = mkdtempSync(join(tmpdir(), "cxx-opencode-test-"));
  const backend = makeBackend(fake, baseDir);
  t.after(async () => { backend.stop(); await fake.close(); rmSync(baseDir, { recursive: true, force: true }); });
  await backend.start();
  const [first, second] = await Promise.all([backend.request("model/list"), backend.request("model/list")]);
  assert.deepEqual(first.data.map((m) => m.id), ["custom/chosen"]);
  assert.deepEqual(second.data.map((m) => m.id), ["custom/chosen"]);
  assert.equal(fake.requests.filter((request) => request.path === "/provider").length, 0);
  assert.equal(fake.requests.filter((request) => request.path === "/config").length, 1);
});

test("OpenCode backend lists global sessions and exposes one real default model", async (t) => {
  const fake = await fakeOpenCode();
  const baseDir = mkdtempSync(join(tmpdir(), "cxx-opencode-test-"));
  const backend = makeBackend(fake, baseDir);
  t.after(async () => { backend.stop(); await fake.close(); rmSync(baseDir, { recursive: true, force: true }); });
  await backend.start();
  await backend.startThread({ cwd: "/work/a" });
  const page = await backend.listThreadsPage({ limit: 50 });
  assert.equal(page.items[0].source, "opencode");
  assert.ok(fake.requests.some((r) => r.path === "/experimental/session" && r.query.roots === "true"));
  const models = (await backend.request("model/list")).data;
  assert.deepEqual(models.map((m) => [m.id, m.isDefault]), [["p/default", true]]);
});

test("OpenCode fast async turn emits start, delta and terminal state without remaining running", async (t) => {
  const fake = await fakeOpenCode();
  const baseDir = mkdtempSync(join(tmpdir(), "cxx-opencode-test-"));
  const backend = makeBackend(fake, baseDir);
  const events = [];
  backend.onNotification = (method, params) => events.push({ method, params });
  t.after(async () => { backend.stop(); await fake.close(); rmSync(baseDir, { recursive: true, force: true }); });
  await backend.start();
  const { threadId } = await backend.startThread({ cwd: "/work/a" });
  const result = await backend.startTurn(threadId, [{ type: "text", text: "hello" }], {
    model: "p/default", effort: "high", permissionPreset: "readonly",
  });
  await wait(80);
  assert.ok(result.turnId);
  assert.deepEqual(events.map((x) => x.method), ["turn/started", "agent_message_delta", "turn/completed"]);
  assert.equal((await backend.readThread(threadId)).status, "idle");
  const transcript = readFileSync(join(baseDir, `${threadId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(transcript.at(-1).message.content[0].text, "OK");
  const patch = fake.requests.find((r) => r.method === "PATCH" && r.path === `/session/${threadId}`);
  assert.equal(patch.body.permission.find((r) => r.permission === "bash").action, "deny");
  const prompt = fake.requests.find((r) => r.path.endsWith("/prompt_async"));
  assert.deepEqual(prompt.body.model, { providerID: "p", modelID: "default" });
  assert.equal(prompt.body.variant, "high");
});

test("OpenCode permission and question events bridge to existing approval/question protocol", async (t) => {
  const fake = await fakeOpenCode();
  const baseDir = mkdtempSync(join(tmpdir(), "cxx-opencode-test-"));
  const backend = makeBackend(fake, baseDir);
  const approvals = [];
  backend.onServerRequest = (...args) => approvals.push(args);
  t.after(async () => { backend.stop(); await fake.close(); rmSync(baseDir, { recursive: true, force: true }); });
  await backend.start();
  const { threadId } = await backend.startThread({ cwd: "/work/a" });
  fake.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: threadId, permission: "bash", patterns: ["git status"], metadata: {}, always: [] } }, "/work/a");
  fake.emit({ type: "question.asked", properties: { id: "que_1", sessionID: threadId, questions: [{ header: "Choice", question: "Pick", options: [{ label: "A", description: "a" }], multiple: false }], tool: { messageID: "m", callID: "call_q" } } }, "/work/a");
  await wait(80);
  assert.equal(approvals[0][0], "per_1");
  assert.equal(approvals[0][1], "execCommandApproval");
  const transcript = readFileSync(join(baseDir, `${threadId}.jsonl`), "utf8");
  assert.match(transcript, /AskUserQuestion/);
  backend.respond("per_1", { decision: "acceptForSession" });
  await backend.answerQuestion(threadId, "call_q", { Pick: "A" });
  await wait(20);
  assert.equal(fake.requests.find((r) => r.path === "/permission/per_1/reply").body.reply, "always");
  assert.deepEqual(fake.requests.find((r) => r.path === "/question/que_1/reply").body.answers, [["A"]]);
});

test("OpenCode abort suppresses a late busy event instead of resurrecting the turn", async (t) => {
  const fake = await fakeOpenCode();
  const baseDir = mkdtempSync(join(tmpdir(), "cxx-opencode-test-"));
  const backend = makeBackend(fake, baseDir);
  const events = [];
  backend.onNotification = (method) => events.push(method);
  t.after(async () => { backend.stop(); await fake.close(); rmSync(baseDir, { recursive: true, force: true }); });
  await backend.start();
  const { threadId } = await backend.startThread({ cwd: "/work/a" });
  // Seed a running turn without waiting for the fake prompt handler's fast completion.
  fake.emit({ type: "session.status", properties: { sessionID: threadId, status: { type: "busy" } } }, "/work/a");
  await wait(20);
  await backend.interruptTurn(threadId);
  fake.emit({ type: "session.status", properties: { sessionID: threadId, status: { type: "busy" } } }, "/work/a");
  await wait(30);
  assert.deepEqual(events, ["turn/started", "turn/aborted"]);
  assert.equal((await backend.readThread(threadId)).status, "idle");
});

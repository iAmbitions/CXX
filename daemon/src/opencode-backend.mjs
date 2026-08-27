import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { CachedProjects } from "./project-index.mjs";
import { killProcessTree } from "./proc-reap.mjs";
import { openCodeInvocation } from "./opencode-path.mjs";

const MODEL_LIST_CACHE_MS = 60_000;

function withQuery(path, values = {}) {
  const url = new URL(path, "http://127.0.0.1");
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function cleanError(error) {
  return String(error?.data?.message || error?.message || error?.name || "OpenCode 执行失败")
    .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
}

export function parseOpenCodeModelRef(value) {
  const raw = String(value || "").trim();
  const slash = raw.indexOf("/");
  return slash > 0 && slash < raw.length - 1
    ? { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
    : null;
}

function toolName(part) {
  return /^(question|askuserquestion)$/i.test(part?.tool || "") ? "AskUserQuestion" : (part?.tool || "tool");
}

function toolOutput(state) {
  if (typeof state?.output === "string") return state.output;
  if (typeof state?.error === "string") return state.error;
  if (state?.result !== undefined) return typeof state.result === "string" ? state.result : JSON.stringify(state.result);
  if (Array.isArray(state?.content)) return state.content.map((x) => x?.text || x?.content || "").filter(Boolean).join("\n");
  return "";
}

export function openCodeMessageToTranscript(row) {
  const info = row?.info || {};
  const role = info.role === "user" ? "user" : "assistant";
  const content = [];
  for (const part of row?.parts || []) {
    if (part?.type === "text" && part.text && !part.ignored) content.push({ type: "text", text: part.text });
    else if (part?.type === "reasoning" && part.text) content.push({ type: "thinking", thinking: part.text });
    else if (part?.type === "file" && part.url) {
      const source = String(part.url).startsWith("data:")
        ? { type: "base64", media_type: part.mime || "application/octet-stream", data: String(part.url).split(",", 2)[1] || "" }
        : null;
      content.push(source?.data
        ? { type: "image", source }
        : { type: "text", text: part.filename ? `[File: ${part.filename}]` : `[File: ${part.url}]` });
    } else if (part?.type === "tool") {
      const state = part.state || {};
      const callId = part.callID || part.id;
      content.push({ type: "tool_use", id: callId, name: toolName(part), input: state.input || {} });
      if (["completed", "error"].includes(state.status)) content.push({
        type: "tool_result",
        tool_use_id: callId,
        content: toolOutput(state),
        is_error: state.status === "error",
      });
    }
  }
  const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
  const outputTokens = Number(info.tokens?.output || 0) + Number(info.tokens?.reasoning || 0);
  return {
    type: role,
    uuid: info.id || randomUUID(),
    cwd: info.path?.cwd,
    timestamp: new Date(info.time?.completed || info.time?.created || Date.now()).toISOString(),
    message: {
      role,
      content,
      ...(model ? { model } : {}),
      ...(outputTokens ? { usage: { output_tokens: outputTokens } } : {}),
      ...(role === "assistant" && info.time?.completed ? { stop_reason: "end_turn" } : {}),
    },
  };
}

function questionEntry(request) {
  const callId = request.tool?.callID || request.id;
  return {
    type: "assistant",
    uuid: `question-${request.id}`,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: callId,
        name: "AskUserQuestion",
        input: {
          questions: (request.questions || []).map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options || [],
            multiSelect: q.multiple === true,
          })),
        },
      }],
    },
  };
}

export function openCodePermissionRules(preset) {
  if (preset === "readonly") return [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "write", pattern: "*", action: "deny" },
    { permission: "patch", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
  ];
  if (preset === "auto") return [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "write", pattern: "*", action: "allow" },
    { permission: "patch", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
  ];
  if (preset === "full") return [{ permission: "*", pattern: "*", action: "allow" }];
  return null;
}

function configPermissionRules(permission) {
  if (Array.isArray(permission)) return permission;
  const rules = [];
  for (const [name, value] of Object.entries(permission || {})) {
    if (typeof value === "string") rules.push({ permission: name, pattern: "*", action: value });
    else for (const [pattern, action] of Object.entries(value || {})) rules.push({ permission: name, pattern, action });
  }
  return rules;
}

function openCodeConfiguredModelRefs(config) {
  if (!config || typeof config !== "object") return new Set();
  const refs = new Set();
  const add = (value) => {
    if (typeof value === "string" && parseOpenCodeModelRef(value)) refs.add(value.trim());
  };
  add(config.model);
  add(config.small_model);
  for (const agent of Object.values(config.agent || {})) add(agent?.model);
  for (const [providerID, provider] of Object.entries(config.provider || {})) {
    for (const modelID of Object.keys(provider?.models || {})) refs.add(`${providerID}/${modelID}`);
  }
  return refs;
}

export function buildOpenCodeConfiguredModelCatalog(config = {}) {
  const providers = [];
  for (const [providerID, provider] of Object.entries(config?.provider || {})) {
    const entries = Object.entries(provider?.models || {});
    if (!entries.length) continue;
    providers.push({
      id: providerID,
      name: provider?.name || providerID,
      models: Object.fromEntries(entries.map(([modelID, model]) => [modelID, { ...model, id: modelID }])),
    });
  }
  if (!providers.length) return [];
  return buildOpenCodeModelCatalog({ connected: providers.map((provider) => provider.id), all: providers }, config);
}

export function buildOpenCodeModelCatalog(providerResponse, configOrModel = null) {
  const config = configOrModel && typeof configOrModel === "object" ? configOrModel : {};
  const configuredModel = typeof configOrModel === "string" ? configOrModel : config.model || null;
  const configuredRefs = openCodeConfiguredModelRefs(config);
  const hasExplicitCatalog = Object.values(config.provider || {}).some(
    (provider) => Object.keys(provider?.models || {}).length > 0,
  );
  const enabled = new Set(config.enabled_providers || []);
  const disabled = new Set(config.disabled_providers || []);
  const connected = new Set(providerResponse?.connected || []);
  const models = [];
  for (const provider of providerResponse?.all || []) {
    if (!connected.has(provider.id) || disabled.has(provider.id)) continue;
    if (enabled.size && !enabled.has(provider.id)) continue;
    for (const [catalogID, raw] of Object.entries(provider.models || {})) {
      if (!raw?.id || raw.status === "disabled") continue;
      const id = `${provider.id}/${raw.id}`;
      // OpenCode 的 /provider 会把所有已连接 provider 的完整 models.dev
      // 目录都返回。只要用户配置里声明过模型，就仅展示这些显式模型，
      // 再补上默认/小模型/agent 引用，避免手机端一次出现上百个无关项。
      if (hasExplicitCatalog && !configuredRefs.has(id) && !configuredRefs.has(`${provider.id}/${catalogID}`)) continue;
      models.push({
        id,
        model: id,
        displayName: `${raw.name || raw.id}${provider.name ? ` · ${provider.name}` : ""}`,
        description: raw.family || "",
        supportedReasoningEfforts: Object.keys(raw.variants || {}).map((reasoningEffort) => ({ reasoningEffort })),
        defaultReasoningEffort: null,
        isDefault: id === configuredModel,
      });
    }
  }
  if (!models.some((m) => m.isDefault) && models[0]) models[0].isDefault = true;
  models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
  return models;
}

export class OpenCodeBackend {
  #command; #port; #base; #log; #env; #fetch; #spawn; #baseUrl;
  #child = null; #closed = false; #abort = null; #eventTask = null; #eventReady = null; #resolveEventReady = null;
  #sessions = new Map(); #turns = new Map(); #failed = new Map(); #pending = new Map(); #ignoreBusyUntil = new Map();
  #pendingQuestions = new Map(); #syncTimers = new Map(); #partTypes = new Map(); #projects;
  #defaultPermissions = []; #modelCache = null; #modelLoad = null;
  onNotification = () => {};
  onServerRequest = () => {};
  onServerRequestCancel = () => {};
  onStateChange = () => {};
  healthy = false;

  constructor({ command = "opencode", port, baseDir, log = () => {}, env = null, baseUrl = null, fetchImpl = fetch, spawnImpl = spawn } = {}) {
    this.#command = command;
    this.#port = port;
    this.#base = baseDir;
    this.#log = log;
    this.#env = env;
    this.#fetch = fetchImpl;
    this.#spawn = spawnImpl;
    this.#baseUrl = baseUrl;
    mkdirSync(this.#base, { recursive: true });
    this.#projects = new CachedProjects(() => this.listThreads(5000));
  }

  get url() { return this.#baseUrl || `http://127.0.0.1:${this.#port}`; }

  async start() {
    this.#closed = false;
    let spawnError = null;
    if (!this.#baseUrl) {
      const invocation = openCodeInvocation(this.#command, ["serve", "--hostname", "127.0.0.1", "--port", String(this.#port)], { env: this.#env || process.env });
      this.#child = this.#spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "ignore", "pipe"], detached: true, ...(this.#env ? { env: this.#env } : {}),
      });
      this.#child.stderr?.on("data", (x) => this.#log(`[opencode] ${String(x).trimEnd()}`));
      this.#child.once("error", (err) => { spawnError = err; });
      this.#child.on("exit", (code) => {
        this.healthy = false;
        this.onStateChange(false);
        if (!this.#closed) this.#log(`OpenCode server 退出（code=${code}）`);
      });
    }
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw new Error(`OpenCode server 启动失败: ${spawnError.message}`);
      try { const r = await this.#fetch(`${this.url}/global/health`); if (r.ok) break; } catch {}
      if (i === 99) throw new Error("OpenCode server 启动超时");
      await delay(100);
    }
    try {
      const config = await this.#api("/config");
      this.#defaultPermissions = configPermissionRules(config?.permission);
      const models = buildOpenCodeConfiguredModelCatalog(config);
      if (models.length) this.#modelCache = { at: Date.now(), data: models };
    } catch {}
    try {
      const statuses = await this.#api("/session/status");
      for (const [id, status] of Object.entries(statuses || {})) {
        if (status?.type && status.type !== "idle") this.#turns.set(id, id);
      }
    } catch {}
    this.#eventReady = new Promise((resolve) => { this.#resolveEventReady = resolve; });
    this.#eventTask = this.#listenEvents();
    await Promise.race([this.#eventReady, delay(3000)]);
    this.healthy = true;
    this.onStateChange(true);
  }

  stop() {
    this.#closed = true;
    this.#abort?.abort();
    for (const timer of this.#syncTimers.values()) clearTimeout(timer);
    this.#syncTimers.clear();
    if (this.#child?.pid) killProcessTree(this.#child.pid, this.#log);
    this.#child = null;
    this.#modelCache = null;
    this.#modelLoad = null;
    this.healthy = false;
  }

  async #api(path, { method = "GET", body, directory, query } = {}) {
    const target = withQuery(path, { ...(query || {}), directory });
    const res = await this.#fetch(`${this.url}${target}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { const parsed = JSON.parse(text); detail = cleanError(parsed?.error || parsed); } catch {}
      throw new Error(detail || `OpenCode HTTP ${res.status}`);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  async #listenEvents() {
    while (!this.#closed) {
      this.#abort = new AbortController();
      try {
        const res = await this.#fetch(`${this.url}/global/event`, { signal: this.#abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.#resolveEventReady?.();
        this.#resolveEventReady = null;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!this.#closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          for (;;) {
            const at = buf.indexOf("\n\n");
            if (at < 0) break;
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const data = block.split("\n").filter((x) => x.startsWith("data:")).map((x) => x.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try { await this.#event(JSON.parse(data)); } catch (err) { this.#log(`OpenCode 事件处理失败: ${err.message}`); }
          }
        }
      } catch (err) {
        if (!this.#closed && err?.name !== "AbortError") this.#log(`OpenCode 事件流断开: ${err.message}`);
      }
      if (!this.#closed) await delay(1000);
    }
  }

  async #event(envelope) {
    const event = envelope?.payload || envelope;
    const p = event?.properties || {};
    const id = p.sessionID || p.info?.sessionID || p.part?.sessionID;
    if (!event || !id) return;
    const directory = envelope?.directory || this.#sessions.get(id)?.directory;
    if (event.type === "session.status" && p.status?.type && p.status.type !== "idle") {
      if ((this.#ignoreBusyUntil.get(id) || 0) > Date.now()) return;
      this.#ignoreBusyUntil.delete(id);
      if (!this.#turns.has(id)) {
        this.#turns.set(id, id);
        this.onNotification("turn/started", { threadId: id, turnId: id });
      }
    } else if (event.type === "message.part.updated") {
      if (p.part?.id && p.part?.type) this.#partTypes.set(p.part.id, p.part.type);
      if (p.part?.type === "tool") this.#scheduleSync(id);
    } else if (event.type === "message.part.delta" && p.field === "text" && p.delta) {
      // OpenCode 对 reasoning 与最终正文都发送 field=text；只能把已确认属于 text part
      // 的增量送到聊天气泡，避免把模型内部思考过程泄漏到最终回答流里。
      if (this.#partTypes.get(p.partID) === "text") {
        this.onNotification("agent_message_delta", { threadId: id, delta: p.delta });
      }
    } else if (event.type === "session.next.text.delta" && p.delta) {
      this.onNotification("agent_message_delta", { threadId: id, delta: p.delta });
    } else if (["message.updated", "message.part.removed", "message.removed"].includes(event.type)) {
      this.#scheduleSync(id);
    } else if (event.type === "session.error") {
      this.#failed.set(id, cleanError(p.error));
    } else if (["permission.asked", "permission.v2.asked"].includes(event.type)) {
      const requestId = p.id;
      const action = p.permission || p.action || "tool";
      this.#pending.set(requestId, { type: "permission", sessionId: id, directory });
      const meta = p.metadata || {};
      const input = meta.input && typeof meta.input === "object" ? meta.input : {};
      const isEdit = /edit|write|patch|multiedit/i.test(action);
      this.onServerRequest(requestId, isEdit ? "applyPatchApproval" : "execCommandApproval", {
        threadId: id,
        toolName: action,
        cwd: directory,
        command: p.patterns?.join(" ") || p.resources?.join(" ") || meta.command || input.command || action,
        reason: meta.description || meta.title || null,
        ...(isEdit && (input.file_path || input.path) ? {
          fileChanges: { [input.file_path || input.path]: { type: "update", unified_diff: meta.diff || "" } },
        } : {}),
      });
    } else if (["permission.replied", "permission.v2.replied"].includes(event.type)) {
      if (p.requestID || p.id) this.#resolvePending(p.requestID || p.id);
    } else if (["question.asked", "question.v2.asked"].includes(event.type)) {
      const request = { ...p, directory };
      const callId = request.tool?.callID || request.id;
      this.#pending.set(request.id, { type: "question", request, sessionId: id, directory });
      if (callId !== request.id) this.#pending.set(callId, { type: "question", request, sessionId: id, directory });
      this.#pendingQuestions.set(request.id, request);
      await this.#sync(id).catch((err) => this.#log(`OpenCode 问答同步失败: ${err.message}`));
    } else if (["question.replied", "question.v2.replied", "question.rejected", "question.v2.rejected"].includes(event.type)) {
      this.#resolveQuestion(p.requestID || p.id, id);
      this.#scheduleSync(id, 0);
    } else if (event.type === "session.idle" || (event.type === "session.status" && p.status?.type === "idle")) {
      const turnId = this.#turns.get(id);
      if (!turnId) return;
      this.#turns.delete(id);
      await this.#sync(id).catch((err) => this.#log(`OpenCode 会话同步失败: ${err.message}`));
      const failure = this.#failed.get(id);
      this.#failed.delete(id);
      this.onNotification(failure ? "turn/failed" : "turn/completed", {
        threadId: id,
        turnId,
        ...(failure ? { error: failure } : {}),
      });
    } else if (event.type === "session.updated" && p.info) {
      this.#sessions.set(id, p.info);
      this.invalidateProjects();
    }
  }

  #resolvePending(requestId) {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    for (const [key, value] of this.#pending) {
      if (value === pending) this.#pending.delete(key);
    }
    if (pending.type === "permission") this.onServerRequestCancel(requestId);
  }

  #resolveQuestion(requestId, sessionId) {
    const pending = this.#pending.get(requestId);
    const request = pending?.request || this.#pendingQuestions.get(requestId);
    if (pending) for (const [key, value] of this.#pending) if (value === pending) this.#pending.delete(key);
    if (request) this.#pendingQuestions.delete(request.id);
    if (sessionId) this.#scheduleSync(sessionId, 0);
  }

  #scheduleSync(id, wait = 60) {
    clearTimeout(this.#syncTimers.get(id));
    const timer = setTimeout(() => {
      this.#syncTimers.delete(id);
      this.#sync(id).catch((err) => this.#log(`OpenCode 会话同步失败: ${err.message}`));
    }, wait);
    timer.unref?.();
    this.#syncTimers.set(id, timer);
  }

  #path(id) { return join(this.#base, `${id}.jsonl`); }

  async #sync(id) {
    const s = await this.#loadSession(id);
    const rows = await this.#api(`/session/${id}/message`, { directory: s.directory });
    const entries = (rows || []).map(openCodeMessageToTranscript);
    const callIds = new Set((rows || []).flatMap((row) => (row.parts || []).map((part) => part.callID || part.id)));
    for (const request of this.#pendingQuestions.values()) {
      if (request.sessionID === id && !callIds.has(request.tool?.callID || request.id)) entries.push(questionEntry(request));
    }
    const path = this.#path(id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${entries.map(JSON.stringify).join("\n")}${entries.length ? "\n" : ""}`);
    renameSync(temp, path);
  }

  #map(s) {
    return {
      id: s.id,
      name: s.title || s.slug || "OpenCode 会话",
      preview: "",
      cwd: s.directory || "",
      updatedAt: Math.floor((s.time?.updated || s.time?.created || 0) / 1000),
      source: "opencode",
      status: this.#turns.has(s.id) ? "running" : "idle",
      archived: Boolean(s.time?.archived),
      path: this.#path(s.id),
    };
  }

  async #globalSessions({ limit = 5000, archived } = {}) {
    const list = await this.#api("/experimental/session", { query: { roots: true, limit, archived } });
    for (const s of list || []) this.#sessions.set(s.id, s);
    return list || [];
  }

  async #loadSession(id) {
    if (this.#sessions.has(id)) return this.#sessions.get(id);
    const found = (await this.#globalSessions({ limit: 5000, archived: true })).find((s) => s.id === id);
    if (!found) throw new Error("OpenCode 会话不存在");
    return found;
  }

  async listThreads(limit = 1000) {
    return (await this.#globalSessions({ limit: Math.max(limit, 1000) }))
      .filter((s) => !s.time?.archived).map((s) => this.#map(s)).slice(0, limit);
  }

  async listThreadsPage({ cursor = null, limit = 2000, cwd = null } = {}) {
    if (cwd) return this.#projects.page(cwd, { cursor, limit });
    const at = Math.max(0, Number(cursor) || 0);
    const rows = await this.#api("/experimental/session", { query: { roots: true, start: at, limit } });
    for (const s of rows || []) this.#sessions.set(s.id, s);
    const items = (rows || []).filter((s) => !s.time?.archived).map((s) => this.#map(s));
    return { items, nextCursor: items.length >= limit ? String(at + items.length) : null };
  }

  aggregateProjects({ fresh = false } = {}) { return this.#projects.get({ fresh }); }
  invalidateProjects() { this.#projects.invalidate(); }

  async readThread(id) {
    const s = await this.#loadSession(id);
    await this.#sync(id);
    return this.#map(s);
  }

  async startThread({ cwd } = {}) {
    const s = await this.#api("/session", { method: "POST", directory: cwd, body: {} });
    this.#sessions.set(s.id, s);
    await this.#sync(s.id);
    return { threadId: s.id, thread: s };
  }

  async forkThread(id) {
    const s = await this.#loadSession(id);
    const forked = await this.#api(`/session/${id}/fork`, { method: "POST", directory: s.directory, body: {} });
    this.#sessions.set(forked.id, forked);
    await this.#sync(forked.id);
    return { threadId: forked.id, thread: forked, cwd: forked.directory };
  }

  resumeThread() { return { ok: true }; }

  async #applyPermissionPreset(session, preset) {
    const rules = preset === "default" ? this.#defaultPermissions : openCodePermissionRules(preset);
    if (!rules) return;
    const updated = await this.#api(`/session/${session.id}`, {
      method: "PATCH", directory: session.directory, body: { permission: rules },
    });
    if (updated?.id) this.#sessions.set(updated.id, updated);
  }

  async startTurn(id, input, overrides = {}) {
    if (this.#turns.has(id)) throw new Error("该会话已有进行中的任务");
    const s = await this.#loadSession(id);
    await this.#applyPermissionPreset(s, overrides.permissionPreset);
    const parts = [];
    for (const item of input || []) {
      if (item.type === "text" && item.text) parts.push({ type: "text", text: item.text });
      else if (item.type === "image" && item.url) parts.push({
        type: "file",
        mime: item.url.match(/^data:([^;]+)/)?.[1] || "image/png",
        filename: "image",
        url: item.url,
      });
    }
    const body = {
      parts,
      agent: overrides.collaborationMode?.mode === "plan" ? "plan" : "build",
    };
    const model = parseOpenCodeModelRef(overrides.model);
    if (model) body.model = model;
    if (overrides.effort) body.variant = overrides.effort;
    const turnId = randomUUID();
    this.#ignoreBusyUntil.delete(id);
    this.#turns.set(id, turnId);
    // prompt_async 可能在 HTTP 应答返回前完成；先发布 started，SessionHub 的终态序号
    // 会确保快速 completed/failed 不会被迟到的 startTurn 返回值重新写成运行中。
    this.onNotification("turn/started", { threadId: id, turnId });
    try {
      await this.#api(`/session/${id}/prompt_async`, { method: "POST", directory: s.directory, body });
    } catch (err) {
      if (this.#turns.get(id) === turnId) {
        this.#turns.delete(id);
        this.onNotification("turn/failed", { threadId: id, turnId, error: cleanError(err) });
      }
      throw err;
    }
    return { turnId };
  }

  async interruptTurn(id) {
    const s = await this.#loadSession(id);
    const turnId = this.#turns.get(id);
    // OpenCode 在 abort 应答后偶尔还会补发一条迟到的 busy/retry；短时间抑制它，
    // 否则手机端刚显示“已停止”又会被重新点亮成“回复中”。下一次正常发送会主动清除。
    this.#ignoreBusyUntil.set(id, Date.now() + 5000);
    await this.#api(`/session/${id}/abort`, { method: "POST", directory: s.directory, body: {} });
    if (turnId) {
      this.#turns.delete(id);
      this.onNotification("turn/aborted", { threadId: id, turnId });
    }
    return { ok: true };
  }

  async archiveThread(id) {
    const s = await this.#loadSession(id);
    const updated = await this.#api(`/session/${id}`, { method: "PATCH", directory: s.directory, body: { time: { archived: Date.now() } } });
    if (updated?.id) this.#sessions.set(updated.id, updated);
    this.invalidateProjects();
    this.onNotification("thread/archived", { threadId: id });
    return { ok: true };
  }

  async unarchiveThread(id) {
    const s = await this.#loadSession(id);
    const updated = await this.#api(`/session/${id}`, { method: "PATCH", directory: s.directory, body: { time: { archived: 0 } } });
    if (updated?.id) this.#sessions.set(updated.id, updated);
    this.invalidateProjects();
    this.onNotification("thread/unarchived", { threadId: id });
    return { ok: true };
  }

  async request(method) {
    if (method !== "model/list") return {};
    const now = Date.now();
    if (this.#modelCache && now - this.#modelCache.at < MODEL_LIST_CACHE_MS) {
      return { data: this.#modelCache.data };
    }

    // 同一时刻多个手机/RTC 热切换可能一起预取模型；合并成一次本机请求。
    const load = this.#modelLoad ??= (async () => {
      // /provider 是 OpenCode 的完整 models.dev 目录，本机实测可达数 MB，首次读取
      // 需要数秒。显式配置过 provider.models 时，/config 已包含手机选择器需要的
      // 名称、variants 与默认模型，直接从这个小响应构建，不再下载完整公共目录。
      const config = await this.#api("/config").catch(() => ({}));
      let data = buildOpenCodeConfiguredModelCatalog(config);
      if (!data.length) {
        const providers = await this.#api("/provider");
        data = buildOpenCodeModelCatalog(providers, config);
      }
      this.#modelCache = { at: Date.now(), data };
      return data;
    })();
    try {
      return { data: await load };
    } finally {
      if (this.#modelLoad === load) this.#modelLoad = null;
    }
  }

  async answerQuestion(id, requestId, answers) {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.type !== "question" || pending.sessionId !== id) throw new Error("该问答已不再等待回答");
    const questions = pending.request?.questions || [];
    const values = questions.map((question) => {
      const value = String(answers?.[question.question] || "").trim();
      return question.multiple ? value.split(/,\s*/).filter(Boolean) : [value];
    });
    if (values.some((value) => value.length === 0 || !value[0])) throw new Error("请回答全部问题");
    await this.#api(`/question/${pending.request.id}/reply`, { method: "POST", directory: pending.directory, body: { answers: values } });
    this.#resolveQuestion(pending.request.id, id);
    await this.#sync(id);
    return { ok: true };
  }

  respond(requestId, result) {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.type !== "permission") return;
    this.#pending.delete(requestId);
    const reply = result?.decision === "acceptForSession" ? "always" : result?.decision === "accept" ? "once" : "reject";
    this.#api(`/permission/${requestId}/reply`, { method: "POST", directory: pending.directory, body: { reply } })
      .catch((err) => this.#log(`OpenCode 审批回复失败: ${err.message}`));
  }

  respondError(requestId) { this.respond(requestId, { decision: "decline" }); }
}

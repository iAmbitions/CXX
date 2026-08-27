import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const webSource = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

function projectLoaderSource() {
  const start = webSource.indexOf("async function ensureProjectLoaded(");
  const end = webSource.indexOf("// 时间线模式翻页", start);
  assert.ok(start >= 0 && end > start, "project loader source should be present");
  return webSource.slice(start, end);
}

test("项目展开只请求一页并保留下一页游标", async () => {
  const calls = [];
  const app = {
    projSessions: new Map(),
    view: "list",
    listGen: 0,
    session: {
      request: async (method, params) => {
        calls.push({ method, params });
        return {
          sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, updatedAt: i })),
          nextCursor: "page-2",
        };
      },
    },
  };
  const sandbox = {
    app,
    renderList() {},
    ingestSessions() {},
    t: (key) => key,
  };
  vm.runInNewContext(`${projectLoaderSource()}\nglobalThis.loader = ensureProjectLoaded;`, sandbox);

  await sandbox.loader("/Users/fou/dev/openrouter", "/Users/fou/dev/openrouter");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sessions.list");
  assert.equal(calls[0].params.cwd, "/Users/fou/dev/openrouter");
  assert.equal(calls[0].params.cursor, null);
  assert.equal(calls[0].params.limit, 100);
  const cache = app.projSessions.get("/Users/fou/dev/openrouter");
  assert.equal(cache.sessions.length, 100);
  assert.equal(cache.nextCursor, "page-2");
  assert.equal(cache.done, false);
  assert.equal(cache.loading, false);
});

test("首页不再后台预取全部项目会话", () => {
  assert.doesNotMatch(webSource, /prefetchAllProjects|prefetching|prefetchAt/);
});

test("普通 RPC 保持 30 秒，列表族请求单独放宽到 90 秒", () => {
  assert.match(webSource, /const REQUEST_TIMEOUT_MS = 30000;/);
  assert.match(webSource, /const LIST_REQUEST_TIMEOUT_MS = 90000;/);
  assert.equal((webSource.match(/timeoutMs = REQUEST_TIMEOUT_MS/g) || []).length, 3);
  assert.match(webSource, /method === "sessions\.list" \|\| method === "projects\.list"/);
  assert.doesNotMatch(webSource, /timeoutMs = 15000/);
});


test("项目强制刷新会丢弃旧页并从第一页重新获取", async () => {
  const calls = [];
  const app = {
    projSessions: new Map([["/repo/demo", {
      sessions: [{ id: "stale", updatedAt: 1 }],
      nextCursor: "old-page-2",
      done: true,
      loading: false,
      error: null,
    }]]),
    view: "list",
    listGen: 0,
    session: {
      request: async (method, params) => {
        calls.push({ method, params });
        return { sessions: [{ id: "fresh", updatedAt: 2 }], nextCursor: null };
      },
    },
  };
  const sandbox = { app, renderList() {}, ingestSessions() {}, t: (key) => key };
  vm.runInNewContext(`${projectLoaderSource()}\nglobalThis.loader = ensureProjectLoaded;`, sandbox);

  await sandbox.loader("/repo/demo", "/repo/demo", { refresh: true });

  assert.equal(calls[0].params.cursor, null);
  assert.equal(app.projSessions.get("/repo/demo").sessions.map((s) => s.id).join(","), "fresh");
});

test("返回列表会请求 fresh 项目索引并刷新已展开项目", () => {
  assert.match(webSource, /await refreshList\(\{ fresh: true \}\)/);
  assert.match(webSource, /request\("projects\.list", fresh \? \{ fresh: true \} : \{\}\)/);
  assert.match(webSource, /ensureProjectLoaded\(norm, p\.cwd, \{ refresh: true \}\)/);
});

test("项目加载失败会显示可点击重试，不再静默空白", () => {
  assert.match(webSource, /list\.loadretry/);
  assert.match(webSource, /cache\?\.error/);
  assert.match(webSource, /loadRetryRow/);
});

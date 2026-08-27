import assert from "node:assert/strict";
import test from "node:test";

import { CachedProjects, groupProjects } from "../daemon/src/project-index.mjs";

test("项目索引同时保留可分页的会话快照，并排除已归档会话", () => {
  const grouped = groupProjects([
    { id: "new", cwd: "/repo/demo/", updatedAt: 30, name: "new" },
    { id: "old", cwd: "/repo/demo", updatedAt: 10, name: "old" },
    { id: "archived", cwd: "/repo/demo", updatedAt: 40, archived: true },
    { id: "other", cwd: "/repo/other", updatedAt: 20 },
  ]);

  assert.equal(grouped.projects.length, 2);
  assert.equal(grouped.projects.find((p) => p.norm === "/repo/demo").count, 2);
  assert.deepEqual(grouped.sessionsByCwd.get("/repo/demo").map((s) => s.id), ["new", "old"]);
  assert.equal(grouped.idToCwd.has("archived"), false);
});

test("项目展开从最近一次项目索引分页，不因 TTL 到期重新扫描", async () => {
  let scans = 0;
  let threads = Array.from({ length: 3 }, (_, i) => ({
    id: `s${i}`,
    cwd: "/repo/demo",
    updatedAt: 30 - i,
  }));
  const cache = new CachedProjects(async () => {
    scans++;
    return threads;
  }, { ttlMs: 0 });

  await cache.get();
  const first = await cache.page("/repo/demo/", { limit: 2 });
  assert.equal(scans, 1);
  assert.deepEqual(first.items.map((s) => s.id), ["s0", "s1"]);
  assert.equal(first.nextCursor, "2");

  const second = await cache.page("/repo/demo", { cursor: first.nextCursor, limit: 2 });
  assert.equal(scans, 1, "project click should reuse the list snapshot instead of rescanning");
  assert.deepEqual(second.items.map((s) => s.id), ["s2"]);
  assert.equal(second.nextCursor, null);

  threads = [{ id: "fresh", cwd: "/repo/demo", updatedAt: 99 }];
  await cache.get({ fresh: true });
  const refreshed = await cache.page("/repo/demo", { limit: 100 });
  assert.equal(scans, 2);
  assert.deepEqual(refreshed.items.map((s) => s.id), ["fresh"]);
});

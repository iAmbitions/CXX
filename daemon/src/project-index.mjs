// 会话按项目（cwd）聚合——codex / claude / opencode 三个后端共用。
//
// normSep 必须与 web/index.html 里的同名函数逐字一致：daemon 用它建 idToCwd/分组键，
// web 用它建 projByCwd 并按 cwd 匹配看板增量。两边分歧会把同一项目拆成两组或错配徽标。
export function normSep(cwd) {
  return (cwd || "").trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

// threads（backend.listThreads 产物：含 id/cwd/updatedAt/name/preview）→ 按 cwd 分组。
// 返回紧凑项目摘要，同时保留 daemon 内部的 sessionsByCwd，供手机展开项目时直接分页；
// 这样展开与 projects.list 使用同一份快照，不再额外请求引擎并等待一次全量扫描。
export function groupProjects(threads, { cap = 800, previewMax = 80 } = {}) {
  const byCwd = new Map(); // normCwd -> entry
  const idToCwd = new Map(); // threadId -> normCwd
  const sessionsByCwd = new Map(); // normCwd -> newest-first thread[]（仅 daemon 内部使用）
  for (const t of threads) {
    if (!t?.id || t.archived) continue;
    const norm = normSep(t.cwd);
    idToCwd.set(t.id, norm);
    let bucket = sessionsByCwd.get(norm);
    if (!bucket) {
      bucket = [];
      sessionsByCwd.set(norm, bucket);
    }
    bucket.push(t);
    let e = byCwd.get(norm);
    if (!e) {
      e = { norm, cwd: t.cwd || "", count: 0, latestUpdatedAt: 0, latestName: null, latestPreview: "" };
      byCwd.set(norm, e);
    }
    e.count++;
    if ((t.updatedAt || 0) >= e.latestUpdatedAt) {
      e.latestUpdatedAt = t.updatedAt || 0;
      e.latestName = t.name ?? null;
      e.latestPreview = t.preview ? String(t.preview).slice(0, previewMax) : "";
      e.cwd = t.cwd || e.cwd; // 展示用最近会话的原始 cwd
    }
  }
  for (const sessions of sessionsByCwd.values()) {
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  const all = [...byCwd.values()].sort((a, b) => (b.latestUpdatedAt || 0) - (a.latestUpdatedAt || 0));
  return { projects: all.slice(0, cap), idToCwd, hasMore: all.length > cap, sessionsByCwd };
}

// TTL + 单飞缓存：包住「一次全量本地扫描 + 分组」。scan() 返回 threads 数组。
// 首页 projects.list 命中缓存即 0 扫描；新建会话可 invalidate 立即重建。运行/审批徽标
// 不进缓存（每次实时从 hub 叠加），故看板变化无需失效——只有会话集合变了才需要。
export class CachedProjects {
  #scan;
  #ttl;
  #builtAt = 0;
  #value = null;
  #building = null;
  constructor(scan, { ttlMs = 10000 } = {}) {
    this.#scan = scan;
    this.#ttl = ttlMs;
  }
  invalidate() {
    this.#builtAt = 0;
  }
  async get({ fresh = false } = {}) {
    if (fresh) this.invalidate();
    const now = Date.now();
    if (this.#value && now - this.#builtAt < this.#ttl) return this.#value;
    if (this.#building) return this.#building; // 单飞：并发请求共享同一次扫描，不重复拉全量
    this.#building = (async () => {
      try {
        const threads = await this.#scan();
        this.#value = groupProjects(threads);
        this.#builtAt = Date.now();
        return this.#value;
      } finally {
        this.#building = null;
      }
    })();
    return this.#building;
  }

  // 项目展开沿用最近一次 projects.list 的同一份会话快照。即使 TTL 刚过也不在点击时
  // 重新做全量扫描；列表页的显式刷新会先 fresh 重建缓存，再让已展开项目重新取第一页。
  async page(cwd, { cursor = null, limit = 100 } = {}) {
    const value = this.#value ?? await this.get();
    const all = value.sessionsByCwd.get(normSep(cwd)) ?? [];
    const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
    const target = Math.max(1, Math.min(2000, limit | 0));
    const items = all.slice(offset, offset + target);
    const nextOffset = offset + items.length;
    return { items, nextCursor: nextOffset < all.length ? String(nextOffset) : null };
  }
}

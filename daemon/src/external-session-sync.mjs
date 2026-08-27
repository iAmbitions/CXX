// Detect conversations started or continued outside Pocket Agent itself (the Codex
// desktop app / CLI and Claude Code terminal). Those tools write their own session
// stores and do not notify this daemon, so a connected phone needs a small local
// reconciliation loop to learn that its home board changed.
//
// The loop is intentionally dormant unless a full-control phone is connected. It
// only polls a compact recent page and sends metadata-only `board.changed` refresh
// hints—no prompt, rollout content, token, or local path is sent in the push.

export function sessionRevision(items = []) {
  return items
    .filter((item) => item?.id)
    .map((item) => `${item.id}\u0000${Number(item.updatedAt) || 0}\u0000${item.archived ? 1 : 0}`)
    .sort()
    .join("\u0001");
}

export class ExternalSessionSync {
  #backends;
  #hubs;
  #log;
  #intervalMs;
  #recentLimit;
  #timer = null;
  #running = false;
  #revisions = new Map();

  constructor({ backends, hubs, log = () => {}, intervalMs = 60_000, recentLimit = 100 } = {}) {
    this.#backends = backends ?? {};
    this.#hubs = hubs ?? {};
    this.#log = log;
    this.#intervalMs = Math.max(1_000, intervalMs);
    this.#recentLimit = Math.max(1, Math.min(200, recentLimit));
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#revisions.clear();
  }

  async tick() {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const [agent, backend] of Object.entries(this.#backends)) {
        const hub = this.#hubs[agent];
        // View-only share links must never receive a list-wide refresh signal. With no
        // regular phone online there is no user-visible benefit to scanning local history.
        if (!backend?.listThreadsPage || !hub?.hasBoardClients?.()) {
          this.#revisions.delete(agent);
          continue;
        }
        try {
          const page = await backend.listThreadsPage({ limit: this.#recentLimit });
          const revision = sessionRevision(page?.items);
          const previous = this.#revisions.get(agent);
          this.#revisions.set(agent, revision);
          // First observation after a phone connects is also a refresh: it recovers from
          // a stale PWA snapshot or an initial request that happened while the app-server
          // was still warming up. 默认 60 秒核对一次，避免大型 Codex 会话库被持续扫描。
          if (previous !== revision) {
            backend.invalidateProjects?.();
            hub.broadcastBoardRefresh?.();
            this.#log(`外部会话同步: agent=${agent} recent=${page?.items?.length ?? 0}`);
          }
        } catch (err) {
          // A transient Codex/Claude read failure must not impact the daemon or a running
          // turn. Keep the old revision so the next successful read still triggers a refresh.
          this.#log(`外部会话同步失败: agent=${agent} ${err?.message ?? String(err)}`);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}

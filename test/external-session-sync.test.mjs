import assert from "node:assert/strict";
import test from "node:test";

import { ExternalSessionSync, sessionRevision } from "../daemon/src/external-session-sync.mjs";

test("sessionRevision is order-independent and changes when a recent session changes", () => {
  const a = sessionRevision([{ id: "b", updatedAt: 2 }, { id: "a", updatedAt: 1 }]);
  const b = sessionRevision([{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 2 }]);
  const c = sessionRevision([{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 3 }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("external session sync refreshes connected phones only when the recent revision changes", async () => {
  let revision = [{ id: "s1", updatedAt: 1 }];
  let invalidations = 0;
  let refreshes = 0;
  const sync = new ExternalSessionSync({
    intervalMs: 60_000,
    backends: {
      codex: {
        async listThreadsPage() { return { items: revision }; },
        invalidateProjects() { invalidations++; },
      },
    },
    hubs: {
      codex: {
        hasBoardClients: () => true,
        broadcastBoardRefresh: () => { refreshes++; },
      },
    },
  });

  await sync.tick(); // first observation repairs stale client snapshots
  await sync.tick(); // unchanged: no duplicate refresh
  revision = [{ id: "s1", updatedAt: 2 }, { id: "s2", updatedAt: 2 }];
  await sync.tick();
  sync.stop();

  assert.equal(invalidations, 2);
  assert.equal(refreshes, 2);
});

test("external session sync does not scan while only viewers or no clients are connected", async () => {
  let reads = 0;
  const sync = new ExternalSessionSync({
    backends: { claude: { async listThreadsPage() { reads++; return { items: [] }; } } },
    hubs: { claude: { hasBoardClients: () => false, broadcastBoardRefresh() {} } },
  });
  await sync.tick();
  sync.stop();
  assert.equal(reads, 0);
});

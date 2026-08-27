// Public Pocket Agent Remote relay entrypoint.
// Keep this file zero-knowledge and self-host friendly: no official route, stats,
// Analytics Engine, Telegram, or private tokens. Official-only behavior lives under
// internal/relay-worker and imports the shared relay core from this package.

import { BaseRelayRoom, createRelayWorker } from "./relay-core.mjs";

export default createRelayWorker({ serviceLabel: "Pocket Agent relay" });

export class RelayRoom extends BaseRelayRoom {}

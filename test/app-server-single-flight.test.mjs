import assert from "node:assert/strict";
import test from "node:test";

import { appServerSpawnOptions, singleFlight } from "../daemon/src/app-server.mjs";

test("app-server receives the captured shell environment", () => {
  const env = { PATH: "/usr/bin", OPENAI_API_KEY: "secret" };
  const options = appServerSpawnOptions(env);
  assert.equal(options.env, env);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);

  assert.equal("env" in appServerSpawnOptions(), false, "default spawn should retain normal inheritance");
});

test("singleFlight coalesces identical concurrent work and clears after success", async () => {
  const inFlight = new Map();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = async () => { calls++; await gate; return "ok"; };

  const first = singleFlight(inFlight, "thread/list:first", task);
  const second = singleFlight(inFlight, "thread/list:first", task);
  assert.equal(first, second);
  assert.equal(calls, 0, "task begins on the next microtask");
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await second, "ok");
  await Promise.resolve();
  assert.equal(inFlight.size, 0);

  assert.equal(await singleFlight(inFlight, "thread/list:first", task), "ok");
  assert.equal(calls, 2, "completed work must not remain cached forever");
});

test("singleFlight clears a rejected request so a retry can run", async () => {
  const inFlight = new Map();
  let calls = 0;
  const fail = () => { calls++; throw new Error("temporary failure"); };

  await assert.rejects(singleFlight(inFlight, "thread/list:first", fail), /temporary failure/);
  await Promise.resolve();
  assert.equal(inFlight.size, 0);
  await assert.rejects(singleFlight(inFlight, "thread/list:first", fail), /temporary failure/);
  assert.equal(calls, 2);
});

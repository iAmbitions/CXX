import assert from "node:assert/strict";
import test from "node:test";

import {
  createJingmeNotifier,
  isJingmeNotifier,
  normalizeJingmeConfig,
  Notifier,
} from "../daemon/src/notify.mjs";

const jingme = {
  appKey: "test-app",
  appSecret: "test-secret",
  openTeamId: "team-1",
  robotId: "robot-1",
  tenantId: "CN.JD.GROUP",
  baseUrl: "http://openme.test",
};

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test("京Me接收人仅接受合法 ERP", () => {
  assert.deepEqual(createJingmeNotifier("tanchuxiong.1"), { type: "jingme", erp: "tanchuxiong.1" });
  assert.equal(createJingmeNotifier(""), null);
  assert.equal(createJingmeNotifier("bad ERP"), null);
  assert.equal(isJingmeNotifier({ type: "jingme", erp: "a.b" }), true);
  assert.equal(isJingmeNotifier({ type: "bark", key: "x" }), false);
});

test("京Me配置缺失任一敏感字段时不启用", () => {
  assert.equal(normalizeJingmeConfig({ appKey: "a" }), null);
  assert.equal(normalizeJingmeConfig({ ...jingme, baseUrl: "ftp://openme.test" }), null);
  assert.equal(normalizeJingmeConfig(jingme).robotId, "robot-1");
});

test("京Me通知依次换取应用和团队令牌，再将摘要发给 ERP", async () => {
  const calls = [];
  const notifier = new Notifier([{ type: "jingme", erp: "tanchuxiong.1" }], {
    jingme,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/app_access_token")) return response({ code: 0, data: { appAccessToken: "app-token" } });
      if (url.endsWith("/team_access_token")) return response({ code: 0, data: { teamAccessToken: "team-token" } });
      return response({ code: 0, data: {} });
    },
  });

  assert.equal(await notifier.send("任务完成", "会话已完成", "https://example.test/CXX/#s=abc"), true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://openme.test/open-api/auth/v1/app_access_token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { appKey: "test-app", appSecret: "test-secret" });
  assert.equal(calls[1].url, "http://openme.test/open-api/auth/v1/team_access_token");
  assert.deepEqual(JSON.parse(calls[1].init.body), { appAccessToken: "app-token", openTeamId: "team-1" });
  assert.equal(calls[2].url, "http://openme.test/open-api/suite/v1/timline/sendRobotMsg");
  assert.equal(calls[2].init.headers.authorization, "Bearer team-token");
  const payload = JSON.parse(calls[2].init.body);
  assert.equal(payload.erp, "tanchuxiong.1");
  assert.equal(payload.appId, "test-app");
  assert.equal(payload.params.robotId, "robot-1");
  assert.equal(payload.params.body.type, "text");
  assert.equal(payload.params.body.content, "任务完成\n会话已完成\nhttps://example.test/CXX/#s=abc");
});

test("历史渠道被禁用，不会被作为通知发送", async () => {
  const notifier = new Notifier([{ type: "bark", key: "old" }], {
    jingme,
    fetch: async () => { throw new Error("不应请求网络"); },
  });
  assert.equal(notifier.count, 0);
  assert.equal(await notifier.send("标题", "正文"), true);
});

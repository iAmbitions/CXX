import assert from "node:assert/strict";
import test from "node:test";

import { Notifier } from "../daemon/src/notify.mjs";

const jingme = {
  appKey: "test-app", appSecret: "test-secret", openTeamId: "team-1", robotId: "robot-1", baseUrl: "http://openme.test",
};

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test("京Me令牌请求失败会记录脱敏错误并返回 false", async () => {
  const logs = [];
  const notifier = new Notifier([{ type: "jingme", erp: "tester" }], {
    jingme,
    fetch: async () => response({ code: 401, msg: "not authorized" }),
    log: (message) => logs.push(message),
  });
  assert.equal(await notifier.send("标题", "正文"), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /获取京Me应用令牌.*失败/);
  assert.doesNotMatch(logs[0], /test-secret/);
});

test("京Me单个接收人发送失败会返回 false 并标明 ERP", async () => {
  const logs = [];
  let step = 0;
  const notifier = new Notifier([{ type: "jingme", erp: "tester" }], {
    jingme,
    fetch: async () => {
      step += 1;
      if (step === 1) return response({ code: 0, data: { appAccessToken: "app-token" } });
      if (step === 2) return response({ code: 0, data: { teamAccessToken: "team-token" } });
      return response({ code: 500, msg: "denied" });
    },
    log: (message) => logs.push(message),
  });
  assert.equal(await notifier.send("标题", "正文"), false);
  assert.match(logs[0], /京Me:tester/);
  assert.match(logs[0], /发送京Me消息给 tester 失败/);
});

test("未配置京Me机器人凭据时不会请求网络", async () => {
  const logs = [];
  const notifier = new Notifier([{ type: "jingme", erp: "tester" }], {
    fetch: async () => { throw new Error("不应请求网络"); },
    log: (message) => logs.push(message),
  });
  assert.equal(await notifier.send("标题", "正文"), false);
  assert.match(logs[0], /未配置机器人凭据/);
});

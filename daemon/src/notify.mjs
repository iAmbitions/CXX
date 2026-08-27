// 京Me 机器人通知：任务完成 / 需要审批时主动推到京Me。
//
// 机器人凭据只从本机 ~/.cxx/remote/daemon.json 的 jingme 字段读取，绝不写入
// 源码、Git 仓库或日志。通知正文仍只包含摘要和可选手机端深链，绝不含代码/命令/文件路径。
const TIMEOUT_MS = 8000;
const DEFAULT_JINGME_BASE_URL = "http://openme.jd.local";
const DEFAULT_JINGME_TENANT_ID = "CN.JD.GROUP";

function trimmed(value, max = 256) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// ERP 仅作为京Me 接收人标识；限制为常见 ERP 字符，避免把任意内容拼入请求或配置。
export function createJingmeNotifier(erp) {
  const value = trimmed(erp, 64);
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(value)) return null;
  return { type: "jingme", erp: value };
}

export function isJingmeNotifier(value) {
  return createJingmeNotifier(value?.erp)?.erp != null && value?.type === "jingme";
}

export function normalizeNotifier(value) {
  if (value?.type !== "jingme") return value;
  return createJingmeNotifier(value.erp) ?? { type: "jingme", erp: "" };
}

// `jingme` 是机器私有配置（0600 的 daemon.json），形如：
// { appKey, appSecret, openTeamId, robotId, tenantId?, baseUrl? }
// 缺凭据时返回 null，调用方只会记录脱敏错误，不会向网络发送半成品请求。
export function normalizeJingmeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const appKey = trimmed(value.appKey, 128);
  const appSecret = trimmed(value.appSecret, 256);
  const openTeamId = trimmed(value.openTeamId, 128);
  const robotId = trimmed(value.robotId, 128);
  const tenantId = trimmed(value.tenantId || DEFAULT_JINGME_TENANT_ID, 128);
  const baseUrl = trimmed(value.baseUrl || DEFAULT_JINGME_BASE_URL, 512).replace(/\/+$/, "");
  if (!appKey || !appSecret || !openTeamId || !robotId || !tenantId) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { appKey, appSecret, openTeamId, robotId, tenantId, baseUrl };
}

function withLink(title, body, link) {
  return link ? `${title}\n${body}\n${link}` : `${title}\n${body}`;
}

function randomRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
}

function json(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function readJingmeData(fetchImpl, url, init, stage) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${stage} 请求异常：${err?.message ?? String(err)}`);
  }
  if (!response?.ok) throw new Error(`${stage} HTTP ${response?.status ?? "?"}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${stage} 响应不是有效 JSON`);
  }
  if (payload?.code !== 0) throw new Error(`${stage} 失败：${payload?.msg || `code ${payload?.code ?? "?"}`}`);
  return payload?.data ?? {};
}

async function getJingmeTeamToken(fetchImpl, settings) {
  const app = await readJingmeData(
    fetchImpl,
    `${settings.baseUrl}/open-api/auth/v1/app_access_token`,
    json({ appKey: settings.appKey, appSecret: settings.appSecret }),
    "获取京Me应用令牌",
  );
  const appAccessToken = trimmed(app.appAccessToken, 4096);
  if (!appAccessToken) throw new Error("获取京Me应用令牌失败：响应缺少 appAccessToken");
  const team = await readJingmeData(
    fetchImpl,
    `${settings.baseUrl}/open-api/auth/v1/team_access_token`,
    json({ appAccessToken, openTeamId: settings.openTeamId }),
    "获取京Me团队令牌",
  );
  const teamAccessToken = trimmed(team.teamAccessToken, 4096);
  if (!teamAccessToken) throw new Error("获取京Me团队令牌失败：响应缺少 teamAccessToken");
  return teamAccessToken;
}

async function sendJingmeMessage(fetchImpl, settings, teamAccessToken, erp, content) {
  return readJingmeData(
    fetchImpl,
    `${settings.baseUrl}/open-api/suite/v1/timline/sendRobotMsg`,
    json(
      {
        appId: settings.appKey,
        erp,
        tenantId: settings.tenantId,
        requestId: randomRequestId(),
        dateTime: Date.now(),
        params: {
          robotId: settings.robotId,
          body: { type: "text", content },
        },
      },
      { authorization: `Bearer ${teamAccessToken}` },
    ),
    `发送京Me消息给 ${erp}`,
  );
}

// 脱敏展示：ERP 不是密钥，可帮助用户识别当前接收人；机器人凭据永不展示。
export function redact(value) {
  const notifier = normalizeNotifier(value);
  if (notifier?.type === "jingme") return `京Me:${notifier.erp || "未填写 ERP"}`;
  return notifier?.type || "未知";
}

export class Notifier {
  #notifiers;
  #fetch;
  #log;
  #jingme;

  constructor(notifiers = [], { fetch = globalThis.fetch, log = () => {}, jingme = null } = {}) {
    // 产品已收敛为京Me机器人；历史 Bark/Server酱/Webhook/OneBot 条目一律不再发送。
    this.#notifiers = (Array.isArray(notifiers) ? notifiers : [])
      .map(normalizeNotifier)
      .filter(isJingmeNotifier);
    this.#fetch = fetch;
    this.#log = log;
    this.#jingme = normalizeJingmeConfig(jingme);
  }

  get count() {
    return this.#notifiers.length;
  }

  async send(title, body, link) {
    if (this.#notifiers.length === 0) return true;
    if (!this.#jingme) {
      this.#log("通知发送失败 京Me: 本机未配置机器人凭据");
      return false;
    }
    let teamAccessToken;
    try {
      teamAccessToken = await getJingmeTeamToken(this.#fetch, this.#jingme);
    } catch (err) {
      this.#log(`通知发送失败 京Me: ${err.message}`);
      return false;
    }

    const content = withLink(title, body, link);
    const results = await Promise.allSettled(
      this.#notifiers.map((notifier) =>
        sendJingmeMessage(this.#fetch, this.#jingme, teamAccessToken, notifier.erp, content),
      ),
    );
    let ok = true;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status === "fulfilled") continue;
      ok = false;
      this.#log(`通知发送失败 ${redact(this.#notifiers[i])}: ${result.reason?.message ?? String(result.reason)}`);
    }
    return ok;
  }
}

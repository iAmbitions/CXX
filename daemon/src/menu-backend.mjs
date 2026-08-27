// Per-action backend for the menu-bar shell (Model A).
//
// The Swift shell is a pure view: it shells out to `cxx-daemon <subcommand>` for
// every action (argv subcommand in → single JSON object out) and never holds a
// persistent connection. This module is the cross-cutting command surface, mirroring
// codex-zh's launcher/remote-backend-core.mjs. Everything here is pure config I/O
// (reuse of config.mjs / notify.mjs) except enable/disable which delegate to the
// platform keepalive layer (mac-agent.mjs) via deps.
//
// The running daemon and this CLI communicate ONLY through the config JSON on disk
// (device/notifier edits) + launchctl (lifecycle). The daemon picks up config edits
// via config-watch.mjs (fs.watch + stat poll) and per-auth re-reads. No socket/IPC.
//
// Protocol:
//   status        -> { enabled, running, deviceCount, notifierCount, relay, version }
//   enable        -> { ok, enabled, error? }     (platform hook)
//   disable       -> { ok, enabled }             (platform hook)
//   pair          -> { url } | { error }         (#p= one-time link, 5-min TTL)
//   pair-once     -> { url } | { error }         (compatibility alias of pair)
//   pair-permanent -> { url } | { error }        (#d= long-lived device link; revoke in Devices)
//   devices       -> { devices:[{deviceId,name,createdAt,lastSeenAt,phoneGroup*, …viewer fields}] }
//   revoke <id>   -> { ok }
//   prune-unused  -> { ok, removed }
//   device-group <inputFile> -> { ok, count }    (group browser credentials as one physical phone)
//   device-ungroup <id> -> { ok }
//   notify-list   -> { notifiers:[{index,label}] }
//   notify-add <inputFile>  -> { ok, count }     (input {type:"jingme",erp} via temp file)
//   notify-remove <index>       -> { ok }
//   notify-test [inputFile]     -> { ok, count }     (tests the unsaved entry in inputFile)
//   notify-test-index <index>   -> { ok, count }     (tests the saved channel at index)
import { existsSync, readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  deviceUrl,
  issueDeviceToken,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "./config.mjs";
import { createJingmeNotifier, isJingmeNotifier, normalizeJingmeConfig, Notifier, redact } from "./notify.mjs";
import { listPtyHosts, reattachPtyHost, resolvePtyHostBin } from "./pty-adapter.mjs";
import { writeQrBmp } from "./qr-bmp.mjs";
import { cxxVersion } from "./version.mjs";

export function status(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  const connectedDevices = (config?.devices ?? []).filter((d) => d.role !== "viewer" && d.lastSeenAt);
  const physicalDeviceKeys = connectedDevices.map((d) => d.phoneGroupId ? `group:${d.phoneGroupId}` : `device:${d.deviceId}`);
  return {
    enabled: deps.isEnabled(deps),
    running: deps.isRunning(deps),
    // Only count credentials that have actually connected. Manually grouped browser
    // credentials represent one physical phone and therefore count once.
    deviceCount: new Set(physicalDeviceKeys).size,
    notifierCount: config?.notifiers?.length ?? 0,
    relay: config?.relayUrl ?? "",
    version: cxxVersion(),
  };
}

// 临时二维码/链接：5 分钟内有效、仅可用一次。令牌被手机成功消费前不会创建
// 设备记录，避免每次生成临时码都留下“从未连接”的垃圾条目。
export function pair(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const token = issuePairToken(deps.configPath, config);
  return maybeAttachQr({ url: pairUrl(loadOrCreateConfig(deps.configPath), token) }, deps);
}

// 长期二维码/链接：面向本人常用手机。链接内含长期设备凭据，因此同一链接可重复打开；
// 重复使用同一链接仍命中同一个 deviceId，不会重复创建设备。设备统计只计算实际连接过的
// 条目，因此生成但尚未使用的长期链接不会在控制中心冒充一台手机。
export function pairPermanent(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const { deviceToken } = issueDeviceToken(deps.configPath, config);
  return maybeAttachQr({ url: deviceUrl(loadOrCreateConfig(deps.configPath), deviceToken) }, deps);
}

// 兼容旧 CLI/壳调用：与临时码 pair 完全等价。
export function pairOnce(deps) {
  return pair(deps);
}

function maybeAttachQr(result, deps) {
  if ((deps.platform || platform()) !== "win32" || !result?.url) return result;
  try {
    result.qrPath = writeQrBmp(result.url, join(tmpdir(), `cxx-qr-${process.pid}-${Date.now()}.bmp`));
  } catch (err) {
    deps.log?.(`qr 生成失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

// 在线观众数：daemon 在观众上下线时把按 deviceId 聚合的计数节流写入 viewer-status.json
//（本 CLI 无常驻进程，这是唯一不引协议通道的取数路径）。daemon 没在跑则视为无人围观。
function readViewerStatus(deps) {
  if (!deps.isRunning(deps)) return {};
  try {
    const p = join(dirname(deps.configPath), "viewer-status.json");
    return JSON.parse(readFileSync(p, "utf8"))?.byDevice ?? {};
  } catch {
    return {};
  }
}

export function listDevices(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { devices: [] };
  const viewers = readViewerStatus(deps);
  return {
    devices: (config.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name || "",
      createdAt: d.createdAt ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      // 手动归并仅影响桌面展示，绝不合并/共享浏览器令牌：各浏览器仍各自独立认证。
      phoneGroupId: d.phoneGroupId ?? null,
      phoneGroupName: d.phoneGroupName ?? null,
      // 围观链接扩展字段（全权设备缺省）：桌面设备页渲染只读徽标/会话名/时效/观众数
      ...(d.role === "viewer"
        ? {
            role: "viewer",
            sessionName: d.sessionName ?? "",
            expiresAt: d.expiresAt ?? null,
            muted: d.muted === true,
            url: d.url ?? null,
            viewers: viewers[d.deviceId] ?? 0,
          }
        : {}),
    })),
  };
}

// 手动把多个已连接的浏览器凭据归入同一“手机”展示组。此操作不改 token、不撤销
// 设备，也不会影响手机端连接；仅避免浏览器/域名隔离把同一台手机显示成多台设备。
export function groupDevices(deps, input = {}) {
  const primaryId = String(input.primaryId ?? "");
  const memberId = String(input.memberId ?? "");
  if (!primaryId || !memberId || primaryId === memberId) {
    return { ok: false, error: "请选择两个不同的已连接设备" };
  }
  const config = loadOrCreateConfig(deps.configPath);
  const fullDevices = (config.devices ?? []).filter((d) => d.role !== "viewer");
  const primary = fullDevices.find((d) => d.deviceId === primaryId);
  const member = fullDevices.find((d) => d.deviceId === memberId);
  if (!primary || !member) return { ok: false, error: "设备不存在或不能归并只读链接" };
  if (!primary.lastSeenAt || !member.lastSeenAt) {
    return { ok: false, error: "只能归并至少成功连接过一次的设备" };
  }
  const groupId = primary.phoneGroupId || `phone:${primary.deviceId}`;
  const name = String(input.name ?? "").trim().slice(0, 48) || primary.phoneGroupName || primary.name || "同一台手机";
  // 若主设备本来已在一组，成员加入整组；不去自动猜测其它设备，避免误把不同手机混在一起。
  for (const d of fullDevices) {
    if (d.deviceId === primary.deviceId || d.deviceId === member.deviceId || d.phoneGroupId === groupId) {
      d.phoneGroupId = groupId;
      d.phoneGroupName = name;
    }
  }
  saveConfig(deps.configPath, config);
  return { ok: true, count: fullDevices.filter((d) => d.phoneGroupId === groupId).length, groupId, name };
}

// 解除当前浏览器凭据的展示归并，不撤销它，也不会断开远程连接。
export function ungroupDevice(deps, deviceId) {
  const config = loadOrCreateConfig(deps.configPath);
  const device = (config.devices ?? []).find((d) => d.deviceId === deviceId && d.role !== "viewer");
  if (!device?.phoneGroupId) return { ok: false, error: "该设备当前不在同一手机组中" };
  delete device.phoneGroupId;
  delete device.phoneGroupName;
  saveConfig(deps.configPath, config);
  return { ok: true };
}

export function revokeDevice(deps, deviceId) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.deviceId !== deviceId);
  saveConfig(deps.configPath, config);
  return { ok: config.devices.length < before };
}

// 清理"从未连接"的设备（lastSeenAt 空）——即生成过但没人扫过的链接。移除它们等于
// 作废这些悬空令牌：曾外泄/转发但没被使用的链接随即失效（撤销即时生效，因 daemon
// 每次鉴权重读配置 + config-watch 热核对）。围观链接除外（永久分享链接长期无人点开合法）。
export function pruneUnusedDevices(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.lastSeenAt || d.role === "viewer");
  const removed = before - config.devices.length;
  saveConfig(deps.configPath, config);
  return { ok: true, removed };
}

function keepJingmeNotifiers(config) {
  const before = Array.isArray(config.notifiers) ? config.notifiers : [];
  const next = before.filter(isJingmeNotifier);
  const changed = next.length !== before.length;
  config.notifiers = next;
  return changed;
}

export function notifyList(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  if (keepJingmeNotifiers(config)) saveConfig(deps.configPath, config);
  return { notifiers: config.notifiers.map((n, index) => ({ index, label: redact(n) })) };
}

export function notifyAdd(deps, entry) {
  const config = loadOrCreateConfig(deps.configPath);
  keepJingmeNotifiers(config);
  const notifier = entry?.type === "jingme" ? createJingmeNotifier(entry.erp) : null;
  if (!notifier) return { ok: false, error: "仅支持京Me机器人通知，ERP 格式无效" };
  if (!normalizeJingmeConfig(config.jingme)) return { ok: false, error: "本机未配置京Me机器人凭据" };
  if (!config.notifiers.some((n) => n.erp === notifier.erp)) config.notifiers.push(notifier);
  saveConfig(deps.configPath, config);
  return { ok: true, count: config.notifiers.length };
}

export function notifyRemove(deps, index) {
  const config = loadOrCreateConfig(deps.configPath);
  keepJingmeNotifiers(config);
  if (index < 0 || index >= config.notifiers.length) return { ok: false };
  config.notifiers.splice(index, 1);
  saveConfig(deps.configPath, config);
  return { ok: true };
}

// 测试输入框中尚未添加的京Me接收人；不落盘。
export async function notifyTest(deps, entry) {
  const config = loadOrCreateConfig(deps.configPath);
  const notifierEntry = entry?.type === "jingme" ? createJingmeNotifier(entry.erp) : null;
  if (!notifierEntry) return { ok: false, count: 0, error: "ERP 格式无效" };
  const notifier = new Notifier([notifierEntry], { log: deps.log, jingme: config.jingme });
  const ok = await notifier.send("口袋Agent 测试", "如果你收到这条，说明京Me机器人通知配置成功 ✅");
  return { ok, count: notifier.count, ...(ok ? {} : { error: "京Me测试消息发送失败" }) };
}

// 测试一个已保存的京Me接收人。
export async function notifyTestIndex(deps, index) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  if (keepJingmeNotifiers(config)) saveConfig(deps.configPath, config);
  const list = config.notifiers;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return { ok: false, count: 0 };
  const notifier = new Notifier([list[index]], { log: deps.log, jingme: config.jingme });
  const ok = await notifier.send("口袋Agent 测试", "如果你收到这条，说明京Me机器人通知配置成功 ✅");
  return { ok, count: notifier.count, ...(ok ? {} : { error: "京Me测试消息发送失败" }) };
}

// —— Terminal Mode（internal/TERMINAL-MODE.md §4.8/§13.1）——
// 桌面壳的终端管理面：全局开关 + 逐设备授权（写配置，daemon config-watch 热生效）、
// 运行中终端可见性与电脑侧结束。真相在 pty-host 注册目录（磁盘），CLI 无常驻进程
// 也能读；结束直接连 host 的本机 socket 发 CLOSE，不经 daemon。
function ptyBaseDir(deps) {
  return join(dirname(deps.configPath), "pty");
}

export function terminalStatus(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  const hosts = listPtyHosts(ptyBaseDir(deps));
  return {
    enabled: config?.terminalEnabled === true,
    hostAvailable: Boolean(resolvePtyHostBin(config?.ptyHostPath)),
    // 菜单栏「终端 · N」的 N = 存活 host 数；列表含 title/cwd 供点开查看与结束
    terminals: hosts.map((h) => ({
      terminalId: h.terminalId,
      title: h.meta?.title ?? h.terminalId,
      cwd: h.meta?.cwd ?? "",
      presetName: h.meta?.presetName ?? "",
      startedAt: h.startedAt ?? null,
      alive: h.alive,
      exit: h.exit ?? null,
    })),
    devices: (config?.devices ?? [])
      .filter((d) => d.role !== "viewer")
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name || "",
        terminalAccess: d.terminalAccess === true,
      })),
  };
}

export function terminalEnable(deps, enabled) {
  const config = loadOrCreateConfig(deps.configPath);
  config.terminalEnabled = enabled === true;
  saveConfig(deps.configPath, config);
  return { ok: true, enabled: config.terminalEnabled };
}

export function terminalAccess(deps, deviceId, allowed) {
  const config = loadOrCreateConfig(deps.configPath);
  const device = (config.devices ?? []).find((d) => d.deviceId === deviceId && d.role !== "viewer");
  if (!device) return { ok: false, error: "设备不存在" };
  device.terminalAccess = allowed === true;
  saveConfig(deps.configPath, config);
  return { ok: true, deviceId, terminalAccess: device.terminalAccess };
}

// 电脑侧结束一个终端（§4.8 信任对称）：直连该 host 的 socket 发 CLOSE
//（host 自会 SIGTERM→SIGKILL 子进程并自灭）。host 已死则只清注册目录残骸。
export async function terminalClose(deps, terminalId) {
  if (!/^[\w.-]+$/.test(String(terminalId ?? ""))) return { ok: false, error: "terminalId 非法" };
  const host = listPtyHosts(ptyBaseDir(deps)).find((h) => h.terminalId === terminalId);
  if (!host) return { ok: false, error: "终端不存在" };
  if (!host.alive) return { ok: true, alreadyExited: true };
  try {
    const { client } = await reattachPtyHost({ dir: host.dir, sinceSeq: Number.MAX_SAFE_INTEGER, timeoutMs: 3000 });
    client.close();
    await new Promise((r) => setTimeout(r, 300)); // 给 CLOSE 帧冲刷的时间
    client.disconnect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// —— CLI 分发 —— enable/disable 走平台钩子（mac/win/linux-agent），其余纯 config 逻辑。
export async function runMenuCommand(command, rest, deps) {
  switch (command) {
    case "status": return status(deps);
    case "enable": return deps.enable(deps);
    case "disable": return deps.disable(deps);
    case "pair": return pair(deps);
    case "pair-once": return pairOnce(deps);
    case "pair-permanent": return pairPermanent(deps);
    case "devices": return listDevices(deps);
    case "revoke": return revokeDevice(deps, rest[0]);
    case "prune-unused": return pruneUnusedDevices(deps);
    case "device-group": return groupDevices(deps, JSON.parse(readFileSync(rest[0], "utf8")));
    case "device-ungroup": return ungroupDevice(deps, rest[0]);
    case "notify-list": return notifyList(deps);
    case "notify-add": return notifyAdd(deps, JSON.parse(readFileSync(rest[0], "utf8")));
    case "notify-remove": return notifyRemove(deps, Number(rest[0]));
    case "notify-test": return notifyTest(deps, rest[0] ? JSON.parse(readFileSync(rest[0], "utf8")) : undefined);
    case "notify-test-index": return notifyTestIndex(deps, Number(rest[0]));
    case "terminal-status": return terminalStatus(deps);
    case "terminal-enable": return terminalEnable(deps, rest[0] !== "0" && rest[0] !== "false");
    case "terminal-access": return terminalAccess(deps, rest[0], rest[1] !== "0" && rest[1] !== "false");
    case "terminal-close": return terminalClose(deps, rest[0]);
    default: return null; // not a menu command
  }
}

export const MENU_COMMANDS = new Set([
  "status", "enable", "disable", "pair", "pair-once", "pair-permanent", "devices",
  "revoke", "prune-unused", "device-group", "device-ungroup", "notify-list", "notify-add", "notify-remove", "notify-test", "notify-test-index",
  "terminal-status", "terminal-enable", "terminal-access", "terminal-close",
]);

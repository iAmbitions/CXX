// Codex model metadata helpers. The live app-server catalog is useful for standard
// installs, while a custom CODEX_HOME/config.toml may point at a local model catalog
// that changes independently of the running Codex process.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function unquoteTomlString(value) {
  const v = String(value ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim();
  }
  return "";
}

function parseTomlConfig(text) {
  let section = "";
  const topLevel = {};
  const profileModels = new Map();
  let activeProfile = "";
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    const value = unquoteTomlString(rawValue);
    if (!value) continue;
    if (!section) {
      topLevel[key] = value;
      if (key === "profile") activeProfile = value;
    }
    const profileMatch = section.match(/^profiles[.\"]?(.+?)[\"]?$/);
    if (profileMatch && key === "model") profileModels.set(profileMatch[1].replace(/^"|"$/g, ""), value);
  }
  return {
    model: profileModels.get(activeProfile) || topLevel.model || null,
    modelCatalogPath: topLevel.model_catalog_json || null,
  };
}

function configPath({ env = process.env, home = homedir() } = {}) {
  const base = String(env.CODEX_HOME || join(home, ".codex")).trim();
  return join(base, "config.toml");
}

export function readCodexConfiguredModel(options = {}) {
  const { readFile = readFileSync, exists = existsSync } = options;
  const path = configPath(options);
  try {
    if (!exists(path)) return null;
    return parseTomlConfig(readFile(path, "utf8")).model;
  } catch {
    return null;
  }
}

export function modelIdOf(model) {
  const id = model?.model ?? model?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function modelMatchesId(model, id) {
  const left = modelIdOf(model);
  return Boolean(left && id && left.toLowerCase() === String(id).trim().toLowerCase());
}

export function markConfiguredCodexDefault(models, configuredModel) {
  const list = Array.isArray(models) ? models : [];
  if (!configuredModel || !list.some((m) => modelMatchesId(m, configuredModel))) return list;
  return list.map((m) => ({ ...m, isDefault: modelMatchesId(m, configuredModel) }));
}

function catalogModelToAppServer(model, configuredModel) {
  const id = typeof model?.slug === "string" ? model.slug.trim() : "";
  if (!id || model?.visibility === "hidden") return null;
  const efforts = Array.isArray(model?.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((item) => ({ reasoningEffort: item?.effort, description: item?.description }))
      .filter((item) => typeof item.reasoningEffort === "string" && item.reasoningEffort)
    : [];
  return {
    id,
    model: id,
    displayName: String(model?.display_name || id),
    description: String(model?.description || model?.display_name || id),
    hidden: false,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: typeof model?.default_reasoning_level === "string"
      ? model.default_reasoning_level
      : null,
    isDefault: modelMatchesId({ id }, configuredModel),
  };
}

// Read the catalog on every call. This makes a browser reload pick up changes made
// by local tools such as cc-switch without waiting for Pocket Agent or Codex to restart.
export function readCodexLocalModelCatalog(options = {}) {
  const { readFile = readFileSync, exists = existsSync } = options;
  const path = configPath(options);
  try {
    if (!exists(path)) return null;
    const parsed = parseTomlConfig(readFile(path, "utf8"));
    if (!parsed.modelCatalogPath) return null;
    const catalogPath = isAbsolute(parsed.modelCatalogPath)
      ? parsed.modelCatalogPath
      : resolve(dirname(path), parsed.modelCatalogPath);
    if (!exists(catalogPath)) return null;
    const payload = JSON.parse(readFile(catalogPath, "utf8"));
    const models = (Array.isArray(payload?.models) ? payload.models : [])
      .map((model) => catalogModelToAppServer(model, parsed.model))
      .filter(Boolean);
    return models.length ? models : null;
  } catch {
    return null;
  }
}

// A local catalog, when present, is the exact user-managed source of truth. Keep
// app-server's catalog as a fallback for ordinary Codex installations.
export function resolveCodexModels(appServerModels, { configuredModel = null, localCatalog = null } = {}) {
  const local = Array.isArray(localCatalog) && localCatalog.length ? localCatalog : null;
  return markConfiguredCodexDefault(local ?? appServerModels, configuredModel);
}

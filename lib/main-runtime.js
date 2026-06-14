"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OFFICIAL_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiUrl(value) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : "";
}

function deriveModelListUrl(value) {
  const normalized = normalizeApiUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.search = "";
    url.hash = "";
    return `${url.toString().replace(/\/+$/, "")}/models`;
  } catch {
    return `${normalized.replace(/\/+$/, "")}/models`;
  }
}

function deriveEndpointUrl(value, endpointPath) {
  const normalized = normalizeApiUrl(value);
  const cleanPath = trimString(endpointPath).replace(/^\/+/, "");
  if (!normalized || !cleanPath) return "";
  try {
    return new URL(cleanPath, `${normalized.replace(/\/+$/, "")}/`).toString();
  } catch {
    return `${normalized.replace(/\/+$/, "")}/${cleanPath}`;
  }
}

function deriveChatCompletionsUrl(value) {
  return deriveEndpointUrl(value, "chat/completions");
}

function codexHome() {
  return trimString(process.env.CODEX_HOME) || path.join(os.homedir(), ".codex");
}

function tomlQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseTomlString(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(['"])(.*?)\\1\\s*$`));
  return match ? match[2] : "";
}

function readAuthApiKey(authPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return trimString(parsed?.OPENAI_API_KEY);
  } catch {
    return "";
  }
}

function readCodexApiSettings() {
  const home = codexHome();
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  const apiKey = readAuthApiKey(authPath);
  let modelProvider = "";
  let model = "";
  let providerName = "";
  let apiUrl = "";

  if (fs.existsSync(configPath)) {
    const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      modelProvider ||= parseTomlString(line, "model_provider");
      model ||= parseTomlString(line, "model");
    }

    const providerSections = modelProvider
      ? new Set([
          `model_providers.${modelProvider}`,
          `model_providers."${modelProvider}"`,
          `model_providers.'${modelProvider}'`,
        ])
      : new Set();
    let currentSection = "";
    for (const line of lines) {
      const sectionMatch = line.match(/^\s*\[(.+?)\]\s*$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        continue;
      }
      if (!providerSections.has(currentSection)) continue;
      providerName ||= parseTomlString(line, "name");
      apiUrl ||= normalizeApiUrl(parseTomlString(line, "base_url"));
    }
  }

  const effectiveApiUrl = apiUrl || (apiKey ? OFFICIAL_OPENAI_API_BASE_URL : "");
  return {
    dataDir: home,
    configPath,
    authPath,
    providerId: modelProvider,
    providerName,
    model,
    apiUrl: effectiveApiUrl,
    modelListUrl: deriveModelListUrl(effectiveApiUrl),
    apiKey,
    hasApiKey: apiKey.length > 0,
  };
}

function writeCodexConfigApiUrl(configPath, providerId, apiUrl) {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  if (!normalizedApiUrl) {
    throw new Error("API URL cannot be empty.");
  }
  if (!providerId) {
    throw new Error("Current model_provider was not found, so config.toml cannot be updated.");
  }

  const lines = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").split(/\r?\n/) : [];
  const providerSections = new Set([
    `model_providers.${providerId}`,
    `model_providers."${providerId}"`,
    `model_providers.'${providerId}'`,
  ]);
  let currentSection = "";
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let baseUrlLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^\s*\[(.+?)\]\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (sectionStart >= 0) {
        sectionEnd = index;
        break;
      }
      if (providerSections.has(currentSection)) {
        sectionStart = index;
      }
      continue;
    }
    if (sectionStart >= 0 && providerSections.has(currentSection) && /^\s*base_url\s*=/.test(lines[index])) {
      baseUrlLine = index;
    }
  }

  const nextLine = `base_url = ${tomlQuote(normalizedApiUrl)}`;
  if (baseUrlLine >= 0) {
    lines[baseUrlLine] = nextLine;
  } else if (sectionStart >= 0) {
    lines.splice(sectionEnd, 0, nextLine);
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`[model_providers.${providerId}]`, nextLine);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

function writeAuthApiKey(authPath, apiKey) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {}
  parsed.auth_mode = parsed.auth_mode || "apikey";
  parsed.OPENAI_API_KEY = trimString(apiKey);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function writeCodexApiSettings(nextSettings = {}) {
  const current = readCodexApiSettings();
  const apiUrl = normalizeApiUrl(nextSettings.apiUrl || current.apiUrl);
  const apiKey = trimString(nextSettings.apiKey);
  writeCodexConfigApiUrl(current.configPath, current.providerId, apiUrl);
  writeAuthApiKey(current.authPath, apiKey);
  return { apiUrl, apiKey };
}

function readEffectiveSettings() {
  const codexSettings = readCodexApiSettings();
  const apiUrl = codexSettings.apiUrl;
  const apiKey = codexSettings.apiKey;
  return {
    ...codexSettings,
    apiUrl,
    modelListUrl: deriveModelListUrl(apiUrl),
    apiKey,
    hasApiKey: apiKey.length > 0,
    source: "codex-config",
    savedApiUrl: apiUrl,
    savedApiKey: apiKey,
    codexApiUrl: codexSettings.apiUrl,
    codexHasApiKey: codexSettings.hasApiKey,
  };
}

function readRequestSettings(request = {}) {
  const settings = readEffectiveSettings();
  const requestApiUrl = normalizeApiUrl(request.apiUrl);
  const requestApiKey = trimString(request.apiKey);
  const hasRequestOverride = requestApiUrl.length > 0 || requestApiKey.length > 0;
  if (!hasRequestOverride) return settings;
  const apiUrl = requestApiUrl || settings.apiUrl;
  const apiKey = requestApiKey;
  return {
    ...settings,
    apiUrl,
    modelListUrl: deriveModelListUrl(apiUrl),
    apiKey,
    hasApiKey: apiKey.length > 0,
    source: "settings-draft",
  };
}

function createMainRuntime(api) {
  let cache = { at: 0, settingsKey: "", value: null };
  const TTL_MS = 30_000;

  function readSettings() {
    return readEffectiveSettings();
  }

  function writeSettings(nextSettings = {}) {
    const saved = writeCodexApiSettings(nextSettings);
    cache = { at: 0, settingsKey: "", value: null };
    api.log.info("[custom-models] codex api settings saved", {
      hasApiUrl: saved.apiUrl.length > 0,
      hasApiKey: saved.apiKey.length > 0,
    });
    return readEffectiveSettings();
  }

  async function fetchModels(request = {}) {
    const settings = readRequestSettings(request);
    if (!settings.modelListUrl) {
      throw new Error("The current provider models endpoint was not found.");
    }
    const settingsKey = `${settings.modelListUrl}\n${settings.apiKey}`;
    if (!request.force && cache.value && cache.settingsKey === settingsKey && Date.now() - cache.at < TTL_MS) {
      return cache.value;
    }

    const headers = { Accept: "application/json" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    api.log.info("[custom-models] fetch model list", {
      url: settings.modelListUrl,
      providerId: settings.providerId,
      hasApiKey: settings.hasApiKey,
      force: request.force === true,
    });
    const response = await fetch(settings.modelListUrl, { method: "GET", headers });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}): ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    }
    cache = { at: Date.now(), settingsKey, value: payload };
    return payload;
  }

  async function testModel(request = {}) {
    const settings = readRequestSettings(request);
    const model = trimString(request.model);
    const message = trimString(request.message) || "hi";
    const url = deriveChatCompletionsUrl(settings.apiUrl);
    if (!url) {
      throw new Error("Test endpoint was not found.");
    }
    if (!model) {
      throw new Error("Select a model.");
    }

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    const body = {
      model,
      messages: [{ role: "user", content: message }],
      stream: false,
      temperature: 0,
      max_tokens: 32,
    };

    api.log.info("[custom-models] test model request", {
      url,
      model,
      hasApiKey: settings.hasApiKey,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      throw new Error(`Test request failed (${response.status}): ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    }

    const assistantText =
      trimString(payload?.choices?.[0]?.message?.content) ||
      trimString(payload?.choices?.[0]?.delta?.content) ||
      trimString(payload?.output_text) ||
      trimString(payload?.text) ||
      "";

    return {
      url,
      model,
      message,
      assistantText,
      usage: payload?.usage || null,
      raw: payload,
    };
  }

  return { readSettings, writeSettings, fetchModels, testModel };
}

module.exports = {
  createMainRuntime,
  deriveModelListUrl,
  readCodexApiSettings,
  readEffectiveSettings,
};

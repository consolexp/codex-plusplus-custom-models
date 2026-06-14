"use strict";

const TWEAK_ID = "io.github.consolexp.custom-models";
const LEGACY_TWEAK_IDS = ["com.local.custom-models"];
const REFRESH_EVENT = "codexpp-custom-models-refresh";
const CHANNELS = ["settings-read", "settings-write", "fetch-models", "test-model", "broadcast-refresh"];

let settingsHandle = null;
let webviewBridgeTeardown = null;

const TEXT = {
  en: {
    pageTitle: "Custom Models",
    pageDescription: "Read and replace model choices from an OpenAI-compatible /models endpoint.",
    readingConfig: "Reading current model configuration...",
    saveRefresh: "Save and Refresh",
    refreshModelList: "Refresh Model List",
    testSelectedModel: "Test Selected Model",
    selectModelToTest: 'Select a model, then send "hi" to test connectivity.',
    source: "Source: Codex configuration",
    currentProvider: (value) => `Current provider: ${value || "-"}`,
    baseUrl: (value) => `Base URL: ${value || "-"}`,
    modelsEndpoint: (value) => `Models endpoint: ${value || "-"}`,
    apiKey: (loaded) => `API key: ${loaded ? "loaded" : "not loaded"}`,
    configFile: (value) => `Config file: ${value || "-"}`,
    authFile: (value) => `Auth file: ${value || "-"}`,
    enabledStatus: "Custom Models is enabled.",
    missingBaseUrl: "Provider base_url was not found.",
    noModelsLoaded: "No models loaded",
    noModelToTest: "No model is available to test.",
    loadedModels: (count, model) => `Loaded ${count} models. Current selection: ${model}`,
    refreshingModels: "Refreshing model list...",
    savingApi: "Saving API settings...",
    savedRefreshing: "Saved. Refreshing model list...",
    savedCount: (count) => `Saved and refreshed ${count} models.`,
    refreshedCount: (count) => `Refreshed ${count} models.`,
    currentSelection: (model) => `Current selection: ${model}`,
    selectModel: "Select a model.",
    sendingHi: (model) => `Sending "hi" with ${model}...`,
    testingModel: "Testing model connectivity...",
    emptyResponse: "(model returned an empty response)",
    resultModel: (value) => `Model: ${value}`,
    resultEndpoint: (value) => `Endpoint: ${value}`,
    resultSent: (value) => `Sent: ${value}`,
    resultReply: (value) => `Reply: ${value}`,
    testPassed: "Test passed. The model endpoint is available.",
    testFailed: "Test failed.",
    rowModelSource: "Model List Source",
    rowModelSourceDescription: "Read and write the current Codex config.toml/auth.json.",
    rowApiUrl: "API URL",
    rowApiUrlDescription: "OpenAI-compatible API base URL. The tweak requests its /models endpoint automatically.",
    rowApiKey: "API Key",
    rowApiKeyDescription: "Bearer token used to request the model list.",
    rowActions: "Actions",
    rowActionsDescription: "Save the current configuration or request /models again.",
    rowTestModel: "Test Model",
    rowTestModelDescription: 'Send "hi" with the selected model to verify the URL and key.',
  },
  zh: {
    pageTitle: "自定义模型",
    pageDescription: "从 OpenAI 兼容的 /models 端点读取并替换模型选项。",
    readingConfig: "正在读取当前模型配置...",
    saveRefresh: "保存并刷新",
    refreshModelList: "刷新模型列表",
    testSelectedModel: "测试所选模型",
    selectModelToTest: "选择一个模型，然后发送“hi”测试连通性。",
    source: "来源：Codex 配置",
    currentProvider: (value) => `当前提供商：${value || "-"}`,
    baseUrl: (value) => `基础 URL：${value || "-"}`,
    modelsEndpoint: (value) => `模型端点：${value || "-"}`,
    apiKey: (loaded) => `API 密钥：${loaded ? "已加载" : "未加载"}`,
    configFile: (value) => `配置文件：${value || "-"}`,
    authFile: (value) => `认证文件：${value || "-"}`,
    enabledStatus: "自定义模型已启用。",
    missingBaseUrl: "未找到提供商 base_url。",
    noModelsLoaded: "未加载模型",
    noModelToTest: "没有可用于测试的模型。",
    loadedModels: (count, model) => `已加载 ${count} 个模型。当前选择：${model}`,
    refreshingModels: "正在刷新模型列表...",
    savingApi: "正在保存 API 设置...",
    savedRefreshing: "已保存。正在刷新模型列表...",
    savedCount: (count) => `已保存并刷新 ${count} 个模型。`,
    refreshedCount: (count) => `已刷新 ${count} 个模型。`,
    currentSelection: (model) => `当前选择：${model}`,
    selectModel: "请选择一个模型。",
    sendingHi: (model) => `正在使用 ${model} 发送“hi”...`,
    testingModel: "正在测试模型连通性...",
    emptyResponse: "（模型返回了空响应）",
    resultModel: (value) => `模型：${value}`,
    resultEndpoint: (value) => `端点：${value}`,
    resultSent: (value) => `发送：${value}`,
    resultReply: (value) => `回复：${value}`,
    testPassed: "测试通过。模型端点可用。",
    testFailed: "测试失败。",
    rowModelSource: "模型列表来源",
    rowModelSourceDescription: "读取并写入当前 Codex config.toml/auth.json。",
    rowApiUrl: "API URL",
    rowApiUrlDescription: "OpenAI 兼容 API 基础 URL。此 tweak 会自动请求它的 /models 端点。",
    rowApiKey: "API 密钥",
    rowApiKeyDescription: "用于请求模型列表的 Bearer token。",
    rowActions: "操作",
    rowActionsDescription: "保存当前配置或再次请求 /models。",
    rowTestModel: "测试模型",
    rowTestModelDescription: "用所选模型发送“hi”以验证 URL 和密钥。",
  },
};

function currentLanguage() {
  const candidates = [
    publicLanguageFromGlobals(),
    globalThis.__codexppLanguage,
    globalThis.__codexppLocale,
    documentLanguageFromHtml(),
    uiLanguageFromDocument(),
    browserLanguageFromNavigator(),
  ];
  for (const candidate of candidates) {
    const language = normalizeLanguageCandidate(candidate);
    if (language) return language;
  }
  return "zh";
}

function normalizeLanguageCandidate(candidate) {
  const value = String(candidate || "").trim().toLowerCase();
  if (!value || value === "auto" || value === "system" || value === "default") return null;
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("en")) return "en";
  return null;
}

function uiLanguageFromDocument() {
  if (typeof document === "undefined") return null;
  const text = [
    document.documentElement?.lang,
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join("\n");
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : null;
}

function documentLanguageFromHtml() {
  if (typeof document === "undefined") return null;
  const value = String(document.documentElement?.lang || "").trim().toLowerCase();
  return value.startsWith("zh") ? "zh" : null;
}

function browserLanguageFromNavigator() {
  if (typeof navigator === "undefined") return null;
  const value = String(navigator.language || "").trim().toLowerCase();
  return value.startsWith("zh") ? "zh" : null;
}

function publicLanguageFromGlobals() {
  const globalCandidates = [
    globalThis.__codexppPublicSettings,
    globalThis.__codexppSettings,
    globalThis.__codex?.settings,
  ];
  for (const candidate of globalCandidates) {
    const value = candidate?.localeOverride ?? candidate?.values?.localeOverride;
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !/codex|setting|locale|language/i.test(key)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw || !raw.includes("localeOverride")) continue;
      const value = findLocaleOverride(JSON.parse(raw));
      if (value) return value;
    }
  } catch {}
  return null;
}

function findLocaleOverride(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.localeOverride === "string") return value.localeOverride;
  if (typeof value.values?.localeOverride === "string") return value.values.localeOverride;
  for (const child of Object.values(value)) {
    const result = findLocaleOverride(child);
    if (result) return result;
  }
  return null;
}

function t(key, ...args) {
  const entry = TEXT[currentLanguage()][key] ?? TEXT.en[key] ?? key;
  return typeof entry === "function" ? entry(...args) : entry;
}

function clearMainIpcHandlers() {
  if (typeof require !== "function") return;
  try {
    const { ipcMain } = require("electron");
    for (const tweakId of [TWEAK_ID, ...LEGACY_TWEAK_IDS]) {
      for (const channel of CHANNELS) {
        ipcMain.removeHandler(`codexpp:${tweakId}:${channel}`);
      }
    }
  } catch {}
}

function startMain(api) {
  clearMainIpcHandlers();
  try {
    webviewBridgeTeardown?.();
  } catch {}
  webviewBridgeTeardown = null;
  const mainRuntimePath = require.resolve("./lib/main-runtime.js");
  const mainWebviewBridgePath = require.resolve("./lib/main-webview-bridge.js");
  delete require.cache[mainRuntimePath];
  delete require.cache[mainWebviewBridgePath];
  const { createMainRuntime } = require(mainRuntimePath);
  const { createMainWebviewBridge } = require(mainWebviewBridgePath);
  const fs = require("node:fs");
  const path = require("node:path");
  const runtime = createMainRuntime(api);
  const bridge = createMainWebviewBridge({
    api,
    readRendererBundle() {
      return fs.readFileSync(path.join(__dirname, "lib", "renderer.js"), "utf8");
    },
    async handleRpc(channel, args) {
      if (channel === "settings-read") {
        return runtime.readSettings();
      }
      if (channel === "settings-write") {
        return runtime.writeSettings(args[0]);
      }
      if (channel === "fetch-models") {
        return runtime.fetchModels(args[0]);
      }
      if (channel === "test-model") {
        return runtime.testModel(args[0]);
      }
      throw new Error(`Unknown Custom Models RPC channel: ${channel}`);
    },
  });
  api.ipc.handle("settings-read", () => runtime.readSettings());
  api.ipc.handle("settings-write", (payload) => runtime.writeSettings(payload));
  api.ipc.handle("fetch-models", (request) => runtime.fetchModels(request));
  api.ipc.handle("test-model", (request) => runtime.testModel(request));
  api.ipc.handle("broadcast-refresh", (payload) => {
    bridge.dispatchCustomEvent(REFRESH_EVENT, payload || null);
    return { ok: true };
  });
  bridge.start();
  webviewBridgeTeardown = () => bridge.dispose();
  api.log.info("[custom-models] main bridge ready.");
  return () => {
    try {
      webviewBridgeTeardown?.();
    } catch {}
    webviewBridgeTeardown = null;
    clearMainIpcHandlers();
  };
}

function startRenderer(api) {
  if (typeof api.settings?.registerPage === "function") {
    settingsHandle = api.settings.registerPage({
      id: "custom-models",
      title: t("pageTitle"),
      description: t("pageDescription"),
      render(root) {
        renderSettings(root, api);
      },
    });
  } else {
    api.log.warn("[custom-models] settings.registerPage unavailable.");
  }
}

function createEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "className") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "type") el.type = value;
    else if (key === "value") el.value = value == null ? "" : String(value);
    else if (value != null) el.setAttribute(key, String(value));
  }
  for (const child of children) el.append(child);
  return el;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function modelNameFromEntry(entry) {
  return trimString(entry?.model ?? entry?.id ?? entry?.name);
}

function extractModelNames(payload) {
  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  const seen = new Set();
  const names = [];
  for (const entry of rawModels) {
    const name = typeof entry === "string" ? trimString(entry) : modelNameFromEntry(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function renderSettings(root, api) {
  root.innerHTML = "";
  let currentSettings = null;
  let currentModelNames = [];
  const status = createEl("div", {
    className: "min-h-5 text-xs text-token-text-secondary",
    text: t("readingConfig"),
  });
  const details = createEl("div", {
    className: "whitespace-pre-wrap text-xs leading-5 text-token-text-secondary",
  });
  const apiUrlInput = createEl("input", {
    type: "url",
    className:
      "w-full rounded-lg border border-token-border bg-token-input-background px-3 py-2 text-sm " +
      "text-token-text-primary outline-none focus:border-token-text-secondary",
    placeholder: "https://api.openai.com/v1",
  });
  const apiKeyInput = createEl("input", {
    type: "text",
    className:
      "w-full rounded-lg border border-token-border bg-token-input-background px-3 py-2 text-sm " +
      "text-token-text-primary outline-none focus:border-token-text-secondary",
    placeholder: "sk-...",
  });
  const saveButton = createEl("button", {
    type: "button",
    className:
      "rounded-lg border border-token-border px-3 py-1.5 text-sm text-token-text-primary " +
      "shadow-sm hover:bg-token-foreground/10 disabled:opacity-60",
    text: t("saveRefresh"),
  });
  const refreshButton = createEl("button", {
    type: "button",
    className:
      "rounded-lg border border-token-border px-3 py-1.5 text-sm text-token-text-primary " +
      "shadow-sm hover:bg-token-foreground/10 disabled:opacity-60",
    text: t("refreshModelList"),
  });
  const actionButtons = createEl("div", {
    className: "flex w-full max-w-md flex-wrap justify-end gap-2",
  }, [saveButton, refreshButton]);
  const modelSelect = createEl("select", {
    className:
      "w-full rounded-lg border border-token-border bg-token-input-background px-3 py-2 text-sm " +
      "text-token-text-primary outline-none focus:border-token-text-secondary disabled:opacity-60",
  });
  const testButton = createEl("button", {
    type: "button",
    className:
      "rounded-lg border border-token-border px-3 py-1.5 text-sm text-token-text-primary " +
      "shadow-sm hover:bg-token-foreground/10 disabled:opacity-60",
    text: t("testSelectedModel"),
  });
  const testResult = createEl("div", {
    className: "whitespace-pre-wrap text-xs leading-5 text-token-text-secondary",
    text: t("selectModelToTest"),
  });
  const rows = createEl("div", { className: "divide-y-[0.5px] divide-token-border" });
  const card = createEl("div", {
    className: "overflow-hidden rounded-lg border border-token-border bg-token-input-background shadow-sm",
  }, [rows]);
  const page = createEl("div", { className: "flex max-w-3xl flex-col gap-4" }, [card, status]);

  function row(label, description, control) {
    return createEl("div", {
      className: "flex items-center justify-between gap-4 p-3 max-sm:flex-col max-sm:items-stretch",
    }, [
      createEl("div", { className: "min-w-0 flex-1" }, [
        createEl("div", { className: "text-sm font-medium text-token-text-primary", text: label }),
        description
          ? createEl("div", { className: "mt-0.5 text-xs leading-5 text-token-text-secondary", text: description })
          : document.createTextNode(""),
      ]),
      createEl("div", { className: "flex min-w-[18rem] justify-end max-sm:min-w-0" }, [control]),
    ]);
  }

  function inputStack(children) {
    return createEl("div", { className: "flex w-full max-w-md flex-col gap-2" }, children);
  }

  function setButtonsDisabled(disabled) {
    saveButton.disabled = disabled;
    refreshButton.disabled = disabled;
    testButton.disabled = disabled || currentModelNames.length === 0;
    modelSelect.disabled = disabled || currentModelNames.length === 0;
  }

  function setStatus(text, kind) {
    status.textContent = text || "";
    status.className =
      kind === "error"
        ? "min-h-5 text-xs text-red-500"
        : kind === "ok"
          ? "min-h-5 text-xs text-green-600"
          : "min-h-5 text-xs text-token-text-secondary";
  }

  async function loadSettings() {
    try {
      const settings = await api.ipc.invoke("settings-read");
      currentSettings = settings;
      apiUrlInput.value = settings.savedApiUrl || "";
      apiKeyInput.value = settings.savedApiKey || "";
      const lines = [
        t("source"),
        t("currentProvider", settings.providerName || settings.providerId),
        t("baseUrl", settings.apiUrl),
        t("modelsEndpoint", settings.modelListUrl),
        t("apiKey", settings.hasApiKey),
        t("configFile", settings.configPath),
        t("authFile", settings.authPath),
      ];
      details.textContent = lines.join("\n");
      setStatus(settings.modelListUrl ? t("enabledStatus") : t("missingBaseUrl"), settings.modelListUrl ? "ok" : "error");
    } catch (error) {
      details.textContent = "";
      setStatus(error?.message || String(error), "error");
    }
  }

  function renderModelNames(modelNames) {
    currentModelNames = Array.isArray(modelNames) ? modelNames : [];
    modelSelect.innerHTML = "";
    if (currentModelNames.length === 0) {
      modelSelect.append(createEl("option", { value: "", text: t("noModelsLoaded") }));
      testResult.textContent = t("noModelToTest");
      setButtonsDisabled(false);
      return;
    }

    for (const name of currentModelNames) {
      modelSelect.append(createEl("option", { value: name, text: name }));
    }
    testResult.textContent = t("loadedModels", currentModelNames.length, modelSelect.value);
    setButtonsDisabled(false);
  }

  async function refreshModels(statusText = t("refreshingModels")) {
    setStatus(statusText);
    const result = await api.ipc.invoke("fetch-models", {
      force: true,
      apiUrl: apiUrlInput.value,
      apiKey: apiKeyInput.value,
    });
    await api.ipc.invoke("broadcast-refresh", result);
    const modelNames = extractModelNames(result);
    renderModelNames(modelNames);
    return { count: modelNames.length, modelNames };
  }

  saveButton.addEventListener("click", async () => {
    setButtonsDisabled(true);
    setStatus(t("savingApi"));
    try {
      const settings = await api.ipc.invoke("settings-write", {
        apiUrl: apiUrlInput.value,
        apiKey: apiKeyInput.value,
      });
      currentSettings = settings;
      const { count } = await refreshModels(t("savedRefreshing"));
      await loadSettings();
      setStatus(t("savedCount", count), "ok");
    } catch (error) {
      setStatus(error?.message || String(error), "error");
    } finally {
      setButtonsDisabled(false);
    }
  });

  refreshButton.addEventListener("click", async () => {
    setButtonsDisabled(true);
    try {
      const { count } = await refreshModels();
      setStatus(t("refreshedCount", count), "ok");
    } catch (error) {
      setStatus(error?.message || String(error), "error");
    } finally {
      setButtonsDisabled(false);
    }
  });

  modelSelect.addEventListener("change", () => {
    testResult.textContent = modelSelect.value ? t("currentSelection", modelSelect.value) : t("noModelToTest");
  });

  testButton.addEventListener("click", async () => {
    const model = trimString(modelSelect.value);
    if (!model) {
      setStatus(t("selectModel"), "error");
      return;
    }
    setButtonsDisabled(true);
    testResult.textContent = t("sendingHi", model);
    setStatus(t("testingModel"));
    try {
      const result = await api.ipc.invoke("test-model", {
        model,
        message: "hi",
        apiUrl: apiUrlInput.value,
        apiKey: apiKeyInput.value,
      });
      const answer = trimString(result?.assistantText) || t("emptyResponse");
      testResult.textContent = [
        t("resultModel", result.model),
        t("resultEndpoint", result.url),
        t("resultSent", result.message),
        t("resultReply", answer),
      ].join("\n");
      setStatus(t("testPassed"), "ok");
    } catch (error) {
      testResult.textContent = error?.message || String(error);
      setStatus(t("testFailed"), "error");
    } finally {
      setButtonsDisabled(false);
    }
  });

  rows.append(
    row(t("rowModelSource"), t("rowModelSourceDescription"), details),
    row(t("rowApiUrl"), t("rowApiUrlDescription"), inputStack([apiUrlInput])),
    row(t("rowApiKey"), t("rowApiKeyDescription"), inputStack([apiKeyInput])),
    row(t("rowActions"), t("rowActionsDescription"), actionButtons),
    row(t("rowTestModel"), t("rowTestModelDescription"), inputStack([modelSelect, testButton, testResult])),
  );
  root.append(page);
  void loadSettings();
  setButtonsDisabled(false);
}

module.exports = {
  start(api) {
    if (api.process === "main") {
      this._mainTeardown = startMain(api);
      return;
    }
    startRenderer(api);
  },
  stop() {
    try {
      this._mainTeardown?.();
    } catch {}
    this._mainTeardown = null;
    try {
      settingsHandle?.unregister?.();
    } catch {}
    settingsHandle = null;
  },
};


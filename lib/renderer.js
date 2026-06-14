"use strict";

const DEFAULT_REASONING_EFFORT = "medium";
const FALLBACK_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const SUPPORTED_REASONING_EFFORTS = new Set(FALLBACK_REASONING_EFFORTS);
const INSTANCE_KEY = "__codexppCustomModelsInstance";
const STATE_KEY = "__codexppCustomModelsState";
const modulePromises = new Map();
const REFRESH_MENU_ITEM_ATTR = "data-custom-models-refresh-item";
const MENU_OBSERVER_KEY = "__codexppCustomModelsMenuObserver";
const MODEL_MENU_ITEM_SELECTOR = "[data-model-selected], [role='menuitem'], [role='menuitemradio']";
const MENU_DIAGNOSTIC_KEY = "__codexppCustomModelsLastMenuDiagnosticAt";
const HIDDEN_UNKNOWN_MODEL_ATTR = "data-custom-models-hidden-unknown-model";

let currentApi = null;
let cachedModelList = null;
let cachedAt = 0;
let inFlight = null;

function cacheNormalizedModelList(payload) {
  const normalized = normalizeModelListPayload(payload);
  cachedModelList = normalized;
  cachedAt = Date.now();
  return normalized;
}

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

function getGlobalState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      patchInstalled: false,
      patchedBridges: new WeakSet(),
      patchedManagers: new WeakSet(),
      bridgeRestore: new WeakMap(),
      managerRestore: new WeakMap(),
      restoreCallbacks: [],
      warmupPromise: null,
      lastInstallFailure: "",
    };
  }
  if (!Array.isArray(globalThis[STATE_KEY].restoreCallbacks)) {
    globalThis[STATE_KEY].restoreCallbacks = [];
  }
  return globalThis[STATE_KEY];
}

function restoreCustomModelPatches() {
  const state = getGlobalState();
  const callbacks = state.restoreCallbacks.splice(0);
  for (const restore of callbacks.reverse()) {
    try {
      restore();
    } catch {}
  }
  state.patchedBridges = new WeakSet();
  state.patchedManagers = new WeakSet();
  state.bridgeRestore = new WeakMap();
  state.managerRestore = new WeakMap();
  state.patchInstalled = false;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReasoningEffort(value) {
  const normalized = trimString(value);
  return normalized.length > 0 ? normalized : DEFAULT_REASONING_EFFORT;
}

function normalizeReasoningEffortEntry(value) {
  const reasoningEffort =
    typeof value === "string"
      ? normalizeReasoningEffort(value)
      : normalizeReasoningEffort(value?.reasoningEffort);
  return {
    reasoningEffort,
    description:
      typeof value === "object" && value && trimString(value.description).length > 0
        ? trimString(value.description)
        : `${reasoningEffort} effort`,
  };
}

function compareReasoningEfforts(left, right) {
  const leftIndex = FALLBACK_REASONING_EFFORTS.indexOf(left.reasoningEffort);
  const rightIndex = FALLBACK_REASONING_EFFORTS.indexOf(right.reasoningEffort);
  return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
}

function normalizeSupportedReasoningEfforts(entry) {
  const values = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : Array.isArray(entry?.supported_reasoning_efforts)
      ? entry.supported_reasoning_efforts
      : Array.isArray(entry?.reasoningEfforts)
        ? entry.reasoningEfforts
        : Array.isArray(entry?.reasoning_efforts)
          ? entry.reasoning_efforts
          : null;

  if (!values || values.length === 0) {
    return FALLBACK_REASONING_EFFORTS.map(normalizeReasoningEffortEntry);
  }

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const next = normalizeReasoningEffortEntry(value);
    if (seen.has(next.reasoningEffort)) continue;
    seen.add(next.reasoningEffort);
    normalized.push(next);
  }

  return normalized.length > 0
    ? normalized
    : FALLBACK_REASONING_EFFORTS.map(normalizeReasoningEffortEntry);
}

function splitModelVariant(rawModel) {
  const normalized = trimString(rawModel);
  if (!normalized) return { model: "", variantReasoningEffort: "" };
  const separatorIndex = normalized.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
    return { model: normalized, variantReasoningEffort: "" };
  }
  const candidateEffort = trimString(normalized.slice(separatorIndex + 1));
  if (!SUPPORTED_REASONING_EFFORTS.has(candidateEffort)) {
    return { model: normalized, variantReasoningEffort: "" };
  }
  return {
    model: trimString(normalized.slice(0, separatorIndex)),
    variantReasoningEffort: candidateEffort,
  };
}

function normalizeModelEntry(entry, index) {
  const rawModel = trimString(entry?.model ?? entry?.id ?? entry?.name);
  const { model, variantReasoningEffort } = splitModelVariant(rawModel);
  if (!model) return null;

  const hasExplicitSupportedReasoningEfforts =
    Array.isArray(entry?.supportedReasoningEfforts) ||
    Array.isArray(entry?.supported_reasoning_efforts) ||
    Array.isArray(entry?.reasoningEfforts) ||
    Array.isArray(entry?.reasoning_efforts);
  const supportedReasoningEfforts = hasExplicitSupportedReasoningEfforts
    ? normalizeSupportedReasoningEfforts(entry)
    : variantReasoningEffort
      ? [normalizeReasoningEffortEntry(variantReasoningEffort)]
      : normalizeSupportedReasoningEfforts(entry);
  const defaultReasoningEffort = normalizeReasoningEffort(
    entry?.defaultReasoningEffort ??
      entry?.default_reasoning_effort ??
      supportedReasoningEfforts[0]?.reasoningEffort,
  );

  return {
    model,
    id: model,
    slug: model,
    name: model,
    displayName: trimString(entry?.displayName ?? entry?.display_name ?? model),
    hidden: Boolean(entry?.hidden),
    isDefault: Boolean(entry?.isDefault ?? entry?.is_default ?? index === 0),
    defaultReasoningEffort,
    supportedReasoningEfforts,
    inputModalities: Array.isArray(entry?.inputModalities)
      ? entry.inputModalities
      : Array.isArray(entry?.input_modalities)
        ? entry.input_modalities
        : null,
  };
}

function normalizeModelListPayload(payload) {
  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  const aggregatedModels = new Map();

  rawModels.forEach((entry, index) => {
    const normalizedEntry = normalizeModelEntry(entry, index);
    if (!normalizedEntry) return;

    const existing = aggregatedModels.get(normalizedEntry.model);
    if (!existing) {
      aggregatedModels.set(normalizedEntry.model, {
        ...normalizedEntry,
        supportedReasoningEfforts: [...normalizedEntry.supportedReasoningEfforts],
      });
      return;
    }

    existing.displayName = trimString(existing.displayName) || trimString(normalizedEntry.displayName);
    existing.hidden = existing.hidden && Boolean(normalizedEntry.hidden);
    existing.isDefault = existing.isDefault || Boolean(normalizedEntry.isDefault);
    existing.inputModalities ??= normalizedEntry.inputModalities;

    const seen = new Set(existing.supportedReasoningEfforts.map((item) => item.reasoningEffort));
    for (const item of normalizedEntry.supportedReasoningEfforts) {
      if (seen.has(item.reasoningEffort)) continue;
      seen.add(item.reasoningEffort);
      existing.supportedReasoningEfforts.push(item);
    }
  });

  const models = [...aggregatedModels.values()].map((entry) => {
    const supportedReasoningEfforts = [...entry.supportedReasoningEfforts].sort(compareReasoningEfforts);
    const fallbackDefaultReasoningEffort =
      supportedReasoningEfforts.find((item) => item.reasoningEffort === DEFAULT_REASONING_EFFORT)?.reasoningEffort ??
      supportedReasoningEfforts[0]?.reasoningEffort;
    return {
      model: entry.model,
      id: entry.model,
      slug: entry.model,
      name: entry.model,
      displayName: trimString(entry.displayName) || entry.model,
      hidden: Boolean(entry.hidden),
      isDefault: Boolean(entry.isDefault),
      defaultReasoningEffort: normalizeReasoningEffort(entry.defaultReasoningEffort ?? fallbackDefaultReasoningEffort),
      supportedReasoningEfforts:
        supportedReasoningEfforts.length > 0
          ? supportedReasoningEfforts
          : FALLBACK_REASONING_EFFORTS.map(normalizeReasoningEffortEntry),
      inputModalities: entry.inputModalities,
    };
  });

  const requestedDefaultModel = splitModelVariant(payload?.defaultModel ?? payload?.default_model).model;
  const defaultModel =
    models.find((entry) => entry.model === requestedDefaultModel) ||
    models.find((entry) => entry.isDefault) ||
    models[0] ||
    null;

  return {
    data: models.map((entry) => ({
      ...entry,
      isDefault: defaultModel != null && entry.model === defaultModel.model,
    })),
    has_more: false,
    next_cursor: null,
  };
}

async function fetchNormalizedModels(force = false) {
  if (!force && cachedModelList && Date.now() - cachedAt < 30_000) return cachedModelList;
  if (!force && inFlight) return inFlight;
  inFlight = currentApi.ipc.invoke("fetch-models", { force }).then((payload) => {
    const normalized = cacheNormalizedModelList(payload);
    currentApi.log.info("[custom-models] model list loaded", {
      count: Array.isArray(normalized?.data) ? normalized.data.length : 0,
      models: Array.isArray(normalized?.data) ? normalized.data.map((entry) => entry.model).slice(0, 30) : [],
    });
    return normalized;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchNormalizedModelsWithFallback({ force = false, fallback, meta = {} } = {}) {
  try {
    return await fetchNormalizedModels(force);
  } catch (error) {
    currentApi.log.warn("[custom-models] custom model fetch failed; falling back to native model list", {
      force,
      ...meta,
      message: error?.message || String(error),
    });
    if (typeof fallback !== "function") throw error;
    const payload = await fallback();
    const normalized = cacheNormalizedModelList(payload);
    currentApi.log.info("[custom-models] native model list fallback loaded", {
      force,
      ...meta,
      count: Array.isArray(normalized?.data) ? normalized.data.length : 0,
      models: Array.isArray(normalized?.data) ? normalized.data.map((entry) => entry.model).slice(0, 30) : [],
    });
    return normalized;
  }
}

function shouldInterceptModelListRequest(method, payload) {
  if (method === "model/list" || method === "list-models-for-host") {
    return true;
  }
  return method === "send-cli-request-for-host" && payload?.method === "model/list";
}

function extractHostId(method, payload) {
  if (method === "send-cli-request-for-host") {
    return trimString(payload?.params?.hostId ?? payload?.hostId) || "local";
  }
  return trimString(payload?.hostId) || "local";
}

function modelListQueryKeyPrefix() {
  return ["models", "list"];
}

function getQueryKey(query) {
  return Array.isArray(query?.queryKey)
    ? query.queryKey
    : Array.isArray(query?.options?.queryKey)
      ? query.options.queryKey
      : null;
}

async function warmupModelList() {
  const state = getGlobalState();
  if (cachedModelList && Date.now() - cachedAt < 30_000) {
    return cachedModelList;
  }
  if (state.warmupPromise) return state.warmupPromise;
  state.warmupPromise = fetchNormalizedModels(false).finally(() => {
    state.warmupPromise = null;
  });
  return state.warmupPromise;
}

function codexAppAssetUrl(namePart) {
  const urls = [
    ...Array.from(document.scripts || []).map((script) => script.src),
    ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
    ...performance.getEntriesByType("resource").map((entry) => entry.name),
  ].filter(Boolean);
  return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
}

function findAllReactRoots() {
  const roots = [];
  for (const node of Array.from(document.querySelectorAll("body, body *"))) {
    for (const key of Object.keys(node || {})) {
      if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
        roots.push(node);
        break;
      }
    }
  }
  return roots;
}

function getFiber(node) {
  if (currentApi?.react?.getFiber) {
    try {
      return currentApi.react.getFiber(node);
    } catch {}
  }
  for (const key of Object.keys(node || {})) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
      return node[key] || null;
    }
  }
  return null;
}

function walkFiberTree(fiber, visit, seen = new Set()) {
  if (!fiber || seen.has(fiber)) return;
  seen.add(fiber);
  visit(fiber);
  walkFiberTree(fiber.child, visit, seen);
  walkFiberTree(fiber.sibling, visit, seen);
}

function looksLikeQueryClient(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.getQueryCache === "function" &&
      (typeof value.removeQueries === "function" ||
        typeof value.invalidateQueries === "function" ||
        typeof value.resetQueries === "function"),
  );
}

function collectQueryClientCandidates(value, seen, queryClients, depth = 0) {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
  seen.add(value);

  if (looksLikeQueryClient(value)) {
    queryClients.add(value);
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) {
      collectQueryClientCandidates(item, seen, queryClients, depth + 1);
    }
    return;
  }

  for (const key of Object.keys(value).slice(0, 80)) {
    if (/^_|fiber|return|child|sibling|stateNode|alternate/i.test(key)) continue;
    try {
      collectQueryClientCandidates(value[key], seen, queryClients, depth + 1);
    } catch {}
  }
}

function discoverQueryClients() {
  const queryClients = new Set();
  for (const node of findAllReactRoots()) {
    const rootFiber = getFiber(node);
    walkFiberTree(rootFiber, (fiber) => {
      collectQueryClientCandidates(fiber.memoizedProps, new WeakSet(), queryClients);
      collectQueryClientCandidates(fiber.memoizedState, new WeakSet(), queryClients);
      collectQueryClientCandidates(fiber.stateNode, new WeakSet(), queryClients);
    });
  }
  return [...queryClients];
}

function looksLikeCodexManager(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.sendRequest === "function" &&
      (typeof value.getHostId === "function" ||
        typeof value.getConversation === "function" ||
        typeof value.addTurnCompletedListener === "function" ||
        typeof value.resumeConversationForUnavailableOwner === "function"),
  );
}

function looksLikeAppServerRegistry(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.getAll === "function" &&
      (typeof value.getImplForHostId === "function" ||
        typeof value.getForHostId === "function" ||
        typeof value.getMaybeForConversationId === "function"),
  );
}

function collectManagerCandidates(value, seen, managers, registries, depth = 0) {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
  seen.add(value);

  if (looksLikeCodexManager(value)) {
    managers.add(value);
  }

  if (looksLikeAppServerRegistry(value)) {
    registries.add(value);
    try {
      const items = value.getAll();
      if (Array.isArray(items)) {
        for (const manager of items) {
          if (looksLikeCodexManager(manager)) managers.add(manager);
        }
      }
    } catch {}
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) {
      collectManagerCandidates(item, seen, managers, registries, depth + 1);
    }
    return;
  }

  for (const key of Object.keys(value).slice(0, 100)) {
    if (/^_|fiber|return|child|sibling|stateNode|alternate/i.test(key)) continue;
    try {
      collectManagerCandidates(value[key], seen, managers, registries, depth + 1);
    } catch {}
  }
}

function discoverManagersAndRegistries() {
  const managers = new Set();
  const registries = new Set();
  for (const node of findAllReactRoots()) {
    const rootFiber = getFiber(node);
    walkFiberTree(rootFiber, (fiber) => {
      collectManagerCandidates(fiber.memoizedProps, new WeakSet(), managers, registries);
      collectManagerCandidates(fiber.memoizedState, new WeakSet(), managers, registries);
      collectManagerCandidates(fiber.stateNode, new WeakSet(), managers, registries);
    });
  }
  return { managers: [...managers], registries: [...registries] };
}

async function replaceModelListQueries(reason, normalized = cachedModelList) {
  const queryClients = discoverQueryClients();
  if (queryClients.length === 0) {
    currentApi.log.info("[custom-models] model cache replace skipped", { reason, queryClientCount: 0 });
    return;
  }
  if (!normalized || !Array.isArray(normalized.data)) {
    currentApi.log.warn("[custom-models] model cache replace skipped: no normalized model list", { reason });
    return;
  }

  const queryKey = modelListQueryKeyPrefix();
  const summaries = [];
  for (const queryClient of queryClients) {
    try {
      const queryCache = queryClient.getQueryCache?.();
      if (typeof queryClient.cancelQueries === "function") {
        await queryClient.cancelQueries({ queryKey });
      }
      const queries = typeof queryCache?.findAll === "function"
        ? queryCache.findAll({ queryKey })
        : [];
      const keys = queries.map(getQueryKey).filter(Boolean);
      let setCount = 0;
      for (const key of keys) {
        if (typeof queryClient.setQueryData !== "function") continue;
        queryClient.setQueryData(key, normalized);
        setCount += 1;
      }
      summaries.push({
        queryCount: keys.length,
        setCount,
        sampleKeys: keys.slice(0, 5),
      });
    } catch (error) {
      summaries.push({ error: error?.message || String(error) });
    }
  }

  currentApi.log.info("[custom-models] model cache replaced from url", {
    reason,
    queryClientCount: queryClients.length,
    modelCount: normalized.data.length,
    models: normalized.data.map((entry) => entry.model).slice(0, 30),
    summaries,
  });
}

async function loadCodexAppModule(namePart) {
  if (!modulePromises.has(namePart)) {
    const promise = Promise.resolve().then(async () => {
      const url = codexAppAssetUrl(namePart);
      if (!url) throw new Error(`Codex App asset not found: ${namePart}`);
      return await import(url);
    }).catch((error) => {
      modulePromises.delete(namePart);
      throw error;
    });
    modulePromises.set(namePart, promise);
  }
  return modulePromises.get(namePart);
}

function findRequestBridgeExport(hostModule) {
  const matches = [];
  for (const [key, value] of Object.entries(hostModule || {})) {
    if (!value || typeof value !== "object") continue;
    if (typeof value.sendRequest !== "function") continue;
    if (typeof value.setMessageHandler !== "function") continue;
    matches.push({ key, value });
  }
  return matches;
}

async function patchDiscoveredManagers() {
  const state = getGlobalState();
  const { managers, registries } = discoverManagersAndRegistries();
  let patchedCount = 0;

  for (const manager of managers) {
    if (!manager || state.patchedManagers.has(manager)) continue;

    const originalSendRequest = manager.sendRequest;
    if (typeof originalSendRequest !== "function") continue;

    const patchedSendRequest = async function onCustomModelsManagerSendRequest(method, payload, options) {
      if (shouldInterceptModelListRequest(method, payload)) {
        const hostId = trimString(
          this?.getHostId?.() ??
          payload?.hostId ??
          payload?.params?.hostId,
        ) || "local";
        currentApi.log.info("[custom-models] intercept manager model list request", {
          method,
          hostId,
          nestedMethod: trimString(payload?.method),
          source: "manager-sendRequest",
        });
        return fetchNormalizedModelsWithFallback({
          force: false,
          meta: {
            hostId,
            method,
            nestedMethod: trimString(payload?.method),
            source: "manager-sendRequest",
          },
          fallback: () => originalSendRequest.call(this, method, payload, options),
        });
      }
      return originalSendRequest.call(this, method, payload, options);
    };
    manager.sendRequest = patchedSendRequest;

    state.patchedManagers.add(manager);
    state.managerRestore.set(manager, originalSendRequest);
    state.restoreCallbacks.push(() => {
      if (manager.sendRequest === patchedSendRequest) {
        manager.sendRequest = originalSendRequest;
      }
    });
    patchedCount += 1;
  }

  currentApi.log.info("[custom-models] manager patch scan", {
    managerCount: managers.length,
    registryCount: registries.length,
    patchedCount,
    hostIds: managers.map((manager) => trimString(manager?.getHostId?.()) || null).slice(0, 20),
  });
}

async function installAppServerPatch() {
  const state = getGlobalState();
  const hostModule = await loadCodexAppModule("app-server-manager-signals-");
  const bridgeExports = findRequestBridgeExport(hostModule);
  if (bridgeExports.length === 0) {
    throw new Error("app-server-manager-signals bridge export not found");
  }

  let patchedCount = 0;
  for (const bridgeExport of bridgeExports) {
    const bridge = bridgeExport.value;
    if (!bridge) continue;

    if (state.patchedBridges.has(bridge)) {
      patchedCount += 1;
      continue;
    }

    const originalSendRequest = bridge.sendRequest;
    if (typeof originalSendRequest !== "function") continue;

    const patchedSendRequest = async (method, payload) => {
      if (shouldInterceptModelListRequest(method, payload)) {
        const hostId = extractHostId(method, payload);
        currentApi.log.info("[custom-models] intercept model list request", {
          method,
          hostId,
          includeHidden: payload?.includeHidden,
          limit: payload?.limit,
        });
        return fetchNormalizedModelsWithFallback({
          force: false,
          meta: {
            hostId,
            method,
            includeHidden: payload?.includeHidden,
            limit: payload?.limit,
            source: "appserver-bridge",
          },
          fallback: () => originalSendRequest(method, payload),
        });
      }
      return originalSendRequest(method, payload);
    };
    bridge.sendRequest = patchedSendRequest;

    state.patchedBridges.add(bridge);
    state.bridgeRestore.set(bridge, originalSendRequest);
    state.restoreCallbacks.push(() => {
      if (bridge.sendRequest === patchedSendRequest) {
        bridge.sendRequest = originalSendRequest;
      }
    });
    patchedCount += 1;
  }

  state.patchInstalled = state.patchInstalled || patchedCount > 0;
  currentApi.log.info("[custom-models] appserver patch scan", {
    exportCount: Object.keys(hostModule || {}).length,
    candidateCount: bridgeExports.length,
    patchedCount,
    bridgeExportKeys: bridgeExports.map((entry) => entry.key),
  });
  if (!state.patchInstalled) {
    throw new Error("app-server-manager-signals bridge patch unavailable");
  }
}

function refreshLabel() {
  return currentLanguage() === "zh" ? "刷新" : "Refresh";
}

function knownModelLabels() {
  const entries = Array.isArray(cachedModelList?.data) ? cachedModelList.data : [];
  const labels = new Set();
  for (const entry of entries) {
    for (const value of [entry?.model, entry?.id, entry?.slug, entry?.name, entry?.displayName]) {
      const label = trimString(value);
      if (label) labels.add(label.toLowerCase());
    }
  }
  return labels;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKnownModelLabel(text, labels = knownModelLabels()) {
  const normalizedText = trimString(text).toLowerCase();
  if (!normalizedText) return false;
  for (const label of labels) {
    if (!label) continue;
    const normalizedLabel = trimString(label).toLowerCase();
    if (!normalizedLabel) continue;
    const pattern = new RegExp(`(^|[^a-z0-9._-])${escapeRegExp(normalizedLabel)}($|[^a-z0-9._-])`, "i");
    if (pattern.test(normalizedText)) return true;
  }
  return false;
}

function looksLikeVersionedModelName(text) {
  const normalizedText = trimString(text).toLowerCase();
  if (!normalizedText) return false;
  return /\b\d+(?:\.\d+)+(?:[-_\s]?(?:mini|codex|turbo|preview|latest|fast|thinking|nano|pro|max))?\b/i
    .test(normalizedText);
}

function looksLikeModelMenuItem(node, labels = knownModelLabels()) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.hasAttribute("data-model-selected")) return true;
  const text = trimString(node.textContent).toLowerCase();
  if (!text) return false;
  if (hasKnownModelLabel(text, labels)) return true;
  if (/\b(?:gpt|claude|gemini|qwen|deepseek|kimi|llama|codex|o\d)\b/i.test(text)) return true;
  return looksLikeVersionedModelName(text);
}

function isKnownModelMenuItem(node, labels = knownModelLabels()) {
  const text = trimString(node?.textContent).toLowerCase();
  return hasKnownModelLabel(text, labels);
}

function isRefreshMenuItem(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.hasAttribute(REFRESH_MENU_ITEM_ATTR)) return true;
  const text = trimString(node.textContent).toLowerCase();
  return text === "refresh" || text === "刷新";
}

function findModelMenuContainer(item) {
  let node = item?.parentElement || null;
  const labels = knownModelLabels();
  let matched = null;
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const modelItems = Array.from(node.querySelectorAll?.(MODEL_MENU_ITEM_SELECTOR) || [])
      .filter((candidate) => looksLikeModelMenuItem(candidate, labels));
    const role = trimString(node.getAttribute?.("role"));
    if (modelItems.length > 0 && (role === "menu" || role === "listbox" || modelItems.length > 1)) {
      matched = node;
    }
  }
  return matched || item?.parentElement || null;
}

async function refreshModelsFromMenu() {
  currentApi.log.info("[custom-models] menu refresh requested");
  const payload = await currentApi.ipc.invoke("fetch-models", { force: true });
  const normalized = cacheNormalizedModelList(payload);
  await replaceModelListQueries("menu-refresh", normalized);
  window.dispatchEvent(new CustomEvent("codexpp-custom-models-refresh", { detail: payload }));
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
}

function findMenuTitleNode(container) {
  const candidates = Array.from(container.querySelectorAll("*"));
  return candidates.find((node) => {
    const text = trimString(node.textContent).toLowerCase();
    return text === "model" || text === "模型";
  }) || null;
}

function cloneRefreshMenuItem(referenceItem) {
  const item = referenceItem.cloneNode(true);
  item.setAttribute(REFRESH_MENU_ITEM_ATTR, "true");
  item.removeAttribute("data-model-selected");
  item.removeAttribute("aria-checked");
  item.removeAttribute("data-state");
  item.removeAttribute("data-highlighted");
  const rightIcon = item.querySelector("svg, [data-slot='right-icon']");
  rightIcon?.remove?.();
  const textTarget = Array.from(item.querySelectorAll("*")).find((node) => trimString(node.textContent).length > 0) || item;
  textTarget.textContent = refreshLabel();
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void refreshModelsFromMenu().catch((error) => {
      currentApi.log.warn("[custom-models] menu refresh failed", {
        message: error?.message || String(error),
      });
    });
  });
  return item;
}

function ensureRefreshMenuItem(container) {
  if (!container || container.querySelector(`[${REFRESH_MENU_ITEM_ATTR}]`)) return;
  const labels = knownModelLabels();
  const modelItems = Array.from(container.querySelectorAll(MODEL_MENU_ITEM_SELECTOR))
    .filter((item) => looksLikeModelMenuItem(item, labels));
  if (modelItems.length === 0) return;
  const refreshItem = cloneRefreshMenuItem(modelItems[0]);
  const titleNode = findMenuTitleNode(container);
  if (titleNode?.parentElement === container) {
    container.insertBefore(refreshItem, titleNode.nextSibling);
    currentApi.log.info("[custom-models] model menu refresh item inserted", {
      itemCount: modelItems.length,
      position: "after-title",
      sample: trimString(modelItems[0]?.textContent).slice(0, 80),
    });
    return;
  }
  container.insertBefore(refreshItem, modelItems[0]);
  currentApi.log.info("[custom-models] model menu refresh item inserted", {
    itemCount: modelItems.length,
    position: "before-first-model",
    sample: trimString(modelItems[0]?.textContent).slice(0, 80),
  });
}

function hideUnknownModelMenuItems(container) {
  if (!container) return;
  const labels = knownModelLabels();
  if (labels.size === 0) return;
  const candidates = Array.from(container.querySelectorAll(MODEL_MENU_ITEM_SELECTOR));
  let hiddenCount = 0;
  const hiddenSamples = [];
  for (const item of candidates) {
    if (isRefreshMenuItem(item)) continue;
    if (!looksLikeModelMenuItem(item, labels)) continue;
    if (isKnownModelMenuItem(item, labels)) continue;
    item.setAttribute(HIDDEN_UNKNOWN_MODEL_ATTR, "true");
    item.setAttribute("aria-hidden", "true");
    item.style.display = "none";
    hiddenCount += 1;
    if (hiddenSamples.length < 10) hiddenSamples.push(trimString(item.textContent).slice(0, 80));
  }
  if (hiddenCount > 0) {
    currentApi.log.info("[custom-models] unknown model menu items hidden", {
      hiddenCount,
      allowedModels: [...labels].slice(0, 20),
      samples: hiddenSamples,
    });
  }
}

function patchVisibleModelMenus() {
  const labels = knownModelLabels();
  const candidates = Array.from(document.querySelectorAll(MODEL_MENU_ITEM_SELECTOR));
  const modelItems = candidates.filter((item) => looksLikeModelMenuItem(item, labels));
  if (candidates.length > 0 || modelItems.length > 0) {
    const now = Date.now();
    const last = Number(window[MENU_DIAGNOSTIC_KEY] || 0);
    if (now - last > 2000) {
      window[MENU_DIAGNOSTIC_KEY] = now;
      currentApi.log.info("[custom-models] model menu scan", {
        candidateCount: candidates.length,
        modelItemCount: modelItems.length,
        labelCount: labels.size,
        selectedCount: document.querySelectorAll("[data-model-selected]").length,
        sample: candidates.slice(0, 8).map((item) => ({
          role: trimString(item.getAttribute?.("role")),
          selected: trimString(item.getAttribute?.("data-model-selected")),
          text: trimString(item.textContent).slice(0, 80),
        })),
      });
    }
  }
  for (const item of modelItems) {
    const container = findModelMenuContainer(item);
    if (!container) continue;
    hideUnknownModelMenuItems(container);
    ensureRefreshMenuItem(container);
  }
}

function installMenuRefreshObserver() {
  if (window[MENU_OBSERVER_KEY]) return window[MENU_OBSERVER_KEY];
  patchVisibleModelMenus();
  const observer = new MutationObserver(() => {
    patchVisibleModelMenus();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  window[MENU_OBSERVER_KEY] = observer;
  return observer;
}

function startCustomModelsRenderer(api) {
  try {
    globalThis[INSTANCE_KEY]?.teardown?.();
  } catch {}

  currentApi = api;

  const onRefresh = (event) => {
    cachedModelList = event?.detail ? normalizeModelListPayload(event.detail) : null;
    cachedAt = cachedModelList ? Date.now() : 0;
    void replaceModelListQueries("settings-refresh", cachedModelList);
  };

  window.addEventListener("codexpp-custom-models-refresh", onRefresh);
  const menuObserver = installMenuRefreshObserver();

  const retryTimers = [];
  const installFailures = new Set();
  let active = true;
  const scheduleInstall = (delayMs) => {
    const timer = window.setTimeout(() => {
      if (!active) return;
      Promise.allSettled([
        installAppServerPatch(),
        patchDiscoveredManagers(),
      ]).then((results) => {
        if (!active) {
          restoreCustomModelPatches();
          return;
        }
        for (const result of results) {
          if (result.status !== "rejected") continue;
          const message = result.reason?.message || String(result.reason);
          if (!installFailures.has(message)) {
            installFailures.add(message);
            currentApi.log.warn("[custom-models] patch install failed", { message });
          }
        }
      });
    }, delayMs);
    retryTimers.push(timer);
  };

  for (const delayMs of [0, 800, 2500, 5000]) {
    scheduleInstall(delayMs);
  }

  const warmupTimer = window.setTimeout(() => {
    warmupModelList().catch((error) => {
      currentApi.log.warn("[custom-models] warmup failed", {
        message: error?.message || String(error),
      });
    }).then((normalized) => {
      void replaceModelListQueries("warmup", normalized);
    });
  }, 1200);
  retryTimers.push(warmupTimer);

  const teardown = () => {
    active = false;
    window.removeEventListener("codexpp-custom-models-refresh", onRefresh);
    try {
      menuObserver?.disconnect?.();
    } catch {}
    if (window[MENU_OBSERVER_KEY] === menuObserver) {
      delete window[MENU_OBSERVER_KEY];
    }
    for (const timer of retryTimers) window.clearTimeout(timer);
    restoreCustomModelPatches();
    if (globalThis[INSTANCE_KEY]?.teardown === teardown) {
      delete globalThis[INSTANCE_KEY];
    }
  };

  globalThis[INSTANCE_KEY] = { teardown };
  return teardown;
}

module.exports = {
  startCustomModelsRenderer,
  normalizeModelListPayload,
};

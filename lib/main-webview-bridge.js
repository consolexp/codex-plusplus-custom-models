"use strict";

const RPC_PREFIX = "__CODEXPP_CUSTOM_MODELS_RPC__";
const LOG_PREFIX = "__CODEXPP_CUSTOM_MODELS_LOG__";
const RESPONSE_EVENT = "__codexpp_custom_models_rpc_response__";
const GLOBAL_KEY = "__codexpp_custom_models_webview_bridge__";
const BRIDGE_VERSION = 2;

function createMainWebviewBridge(options) {
  const api = options.api;
  const readRendererBundle = options.readRendererBundle;
  const handleRpc = options.handleRpc;
  const state = globalThis[GLOBAL_KEY] || {
    attached: new Map(),
    listenerRegistered: false,
    webContentsCreatedListener: null,
    lastInjectLogAtById: new Map(),
    retryTimersById: new Map(),
  };
  if (!(state.attached instanceof Map)) state.attached = new Map();
  if (!(state.lastInjectLogAtById instanceof Map)) state.lastInjectLogAtById = new Map();
  if (!(state.retryTimersById instanceof Map)) state.retryTimersById = new Map();
  state.listenerRegistered = Boolean(state.listenerRegistered);
  for (const timer of state.retryTimersById.values()) {
    clearTimeout(timer);
  }
  state.retryTimersById.clear();
  for (const attached of state.attached.values()) {
    try {
      attached.dispose?.();
    } catch {}
  }
  state.attached.clear();
  state.generation = Number(state.generation || 0) + 1;
  const generation = state.generation;
  globalThis[GLOBAL_KEY] = state;

  function isCandidateWebContents(wc) {
    if (!wc || wc.isDestroyed?.()) return false;
    const url = String(wc.getURL?.() || "");
    if (!url) return true;
    return url.startsWith("app://") || url.includes("codex") || url.includes("localhost");
  }

  function sendResponse(wc, id, payload) {
    if (!id || !wc || wc.isDestroyed?.()) return;
    const detail = JSON.stringify({ id, ...payload });
    wc.executeJavaScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(RESPONSE_EVENT)}, { detail: ${detail} }));`,
      true,
    ).catch(() => {});
  }

  async function handleConsoleMessage(wc, rawMessage) {
    const message = String(rawMessage || "");
    if (message.startsWith(LOG_PREFIX)) {
      try {
        const entry = JSON.parse(message.slice(LOG_PREFIX.length));
        const args = Array.isArray(entry.args) ? entry.args : [];
        const level = entry.level === "warn" ? "warn" : "info";
        api.log[level](`[custom-models:webview] ${args.map(formatLogArg).join(" ")}`);
      } catch {
        api.log.info(message);
      }
      return;
    }
    if (!message.startsWith(RPC_PREFIX)) return;

    let request;
    try {
      request = JSON.parse(message.slice(RPC_PREFIX.length));
    } catch (error) {
      api.log.warn("[custom-models] webview RPC parse failed", error?.message || String(error));
      return;
    }

    const id = String(request?.id || "");
    const channel = String(request?.channel || "");
    const args = Array.isArray(request?.args) ? request.args : [];
    try {
      const result = await handleRpc(channel, args);
      sendResponse(wc, id, { ok: true, result });
    } catch (error) {
      api.log.warn("[custom-models] webview RPC error", {
        channel,
        error: error?.message || String(error),
      });
      sendResponse(wc, id, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  function attach(wc) {
    if (!isCandidateWebContents(wc)) return;
    if (state.attached.has(wc)) return;

    const onConsoleMessage = (...eventArgs) => {
      const message = extractConsoleMessage(eventArgs);
      handleConsoleMessage(wc, message).catch((error) => {
        api.log.warn("[custom-models] webview RPC failed", error?.message || String(error));
      });
    };
    const injectSoon = () => {
      setTimeout(() => {
        if (state.generation !== generation) return;
        inject(wc).catch(() => {});
      }, 250);
    };

    wc.on("console-message", onConsoleMessage);
    wc.on("dom-ready", injectSoon);
    wc.on("did-finish-load", injectSoon);
    state.attached.set(wc, {
      dispose() {
        try {
          wc.off("console-message", onConsoleMessage);
          wc.off("dom-ready", injectSoon);
          wc.off("did-finish-load", injectSoon);
        } catch {}
      },
    });
    injectSoon();
  }

  async function inject(wc) {
    if (state.generation !== generation) return;
    if (!isCandidateWebContents(wc)) return;
    const bundleSource = String(readRendererBundle() || "");
    if (!bundleSource.trim()) {
      throw new Error("Custom Models renderer bundle is empty.");
    }
    const smokeScript = buildSmokeScript();
    const script = buildInjectionScript(bundleSource);
    const id = typeof wc.id === "number" ? wc.id : String(wc.getURL?.() || "unknown");
    api.log.info("[custom-models] webview bridge inject begin", {
      id,
      url: String(wc.getURL?.() || ""),
      sourceLength: bundleSource.length,
      scriptLength: script.length,
    });

    try {
      const probe = await withTimeout(
        wc.executeJavaScript("(() => ({ ok: true, href: location.href, title: document.title }))()", true),
        5000,
        "probe timed out",
      );
      api.log.info("[custom-models] webview bridge probe result", { id, probe });
      const smoke = await withTimeout(
        wc.executeJavaScript(smokeScript, true),
        5000,
        "smoke timed out",
      );
      api.log.info("[custom-models] webview bridge smoke result", { id, smoke });
      api.log.info("[custom-models] webview bridge loader dispatch", { id, scriptLength: script.length });
      try {
        const promise = wc.executeJavaScript(script, true);
        api.log.info("[custom-models] webview bridge loader promise created", { id });
        Promise.resolve(promise).then(
          (result) => {
            logInjectResult(wc, result || { ok: true, returned: true });
            if (result?.ok !== true) scheduleRetry(wc);
          },
          (error) => {
            logInjectResult(wc, { ok: false, error: error?.message || String(error) });
            scheduleRetry(wc, error);
          },
        );
      } catch (error) {
        logInjectResult(wc, { ok: false, error: error?.message || String(error) });
        scheduleRetry(wc, error);
      }
      logInjectResult(wc, { ok: true, scheduled: true, href: probe?.href || "" });
    } catch (error) {
      logInjectResult(wc, { ok: false, error: error?.message || String(error) });
      scheduleRetry(wc, error);
    }
  }

  function scheduleRetry(wc) {
    if (state.generation !== generation) return;
    if (!wc || wc.isDestroyed?.()) return;
    const id = typeof wc.id === "number" ? wc.id : String(wc.getURL?.() || "unknown");
    if (state.retryTimersById.has(id)) return;
    const timer = setTimeout(() => {
      state.retryTimersById.delete(id);
      if (state.generation !== generation) return;
      inject(wc).catch(() => {});
    }, 5000);
    state.retryTimersById.set(id, timer);
  }

  function logInjectResult(wc, result) {
    const id = typeof wc.id === "number" ? wc.id : String(wc.getURL?.() || "unknown");
    const now = Date.now();
    const previous = Number(state.lastInjectLogAtById.get(id) || 0);
    const ok = result?.ok === true;
    const scheduled = result?.scheduled === true;
    const alreadyStarted = result?.alreadyStarted === true;
    if (ok && alreadyStarted && now - previous < 60_000) return;
    state.lastInjectLogAtById.set(id, now);
    api.log[ok ? "info" : "warn"]("[custom-models] webview bridge inject result", {
      id,
      ok,
      scheduled,
      alreadyStarted,
      href: String(result?.href || wc.getURL?.() || ""),
      error: String(result?.error || ""),
      stack: String(result?.stack || "").slice(0, 1200),
    });
  }

  function dispatchCustomEvent(eventName, detail) {
    const detailJson = JSON.stringify(detail ?? null);
    const script =
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${detailJson} }));`;
    for (const wc of state.attached.keys()) {
      if (!isCandidateWebContents(wc)) continue;
      wc.executeJavaScript(script, true).catch(() => {});
    }
  }

  function start() {
    const { app, webContents } = require("electron");
    for (const wc of webContents.getAllWebContents()) attach(wc);
    if (!state.listenerRegistered) {
      state.webContentsCreatedListener = (_event, wc) => {
        globalThis[GLOBAL_KEY]?.attach?.(wc);
      };
      app.on("web-contents-created", state.webContentsCreatedListener);
      state.listenerRegistered = true;
    }
    state.attach = attach;
    api.log.info("[custom-models] webview bridge active.");
  }

  function dispose() {
    state.generation = Number(state.generation || 0) + 1;
    for (const timer of state.retryTimersById.values()) {
      clearTimeout(timer);
    }
    state.retryTimersById.clear();
    for (const [wc, attached] of state.attached.entries()) {
      attached.dispose();
      state.attached.delete(wc);
    }
    try {
      const { app } = require("electron");
      if (state.webContentsCreatedListener) {
        app.off("web-contents-created", state.webContentsCreatedListener);
      }
    } catch {}
    state.webContentsCreatedListener = null;
    state.listenerRegistered = false;
    delete state.attach;
    if (globalThis[GLOBAL_KEY] === state) {
      delete globalThis[GLOBAL_KEY];
    }
  }

  return {
    dispose,
    dispatchCustomEvent,
    start,
  };
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractConsoleMessage(eventArgs) {
  for (let index = eventArgs.length - 1; index >= 0; index -= 1) {
    const value = eventArgs[index];
    if (typeof value === "string" && (value.startsWith(RPC_PREFIX) || value.startsWith(LOG_PREFIX))) {
      return value;
    }
  }
  const maybeMessage = eventArgs.find((value) => typeof value === "string");
  return maybeMessage || "";
}

function withTimeout(promise, timeoutMs, message) {
  let timerId = null;
  return new Promise((resolve, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timerId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timerId);
        reject(error);
      },
    );
  });
}

function buildSmokeScript() {
  return `
(() => {
  const LOG_PREFIX = ${JSON.stringify(LOG_PREFIX)};
  try {
    console.info(LOG_PREFIX + JSON.stringify({
      level: "info",
      args: ["[custom-models] webview smoke", location.href, document.title],
    }));
  } catch {}
  return { ok: true, smoke: true, href: location.href, title: document.title };
})()
`;
}

function buildInjectionScript(bundleSource) {
  const loaderSource = `
  const RESPONSE_EVENT = ${JSON.stringify(RESPONSE_EVENT)};
  const RPC_PREFIX = ${JSON.stringify(RPC_PREFIX)};
  const LOG_PREFIX = ${JSON.stringify(LOG_PREFIX)};
  const BRIDGE_VERSION = ${BRIDGE_VERSION};
  const BUNDLE_SOURCE_LENGTH = ${bundleSource.length};

  if (window.__codexppCustomModelsBridge?.started) {
    if (
      window.__codexppCustomModelsBridge.version === BRIDGE_VERSION &&
      window.__codexppCustomModelsBridge.bundleLength === BUNDLE_SOURCE_LENGTH &&
      !window.__codexppCustomModelsBridge.error
    ) {
      return { ok: true, alreadyStarted: true, href: location.href };
    }
    try { window.__codexppCustomModelsBridge.dispose?.(); } catch {}
  }

  const pending = new Map();
  let nextRequestId = 1;

  const serializeArg = (value) => {
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  const emitLog = (level, args) => {
    try {
      console[level === "warn" ? "warn" : "info"](
        LOG_PREFIX + JSON.stringify({ level, args: Array.from(args).map(serializeArg) }),
      );
    } catch {}
  };

  const onResponse = (event) => {
    const detail = event?.detail || {};
    const id = String(detail.id || "");
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    window.clearTimeout(entry.timer);
    if (detail.ok) entry.resolve(detail.result);
    else entry.reject(new Error(detail.error || "Custom Models RPC failed."));
  };
  window.addEventListener(RESPONSE_EVENT, onResponse);

  const ipc = {
    invoke(channel, ...args) {
      const id = "custom-models-rpc-" + Date.now() + "-" + nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error("Custom Models RPC timed out: " + channel));
        }, 120000);
        pending.set(id, { resolve, reject, timer });
        console.info(RPC_PREFIX + JSON.stringify({ id, channel, args }));
      });
    },
  };

  const react = {
    getFiber(node) {
      if (!node || typeof node !== "object") return null;
      for (const key of Object.keys(node)) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
          return node[key] || null;
        }
      }
      return null;
    },
  };

  const api = {
    ipc,
    react,
    log: {
      info: (...args) => emitLog("info", args),
      warn: (...args) => emitLog("warn", args),
    },
  };

  window.__codexppCustomModelsBridge = {
    started: true,
    loading: true,
    version: BRIDGE_VERSION,
    bundleLength: BUNDLE_SOURCE_LENGTH,
    disposeRenderer: null,
    dispose() {
      try { this.disposeRenderer?.(); } catch {}
      window.removeEventListener(RESPONSE_EVENT, onResponse);
      for (const entry of pending.values()) window.clearTimeout(entry.timer);
      pending.clear();
      this.started = false;
    },
  };

  api.log.info("[custom-models] webview loader installed", location.href, "v" + BRIDGE_VERSION);
  window.setTimeout(() => {
    try {
      api.log.info("[custom-models] webview loader timer fired");
      const module = { exports: {} };
      const exports = module.exports;
      ${bundleSource}
      ;
      api.log.info("[custom-models] webview bundle evaluated");
      const rendererEntry = module.exports?.startCustomModelsRenderer;
      if (typeof rendererEntry !== "function") {
        throw new Error("Custom Models renderer did not export startCustomModelsRenderer.");
      }
      window.__codexppCustomModelsBridge.disposeRenderer = rendererEntry(api);
      window.__codexppCustomModelsBridge.loading = false;
      api.log.info("[custom-models] webview renderer started", location.href);
    } catch (error) {
      window.__codexppCustomModelsBridge.loading = false;
      window.__codexppCustomModelsBridge.error = error?.message || String(error);
      api.log.warn(
        "[custom-models] webview renderer failed",
        error?.message || String(error),
        typeof error?.stack === "string" ? error.stack : "",
      );
    }
  }, 0);
  return { ok: true, scheduled: true, href: location.href };
`;
  return `
(() => {
  try {
    ${loaderSource}
  } catch (error) {
    return {
      ok: false,
      href: location.href,
      error: error?.message || String(error),
      stack: typeof error?.stack === "string" ? error.stack : "",
    };
  }
})()
`;
}

module.exports = {
  createMainWebviewBridge,
};

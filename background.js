import {
  ACTIONS,
  askAIQuestion,
  callAI,
  fetchContextualWordSuggestions,
  fetchSentenceSuggestions,
  getSettings,
  resolveProviderConfig
} from "./shared/actions.js";

const PARENT_MENU_ID = "text-ai-tools-root";

export const CONTENT_SCRIPT_FILES = [
  "content/language-registry.js",
  "content/morphology-tr.js",
  "content/deasciifier-tr.js",
  "content/personal-model.js",
  "content/spellcheck-engine.js",
  "content/undo-manager.js",
  "content/dom-editor.js",
  "content.js"
];

const lexiconCache = new Map();

export function clearLexiconCache() {
  lexiconCache.clear();
}

export function sanitizeLexiconLang(lang) {
  return String(lang || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

export async function getLexicon(lang) {
  const safeLang = sanitizeLexiconLang(lang);
  if (!safeLang || safeLang !== String(lang || "").trim().toLowerCase()) {
    return { ok: false, error: "Invalid language identifier." };
  }

  if (lexiconCache.has(safeLang)) {
    return { ok: true, lang: safeLang, data: lexiconCache.get(safeLang) };
  }

  try {
    const url = chrome.runtime.getURL(`shared/lexicons/${safeLang}.json`);
    const res = await fetch(url);
    if (!res.ok) {
      return {
        ok: false,
        error: `No bundled lexicon available for "${safeLang}" (HTTP ${res.status}).`
      };
    }
    const data = await res.json();
    lexiconCache.set(safeLang, data);
    return { ok: true, lang: safeLang, data };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load lexicon for "${safeLang}": ${err?.message || err}`
    };
  }
}

let contextMenuSetupChain = Promise.resolve();

function createContextMenuItems(settings) {
  const ignoreLastError = () => {
    void chrome.runtime?.lastError;
  };
  try {
    chrome.contextMenus.create(
      {
        id: PARENT_MENU_ID,
        title: "Text AI Tools",
        contexts: ["selection"]
      },
      ignoreLastError
    );

    for (const action of Object.values(ACTIONS)) {
      const title =
        action.id === "translate"
          ? `Translate (${settings.primaryLanguage} ↔ ${settings.secondaryLanguage})`
          : action.title;
      chrome.contextMenus.create(
        {
          id: action.id,
          parentId: PARENT_MENU_ID,
          title,
          contexts: ["selection"]
        },
        ignoreLastError
      );
    }
  } catch {
    // Ignore context menu creation errors on unsupported contexts
  }
}

export function setupContextMenus() {
  const run = async () => {
    if (!chrome?.contextMenus?.removeAll || !chrome?.contextMenus?.create) return;
    const settings = await getSettings();
    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      try {
        const maybePromise = chrome.contextMenus.removeAll(() => {
          void chrome.runtime?.lastError;
          if (!finished) {
            createContextMenuItems(settings);
            done();
          }
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(
            () => {
              if (!finished) {
                createContextMenuItems(settings);
                done();
              }
            },
            () => done()
          );
        }
      } catch {
        done();
      }
    });
  };
  contextMenuSetupChain = contextMenuSetupChain.then(run, run);
  return contextMenuSetupChain;
}

export async function ensureContentScript(tabId, frameId) {
  const target =
    typeof frameId === "number"
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
  await chrome.scripting.executeScript({
    target,
    files: CONTENT_SCRIPT_FILES
  });
}

function sendTabMessageRaw(tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    if (!tabId || !chrome?.tabs?.sendMessage) {
      reject(new Error("Tab messaging unavailable."));
      return;
    }
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    const cb = (res) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        finish(reject, new Error(err.message || String(err)));
      } else {
        finish(resolve, res);
      }
    };
    try {
      const maybePromise =
        typeof frameId === "number"
          ? chrome.tabs.sendMessage(tabId, message, { frameId }, cb)
          : chrome.tabs.sendMessage(tabId, message, cb);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (res) => finish(resolve, res),
          (err) => finish(reject, err)
        );
      }
    } catch (err) {
      finish(reject, err);
    }
  });
}

export async function trySendMessageToTab(tabId, message, frameId) {
  if (!tabId) return { ok: false, error: "Missing tabId." };
  try {
    const data = await sendTabMessageRaw(tabId, message, frameId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function isExpectedRestrictedInjectionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("cannot access") ||
    msg.includes("restricted") ||
    msg.includes("about:") ||
    msg.includes("orion://") ||
    msg.includes("chrome://") ||
    msg.includes("edge://") ||
    msg.includes("opera://") ||
    msg.includes("moz-extension://") ||
    msg.includes("extension gallery") ||
    msg.includes("frame was removed") ||
    msg.includes("no tab with id")
  );
}

export async function handleTabAction(tabId, actionId, fallbackSelection = "", frameId) {
  const action = ACTIONS[actionId];
  if (!action || !tabId) return;

  let selectedText = "";
  let scriptReady = false;

  try {
    const res = await sendTabMessageRaw(tabId, { type: "getSelection" }, frameId);
    selectedText = res?.text || fallbackSelection || "";
    scriptReady = true;
  } catch {
    scriptReady = false;
  }

  if (!scriptReady) {
    try {
      await ensureContentScript(tabId, frameId);
    } catch (err) {
      if (!isExpectedRestrictedInjectionError(err)) {
        console.warn("Failed to inject content script:", err);
      }
      return;
    }

    const probe = await trySendMessageToTab(tabId, { type: "getSelection" }, frameId);
    selectedText = probe.ok ? probe.data?.text || fallbackSelection || "" : fallbackSelection || "";
  }

  const settings = await getSettings();
  const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
  if (providerCfg.requiresKey && !settings.apiKey) {
    await trySendMessageToTab(
      tabId,
      {
        type: "showError",
        message: `Please set your ${providerCfg.label} API key first.`,
        openOptions: true
      },
      frameId
    );
    return;
  }

  if (!selectedText.trim()) {
    await trySendMessageToTab(
      tabId,
      {
        type: "showError",
        message: "Please select some text first."
      },
      frameId
    );
    return;
  }

  await trySendMessageToTab(
    tabId,
    {
      type: "showLoading",
      message: `Running ${action.shortTitle}...`
    },
    frameId
  );

  try {
    const result = await callAI({
      provider: settings.provider,
      customBaseUrl: settings.customBaseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      actionId,
      text: selectedText,
      primaryLanguage: settings.primaryLanguage,
      secondaryLanguage: settings.secondaryLanguage
    });

    await trySendMessageToTab(
      tabId,
      {
        type: "applyResult",
        mode: action.mode,
        text: result,
        dialogTitle: action.dialogTitle,
        copiedNotice: action.copiedNotice,
        copyOnReplace: settings.copyOnReplace
      },
      frameId
    );
  } catch (err) {
    await trySendMessageToTab(
      tabId,
      {
        type: "showError",
        message: `${providerCfg.label} API request failed: ${err?.message || err}`
      },
      frameId
    );
  }
}

export async function openOptionsPageSafely() {
  const fallbackToTab = async () => {
    try {
      if (chrome?.tabs?.create && chrome?.runtime?.getURL) {
        await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        return true;
      }
    } catch {
      // Ignore tab fallback errors
    }
    return false;
  };

  if (typeof chrome?.runtime?.openOptionsPage !== "function") {
    return fallbackToTab();
  }

  let fellBack = false;
  const triggerFallback = () => {
    if (fellBack) return Promise.resolve(true);
    fellBack = true;
    return fallbackToTab();
  };

  try {
    let syncCallbackErr = null;
    const maybePromise = chrome.runtime.openOptionsPage(() => {
      const err = chrome.runtime?.lastError;
      if (err) {
        syncCallbackErr = err;
        void triggerFallback();
      }
    });
    if (maybePromise && typeof maybePromise.then === "function") {
      await maybePromise;
    }
    if (syncCallbackErr) {
      return await triggerFallback();
    }
    return true;
  } catch {
    return await triggerFallback();
  }
}

function safeSendResponse(sendResponse, payload) {
  if (typeof sendResponse !== "function") return;
  try {
    sendResponse(payload);
  } catch {
    // Ignore closed message channel errors (e.g., tab closed or navigated)
  }
}

export async function handleRuntimeMessage(msg, sender) {
  if (!msg || typeof msg !== "object") {
    return { ok: false, error: "Invalid message payload." };
  }

  if (msg.type === "getLexicon") {
    return getLexicon(msg.lang);
  }

  if (msg.type === "geminiInlineAction") {
    const action = ACTIONS[msg.actionId];
    if (!action) {
      return { ok: false, error: `Unknown action: ${msg.actionId}` };
    }
    const settings = await getSettings();
    const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
    if (providerCfg.requiresKey && !settings.apiKey) {
      return {
        ok: false,
        error: `Please set your ${providerCfg.label} API key in Settings first.`,
        openOptions: true
      };
    }
    try {
      const result = await callAI({
        provider: settings.provider,
        customBaseUrl: settings.customBaseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        actionId: msg.actionId,
        text: msg.text,
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage
      });
      return {
        ok: true,
        result,
        mode: action.mode,
        dialogTitle: action.dialogTitle
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (msg.type === "geminiSentenceSuggestions") {
    const settings = await getSettings();
    const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
    if (providerCfg.requiresKey && !settings.apiKey) {
      return {
        ok: false,
        error: `Please set your ${providerCfg.label} API key in Settings first.`,
        openOptions: true
      };
    }
    try {
      const { options } = await fetchSentenceSuggestions({
        text: msg.text,
        mode: msg.mode || "sentence",
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage,
        provider: settings.provider,
        customBaseUrl: settings.customBaseUrl,
        apiKey: settings.apiKey,
        model: settings.model
      });
      return { ok: true, options };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (msg.type === "geminiContextualWord") {
    const settings = await getSettings();
    const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
    if (providerCfg.requiresKey && !settings.apiKey) {
      return {
        ok: false,
        error: `Please set your ${providerCfg.label} API key in Settings first.`,
        openOptions: true
      };
    }
    try {
      const { suggestions } = await fetchContextualWordSuggestions({
        sentence: msg.sentence,
        targetWord: msg.targetWord,
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage,
        provider: settings.provider,
        customBaseUrl: settings.customBaseUrl,
        apiKey: settings.apiKey,
        model: settings.model
      });
      return { ok: true, suggestions };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (msg.type === "relayModalToTopFrame") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return { ok: false, error: "Missing sender tab ID for modal relay." };
    }
    const relayRes = await trySendMessageToTab(
      tabId,
      {
        type: "showTopFrameModal",
        dialogTitle: msg.dialogTitle || "Result",
        text: msg.text || ""
      },
      0
    );
    return relayRes.ok ? { ok: true } : { ok: false, error: relayRes.error };
  }

  if (msg.type === "askAIQuestion") {
    const settings = await getSettings();
    const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
    if (providerCfg.requiresKey && !settings.apiKey) {
      return {
        ok: false,
        error: `Please set your ${providerCfg.label} API key in Settings first.`,
        openOptions: true
      };
    }
    try {
      const result = await askAIQuestion({
        question: msg.question,
        text: msg.text,
        history: Array.isArray(msg.history) ? msg.history : [],
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage,
        provider: settings.provider,
        customBaseUrl: settings.customBaseUrl,
        apiKey: settings.apiKey,
        model: settings.askModel || settings.model
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (msg.type === "openOptions") {
    await openOptionsPageSafely();
    return { ok: true };
  }

  if (msg.type === "checkAndReloadUpdate") {
    const canReload = typeof chrome?.runtime?.reload === "function";
    if (canReload) {
      const reloaded = await checkLocalManifestAndReload({ deferReload: true });
      if (reloaded) {
        return { ok: true, reloaded: true };
      }
    }
    const remoteVersion = await checkRemoteManifestVersion();
    const currentVersion = chrome.runtime.getManifest?.().version || "";
    return {
      ok: true,
      reloaded: false,
      unsupportedReload: !canReload,
      currentVersion,
      remoteVersion,
      hasUpdate: Boolean(remoteVersion && compareVersions(remoteVersion, currentVersion) > 0)
    };
  }

  return { ok: false, error: `Unknown message type: ${msg.type}` };
}

const REMOTE_MANIFEST_URL =
  "https://raw.githubusercontent.com/AlpBora/Text-AI-Tools-Extension/main/manifest.json";

export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkLocalManifestAndReload({ deferReload = false } = {}) {
  try {
    if (
      !chrome?.runtime?.getURL ||
      !chrome?.runtime?.getManifest ||
      typeof chrome?.runtime?.reload !== "function"
    ) {
      return false;
    }
    const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!res.ok) return false;
    const diskManifest = await res.json();
    const runningVersion = chrome.runtime.getManifest().version;
    if (diskManifest?.version && diskManifest.version !== runningVersion) {
      if (deferReload) {
        setTimeout(() => {
          try {
            if (typeof chrome?.runtime?.reload === "function") {
              chrome.runtime.reload();
            }
          } catch {
            // Ignore reload errors
          }
        }, 50);
      } else {
        chrome.runtime.reload();
      }
      return true;
    }
  } catch {
    // Ignore local fetch errors
  }
  return false;
}

export async function checkRemoteManifestVersion() {
  try {
    if (typeof fetch !== "function") return null;
    const res = await fetch(REMOTE_MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const remote = await res.json();
    const remoteVersion = typeof remote?.version === "string" ? remote.version.trim() : null;
    if (remoteVersion && chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ latestRemoteVersion: remoteVersion });
    }
    return remoteVersion;
  } catch {
    return null;
  }
}

export function registerListeners() {
  if (typeof chrome === "undefined" || !chrome.runtime) return;

  chrome.runtime.onInstalled?.addListener(() => {
    void setupContextMenus().catch(() => {});
  });
  chrome.runtime.onStartup?.addListener(() => {
    void setupContextMenus().catch(() => {});
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && (changes.primaryLanguage || changes.secondaryLanguage)) {
      void setupContextMenus().catch(() => {});
    }
  });

  chrome.contextMenus?.onClicked?.addListener((info, tab) => {
    if (!tab?.id || !ACTIONS[info.menuItemId]) return;
    const frameId = typeof info.frameId === "number" ? info.frameId : 0;
    Promise.resolve(
      handleTabAction(tab.id, info.menuItemId, info.selectionText || "", frameId)
    ).catch(() => {});
  });

  chrome.commands?.onCommand?.addListener(async (command) => {
    if (!ACTIONS[command]) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      if (!tab?.id) return;

      let targetFrameId = 0;
      if (typeof chrome?.scripting?.executeScript === "function") {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => {
              const sel = window.getSelection?.()?.toString() || "";
              const active = document.activeElement;
              const isInputSel =
                active &&
                (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
                (active.selectionEnd ?? 0) > (active.selectionStart ?? 0);
              const hasSel = Boolean(sel.trim()) || Boolean(isInputSel);
              const isLeafFocus = document.hasFocus() && active?.tagName !== "IFRAME";
              return { hasSel, isLeafFocus };
            }
          });
          if (Array.isArray(results)) {
            const selFrame = results.find((r) => r?.result?.hasSel && typeof r.frameId === "number");
            const focusFrame = results.find(
              (r) => r?.result?.isLeafFocus && typeof r.frameId === "number"
            );
            if (selFrame) targetFrameId = selFrame.frameId;
            else if (focusFrame) targetFrameId = focusFrame.frameId;
          }
        } catch {
          targetFrameId = 0;
        }
      }

      await handleTabAction(tab.id, command, "", targetFrameId);
    } catch {
      // Ignore command errors on closed/restricted tabs
    }
  });

  chrome.runtime.onMessage?.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") {
      return false;
    }

    if (msg.type === "openOptions") {
      void openOptionsPageSafely();
      safeSendResponse(sendResponse, { ok: true });
      return false;
    }

    const asyncTypes = new Set([
      "getLexicon",
      "geminiInlineAction",
      "geminiSentenceSuggestions",
      "geminiContextualWord",
      "askAIQuestion",
      "relayModalToTopFrame",
      "checkAndReloadUpdate"
    ]);
    if (!asyncTypes.has(msg.type)) {
      return false;
    }

    handleRuntimeMessage(msg, sender)
      .then((res) => safeSendResponse(sendResponse, res))
      .catch((err) => safeSendResponse(sendResponse, { ok: false, error: err?.message || String(err) }));
    return true;
  });
}

registerListeners();

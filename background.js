import {
  ACTIONS,
  callGemini,
  fetchContextualWordSuggestions,
  fetchSentenceSuggestions,
  getSettings
} from "./shared/actions.js";

const PARENT_MENU_ID = "text-ai-tools-root";

export const CONTENT_SCRIPT_FILES = [
  "content/language-registry.js",
  "content/morphology-tr.js",
  "content/deasciifier-tr.js",
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

export async function setupContextMenus() {
  const settings = await getSettings();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT_MENU_ID,
      title: "Text AI Tools",
      contexts: ["selection"]
    });

    for (const action of Object.values(ACTIONS)) {
      const title =
        action.id === "translate"
          ? `Translate (${settings.primaryLanguage} ↔ ${settings.secondaryLanguage})`
          : action.title;
      chrome.contextMenus.create({
        id: action.id,
        parentId: PARENT_MENU_ID,
        title,
        contexts: ["selection"]
      });
    }
  });
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

function sendMessageToTab(tabId, message, frameId) {
  if (typeof frameId === "number") {
    return chrome.tabs.sendMessage(tabId, message, { frameId });
  }
  return chrome.tabs.sendMessage(tabId, message);
}

export async function handleTabAction(tabId, actionId, fallbackSelection = "", frameId) {
  const action = ACTIONS[actionId];
  if (!action || !tabId) return;

  let selectedText = "";
  let scriptReady = false;

  try {
    const res = await sendMessageToTab(tabId, { type: "getSelection" }, frameId);
    selectedText = res?.text || fallbackSelection || "";
    scriptReady = true;
  } catch {
    scriptReady = false;
  }

  if (!scriptReady) {
    try {
      await ensureContentScript(tabId, frameId);
    } catch (err) {
      console.error("Failed to inject content script:", err);
      return;
    }

    try {
      const res = await sendMessageToTab(tabId, { type: "getSelection" }, frameId);
      selectedText = res?.text || fallbackSelection || "";
    } catch {
      selectedText = fallbackSelection || "";
    }
  }

  const settings = await getSettings();
  if (!settings.apiKey) {
    await sendMessageToTab(
      tabId,
      {
        type: "showError",
        message: "Please set your Gemini API key first.",
        openOptions: true
      },
      frameId
    );
    return;
  }

  if (!selectedText.trim()) {
    await sendMessageToTab(
      tabId,
      {
        type: "showError",
        message: "Please select some text first."
      },
      frameId
    );
    return;
  }

  await sendMessageToTab(
    tabId,
    {
      type: "showLoading",
      message: `Running ${action.shortTitle}...`
    },
    frameId
  );

  try {
    const result = await callGemini({
      apiKey: settings.apiKey,
      model: settings.model,
      actionId,
      text: selectedText,
      primaryLanguage: settings.primaryLanguage,
      secondaryLanguage: settings.secondaryLanguage
    });

    await sendMessageToTab(
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
    await sendMessageToTab(
      tabId,
      {
        type: "showError",
        message: `Gemini API request failed: ${err?.message || err}`
      },
      frameId
    );
  }
}

export async function handleRuntimeMessage(msg, sender) {
  if (!msg || typeof msg !== "object") {
    return { ok: false, error: "Invalid message payload." };
  }

  if (msg.type === "getLexicon") {
    return getLexicon(msg.lang);
  }

  if (msg.type === "geminiSentenceSuggestions") {
    const settings = await getSettings();
    if (!settings.apiKey) {
      return {
        ok: false,
        error: "Please set your Gemini API key in Settings first.",
        openOptions: true
      };
    }
    try {
      const { options } = await fetchSentenceSuggestions({
        text: msg.text,
        mode: msg.mode || "sentence",
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage,
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
    if (!settings.apiKey) {
      return {
        ok: false,
        error: "Please set your Gemini API key in Settings first.",
        openOptions: true
      };
    }
    try {
      const { suggestions } = await fetchContextualWordSuggestions({
        sentence: msg.sentence,
        targetWord: msg.targetWord,
        primaryLanguage: msg.primaryLang || settings.primaryLanguage,
        secondaryLanguage: msg.secondaryLang || settings.secondaryLanguage,
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
    try {
      await chrome.tabs.sendMessage(
        tabId,
        {
          type: "showTopFrameModal",
          dialogTitle: msg.dialogTitle || "Result",
          text: msg.text || ""
        },
        { frameId: 0 }
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  return { ok: false, error: `Unknown message type: ${msg.type}` };
}

export function registerListeners() {
  if (typeof chrome === "undefined" || !chrome.runtime) return;

  chrome.runtime.onInstalled?.addListener(setupContextMenus);
  chrome.runtime.onStartup?.addListener(setupContextMenus);

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && (changes.primaryLanguage || changes.secondaryLanguage)) {
      setupContextMenus();
    }
  });

  chrome.contextMenus?.onClicked?.addListener((info, tab) => {
    if (!tab?.id || !ACTIONS[info.menuItemId]) return;
    const frameId = typeof info.frameId === "number" ? info.frameId : 0;
    handleTabAction(tab.id, info.menuItemId, info.selectionText || "", frameId);
  });

  chrome.commands?.onCommand?.addListener(async (command) => {
    if (!ACTIONS[command]) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      handleTabAction(tab.id, command, "", 0);
    }
  });

  chrome.runtime.onMessage?.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "openOptions") {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }

    const asyncTypes = new Set([
      "getLexicon",
      "geminiSentenceSuggestions",
      "geminiContextualWord",
      "relayModalToTopFrame"
    ]);
    if (!msg || !asyncTypes.has(msg.type)) {
      return false;
    }

    handleRuntimeMessage(msg, sender)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
}

registerListeners();

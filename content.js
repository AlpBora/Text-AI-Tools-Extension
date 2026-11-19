(() => {
  "use strict";

  const HOST_ID = "text-tools-shadow-host";
  const LEXICON_TIMEOUT_MS = 4000;
  const LEXICON_RETRY_COOLDOWN_MS = 15000;

  function readRuntimeId() {
    try {
      return chrome?.runtime?.id;
    } catch {
      return null;
    }
  }

  const initialRuntimeId = readRuntimeId();
  const hasExplicitRuntimeId = typeof initialRuntimeId === "string" && initialRuntimeId.length > 0;
  const runtimeStateKey = hasExplicitRuntimeId ? initialRuntimeId : "__mock__";

  const prevState = globalThis.__TEXT_AI_TOOLS_STATE__;
  if (prevState) {
    const stillAlive =
      prevState.active &&
      prevState.runtimeId === runtimeStateKey &&
      (typeof prevState.isAlive === "function" ? prevState.isAlive() : true);
    if (stillAlive) {
      return;
    }
    if (typeof prevState.cleanup === "function") {
      try {
        prevState.cleanup();
      } catch {
        // Ignore cleanup errors from prior invalidated instance
      }
    }
  }

  // Also clean up any orphaned shadow host from a previous isolated-world injection
  try {
    const orphanHost = typeof document !== "undefined" ? document.getElementById(HOST_ID) : null;
    if (orphanHost && !globalThis.__TEXT_AI_TOOLS_STATE__?.active) {
      orphanHost.remove();
    }
  } catch {
    // Ignore DOM cleanup errors
  }

  let contextInvalidated = false;
  function isRuntimeContextAlive() {
    if (contextInvalidated) return false;
    if (!hasExplicitRuntimeId) return Boolean(chrome?.runtime);
    return readRuntimeId() === initialRuntimeId;
  }

  function isContextInvalidatedError(errOrMsg) {
    const msg = String(errOrMsg?.message || errOrMsg || "").toLowerCase();
    return msg.includes("extension context invalidated") || msg.includes("context invalidated");
  }

  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const managedListeners = [];
  let storageChangedListener = null;
  let runtimeMessageListener = null;

  function addManagedListener(target, type, fn, capture = false) {
    if (!target || typeof target.addEventListener !== "function") return;
    if (abortController) {
      try {
        target.addEventListener(type, fn, { capture: Boolean(capture), signal: abortController.signal });
      } catch {
        target.addEventListener(type, fn, Boolean(capture));
      }
    } else {
      target.addEventListener(type, fn, Boolean(capture));
    }
    managedListeners.push({ target, type, fn, capture: Boolean(capture) });
  }

  globalThis.__TEXT_AI_TOOLS_CONTENT_INIT__ = true;
  if (typeof window !== "undefined") {
    window.__textToolsLoaded = true;
  }

  const Tools = globalThis.__TEXT_AI_TOOLS__ || {};
  const DomEditor = Tools.DomEditor;
  const SpellcheckEngine = Tools.SpellcheckEngine;
  const LanguageRegistry = Tools.LanguageRegistry;
  const PersonalModel = Tools.PersonalModel;
  const UndoManager = Tools.UndoManager;

  const settings = {
    spellcheckEnabled: true,
    autoCorrectEnabled: true,
    primaryLanguage: "Turkish",
    secondaryLanguage: "English",
    copyOnReplace: true
  };

  const lexiconsByLang = Object.create(null);
  const lexiconPending = new Map();
  const lexiconCooldownUntil = new Map();
  let lexiconsInitialized = false;

  let activeEditor = null;
  let savedSelection = null;
  let isApplyingExtensionEdit = false;
  let isComposing = false;

  let toastTimer = null;
  let undoTimer = null;
  let selectionUpdateTimer = null;
  let habitSaveTimer = null;

  let activeUncertain = null; // { editor, word, span, candidates, sentence }
  let activeUndoState = null; // { editor, undoId, start, end, originalWord, correctedWord, boundaryChar }
  let activeMenuMode = null; // "uncertain" | "suggestions" | null

  const userHabits = {
    corrections: Object.create(null),
    wordCounts: Object.create(null),
    ignored: Object.create(null),
    bigrams: Object.create(null),
    domainCounts: Object.create(null),
    charEdits: Object.create(null)
  };

  function getDeepActiveElement() {
    if (DomEditor && typeof DomEditor.getDeepActiveElement === "function") {
      return DomEditor.getDeepActiveElement(document);
    }
    return document.activeElement || null;
  }

  function clearAllTimers() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
    if (selectionUpdateTimer) {
      clearTimeout(selectionUpdateTimer);
      selectionUpdateTimer = null;
    }
    if (habitSaveTimer) {
      clearTimeout(habitSaveTimer);
      habitSaveTimer = null;
    }
  }

  function teardownInstance({ removeHost = true } = {}) {
    stateRecord.active = false;
    contextInvalidated = true;
    clearAllTimers();

    if (activeUncertain?.editor && DomEditor) {
      try {
        DomEditor.setUncertainUnderline(activeUncertain.editor, null);
      } catch {
        // ignore
      }
    }
    activeUncertain = null;
    activeUndoState = null;
    activeMenuMode = null;
    activeEditor = null;
    savedSelection = null;

    if (abortController) {
      try {
        abortController.abort();
      } catch {
        // ignore
      }
    }
    for (const entry of managedListeners.splice(0)) {
      try {
        entry.target.removeEventListener?.(entry.type, entry.fn, entry.capture);
      } catch {
        // ignore
      }
    }
    if (storageChangedListener) {
      try {
        chrome?.storage?.onChanged?.removeListener?.(storageChangedListener);
      } catch {
        // ignore
      }
      storageChangedListener = null;
    }
    if (runtimeMessageListener) {
      try {
        chrome?.runtime?.onMessage?.removeListener?.(runtimeMessageListener);
      } catch {
        // ignore
      }
      runtimeMessageListener = null;
    }

    if (removeHost && typeof document !== "undefined") {
      try {
        document.getElementById(HOST_ID)?.remove();
      } catch {
        // ignore
      }
    }
  }

  function handleContextInvalidated() {
    if (!stateRecord.active) return;
    teardownInstance({ removeHost: false });
    globalThis.__TEXT_AI_TOOLS_CONTENT_INIT__ = false;
    try {
      showToast({
        message: "Text AI Tools was reloaded. Refresh this page to continue.",
        variant: "error",
        duration: 4500
      });
      setTimeout(() => {
        try {
          if (!stateRecord.active) {
            document.getElementById(HOST_ID)?.remove();
          }
        } catch {
          // ignore
        }
      }, 4600);
    } catch {
      try {
        document.getElementById(HOST_ID)?.remove();
      } catch {
        // ignore
      }
    }
  }

  const stateRecord = {
    active: true,
    runtimeId: runtimeStateKey,
    isAlive: isRuntimeContextAlive,
    cleanup: () => teardownInstance({ removeHost: true })
  };
  globalThis.__TEXT_AI_TOOLS_STATE__ = stateRecord;

  function sendRuntimeMessage(payload, { timeoutMs = 30000 } = {}, onDone = null) {
    const run = (resolve) => {
      if (!isRuntimeContextAlive()) {
        handleContextInvalidated();
        const errRes = {
          ok: false,
          error: "Extension context invalidated. Refresh the page to continue.",
          contextInvalidated: true
        };
        if (onDone) onDone(errRes);
        resolve(errRes);
        return;
      }

      if (!chrome?.runtime?.sendMessage) {
        const errRes = { ok: false, error: "Extension messaging unavailable." };
        if (onDone) onDone(errRes);
        resolve(errRes);
        return;
      }

      let settled = false;
      let timer = null;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (res?.contextInvalidated) {
          handleContextInvalidated();
        }
        if (onDone) onDone(res);
        resolve(res);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish({ ok: false, error: "Request timed out. Please try again.", timedOut: true });
        }, timeoutMs);
      }

      try {
        const maybePromise = chrome.runtime.sendMessage(payload, (res) => {
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            const msg = lastErr.message || String(lastErr);
            if (isContextInvalidatedError(msg)) {
              finish({
                ok: false,
                error: "Extension context invalidated. Refresh the page to continue.",
                contextInvalidated: true
              });
              return;
            }
            finish({ ok: false, error: msg });
            return;
          }
          if (res === undefined) {
            finish({ ok: false, error: "No response from extension background." });
            return;
          }
          finish(res);
        });

        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(
            (res) => {
              if (res === undefined) {
                finish({ ok: false, error: "No response from extension background." });
              } else {
                finish(res);
              }
            },
            (err) => {
              const msg = err?.message || String(err);
              if (isContextInvalidatedError(msg)) {
                finish({
                  ok: false,
                  error: "Extension context invalidated. Refresh the page to continue.",
                  contextInvalidated: true
                });
              } else {
                finish({ ok: false, error: msg });
              }
            }
          );
        }
      } catch (err) {
        const msg = err?.message || String(err);
        if (isContextInvalidatedError(msg)) {
          finish({
            ok: false,
            error: "Extension context invalidated. Refresh the page to continue.",
            contextInvalidated: true
          });
        } else {
          finish({ ok: false, error: msg });
        }
      }
    };

    if (typeof onDone === "function") {
      let syncResult;
      run((res) => {
        syncResult = res;
      });
      return Promise.resolve(syncResult);
    }
    return new Promise(run);
  }

  function getCurrentDomain() {
    try {
      return String(window.location?.hostname || "").trim().toLowerCase();
    } catch {
      return "";
    }
  }

  function trLowerHabit(str) {
    return String(str || "")
      .trim()
      .normalize("NFC")
      .replace(/İ/g, "i")
      .replace(/I/g, "ı")
      .toLowerCase()
      .replace(/i\u0307/g, "i")
      .normalize("NFC");
  }

  function mergeUserHabits(rawHabits) {
    if (!rawHabits || typeof rawHabits !== "object") return;
    if (rawHabits.corrections && typeof rawHabits.corrections === "object") {
      Object.assign(userHabits.corrections, rawHabits.corrections);
    }
    if (rawHabits.wordCounts && typeof rawHabits.wordCounts === "object") {
      Object.assign(userHabits.wordCounts, rawHabits.wordCounts);
    }
    if (rawHabits.ignored && typeof rawHabits.ignored === "object") {
      Object.assign(userHabits.ignored, rawHabits.ignored);
    }
    if (rawHabits.bigrams && typeof rawHabits.bigrams === "object") {
      Object.assign(userHabits.bigrams, rawHabits.bigrams);
    }
    if (rawHabits.domainCounts && typeof rawHabits.domainCounts === "object") {
      Object.assign(userHabits.domainCounts, rawHabits.domainCounts);
    }
    if (rawHabits.charEdits && typeof rawHabits.charEdits === "object") {
      Object.assign(userHabits.charEdits, rawHabits.charEdits);
    }
  }

  function saveUserHabitsDebounced() {
    if (!isRuntimeContextAlive()) return;
    if (habitSaveTimer) clearTimeout(habitSaveTimer);
    habitSaveTimer = setTimeout(() => {
      habitSaveTimer = null;
      if (!isRuntimeContextAlive()) return;
      try {
        if (!chrome?.storage?.local?.set) return;
        const payload = PersonalModel
          ? PersonalModel.pruneHabits(userHabits)
          : {
              corrections: { ...userHabits.corrections },
              wordCounts: { ...userHabits.wordCounts },
              ignored: { ...userHabits.ignored },
              bigrams: { ...userHabits.bigrams },
              domainCounts: { ...userHabits.domainCounts },
              charEdits: { ...userHabits.charEdits }
            };
        const res = chrome.storage.local.set({ userHabits: payload }, () => {
          const err = chrome.runtime?.lastError;
          if (err && isContextInvalidatedError(err.message || err)) {
            handleContextInvalidated();
          }
        });
        if (res && typeof res.catch === "function") {
          res.catch((err) => {
            if (isContextInvalidatedError(err)) {
              handleContextInvalidated();
            }
          });
        }
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          handleContextInvalidated();
        }
      }
    }, 400);
  }

  function recordHabitWordUsage(word, prevWord) {
    const k = trLowerHabit(word);
    if (!k || k.length < 2) return;
    userHabits.wordCounts[k] = (Number(userHabits.wordCounts[k]) || 0) + 1;
    if (PersonalModel) {
      if (prevWord) PersonalModel.recordBigram(userHabits, prevWord, k, 1);
      const dom = getCurrentDomain();
      if (dom) PersonalModel.recordDomainWord(userHabits, dom, k, 1);
    }
    saveUserHabitsDebounced();
  }

  function recordHabitCorrection(origWord, targetWord, weight = 1, prevWord = "") {
    const o = trLowerHabit(origWord);
    const t = trLowerHabit(targetWord);
    if (!o || !t || o === t) return;
    if (!userHabits.corrections[o] || typeof userHabits.corrections[o] !== "object") {
      userHabits.corrections[o] = Object.create(null);
    }
    userHabits.corrections[o][t] = (Number(userHabits.corrections[o][t]) || 0) + weight;
    userHabits.wordCounts[t] = (Number(userHabits.wordCounts[t]) || 0) + weight;
    if (PersonalModel) {
      PersonalModel.learnCharEdits(userHabits, o, t, weight);
      if (prevWord) PersonalModel.recordBigram(userHabits, prevWord, t, weight);
      const dom = getCurrentDomain();
      if (dom) PersonalModel.recordDomainWord(userHabits, dom, t, weight);
    }
    if (userHabits.ignored[o]) {
      delete userHabits.ignored[o];
    }
    saveUserHabitsDebounced();
  }

  function recordHabitIgnore(origWord, correctedWord) {
    const o = trLowerHabit(origWord);
    if (!o) return;
    userHabits.ignored[o] = (Number(userHabits.ignored[o]) || 0) + 1;
    if (correctedWord) {
      const t = trLowerHabit(correctedWord);
      if (userHabits.corrections[o] && userHabits.corrections[o][t]) {
        userHabits.corrections[o][t] = Math.max(0, Number(userHabits.corrections[o][t]) - 1);
      }
      if (PersonalModel) {
        PersonalModel.learnCharEdits(userHabits, o, t, -1);
      }
    }
    saveUserHabitsDebounced();
  }

  // --- Storage & Lazy Lexicon Loading ---
  function loadSettings() {
    if (!isRuntimeContextAlive()) return;
    try {
      if (!chrome?.storage?.local) return;
      chrome.storage.local.get(
        {
          spellcheckEnabled: true,
          autoCorrectEnabled: true,
          primaryLanguage: "Turkish",
          secondaryLanguage: "English",
          copyOnReplace: true,
          userHabits: null
        },
        (data) => {
          if (chrome.runtime?.lastError || !data) return;
          settings.spellcheckEnabled = data.spellcheckEnabled !== false;
          settings.autoCorrectEnabled = data.autoCorrectEnabled !== false;
          settings.primaryLanguage = String(data.primaryLanguage || "Turkish").trim() || "Turkish";
          settings.secondaryLanguage = String(data.secondaryLanguage || "English").trim() || "English";
          settings.copyOnReplace = Boolean(data.copyOnReplace);
          mergeUserHabits(data.userHabits);
        }
      );
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        handleContextInvalidated();
      }
    }
  }

  function getActiveBundledLangIds() {
    const ids = [];
    const candidates = [settings.primaryLanguage, settings.secondaryLanguage];
    for (const raw of candidates) {
      if (!raw) continue;
      const norm = LanguageRegistry ? LanguageRegistry.normalizeLang(raw) : String(raw).trim().toLowerCase();
      if (!norm || ids.includes(norm)) continue;
      const profile = LanguageRegistry ? LanguageRegistry.getProfile(norm) : null;
      if (!profile || profile.hasBundledLexicon) {
        ids.push(norm);
      }
    }
    return ids;
  }

  function fetchLexicon(langId, { bypassCooldown = false } = {}) {
    if (!langId) return Promise.resolve(null);
    if (lexiconsByLang[langId]) return Promise.resolve(lexiconsByLang[langId]);
    if (lexiconPending.has(langId)) return lexiconPending.get(langId);
    if (!bypassCooldown && Date.now() < (lexiconCooldownUntil.get(langId) || 0)) {
      return Promise.resolve(null);
    }
    if (!isRuntimeContextAlive()) {
      return Promise.resolve(null);
    }

    let syncLoaded = null;
    let resolvedSync = false;

    const fallbackLoad = async () => {
      if (
        typeof fetch === "function" &&
        typeof chrome?.runtime?.getURL === "function" &&
        isRuntimeContextAlive()
      ) {
        try {
          const url = chrome.runtime.getURL(`shared/lexicons/${encodeURIComponent(langId)}.json`);
          const resp = await fetch(url);
          if (resp && resp.ok) {
            const data = await resp.json();
            if (data) {
              lexiconsByLang[langId] = data;
              lexiconCooldownUntil.delete(langId);
              lexiconsInitialized = hasAllActiveLexiconsLoaded();
              return data;
            }
          }
        } catch {
          // Ignore fallback fetch errors
        }
      }
      lexiconCooldownUntil.set(langId, Date.now() + LEXICON_RETRY_COOLDOWN_MS);
      return null;
    };

    const promise = new Promise((resolve) => {
      sendRuntimeMessage(
        { type: "getLexicon", lang: langId },
        { timeoutMs: LEXICON_TIMEOUT_MS },
        (res) => {
          if (res && res.ok && res.data) {
            lexiconsByLang[langId] = res.data;
            lexiconCooldownUntil.delete(langId);
            lexiconsInitialized = hasAllActiveLexiconsLoaded();
            syncLoaded = res.data;
            resolvedSync = true;
            resolve(res.data);
            return;
          }
          if (res?.contextInvalidated) {
            resolve(null);
            return;
          }
          fallbackLoad().then(resolve, () => resolve(null));
        }
      );
    }).finally(() => {
      lexiconPending.delete(langId);
    });

    if (resolvedSync) {
      return Promise.resolve(syncLoaded);
    }
    lexiconPending.set(langId, promise);
    return promise;
  }

  function ensureLexiconsForActiveLanguages({ bypassCooldown = false } = {}) {
    const langIds = getActiveBundledLangIds();
    const missing = langIds.filter((id) => !lexiconsByLang[id]);
    if (missing.length === 0) {
      lexiconsInitialized = true;
      return Promise.resolve();
    }
    return Promise.all(missing.map((id) => fetchLexicon(id, { bypassCooldown })));
  }

  function hasAllActiveLexiconsLoaded() {
    const langIds = getActiveBundledLangIds();
    return langIds.every((id) => Boolean(lexiconsByLang[id]));
  }

  // --- Shadow DOM Host & Styles ---
  function ensureShadowStructure() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.zIndex = "2147483647";
      host.style.top = "0";
      host.style.left = "0";
      host.style.width = "0";
      host.style.height = "0";
      host.style.pointerEvents = "none";
      (document.documentElement || document.body).appendChild(host);
    }

    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        #text-tools-underlines {
          position: fixed;
          top: 0;
          left: 0;
          width: 0;
          height: 0;
          pointer-events: none;
          z-index: 2147483645;
        }
        .uncertain-underline {
          position: fixed;
          pointer-events: none;
          border-bottom: 2px wavy #ef4444;
          background: rgba(239, 68, 68, 0.06);
        }
        #text-tools-floating {
          position: fixed;
          top: 0;
          left: 0;
          width: 0;
          height: 0;
          pointer-events: none;
          z-index: 2147483646;
        }
        .trigger-btn {
          position: fixed;
          pointer-events: auto;
          width: 26px;
          height: 26px;
          border-radius: 999px;
          border: 1px solid rgba(89, 230, 245, 0.45);
          background: linear-gradient(135deg, rgba(10, 166, 199, 0.78), rgba(10, 41, 107, 0.88));
          backdrop-filter: blur(12px) saturate(160%);
          -webkit-backdrop-filter: blur(12px) saturate(160%);
          color: #ffffff;
          font-size: 13px;
          font-weight: 700;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 6px 16px rgba(4, 24, 62, 0.32);
          transition: transform 0.12s ease, box-shadow 0.12s ease;
          padding: 0;
        }
        .trigger-btn:hover {
          transform: scale(1.08);
          box-shadow: 0 8px 20px rgba(10, 166, 199, 0.45);
        }
        .undo-pill {
          position: fixed;
          pointer-events: auto;
          background: #111827;
          color: #f9fafb;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 999px;
          padding: 5px 8px 5px 12px;
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
          animation: fadeIn 0.14s ease-out;
          max-width: min(360px, calc(100vw - 16px));
        }
        .undo-text {
          color: #d1d5db;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 190px;
        }
        .undo-btn {
          background: #4f46e5;
          color: #ffffff;
          border: none;
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .undo-btn:hover { background: #4338ca; }
        .pill-close {
          background: transparent;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          font-size: 14px;
          padding: 0 4px;
          line-height: 1;
        }
        .pill-close:hover { color: #ffffff; }
        .popover {
          position: fixed;
          pointer-events: auto;
          min-width: 216px;
          max-width: min(300px, calc(100vw - 16px));
          max-height: calc(100vh - 16px);
          overflow-y: auto;
          background: linear-gradient(145deg, rgba(10, 166, 199, 0.68), rgba(10, 41, 107, 0.80));
          backdrop-filter: blur(20px) saturate(165%);
          -webkit-backdrop-filter: blur(20px) saturate(165%);
          color: #ffffff;
          border: 1px solid rgba(89, 230, 245, 0.38);
          border-radius: 16px;
          box-shadow: 0 18px 40px rgba(4, 20, 56, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.22);
          padding: 8px;
          animation: fadeIn 0.14s ease-out;
        }
        .popover-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 2px 4px 6px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.16);
          margin-bottom: 6px;
        }
        .popover-title {
          font-size: 11px;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.94);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .badge {
          background: rgba(255, 255, 255, 0.18);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.24);
          border-radius: 6px;
          padding: 1px 6px;
          font-size: 9.5px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .badge-warn {
          background: rgba(239, 68, 68, 0.32);
          border-color: rgba(254, 202, 202, 0.4);
          color: #ffffff;
        }
        .close-x {
          background: transparent;
          border: none;
          color: rgba(255, 255, 255, 0.75);
          font-size: 15px;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 6px;
          line-height: 1;
        }
        .close-x:hover { background: rgba(255, 255, 255, 0.18); color: #ffffff; }
        .candidate-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 6px;
        }
        .candidate-btn {
          background: rgba(255, 255, 255, 0.14);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 9px;
          padding: 5px 10px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
        }
        .candidate-btn:hover {
          background: rgba(46, 209, 230, 0.38);
          border-color: rgba(255, 255, 255, 0.5);
          color: #ffffff;
        }
        .gemini-context-btn {
          width: 100%;
          background: rgba(255, 255, 255, 0.12);
          color: #e0f7fa;
          border: 1px dashed rgba(130, 240, 252, 0.5);
          border-radius: 9px;
          padding: 6px 10px;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .gemini-context-btn:hover {
          background: rgba(46, 209, 230, 0.32);
          border-color: #ffffff;
        }
        .contextual-results {
          margin-top: 6px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .contextual-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .contextual-reason {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.78);
        }
        .suggestion-list {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .action-grid {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .action-btn {
          background: rgba(255, 255, 255, 0.12);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.20);
          border-radius: 9px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          text-align: left;
          transition: background 0.12s ease, border-color 0.12s ease;
        }
        .action-btn:hover {
          background: rgba(46, 209, 230, 0.38);
          border-color: rgba(255, 255, 255, 0.48);
          color: #ffffff;
        }
        .action-btn-primary {
          background: rgba(25, 184, 214, 0.34);
          border-color: rgba(115, 240, 250, 0.44);
          color: #ffffff;
          font-weight: 600;
        }
        .action-btn-primary:hover {
          background: rgba(46, 209, 230, 0.48);
          border-color: rgba(255, 255, 255, 0.58);
          color: #ffffff;
        }
        .ask-form {
          display: flex;
          gap: 5px;
          margin-top: 6px;
          padding-top: 6px;
          border-top: 1px solid rgba(255, 255, 255, 0.16);
        }
        .ask-input {
          flex: 1;
          min-width: 0;
          background: rgba(5, 16, 36, 0.45);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 8px;
          padding: 5px 8px;
          font-size: 11.5px;
          outline: none;
        }
        .ask-input::placeholder {
          color: rgba(255, 255, 255, 0.55);
        }
        .ask-input:focus {
          border-color: rgba(115, 240, 250, 0.65);
        }
        .ask-send {
          background: rgba(25, 184, 214, 0.45);
          color: #ffffff;
          border: 1px solid rgba(115, 240, 250, 0.45);
          border-radius: 8px;
          padding: 0 9px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .ask-answer {
          font-size: 12px;
          line-height: 1.45;
          color: #f0f9ff;
          max-height: 150px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          margin-bottom: 8px;
        }
        .ask-answer-actions {
          display: flex;
          gap: 6px;
        }
        .action-btn-secondary {
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.85);
          border-style: dashed;
          font-size: 11px;
          padding: 5px 8px;
        }
        .inline-result-box {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 2px;
        }
        .inline-result-text {
          font-size: 12.5px;
          line-height: 1.45;
          color: #ffffff;
          background: rgba(4, 18, 48, 0.36);
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 9px;
          padding: 8px 10px;
          white-space: pre-wrap;
          max-height: 200px;
          overflow-y: auto;
          user-select: text;
        }
        .inline-result-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }
        .suggestion-option-btn {
          width: 100%;
          text-align: left;
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 9px;
          padding: 8px 10px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .suggestion-option-btn:hover {
          background: #eef2ff;
          border-color: #818cf8;
        }
        .opt-header {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .opt-badge {
          background: #e0e7ff;
          color: #3730a3;
          font-size: 10px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: 5px;
          text-transform: uppercase;
        }
        .opt-text {
          font-size: 13px;
          color: #111827;
          line-height: 1.4;
          font-weight: 500;
        }
        .opt-desc {
          font-size: 11px;
          color: #6b7280;
        }
        .inline-status,
        .loading-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.90);
          padding: 6px 4px;
        }
        .inline-error {
          font-size: 12px;
          color: #fecaca;
          background: rgba(127, 29, 29, 0.55);
          border: 1px solid rgba(254, 202, 202, 0.35);
          border-radius: 9px;
          padding: 7px 9px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .inline-settings-btn {
          align-self: flex-start;
          background: rgba(25, 184, 214, 0.45);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.35);
          border-radius: 7px;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }
        .toast {
          position: fixed;
          pointer-events: auto;
          bottom: 20px;
          right: 20px;
          max-width: 380px;
          background: #111827;
          color: #f9fafb;
          padding: 12px 16px;
          border-radius: 12px;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
          border: 1px solid rgba(255, 255, 255, 0.12);
          font-size: 13px;
          line-height: 1.45;
          display: flex;
          align-items: center;
          gap: 10px;
          z-index: 2147483647;
          animation: fadeIn 0.16s ease-out;
        }
        .toast.error { background: #7f1d1d; border-color: rgba(254, 202, 202, 0.25); }
        .toast.success { background: #064e3b; border-color: rgba(167, 243, 208, 0.25); }
        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255, 255, 255, 0.28);
          border-top-color: #60a5fa;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          flex-shrink: 0;
        }
        .spinner-dark {
          width: 14px;
          height: 14px;
          border: 2px solid #e5e7eb;
          border-top-color: #4f46e5;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          flex-shrink: 0;
        }
        .toast-btn {
          background: rgba(255, 255, 255, 0.16);
          color: #fff;
          border: none;
          border-radius: 7px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .toast-btn:hover { background: rgba(255, 255, 255, 0.26); }
        .backdrop {
          position: fixed;
          pointer-events: auto;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          backdrop-filter: blur(2px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 2147483647;
          animation: fadeIn 0.15s ease-out;
        }
        .modal {
          width: 100%;
          max-width: 560px;
          max-height: 80vh;
          background: #ffffff;
          color: #111827;
          border-radius: 14px;
          box-shadow: 0 24px 50px rgba(0, 0, 0, 0.28);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid #e5e7eb;
        }
        .modal-header {
          padding: 14px 18px;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #f9fafb;
        }
        .modal-title {
          font-size: 15px;
          font-weight: 700;
          color: #111827;
        }
        .modal-body {
          padding: 16px 18px;
          font-size: 14px;
          line-height: 1.6;
          color: #1f2937;
          white-space: pre-wrap;
          overflow-y: auto;
          user-select: text;
        }
        .modal-footer {
          padding: 12px 18px;
          border-top: 1px solid #e5e7eb;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          background: #f9fafb;
        }
        .btn {
          border: 1px solid #d1d5db;
          background: #ffffff;
          color: #111827;
          border-radius: 8px;
          padding: 7px 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn:hover { background: #f3f4f6; }
        .btn-primary {
          background: #4f46e5;
          border-color: #4f46e5;
          color: #ffffff;
        }
        .btn-primary:hover { background: #4338ca; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `;

      const underlines = document.createElement("div");
      underlines.id = "text-tools-underlines";

      const floating = document.createElement("div");
      floating.id = "text-tools-floating";

      const slotTrigger = document.createElement("div");
      slotTrigger.id = "slot-trigger";
      const slotMenu = document.createElement("div");
      slotMenu.id = "slot-menu";
      const slotUndo = document.createElement("div");
      slotUndo.id = "slot-undo";

      floating.appendChild(slotTrigger);
      floating.appendChild(slotMenu);
      floating.appendChild(slotUndo);

      const container = document.createElement("div");
      container.id = "root";

      shadow.appendChild(style);
      shadow.appendChild(underlines);
      shadow.appendChild(floating);
      shadow.appendChild(container);
    }

    return host.shadowRoot;
  }

  function getShadowRoot() {
    return ensureShadowStructure().getElementById("root");
  }

  function getSlot(slotId) {
    const sr = ensureShadowStructure();
    return sr.getElementById(slotId);
  }

  function clearRoot() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    const root = getShadowRoot();
    root.innerHTML = "";
    return root;
  }

  function preventBlurOnMouseDown(el) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
  }

  function clampPosition(left, top, approxWidth = 280, approxHeight = 160) {
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    const clampedLeft = Math.max(8, Math.min(vw - approxWidth - 8, left));
    let clampedTop = top;
    if (clampedTop + approxHeight > vh - 8) {
      clampedTop = Math.max(8, top - approxHeight - 28);
    }
    clampedTop = Math.max(8, Math.min(vh - Math.min(approxHeight, vh - 16) - 8, clampedTop));
    return { left: Math.round(clampedLeft), top: Math.round(clampedTop) };
  }

  // --- Toast & Modal UI ---
  function showToast({ message, variant = "info", loading = false, duration = 3500, openOptions = false }) {
    const root = clearRoot();
    const toast = document.createElement("div");
    toast.className = `toast ${variant}`;
    toast.setAttribute("role", variant === "error" ? "alert" : "status");

    if (loading) {
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      toast.appendChild(spinner);
    }

    const span = document.createElement("span");
    span.textContent = message;
    toast.appendChild(span);

    if (openOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-btn";
      btn.textContent = "Open Settings";
      preventBlurOnMouseDown(btn);
      btn.addEventListener("click", () => {
        void sendRuntimeMessage({ type: "openOptions" }, { timeoutMs: 5000 });
        clearRoot();
      });
      toast.appendChild(btn);
    }

    root.appendChild(toast);
    if (duration > 0) {
      toastTimer = setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, duration);
    }
  }

  function showModal({ title, text, copiedNotice }) {
    const root = clearRoot();
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", title || "Result");

    const header = document.createElement("div");
    header.className = "modal-header";
    const titleEl = document.createElement("div");
    titleEl.className = "modal-title";
    titleEl.textContent = title;
    const closeX = document.createElement("button");
    closeX.type = "button";
    closeX.className = "close-x";
    closeX.setAttribute("aria-label", "Close");
    closeX.textContent = "×";
    header.appendChild(titleEl);
    header.appendChild(closeX);

    const body = document.createElement("div");
    body.className = "modal-body";
    body.textContent = text;

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-primary";
    copyBtn.textContent = "Copy";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn";
    okBtn.textContent = "OK";
    footer.appendChild(copyBtn);
    footer.appendChild(okBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);

    closeX.addEventListener("click", close);
    okBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(text);
      if (ok) {
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => {
          close();
          if (copiedNotice) {
            showToast({ message: copiedNotice, variant: "success", duration: 2500 });
          }
        }, 450);
      }
    });
  }

  // --- Safe Programmatic Edit Wrapper ---
  function applyExtensionReplacement(editor, snapshot, newText) {
    if (!DomEditor || !editor || !snapshot) return false;
    isApplyingExtensionEdit = true;
    try {
      return DomEditor.replaceRangeSafely(editor, snapshot, newText);
    } finally {
      isApplyingExtensionEdit = false;
    }
  }

  // --- Undo Pill UI ---
  function hideUndoPill() {
    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
    activeUndoState = null;
    const host = document.getElementById(HOST_ID);
    if (!host?.shadowRoot) return;
    const slot = host.shadowRoot.getElementById("slot-undo");
    if (slot) slot.innerHTML = "";
  }

  function isUndoStateStillValid(state) {
    if (!state || !state.editor || !DomEditor) return false;
    const editor = state.editor;
    if (editor.isConnected === false) return false;
    const fullText =
      editor.tagName === "INPUT" || editor.tagName === "TEXTAREA"
        ? String(editor.value ?? "")
        : DomEditor.buildContentEditableTextModel(editor).fullText;
    if (fullText.slice(state.start, state.end) !== state.correctedWord) {
      return false;
    }
    const prevCh = state.start > 0 ? fullText[state.start - 1] : "";
    const nextCh = state.end < fullText.length ? fullText[state.end] : "";
    if ((prevCh && /[\p{L}\p{N}_]/u.test(prevCh)) || (nextCh && /[\p{L}\p{N}_]/u.test(nextCh))) {
      return false;
    }
    return true;
  }

  function performUndoEntry(entryState) {
    if (!entryState || !UndoManager || !DomEditor) return false;
    if (!isUndoStateStillValid(entryState)) {
      hideUndoPill();
      return false;
    }
    const consumed = UndoManager.consume(entryState.undoId);
    if (!consumed) return false;

    const kind =
      entryState.editor.tagName === "INPUT" || entryState.editor.tagName === "TEXTAREA"
        ? "input"
        : "contenteditable";

    const ok = applyExtensionReplacement(
      entryState.editor,
      {
        kind,
        el: entryState.editor,
        start: consumed.start,
        end: consumed.end,
        expectedOriginal: consumed.correctedWord,
        preserveTrailingCaret: true
      },
      consumed.originalWord
    );

    if (ok) {
      recordHabitIgnore(consumed.originalWord, consumed.correctedWord);
    }

    hideUndoPill();
    return ok;
  }

  function showUndoPill(undoState) {
    hideUndoPill();
    activeUndoState = undoState;

    const slot = getSlot("slot-undo");
    const pill = document.createElement("div");
    pill.className = "undo-pill";
    pill.setAttribute("role", "status");

    const rect = DomEditor?.getSpanRect(undoState.editor, {
      start: undoState.start,
      end: undoState.end
    });
    const pos = rect
      ? clampPosition(rect.left, rect.bottom + 8, 280, 36)
      : { left: 16, top: Math.max(12, (window.innerHeight || 600) - 56) };

    pill.style.left = `${pos.left}px`;
    pill.style.top = `${pos.top}px`;

    const textEl = document.createElement("span");
    textEl.className = "undo-text";
    textEl.textContent = `${undoState.originalWord} → ${undoState.correctedWord}`;

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "undo-btn";
    undoBtn.setAttribute("data-action", "undo");
    undoBtn.setAttribute("aria-label", "Geri al (Undo)");
    undoBtn.textContent = "Geri al (Undo)";
    preventBlurOnMouseDown(undoBtn);
    undoBtn.addEventListener("click", () => {
      performUndoEntry(undoState);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pill-close";
    closeBtn.setAttribute("aria-label", "Dismiss undo");
    closeBtn.textContent = "×";
    preventBlurOnMouseDown(closeBtn);
    closeBtn.addEventListener("click", hideUndoPill);

    pill.appendChild(textEl);
    pill.appendChild(undoBtn);
    pill.appendChild(closeBtn);
    slot.appendChild(pill);

    undoTimer = setTimeout(() => {
      hideUndoPill();
    }, 1200);
  }

  // --- Uncertain Word Popover & Underline ---
  function clearUncertainState({ keepMenuIfSuggestion = false } = {}) {
    if (activeUncertain?.editor && DomEditor) {
      DomEditor.setUncertainUnderline(activeUncertain.editor, null);
    }
    activeUncertain = null;
    if (!keepMenuIfSuggestion || activeMenuMode === "uncertain") {
      closeFloatingMenu();
    }
  }

  function closeFloatingMenu() {
    activeMenuMode = null;
    const host = document.getElementById(HOST_ID);
    if (!host?.shadowRoot) return;
    const slot = host.shadowRoot.getElementById("slot-menu");
    if (slot) slot.innerHTML = "";
  }

  function isUncertainSpanStillValid(state) {
    if (!state || !state.editor || !DomEditor) return false;
    const editor = state.editor;
    if (editor.isConnected === false) return false;
    if (editor.tagName === "INPUT" || editor.tagName === "TEXTAREA") {
      const val = String(editor.value ?? "");
      return val.slice(state.span.start, state.span.end) === state.word;
    }
    if (state.span.domRange) {
      try {
        if (editor.contains(state.span.domRange.startContainer)) {
          return state.span.domRange.toString() === state.word;
        }
      } catch {
        return false;
      }
    }
    const model = DomEditor.buildContentEditableTextModel(editor);
    return model.fullText.slice(state.span.start, state.span.end) === state.word;
  }

  function getLiveSentenceForUncertain(state) {
    if (!state || !state.editor || !DomEditor) {
      return state?.sentence || state?.word || "";
    }
    try {
      const editor = state.editor;
      const isInput = editor.tagName === "INPUT" || editor.tagName === "TEXTAREA";
      const fullText = isInput
        ? String(editor.value ?? "")
        : DomEditor.buildContentEditableTextModel(editor).fullText;
      if (!fullText || !fullText.trim()) {
        return state.sentence || state.word || "";
      }
      const sentences = DomEditor.segmentSentences(fullText);
      if (!Array.isArray(sentences) || sentences.length === 0) {
        return state.sentence || state.word || "";
      }
      const spanStart = typeof state.span?.start === "number" ? state.span.start : -1;
      const spanEnd = typeof state.span?.end === "number" ? state.span.end : spanStart;
      if (spanStart >= 0) {
        const exactMatch = sentences.find((s) => spanStart >= s.start && spanEnd <= s.end);
        if (exactMatch?.text) return exactMatch.text;
        const overlapMatch = sentences.find((s) => spanStart >= s.start && spanStart <= s.end);
        if (overlapMatch?.text) return overlapMatch.text;
      }
      const activeSentence = DomEditor.extractSentenceOrSelection(editor);
      if (activeSentence?.text && activeSentence.text.includes(state.word)) {
        return activeSentence.text;
      }
    } catch {
      // Fall back to initial sentence snapshot if live extraction fails
    }
    return state.sentence || state.word || "";
  }

  function showUncertainPopover(uncertainState) {
    activeUncertain = uncertainState;
    activeMenuMode = "uncertain";

    const slot = getSlot("slot-menu");
    slot.innerHTML = "";

    const pop = document.createElement("div");
    pop.className = "popover uncertain-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Word suggestions");

    const rect = DomEditor?.getSpanRect(uncertainState.editor, uncertainState.span);
    const pos = rect
      ? clampPosition(rect.left, rect.bottom + 8, 280, 170)
      : { left: 16, top: 64 };
    pop.style.left = `${pos.left}px`;
    pop.style.top = `${pos.top}px`;

    const header = document.createElement("div");
    header.className = "popover-header";

    const title = document.createElement("div");
    title.className = "popover-title";
    const wordSpan = document.createElement("span");
    wordSpan.textContent = uncertainState.word;
    const badge = document.createElement("span");
    badge.className = "badge badge-warn";
    badge.textContent = "Uncertain";
    title.appendChild(wordSpan);
    title.appendChild(badge);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-x";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    preventBlurOnMouseDown(closeBtn);
    closeBtn.addEventListener("click", () => {
      if (uncertainState?.word) {
        recordHabitIgnore(uncertainState.word, null);
      }
      clearUncertainState();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    pop.appendChild(header);

    const applyCandidate = (newWord) => {
      const ok = applyExtensionReplacement(uncertainState.editor, uncertainState.span, newWord);
      if (ok) {
        recordHabitCorrection(uncertainState.word, newWord, 2, uncertainState.prevWord || "");
        clearUncertainState();
        scheduleFloatingTriggerUpdate();
      }
    };

    const candidates = (uncertainState.candidates || []).slice(0, 5);
    if (candidates.length > 0) {
      const list = document.createElement("div");
      list.className = "candidate-list";
      for (const c of candidates) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "candidate-btn";
        btn.setAttribute("data-word", c.word);
        btn.textContent = c.word;
        preventBlurOnMouseDown(btn);
        btn.addEventListener("click", () => applyCandidate(c.word));
        list.appendChild(btn);
      }
      pop.appendChild(list);
    }

    // Manual-only Contextual Word Lookup button
    const ctxBtn = document.createElement("button");
    ctxBtn.type = "button";
    ctxBtn.className = "gemini-context-btn";
    ctxBtn.setAttribute("data-action", "ask-gemini-context");
    ctxBtn.setAttribute("aria-label", "Ask AI (Context) — Bağlamdan Kelime Bul");
    ctxBtn.textContent = "✨ Ask Gemini (Context)";
    preventBlurOnMouseDown(ctxBtn);

    const ctxResults = document.createElement("div");
    ctxResults.className = "contextual-results";

    ctxBtn.addEventListener("click", () => {
      ctxBtn.disabled = true;
      ctxResults.innerHTML = "";
      const status = document.createElement("div");
      status.className = "inline-status";
      const sp = document.createElement("div");
      sp.className = "spinner-dark";
      const stTxt = document.createElement("span");
      stTxt.textContent = "Searching context with AI...";
      status.appendChild(sp);
      status.appendChild(stTxt);
      ctxResults.appendChild(status);

      const liveSentence = getLiveSentenceForUncertain(uncertainState);

      sendRuntimeMessage(
        {
          type: "geminiContextualWord",
          sentence: liveSentence,
          targetWord: uncertainState.word,
          primaryLang: settings.primaryLanguage,
          secondaryLang: settings.secondaryLanguage
        },
        { timeoutMs: 90000 },
        (res) => {
          ctxBtn.disabled = false;
          ctxResults.innerHTML = "";
          if (!res || !res.ok) {
            const errBox = document.createElement("div");
            errBox.className = "inline-error";
            const msg = document.createElement("span");
            msg.textContent = res?.error || "AI context lookup failed.";
            errBox.appendChild(msg);
            if (res?.openOptions) {
              const optBtn = document.createElement("button");
              optBtn.type = "button";
              optBtn.className = "inline-settings-btn";
              optBtn.textContent = "Open Settings";
              preventBlurOnMouseDown(optBtn);
              optBtn.addEventListener("click", () => {
                void sendRuntimeMessage({ type: "openOptions" }, { timeoutMs: 5000 });
              });
              errBox.appendChild(optBtn);
            }
            ctxResults.appendChild(errBox);
            return;
          }

          for (const item of res.suggestions || []) {
            const row = document.createElement("div");
            row.className = "contextual-row";
            const wBtn = document.createElement("button");
            wBtn.type = "button";
            wBtn.className = "candidate-btn contextual-candidate-btn";
            wBtn.setAttribute("data-word", item.word);
            wBtn.textContent = item.word;
            preventBlurOnMouseDown(wBtn);
            wBtn.addEventListener("click", () => applyCandidate(item.word));
            row.appendChild(wBtn);

            if (item.reason) {
              const reason = document.createElement("span");
              reason.className = "contextual-reason";
              reason.textContent = item.reason;
              row.appendChild(reason);
            }
            ctxResults.appendChild(row);
          }
        }
      );
    });

    pop.appendChild(ctxBtn);
    pop.appendChild(ctxResults);
    slot.appendChild(pop);
  }

  // --- Floating Sentence / Selection Trigger & Suggestion Menu ---
  function hideFloatingTrigger() {
    const host = document.getElementById(HOST_ID);
    if (!host?.shadowRoot) return;
    const slot = host.shadowRoot.getElementById("slot-trigger");
    if (slot) slot.innerHTML = "";
  }

  function showFloatingTrigger(editor, extraction) {
    const slot = getSlot("slot-trigger");
    slot.innerHTML = "";

    const rect = DomEditor?.getCaretOrSelectionRect(editor, extraction.rangeSnapshot);
    if (!rect) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "trigger-btn";
    btn.setAttribute("data-role", "sentence-trigger");
    btn.setAttribute("aria-label", "AI Suggestions");
    btn.setAttribute("title", "AI Suggestions");
    btn.textContent = "✦";

    const pos = clampPosition(rect.right + 6, rect.bottom + 4, 30, 30);
    btn.style.left = `${pos.left}px`;
    btn.style.top = `${pos.top}px`;

    preventBlurOnMouseDown(btn);
    btn.addEventListener("click", () => {
      const freshExtraction = DomEditor.extractSentenceOrSelection(editor) || extraction;
      openSentenceSuggestionMenu(editor, freshExtraction, pos);
    });

    slot.appendChild(btn);
  }

  function openSentenceSuggestionMenu(editor, extraction, anchorPos) {
    if (!extraction || !extraction.text) return;
    clearUncertainState({ keepMenuIfSuggestion: true });
    activeMenuMode = "suggestions";

    const slot = getSlot("slot-menu");
    slot.innerHTML = "";

    const menu = document.createElement("div");
    menu.className = "popover suggestion-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "AI Actions");

    const pos = clampPosition(anchorPos.left, anchorPos.top + 32, 330, 220);
    menu.style.left = `${pos.left}px`;
    menu.style.top = `${pos.top}px`;

    const header = document.createElement("div");
    header.className = "popover-header";

    const title = document.createElement("div");
    title.className = "popover-title";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = "Text AI Tools";
    const modeBadge = document.createElement("span");
    modeBadge.className = "badge";
    modeBadge.textContent = extraction.mode === "selection" ? "Selection" : "Sentence";
    title.appendChild(labelSpan);
    title.appendChild(modeBadge);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-x";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    preventBlurOnMouseDown(closeBtn);
    closeBtn.addEventListener("click", closeFloatingMenu);

    header.appendChild(title);
    header.appendChild(closeBtn);
    menu.appendChild(header);

    const bodyContainer = document.createElement("div");
    bodyContainer.className = "suggestion-list";
    menu.appendChild(bodyContainer);
    slot.appendChild(menu);

    const isEditableTarget = Boolean(editor && extraction.rangeSnapshot?.kind !== "readonly");

    const renderError = (errMsg, openOptions) => {
      bodyContainer.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "inline-error";
      const msg = document.createElement("span");
      msg.textContent = errMsg;
      errBox.appendChild(msg);
      if (openOptions) {
        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = "inline-settings-btn";
        optBtn.textContent = "Open Settings";
        preventBlurOnMouseDown(optBtn);
        optBtn.addEventListener("click", () => {
          void sendRuntimeMessage({ type: "openOptions" }, { timeoutMs: 5000 });
        });
        errBox.appendChild(optBtn);
      }
      bodyContainer.appendChild(errBox);
    };

    const renderLoading = (label) => {
      bodyContainer.innerHTML = "";
      const status = document.createElement("div");
      status.className = "inline-status";
      const sp = document.createElement("div");
      sp.className = "spinner-dark";
      const stTxt = document.createElement("span");
      stTxt.textContent = label;
      status.appendChild(sp);
      status.appendChild(stTxt);
      bodyContainer.appendChild(status);
    };

    const applyAndRecordUndo = (newText) => {
      const origText = extraction.text;
      const ok = applyExtensionReplacement(editor, extraction.rangeSnapshot, newText);
      closeFloatingMenu();
      if (ok) {
        if (UndoManager && typeof extraction.start === "number") {
          const newEnd = extraction.start + newText.length;
          const undoId = UndoManager.recordAutoCorrect({
            targetRef: editor,
            start: extraction.start,
            end: newEnd,
            originalWord: origText,
            correctedWord: newText
          });
          activeUndoState = {
            editor,
            undoId,
            start: extraction.start,
            end: newEnd,
            originalWord: origText,
            correctedWord: newText,
            boundaryChar: ""
          };
        }
        clearUncertainState({ keepMenuIfSuggestion: false });
        scheduleFloatingTriggerUpdate();
      }
      return ok;
    };

    const runSingleAction = (actionId, label) => {
      renderLoading(`Running ${label}...`);
      sendRuntimeMessage(
        {
          type: "geminiInlineAction",
          actionId,
          text: extraction.text,
          primaryLang: settings.primaryLanguage,
          secondaryLang: settings.secondaryLanguage
        },
        { timeoutMs: 90000 },
        (res) => {
          if (activeMenuMode !== "suggestions") return;
          if (!res || !res.ok) {
            renderError(res?.error || "AI request failed.", res?.openOptions);
            return;
          }

          const outText = String(res.result || "").trim();
          if (res.mode === "replace" && isEditableTarget) {
            const applied = applyAndRecordUndo(outText);
            if (applied) return;
          }

          bodyContainer.innerHTML = "";
          const box = document.createElement("div");
          box.className = "inline-result-box";
          const txt = document.createElement("div");
          txt.className = "inline-result-text";
          txt.textContent = outText;
          box.appendChild(txt);

          const actionsRow = document.createElement("div");
          actionsRow.className = "inline-result-actions";
          if (isEditableTarget) {
            const replaceBtn = document.createElement("button");
            replaceBtn.type = "button";
            replaceBtn.className = "action-btn action-btn-primary";
            replaceBtn.textContent = "Apply";
            preventBlurOnMouseDown(replaceBtn);
            replaceBtn.addEventListener("click", () => applyAndRecordUndo(outText));
            actionsRow.appendChild(replaceBtn);
          }
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "action-btn";
          copyBtn.textContent = "Copy";
          preventBlurOnMouseDown(copyBtn);
          copyBtn.addEventListener("click", async () => {
            const copied = await copyText(outText);
            if (copied) {
              copyBtn.textContent = "Copied ✓";
              setTimeout(closeFloatingMenu, 500);
            }
          });
          actionsRow.appendChild(copyBtn);
          box.appendChild(actionsRow);
          bodyContainer.appendChild(box);
        }
      );
    };

    const runThreeOptions = () => {
      renderLoading("Getting 3 options...");
      sendRuntimeMessage(
        {
          type: "geminiSentenceSuggestions",
          text: extraction.text,
          mode: extraction.mode,
          primaryLang: settings.primaryLanguage,
          secondaryLang: settings.secondaryLanguage
        },
        { timeoutMs: 90000 },
        (res) => {
          if (activeMenuMode !== "suggestions") return;
          bodyContainer.innerHTML = "";
          if (!res || !res.ok) {
            renderError(res?.error || "Failed to fetch suggestions.", res?.openOptions);
            return;
          }

          for (const opt of res.options || []) {
            const optBtn = document.createElement("button");
            optBtn.type = "button";
            optBtn.className = "suggestion-option-btn";
            optBtn.setAttribute("role", "menuitem");
            optBtn.setAttribute("data-category", opt.category || "grammar");

            const optHeader = document.createElement("div");
            optHeader.className = "opt-header";
            const badge = document.createElement("span");
            badge.className = "opt-badge";
            badge.textContent = opt.label || opt.category || "Option";
            optHeader.appendChild(badge);
            optBtn.appendChild(optHeader);

            const textEl = document.createElement("span");
            textEl.className = "opt-text";
            textEl.textContent = opt.text;
            optBtn.appendChild(textEl);

            if (opt.explanation) {
              const desc = document.createElement("span");
              desc.className = "opt-desc";
              desc.textContent = opt.explanation;
              optBtn.appendChild(desc);
            }

            preventBlurOnMouseDown(optBtn);
            optBtn.addEventListener("click", () => applyAndRecordUndo(opt.text));
            bodyContainer.appendChild(optBtn);
          }
        }
      );
    };

    // Render direct action choices immediately (ZERO AI calls until clicked!)
    const grid = document.createElement("div");
    grid.className = "action-grid";

    const actionsToShow = isEditableTarget
      ? [
          { id: "fix", label: "Proofread", primary: true },
          { id: "concise", label: "Shorten", primary: false },
          { id: "professional", label: "Professional", primary: false },
          { id: "translate", label: "Translate", primary: false },
          { id: "summarize", label: "Summarize", primary: false },
          { id: "keypoints", label: "Key Points", primary: false }
        ]
      : [
          { id: "translate", label: "Translate", primary: true },
          { id: "summarize", label: "Summarize", primary: false },
          { id: "keypoints", label: "Key Points", primary: false }
        ];

    for (const act of actionsToShow) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = act.primary ? "action-btn action-btn-primary" : "action-btn";
      b.setAttribute("role", "menuitem");
      b.setAttribute("data-inline-action", act.id);
      b.textContent = act.label;
      preventBlurOnMouseDown(b);
      b.addEventListener("click", () => runSingleAction(act.id, act.label));
      grid.appendChild(b);
    }

    bodyContainer.appendChild(grid);

    const qaHistory = [];
    const renderQAView = (errorMsg = "", { openOptions = false } = {}) => {
      bodyContainer.innerHTML = "";
      if (qaHistory.length > 0) {
        const thread = document.createElement("div");
        thread.className = "ask-answer";
        preventBlurOnMouseDown(thread);
        thread.textContent = qaHistory
          .map((item) => (item.role === "user" ? `› ${item.text}` : item.text))
          .join("\n\n");
        bodyContainer.appendChild(thread);
        thread.scrollTop = thread.scrollHeight;
      }

      if (errorMsg) {
        const errBox = document.createElement("div");
        errBox.className = "inline-error ask-error";
        const msg = document.createElement("span");
        msg.textContent = errorMsg;
        errBox.appendChild(msg);
        if (openOptions) {
          const optBtn = document.createElement("button");
          optBtn.type = "button";
          optBtn.className = "inline-settings-btn";
          optBtn.textContent = "Open Settings";
          preventBlurOnMouseDown(optBtn);
          optBtn.addEventListener("click", () => {
            void sendRuntimeMessage({ type: "openOptions" }, { timeoutMs: 5000 });
          });
          errBox.appendChild(optBtn);
        }
        bodyContainer.appendChild(errBox);
      }

      const followForm = document.createElement("form");
      followForm.className = "ask-form";
      const followInput = document.createElement("input");
      followInput.type = "text";
      followInput.className = "ask-input";
      followInput.placeholder = qaHistory.length > 0 ? "Ask follow-up…" : "Ask AI about this…";
      const followSend = document.createElement("button");
      followSend.type = "submit";
      followSend.className = "ask-send";
      followSend.textContent = "→";
      preventBlurOnMouseDown(followSend);
      followForm.appendChild(followInput);
      followForm.appendChild(followSend);
      followForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        submitQuestion(followInput.value.trim());
      });
      bodyContainer.appendChild(followForm);
      followInput.focus();
    };

    const submitQuestion = async (q) => {
      if (!q) return;
      bodyContainer.innerHTML = "";
      const loadingRow = document.createElement("div");
      loadingRow.className = "loading-row";
      const sp = document.createElement("div");
      sp.className = "spinner";
      const lbl = document.createElement("span");
      lbl.textContent = "Thinking…";
      loadingRow.appendChild(sp);
      loadingRow.appendChild(lbl);
      bodyContainer.appendChild(loadingRow);

      try {
        const res = await sendRuntimeMessage(
          {
            type: "askAIQuestion",
            question: q,
            text: extraction.text,
            history: qaHistory,
            primaryLang: settings.primaryLanguage,
            secondaryLang: settings.secondaryLanguage
          },
          { timeoutMs: 90000 }
        );
        if (activeMenuMode !== "suggestions") return;
        if (!res?.ok) {
          renderQAView(res?.error || "Request failed.", { openOptions: Boolean(res?.openOptions) });
          return;
        }
        qaHistory.push({ role: "user", text: q });
        qaHistory.push({ role: "assistant", text: (res.result || "").trim() });
        renderQAView();
      } catch (err) {
        if (activeMenuMode !== "suggestions") return;
        renderQAView(err?.message || "Request failed.");
      }
    };

    const askForm = document.createElement("form");
    askForm.className = "ask-form";
    const askInput = document.createElement("input");
    askInput.type = "text";
    askInput.className = "ask-input";
    askInput.placeholder = "Ask AI about this…";
    const askSend = document.createElement("button");
    askSend.type = "submit";
    askSend.className = "ask-send";
    askSend.textContent = "→";
    preventBlurOnMouseDown(askSend);
    askForm.appendChild(askInput);
    askForm.appendChild(askSend);

    askForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitQuestion(askInput.value.trim());
    });

    bodyContainer.appendChild(askForm);
  }

  function updateFloatingTriggerNow() {
    if (!DomEditor) return;
    if (activeEditor && activeEditor.isConnected === false) {
      activeEditor = null;
    }
    const deepActive = getDeepActiveElement();
    const editor =
      (activeEditor && DomEditor.isEligibleEditor(activeEditor) && activeEditor) ||
      DomEditor.resolveEditableTarget(deepActive);

    if (editor && (!deepActive || editor.contains(deepActive) || deepActive === editor)) {
      const extracted = DomEditor.extractSentenceOrSelection(editor);
      if (extracted) {
        if (extracted.mode === "selection") {
          showFloatingTrigger(editor, extracted);
          return;
        }
        if (extracted.mode === "sentence" && DomEditor.isCaretAtSentenceEnd(editor)) {
          showFloatingTrigger(editor, extracted);
          return;
        }
      }
      hideFloatingTrigger();
      return;
    }

    // Read-only webpage selection support (Translate / Summarize anywhere)
    const roExtracted = DomEditor.extractSentenceOrSelection(null);
    if (roExtracted && roExtracted.mode === "selection" && roExtracted.text.trim().length > 0) {
      showFloatingTrigger(null, roExtracted);
      return;
    }

    hideFloatingTrigger();
  }

  function scheduleFloatingTriggerUpdate() {
    if (selectionUpdateTimer) {
      clearTimeout(selectionUpdateTimer);
    }
    selectionUpdateTimer = setTimeout(() => {
      selectionUpdateTimer = null;
      updateFloatingTriggerNow();
    }, 30);
  }

  // --- Word-End Local Spellcheck Pipeline (ZERO Gemini Calls!) ---
  function evaluateWordBoundary(editor, extracted) {
    if (!SpellcheckEngine || !extracted) return;

    const inputType =
      editor.tagName === "INPUT"
        ? String(editor.type || editor.getAttribute("type") || "text").toLowerCase()
        : "";

    const prevWord =
      Array.isArray(extracted.contextTokens) && extracted.contextTokens.length > 0
        ? extracted.contextTokens[extracted.contextTokens.length - 1]
        : "";
    const domain = getCurrentDomain();

    const result = SpellcheckEngine.checkWord({
      word: extracted.word,
      contextTokens: extracted.contextTokens,
      primaryLang: settings.primaryLanguage,
      secondaryLang: settings.secondaryLanguage,
      lexiconsByLang,
      autoCorrectEnabled: settings.autoCorrectEnabled,
      userHabits,
      context: { inputType, domain }
    });

    if (!result || result.decision === "skip") {
      return;
    }

    if (result.decision === "valid") {
      recordHabitWordUsage(extracted.word, prevWord);
      return;
    }

    if (result.decision === "auto_correct" && result.replacement && result.replacement !== extracted.word) {
      const ok = applyExtensionReplacement(editor, extracted.rangeSnapshot, result.replacement);
      if (ok && UndoManager) {
        recordHabitWordUsage(result.replacement, prevWord);
        if (PersonalModel) {
          PersonalModel.learnCharEdits(userHabits, extracted.word, result.replacement, 0.5);
          saveUserHabitsDebounced();
        }
        const newEnd = extracted.start + result.replacement.length;
        const undoId = UndoManager.recordAutoCorrect({
          targetRef: editor,
          start: extracted.start,
          end: newEnd,
          originalWord: extracted.word,
          correctedWord: result.replacement
        });

        // Clear uncertain underline only if this auto-correction replaced the uncertain word itself
        if (
          activeUncertain?.editor === editor &&
          activeUncertain.span?.start === extracted.start
        ) {
          clearUncertainState();
        }

        // Undo is handled silently via Ctrl+Z / Cmd+Z or immediate Backspace (no intrusive floating pill)
        activeUndoState = {
          editor,
          undoId,
          start: extracted.start,
          end: newEnd,
          originalWord: extracted.word,
          correctedWord: result.replacement,
          boundaryChar: extracted.boundaryChar
        };
      }
      return;
    }

    if (result.decision === "uncertain") {
      ensureShadowStructure();
      const span = {
        ...extracted.rangeSnapshot,
        start: extracted.start,
        end: extracted.end,
        word: extracted.word
      };
      DomEditor.setUncertainUnderline(editor, span);

      const sentenceExtract = DomEditor.extractSentenceOrSelection(editor);
      const sentenceText =
        sentenceExtract?.text ||
        [...(extracted.contextTokens || []), extracted.word].join(" ");

      showUncertainPopover({
        editor,
        word: extracted.word,
        span,
        candidates: result.candidates || [],
        sentence: sentenceText,
        prevWord
      });
    }
  }

  // --- DOM Event Listeners ---
  addManagedListener(document, "compositionstart", () => {
    isComposing = true;
  });

  addManagedListener(document, "compositionend", () => {
    isComposing = false;
  });

  addManagedListener(window, "blur", () => {
    isComposing = false;
  });

  addManagedListener(
    document,
    "focusin",
    (e) => {
      if (!DomEditor || !isRuntimeContextAlive()) return;
      const rawTarget = (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
      const editor = DomEditor.resolveEditableTarget(rawTarget);
      if (!editor) return;
      if (editor !== activeEditor) {
        isComposing = false;
      }
      activeEditor = editor;
      ensureLexiconsForActiveLanguages({ bypassCooldown: true });
      scheduleFloatingTriggerUpdate();
    },
    true
  );

  addManagedListener(
    document,
    "focusout",
    (e) => {
      isComposing = false;
      const next = e.relatedTarget;
      const host = document.getElementById(HOST_ID);
      const composedPath = typeof e.composedPath === "function" ? e.composedPath() : [];
      const fromShadowHost =
        Boolean(
          host &&
            e.target &&
            (e.target === host || host.contains?.(e.target) || host.shadowRoot?.contains?.(e.target))
        ) || composedPath.some((node) => node && node.id === HOST_ID);

      if (next && host && (next === host || host.contains?.(next) || host.shadowRoot?.contains?.(next))) {
        return;
      }
      if (activeMenuMode === "suggestions" && (fromShadowHost && !next || !next)) {
        return;
      }
      setTimeout(() => {
        if (!stateRecord.active || !isRuntimeContextAlive()) return;
        const currentActive = getDeepActiveElement();
        if (
          currentActive &&
          host &&
          (currentActive === host || host.contains?.(currentActive) || host.shadowRoot?.contains?.(currentActive))
        ) {
          return;
        }
        if (!DomEditor?.resolveEditableTarget(currentActive)) {
          hideFloatingTrigger();
          if (activeMenuMode === "uncertain" || activeMenuMode === "suggestions") {
            clearUncertainState({ keepMenuIfSuggestion: false });
            closeFloatingMenu();
          }
        }
      }, 120);
    },
    true
  );

  addManagedListener(
    document,
    "keydown",
    (e) => {
      if (isApplyingExtensionEdit || isComposing || e.isComposing) return;

      if (e.key === "Escape") {
        clearUncertainState({ keepMenuIfSuggestion: false });
        closeFloatingMenu();
        hideUndoPill();
        return;
      }

      const rawTarget = (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
      const editor = DomEditor?.resolveEditableTarget(rawTarget);
      if (!editor) return;

      const isPlainBackspace =
        e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const isUndoShortcut =
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        String(e.key || "").toLowerCase() === "z";

      if ((isPlainBackspace || isUndoShortcut) && UndoManager) {
        const latest = UndoManager.getLatest(editor);
        if (latest && Date.now() - latest.timestamp < 15000) {
          let matchesCurrent = false;
          if (editor.tagName === "INPUT" || editor.tagName === "TEXTAREA") {
            const val = String(editor.value ?? "");
            const caret = editor.selectionStart;
            const collapsed = caret === editor.selectionEnd;
            if (
              collapsed &&
              (caret === latest.end || caret === latest.end + 1) &&
              val.slice(latest.start, latest.end) === latest.correctedWord
            ) {
              matchesCurrent = true;
            }
          } else {
            const sel = DomEditor?.getSelectionForNode?.(editor) || window.getSelection?.();
            if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
              const extracted = DomEditor.extractWordBeforeCaret(editor);
              const atCorrectedEnd =
                extracted &&
                extracted.start === latest.start &&
                extracted.end === latest.end &&
                extracted.word === latest.correctedWord;
              if (atCorrectedEnd) {
                matchesCurrent = true;
              }
            }
          }

          if (matchesCurrent) {
            e.preventDefault();
            performUndoEntry({
              editor,
              undoId: latest.undoId,
              start: latest.start,
              end: latest.end,
              originalWord: latest.originalWord,
              correctedWord: latest.correctedWord
            });
            return;
          }
        }
      }

      if (activeUndoState && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        hideUndoPill();
      }
    },
    true
  );

  addManagedListener(
    document,
    "input",
    async (e) => {
      if (isApplyingExtensionEdit || isComposing || e.isComposing || !DomEditor || !isRuntimeContextAlive()) {
        return;
      }
      const rawTarget = (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
      const editor = DomEditor.resolveEditableTarget(rawTarget);
      if (!editor) return;

      activeEditor = editor;

      if (activeUncertain && activeUncertain.editor === editor && !isUncertainSpanStillValid(activeUncertain)) {
        clearUncertainState({ keepMenuIfSuggestion: true });
      }
      if (activeUndoState && activeUndoState.editor === editor) {
        hideUndoPill();
      }

      if (settings.spellcheckEnabled) {
        const extracted = DomEditor.extractWordBeforeCaret(editor);
        if (extracted) {
          if (hasAllActiveLexiconsLoaded()) {
            evaluateWordBoundary(editor, extracted);
          } else {
            scheduleFloatingTriggerUpdate();
            await ensureLexiconsForActiveLanguages({ bypassCooldown: false });
            if (!stateRecord.active || !isRuntimeContextAlive() || editor.isConnected === false) return;
            // Re-verify expectedOriginal before applying after async lexicon load
            const stillValid =
              editor.tagName === "INPUT" || editor.tagName === "TEXTAREA"
                ? String(editor.value ?? "").slice(extracted.start, extracted.end) === extracted.word
                : DomEditor.buildContentEditableTextModel(editor).fullText.slice(
                    extracted.start,
                    extracted.end
                  ) === extracted.word;
            if (stillValid && hasAllActiveLexiconsLoaded()) {
              evaluateWordBoundary(editor, extracted);
            }
          }
        }
      }

      scheduleFloatingTriggerUpdate();
    },
    true
  );

  addManagedListener(
    document,
    "mousedown",
    (e) => {
      if (!activeMenuMode) return;
      const host = document.getElementById(HOST_ID);
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const insideHost =
        path.some((node) => node && node.id === HOST_ID) ||
        Boolean(host && e.target && (e.target === host || host.contains?.(e.target)));
      if (!insideHost) {
        clearUncertainState({ keepMenuIfSuggestion: false });
        closeFloatingMenu();
      }
    },
    true
  );

  addManagedListener(document, "mouseup", () => {
    scheduleFloatingTriggerUpdate();
  });

  addManagedListener(document, "keyup", (e) => {
    if (e.key === "Escape") return;
    scheduleFloatingTriggerUpdate();
  });

  addManagedListener(document, "selectionchange", () => {
    scheduleFloatingTriggerUpdate();
  });

  addManagedListener(
    window,
    "scroll",
    () => {
      if (activeUncertain?.editor && DomEditor) {
        if (activeUncertain.editor.isConnected === false) {
          clearUncertainState({ keepMenuIfSuggestion: true });
        } else {
          DomEditor.setUncertainUnderline(activeUncertain.editor, activeUncertain.span);
        }
      }
      scheduleFloatingTriggerUpdate();
    },
    true
  );

  addManagedListener(window, "resize", () => {
    scheduleFloatingTriggerUpdate();
  });

  // --- Storage Change Listener ---
  try {
    if (chrome?.storage?.onChanged?.addListener) {
      storageChangedListener = (changes, area) => {
        if (area !== "local" || !stateRecord.active) return;
        let langChanged = false;
        if (changes.spellcheckEnabled) {
          settings.spellcheckEnabled = changes.spellcheckEnabled.newValue !== false;
          if (!settings.spellcheckEnabled) {
            clearUncertainState();
            hideUndoPill();
          }
        }
        if (changes.autoCorrectEnabled) {
          settings.autoCorrectEnabled = changes.autoCorrectEnabled.newValue !== false;
        }
        if (changes.primaryLanguage) {
          settings.primaryLanguage =
            String(changes.primaryLanguage.newValue || "Turkish").trim() || "Turkish";
          langChanged = true;
        }
        if (changes.secondaryLanguage) {
          settings.secondaryLanguage =
            String(changes.secondaryLanguage.newValue || "English").trim() || "English";
          langChanged = true;
        }
        if (changes.copyOnReplace) {
          settings.copyOnReplace = Boolean(changes.copyOnReplace.newValue);
        }
        if (changes.userHabits?.newValue) {
          mergeUserHabits(changes.userHabits.newValue);
        }
        if (langChanged && (lexiconsInitialized || activeEditor)) {
          ensureLexiconsForActiveLanguages({ bypassCooldown: true });
        }
      };
      chrome.storage.onChanged.addListener(storageChangedListener);
    }
  } catch {
    // Ignore outside extension context
  }

  // --- Context Menu / Shortcut Selection & Clipboard Helpers ---
  function captureSelection() {
    const active = getDeepActiveElement();
    // Never capture from password fields
    if (active && active.tagName === "INPUT" && String(active.type || "").toLowerCase() === "password") {
      savedSelection = null;
      return "";
    }

    if (DomEditor && DomEditor.isEligibleEditor(active)) {
      if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") {
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? 0;
        const text = active.value.slice(start, end);
        if (text) {
          savedSelection = {
            kind: "input",
            el: active,
            start,
            end,
            expectedOriginal: text,
            preserveTrailingCaret: false
          };
          return text;
        }
      } else {
        const extracted = DomEditor.extractSentenceOrSelection(active);
        if (extracted && extracted.mode === "selection") {
          savedSelection = extracted.rangeSnapshot;
          return extracted.text;
        }
      }
    }

    const sel = (DomEditor?.getSelectionForNode?.(active)) || window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const text = sel.toString();
      if (text) {
        const range = sel.getRangeAt(0).cloneRange();
        const container =
          range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        const editableHost = DomEditor?.resolveEditableTarget(active) || DomEditor?.resolveEditableTarget(container);
        savedSelection = {
          kind: editableHost ? "contenteditable" : "readonly",
          el: editableHost || null,
          domRange: range,
          range,
          expectedOriginal: text
        };
        return text;
      }
    }

    savedSelection = null;
    return "";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function replaceSavedSelection(newText) {
    if (!savedSelection) return false;
    if (savedSelection.kind === "readonly") return false;
    if (savedSelection.el?.isConnected === false) return false;

    if (DomEditor && savedSelection.el) {
      return applyExtensionReplacement(savedSelection.el, savedSelection, newText);
    }
    return false;
  }

  async function presentModalSafely({ title, text, copiedNotice }) {
    if (window !== window.top && chrome?.runtime?.sendMessage) {
      const res = await sendRuntimeMessage(
        {
          type: "relayModalToTopFrame",
          dialogTitle: title || "Result",
          text: text || ""
        },
        { timeoutMs: 5000 }
      );
      if (res?.ok) return;
    }
    showModal({ title, text, copiedNotice });
  }

  // --- Background Message Listener ---
  try {
    if (chrome?.runtime?.onMessage?.addListener) {
      runtimeMessageListener = (msg, _sender, sendResponse) => {
        if (!stateRecord.active || !msg || typeof msg !== "object") return false;

        const safeReply = (payload) => {
          try {
            sendResponse(payload);
          } catch {
            // Ignore closed port
          }
        };

        if (msg.type === "getSelection") {
          safeReply({ text: captureSelection() });
          return false;
        }

        if (msg.type === "showLoading") {
          showToast({ message: msg.message || "Processing...", loading: true, duration: 0 });
          safeReply({ ok: true });
          return false;
        }

        if (msg.type === "showError") {
          showToast({
            message: msg.message || "An error occurred.",
            variant: "error",
            duration: 6000,
            openOptions: Boolean(msg.openOptions)
          });
          safeReply({ ok: true });
          return false;
        }

        if (msg.type === "showTopFrameModal") {
          if (window === window.top) {
            showModal({
              title: msg.dialogTitle || "Result",
              text: msg.text || "",
              copiedNotice: "Copied to clipboard."
            });
            safeReply({ ok: true });
          }
          return false;
        }

        if (msg.type === "applyResult") {
          let responded = false;
          const replyOnce = (payload) => {
            if (responded) return;
            responded = true;
            safeReply(payload);
          };

          (async () => {
            try {
              if (msg.mode === "replace") {
                const replaced = replaceSavedSelection(msg.text);
                if (replaced) {
                  if (msg.copyOnReplace) {
                    const copied = await copyText(msg.text);
                    if (!copied) {
                      await presentModalSafely({
                        title: msg.dialogTitle || "Result",
                        text: msg.text,
                        copiedNotice: msg.copiedNotice || "Copied to clipboard."
                      });
                      replyOnce({ ok: true, replaced: true, copied: false });
                      return;
                    }
                  }
                  showToast({
                    message: msg.copyOnReplace
                      ? "Replaced selection and copied to clipboard."
                      : "Replaced selection.",
                    variant: "success",
                    duration: 3000
                  });
                  replyOnce({ ok: true, replaced: true });
                  return;
                }
              }
              await presentModalSafely({
                title: msg.dialogTitle || "Result",
                text: msg.text,
                copiedNotice: msg.copiedNotice || "Copied to clipboard."
              });
              replyOnce({ ok: true, replaced: false });
            } catch (err) {
              replyOnce({ ok: false, error: err?.message || String(err) });
            } finally {
              if (!responded) {
                replyOnce({ ok: false, error: "applyResult failed unexpectedly." });
              }
            }
          })();
          return true;
        }

        return false;
      };
      chrome.runtime.onMessage.addListener(runtimeMessageListener);
    }
  } catch {
    // Ignore outside extension context
  }

  loadSettings();

  // Handle late injection into an already-focused editor
  const initialActive = getDeepActiveElement();
  const initialEditor = DomEditor?.resolveEditableTarget(initialActive);
  if (initialEditor) {
    activeEditor = initialEditor;
    ensureLexiconsForActiveLanguages({ bypassCooldown: true });
    scheduleFloatingTriggerUpdate();
  }
})();

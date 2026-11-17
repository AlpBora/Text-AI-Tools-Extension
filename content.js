(() => {
  "use strict";

  if (globalThis.__TEXT_AI_TOOLS_CONTENT_INIT__) {
    return;
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

  const HOST_ID = "text-tools-shadow-host";

  const settings = {
    spellcheckEnabled: true,
    autoCorrectEnabled: true,
    primaryLanguage: "Turkish",
    secondaryLanguage: "English",
    copyOnReplace: true
  };

  const lexiconsByLang = Object.create(null);
  const lexiconPending = new Map();
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

  function saveUserHabitsDebounced() {
    if (habitSaveTimer) clearTimeout(habitSaveTimer);
    habitSaveTimer = setTimeout(() => {
      habitSaveTimer = null;
      try {
        if (!chrome?.storage?.local) return;
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
        chrome.storage.local.set({ userHabits: payload });
      } catch {
        // Ignore storage write errors
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
          if (data.userHabits && typeof data.userHabits === "object") {
            if (data.userHabits.corrections && typeof data.userHabits.corrections === "object") {
              Object.assign(userHabits.corrections, data.userHabits.corrections);
            }
            if (data.userHabits.wordCounts && typeof data.userHabits.wordCounts === "object") {
              Object.assign(userHabits.wordCounts, data.userHabits.wordCounts);
            }
            if (data.userHabits.ignored && typeof data.userHabits.ignored === "object") {
              Object.assign(userHabits.ignored, data.userHabits.ignored);
            }
            if (data.userHabits.bigrams && typeof data.userHabits.bigrams === "object") {
              Object.assign(userHabits.bigrams, data.userHabits.bigrams);
            }
            if (data.userHabits.domainCounts && typeof data.userHabits.domainCounts === "object") {
              Object.assign(userHabits.domainCounts, data.userHabits.domainCounts);
            }
            if (data.userHabits.charEdits && typeof data.userHabits.charEdits === "object") {
              Object.assign(userHabits.charEdits, data.userHabits.charEdits);
            }
          }
        }
      );
    } catch {
      // Ignore outside extension context
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

  function fetchLexicon(langId) {
    if (!langId) return Promise.resolve(null);
    if (lexiconsByLang[langId]) return Promise.resolve(lexiconsByLang[langId]);
    if (lexiconPending.has(langId)) return lexiconPending.get(langId);

    if (!chrome?.runtime?.sendMessage) {
      return Promise.resolve(null);
    }

    const promise = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "getLexicon", lang: langId }, (res) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
            return;
          }
          if (res && res.ok && res.data) {
            lexiconsByLang[langId] = res.data;
            resolve(res.data);
          } else {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
    }).finally(() => {
      lexiconPending.delete(langId);
    });

    lexiconPending.set(langId, promise);
    return promise;
  }

  function ensureLexiconsForActiveLanguages() {
    lexiconsInitialized = true;
    const langIds = getActiveBundledLangIds();
    const missing = langIds.filter((id) => !lexiconsByLang[id]);
    if (missing.length === 0) return Promise.resolve();
    return Promise.all(missing.map((id) => fetchLexicon(id)));
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
          border: 1px solid rgba(99, 102, 241, 0.45);
          background: #ffffff;
          color: #4f46e5;
          font-size: 13px;
          font-weight: 700;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(15, 23, 42, 0.16);
          transition: transform 0.12s ease, background 0.12s ease;
          padding: 0;
        }
        .trigger-btn:hover {
          background: #4f46e5;
          color: #ffffff;
          transform: scale(1.06);
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
          min-width: 230px;
          max-width: min(360px, calc(100vw - 16px));
          max-height: calc(100vh - 16px);
          overflow-y: auto;
          background: #ffffff;
          color: #111827;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22);
          padding: 8px;
          animation: fadeIn 0.14s ease-out;
        }
        .popover-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 4px 6px 6px;
          border-bottom: 1px solid #f3f4f6;
          margin-bottom: 6px;
        }
        .popover-title {
          font-size: 12px;
          font-weight: 700;
          color: #374151;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .badge {
          background: #eef2ff;
          color: #4338ca;
          border-radius: 6px;
          padding: 1px 6px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .badge-warn {
          background: #fef2f2;
          color: #b91c1c;
        }
        .close-x {
          background: transparent;
          border: none;
          color: #6b7280;
          font-size: 16px;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 6px;
          line-height: 1;
        }
        .close-x:hover { background: #e5e7eb; color: #111827; }
        .candidate-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 6px;
        }
        .candidate-btn {
          background: #f3f4f6;
          color: #111827;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 5px 10px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .candidate-btn:hover {
          background: #eef2ff;
          border-color: #a5b4fc;
          color: #312e81;
        }
        .gemini-context-btn {
          width: 100%;
          background: #f5f3ff;
          color: #4f46e5;
          border: 1px dashed #c4b5fd;
          border-radius: 8px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .gemini-context-btn:hover {
          background: #ede9fe;
          border-color: #8b5cf6;
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
          color: #6b7280;
        }
        .suggestion-list {
          display: flex;
          flex-direction: column;
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
        .inline-status {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #4b5563;
          padding: 6px 4px;
        }
        .inline-error {
          font-size: 12px;
          color: #b91c1c;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 8px;
          padding: 7px 9px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .inline-settings-btn {
          align-self: flex-start;
          background: #4f46e5;
          color: #ffffff;
          border: none;
          border-radius: 6px;
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
        chrome.runtime.sendMessage({ type: "openOptions" });
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

    // Manual-only Gemini Contextual Word Lookup button
    const ctxBtn = document.createElement("button");
    ctxBtn.type = "button";
    ctxBtn.className = "gemini-context-btn";
    ctxBtn.setAttribute("data-action", "ask-gemini-context");
    ctxBtn.setAttribute("aria-label", "Ask Gemini (Context) — Bağlamdan Kelime Bul");
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
      stTxt.textContent = "Searching context with Gemini...";
      status.appendChild(sp);
      status.appendChild(stTxt);
      ctxResults.appendChild(status);

      const liveSentence = getLiveSentenceForUncertain(uncertainState);

      chrome.runtime.sendMessage(
        {
          type: "geminiContextualWord",
          sentence: liveSentence,
          targetWord: uncertainState.word,
          primaryLang: settings.primaryLanguage,
          secondaryLang: settings.secondaryLanguage
        },
        (res) => {
          ctxBtn.disabled = false;
          ctxResults.innerHTML = "";
          if (chrome.runtime?.lastError || !res || !res.ok) {
            const errBox = document.createElement("div");
            errBox.className = "inline-error";
            const msg = document.createElement("span");
            msg.textContent = res?.error || chrome.runtime?.lastError?.message || "Gemini lookup failed.";
            errBox.appendChild(msg);
            if (res?.openOptions) {
              const optBtn = document.createElement("button");
              optBtn.type = "button";
              optBtn.className = "inline-settings-btn";
              optBtn.textContent = "Open Settings";
              preventBlurOnMouseDown(optBtn);
              optBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openOptions" }));
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
    activeMenuMode = "suggestions";

    const slot = getSlot("slot-menu");
    slot.innerHTML = "";

    const menu = document.createElement("div");
    menu.className = "popover suggestion-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "AI Sentence Suggestions");

    const pos = clampPosition(anchorPos.left, anchorPos.top + 32, 330, 220);
    menu.style.left = `${pos.left}px`;
    menu.style.top = `${pos.top}px`;

    const header = document.createElement("div");
    header.className = "popover-header";

    const title = document.createElement("div");
    title.className = "popover-title";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = "AI Suggestions";
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

    const list = document.createElement("div");
    list.className = "suggestion-list";

    const status = document.createElement("div");
    status.className = "inline-status";
    const sp = document.createElement("div");
    sp.className = "spinner-dark";
    const stTxt = document.createElement("span");
    stTxt.textContent = "Getting grammar & fluency options...";
    status.appendChild(sp);
    status.appendChild(stTxt);
    list.appendChild(status);

    menu.appendChild(list);
    slot.appendChild(menu);

    chrome.runtime.sendMessage(
      {
        type: "geminiSentenceSuggestions",
        text: extraction.text,
        mode: extraction.mode,
        primaryLang: settings.primaryLanguage,
        secondaryLang: settings.secondaryLanguage
      },
      (res) => {
        if (activeMenuMode !== "suggestions") return;
        list.innerHTML = "";
        if (chrome.runtime?.lastError || !res || !res.ok) {
          const errBox = document.createElement("div");
          errBox.className = "inline-error";
          const msg = document.createElement("span");
          msg.textContent =
            res?.error || chrome.runtime?.lastError?.message || "Failed to fetch suggestions.";
          errBox.appendChild(msg);
          if (res?.openOptions) {
            const optBtn = document.createElement("button");
            optBtn.type = "button";
            optBtn.className = "inline-settings-btn";
            optBtn.textContent = "Open Settings";
            preventBlurOnMouseDown(optBtn);
            optBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openOptions" }));
            errBox.appendChild(optBtn);
          }
          list.appendChild(errBox);
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
          optBtn.addEventListener("click", () => {
            const ok = applyExtensionReplacement(editor, extraction.rangeSnapshot, opt.text);
            closeFloatingMenu();
            if (ok) {
              clearUncertainState({ keepMenuIfSuggestion: false });
              scheduleFloatingTriggerUpdate();
            }
          });

          list.appendChild(optBtn);
        }
      }
    );
  }

  function updateFloatingTriggerNow() {
    if (!DomEditor) return;
    const editor =
      (activeEditor && DomEditor.isEligibleEditor(activeEditor) && activeEditor) ||
      DomEditor.resolveEditableTarget(document.activeElement);

    if (!editor || (document.activeElement && !editor.contains(document.activeElement) && document.activeElement !== editor)) {
      hideFloatingTrigger();
      return;
    }

    const extracted = DomEditor.extractSentenceOrSelection(editor);
    if (!extracted) {
      hideFloatingTrigger();
      return;
    }

    if (extracted.mode === "selection") {
      showFloatingTrigger(editor, extracted);
      return;
    }

    if (extracted.mode === "sentence" && DomEditor.isCaretAtSentenceEnd(editor)) {
      showFloatingTrigger(editor, extracted);
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
  document.addEventListener("compositionstart", () => {
    isComposing = true;
  });

  document.addEventListener("compositionend", () => {
    isComposing = false;
  });

  document.addEventListener(
    "focusin",
    (e) => {
      if (!DomEditor) return;
      const rawTarget = (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
      const editor = DomEditor.resolveEditableTarget(rawTarget);
      if (!editor) return;
      activeEditor = editor;
      ensureLexiconsForActiveLanguages();
      scheduleFloatingTriggerUpdate();
    },
    true
  );

  document.addEventListener(
    "focusout",
    (e) => {
      const next = e.relatedTarget;
      const host = document.getElementById(HOST_ID);
      if (next && host && (next === host || host.contains(next))) {
        return;
      }
      setTimeout(() => {
        const currentActive = document.activeElement;
        if (!DomEditor?.resolveEditableTarget(currentActive)) {
          hideFloatingTrigger();
          if (activeMenuMode === "uncertain" || activeMenuMode === "suggestions") {
            closeFloatingMenu();
          }
        }
      }, 120);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (isApplyingExtensionEdit || isComposing || e.isComposing) return;

      if (e.key === "Escape") {
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
            const sel = window.getSelection?.();
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

  document.addEventListener(
    "input",
    async (e) => {
      if (isApplyingExtensionEdit || isComposing || e.isComposing || !DomEditor) return;
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
            await ensureLexiconsForActiveLanguages();
            // Re-verify expectedOriginal before applying after async lexicon load
            const stillValid =
              editor.tagName === "INPUT" || editor.tagName === "TEXTAREA"
                ? String(editor.value ?? "").slice(extracted.start, extracted.end) === extracted.word
                : DomEditor.buildContentEditableTextModel(editor).fullText.slice(
                    extracted.start,
                    extracted.end
                  ) === extracted.word;
            if (stillValid) {
              evaluateWordBoundary(editor, extracted);
            }
          }
        }
      }

      scheduleFloatingTriggerUpdate();
    },
    true
  );

  document.addEventListener("mouseup", () => {
    scheduleFloatingTriggerUpdate();
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") return;
    scheduleFloatingTriggerUpdate();
  });

  document.addEventListener("selectionchange", () => {
    scheduleFloatingTriggerUpdate();
  });

  window.addEventListener(
    "scroll",
    () => {
      if (activeUncertain?.editor && DomEditor) {
        if (activeUncertain.editor.tagName === "INPUT" || activeUncertain.editor.tagName === "TEXTAREA") {
          DomEditor.setUncertainUnderline(activeUncertain.editor, activeUncertain.span);
        }
      }
      scheduleFloatingTriggerUpdate();
    },
    true
  );

  window.addEventListener("resize", () => {
    scheduleFloatingTriggerUpdate();
  });

  // --- Storage Change Listener ---
  try {
    chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
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
      if (langChanged && (lexiconsInitialized || activeEditor)) {
        ensureLexiconsForActiveLanguages();
      }
    });
  } catch {
    // Ignore outside extension context
  }

  // --- Context Menu / Shortcut Selection & Clipboard Helpers ---
  function captureSelection() {
    const active = document.activeElement;
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

    const sel = window.getSelection();
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

    if (DomEditor && savedSelection.el) {
      return applyExtensionReplacement(savedSelection.el, savedSelection, newText);
    }
    return false;
  }

  async function presentModalSafely({ title, text, copiedNotice }) {
    if (window !== window.top && chrome?.runtime?.sendMessage) {
      const relayed = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            {
              type: "relayModalToTopFrame",
              dialogTitle: title || "Result",
              text: text || ""
            },
            (res) => {
              if (chrome.runtime?.lastError || !res?.ok) {
                resolve(false);
              } else {
                resolve(true);
              }
            }
          );
        } catch {
          resolve(false);
        }
      });
      if (relayed) return;
    }
    showModal({ title, text, copiedNotice });
  }

  // --- Background Message Listener ---
  try {
    chrome?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return false;

      if (msg.type === "getSelection") {
        sendResponse({ text: captureSelection() });
        return false;
      }

      if (msg.type === "showLoading") {
        showToast({ message: msg.message || "Processing...", loading: true, duration: 0 });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === "showError") {
        showToast({
          message: msg.message || "An error occurred.",
          variant: "error",
          duration: 6000,
          openOptions: Boolean(msg.openOptions)
        });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === "showTopFrameModal") {
        if (window === window.top) {
          showModal({
            title: msg.dialogTitle || "Result",
            text: msg.text || "",
            copiedNotice: "Copied to clipboard."
          });
          sendResponse({ ok: true });
        }
        return false;
      }

      if (msg.type === "applyResult") {
        (async () => {
          if (msg.mode === "replace") {
            const replaced = replaceSavedSelection(msg.text);
            if (replaced) {
              if (msg.copyOnReplace) {
                await copyText(msg.text);
              }
              showToast({
                message: msg.copyOnReplace
                  ? "Replaced selection and copied to clipboard."
                  : "Replaced selection.",
                variant: "success",
                duration: 3000
              });
              sendResponse({ ok: true, replaced: true });
              return;
            }
          }
          await presentModalSafely({
            title: msg.dialogTitle || "Result",
            text: msg.text,
            copiedNotice: msg.copiedNotice || "Copied to clipboard."
          });
          sendResponse({ ok: true, replaced: false });
        })();
        return true;
      }

      return false;
    });
  } catch {
    // Ignore outside extension context
  }

  loadSettings();
})();

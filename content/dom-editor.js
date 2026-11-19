(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

  const ALLOWED_INPUT_TYPES = new Set(["text", "search", "tel"]);
  const BOUNDARY_CHARS = new Set([
    " ",
    "\u00A0",
    "\n",
    "\r",
    "\t",
    ".",
    ",",
    ";",
    ":",
    "!",
    "?",
    ")",
    "]",
    "}",
    "\"",
    "\u201D",
    "\u2019",
    "\u2026",
    "/"
  ]);

  const SENTENCE_TERMINATORS = new Set([".", "!", "?", "\u2026"]);
  const CLOSING_WRAPPERS = new Set(["\"", "'", "\u201D", "\u2019", ")", "]", "}"]);
  const BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "PRE",
    "TR",
    "SECTION",
    "ARTICLE",
    "HEADER",
    "FOOTER",
    "ASIDE",
    "ADDRESS"
  ]);

  const ABBREVIATIONS = new Set([
    "dr",
    "mr",
    "mrs",
    "ms",
    "prof",
    "sr",
    "jr",
    "st",
    "vs",
    "etc",
    "eg",
    "ie",
    "e.g",
    "i.e",
    "vb",
    "bkz",
    "örn",
    "orn",
    "yy",
    "doç",
    "doc",
    "yrd",
    "av",
    "alb",
    "uzm",
    "fig",
    "no",
    "vol",
    "inc",
    "ltd",
    "corp",
    "co",
    "approx",
    "al",
    "et",
    "ph.d",
    "u.s",
    "u.k",
    "a.m",
    "p.m"
  ]);

  const URL_SCHEME_RE = /^(?:https?|ftp|file):\/\//i;
  const URL_WWW_RE = /^www\.[^\s]+/i;
  const URL_DOMAIN_PATH_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;
  const URL_DOMAIN_TLD_RE =
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|dev|app|ai|co|uk|de|fr|tr|info|biz|me|xyz|tv|cc|gg|ly|to|sh|js|ts|mjs|cjs|py|json|html|css|md|xml|yml|yaml|txt)$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DECIMAL_RE = /^\d+(?:[.,]\d+)+$/;
  const WORD_BODY_CHAR_RE = /[\p{L}\p{N}_-]/u;
  const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
  const APOSTROPHE_RE = /['\u2018\u2019\u02BC]/;

  const HIGHLIGHT_NAME = "text-ai-tools-uncertain";
  const HIGHLIGHT_STYLE_ID = "text-ai-tools-highlight-style";
  const SHADOW_HOST_ID = "text-tools-shadow-host";

  const uncertainOverlayState = new WeakMap();
  let sharedMirrorDiv = null;

  function isEditableAttr(val) {
    if (val === null || val === undefined) return false;
    const s = String(val).toLowerCase();
    return s === "" || s === "true" || s === "plaintext-only";
  }

  function isExplicitlyNonEditable(el) {
    if (!el || typeof el !== "object") return true;
    const attr = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : undefined;
    if (attr !== undefined && attr !== null && String(attr).toLowerCase() === "false") {
      return true;
    }
    if (el.isContentEditable === false && !isEditableAttr(attr)) {
      return true;
    }
    return false;
  }

  function isNodeEditable(el) {
    if (!el || typeof el !== "object") return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (!tag || tag === "INPUT" || tag === "TEXTAREA" || tag === "HTML") return false;
    const attr = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : undefined;
    if (String(attr).toLowerCase() === "false") return false;
    if (el.isContentEditable === true) return true;
    if (isEditableAttr(attr)) return true;
    return false;
  }

  function hasDisabledOrReadOnlyAttr(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return true;
    if (typeof el.getAttribute === "function") {
      if (el.getAttribute("aria-disabled") === "true") return true;
      if (el.getAttribute("aria-readonly") === "true") return true;
    }
    return false;
  }

  function resolveEditableTarget(node) {
    if (!node || typeof node !== "object") return null;
    const el = node.nodeType === 3 ? node.parentElement || node.parentNode : node;
    if (!el || !el.tagName || el.isConnected === false) return null;

    const tag = String(el.tagName).toUpperCase();
    if (tag === "TEXTAREA") {
      return !hasDisabledOrReadOnlyAttr(el) ? el : null;
    }
    if (tag === "INPUT") {
      const rawType =
        (typeof el.type === "string" && el.type) ||
        (typeof el.getAttribute === "function" && el.getAttribute("type")) ||
        "text";
      const type = String(rawType).trim().toLowerCase() || "text";
      if (!ALLOWED_INPUT_TYPES.has(type)) return null;
      return !hasDisabledOrReadOnlyAttr(el) ? el : null;
    }

    // Check contenteditable / designMode
    const doc = el.ownerDocument;
    if (doc && doc.designMode === "on" && doc.body && !isExplicitlyNonEditable(el)) {
      if (doc.body.isConnected === false) return null;
      return hasDisabledOrReadOnlyAttr(doc.body) ? null : doc.body;
    }

    if (isExplicitlyNonEditable(el)) {
      return null;
    }

    let cur = el;
    let editableHost = isNodeEditable(cur) ? cur : null;

    // Walk up while parent is also editable (or to find editable host if child didn't set isContentEditable in mocks)
    while (cur) {
      const parent = cur.parentElement || cur.parentNode;
      if (!parent || !parent.tagName || String(parent.tagName).toUpperCase() === "HTML") {
        break;
      }
      if (isExplicitlyNonEditable(parent)) {
        break;
      }
      if (isNodeEditable(parent)) {
        editableHost = parent;
        cur = parent;
      } else if (editableHost) {
        break;
      } else {
        cur = parent;
      }
    }

    if (!editableHost || editableHost.isConnected === false) return null;
    if (hasDisabledOrReadOnlyAttr(editableHost)) return null;
    return editableHost;
  }

  function isEligibleEditor(el) {
    return Boolean(resolveEditableTarget(el));
  }

  function isInputLike(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA";
  }

  function getDoc(el) {
    return el?.ownerDocument || (typeof document !== "undefined" ? document : null);
  }

  function getWin(el) {
    const doc = getDoc(el);
    return doc?.defaultView || (typeof window !== "undefined" ? window : null);
  }

  function getDeepActiveElement(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    let active = d?.activeElement || null;
    let guard = 0;
    while (active && active.shadowRoot && active.shadowRoot.activeElement && guard < 10) {
      if (active.id === SHADOW_HOST_ID) break;
      active = active.shadowRoot.activeElement;
      guard += 1;
    }
    return active;
  }

  function getSelectionForNode(node) {
    const root = typeof node?.getRootNode === "function" ? node.getRootNode() : null;
    if (root && root !== getDoc(node) && typeof root.getSelection === "function") {
      try {
        const srSel = root.getSelection();
        if (srSel && srSel.rangeCount > 0) return srSel;
      } catch {
        // Ignore shadowRoot.getSelection errors
      }
    }
    const win = getWin(node);
    const doc = getDoc(node);
    return (
      (typeof win?.getSelection === "function" && win.getSelection()) ||
      (typeof doc?.getSelection === "function" && doc.getSelection()) ||
      null
    );
  }

  function getEffectiveSelectionRange(host) {
    const root = typeof host?.getRootNode === "function" ? host.getRootNode() : null;
    const sel = getSelectionForNode(host);
    if (!sel) return null;
    const doc = getDoc(host);
    if (root && root !== doc && typeof sel.getComposedRanges === "function") {
      try {
        const composed = sel.getComposedRanges({ shadowRoots: [root] });
        if (Array.isArray(composed) && composed.length > 0 && composed[0]) {
          const sr = composed[0];
          if (doc && typeof doc.createRange === "function" && sr.startContainer && sr.endContainer) {
            const r = doc.createRange();
            r.setStart(sr.startContainer, sr.startOffset);
            r.setEnd(sr.endContainer, sr.endOffset);
            return { sel, range: r };
          }
        }
      } catch {
        // Fall back to standard selection range
      }
    }
    if (sel.rangeCount > 0) {
      return { sel, range: sel.getRangeAt(0) };
    }
    return null;
  }

  // --- ContentEditable Linear Text Model ---
  function buildContentEditableTextModel(rootEl) {
    const segments = [];
    let fullText = "";
    const childStartMap = new Map();
    const elementStartMap = new Map();
    const elementEndMap = new Map();

    function pushBreak(node) {
      const start = fullText.length;
      fullText += "\n";
      segments.push({ type: "break", node, start, end: start + 1 });
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const text = String(node.nodeValue ?? "");
        const start = fullText.length;
        fullText += text;
        segments.push({ type: "text", node, start, end: start + text.length });
        return;
      }
      if (node.nodeType !== 1 && node !== rootEl) return;

      const tag = String(node.tagName || "").toUpperCase();
      if (node !== rootEl && tag === "BR") {
        pushBreak(node);
        return;
      }

      const isBlock = node !== rootEl && BLOCK_TAGS.has(tag);
      if (isBlock && fullText.length > 0 && !fullText.endsWith("\n")) {
        pushBreak(node);
      }

      elementStartMap.set(node, fullText.length);
      const children = node.childNodes ? Array.from(node.childNodes) : [];
      const offsets = new Array(children.length + 1);
      for (let i = 0; i < children.length; i++) {
        offsets[i] = fullText.length;
        walk(children[i]);
      }
      offsets[children.length] = fullText.length;
      childStartMap.set(node, offsets);
      elementEndMap.set(node, fullText.length);
    }

    walk(rootEl);

    return {
      rootEl,
      fullText,
      segments,
      childStartMap,
      elementStartMap,
      elementEndMap
    };
  }

  function domPositionToLinear(model, container, offset) {
    if (!container) return model.fullText.length;
    if (container.nodeType === 3) {
      for (let i = 0; i < model.segments.length; i++) {
        const seg = model.segments[i];
        if (seg.type === "text" && seg.node === container) {
          const maxLen = seg.end - seg.start;
          return seg.start + Math.max(0, Math.min(maxLen, offset));
        }
      }
      return model.fullText.length;
    }
    const offsets = model.childStartMap.get(container);
    if (offsets) {
      const idx = Math.max(0, Math.min(offsets.length - 1, offset));
      return offsets[idx];
    }
    if (model.elementEndMap.has(container)) {
      return offset === 0 ? model.elementStartMap.get(container) : model.elementEndMap.get(container);
    }
    return model.fullText.length;
  }

  function linearToDomPosition(model, targetOffset) {
    const clamped = Math.max(0, Math.min(model.fullText.length, targetOffset));
    let fallbackBreak = null;

    for (let i = 0; i < model.segments.length; i++) {
      const seg = model.segments[i];
      if (seg.type === "text" && clamped >= seg.start && clamped <= seg.end) {
        return { node: seg.node, offset: clamped - seg.start };
      }
      if (seg.type === "break" && clamped >= seg.start && clamped <= seg.end && !fallbackBreak) {
        fallbackBreak = seg;
      }
    }

    if (fallbackBreak && fallbackBreak.node && fallbackBreak.node.parentNode) {
      const parent = fallbackBreak.node.parentNode;
      const children = parent.childNodes ? Array.from(parent.childNodes) : [];
      const idx = children.indexOf(fallbackBreak.node);
      if (idx !== -1) {
        const tag = String(fallbackBreak.node.tagName || "").toUpperCase();
        if (tag === "BR") {
          return { node: parent, offset: clamped > fallbackBreak.start ? idx + 1 : idx };
        }
        return { node: fallbackBreak.node, offset: 0 };
      }
    }

    // Fallback to last text node or root element
    for (let i = model.segments.length - 1; i >= 0; i--) {
      if (model.segments[i].type === "text") {
        const seg = model.segments[i];
        return { node: seg.node, offset: seg.end - seg.start };
      }
    }

    return { node: model.rootEl, offset: 0 };
  }

  function createDomRangeFromLinear(model, startOffset, endOffset) {
    const doc = getDoc(model.rootEl);
    if (!doc || typeof doc.createRange !== "function") return null;
    const startPos = linearToDomPosition(model, startOffset);
    const endPos = linearToDomPosition(model, endOffset);
    try {
      const range = doc.createRange();
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
      return range;
    } catch {
      return null;
    }
  }

  function getEditorState(el) {
    const host = resolveEditableTarget(el);
    if (!host) return null;

    if (isInputLike(host)) {
      const text = String(host.value ?? "");
      const rawStart = typeof host.selectionStart === "number" ? host.selectionStart : text.length;
      const rawEnd = typeof host.selectionEnd === "number" ? host.selectionEnd : rawStart;
      const start = Math.max(0, Math.min(text.length, Math.min(rawStart, rawEnd)));
      const end = Math.max(start, Math.min(text.length, Math.max(rawStart, rawEnd)));
      return {
        kind: "input",
        host,
        text,
        start,
        end,
        collapsed: start === end,
        model: null,
        domRange: null
      };
    }

    const model = buildContentEditableTextModel(host);
    const text = model.fullText;
    const eff = getEffectiveSelectionRange(host);

    if (eff && eff.range) {
      const r = eff.range;
      const startInside =
        r.startContainer === host ||
        (typeof host.contains === "function" && host.contains(r.startContainer));
      const endInside =
        r.endContainer === host ||
        (typeof host.contains === "function" && host.contains(r.endContainer));
      if (startInside && endInside) {
        const sOff = domPositionToLinear(model, r.startContainer, r.startOffset);
        const eOff = domPositionToLinear(model, r.endContainer, r.endOffset);
        const start = Math.min(sOff, eOff);
        const end = Math.max(sOff, eOff);
        return {
          kind: "contenteditable",
          host,
          text,
          start,
          end,
          collapsed: Boolean(r.collapsed) || start === end,
          model,
          domRange: typeof r.cloneRange === "function" ? r.cloneRange() : r
        };
      }
    }

    return {
      kind: "contenteditable",
      host,
      text,
      start: text.length,
      end: text.length,
      collapsed: true,
      model,
      domRange: null
    };
  }

  function extractContextTokens(textBefore) {
    if (!textBefore) return [];
    const slice = textBefore.slice(Math.max(0, textBefore.length - 320));
    const rawTokens = slice.trim().split(/\s+/).filter(Boolean);
    const cleaned = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const tok = rawTokens[i].replace(/^["'\u201C\u2018(\[{]+|["'\u201D\u2019.,;:!?)\]}\u2026]+$/g, "");
      if (tok) cleaned.push(tok);
    }
    return cleaned.slice(-12);
  }

  function looksLikeUrlOrEmailOrDecimal(token) {
    if (!token) return false;
    if (URL_SCHEME_RE.test(token) || URL_WWW_RE.test(token) || token.includes("://")) return true;
    if (token.includes("@")) return true;
    if (URL_DOMAIN_PATH_RE.test(token) || URL_DOMAIN_TLD_RE.test(token)) return true;
    if (EMAIL_RE.test(token)) return true;
    if (DECIMAL_RE.test(token)) return true;
    return false;
  }

  function extractWordBeforeCaret(el) {
    const state = getEditorState(el);
    if (!state || !state.collapsed || state.start <= 0) return null;

    const { kind, host, text, start: caret, model } = state;
    const boundaryChar = text[caret - 1];
    if (!BOUNDARY_CHARS.has(boundaryChar)) return null;

    const end = caret - 1;
    if (end <= 0) return null;

    // Check full whitespace-delimited token ending at `end` so URLs/emails/decimals aren't split mid-token
    let wsStart = end;
    while (wsStart > 0 && !/[\s\u00A0]/.test(text[wsStart - 1])) {
      wsStart -= 1;
    }
    const wsToken = text.slice(wsStart, end);

    // Strip wrapping leading brackets/quotes on wsToken for URL/email detection
    const trimmedWsToken = wsToken.replace(/^["'\u201C\u2018(\[{]+/, "");
    const leadingTrimLen = wsToken.length - trimmedWsToken.length;

    if (looksLikeUrlOrEmailOrDecimal(trimmedWsToken)) {
      const tokenStart = wsStart + leadingTrimLen;
      const contextTokens = extractContextTokens(text.slice(0, tokenStart));
      const domRange =
        kind === "contenteditable" ? createDomRangeFromLinear(model, tokenStart, end) : null;
      return {
        word: trimmedWsToken,
        start: tokenStart,
        end,
        boundaryChar,
        contextTokens,
        rangeSnapshot: {
          kind,
          el: host,
          start: tokenStart,
          end,
          boundaryChar,
          domRange,
          expectedOriginal: trimmedWsToken,
          preserveTrailingCaret: true
        }
      };
    }

    // Standard prose word scan backward from `end`
    let wordStart = end;
    while (wordStart > 0) {
      const ch = text[wordStart - 1];
      if (WORD_BODY_CHAR_RE.test(ch)) {
        wordStart -= 1;
        continue;
      }
      // Internal apostrophe (don't, Ankara'ya, Türkiye’de)
      if (
        APOSTROPHE_RE.test(ch) &&
        wordStart < end &&
        LETTER_OR_DIGIT_RE.test(text[wordStart]) &&
        wordStart - 2 >= 0 &&
        LETTER_OR_DIGIT_RE.test(text[wordStart - 2])
      ) {
        wordStart -= 1;
        continue;
      }
      break;
    }

    // Strip leading hyphens or apostrophes
    while (wordStart < end && (text[wordStart] === "-" || APOSTROPHE_RE.test(text[wordStart]))) {
      wordStart += 1;
    }

    // Also include leading @ or # if attached to a mention/hashtag
    if (wordStart > 0 && (text[wordStart - 1] === "@" || text[wordStart - 1] === "#")) {
      const beforeSigil = wordStart - 2 >= 0 ? text[wordStart - 2] : " ";
      if (/[\s\u00A0(\[{"'\u201C\u2018]/.test(beforeSigil)) {
        wordStart -= 1;
      }
    }

    if (wordStart >= end) return null;
    const word = text.slice(wordStart, end);
    if (!word) return null;

    const contextTokens = extractContextTokens(text.slice(0, wordStart));
    const domRange =
      kind === "contenteditable" ? createDomRangeFromLinear(model, wordStart, end) : null;

    return {
      word,
      start: wordStart,
      end,
      boundaryChar,
      contextTokens,
      rangeSnapshot: {
        kind,
        el: host,
        start: wordStart,
        end,
        boundaryChar,
        domRange,
        expectedOriginal: word,
        preserveTrailingCaret: true
      }
    };
  }

  // --- Abbreviation-Aware Sentence Segmenter ---
  function isAbbreviationBeforeDot(text, dotIndex) {
    let i = dotIndex;
    while (i > 0 && !/[\s\u00A0(\[{"'\u201C\u2018]/.test(text[i - 1])) {
      i -= 1;
    }
    const token = text.slice(i, dotIndex);
    if (!token) return false;
    const lower = token.toLowerCase();
    if (ABBREVIATIONS.has(lower)) return true;
    // Single uppercase initial (e.g., "J." or "A.")
    if (/^\p{Lu}$/u.test(token)) return true;
    // Multi-part abbreviation like "e.g" or "U.S" or "a.m"
    if (/^[a-zA-Z]{1,3}(?:\.[a-zA-Z]{1,3})+$/.test(token)) return true;
    return false;
  }

  function isInsideUrlOrDecimalAtDot(text, dotIndex) {
    const prev = dotIndex > 0 ? text[dotIndex - 1] : "";
    const next = dotIndex + 1 < text.length ? text[dotIndex + 1] : "";
    // Decimal or version number (e.g., 3.14)
    if (/\d/.test(prev) && /\d/.test(next)) return true;
    // Immediate next char is non-whitespace letter/digit/slash (e.g., github.com/AlpBora or example.com)
    if (next && !/[\s\u00A0\n\r\t"'\u201D\u2019)\]}]/.test(next)) {
      // Find surrounding non-whitespace token
      let s = dotIndex;
      while (s > 0 && !/[\s\u00A0]/.test(text[s - 1])) s -= 1;
      let e = dotIndex + 1;
      while (e < text.length && !/[\s\u00A0]/.test(text[e])) e += 1;
      const ws = text.slice(s, e);
      if (
        URL_SCHEME_RE.test(ws) ||
        URL_WWW_RE.test(ws) ||
        ws.includes("://") ||
        ws.includes("@") ||
        URL_DOMAIN_PATH_RE.test(ws) ||
        URL_DOMAIN_TLD_RE.test(ws) ||
        /^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(ws)
      ) {
        return true;
      }
    }
    return false;
  }

  function segmentSentences(text) {
    const sentences = [];
    const len = text.length;
    let rawStart = 0;

    function pushSentence(from, to) {
      let s = from;
      let e = to;
      while (s < e && /[\s\u00A0\n\r\t]/.test(text[s])) s += 1;
      while (e > s && /[\s\u00A0\n\r\t]/.test(text[e - 1])) e -= 1;
      if (e > s) {
        sentences.push({ start: s, end: e, text: text.slice(s, e) });
      }
    }

    let i = 0;
    while (i < len) {
      const ch = text[i];

      if (ch === "\n") {
        pushSentence(rawStart, i);
        i += 1;
        rawStart = i;
        continue;
      }

      if (SENTENCE_TERMINATORS.has(ch)) {
        if (ch === ".") {
          if (isInsideUrlOrDecimalAtDot(text, i) || isAbbreviationBeforeDot(text, i)) {
            i += 1;
            continue;
          }
        }
        // Consume consecutive sentence terminators (e.g. "...", "?!", "!!")
        let j = i + 1;
        while (j < len && SENTENCE_TERMINATORS.has(text[j])) {
          j += 1;
        }
        // Consume immediate closing quote/paren attached to terminator
        while (j < len && CLOSING_WRAPPERS.has(text[j])) {
          j += 1;
        }
        // If followed by non-whitespace (except newline), wait? If e.g. `foo.Bar` without space, don't split mid-word if URL-like, else split if next is space/EOF/uppercase
        if (j < len && !/[\s\u00A0\n\r\t]/.test(text[j])) {
          i = j;
          continue;
        }
        pushSentence(rawStart, j);
        i = j;
        rawStart = j;
        continue;
      }

      i += 1;
    }

    if (rawStart < len) {
      pushSentence(rawStart, len);
    }

    return sentences;
  }

  function extractSentenceOrSelection(el) {
    const state = getEditorState(el);

    if (!state) {
      // Fallback for non-editable page selection if window.getSelection() has selected text
      const doc = el?.ownerDocument || (typeof document !== "undefined" ? document : null);
      const win = doc?.defaultView || (typeof window !== "undefined" ? window : null);
      const sel = typeof win?.getSelection === "function" ? win.getSelection() : null;
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const text = sel.toString();
        if (text && text.trim()) {
          const range = sel.getRangeAt(0);
          return {
            mode: "selection",
            text,
            start: 0,
            end: text.length,
            rangeSnapshot: {
              kind: "readonly",
              el: null,
              start: 0,
              end: text.length,
              domRange: typeof range.cloneRange === "function" ? range.cloneRange() : range,
              expectedOriginal: text,
              preserveTrailingCaret: false
            },
            contextTokens: extractContextTokens(text),
            expectedOriginal: text
          };
        }
      }
      return null;
    }

    const { kind, host, text, start, end, collapsed, model, domRange } = state;

    if (!collapsed && end > start) {
      const selectedText = text.slice(start, end);
      if (selectedText.trim().length > 0) {
        const snapRange =
          kind === "contenteditable"
            ? domRange || createDomRangeFromLinear(model, start, end)
            : null;
        return {
          mode: "selection",
          text: selectedText,
          start,
          end,
          rangeSnapshot: {
            kind,
            el: host,
            start,
            end,
            domRange: snapRange,
            expectedOriginal: selectedText,
            preserveTrailingCaret: false
          },
          contextTokens: extractContextTokens(text.slice(0, start)),
          expectedOriginal: selectedText
        };
      }
    }

    // Sentence mode at caret
    if (!text.trim()) return null;
    const sentences = segmentSentences(text);
    if (sentences.length === 0) return null;

    const caret = start;
    let chosen = null;

    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (caret >= s.start && caret <= s.end) {
        chosen = s;
        break;
      }
    }

    if (!chosen) {
      // Caret is in whitespace after a sentence or before the first sentence
      for (let i = sentences.length - 1; i >= 0; i--) {
        if (sentences[i].end <= caret) {
          // Check if there are only horizontal spaces between sentence end and caret, or no later sentence
          const between = text.slice(sentences[i].end, caret);
          if (!between.includes("\n") || i === sentences.length - 1) {
            chosen = sentences[i];
            break;
          }
        }
      }
    }

    if (!chosen) {
      chosen = sentences[0];
    }

    const snapRange =
      kind === "contenteditable" ? createDomRangeFromLinear(model, chosen.start, chosen.end) : null;

    return {
      mode: "sentence",
      text: chosen.text,
      start: chosen.start,
      end: chosen.end,
      rangeSnapshot: {
        kind,
        el: host,
        start: chosen.start,
        end: chosen.end,
        domRange: snapRange,
        expectedOriginal: chosen.text,
        preserveTrailingCaret: false
      },
      contextTokens: extractContextTokens(text.slice(0, chosen.start)),
      expectedOriginal: chosen.text
    };
  }

  function isCaretAtSentenceEnd(el) {
    const state = getEditorState(el);
    if (!state || !state.collapsed) return false;
    const before = state.text.slice(0, state.start);
    if (!before.trim()) return false;
    // Allow optional trailing single space/closing wrapper after terminal punctuation
    const trimmed = before.replace(/[ \t\u00A0]$/, "");
    if (!trimmed) return false;
    if (trimmed !== before) {
      const after = state.text.slice(state.start);
      if (after && !/^[\s\u00A0\n\r\t]/.test(after)) {
        return false;
      }
    }
    let idx = trimmed.length - 1;
    while (idx >= 0 && CLOSING_WRAPPERS.has(trimmed[idx])) {
      idx -= 1;
    }
    if (idx < 0) return false;
    const ch = trimmed[idx];
    if (!SENTENCE_TERMINATORS.has(ch)) return false;
    if (ch === "." && (isInsideUrlOrDecimalAtDot(trimmed, idx) || isAbbreviationBeforeDot(trimmed, idx))) {
      return false;
    }
    return true;
  }

  // --- Geometry: Mirror-Div (input/textarea) & Range Rects (contenteditable) ---
  const MIRROR_STYLE_PROPS = [
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "textAlign",
    "textIndent",
    "textTransform",
    "wordSpacing",
    "tabSize",
    "direction"
  ];

  function getMirrorSpanRect(el, start, end) {
    const doc = getDoc(el);
    const win = getWin(el);
    if (!doc || typeof doc.createElement !== "function" || typeof el.getBoundingClientRect !== "function") {
      return null;
    }

    const elRect = el.getBoundingClientRect();
    const computed = typeof win?.getComputedStyle === "function" ? win.getComputedStyle(el) : null;

    if (!sharedMirrorDiv || sharedMirrorDiv.ownerDocument !== doc) {
      sharedMirrorDiv = doc.createElement("div");
      sharedMirrorDiv.setAttribute("data-text-ai-tools-mirror", "true");
    }

    const mirror = sharedMirrorDiv;
    const style = mirror.style;
    style.position = "fixed";
    style.top = "-9999px";
    style.left = "-9999px";
    style.visibility = "hidden";
    style.pointerEvents = "none";
    style.margin = "0";
    style.overflow = "hidden";

    if (computed) {
      for (const prop of MIRROR_STYLE_PROPS) {
        style[prop] = computed[prop];
      }
    }

    const isTextarea = String(el.tagName || "").toUpperCase() === "TEXTAREA";
    if (isTextarea) {
      style.whiteSpace = "pre-wrap";
      style.wordWrap = "break-word";
      style.overflowWrap = "break-word";
      style.width = `${elRect.width}px`;
      style.height = "auto";
    } else {
      style.whiteSpace = "pre";
      style.wordWrap = "normal";
      style.overflowWrap = "normal";
      style.width = "auto";
      style.minWidth = `${elRect.width}px`;
      style.height = "auto";
    }

    const value = String(el.value ?? "");
    const clampedStart = Math.max(0, Math.min(value.length, start));
    const clampedEnd = Math.max(clampedStart, Math.min(value.length, end));
    const targetText = value.slice(clampedStart, clampedEnd);

    mirror.textContent = "";
    const beforeNode = doc.createTextNode(value.slice(0, clampedStart));
    const marker = doc.createElement("span");
    marker.textContent = targetText || "\u200B";
    const afterNode = doc.createTextNode(value.slice(clampedEnd) || "\u200B");

    mirror.appendChild(beforeNode);
    mirror.appendChild(marker);
    mirror.appendChild(afterNode);

    const mountParent = doc.body || doc.documentElement;
    if (!mountParent) return null;
    mountParent.appendChild(mirror);

    try {
      const mirrorRect = mirror.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const scrollLeft = el.scrollLeft || 0;
      const scrollTop = el.scrollTop || 0;

      const relLeft = markerRect.left - mirrorRect.left - scrollLeft;
      const relTop = markerRect.top - mirrorRect.top - scrollTop;
      const width = targetText ? markerRect.width : 2;
      const height = markerRect.height || parseFloat(computed?.lineHeight) || 18;

      const left = elRect.left + relLeft;
      const top = elRect.top + relTop;

      return {
        top,
        left,
        bottom: top + height,
        right: left + width,
        width,
        height
      };
    } finally {
      mirror.remove();
    }
  }

  function getContentEditableSpanRect(host, span, domRange) {
    const doc = getDoc(host);
    let range = domRange;
    if (!range && span && typeof span.start === "number") {
      const model = buildContentEditableTextModel(host);
      range = createDomRangeFromLinear(model, span.start, span.end ?? span.start);
    }

    if (range) {
      if (typeof range.getClientRects === "function") {
        const rects = range.getClientRects();
        if (rects && rects.length > 0) {
          let r = span?.preferEndRect ? rects[rects.length - 1] : rects[0];
          if (span?.preferEndRect && r.width <= 0 && r.height <= 0) {
            for (let i = rects.length - 1; i >= 0; i--) {
              if (rects[i].width > 0 || rects[i].height > 0) {
                r = rects[i];
                break;
              }
            }
          }
          if (r && (r.width > 0 || r.height > 0)) {
            return {
              top: r.top,
              left: r.left,
              bottom: r.bottom,
              right: r.right,
              width: r.width,
              height: r.height
            };
          }
        }
      }
      if (typeof range.getBoundingClientRect === "function") {
        const r = range.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) {
          return {
            top: r.top,
            left: r.left,
            bottom: r.bottom,
            right: r.right,
            width: r.width,
            height: r.height
          };
        }
      }

      // Collapsed empty line fallback: try startContainer element rect before temporary zero-width span
      if (range.collapsed) {
        if (
          range.startContainer &&
          range.startContainer.nodeType === 1 &&
          typeof range.startContainer.getBoundingClientRect === "function"
        ) {
          const er = range.startContainer.getBoundingClientRect();
          if (er && er.height > 0 && er.height <= 44) {
            return {
              top: er.top,
              left: er.left,
              bottom: er.bottom,
              right: er.left + 2,
              width: 2,
              height: er.height
            };
          }
        }
        if (doc && typeof doc.createElement === "function" && typeof range.insertNode === "function") {
          const probe = doc.createElement("span");
          probe.textContent = "\u200B";
          const sel = getSelectionForNode(host);
          let savedCaretRange = null;
          if (sel && sel.rangeCount > 0) {
            const cur = sel.getRangeAt(0);
            savedCaretRange = typeof cur.cloneRange === "function" ? cur.cloneRange() : cur;
          }
          try {
            const cloned = typeof range.cloneRange === "function" ? range.cloneRange() : range;
            cloned.insertNode(probe);
            const pr = probe.getBoundingClientRect();
            if (pr && (pr.height > 0 || pr.top > 0 || pr.left > 0)) {
              return {
                top: pr.top,
                left: pr.left,
                bottom: pr.bottom,
                right: pr.right,
                width: pr.width,
                height: pr.height || 18
              };
            }
          } catch {
            // ignore probe error
          } finally {
            probe.remove();
            if (sel && savedCaretRange) {
              try {
                sel.removeAllRanges();
                sel.addRange(savedCaretRange);
              } catch {
                // ignore selection restore error
              }
            }
          }
        }
      }
    }

    if (typeof host.getBoundingClientRect === "function") {
      const r = host.getBoundingClientRect();
      return {
        top: r.top + 6,
        left: r.left + 8,
        bottom: r.top + 24,
        right: r.left + 10,
        width: 2,
        height: 18
      };
    }

    return null;
  }

  function getSpanRect(el, span) {
    const host = resolveEditableTarget(el) || el;
    if (!host || !span) return null;

    if (isInputLike(host)) {
      const rect = getMirrorSpanRect(host, span.start ?? 0, span.end ?? span.start ?? 0);
      if (rect) return rect;
      if (typeof host.getBoundingClientRect === "function") {
        const r = host.getBoundingClientRect();
        return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
      }
      return null;
    }

    return getContentEditableSpanRect(host, span, span.domRange || null);
  }

  function getCaretOrSelectionRect(el, rangeSnapshot) {
    const host = resolveEditableTarget(el);
    if (!host) {
      if (rangeSnapshot?.domRange && typeof rangeSnapshot.domRange.getBoundingClientRect === "function") {
        const r = rangeSnapshot.domRange.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) {
          return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
        }
      }
      return null;
    }

    if (rangeSnapshot && typeof rangeSnapshot.start === "number") {
      return getSpanRect(host, { ...rangeSnapshot, preferEndRect: true });
    }

    const state = getEditorState(host);
    if (!state) return null;
    return getSpanRect(host, {
      start: state.start,
      end: state.end,
      domRange: state.domRange,
      preferEndRect: true
    });
  }

  // --- Non-Destructive Uncertain Underline ---
  function ensureHighlightStyle(doc) {
    if (!doc || typeof doc.getElementById !== "function" || typeof doc.createElement !== "function") return;
    if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      ::highlight(${HIGHLIGHT_NAME}) {
        text-decoration: underline wavy #ef4444;
        text-decoration-thickness: 1.5px;
        text-underline-offset: 2px;
        background-color: rgba(239, 68, 68, 0.08);
      }
    `;
    const target = doc.head || doc.documentElement;
    if (target) target.appendChild(style);
  }

  function renderInputUnderlineOverlay(host, rectOrNull) {
    const doc = getDoc(host);
    if (!doc || typeof doc.getElementById !== "function") return;
    const shadowHost = doc.getElementById(SHADOW_HOST_ID);
    const sr = shadowHost?.shadowRoot;
    if (!sr) return;

    let layer = sr.getElementById("text-tools-underlines");
    if (!layer) {
      layer = doc.createElement("div");
      layer.id = "text-tools-underlines";
      sr.appendChild(layer);
    }
    layer.innerHTML = "";

    if (!rectOrNull || rectOrNull.width <= 0) return;

    // Clamp underline inside the input/textarea visible box
    const elRect = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
    let left = rectOrNull.left;
    let width = rectOrNull.width;
    let top = rectOrNull.bottom - 2;

    if (elRect) {
      if (top < elRect.top || top > elRect.bottom) return;
      const clampedLeft = Math.max(elRect.left + 2, left);
      const clampedRight = Math.min(elRect.right - 2, left + width);
      if (clampedRight <= clampedLeft) return;
      left = clampedLeft;
      width = clampedRight - clampedLeft;
    }

    const line = doc.createElement("div");
    line.className = "uncertain-underline";
    line.setAttribute("data-uncertain", "true");
    line.style.left = `${Math.round(left)}px`;
    line.style.top = `${Math.round(top)}px`;
    line.style.width = `${Math.max(8, Math.round(width))}px`;
    line.style.height = "4px";
    layer.appendChild(line);
  }

  function setUncertainUnderline(el, spanOrNull) {
    const host = resolveEditableTarget(el) || el;
    if (!host) return;

    const doc = getDoc(host);
    const win = getWin(host);
    const cssObj = win?.CSS || (typeof CSS !== "undefined" ? CSS : null);
    const HighlightCtor = win?.Highlight || (typeof Highlight !== "undefined" ? Highlight : null);

    if (!spanOrNull) {
      uncertainOverlayState.delete(host);
      if (cssObj?.highlights) {
        cssObj.highlights.delete(HIGHLIGHT_NAME);
      }
      renderInputUnderlineOverlay(host, null);
      return;
    }

    uncertainOverlayState.set(host, spanOrNull);

    if (isInputLike(host)) {
      const rect = getSpanRect(host, spanOrNull);
      renderInputUnderlineOverlay(host, rect);
      return;
    }

    // ContentEditable: CSS Custom Highlight API (zero DOM mutation)
    if (cssObj?.highlights && typeof HighlightCtor === "function") {
      ensureHighlightStyle(doc);
      let range = spanOrNull.domRange;
      if (!range && typeof spanOrNull.start === "number") {
        const model = buildContentEditableTextModel(host);
        range = createDomRangeFromLinear(model, spanOrNull.start, spanOrNull.end ?? spanOrNull.start);
      }
      if (range) {
        try {
          const hl = new HighlightCtor(range);
          cssObj.highlights.set(HIGHLIGHT_NAME, hl);
          return;
        } catch {
          // fallback below if range invalid
        }
      }
    }

    // Visual fallback in Shadow DOM if CSS.highlights unavailable
    const rect = getSpanRect(host, spanOrNull);
    renderInputUnderlineOverlay(host, rect);
  }

  // --- Safe Surgical Replacement ---
  function dispatchInputEvents(host, newText, doc) {
    const win = getWin(host);
    const InputEventCtor = win?.InputEvent || (typeof InputEvent !== "undefined" ? InputEvent : null);
    const EventCtor = win?.Event || (typeof Event !== "undefined" ? Event : null);

    if (typeof host.dispatchEvent !== "function") return;

    if (InputEventCtor) {
      try {
        host.dispatchEvent(
          new InputEventCtor("input", {
            bubbles: true,
            cancelable: false,
            inputType: "insertText",
            data: newText
          })
        );
      } catch {
        if (EventCtor) host.dispatchEvent(new EventCtor("input", { bubbles: true }));
      }
    } else if (EventCtor) {
      host.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }

    if (isInputLike(host) && EventCtor) {
      host.dispatchEvent(new EventCtor("change", { bubbles: true }));
    }
  }

  function replaceRangeSafely(el, snapshot, newText) {
    if (!el || !snapshot || typeof newText !== "string") return false;
    const host = resolveEditableTarget(el) || el;
    const doc = getDoc(host);
    const win = getWin(host);

    if (doc && typeof doc.contains === "function" && host !== doc.body && !doc.contains(host)) {
      return false;
    }

    if (snapshot.kind === "input" || isInputLike(host)) {
      const value = String(host.value ?? "");
      const start = Math.max(0, Math.min(value.length, snapshot.start ?? 0));
      const end = Math.max(start, Math.min(value.length, snapshot.end ?? start));

      if (snapshot.expectedOriginal !== undefined) {
        if (value.slice(start, end) !== snapshot.expectedOriginal) {
          return false;
        }
      }

      const prevCaret =
        typeof host.selectionEnd === "number"
          ? host.selectionEnd
          : typeof host.selectionStart === "number"
            ? host.selectionStart
            : end;

      const delta = newText.length - (end - start);
      const expectedFull = value.slice(0, start) + newText + value.slice(end);

      host.focus?.();
      host.setSelectionRange?.(start, end);

      let applied = false;
      if (typeof doc?.execCommand === "function" && (!doc.activeElement || doc.activeElement === host)) {
        try {
          const ok = doc.execCommand("insertText", false, newText);
          if (ok && host.value === expectedFull) {
            applied = true;
          }
        } catch {
          applied = false;
        }
      }

      if (!applied) {
        if (typeof host.setRangeText === "function") {
          host.setRangeText(newText, start, end, "end");
        } else {
          host.value = expectedFull;
        }
        dispatchInputEvents(host, newText, doc);
      }

      if (typeof host.setSelectionRange === "function") {
        const nextCaret =
          snapshot.preserveTrailingCaret && prevCaret >= end
            ? Math.max(0, Math.min(host.value.length, prevCaret + delta))
            : start + newText.length;
        host.setSelectionRange(nextCaret, nextCaret);
      }
      return true;
    }

    // ContentEditable replacement
    const beforeState = getEditorState(host);
    const prevCaret = beforeState ? beforeState.end : snapshot.end ?? 0;

    let range = snapshot.domRange;
    const isRangeConnected =
      range &&
      range.startContainer &&
      (range.startContainer === host ||
        (typeof host.contains === "function" && host.contains(range.startContainer)));

    if (!isRangeConnected) {
      const model = buildContentEditableTextModel(host);
      if (snapshot.expectedOriginal !== undefined) {
        const currentSlice = model.fullText.slice(snapshot.start, snapshot.end);
        if (currentSlice !== snapshot.expectedOriginal) {
          return false;
        }
      }
      range = createDomRangeFromLinear(model, snapshot.start, snapshot.end);
    } else if (snapshot.expectedOriginal !== undefined) {
      const model = buildContentEditableTextModel(host);
      let liveText = "";
      if (range.startContainer && range.endContainer) {
        const rStart = domPositionToLinear(model, range.startContainer, range.startOffset ?? 0);
        const rEnd = domPositionToLinear(model, range.endContainer, range.endOffset ?? 0);
        liveText = model.fullText.slice(Math.min(rStart, rEnd), Math.max(rStart, rEnd));
      }
      const rangeText = typeof range.toString === "function" ? range.toString() : "";
      const norm = (str) => String(str).replace(/\r\n?/g, "\n").replace(/\u00A0/g, " ");
      const collapseBreaks = (str) => norm(str).replace(/\n+/g, "\n");
      const matches =
        norm(rangeText) === norm(snapshot.expectedOriginal) ||
        norm(liveText) === norm(snapshot.expectedOriginal) ||
        collapseBreaks(liveText) === collapseBreaks(snapshot.expectedOriginal);
      if (!matches) {
        return false;
      }
    }

    if (!range) {
      // Pure mock fallback without Range
      if (typeof host.textContent === "string") {
        const txt = host.textContent;
        if (snapshot.expectedOriginal !== undefined && txt.slice(snapshot.start, snapshot.end) !== snapshot.expectedOriginal) {
          return false;
        }
        host.textContent = txt.slice(0, snapshot.start) + newText + txt.slice(snapshot.end);
        dispatchInputEvents(host, newText, doc);
        return true;
      }
      return false;
    }

    host.focus?.();
    const sel = getSelectionForNode(host);

    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const origLen = (snapshot.end ?? 0) - (snapshot.start ?? 0);
    const delta = newText.length - origLen;
    let applied = false;

    const deepActive = getDeepActiveElement(doc);
    if (
      typeof doc?.execCommand === "function" &&
      (!deepActive || deepActive === host || host.contains?.(deepActive))
    ) {
      try {
        const ok = doc.execCommand("insertText", false, newText);
        if (ok) {
          if (typeof snapshot.start === "number") {
            const checkModel = buildContentEditableTextModel(host);
            const actualSlice = checkModel.fullText.slice(
              snapshot.start,
              snapshot.start + newText.length
            );
            if (actualSlice.replace(/\u00A0/g, " ") === newText.replace(/\u00A0/g, " ")) {
              applied = true;
            }
          } else {
            applied = true;
          }
        }
      } catch {
        applied = false;
      }
    }

    if (!applied) {
      range.deleteContents();
      const textNode = doc.createTextNode(newText);
      range.insertNode(textNode);
      if (typeof range.setStartAfter === "function") {
        range.setStartAfter(textNode);
        range.collapse(true);
      }
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      dispatchInputEvents(host, newText, doc);
    }

    // Restore caret cleanly (preserving trailing boundary char when replacing word before boundary)
    if (sel && doc && typeof doc.createRange === "function") {
      try {
        const afterModel = buildContentEditableTextModel(host);
        const targetCaretOffset =
          snapshot.preserveTrailingCaret && prevCaret >= (snapshot.end ?? 0)
            ? Math.max(0, Math.min(afterModel.fullText.length, prevCaret + delta))
            : Math.max(0, Math.min(afterModel.fullText.length, (snapshot.start ?? 0) + newText.length));
        const pos = linearToDomPosition(afterModel, targetCaretOffset);
        const collapsedRange = doc.createRange();
        collapsedRange.setStart(pos.node, pos.offset);
        collapsedRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(collapsedRange);
      } catch {
        // Keep browser caret if repositioning fails
      }
    }

    return true;
  }

  const DomEditor = {
    isEligibleEditor,
    resolveEditableTarget,
    getDeepActiveElement,
    getSelectionForNode,
    extractWordBeforeCaret,
    extractSentenceOrSelection,
    isCaretAtSentenceEnd,
    getCaretOrSelectionRect,
    getSpanRect,
    replaceRangeSafely,
    setUncertainUnderline,
    segmentSentences,
    buildContentEditableTextModel
  };

  NS.DomEditor = DomEditor;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DomEditor;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

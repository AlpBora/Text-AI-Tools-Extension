import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

// --- Lightweight Node DOM Mock ---
function createMockDOM() {
  class MockEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.bubbles = Boolean(opts.bubbles);
      this.cancelable = Boolean(opts.cancelable);
      this.defaultPrevented = false;
      Object.assign(this, opts);
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  class MockInputEvent extends MockEvent {}

  class MockNode {
    constructor(nodeType, ownerDocument) {
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    appendChild(child) {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(newChild, refChild) {
      if (!refChild) return this.appendChild(newChild);
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      const idx = this.childNodes.indexOf(refChild);
      if (idx === -1) return this.appendChild(newChild);
      newChild.parentNode = this;
      this.childNodes.splice(idx, 0, newChild);
      return newChild;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
  }

  class MockText extends MockNode {
    constructor(value, ownerDocument) {
      super(3, ownerDocument);
      this.nodeValue = String(value ?? "");
    }
    get textContent() {
      return this.nodeValue;
    }
    set textContent(v) {
      this.nodeValue = String(v ?? "");
    }
  }

  class MockElement extends MockNode {
    constructor(tagName, ownerDocument) {
      super(1, ownerDocument);
      this.tagName = String(tagName).toUpperCase();
      this.attributes = new Map();
      this.style = {};
      this.listeners = new Map();
      this.disabled = false;
      this.readOnly = false;
      this.scrollLeft = 0;
      this.scrollTop = 0;
      this._rect = { top: 20, left: 10, bottom: 44, right: 260, width: 250, height: 24 };
      this._value = "";
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.shadowRoot = null;
      this._innerHTML = "";
    }
    get id() {
      return this.attributes.get("id") || "";
    }
    set id(v) {
      this.attributes.set("id", String(v));
    }
    get className() {
      return this.attributes.get("class") || "";
    }
    set className(v) {
      this.attributes.set("class", String(v));
    }
    get type() {
      return this.attributes.get("type") || (this.tagName === "INPUT" ? "text" : undefined);
    }
    set type(v) {
      this.attributes.set("type", String(v));
    }
    get value() {
      return this._value;
    }
    set value(v) {
      this._value = String(v ?? "");
    }
    get isContentEditable() {
      const attr = this.getAttribute("contenteditable");
      if (attr === "false") return false;
      if (attr === "" || attr === "true" || attr === "plaintext-only") return true;
      return this.parentElement ? this.parentElement.isContentEditable : false;
    }
    get textContent() {
      if (this.tagName === "INPUT" || this.tagName === "TEXTAREA") return "";
      return this.childNodes
        .map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent))
        .join("");
    }
    set textContent(v) {
      this.childNodes.length = 0;
      if (v !== "" && v !== null && v !== undefined) {
        this.appendChild(this.ownerDocument.createTextNode(String(v)));
      }
    }
    get innerText() {
      return this.textContent;
    }
    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === "") {
        this.childNodes.length = 0;
      }
    }
    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
    }
    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }
    attachShadow() {
      const sr = new MockShadowRoot(this.ownerDocument, this);
      this.shadowRoot = sr;
      return sr;
    }
    getBoundingClientRect() {
      if (this.getAttribute("data-text-ai-tools-mirror") === "true") {
        return { top: 0, left: 0, bottom: 20, right: 200, width: 200, height: 20 };
      }
      if (this.tagName === "SPAN" && this.parentElement?.getAttribute("data-text-ai-tools-mirror") === "true") {
        const beforeLen = this.parentElement.childNodes[0]?.nodeValue?.length || 0;
        const w = Math.max(4, (this.textContent || "").length * 7);
        const left = 10 + beforeLen * 7;
        return { top: 2, left, bottom: 20, right: left + w, width: w, height: 18 };
      }
      return { ...this._rect };
    }
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    setRangeText(replacement, start, end, selectMode = "preserve") {
      const s = start ?? this.selectionStart;
      const e = end ?? this.selectionEnd;
      this._value = this._value.slice(0, s) + replacement + this._value.slice(e);
      if (selectMode === "end") {
        this.selectionStart = s + replacement.length;
        this.selectionEnd = s + replacement.length;
      }
    }
    focus() {
      this.ownerDocument.activeElement = this;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatchEvent(event) {
      event.target = event.target || this;
      const docListeners = this.ownerDocument.listeners.get(event.type) || [];
      for (const fn of docListeners) fn(event);
      const local = this.listeners.get(event.type) || [];
      for (const fn of local) fn(event);
      return !event.defaultPrevented;
    }
    click() {
      this.dispatchEvent(new MockEvent("click", { bubbles: true }));
    }
    getElementById(id) {
      return findInSubtree(this, (el) => el.id === id);
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const results = [];
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 1) {
            if (matchesSimpleSelector(c, sel)) results.push(c);
            walk(c);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  class MockShadowRoot extends MockElement {
    constructor(ownerDocument, host) {
      super("#shadow-root", ownerDocument);
      this.host = host;
    }
  }

  function matchesSimpleSelector(el, sel) {
    return sel.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith(".")) return el.className.split(/\s+/).includes(s.slice(1));
      if (s.startsWith("#")) return el.id === s.slice(1);
      if (s === "button") return el.tagName === "BUTTON";
      if (s.startsWith("[")) {
        const m = s.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
        if (m) {
          const val = el.getAttribute(m[1]);
          return m[2] !== undefined ? val === m[2] : val !== null;
        }
      }
      return el.tagName === s.toUpperCase();
    });
  }

  function findInSubtree(root, pred) {
    for (const c of root.childNodes) {
      if (c.nodeType === 1) {
        if (pred(c)) return c;
        const found = findInSubtree(c, pred);
        if (found) return found;
      }
    }
    return null;
  }

  class MockRange {
    constructor(doc) {
      this.ownerDocument = doc;
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }
    get collapsed() {
      return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset;
    }
    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset;
    }
    setStartAfter(node) {
      const parent = node.parentNode;
      const idx = parent.childNodes.indexOf(node);
      this.startContainer = parent;
      this.startOffset = idx + 1;
    }
    collapse(toStart) {
      if (toStart) {
        this.endContainer = this.startContainer;
        this.endOffset = this.startOffset;
      } else {
        this.startContainer = this.endContainer;
        this.startOffset = this.endOffset;
      }
    }
    cloneRange() {
      const r = new MockRange(this.ownerDocument);
      r.startContainer = this.startContainer;
      r.startOffset = this.startOffset;
      r.endContainer = this.endContainer;
      r.endOffset = this.endOffset;
      return r;
    }
    toString() {
      if (!this.startContainer || !this.endContainer) return "";
      if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) {
        return this.startContainer.nodeValue.slice(this.startOffset, this.endOffset);
      }
      // Collect across text nodes between start and end
      let out = "";
      let collecting = false;
      const walk = (n) => {
        if (n.nodeType === 3) {
          const val = n.nodeValue;
          if (n === this.startContainer && n === this.endContainer) {
            out += val.slice(this.startOffset, this.endOffset);
            return;
          }
          if (n === this.startContainer) {
            collecting = true;
            out += val.slice(this.startOffset);
            return;
          }
          if (n === this.endContainer) {
            out += val.slice(0, this.endOffset);
            collecting = false;
            return;
          }
          if (collecting) out += val;
          return;
        }
        for (const c of n.childNodes) walk(c);
      };
      let root = this.startContainer;
      while (root.parentNode) root = root.parentNode;
      walk(root);
      return out;
    }
    deleteContents() {
      if (!this.startContainer || !this.endContainer) return;
      if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) {
        const val = this.startContainer.nodeValue;
        this.startContainer.nodeValue = val.slice(0, this.startOffset) + val.slice(this.endOffset);
        this.endOffset = this.startOffset;
        return;
      }
      // Multi-node delete
      const textNodes = [];
      let root = this.startContainer;
      while (root.parentNode) root = root.parentNode;
      const collect = (n) => {
        if (n.nodeType === 3) textNodes.push(n);
        else for (const c of n.childNodes) collect(c);
      };
      collect(root);
      const sIdx = textNodes.indexOf(this.startContainer);
      const eIdx = textNodes.indexOf(this.endContainer);
      if (sIdx !== -1 && eIdx !== -1) {
        textNodes[sIdx].nodeValue = textNodes[sIdx].nodeValue.slice(0, this.startOffset);
        for (let i = sIdx + 1; i < eIdx; i++) {
          textNodes[i].nodeValue = "";
        }
        textNodes[eIdx].nodeValue = textNodes[eIdx].nodeValue.slice(this.endOffset);
        this.endContainer = this.startContainer;
        this.endOffset = this.startOffset;
      }
    }
    insertNode(newNode) {
      if (this.startContainer.nodeType === 3) {
        const textNode = this.startContainer;
        const parent = textNode.parentNode;
        const before = textNode.nodeValue.slice(0, this.startOffset);
        const after = textNode.nodeValue.slice(this.startOffset);
        textNode.nodeValue = before;
        const afterNode = this.ownerDocument.createTextNode(after);
        const idx = parent.childNodes.indexOf(textNode);
        const ref = parent.childNodes[idx + 1] || null;
        parent.insertBefore(newNode, ref);
        if (after) parent.insertBefore(afterNode, ref);
        return;
      }
      const ref = this.startContainer.childNodes[this.startOffset] || null;
      this.startContainer.insertBefore(newNode, ref);
    }
    getClientRects() {
      return [{ top: 30, left: 40, bottom: 50, right: 110, width: 70, height: 20 }];
    }
    getBoundingClientRect() {
      return { top: 30, left: 40, bottom: 50, right: 110, width: 70, height: 20 };
    }
  }

  class MockSelection {
    constructor() {
      this.ranges = [];
    }
    get rangeCount() {
      return this.ranges.length;
    }
    get isCollapsed() {
      return this.ranges.length === 0 ? true : this.ranges[0].collapsed;
    }
    getRangeAt(i) {
      return this.ranges[i];
    }
    removeAllRanges() {
      this.ranges = [];
    }
    addRange(r) {
      this.ranges.push(r);
    }
    toString() {
      return this.ranges.length > 0 ? this.ranges[0].toString() : "";
    }
  }

  const selection = new MockSelection();
  const doc = {
    activeElement: null,
    designMode: "off",
    listeners: new Map(),
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    createTextNode(text) {
      return new MockText(text, doc);
    },
    createRange() {
      return new MockRange(doc);
    },
    getSelection() {
      return selection;
    },
    getElementById(id) {
      return findInSubtree(doc.documentElement, (el) => el.id === id);
    },
    contains(el) {
      return doc.documentElement.contains(el);
    },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = doc.listeners.get(type) || [];
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = doc.listeners.get(event.type) || [];
      for (const fn of [...list]) fn(event);
    }
  };

  doc.documentElement = new MockElement("HTML", doc);
  doc.head = new MockElement("HEAD", doc);
  doc.body = new MockElement("BODY", doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  class MockHighlight {
    constructor(...ranges) {
      this.ranges = new Set(ranges);
    }
    values() {
      return this.ranges.values();
    }
  }

  const highlightsMap = new Map();
  const win = {
    document: doc,
    innerWidth: 1024,
    innerHeight: 768,
    Event: MockEvent,
    InputEvent: MockInputEvent,
    Highlight: MockHighlight,
    CSS: { highlights: highlightsMap },
    getSelection: () => selection,
    getComputedStyle: () => ({
      boxSizing: "border-box",
      fontFamily: "sans-serif",
      fontSize: "14px",
      fontStyle: "normal",
      fontVariant: "normal",
      fontWeight: "400",
      letterSpacing: "normal",
      lineHeight: "20px",
      paddingTop: "6px",
      paddingRight: "8px",
      paddingBottom: "6px",
      paddingLeft: "8px",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      textAlign: "left",
      textIndent: "0px",
      textTransform: "none",
      wordSpacing: "normal",
      tabSize: "4",
      direction: "ltr",
      display: "block",
      visibility: "visible",
      opacity: "1"
    }),
    addEventListener() {}
  };
  doc.defaultView = win;

  return { doc, win, selection, highlightsMap, MockEvent, MockInputEvent };
}

const DomEditor = require("../../content/dom-editor.js");

// ============================================================================
// 1. DomEditor.isEligibleEditor & resolveEditableTarget
// ============================================================================
describe("M4 DomEditor.isEligibleEditor", () => {
  it("accepts textarea and text/search/tel inputs, rejecting password/email/url/readonly/disabled", () => {
    const { doc } = createMockDOM();

    const ta = doc.createElement("textarea");
    assert.equal(DomEditor.isEligibleEditor(ta), true);

    const taRo = doc.createElement("textarea");
    taRo.readOnly = true;
    assert.equal(DomEditor.isEligibleEditor(taRo), false);

    const taDis = doc.createElement("textarea");
    taDis.disabled = true;
    assert.equal(DomEditor.isEligibleEditor(taDis), false);

    for (const okType of ["text", "search", "tel", ""]) {
      const inp = doc.createElement("input");
      if (okType) inp.type = okType;
      assert.equal(DomEditor.isEligibleEditor(inp), true, `Expected input[type="${okType}"] eligible`);
    }

    for (const badType of [
      "password",
      "email",
      "url",
      "hidden",
      "checkbox",
      "radio",
      "number",
      "date",
      "submit",
      "button",
      "file"
    ]) {
      const inp = doc.createElement("input");
      inp.type = badType;
      assert.equal(DomEditor.isEligibleEditor(inp), false, `Expected input[type="${badType}"] rejected`);
    }

    const disText = doc.createElement("input");
    disText.type = "text";
    disText.disabled = true;
    assert.equal(DomEditor.isEligibleEditor(disText), false);
  });

  it("walks up from child nodes inside contenteditable to host root and rejects contenteditable=false", () => {
    const { doc } = createMockDOM();
    const host = doc.createElement("div");
    host.setAttribute("contenteditable", "true");
    const span = doc.createElement("span");
    const txt = doc.createTextNode("hello");
    span.appendChild(txt);
    host.appendChild(span);
    doc.body.appendChild(host);

    assert.equal(DomEditor.isEligibleEditor(host), true);
    assert.equal(DomEditor.isEligibleEditor(span), true);
    assert.equal(DomEditor.resolveEditableTarget(txt), host);

    const locked = doc.createElement("span");
    locked.setAttribute("contenteditable", "false");
    host.appendChild(locked);
    assert.equal(DomEditor.isEligibleEditor(locked), false);

    const plainDiv = doc.createElement("div");
    doc.body.appendChild(plainDiv);
    assert.equal(DomEditor.isEligibleEditor(plainDiv), false);
  });
});

// ============================================================================
// 2. DomEditor.extractWordBeforeCaret
// ============================================================================
describe("M4 DomEditor.extractWordBeforeCaret", () => {
  it("extracts word before boundary chars in textarea and skips mid-word or consecutive boundaries", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);

    // Mid-word: no boundary
    ta.value = "ozetle";
    ta.setSelectionRange(6, 6);
    assert.equal(DomEditor.extractWordBeforeCaret(ta), null);

    // Space boundary
    ta.value = "Merhaba ozetle ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const ex = DomEditor.extractWordBeforeCaret(ta);
    assert.ok(ex);
    assert.equal(ex.word, "ozetle");
    assert.equal(ex.start, 8);
    assert.equal(ex.end, 14);
    assert.equal(ex.boundaryChar, " ");
    assert.deepEqual(ex.contextTokens, ["Merhaba"]);

    // Various punctuation boundaries
    for (const b of [".", ",", ";", ":", "!", "?", ")", "]", "}", "\"", "\u201D", "\u2019", "\u2026", "/", "\u00A0", "\n"]) {
      ta.value = `word${b}`;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const res = DomEditor.extractWordBeforeCaret(ta);
      assert.ok(res, `Expected extraction for boundary ${JSON.stringify(b)}`);
      assert.equal(res.word, "word");
      assert.equal(res.boundaryChar, b);
    }

    // Space after period should NOT re-extract word
    ta.value = "hello. ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    assert.equal(DomEditor.extractWordBeforeCaret(ta), null);
  });

  it("preserves internal apostrophes and full URLs/emails without splitting sub-words", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);

    ta.value = "Ankara'ya ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    assert.equal(DomEditor.extractWordBeforeCaret(ta)?.word, "Ankara'ya");

    ta.value = "Türkiye\u2019de ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    assert.equal(DomEditor.extractWordBeforeCaret(ta)?.word, "Türkiye\u2019de");

    ta.value = "Visit https://github.com/AlpBora ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    assert.equal(DomEditor.extractWordBeforeCaret(ta)?.word, "https://github.com/AlpBora");

    ta.value = "Mail ekip@example.com ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    assert.equal(DomEditor.extractWordBeforeCaret(ta)?.word, "ekip@example.com");
  });

  it("extracts word cleanly across multi-node contenteditable DOM ranges", () => {
    const { doc, selection } = createMockDOM();
    const ce = doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const p1 = doc.createElement("p");
    p1.appendChild(doc.createTextNode("Merhaba "));
    const b = doc.createElement("b");
    const t2 = doc.createTextNode("ozetle ");
    b.appendChild(t2);
    p1.appendChild(b);
    ce.appendChild(p1);
    doc.body.appendChild(ce);

    const r = doc.createRange();
    r.setStart(t2, t2.nodeValue.length);
    r.collapse(true);
    selection.removeAllRanges();
    selection.addRange(r);

    const ex = DomEditor.extractWordBeforeCaret(ce);
    assert.ok(ex);
    assert.equal(ex.word, "ozetle");
    assert.equal(ex.boundaryChar, " ");
    assert.deepEqual(ex.contextTokens, ["Merhaba"]);
    assert.equal(ex.rangeSnapshot.kind, "contenteditable");
    assert.equal(ex.rangeSnapshot.domRange.toString(), "ozetle");
  });
});

// ============================================================================
// 3. DomEditor.extractSentenceOrSelection
// ============================================================================
describe("M4 DomEditor.extractSentenceOrSelection", () => {
  it("prioritizes active selection over sentence mode", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);
    ta.value = "Prefix wordy rough draft suffix.";
    ta.setSelectionRange(7, 24);

    const res = DomEditor.extractSentenceOrSelection(ta);
    assert.ok(res);
    assert.equal(res.mode, "selection");
    assert.equal(res.text, "wordy rough draft");
    assert.equal(res.start, 7);
    assert.equal(res.end, 24);
    assert.equal(res.expectedOriginal, "wordy rough draft");
  });

  it("isolates ONLY active sentence and respects abbreviations, decimals, and URLs", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);

    ta.value = "First sentence stays intact. Dr. Smith read 3.14 e.g. at https://example.com/a.html today. Third.";
    // Place caret inside the second sentence ("today.")
    const idx = ta.value.indexOf("today.");
    ta.setSelectionRange(idx + 6, idx + 6);

    const res = DomEditor.extractSentenceOrSelection(ta);
    assert.ok(res);
    assert.equal(res.mode, "sentence");
    assert.equal(res.text, "Dr. Smith read 3.14 e.g. at https://example.com/a.html today.");
    assert.equal(res.text.includes("First sentence"), false);
    assert.equal(res.text.includes("Third"), false);

    // Caret after abbreviation "Dr." is not sentence end; caret after "today." IS sentence end
    assert.equal(DomEditor.isCaretAtSentenceEnd(ta), true);
    const drPos = ta.value.indexOf("Dr.") + 3;
    ta.setSelectionRange(drPos, drPos);
    assert.equal(DomEditor.isCaretAtSentenceEnd(ta), false);
  });
});

// ============================================================================
// 4. DomEditor.replaceRangeSafely & Geometry / Underlines
// ============================================================================
describe("M4 DomEditor.replaceRangeSafely, Geometry & Uncertain Underline", () => {
  it("rejects stale expectedOriginal snapshots without corrupting editor text", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);
    ta.value = "Modified text here.";
    ta.setSelectionRange(0, 0);

    const staleSnap = {
      kind: "input",
      el: ta,
      start: 0,
      end: 8,
      expectedOriginal: "Original"
    };
    const ok = DomEditor.replaceRangeSafely(ta, staleSnap, "Updated");
    assert.equal(ok, false);
    assert.equal(ta.value, "Modified text here.");
  });

  it("replaces word before boundary in textarea, preserving trailing space and caret", () => {
    const { doc } = createMockDOM();
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);
    ta.value = "keep teh ";
    ta.setSelectionRange(9, 9);

    const ex = DomEditor.extractWordBeforeCaret(ta);
    assert.ok(ex);
    const ok = DomEditor.replaceRangeSafely(ta, ex.rangeSnapshot, "the");
    assert.equal(ok, true);
    assert.equal(ta.value, "keep the ");
    assert.equal(ta.selectionStart, 9);
    assert.equal(ta.selectionEnd, 9);
  });

  it("replaces multi-node contenteditable range safely and preserves surrounding text", () => {
    const { doc, selection } = createMockDOM();
    const ce = doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const t1 = doc.createTextNode("Intro stays here. ");
    const span = doc.createElement("span");
    const t2 = doc.createTextNode("We goes to school.");
    span.appendChild(t2);
    ce.appendChild(t1);
    ce.appendChild(span);
    doc.body.appendChild(ce);

    const r = doc.createRange();
    r.setStart(t2, t2.nodeValue.length);
    r.collapse(true);
    selection.removeAllRanges();
    selection.addRange(r);

    const sent = DomEditor.extractSentenceOrSelection(ce);
    assert.equal(sent.text, "We goes to school.");

    const ok = DomEditor.replaceRangeSafely(ce, sent.rangeSnapshot, "We go to school.");
    assert.equal(ok, true);
    assert.equal(ce.textContent, "Intro stays here. We go to school.");
  });

  it("applies CSS.highlights for contenteditable without DOM mutation and Mirror-Div + Shadow DOM underline for textarea", () => {
    const { doc, highlightsMap, selection } = createMockDOM();

    // ContentEditable CSS.highlights
    const ce = doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const t = doc.createTextNode("hello frobozzq ");
    ce.appendChild(t);
    doc.body.appendChild(ce);
    const r = doc.createRange();
    r.setStart(t, 15);
    r.collapse(true);
    selection.removeAllRanges();
    selection.addRange(r);

    const exCe = DomEditor.extractWordBeforeCaret(ce);
    DomEditor.setUncertainUnderline(ce, exCe.rangeSnapshot);
    assert.equal(highlightsMap.has("text-ai-tools-uncertain"), true);
    assert.equal(ce.childNodes.length, 1); // zero DOM mutation inside editor
    DomEditor.setUncertainUnderline(ce, null);
    assert.equal(highlightsMap.has("text-ai-tools-uncertain"), false);

    // Textarea Mirror-Div rect & Shadow DOM underline
    const shadowHost = doc.createElement("div");
    shadowHost.id = "text-tools-shadow-host";
    const sr = shadowHost.attachShadow({ mode: "open" });
    doc.documentElement.appendChild(shadowHost);

    const ta = doc.createElement("textarea");
    ta.value = "hello frobozzq ";
    ta.setSelectionRange(15, 15);
    doc.body.appendChild(ta);

    const exTa = DomEditor.extractWordBeforeCaret(ta);
    const rect = DomEditor.getSpanRect(ta, exTa.rangeSnapshot);
    assert.ok(rect && rect.width > 0 && rect.height > 0);

    DomEditor.setUncertainUnderline(ta, exTa.rangeSnapshot);
    assert.equal(sr.querySelectorAll(".uncertain-underline").length, 1);
    assert.equal(ta.value, "hello frobozzq ");

    DomEditor.setUncertainUnderline(ta, null);
    assert.equal(sr.querySelectorAll(".uncertain-underline").length, 0);
  });
});

// ============================================================================
// 5. content.js End-to-End Coordinator Integration in Node VM
// ============================================================================
describe("M4 content.js Coordinator Integration", () => {
  function bootContentEnvironment({ isTopFrame = true } = {}) {
    const { doc, win, highlightsMap, MockEvent, MockInputEvent } = createMockDOM();
    const sentMessages = [];
    const storageListeners = [];
    const runtimeMessageListeners = [];

    const trLexicon = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8")
    );
    const enLexicon = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8")
    );

    const storageState = {
      spellcheckEnabled: true,
      autoCorrectEnabled: true,
      primaryLanguage: "Turkish",
      secondaryLanguage: "English",
      copyOnReplace: true
    };

    const chromeMock = {
      storage: {
        local: {
          get(defaults, cb) {
            const out = { ...defaults, ...storageState };
            if (cb) cb(out);
            return Promise.resolve(out);
          }
        },
        onChanged: {
          addListener(fn) {
            storageListeners.push(fn);
          }
        }
      },
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          sentMessages.push(msg);
          if (msg.type === "getLexicon") {
            const data = msg.lang === "tr" ? trLexicon : msg.lang === "en" ? enLexicon : null;
            if (cb) cb(data ? { ok: true, lang: msg.lang, data } : { ok: false, error: "missing" });
            return;
          }
          if (msg.type === "geminiContextualWord") {
            if (cb) {
              cb({
                ok: true,
                suggestions: [{ word: "prerequisites", reason: "Fits context" }]
              });
            }
            return;
          }
          if (msg.type === "geminiSentenceSuggestions") {
            if (cb) {
              cb({
                ok: true,
                options: [
                  { category: "grammar", label: "Grammar", text: "We go to school." },
                  { category: "fluency", label: "Fluency", text: "We attend school." }
                ]
              });
            }
            return;
          }
          if (msg.type === "relayModalToTopFrame") {
            if (cb) cb({ ok: true });
            return;
          }
          if (cb) cb({ ok: true });
        },
        onMessage: {
          addListener(fn) {
            runtimeMessageListeners.push(fn);
          }
        }
      }
    };

    const context = {
      globalThis: null,
      window: win,
      self: win,
      document: doc,
      chrome: chromeMock,
      CSS: win.CSS,
      Highlight: win.Highlight,
      Event: MockEvent,
      InputEvent: MockInputEvent,
      setTimeout,
      clearTimeout,
      console,
      navigator: { clipboard: { writeText: async () => {} } }
    };
    context.globalThis = context;
    win.top = isTopFrame ? win : { parentMarker: true };

    vm.createContext(context);
    for (const rel of [
      "content/language-registry.js",
      "content/morphology-tr.js",
      "content/deasciifier-tr.js",
      "content/spellcheck-engine.js",
      "content/undo-manager.js",
      "content/dom-editor.js",
      "content.js"
    ]) {
      const code = fs.readFileSync(path.join(ROOT_DIR, rel), "utf8");
      vm.runInContext(code, context, { filename: rel });
    }

    return {
      context,
      doc,
      win,
      highlightsMap,
      sentMessages,
      runtimeMessageListeners,
      MockEvent,
      MockInputEvent
    };
  }

  it("guards against double injection and lazily loads lexicons only on eligible editor focusin", () => {
    const env = bootContentEnvironment();
    // Before focusin: zero lexicon or Gemini requests
    assert.equal(env.sentMessages.length, 0);

    // Double injection should be a no-op (no duplicate listeners)
    const contentCode = fs.readFileSync(path.join(ROOT_DIR, "content.js"), "utf8");
    vm.runInContext(contentCode, env.context);
    assert.equal(env.runtimeMessageListeners.length, 1);

    // Focus on password input should NOT request lexicons
    const pw = env.doc.createElement("input");
    pw.type = "password";
    env.doc.body.appendChild(pw);
    pw.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    assert.equal(env.sentMessages.filter((m) => m.type === "getLexicon").length, 0);

    // Focus on eligible textarea triggers lazy getLexicon for tr & en
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    const lexCalls = env.sentMessages.filter((m) => m.type === "getLexicon").map((m) => m.lang);
    assert.deepEqual(lexCalls.sort(), ["en", "tr"]);
  });

  it("auto-corrects at word boundary with zero Gemini calls and supports 1-step Geri al pill + Backspace undo", async () => {
    const env = bootContentEnvironment();
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    ta.value = "ozetle ";
    ta.setSelectionRange(7, 7);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));

    assert.equal(ta.value, "özetle ");
    assert.equal(
      env.sentMessages.some((m) => m.type.startsWith("gemini")),
      false,
      "Typing must NEVER trigger Gemini API calls"
    );

    const sr = env.doc.getElementById("text-tools-shadow-host")?.shadowRoot;
    assert.equal(sr ? sr.querySelector(".undo-btn") : null, null, "No intrusive floating undo pill should appear");

    // Verify 1-step Ctrl+Z / Cmd+Z undo
    const ctrlZEvent = new env.MockEvent("keydown", { bubbles: true, cancelable: true, key: "z" });
    ctrlZEvent.metaKey = true;
    ta.dispatchEvent(ctrlZEvent);
    assert.equal(ctrlZEvent.defaultPrevented, true);
    assert.equal(ta.value, "ozetle ");

    // Also verify immediate Backspace undo after another auto-correct
    ta.value = "teh ";
    ta.setSelectionRange(4, 4);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));
    assert.equal(ta.value, "the ");

    const bsEvent = new env.MockEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" });
    ta.dispatchEvent(bsEvent);
    assert.equal(bsEvent.defaultPrevented, true);
    assert.equal(ta.value, "teh ");
  });

  it("underlines uncertain word, opens popover, and triggers contextual Gemini ONLY when manually clicked", () => {
    const env = bootContentEnvironment();
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    ta.value = "We need xqzblorf ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));

    // Zero automatic Gemini calls
    assert.equal(env.sentMessages.some((m) => m.type.startsWith("gemini")), false);
    assert.equal(ta.value, "We need xqzblorf ");

    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    assert.equal(sr.querySelectorAll(".uncertain-underline").length, 1);

    const askBtn = sr.querySelector('[data-action="ask-gemini-context"]');
    assert.ok(askBtn, "Manual Ask Gemini (Context) button must be present");
    askBtn.click();

    const geminiCtxCalls = env.sentMessages.filter((m) => m.type === "geminiContextualWord");
    assert.equal(geminiCtxCalls.length, 1);
    assert.equal(geminiCtxCalls[0].targetWord, "xqzblorf");

    const candBtn = sr.querySelector('[data-word="prerequisites"]');
    assert.ok(candBtn, "Contextual suggestion button must render");
    candBtn.click();

    assert.equal(ta.value, "We need prerequisites ");
    assert.equal(sr.querySelectorAll(".uncertain-underline").length, 0);
  });

  it("shows floating sentence trigger, fetches suggestions on click, and replaces ONLY target sentence", async () => {
    const env = bootContentEnvironment();
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    ta.value = "Intro stays. We goes to school.";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));

    // Wait for 30ms debounced floating trigger update
    await new Promise((r) => setTimeout(r, 60));

    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    const trigger = sr.querySelector('[data-role="sentence-trigger"]');
    assert.ok(trigger, "Floating sentence trigger button should appear at sentence end");

    assert.equal(env.sentMessages.some((m) => m.type === "geminiSentenceSuggestions"), false);
    trigger.click();

    const calls = env.sentMessages.filter((m) => m.type === "geminiSentenceSuggestions");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "We goes to school.");
    assert.equal(calls[0].mode, "sentence");

    const options = sr.querySelectorAll(".suggestion-option-btn");
    assert.equal(options.length, 2);
    options[0].click();

    assert.equal(ta.value, "Intro stays. We go to school.");
  });

  it("relays modal results from sub-iframe to top frame and renders top-frame modal", async () => {
    const subEnv = bootContentEnvironment({ isTopFrame: false });
    const listener = subEnv.runtimeMessageListeners[0];
    let response;
    listener(
      { type: "applyResult", mode: "modal", dialogTitle: "Translation", text: "Merhaba" },
      {},
      (res) => {
        response = res;
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(response.ok, true);
    assert.equal(response.replaced, false);
    assert.equal(
      subEnv.sentMessages.some(
        (m) => m.type === "relayModalToTopFrame" && m.dialogTitle === "Translation" && m.text === "Merhaba"
      ),
      true
    );

    const topEnv = bootContentEnvironment({ isTopFrame: true });
    let topRes;
    topEnv.runtimeMessageListeners[0](
      { type: "showTopFrameModal", dialogTitle: "Translation", text: "Merhaba" },
      {},
      (res) => {
        topRes = res;
      }
    );
    assert.equal(topRes.ok, true);
    const sr = topEnv.doc.getElementById("text-tools-shadow-host").shadowRoot;
    assert.ok(sr.querySelector(".modal"));
    assert.equal(sr.querySelector(".modal-body").textContent, "Merhaba");
  });

  it("I-4: re-extracts live sentence covering uncertain span when Ask Gemini (Context) is clicked after further typing", () => {
    const env = bootContentEnvironment();
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    // Trigger uncertain popover at 'xqzblorf '
    ta.value = "First sentence. This is xqzblorf ";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));

    // User continues typing the rest of the sentence and even starts another sentence
    ta.value = "First sentence. This is xqzblorf for safety. Third sentence.";
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));

    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    const askBtn = sr.querySelector('[data-action="ask-gemini-context"]');
    assert.ok(askBtn, "Ask Gemini (Context) button must still be open for intact uncertain span");
    askBtn.click();

    const geminiCtxCalls = env.sentMessages.filter((m) => m.type === "geminiContextualWord");
    assert.equal(geminiCtxCalls.length, 1);
    assert.equal(geminiCtxCalls[0].targetWord, "xqzblorf");
    assert.equal(geminiCtxCalls[0].sentence, "This is xqzblorf for safety.");
    assert.equal(geminiCtxCalls[0].sentence.includes("First sentence."), false);
    assert.equal(geminiCtxCalls[0].sentence.includes("Third sentence."), false);
  });

  it("Tier5 BUG-1 & BUG-2: handles multi-block contenteditable expectedOriginal and aligns between-sentence caret", () => {
    const { doc, selection } = createMockDOM();

    // BUG-1: Chromium Range.toString() omits block '\n' between <div> blocks while expectedOriginal includes '\n'
    const ce = doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const d1 = doc.createElement("div");
    const t1 = doc.createTextNode("First line.");
    d1.appendChild(t1);
    const d2 = doc.createElement("div");
    const t2 = doc.createTextNode("Second line.");
    d2.appendChild(t2);
    ce.appendChild(d1);
    ce.appendChild(d2);
    doc.body.appendChild(ce);

    const r = doc.createRange();
    r.setStart(t1, 0);
    r.setEnd(t2, t2.nodeValue.length);
    // Simulate Chromium Range.toString() omitting '\n' across block boundaries
    r.toString = () => "First line.Second line.";
    selection.removeAllRanges();
    selection.addRange(r);

    const extracted = DomEditor.extractSentenceOrSelection(ce);
    assert.equal(extracted.mode, "selection");
    assert.equal(extracted.text, "First line.\nSecond line.");

    // Genuine unchanged multi-block selection must replace cleanly
    const ok = DomEditor.replaceRangeSafely(ce, extracted.rangeSnapshot, "Replaced line 1\nReplaced line 2");
    assert.equal(ok, true);
    assert.equal(ce.textContent.includes("Replaced line 1"), true);

    // Genuinely modified multi-block text must still be rejected
    const staleSnap = {
      kind: "contenteditable",
      el: ce,
      start: 0,
      end: 24,
      domRange: r,
      expectedOriginal: "Modified outside snapshot.\nSecond line.",
    };
    assert.equal(DomEditor.replaceRangeSafely(ce, staleSnap, "Should fail"), false);

    // BUG-2: Between two sentences ("First sentence. |Second sentence.")
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);
    ta.value = "First sentence. Second sentence.";

    // Caret at 16 (after ". " and directly before "Second"): not at end of first sentence
    ta.setSelectionRange(16, 16);
    assert.equal(DomEditor.isCaretAtSentenceEnd(ta), false);
    assert.equal(DomEditor.extractSentenceOrSelection(ta).text, "Second sentence.");

    // Caret at 15 (immediately after "."): at end of first sentence and extracts first sentence
    ta.setSelectionRange(15, 15);
    assert.equal(DomEditor.isCaretAtSentenceEnd(ta), true);
    assert.equal(DomEditor.extractSentenceOrSelection(ta).text, "First sentence.");

    // Caret at trailing space with no following sentence ("First sentence. |"): at end and extracts first sentence
    ta.value = "First sentence. ";
    ta.setSelectionRange(16, 16);
    assert.equal(DomEditor.isCaretAtSentenceEnd(ta), true);
    assert.equal(DomEditor.extractSentenceOrSelection(ta).text, "First sentence.");
  });
});


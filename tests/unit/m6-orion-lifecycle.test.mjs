import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

let originalChrome;
let originalFetch;
let originalNavigator;
let originalDocument;

beforeEach(() => {
  originalChrome = globalThis.chrome;
  originalFetch = globalThis.fetch;
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  originalDocument = globalThis.document;
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
  globalThis.document = originalDocument;
});

function createContentDOM() {
  class MockEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.bubbles = Boolean(opts.bubbles);
      this.cancelable = Boolean(opts.cancelable);
      this.defaultPrevented = false;
      this.relatedTarget = opts.relatedTarget ?? null;
      Object.assign(this, opts);
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    composedPath() {
      const pathArr = [];
      let cur = this.target;
      while (cur) {
        pathArr.push(cur);
        cur = cur.parentNode || cur.host || null;
      }
      return pathArr;
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
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.documentElement) return true;
        cur = cur.parentNode || cur.host || null;
      }
      return false;
    }
    getRootNode() {
      let cur = this;
      while (cur.parentNode) {
        cur = cur.parentNode;
      }
      if (cur === this.ownerDocument.documentElement) return this.ownerDocument;
      return cur;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
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
      if (this.parentNode) this.parentNode.removeChild(this);
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

  function matchesSimpleSelector(el, sel) {
    return sel.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith(".")) return el.className.split(/\s+/).includes(s.slice(1));
      if (s.startsWith("#")) return el.id === s.slice(1);
      if (s === "button" || s === "form" || s === "input") return el.tagName === s.toUpperCase();
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
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
    }
    set textContent(v) {
      this.childNodes.length = 0;
      if (v !== "" && v !== null && v !== undefined) {
        this.appendChild(this.ownerDocument.createTextNode(String(v)));
      }
    }
    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === "") this.childNodes.length = 0;
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
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, capture });
    }
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const list = this.listeners.get(type) || [];
      const idx = list.findIndex((item) => item.fn === fn && item.capture === capture);
      if (idx !== -1) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      event.target = event.target || this;
      if (event.bubbles || event.type === "focusin" || event.type === "focusout" || event.type === "mousedown" || event.type === "input" || event.type === "keydown") {
        const docList = this.ownerDocument.listeners.get(event.type) || [];
        for (const item of [...docList]) item.fn(event);
      }
      const local = this.listeners.get(event.type) || [];
      for (const item of [...local]) item.fn(event);
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
      this.activeElement = null;
    }
    get isConnected() {
      return this.host?.isConnected ?? false;
    }
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
      if (this.startContainer === this.endContainer && this.startContainer?.nodeType === 3) {
        return this.startContainer.nodeValue.slice(this.startOffset, this.endOffset);
      }
      return "";
    }
    deleteContents() {
      if (!this.startContainer || !this.endContainer) return;
      if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) {
        const val = this.startContainer.nodeValue;
        this.startContainer.nodeValue = val.slice(0, this.startOffset) + val.slice(this.endOffset);
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
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push({ fn, capture });
    },
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const list = doc.listeners.get(type) || [];
      const idx = list.findIndex((item) => item.fn === fn && item.capture === capture);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = doc.listeners.get(event.type) || [];
      for (const item of [...list]) item.fn(event);
    }
  };
  doc.documentElement = new MockElement("HTML", doc);
  doc.head = new MockElement("HEAD", doc);
  doc.body = new MockElement("BODY", doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const winListeners = new Map();
  const win = {
    document: doc,
    innerWidth: 1024,
    innerHeight: 768,
    Event: MockEvent,
    InputEvent: MockInputEvent,
    CSS: { highlights: new Map() },
    Highlight: class MockHighlight {},
    getSelection: () => selection,
    getComputedStyle: () => ({
      boxSizing: "border-box",
      fontFamily: "sans-serif",
      fontSize: "14px",
      lineHeight: "20px",
      paddingTop: "6px",
      paddingRight: "8px",
      paddingBottom: "6px",
      paddingLeft: "8px",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      direction: "ltr"
    }),
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture });
    },
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const list = winListeners.get(type) || [];
      const idx = list.findIndex((item) => item.fn === fn && item.capture === capture);
      if (idx !== -1) list.splice(idx, 1);
    }
  };
  doc.defaultView = win;
  win.top = win;

  return { doc, win, selection, winListeners, MockEvent, MockInputEvent, MockSelection, MockRange };
}

function bootContentVM({
  runtimeId = "ext-test-1",
  sendMessageImpl = null,
  storageSetImpl = null,
  fetchImpl = null,
  clipboardWriteImpl = async () => {},
  execCommandImpl = () => true,
  isTopFrame = true,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  const { doc, win, selection, winListeners, MockEvent, MockInputEvent } = createContentDOM();
  doc.execCommand = execCommandImpl;
  if (!isTopFrame) win.top = { parentMarker: true };

  const sentMessages = [];
  const runtimeListeners = [];
  const storageListeners = [];

  const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
  const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));

  const chromeMock = {
    storage: {
      local: {
        get(defaults, cb) {
          const out = {
            ...defaults,
            spellcheckEnabled: true,
            autoCorrectEnabled: true,
            primaryLanguage: "Turkish",
            secondaryLanguage: "English",
            copyOnReplace: true
          };
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set(vals, cb) {
          if (storageSetImpl) return storageSetImpl(vals, cb);
          if (cb) cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        },
        removeListener(fn) {
          const idx = storageListeners.indexOf(fn);
          if (idx !== -1) storageListeners.splice(idx, 1);
        }
      }
    },
    runtime: {
      id: runtimeId,
      lastError: null,
      getURL(rel) {
        return `chrome-extension://${chromeMock.runtime.id || "ext"}/${rel}`;
      },
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (sendMessageImpl) {
          return sendMessageImpl(msg, cb, chromeMock);
        }
        if (msg.type === "getLexicon") {
          const data = msg.lang === "tr" ? trLexicon : msg.lang === "en" ? enLexicon : null;
          if (cb) cb(data ? { ok: true, lang: msg.lang, data } : { ok: false, error: "missing" });
          return undefined;
        }
        if (cb) cb({ ok: true });
        return undefined;
      },
      onMessage: {
        addListener(fn) {
          runtimeListeners.push(fn);
        },
        removeListener(fn) {
          const idx = runtimeListeners.indexOf(fn);
          if (idx !== -1) runtimeListeners.splice(idx, 1);
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
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    console,
    navigator: { clipboard: { writeText: clipboardWriteImpl } }
  };
  context.globalThis = context;
  vm.createContext(context);

  const loadFiles = (files) => {
    for (const rel of files) {
      const code = fs.readFileSync(path.join(ROOT_DIR, rel), "utf8");
      vm.runInContext(code, context, { filename: rel });
    }
  };

  loadFiles([
    "content/language-registry.js",
    "content/morphology-tr.js",
    "content/deasciifier-tr.js",
    "content/spellcheck-engine.js",
    "content/undo-manager.js",
    "content/dom-editor.js",
    "content.js"
  ]);

  return {
    context,
    doc,
    win,
    selection,
    winListeners,
    chromeMock,
    sentMessages,
    runtimeListeners,
    storageListeners,
    MockEvent,
    MockInputEvent,
    reinjectContent: () => loadFiles(["content.js"])
  };
}

describe("M6 Orion & Chrome Compatibility Contracts", () => {
  it("manifest.json keeps module service_worker, web_accessible_resources for lexicons, and excludes alarms & optional_host_permissions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.background, {
      service_worker: "background.js",
      type: "module"
    });
    assert.equal(manifest.permissions.includes("alarms"), false);
    assert.equal(manifest.optional_host_permissions, undefined);
    assert.deepEqual(manifest.web_accessible_resources, [
      {
        resources: ["shared/lexicons/*.json"],
        matches: ["<all_urls>"]
      }
    ]);
  });

  it("options.js ensureHostPermission skips chrome.permissions.request for static providers and custom localhost", async () => {
    let requestCalled = 0;
    let containsArgs = null;
    globalThis.chrome = {
      permissions: {
        async request() {
          requestCalled += 1;
          return false;
        },
        async contains(arg) {
          containsArgs = arg;
          return false;
        }
      }
    };

    const { ensureHostPermission, normalizeOriginPattern } = await import("../../options.js");
    assert.equal(normalizeOriginPattern("http://localhost:11434/v1"), "http://localhost/*");

    for (const provider of ["gemini", "openai", "anthropic", "openrouter", "groq"]) {
      const ok = await ensureHostPermission(provider, "");
      assert.equal(ok, true, `${provider} must return true`);
    }
    const customOk = await ensureHostPermission("custom", "http://localhost:11434/v1");
    assert.equal(customOk, true);
    assert.equal(requestCalled, 0, "Must never call permissions.request when optional_host_permissions is absent");
    assert.deepEqual(containsArgs, { origins: ["http://localhost/*"] });
  });

  it("popup.js supports Orion callback-only sendMessage, Promise sendMessage, and hides shortcuts button when getShortcutsUrl() is null", async () => {
    const { sendRuntimeMessage, getShortcutsUrl, initPopup } = await import("../../popup.js");

    assert.equal(
      getShortcutsUrl("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Orion/1.1.4 Safari/605.1.15"),
      null
    );

    // 1. Callback-only Orion shim returning undefined
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage(_msg, cb) {
          setTimeout(() => cb({ ok: true, reloaded: false, unsupportedReload: true }), 5);
          return undefined;
        }
      }
    };
    const cbRes = await sendRuntimeMessage({ type: "checkAndReloadUpdate" }, { timeoutMs: 200 });
    assert.equal(cbRes.ok, true);
    assert.equal(cbRes.unsupportedReload, true);

    // 2. Promise-returning Chromium API
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage() {
          return Promise.resolve({ ok: true, reloaded: true });
        }
      }
    };
    const prRes = await sendRuntimeMessage({ type: "checkAndReloadUpdate" }, { timeoutMs: 200 });
    assert.equal(prRes.ok, true);
    assert.equal(prRes.reloaded, true);

    // 3. initPopup hides #open-browser-shortcuts when UA returns null shortcuts URL and falls back to execCommand copy
    const fakeEls = new Map();
    const makeEl = (id) => {
      const classes = new Set();
      const listeners = new Map();
      const el = {
        id,
        value: "",
        textContent: "",
        hidden: false,
        disabled: false,
        dataset: {},
        style: {},
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c)
        },
        addEventListener: (t, fn) => {
          if (!listeners.has(t)) listeners.set(t, []);
          listeners.get(t).push(fn);
        },
        click: async () => {
          for (const fn of listeners.get("click") || []) await fn();
        },
        select: () => {},
        remove: () => {}
      };
      return el;
    };
    for (const id of [
      "api-banner",
      "quick-key",
      "save-quick-key",
      "input-text",
      "output-text",
      "result-card",
      "copy-output",
      "status",
      "translate-btn",
      "open-options",
      "open-shortcuts",
      "shortcuts-card",
      "shortcuts-list",
      "close-shortcuts",
      "open-browser-shortcuts",
      "update-banner",
      "update-label",
      "update-now-btn"
    ]) {
      fakeEls.set(id, makeEl(id));
    }

    let execCopied = false;
    globalThis.document = {
      body: { appendChild: () => {} },
      getElementById: (id) => fakeEls.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => makeEl("tmp"),
      execCommand: (cmd) => {
        if (cmd === "copy") {
          execCopied = true;
          return true;
        }
        return false;
      }
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        clipboard: {
          writeText: async () => {
            throw new Error("Clipboard denied");
          }
        }
      }
    });
    globalThis.chrome = {
      storage: { local: { async get() { return {}; } } },
      runtime: {
        getManifest: () => ({ version: "1.8.0" }),
        sendMessage: (_msg, cb) => cb({ ok: true, reloaded: false, unsupportedReload: true })
      }
    };

    initPopup();
    assert.equal(fakeEls.get("open-browser-shortcuts").classList.contains("hidden"), true);
    assert.equal(fakeEls.get("open-browser-shortcuts").hidden, true);

    fakeEls.get("output-text").value = "Copied via fallback";
    await fakeEls.get("copy-output").click();
    assert.equal(execCopied, true);
    assert.equal(fakeEls.get("copy-output").textContent, "Copied ✓");
  });
});

describe("M6 background.js Error Hygiene, Serialization & Reload Safety", () => {
  it("handleTabAction guards all sendMessageToTab calls and avoids console.error on restricted page injection", async () => {
    const errorsLogged = [];
    const origConsoleError = console.error;
    console.error = (...args) => errorsLogged.push(args.join(" "));

    try {
      const storage = { provider: "openai", apiKey: "sk-test", model: "gpt-4.1-mini" };
      const sendCalls = [];
      globalThis.chrome = {
        storage: {
          local: {
            async get(defs) {
              return { ...defs, ...storage };
            }
          }
        },
        runtime: { lastError: null, getURL: (p) => `chrome-extension://id/${p}` },
        tabs: {
          async sendMessage(_tabId, msg) {
            sendCalls.push(msg.type);
            if (msg.type === "getSelection") return { text: "broken text" };
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
        },
        scripting: {
          async executeScript() {
            throw new Error("Cannot access contents of url \"orion://settings/\". Extension manifest must request permission to access this host.");
          }
        }
      };
      globalThis.fetch = async () => ({ ok: false, status: 500, async text() { return "server error"; } });

      const bg = await import("../../background.js");

      // Case 1: Restricted injection failure must NOT call console.error
      globalThis.chrome.tabs.sendMessage = async () => {
        throw new Error("Receiving end does not exist.");
      };
      await bg.handleTabAction(1, "fix", "", 0);
      assert.equal(errorsLogged.length, 0, "Restricted injection failure must not call console.error");

      // Case 2: All subsequent sendMessageToTab failures (showLoading, showError on AI fail) must NOT reject unhandled
      const errorMessages = [];
      globalThis.chrome.tabs.sendMessage = async (_id, msg) => {
        if (msg.type === "getSelection") return { text: "hello world" };
        if (msg.type === "showError") errorMessages.push(msg.message);
        throw new Error("Tab was closed.");
      };
      await bg.handleTabAction(2, "fix", "", 0);
      assert.ok(errorMessages.length === 1);
      assert.match(errorMessages[0], /^OpenAI API request failed:/);
    } finally {
      console.error = origConsoleError;
    }
  });

  it("setupContextMenus serializes concurrent calls cleanly without interleaving removeAll and create", async () => {
    const events = [];
    globalThis.chrome = {
      storage: { local: { async get(defs) { return defs; } } },
      runtime: { lastError: null },
      contextMenus: {
        removeAll(cb) {
          events.push("removeAll");
          setTimeout(() => cb(), 10);
        },
        create(opts, cb) {
          events.push(`create:${opts.id}`);
          if (cb) cb();
        }
      }
    };

    const bg = await import("../../background.js");
    await Promise.all([bg.setupContextMenus(), bg.setupContextMenus()]);

    const removeIndices = events.reduce((acc, ev, idx) => (ev === "removeAll" ? [...acc, idx] : acc), []);
    assert.equal(removeIndices.length, 2);
    assert.ok(removeIndices[1] > removeIndices[0] + 1, "Second removeAll must run after first create batch completes");
    assert.equal(events[removeIndices[0] + 1], "create:text-ai-tools-root");
    assert.equal(events[removeIndices[1] + 1], "create:text-ai-tools-root");
  });

  it("registerListeners handles openOptions fallback, safe sendResponse, and avoids unpermitted startup fetches or reload crashes", async () => {
    const listeners = { onInstalled: [], onStartup: [], onMessage: [], onCommand: [], onClicked: [] };
    const createdTabs = [];
    let fetchCalls = 0;
    let reloadCalls = 0;

    globalThis.fetch = async (url) => {
      fetchCalls += 1;
      if (String(url).endsWith("manifest.json")) {
        return { ok: true, async json() { return { version: "1.9.0" }; } };
      }
      return { ok: false, status: 404 };
    };

    globalThis.chrome = {
      storage: { local: { async get(defs) { return defs; }, async set() {} }, onChanged: { addListener() {} } },
      runtime: {
        lastError: null,
        getURL: (p) => `chrome-extension://id/${p}`,
        getManifest: () => ({ version: "1.8.0" }),
        openOptionsPage() {
          throw new Error("openWebExtOptionsPage couldn't find a browser controller");
        },
        onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
        onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
        onMessage: { addListener: (fn) => listeners.onMessage.push(fn) }
      },
      contextMenus: {
        removeAll: (cb) => cb?.(),
        create: (_o, cb) => cb?.(),
        onClicked: { addListener: (fn) => listeners.onClicked.push(fn) }
      },
      commands: { onCommand: { addListener: (fn) => listeners.onCommand.push(fn) } },
      tabs: {
        async create(opts) { createdTabs.push(opts); },
        async query() { return [{ id: 10 }]; },
        async sendMessage() { throw new Error("No tab"); }
      },
      scripting: { async executeScript() { return []; } }
    };

    const bg = await import("../../background.js");
    bg.registerListeners();

    // 1. onStartup must NOT call fetch(raw.githubusercontent.com) or crash
    for (const fn of listeners.onStartup) fn();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCalls, 0, "onStartup must not automatically fetch remote manifest");

    // 2. openOptions returns false synchronously and falls back to tabs.create
    const onMessage = listeners.onMessage[0];
    let syncRes = null;
    const isAsync = onMessage({ type: "openOptions" }, {}, (res) => {
      syncRes = res;
    });
    assert.equal(isAsync, false);
    assert.deepEqual(syncRes, { ok: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(createdTabs[0], { url: "chrome-extension://id/options.html" });

    // 3. checkAndReloadUpdate without chrome.runtime.reload reports unsupportedReload cleanly
    const noReloadRes = await bg.handleRuntimeMessage({ type: "checkAndReloadUpdate" });
    assert.equal(noReloadRes.ok, true);
    assert.equal(noReloadRes.reloaded, false);
    assert.equal(noReloadRes.unsupportedReload, true);

    // 4. checkAndReloadUpdate WITH chrome.runtime.reload responds BEFORE deferred reload fires
    globalThis.chrome.runtime.reload = () => {
      reloadCalls += 1;
    };
    let asyncReply = null;
    const keepOpen = onMessage({ type: "checkAndReloadUpdate" }, {}, (res) => {
      asyncReply = res;
    });
    assert.equal(keepOpen, true);
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(asyncReply, { ok: true, reloaded: true });
    assert.equal(reloadCalls, 0, "Reload must be deferred until after sendResponse");
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(reloadCalls, 1);

    // 5. Closed-tab sendResponse throwing must not produce unhandled rejection
    const keepOpen2 = onMessage({ type: "getLexicon", lang: "invalid/.." }, {}, () => {
      throw new Error("Attempting to use a disconnected port object");
    });
    assert.equal(keepOpen2, true);
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("M6 content.js & dom-editor.js Orion Lifecycle, Ask AI & Dismiss Regression Tests", () => {
  it("works with Orion callback-only sendMessage for Ask AI and recovers from focusout with relatedTarget=null, renders .loading-row, preserves qaHistory, and renders Open Settings", async () => {
    let askCount = 0;
    const env = bootContentVM({
      sendMessageImpl(msg, cb, chromeMock) {
        if (msg.type === "getLexicon") {
          const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
          const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));
          cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
          return undefined;
        }
        if (msg.type === "askAIQuestion") {
          askCount += 1;
          if (askCount === 1) {
            setTimeout(() => cb({ ok: true, result: "First answer." }), 25);
          } else {
            setTimeout(() => cb({ ok: false, error: "API key missing.", openOptions: true }), 25);
          }
          return undefined; // Strict callback-only Orion shim: returns undefined!
        }
        if (msg.type === "openOptions") {
          cb({ ok: true });
          return undefined;
        }
        chromeMock.runtime.lastError = null;
        cb({ ok: true });
        return undefined;
      }
    });

    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    ta.value = "We need a concise summary.";
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new env.MockEvent("mouseup", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    const styleText = sr.querySelector("style").childNodes.map((n) => n.nodeValue).join("");
    assert.match(styleText, /\.loading-row\b/, "Shadow DOM stylesheet must define .loading-row");

    const trigger = sr.querySelector('[data-role="sentence-trigger"]');
    assert.ok(trigger);
    trigger.click();

    const askForm = sr.querySelector(".ask-form");
    const askInput = sr.querySelector(".ask-input");
    assert.ok(askForm && askInput);
    askInput.focus();
    askInput.value = "What is this about?";
    askForm.dispatchEvent(new env.MockEvent("submit", { bubbles: true, cancelable: true }));

    // Simulate WebKit focusout with relatedTarget: null when bodyContainer swaps to .loading-row
    env.doc.activeElement = env.doc.body;
    askInput.dispatchEvent(new env.MockEvent("focusout", { bubbles: true, relatedTarget: null }));

    assert.ok(sr.querySelector(".loading-row"), ".loading-row must render while Ask AI request is pending");

    // Wait past the 120ms focusout timer + 25ms async response
    await new Promise((r) => setTimeout(r, 170));
    const answerEl = sr.querySelector(".ask-answer");
    assert.ok(answerEl, "Ask AI menu must survive focusout with relatedTarget=null and render answer");
    assert.match(answerEl.textContent, /First answer\./);

    // Follow-up error must preserve prior qaHistory AND render Open Settings button
    const followForm = sr.querySelector(".ask-form");
    const followInput = sr.querySelector(".ask-input");
    followInput.value = "Follow-up question?";
    followForm.dispatchEvent(new env.MockEvent("submit", { bubbles: true, cancelable: true }));

    await new Promise((r) => setTimeout(r, 60));
    const preservedAnswer = sr.querySelector(".ask-answer");
    const errEl = sr.querySelector(".ask-error");
    const settingsBtn = sr.querySelector(".inline-settings-btn");
    assert.ok(preservedAnswer && preservedAnswer.textContent.includes("First answer."), "Prior Q&A thread must be preserved on error");
    assert.ok(errEl && errEl.textContent.includes("API key missing."), "Inline error must render below thread");
    assert.ok(settingsBtn, "Open Settings button must render when res.openOptions is true");

    settingsBtn.click();
    assert.equal(env.sentMessages.some((m) => m.type === "openOptions"), true);
  });

  it("outside-click mousedown dismisses floating menu cleanly without ReferenceError", async () => {
    const env = bootContentVM();
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    ta.value = "Hello world.";
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new env.MockEvent("mouseup", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    sr.querySelector('[data-role="sentence-trigger"]').click();
    assert.ok(sr.querySelector(".suggestion-menu"), "Suggestion menu must be open");

    // Click outside on document.body (must NOT throw ReferenceError: clearActionMenus is not defined)
    env.doc.body.dispatchEvent(new env.MockEvent("mousedown", { bubbles: true }));
    assert.equal(sr.querySelector(".suggestion-menu"), null, "Outside click must dismiss suggestion menu");
  });

  it("fetchLexicon handles failure with getURL fallback, applies cooldown without infinite keystroke loops, and recovers on later focusin", async () => {
    let bgAlive = false;
    const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
    const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));

    // Case A: Background getLexicon fails, getURL fallback succeeds
    const envFallback = bootContentVM({
      sendMessageImpl(msg, cb, chromeMock) {
        if (msg.type === "getLexicon") {
          chromeMock.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          cb(undefined);
          chromeMock.runtime.lastError = null;
          return undefined;
        }
        cb({ ok: true });
        return undefined;
      },
      fetchImpl: async (url) => ({
        ok: true,
        async json() {
          return String(url).includes("/tr.json") ? trLexicon : enLexicon;
        }
      })
    });

    const ta1 = envFallback.doc.createElement("textarea");
    envFallback.doc.body.appendChild(ta1);
    ta1.focus();
    ta1.dispatchEvent(new envFallback.MockEvent("focusin", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));

    ta1.value = "ozetle ";
    ta1.setSelectionRange(7, 7);
    ta1.dispatchEvent(new envFallback.MockInputEvent("input", { bubbles: true }));
    assert.equal(ta1.value, "özetle ", "Local spellcheck must work via getURL fallback when background is suspended");

    // Case B: Both background and getURL fail -> cooldown prevents hammering on every keystroke, then focusin recovers when bg returns
    const envRecovery = bootContentVM({
      sendMessageImpl(msg, cb, chromeMock) {
        if (msg.type === "getLexicon") {
          if (!bgAlive) {
            chromeMock.runtime.lastError = { message: "Could not establish connection." };
            cb(undefined);
            chromeMock.runtime.lastError = null;
          } else {
            cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
          }
          return undefined;
        }
        cb({ ok: true });
        return undefined;
      },
      fetchImpl: async () => ({ ok: false, status: 404 })
    });

    const ta2 = envRecovery.doc.createElement("textarea");
    envRecovery.doc.body.appendChild(ta2);
    ta2.focus();
    ta2.dispatchEvent(new envRecovery.MockEvent("focusin", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const afterFocusCount = envRecovery.sentMessages.filter((m) => m.type === "getLexicon").length;
    assert.equal(afterFocusCount, 2);

    // Multiple keystrokes during cooldown must NOT re-send getLexicon
    for (const txt of ["a ", "b ", "c "]) {
      ta2.value = txt;
      ta2.setSelectionRange(2, 2);
      ta2.dispatchEvent(new envRecovery.MockInputEvent("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      envRecovery.sentMessages.filter((m) => m.type === "getLexicon").length,
      2,
      "Cooldown must prevent getLexicon spam on every keystroke"
    );

    // Background wakes up -> next focusin recovers and auto-corrects
    bgAlive = true;
    ta2.dispatchEvent(new envRecovery.MockEvent("focusin", { bubbles: true }));
    ta2.value = "ozetle ";
    ta2.setSelectionRange(7, 7);
    ta2.dispatchEvent(new envRecovery.MockInputEvent("input", { bubbles: true }));
    assert.equal(ta2.value, "özetle ");
  });

  it("handles Extension context invalidated teardown and clean re-injection without duplicate listeners", async () => {
    const env = bootContentVM({
      runtimeId: "ext-v1",
      sendMessageImpl(msg, cb) {
        if (msg.type === "getLexicon") {
          throw new Error("Extension context invalidated.");
        }
        cb({ ok: true });
      }
    });

    assert.equal(env.runtimeListeners.length, 1);
    assert.equal(env.storageListeners.length, 1);

    // Trigger sendMessage that throws Extension context invalidated
    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    // Listeners must be cleanly torn down on context invalidation
    assert.equal(env.runtimeListeners.length, 0);
    assert.equal(env.storageListeners.length, 0);

    // Re-inject with new runtime.id
    env.chromeMock.runtime.id = "ext-v2";
    env.chromeMock.runtime.sendMessage = (msg, cb) => {
      env.sentMessages.push(msg);
      if (msg.type === "getLexicon") {
        const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
        const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));
        cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
        return;
      }
      cb({ ok: true });
    };
    env.reinjectContent();

    assert.equal(env.runtimeListeners.length, 1, "Re-injection must register exactly one clean runtime listener");
    assert.equal(env.storageListeners.length, 1, "Re-injection must register exactly one clean storage listener");

    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    ta.value = "ozetle ";
    ta.setSelectionRange(7, 7);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));
    assert.equal(ta.value, "özetle ");
  });

  it("applyResult always calls sendResponse on error and falls back to modal when copyText returns false", async () => {
    const env = bootContentVM({
      clipboardWriteImpl: async () => {
        throw new Error("NotAllowedError: user activation expired");
      },
      execCommandImpl: () => false
    });

    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.value = "teh text";
    ta.setSelectionRange(0, ta.value.length);

    const listener = env.runtimeListeners[0];
    let selRes;
    listener({ type: "getSelection" }, {}, (r) => {
      selRes = r;
    });
    assert.equal(selRes.text, "teh text");

    // copyOnReplace=true with copyText returning false must fall back to modal instead of claiming copied
    let applyRes;
    listener(
      {
        type: "applyResult",
        mode: "replace",
        text: "the text",
        dialogTitle: "Proofread Text",
        copyOnReplace: true
      },
      {},
      (r) => {
        applyRes = r;
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.replaced, true);
    assert.equal(applyRes.copied, false);
    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    assert.ok(sr.querySelector(".modal"), "Failed clipboard copy after replace must open modal fallback");

    // Error inside applyResult (e.g. broken msg) must still invoke sendResponse
    let errRes;
    listener(
      { type: "applyResult", mode: "modal", text: { toString() { throw new Error("boom"); } } },
      {},
      (r) => {
        errRes = r;
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errRes?.ok, false);
  });

  it("DomEditor rejects disconnected editors (isConnected === false) and supports Shadow DOM activeElement", () => {
    const DomEditor = require("../../content/dom-editor.js");
    const { doc } = createContentDOM();

    const detached = doc.createElement("textarea");
    assert.equal(detached.isConnected, false);
    assert.equal(DomEditor.isEligibleEditor(detached), false);

    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const innerTa = doc.createElement("textarea");
    sr.appendChild(innerTa);
    doc.activeElement = host;
    sr.activeElement = innerTa;

    assert.equal(DomEditor.getDeepActiveElement(doc), innerTa);
    assert.equal(DomEditor.isEligibleEditor(innerTa), true);
  });

  it("typing inside .ask-input leaves askInput.value untouched, keeps .suggestion-menu intact, and supports Escape", async () => {
    const env = bootContentVM({
      sendMessageImpl(msg, cb) {
        if (msg.type === "getLexicon") {
          const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
          const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));
          cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
          return undefined;
        }
        cb({ ok: true, result: "Answer." });
        return undefined;
      }
    });

    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    ta.value = "We need a concise summary.";
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new env.MockEvent("mouseup", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    sr.querySelector('[data-role="sentence-trigger"]').click();

    const askInput = sr.querySelector(".ask-input");
    assert.ok(askInput, "Ask input must be rendered");
    assert.equal(
      env.context.__TEXT_AI_TOOLS__.DomEditor.resolveEditableTarget(askInput),
      null,
      "resolveEditableTarget must reject elements inside #text-tools-shadow-host"
    );

    askInput.focus();
    askInput.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    askInput.dispatchEvent(new env.MockEvent("compositionstart", { bubbles: true }));
    askInput.value = "explain xqzblorf ";
    askInput.setSelectionRange(askInput.value.length, askInput.value.length);
    askInput.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));
    askInput.dispatchEvent(new env.MockEvent("keydown", { bubbles: true, key: " " }));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(askInput.value, "explain xqzblorf ", "Ask input value must never be spellchecked/mutated");
    assert.ok(sr.querySelector(".suggestion-menu"), ".suggestion-menu must remain intact when typing unknown words in .ask-input");
    assert.equal(sr.querySelector(".uncertain-popover"), null, "Must not open uncertain popover for .ask-input");

    // Verify activeEditor was NOT overwritten to askInput: with activeElement cleared,
    // floating trigger update only keeps the trigger if activeEditor remained ta.
    env.doc.activeElement = null;
    env.doc.body.dispatchEvent(new env.MockEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      sr.querySelector('[data-role="sentence-trigger"]'),
      "activeEditor must remain the page textarea so floating trigger stays intact"
    );

    // Verify Escape inside .ask-input still closes the suggestion menu
    askInput.dispatchEvent(new env.MockEvent("keydown", { bubbles: true, key: "Escape" }));
    assert.equal(sr.querySelector(".suggestion-menu"), null, "Escape inside .ask-input must still close menu");

    // Verify compositionstart inside .ask-input did not leave page editor stuck in composing mode
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));
    ta.value = "ozetle ";
    ta.setSelectionRange(7, 7);
    ta.dispatchEvent(new env.MockInputEvent("input", { bubbles: true }));
    assert.equal(ta.value, "özetle ");
  });

  it("handleContextInvalidated 4600ms timer removes un-replaced toast host but does NOT remove a newly re-injected instance's shadow host", () => {
    const createFakeTimers = () => {
      let now = 0;
      let nextId = 1;
      const queue = new Map();
      return {
        setTimeoutImpl(fn, delay = 0) {
          const id = nextId++;
          queue.set(id, { fn, at: now + Math.max(0, Number(delay) || 0) });
          return id;
        },
        clearTimeoutImpl(id) {
          queue.delete(id);
        },
        advanceBy(ms) {
          const target = now + ms;
          while (true) {
            let earliest = null;
            for (const [id, entry] of queue.entries()) {
              if (entry.at <= target && (!earliest || entry.at < earliest.entry.at)) {
                earliest = { id, entry };
              }
            }
            if (!earliest) break;
            queue.delete(earliest.id);
            now = earliest.entry.at;
            earliest.entry.fn();
          }
          now = target;
        }
      };
    };

    // Case A: Without re-injection, the 4600ms timer cleans up the stale toast host
    const timersA = createFakeTimers();
    const envA = bootContentVM({
      runtimeId: "ext-v1",
      setTimeoutImpl: timersA.setTimeoutImpl,
      clearTimeoutImpl: timersA.clearTimeoutImpl,
      sendMessageImpl(msg) {
        if (msg.type === "getLexicon") {
          throw new Error("Extension context invalidated.");
        }
      }
    });
    const taA = envA.doc.createElement("textarea");
    envA.doc.body.appendChild(taA);
    taA.focus();
    taA.dispatchEvent(new envA.MockEvent("focusin", { bubbles: true }));
    assert.ok(envA.doc.getElementById("text-tools-shadow-host"), "Toast host must exist right after invalidation");
    timersA.advanceBy(4650);
    assert.equal(envA.doc.getElementById("text-tools-shadow-host"), null, "Stale toast host must be removed after 4600ms when not re-injected");

    // Case B: With re-injection at 1000ms, old 4600ms timer must NOT remove new instance's shadow host
    const timersB = createFakeTimers();
    const envB = bootContentVM({
      runtimeId: "ext-v1",
      setTimeoutImpl: timersB.setTimeoutImpl,
      clearTimeoutImpl: timersB.clearTimeoutImpl,
      sendMessageImpl(msg) {
        if (msg.type === "getLexicon") {
          throw new Error("Extension context invalidated.");
        }
      }
    });
    const taB = envB.doc.createElement("textarea");
    envB.doc.body.appendChild(taB);
    taB.focus();
    taB.dispatchEvent(new envB.MockEvent("focusin", { bubbles: true }));
    assert.ok(envB.doc.getElementById("text-tools-shadow-host")?.shadowRoot.querySelector(".toast"));

    timersB.advanceBy(1000);
    envB.chromeMock.runtime.id = "ext-v2";
    envB.chromeMock.runtime.sendMessage = (msg, cb) => {
      envB.sentMessages.push(msg);
      if (msg.type === "getLexicon") {
        const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
        const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));
        cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
        return undefined;
      }
      cb({ ok: true });
      return undefined;
    };
    envB.reinjectContent();

    taB.dispatchEvent(new envB.MockEvent("focusin", { bubbles: true }));
    taB.value = "We need a concise summary.";
    taB.setSelectionRange(0, taB.value.length);
    taB.dispatchEvent(new envB.MockEvent("mouseup", { bubbles: true }));
    timersB.advanceBy(100);
    const newHost = envB.doc.getElementById("text-tools-shadow-host");
    assert.ok(newHost, "New instance must create a connected shadow host");

    timersB.advanceBy(4000); // Total 5100ms (past original 4600ms timer)
    assert.equal(
      envB.doc.getElementById("text-tools-shadow-host"),
      newHost,
      "Old context invalidation timer must NOT delete the newly re-injected shadow host"
    );
    assert.equal(newHost.isConnected, true);
  });

  it("teardownInstance({ removeHost: false }) clears #slot-menu, #slot-trigger, #slot-undo, and #text-tools-underlines during reload toast", async () => {
    let failOnAsk = false;
    const env = bootContentVM({
      runtimeId: "ext-v1",
      sendMessageImpl(msg, cb) {
        if (msg.type === "getLexicon") {
          const trLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/tr.json"), "utf8"));
          const enLexicon = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/en.json"), "utf8"));
          cb({ ok: true, lang: msg.lang, data: msg.lang === "tr" ? trLexicon : enLexicon });
          return undefined;
        }
        if (msg.type === "askAIQuestion" && failOnAsk) {
          throw new Error("Extension context invalidated.");
        }
        cb({ ok: true });
        return undefined;
      }
    });

    const ta = env.doc.createElement("textarea");
    env.doc.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new env.MockEvent("focusin", { bubbles: true }));

    // Select text -> show floating trigger (#slot-trigger) -> open suggestion menu (#slot-menu)
    ta.value = "We need a concise summary.";
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new env.MockEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const host = env.doc.getElementById("text-tools-shadow-host");
    const sr = host.shadowRoot;
    sr.querySelector('[data-role="sentence-trigger"]').click();
    assert.ok(sr.getElementById("slot-trigger").childNodes.length > 0, "#slot-trigger must be populated");
    assert.ok(sr.getElementById("slot-menu").childNodes.length > 0, "#slot-menu must be populated");

    // Populate #slot-undo and #text-tools-underlines to verify all floating slots are cleared on teardown
    const fakeUndoPill = env.doc.createElement("div");
    fakeUndoPill.className = "undo-pill";
    sr.getElementById("slot-undo").appendChild(fakeUndoPill);
    const fakeUnderline = env.doc.createElement("div");
    fakeUnderline.className = "uncertain-underline";
    sr.getElementById("text-tools-underlines").appendChild(fakeUnderline);

    // Submit Ask AI when runtime context is invalidated
    failOnAsk = true;
    const askForm = sr.querySelector(".ask-form");
    const askInput = sr.querySelector(".ask-input");
    askInput.value = "Explain?";
    askForm.dispatchEvent(new env.MockEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(host.isConnected, true, "Shadow host must stay connected for the reload toast");
    assert.ok(sr.querySelector(".toast"), "Reload toast must be displayed");
    assert.equal(sr.getElementById("slot-menu").childNodes.length, 0, "#slot-menu must be cleared during reload toast");
    assert.equal(sr.getElementById("slot-trigger").childNodes.length, 0, "#slot-trigger must be cleared during reload toast");
    assert.equal(sr.getElementById("slot-undo").childNodes.length, 0, "#slot-undo must be cleared during reload toast");
    assert.equal(sr.getElementById("text-tools-underlines").childNodes.length, 0, "#text-tools-underlines must be cleared during reload toast");
  });

  it("showModal() keydown listener is removed both on Escape close and when teardownInstance() runs", async () => {
    const env = bootContentVM();
    const listener = env.runtimeListeners[0];
    const baseKeydownCount = (env.doc.listeners.get("keydown") || []).length;

    // 1. Open modal and close via Escape
    listener({ type: "applyResult", mode: "modal", text: "Result 1", dialogTitle: "Test 1" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    const sr = env.doc.getElementById("text-tools-shadow-host").shadowRoot;
    assert.ok(sr.querySelector(".modal"));
    assert.equal((env.doc.listeners.get("keydown") || []).length, baseKeydownCount + 1);

    env.doc.dispatchEvent(new env.MockEvent("keydown", { key: "Escape" }));
    assert.equal(sr.querySelector(".modal"), null);
    assert.equal((env.doc.listeners.get("keydown") || []).length, baseKeydownCount);

    // 2. Open modal and run teardownInstance() -> zero leaked keydown listeners
    listener({ type: "applyResult", mode: "modal", text: "Result 2", dialogTitle: "Test 2" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sr.querySelector(".modal"));
    assert.equal((env.doc.listeners.get("keydown") || []).length, baseKeydownCount + 1);

    env.context.__TEXT_AI_TOOLS_STATE__.cleanup();
    assert.equal((env.doc.listeners.get("keydown") || []).length, 0, "teardownInstance must leave zero keydown listeners on document");
  });

  it("DomEditor handles Shadow DOM contenteditable selection via getSelectionForNode, getEffectiveSelectionRange, extractWordBeforeCaret, and replaceRangeSafely", () => {
    const DomEditor = require("../../content/dom-editor.js");
    const { doc, MockSelection, MockRange } = createContentDOM();

    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });

    const ce = doc.createElement("div");
    ce.setAttribute("contenteditable", "true");
    const txt = doc.createTextNode("ozetle ");
    ce.appendChild(txt);
    sr.appendChild(ce);

    doc.activeElement = host;
    sr.activeElement = ce;

    const caretRange = new MockRange(doc);
    caretRange.setStart(txt, 7);
    caretRange.collapse(true);

    let composedArgs = null;
    const srSel = new MockSelection();
    srSel.addRange(caretRange);
    srSel.getComposedRanges = (opts) => {
      composedArgs = opts;
      return [{ startContainer: txt, startOffset: 7, endContainer: txt, endOffset: 7 }];
    };
    sr.getSelection = () => srSel;

    assert.equal(DomEditor.getSelectionForNode(ce), srSel);
    const eff = DomEditor.getEffectiveSelectionRange(ce);
    assert.ok(eff && eff.range);
    assert.deepEqual(composedArgs, { shadowRoots: [sr] });
    assert.equal(eff.range.startContainer, txt);
    assert.equal(eff.range.startOffset, 7);

    const extracted = DomEditor.extractWordBeforeCaret(ce);
    assert.ok(extracted);
    assert.equal(extracted.word, "ozetle");
    assert.equal(extracted.boundaryChar, " ");
    assert.equal(extracted.start, 0);
    assert.equal(extracted.end, 6);

    const replaced = DomEditor.replaceRangeSafely(ce, extracted.rangeSnapshot, "özetle");
    assert.equal(replaced, true);
    assert.equal(ce.textContent, "özetle ");
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");

function createChromeMock(initialStorage = {}) {
  const storageData = { ...initialStorage };
  const listeners = {
    onInstalled: [],
    onStartup: [],
    storageChanged: [],
    contextMenuClicked: [],
    command: [],
    message: []
  };
  const calls = {
    sendMessage: [],
    executeScript: [],
    openOptionsPage: 0,
    tabsCreate: [],
    contextMenusRemoveAll: 0,
    contextMenusCreate: []
  };

  let sendMessageImpl = async () => ({ text: "" });
  let executeScriptImpl = async () => [];

  const chrome = {
    storage: {
      local: {
        async get(defaults) {
          if (!defaults || typeof defaults !== "object") return { ...storageData };
          const result = {};
          for (const [k, v] of Object.entries(defaults)) {
            result[k] = Object.prototype.hasOwnProperty.call(storageData, k) ? storageData[k] : v;
          }
          return result;
        },
        async set(values) {
          Object.assign(storageData, values);
        }
      },
      onChanged: {
        addListener(fn) {
          listeners.storageChanged.push(fn);
        }
      }
    },
    runtime: {
      getURL(relPath) {
        return `chrome-extension://test-ext-id/${relPath}`;
      },
      openOptionsPage() {
        calls.openOptionsPage += 1;
      },
      onInstalled: {
        addListener(fn) {
          listeners.onInstalled.push(fn);
        }
      },
      onStartup: {
        addListener(fn) {
          listeners.onStartup.push(fn);
        }
      },
      onMessage: {
        addListener(fn) {
          listeners.message.push(fn);
        }
      }
    },
    contextMenus: {
      removeAll(cb) {
        calls.contextMenusRemoveAll += 1;
        if (cb) cb();
      },
      create(opts) {
        calls.contextMenusCreate.push(opts);
      },
      onClicked: {
        addListener(fn) {
          listeners.contextMenuClicked.push(fn);
        }
      }
    },
    commands: {
      onCommand: {
        addListener(fn) {
          listeners.command.push(fn);
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 42 }];
      },
      async sendMessage(tabId, message, options) {
        calls.sendMessage.push({ tabId, message, options });
        return sendMessageImpl(tabId, message, options);
      },
      async create(opts) {
        calls.tabsCreate.push(opts);
      }
    },
    scripting: {
      async executeScript(arg) {
        calls.executeScript.push(arg);
        return executeScriptImpl(arg);
      }
    }
  };

  return {
    chrome,
    storageData,
    listeners,
    calls,
    setSendMessageImpl(fn) {
      sendMessageImpl = fn;
    },
    setExecuteScriptImpl(fn) {
      executeScriptImpl = fn;
    }
  };
}

let originalChrome;
let originalFetch;

beforeEach(() => {
  originalChrome = globalThis.chrome;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("M3 manifest.json & UI contracts", () => {
  it("manifest.json configures MV3 all_frames content_scripts and keeps host_permissions restricted", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, "Text AI Tools");
    assert.equal(manifest.options_page, "options.html");
    assert.deepEqual(manifest.host_permissions, ["https://generativelanguage.googleapis.com/*"]);
    assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
    const cs = manifest.content_scripts[0];
    assert.deepEqual(cs.matches, ["<all_urls>"]);
    assert.equal(cs.all_frames, true);
    assert.equal(cs.match_about_blank, true);
    assert.equal(cs.run_at, "document_idle");
    assert.deepEqual(cs.js, [
      "content/language-registry.js",
      "content/morphology-tr.js",
      "content/deasciifier-tr.js",
      "content/personal-model.js",
      "content/spellcheck-engine.js",
      "content/undo-manager.js",
      "content/dom-editor.js",
      "content.js"
    ]);
  });

  it("options.html includes provider selector, concise local storage disclosure, model datalist, and spellcheck toggles", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "options.html"), "utf8");
    assert.match(html, /id="provider"/);
    assert.match(html, /id="custom-base-url"/);
    assert.match(html, /id="api-security-notice"/);
    assert.match(html, /chrome\.storage\.local/);
    assert.match(html, /value="gemini-3\.5-flash-lite"/);
    assert.match(html, /value="gemini-3\.8-flash"/);
    assert.match(html, /value="gemini-flash-lite-latest"/);
    assert.match(html, /id="spellcheck-enabled"/);
    assert.match(html, /id="auto-correct-enabled"/);
  });

  it("popup.js detects Opera vs Chrome shortcuts URL", async () => {
    const { getShortcutsUrl } = await import("../../popup.js");
    assert.equal(
      getShortcutsUrl("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 OPR/140.0.6074.18"),
      "opera://extensions/shortcuts"
    );
    assert.equal(
      getShortcutsUrl("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/157.0.8103.79 Safari/537.36"),
      "chrome://extensions/shortcuts"
    );
  });
});

describe("M3 shared/actions.js (Gemini 3.5+ & retry logic)", () => {
  it("exports expected defaults and reads spellcheckEnabled / autoCorrectEnabled via getSettings()", async () => {
    const mock = createChromeMock({});
    globalThis.chrome = mock.chrome;

    const actions = await import("../../shared/actions.js");
    assert.equal(actions.DEFAULT_MODEL, "gemini-3.5-flash-lite");
    assert.ok(actions.SUPPORTED_MODELS.includes("gemini-3.5-flash-lite"));
    assert.ok(actions.SUPPORTED_MODELS.includes("gemini-3.8-flash"));
    assert.ok(actions.SUPPORTED_MODELS.includes("gemini-flash-lite-latest"));

    for (const action of Object.values(actions.ACTIONS)) {
      assert.equal("temperature" in action, false, `Action ${action.id} must not define temperature`);
    }

    const defaults = await actions.getSettings();
    assert.deepEqual(defaults, {
      provider: "gemini",
      customBaseUrl: "",
      apiKey: "",
      model: "gemini-3.5-flash-lite",
      primaryLanguage: "Turkish",
      secondaryLanguage: "English",
      copyOnReplace: true,
      spellcheckEnabled: true,
      autoCorrectEnabled: true
    });

    await mock.chrome.storage.local.set({
      apiKey: "  AIzaTestKey123  ",
      model: "gemini-3.8-flash",
      primaryLanguage: "German",
      secondaryLanguage: "French",
      copyOnReplace: false,
      spellcheckEnabled: false,
      autoCorrectEnabled: false
    });

    const updated = await actions.getSettings();
    assert.deepEqual(updated, {
      provider: "gemini",
      customBaseUrl: "",
      apiKey: "AIzaTestKey123",
      model: "gemini-3.8-flash",
      primaryLanguage: "German",
      secondaryLanguage: "French",
      copyOnReplace: false,
      spellcheckEnabled: false,
      autoCorrectEnabled: false
    });
  });

  it("callGemini omits temperature from generationConfig and sends user role turn", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: "Corrected sentence." }] } }]
          };
        }
      };
    };

    const { callGemini } = await import("../../shared/actions.js");
    const result = await callGemini({
      apiKey: "AIzaSecretTestKey",
      actionId: "fix",
      text: "teh sentence.",
      retryBaseDelayMs: 0
    });

    assert.equal(result, "Corrected sentence.");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(requests[0].init.headers["x-goog-api-key"], "AIzaSecretTestKey");
    assert.equal(requests[0].body.contents[0].role, "user");
    assert.equal(requests[0].body.generationConfig?.temperature, undefined);
    assert.equal(JSON.stringify(requests[0].body).includes("temperature"), false);
  });

  it("fails fast on 4xx client errors (400, 401, 403, 404) without retrying", async () => {
    const { callGemini } = await import("../../shared/actions.js");

    for (const status of [400, 401, 403, 404]) {
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
          ok: false,
          status,
          async text() {
            return `Client error ${status}`;
          }
        };
      };

      await assert.rejects(
        () =>
          callGemini({
            apiKey: "AIzaSecretTestKey",
            actionId: "fix",
            text: "hello world",
            retryBaseDelayMs: 0
          }),
        new RegExp(`HTTP ${status}:`)
      );
      assert.equal(fetchCalls, 1, `HTTP ${status} must fail fast on attempt 1`);
    }
  });

  it("retries on HTTP 429 and 503 and network errors, succeeding on later 200", async () => {
    const { callGemini } = await import("../../shared/actions.js");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return { ok: false, status: 429, async text() { return "rate limited"; } };
      }
      if (fetchCalls === 2) {
        return { ok: false, status: 503, async text() { return "unavailable"; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Recovered." }] } }] };
        }
      };
    };

    const output = await callGemini({
      apiKey: "AIzaSecretTestKey",
      actionId: "professional",
      text: "pls fix",
      retryBaseDelayMs: 0
    });
    assert.equal(output, "Recovered.");
    assert.equal(fetchCalls, 3);

    let netCalls = 0;
    globalThis.fetch = async () => {
      netCalls += 1;
      if (netCalls < 2) {
        throw new TypeError("network down");
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Network recovered." }] } }] };
        }
      };
    };

    const output2 = await callGemini({
      apiKey: "AIzaSecretTestKey",
      actionId: "fix",
      text: "hello",
      retryBaseDelayMs: 0
    });
    assert.equal(output2, "Network recovered.");
    assert.equal(netCalls, 2);
  });

  it("fetchSentenceSuggestions sends structured JSON schema without temperature and parses options", async () => {
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        options: [
                          {
                            category: "grammar",
                            label: "Fix grammar",
                            text: "He goes to school every day.",
                            explanation: "Third-person singular verb agreement"
                          },
                          {
                            category: "fluency",
                            label: "More natural",
                            text: "He attends school daily."
                          }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    };

    const { fetchSentenceSuggestions } = await import("../../shared/actions.js");
    const res = await fetchSentenceSuggestions({
      text: "He go to school every day.",
      mode: "sentence",
      primaryLanguage: "Turkish",
      secondaryLanguage: "English",
      apiKey: "AIzaSecretTestKey",
      retryBaseDelayMs: 0
    });

    assert.equal(capturedBody.generationConfig.responseMimeType, "application/json");
    assert.ok(capturedBody.generationConfig.responseJsonSchema);
    assert.equal(capturedBody.generationConfig.temperature, undefined);
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].category, "grammar");
    assert.equal(res.options[0].text, "He goes to school every day.");
    assert.equal(res.options[1].category, "fluency");
  });

  it("fetchContextualWordSuggestions sends structured JSON schema without temperature and parses suggestions", async () => {
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestions: [
                          { word: "psychology", reason: "Matches phonetic 'saykoloci' in context" },
                          { word: "psychiatry", reason: "Related clinical term" }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    };

    const { fetchContextualWordSuggestions } = await import("../../shared/actions.js");
    const res = await fetchContextualWordSuggestions({
      sentence: "I am studying saykoloci at university.",
      targetWord: "saykoloci",
      primaryLanguage: "Turkish",
      secondaryLanguage: "English",
      apiKey: "AIzaSecretTestKey",
      retryBaseDelayMs: 0
    });

    assert.equal(capturedBody.generationConfig.responseMimeType, "application/json");
    assert.ok(capturedBody.generationConfig.responseJsonSchema);
    assert.equal(capturedBody.generationConfig.temperature, undefined);
    assert.match(capturedBody.contents[0].parts[0].text, /saykoloci/);
    assert.deepEqual(res.suggestions, [
      { word: "psychology", reason: "Matches phonetic 'saykoloci' in context" },
      { word: "psychiatry", reason: "Related clinical term" }
    ]);
  });

  it("detectProviderFromApiKey identifies Gemini, OpenRouter, Groq, and OpenAI prefixes", async () => {
    const { detectProviderFromApiKey } = await import("../../shared/actions.js");
    assert.equal(detectProviderFromApiKey("AIzaSyTest123"), "gemini");
    assert.equal(detectProviderFromApiKey("sk-or-v1-abc123"), "openrouter");
    assert.equal(detectProviderFromApiKey("gsk_test123"), "groq");
    assert.equal(detectProviderFromApiKey("sk-proj-abc123"), "openai");
    assert.equal(detectProviderFromApiKey("unknown-key"), null);
  });

  it("callAI supports OpenAI-compatible providers (OpenAI / OpenRouter / Custom)", async () => {
    let capturedUrl = "";
    let capturedHeaders = null;
    let capturedBody = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: "Fixed OpenAI text." } }]
          };
        }
      };
    };

    const { callAI } = await import("../../shared/actions.js");
    const output = await callAI({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      model: "openai/gpt-4o-mini",
      actionId: "fix",
      text: "broken text",
      retryBaseDelayMs: 0
    });

    assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(capturedHeaders.Authorization, "Bearer sk-or-v1-test");
    assert.equal(capturedBody.model, "openai/gpt-4o-mini");
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[1].content, "broken text");
    assert.equal(output, "Fixed OpenAI text.");
  });
});

describe("M3 background.js service worker handlers", () => {
  it("getLexicon loads bundled JSON, caches in memory, and handles missing/invalid languages gracefully", async () => {
    const mock = createChromeMock({});
    globalThis.chrome = mock.chrome;

    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      if (url.endsWith("shared/lexicons/tr.json")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { lang: "tr", roots: { kitap: 100 } };
          }
        };
      }
      return { ok: false, status: 404 };
    };

    const bg = await import("../../background.js");
    bg.clearLexiconCache();

    const first = await bg.handleRuntimeMessage({ type: "getLexicon", lang: "tr" });
    assert.equal(first.ok, true);
    assert.equal(first.lang, "tr");
    assert.deepEqual(first.data, { lang: "tr", roots: { kitap: 100 } });
    assert.equal(fetchCount, 1);

    const cached = await bg.handleRuntimeMessage({ type: "getLexicon", lang: "TR" });
    assert.equal(cached.ok, true);
    assert.equal(fetchCount, 1, "Second call should hit in-memory cache");

    const missing = await bg.handleRuntimeMessage({ type: "getLexicon", lang: "fr" });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No bundled lexicon/i);

    const traversal = await bg.handleRuntimeMessage({ type: "getLexicon", lang: "../manifest" });
    assert.equal(traversal.ok, false);
  });

  it("handles geminiSentenceSuggestions & geminiContextualWord without leaking apiKey", async () => {
    const mock = createChromeMock({});
    globalThis.chrome = mock.chrome;

    const bg = await import("../../background.js");

    const noKeyRes = await bg.handleRuntimeMessage({
      type: "geminiSentenceSuggestions",
      text: "Test sentence.",
      mode: "sentence"
    });
    assert.equal(noKeyRes.ok, false);
    assert.equal(noKeyRes.openOptions, true);

    await mock.chrome.storage.local.set({ apiKey: "AIzaPrivateKeyNeverLeak" });
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      options: [{ category: "grammar", label: "Fixed", text: "Test sentence fixed." }]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    });

    const sentenceRes = await bg.handleRuntimeMessage({
      type: "geminiSentenceSuggestions",
      text: "Test sentnce.",
      mode: "sentence",
      primaryLang: "Turkish",
      secondaryLang: "English"
    });
    assert.equal(sentenceRes.ok, true);
    assert.equal(sentenceRes.options[0].text, "Test sentence fixed.");
    assert.equal(JSON.stringify(sentenceRes).includes("AIzaPrivateKeyNeverLeak"), false);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      suggestions: [{ word: "necessary", reason: "Phonetic match for nesesery" }]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    });

    const wordRes = await bg.handleRuntimeMessage({
      type: "geminiContextualWord",
      sentence: "It is nesesery to test.",
      targetWord: "nesesery"
    });
    assert.equal(wordRes.ok, true);
    assert.equal(wordRes.suggestions[0].word, "necessary");
    assert.equal(JSON.stringify(wordRes).includes("AIzaPrivateKeyNeverLeak"), false);
  });

  it("relayModalToTopFrame forwards showTopFrameModal to frameId 0", async () => {
    const mock = createChromeMock({});
    globalThis.chrome = mock.chrome;

    const bg = await import("../../background.js");
    const res = await bg.handleRuntimeMessage(
      { type: "relayModalToTopFrame", dialogTitle: "Summary", text: "- Point 1" },
      { tab: { id: 77 }, frameId: 3 }
    );

    assert.equal(res.ok, true);
    assert.equal(mock.calls.sendMessage.length, 1);
    assert.deepEqual(mock.calls.sendMessage[0], {
      tabId: 77,
      message: {
        type: "showTopFrameModal",
        dialogTitle: "Summary",
        text: "- Point 1"
      },
      options: { frameId: 0 }
    });
  });

  it("handleTabAction targets specific frameId and only injects via executeScript when not already responding", async () => {
    const mock = createChromeMock({ apiKey: "AIzaSecret" });
    globalThis.chrome = mock.chrome;

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: "Fixed in iframe." }] } }]
        };
      }
    });

    const bg = await import("../../background.js");

    // Case 1: Content script already loaded in frameId 5
    mock.setSendMessageImpl(async (_tabId, msg) => {
      if (msg.type === "getSelection") return { text: "broken txt" };
      return { ok: true };
    });

    await bg.handleTabAction(12, "fix", "", 5);
    assert.equal(mock.calls.executeScript.length, 0, "Should skip executeScript when frame already responds");
    assert.ok(mock.calls.sendMessage.every((c) => c.options?.frameId === 5));
    assert.equal(mock.calls.sendMessage.at(-1).message.type, "applyResult");
    assert.equal(mock.calls.sendMessage.at(-1).message.text, "Fixed in iframe.");

    // Case 2: Frame not yet injected -> first getSelection throws -> executeScript called with frameIds: [9]
    mock.calls.sendMessage.length = 0;
    let injected = false;
    mock.setExecuteScriptImpl(async () => {
      injected = true;
      return [];
    });
    mock.setSendMessageImpl(async (_tabId, msg) => {
      if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
      if (msg.type === "getSelection") return { text: "iframe fallback" };
      return { ok: true };
    });

    await bg.handleTabAction(15, "fix", "fallback", 9);
    assert.equal(mock.calls.executeScript.length, 1);
    assert.deepEqual(mock.calls.executeScript[0], {
      target: { tabId: 15, frameIds: [9] },
      files: bg.CONTENT_SCRIPT_FILES
    });
    assert.ok(mock.calls.sendMessage.every((c) => c.options?.frameId === 9));
    assert.equal(mock.calls.sendMessage.at(-1).message.type, "applyResult");
  });
});

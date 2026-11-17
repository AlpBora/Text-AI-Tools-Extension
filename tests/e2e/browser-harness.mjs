import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "../..");
export const FIXTURES_DIR = path.join(PROJECT_ROOT, "tests/fixtures");

export const BROWSER_PATHS = {
  chrome:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  opera:
    process.env.OPERA_PATH ||
    "/Applications/Opera.app/Contents/MacOS/Opera"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.join(os.homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright"),
    "playwright"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "Playwright module not found. Set PLAYWRIGHT_PATH or ensure ~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright is present."
  );
}

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    let relPath = decodeURIComponent(reqUrl.pathname);
    if (relPath === "/") relPath = "/index.html";
    const resolved = path.resolve(FIXTURES_DIR, "." + relPath);
    if (!resolved.startsWith(FIXTURES_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(resolved).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    port: addr.port,
    baseUrl,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      })
  };
}

function defaultGeminiResponse(bodyJson) {
  const userText =
    bodyJson?.contents?.[0]?.parts?.map((p) => p?.text || "").join("") || "";
  const sysText =
    bodyJson?.system_instruction?.parts?.map((p) => p?.text || "").join("") || "";
  const schema = bodyJson?.generationConfig?.responseJsonSchema || null;
  const schemaProps = schema?.properties ? Object.keys(schema.properties) : [];
  const wantsJson =
    bodyJson?.generationConfig?.responseMimeType === "application/json" ||
    Boolean(schema);

  if (wantsJson && (schemaProps.includes("options") || /options/i.test(sysText))) {
    const cleanText = userText.trim() || "Sample sentence.";
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
                      label: "Grammar Fix",
                      text: `${cleanText} (grammar polished)`,
                      explanation: "Fixed grammar and punctuation."
                    },
                    {
                      category: "fluency",
                      label: "Fluency",
                      text: `${cleanText} (fluent rewrite)`,
                      explanation: "Improved natural flow."
                    },
                    {
                      category: "professional",
                      label: "Professional",
                      text: `${cleanText} (formal tone)`,
                      explanation: "More professional phrasing."
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

  if (
    wantsJson &&
    (schemaProps.includes("suggestions") || /suggestions|word/i.test(sysText))
  ) {
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  suggestions: [
                    { word: "necessary", reason: "Matches sentence context" },
                    { word: "essential", reason: "Contextual synonym" },
                    { word: "required", reason: "Formal alternative" }
                  ]
                })
              }
            ]
          }
        }
      ]
    };
  }

  return {
    candidates: [
      {
        content: {
          parts: [{ text: `Polished: ${userText.trim()}` }]
        }
      }
    ]
  };
}

export async function launchExtensionBrowser(
  browserName,
  { fixtureBaseUrl, extensionPath = PROJECT_ROOT, headed = false } = {}
) {
  const executablePath = BROWSER_PATHS[browserName];
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`Browser binary not found for "${browserName}": ${executablePath}`);
  }

  const { chromium } = loadPlaywright();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `text-ai-e2e-${browserName}-`)
  );

  // Strict headless (--headless=new) is ALWAYS the default so MV3 extensions
  // run with zero visible GUI windows and zero focus stealing.
  // Headed mode is ONLY permitted when explicitly requested via `--headed`.
  // Never fall back to headed mode automatically.
  const launchOptions = headed
    ? {
        executablePath,
        headless: false,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--enable-unsafe-extension-debugging",
          "--window-size=1280,860"
        ]
      }
    : {
        executablePath,
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions", "--headless"],
        args: [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--enable-unsafe-extension-debugging",
          "--window-size=1280,860"
        ]
      };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  } catch (err) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to launch ${browserName} in ${headed ? "headed" : "strict headless (--headless=new)"} mode: ${err?.message || err}`
    );
  }

  const consoleErrors = [];
  const pageErrors = [];
  const geminiRequests = [];
  let customResponder = null;

  context.on("page", (page) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push({ url: page.url(), text: msg.text() });
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push({ url: page.url(), message: err.message });
    });
  });

  await context.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    let bodyJson = null;
    try {
      bodyJson = raw ? JSON.parse(raw) : null;
    } catch {
      bodyJson = null;
    }

    const entry = {
      timestamp: Date.now(),
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      bodyRaw: raw,
      bodyJson
    };
    geminiRequests.push(entry);

    if (customResponder) {
      const custom = await customResponder(entry);
      if (custom) {
        await route.fulfill({
          status: custom.status ?? 200,
          contentType: custom.contentType || "application/json",
          body:
            typeof custom.body === "string"
              ? custom.body
              : JSON.stringify(custom.body)
        });
        return;
      }
    }

    const payload = defaultGeminiResponse(bodyJson);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload)
    });
  });

  let extensionId = null;
  let serviceWorker = null;
  try {
    const browserCdp = await context.browser().newBrowserCDPSession();
    const loaded = await browserCdp.send("Extensions.loadUnpacked", {
      path: extensionPath
    });
    extensionId = loaded.id;

    serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", {
        timeout: 8000
      });
    }
  } catch (err) {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    const modeLabel = headed ? "headed" : "strict headless (--headless=new)";
    throw new Error(
      `Failed to load MV3 unpacked extension in ${browserName} (${modeLabel}): ${err?.message || err}`
    );
  }

  async function setStorage(values) {
    await serviceWorker.evaluate(async (vals) => {
      await chrome.storage.local.set(vals);
    }, values);
  }

  async function resetStorage(overrides = {}) {
    const defaults = {
      apiKey: "test-local-api-key-000",
      model: "gemini-3.5-flash-lite",
      primaryLanguage: "Turkish",
      secondaryLanguage: "English",
      copyOnReplace: false,
      spellcheckEnabled: true,
      autoCorrectEnabled: true,
      ...overrides
    };
    await serviceWorker.evaluate(async (vals) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(vals);
    }, defaults);
  }

  async function getStorage() {
    return serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get(null);
    });
  }

  async function openFixturePage(relPath = "/index.html") {
    if (!fixtureBaseUrl) {
      throw new Error("fixtureBaseUrl was not provided to launchExtensionBrowser.");
    }
    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}${relPath}`, { waitUntil: "load" });
    await page.waitForTimeout(50);
    return page;
  }

  async function openOptionsPage() {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, {
      waitUntil: "load"
    });
    await page.waitForTimeout(50);
    return page;
  }

  async function openPopupPage() {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "load"
    });
    await page.waitForTimeout(50);
    return page;
  }

  async function cleanupPages() {
    const pages = context.pages();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (i === 0 && p.url() === "about:blank") continue;
      await p.close().catch(() => {});
    }
  }

  return {
    browserName,
    executablePath,
    userDataDir,
    headless: !headed,
    headed: Boolean(headed),
    context,
    extensionId,
    serviceWorker,
    setStorage,
    resetStorage,
    getStorage,
    openFixturePage,
    openOptionsPage,
    openPopupPage,
    cleanupPages,
    setGeminiResponder(fn) {
      customResponder = fn;
    },
    clearGeminiLog() {
      geminiRequests.length = 0;
    },
    getGeminiLog() {
      return geminiRequests.slice();
    },
    getConsoleErrors() {
      return consoleErrors.slice();
    },
    getPageErrors() {
      return pageErrors.slice();
    },
    async close() {
      await context.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

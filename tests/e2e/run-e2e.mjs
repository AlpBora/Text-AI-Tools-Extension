#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchExtensionBrowser, PROJECT_ROOT, startFixtureServer } from "./browser-harness.mjs";
import { buildTier1Cases } from "./tier1-coverage.mjs";
import { buildTier2Cases } from "./tier2-boundary.mjs";
import { buildTier3Cases } from "./tier3-pairwise.mjs";
import { buildTier4Cases } from "./tier4-scenarios.mjs";
import {
  assertZeroGeminiCalls,
  readEditorText,
  typeRealText
} from "./opaque-helpers.mjs";

function parseArgs(argv) {
  const opts = {
    tier: "all",
    browser: "both",
    feature: null,
    id: null,
    smoke: false,
    json: false,
    headed: false
  };
  for (const arg of argv) {
    if (arg === "--smoke") opts.smoke = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--headed") opts.headed = true;
    else if (arg.startsWith("--tier=")) opts.tier = arg.slice("--tier=".length).toLowerCase();
    else if (arg.startsWith("--browser=")) opts.browser = arg.slice("--browser=".length).toLowerCase();
    else if (arg.startsWith("--feature=")) {
      opts.feature = arg
        .slice("--feature=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg.startsWith("--id=")) {
      opts.id = arg
        .slice("--id=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node tests/e2e/run-e2e.mjs [options]
  --tier=1|2|3|4|all      Select test tier (default: all)
  --browser=chrome|opera|both  Select browser (default: both)
  --feature=F1,F2,...     Filter by feature tag(s)
  --id=T1-F01-01,...      Filter by exact case ID(s)
  --smoke                 Run infrastructure smoke check (Chrome & Opera harness + fixtures + Gemini interceptor)
  --headed                Explicitly allow visible browser windows (default: strict --headless=new)
  --json                  Print JSON summary at the end`);
      process.exit(0);
    }
  }
  return opts;
}

function selectBrowsers(browserArg) {
  if (browserArg === "chrome") return ["chrome"];
  if (browserArg === "opera") return ["opera"];
  if (browserArg === "both") return ["chrome", "opera"];
  throw new Error(`Invalid --browser="${browserArg}". Expected chrome|opera|both.`);
}

function selectTiers(tierArg) {
  const all = [
    { tier: 1, name: "Tier 1 (Feature Coverage)", cases: buildTier1Cases() },
    { tier: 2, name: "Tier 2 (Boundary & Corner Cases)", cases: buildTier2Cases() },
    { tier: 3, name: "Tier 3 (Cross-Feature Pairwise)", cases: buildTier3Cases() },
    { tier: 4, name: "Tier 4 (Real-World Scenarios)", cases: buildTier4Cases() }
  ];
  if (tierArg === "all") return all;
  const num = Number(tierArg);
  if (![1, 2, 3, 4].includes(num)) {
    throw new Error(`Invalid --tier="${tierArg}". Expected 1|2|3|4|all.`);
  }
  return all.filter((t) => t.tier === num);
}

function prepareSmokeExtension() {
  const manifestPath = path.join(PROJECT_ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const declared = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
  const missing = declared.filter((rel) => !fs.existsSync(path.join(PROJECT_ROOT, rel)));
  if (missing.length === 0) {
    return { extensionPath: PROJECT_ROOT, staged: false, missing: [], cleanup: () => {} };
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "text-ai-smoke-ext-"));
  for (const ent of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
    if ([".git", ".agents", "node_modules", "tests", "scripts"].includes(ent.name)) continue;
    fs.cpSync(path.join(PROJECT_ROOT, ent.name), path.join(stageDir, ent.name), { recursive: true });
  }
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stageDir, "manifest.json"), "utf8"));
  if (Array.isArray(stagedManifest.content_scripts)) {
    stagedManifest.content_scripts = stagedManifest.content_scripts.map((cs) => ({
      ...cs,
      js: (cs.js || []).filter((rel) => fs.existsSync(path.join(stageDir, rel)))
    }));
  }
  fs.writeFileSync(
    path.join(stageDir, "manifest.json"),
    JSON.stringify(stagedManifest, null, 2)
  );
  return {
    extensionPath: stageDir,
    staged: true,
    missing,
    cleanup: () => fs.rmSync(stageDir, { recursive: true, force: true })
  };
}

async function runInfraSmoke(browserName, baseUrl, { headed = false } = {}) {
  const smokeExt = prepareSmokeExtension();
  if (smokeExt.staged) {
    console.log(
      `[SMOKE NOTE] Missing unbuilt milestone scripts (${smokeExt.missing.join(", ")}); staging temp unpacked extension at ${smokeExt.extensionPath}`
    );
  }
  const session = await launchExtensionBrowser(browserName, {
    fixtureBaseUrl: baseUrl,
    extensionPath: smokeExt.extensionPath,
    headed
  });
  const profileDir = session.userDataDir;
  try {
    assert.ok(session.extensionId, "Extension ID must be returned by Extensions.loadUnpacked");
    assert.ok(session.serviceWorker, "MV3 service worker must be running");
    await session.resetStorage({ apiKey: "smoke-key-001" });
    const stored = await session.getStorage();
    assert.equal(stored.apiKey, "smoke-key-001");

    // 1. Verify fixture page loads all editor types & iframes over http://127.0.0.1
    const page = await session.openFixturePage("/index.html");
    assert.equal(await page.locator("#text-input").count(), 1);
    assert.equal(await page.locator("#search-input").count(), 1);
    assert.equal(await page.locator("#password-input").count(), 1);
    assert.equal(await page.locator("#main-textarea").count(), 1);
    assert.equal(await page.locator("#ce-editor").count(), 1);

    const sameOriginFrame = page.frames().find((f) => f.url().includes("iframe-inner.html"));
    const srcdocFrame = page.frames().find((f) => f.url().startsWith("about:srcdoc"));
    assert.ok(sameOriginFrame, "same-origin iframe must load");
    assert.ok(srcdocFrame, "srcdoc iframe must load");

    // 2. Verify real typing + zero Gemini calls on typing
    session.clearGeminiLog();
    await typeRealText(page, "#text-input", "hello ");
    await typeRealText(page, "#main-textarea", "world ");
    await typeRealText(page, "#ce-editor", "rich ");
    await typeRealText(sameOriginFrame, "#iframe-textarea", "iframe ");
    await typeRealText(srcdocFrame, "#srcdoc-textarea", "srcdoc ");
    assert.equal(await readEditorText(page, "#text-input"), "hello ");
    assert.equal(await readEditorText(page, "#main-textarea"), "world ");
    assert.equal(await readEditorText(page, "#ce-editor"), "rich ");
    assert.equal(await readEditorText(sameOriginFrame, "#iframe-textarea"), "iframe ");
    assert.equal(await readEditorText(srcdocFrame, "#srcdoc-textarea"), "srcdoc ");
    await assertZeroGeminiCalls(session, `${browserName} smoke typing`);
    await page.close();

    // 3. Verify Options & Popup pages load + Gemini interceptor intercepts outbound calls
    const opt = await session.openOptionsPage();
    assert.ok(/Text AI Tools/i.test(await opt.title()));
    await opt.click("#test-btn");
    const deadline = Date.now() + 2000;
    while (session.getGeminiLog().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const log = session.getGeminiLog();
    assert.ok(log.length >= 1, "Gemini interceptor must record outbound generateContent call");
    assert.equal(log[0].headers["x-goog-api-key"], "smoke-key-001");
    await opt.close();

    const pop = await session.openPopupPage();
    assert.ok(/Text AI Tools/i.test(await pop.title()));
    await pop.close();

    const execMode = headed ? "headed" : "headless=new";
    console.log(
      `[SMOKE PASS] ${browserName.toUpperCase()} (${execMode}) | ext=${session.extensionId} | mode=${smokeExt.staged ? "staged-infra" : "direct"} | fixtures=OK | iframes=2 | geminiIntercepted=${log.length}`
    );
  } finally {
    await session.close();
    smokeExt.cleanup();
  }
  assert.equal(
    fs.existsSync(profileDir),
    false,
    `Temporary profile ${profileDir} must be cleaned up on teardown`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browsers = selectBrowsers(opts.browser);
  const fixtureServer = await startFixtureServer();
  const modeStr = opts.headed ? "HEADED (--headed)" : "STRICT HEADLESS (--headless=new)";
  console.log(`Fixture server listening at ${fixtureServer.baseUrl} | Mode: ${modeStr}`);

  try {
    if (opts.smoke) {
      for (const b of browsers) {
        await runInfraSmoke(b, fixtureServer.baseUrl, { headed: opts.headed });
      }
      console.log("All browser smoke checks passed cleanly.");
      return;
    }

    const tiers = selectTiers(opts.tier);
    const summary = {
      mode: opts.headed ? "headed" : "headless=new",
      browsers: {},
      totalPassed: 0,
      totalFailed: 0
    };

    for (const browserName of browsers) {
      console.log(`\n============================================================`);
      console.log(`Running E2E Suite on ${browserName.toUpperCase()} [${modeStr}]`);
      console.log(`============================================================`);
      const session = await launchExtensionBrowser(browserName, {
        fixtureBaseUrl: fixtureServer.baseUrl,
        headed: opts.headed
      });
      const browserStats = { passed: 0, failed: 0, failures: [] };

      try {
        for (const tierObj of tiers) {
          let cases = tierObj.cases;
          if (opts.feature) {
            cases = cases.filter((c) => {
              const tokens = c.feature.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
              return opts.feature.some((f) => tokens.includes(f));
            });
          }
          if (opts.id) {
            cases = cases.filter((c) => opts.id.includes(c.id));
          }
          if (cases.length === 0) continue;

          console.log(`\n--- ${tierObj.name} (${cases.length} cases) ---`);
          for (const tc of cases) {
            session.setGeminiResponder(null);
            session.clearGeminiLog();
            const t0 = Date.now();
            try {
              await tc.run(session);
              const dt = Date.now() - t0;
              browserStats.passed++;
              summary.totalPassed++;
              console.log(`  [PASS] ${tc.id} (${tc.feature}) ${tc.name} [${dt}ms]`);
            } catch (err) {
              const dt = Date.now() - t0;
              browserStats.failed++;
              summary.totalFailed++;
              const msg = err?.message || String(err);
              browserStats.failures.push({ id: tc.id, feature: tc.feature, name: tc.name, error: msg });
              console.error(`  [FAIL] ${tc.id} (${tc.feature}) ${tc.name} [${dt}ms]\n         -> ${msg}`);
            } finally {
              await session.cleanupPages();
            }
          }
        }
      } finally {
        await session.close();
      }

      summary.browsers[browserName] = browserStats;
      console.log(
        `\n${browserName.toUpperCase()} Summary: ${browserStats.passed} passed, ${browserStats.failed} failed`
      );
    }

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    }

    console.log(
      `\nTOTAL: ${summary.totalPassed} passed, ${summary.totalFailed} failed across [${browsers.join(", ")}]`
    );
    if (summary.totalFailed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await fixtureServer.close();
  }
}

main().catch((err) => {
  console.error("Fatal E2E runner error:", err);
  process.exit(1);
});

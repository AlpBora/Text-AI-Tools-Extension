#!/usr/bin/env node
/**
 * Single-source-of-truth Node.js background worker for macOS system-wide Text AI Tools.
 * Directly loads the exact extension modules from ../content/ and ../shared/ with zero code duplication.
 * Communicates over newline-delimited JSON on stdin/stdout.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Ensure globalThis.__TEXT_AI_TOOLS__ is populated before loading CJS/UMD-lite modules
globalThis.__TEXT_AI_TOOLS__ = globalThis.__TEXT_AI_TOOLS__ || {};

const LanguageRegistry = require(path.join(ROOT_DIR, "content", "language-registry.js"));
const TurkishMorphology = require(path.join(ROOT_DIR, "content", "morphology-tr.js"));
const TurkishDeasciifier = require(path.join(ROOT_DIR, "content", "deasciifier-tr.js"));
const PersonalModel = require(path.join(ROOT_DIR, "content", "personal-model.js"));
const SpellcheckEngine = require(path.join(ROOT_DIR, "content", "spellcheck-engine.js"));

const actionsMod = await import(pathToFileURL(path.join(ROOT_DIR, "shared", "actions.js")).href);
const { ACTIONS, AI_PROVIDERS, askAIQuestion, callAI, detectProviderFromApiKey, resolveProviderConfig } = actionsMod;

const STATE_DIR = path.join(os.homedir(), ".text-ai-tools");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const HABITS_PATH = path.join(STATE_DIR, "habits.json");
const KEYCHAIN_SERVICES = [
  "TextAITools-Gemini-API-Key",
  "GEMINI_API_KEY",
  "gemini-api-key",
  "generativelanguage.googleapis.com",
];

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readApiKeyFromKeychain() {
  if (process.platform !== "darwin") return "";
  const account = os.userInfo().username;
  for (const svc of KEYCHAIN_SERVICES) {
    try {
      const val = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", account, "-s", svc, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (val) return val;
    } catch {
      // Not found under this service name
    }
    try {
      const valAny = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", svc, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (valAny) return valAny;
    } catch {
      // Not found
    }
  }
  return "";
}

function saveApiKeyToKeychain(apiKey) {
  const clean = String(apiKey || "").trim();
  if (!clean || process.platform !== "darwin") return false;
  const account = os.userInfo().username;
  execFileSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICES[0], "-w", clean],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  return true;
}

function loadConfig() {
  const defaults = {
    primaryLanguage: "Turkish",
    secondaryLanguage: "English",
    autoCorrectEnabled: true,
    provider: "gemini",
    customBaseUrl: "",
    model: "gemini-3.5-flash-lite",
    hotkey: {
      keyCode: 47,
      cmd: true,
      requireRightCmd: true,
      opt: false,
      ctrl: false,
      shift: false,
      label: "Right ⌘ + .",
    },
  };
  let parsed = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {
    // ignore corrupt config
  }
  const merged = { ...defaults, ...parsed };
  // Never rely on plaintext config.json for apiKey; prefer Keychain or env var
  const keychainKey = readApiKeyFromKeychain();
  merged.apiKey = keychainKey || process.env.GEMINI_API_KEY || "";
  return merged;
}

function saveConfig(cfg) {
  ensureStateDir();
  const { apiKey: _omit, ...safeCfg } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(safeCfg, null, 2), { mode: 0o600 });
}

function loadHabits() {
  try {
    if (fs.existsSync(HABITS_PATH)) {
      return JSON.parse(fs.readFileSync(HABITS_PATH, "utf8"));
    }
  } catch {
    // ignore corrupt habits
  }
  return {
    corrections: {},
    wordCounts: {},
    ignored: {},
    bigrams: {},
    domainCounts: {},
    charEdits: {},
  };
}

let habitSaveTimer = null;
function scheduleSaveHabits(habits) {
  if (habitSaveTimer) clearTimeout(habitSaveTimer);
  habitSaveTimer = setTimeout(() => {
    habitSaveTimer = null;
    try {
      ensureStateDir();
      const pruned = PersonalModel.pruneHabits(habits);
      fs.writeFileSync(HABITS_PATH, JSON.stringify(pruned), { mode: 0o600 });
    } catch {
      // ignore disk write error
    }
  }, 500);
}

const lexiconsByLang = Object.create(null);
function loadBundledLexicons() {
  for (const lang of ["tr", "en"]) {
    const p = path.join(ROOT_DIR, "shared", "lexicons", `${lang}.json`);
    if (fs.existsSync(p)) {
      lexiconsByLang[lang] = JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
}

loadBundledLexicons();
let config = loadConfig();
const userHabits = loadHabits();

// Pre-warm lexicon indexes at startup so the first typed word responds in <2ms
try {
  SpellcheckEngine.checkWord({
    word: "merhaba",
    primaryLang: config.primaryLanguage,
    secondaryLang: config.secondaryLanguage,
    lexiconsByLang,
    autoCorrectEnabled: false,
  });
} catch {
  // ignore warmup error
}

function trLower(str) {
  return String(str || "")
    .trim()
    .normalize("NFC")
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .normalize("NFC");
}

function recordWordUsage(word, prevWord, appDomain) {
  const k = trLower(word);
  if (!k || k.length < 2) return;
  userHabits.wordCounts[k] = (Number(userHabits.wordCounts[k]) || 0) + 1;
  if (prevWord) PersonalModel.recordBigram(userHabits, prevWord, k, 1);
  if (appDomain) PersonalModel.recordDomainWord(userHabits, appDomain, k, 1);
  scheduleSaveHabits(userHabits);
}

export async function handleRequest(req) {
  if (!req || typeof req !== "object") {
    return { ok: false, error: "Invalid request" };
  }

  if (req.type === "ping") {
    return { ok: true, id: req.id, langs: Object.keys(lexiconsByLang) };
  }

  if (req.type === "getConfig") {
    return {
      ok: true,
      id: req.id,
      config: {
        primaryLanguage: config.primaryLanguage,
        secondaryLanguage: config.secondaryLanguage,
        autoCorrectEnabled: config.autoCorrectEnabled !== false,
        hasApiKey: Boolean(config.apiKey),
        provider: config.provider || "gemini",
        customBaseUrl: config.customBaseUrl || "",
        model: config.model,
        hotkey: config.hotkey,
      },
    };
  }

  if (req.type === "setConfig") {
    let nextKey = config.apiKey;
    let detectedProvider = null;
    if (typeof req.apiKey === "string" && req.apiKey.trim()) {
      nextKey = req.apiKey.trim();
      saveApiKeyToKeychain(nextKey);
      detectedProvider = detectProviderFromApiKey(nextKey);
    }
    const nextProvider =
      typeof req.provider === "string" && AI_PROVIDERS[req.provider]
        ? req.provider
        : detectedProvider || config.provider || "gemini";
    const nextProfile = AI_PROVIDERS[nextProvider] || AI_PROVIDERS.gemini;
    const nextModel =
      typeof req.model === "string" && req.model.trim()
        ? req.model.trim()
        : nextProvider !== config.provider
          ? nextProfile.defaultModel
          : config.model;
    config = {
      ...config,
      provider: nextProvider,
      customBaseUrl: typeof req.customBaseUrl === "string" ? req.customBaseUrl.trim() : config.customBaseUrl || "",
      model: nextModel,
      ...(req.primaryLanguage ? { primaryLanguage: String(req.primaryLanguage) } : {}),
      ...(req.secondaryLanguage ? { secondaryLanguage: String(req.secondaryLanguage) } : {}),
      ...(typeof req.autoCorrectEnabled === "boolean" ? { autoCorrectEnabled: req.autoCorrectEnabled } : {}),
      ...(req.model ? { model: String(req.model).trim() } : {}),
      ...(req.hotkey && typeof req.hotkey === "object" ? { hotkey: req.hotkey } : {}),
      apiKey: nextKey,
    };
    saveConfig(config);
    return { ok: true, id: req.id };
  }

  if (req.type === "checkWord") {
    const word = String(req.word || "");
    const contextTokens = Array.isArray(req.contextTokens) ? req.contextTokens : [];
    const prevWord = contextTokens.length > 0 ? contextTokens[contextTokens.length - 1] : "";
    const appDomain = String(req.appName || "macos").trim().toLowerCase();

    const result = SpellcheckEngine.checkWord({
      word,
      contextTokens,
      primaryLang: req.primaryLang || config.primaryLanguage,
      secondaryLang: req.secondaryLang || config.secondaryLanguage,
      lexiconsByLang,
      autoCorrectEnabled: config.autoCorrectEnabled !== false,
      userHabits,
      context: { domain: appDomain },
    });

    if (result.decision === "valid") {
      recordWordUsage(word, prevWord, appDomain);
    } else if (result.decision === "auto_correct" && result.replacement) {
      recordWordUsage(result.replacement, prevWord, appDomain);
      PersonalModel.learnCharEdits(userHabits, word, result.replacement, 0.5);
      scheduleSaveHabits(userHabits);
    }

    return { ok: true, id: req.id, ...result };
  }

  if (req.type === "recordUndo") {
    const orig = trLower(req.originalWord);
    const corr = trLower(req.correctedWord);
    if (orig) {
      userHabits.ignored[orig] = (Number(userHabits.ignored[orig]) || 0) + 1;
      if (corr && orig !== corr) {
        PersonalModel.learnCharEdits(userHabits, orig, corr, -1);
      }
      scheduleSaveHabits(userHabits);
    }
    return { ok: true, id: req.id };
  }

  if (req.type === "inlineAction") {
    const actionId = req.actionId;
    if (!ACTIONS[actionId]) {
      return { ok: false, id: req.id, error: `Unknown action: ${actionId}` };
    }
    if (!config.apiKey) {
      config.apiKey = readApiKeyFromKeychain() || process.env.GEMINI_API_KEY || "";
    }
    const providerCfg = resolveProviderConfig(config.provider, config.customBaseUrl);
    if (providerCfg.requiresKey && !config.apiKey) {
      return {
        ok: false,
        id: req.id,
        code: "MISSING_API_KEY",
        error: `${providerCfg.label} API key not found in macOS Keychain.`,
      };
    }
    try {
      const output = await callAI({
        provider: config.provider,
        customBaseUrl: config.customBaseUrl,
        apiKey: config.apiKey,
        model: config.model,
        actionId,
        text: String(req.text || ""),
        primaryLanguage: config.primaryLanguage,
        secondaryLanguage: config.secondaryLanguage,
      });
      return { ok: true, id: req.id, result: output, mode: ACTIONS[actionId].mode };
    } catch (err) {
      return { ok: false, id: req.id, error: err?.message || String(err) };
    }
  }

  if (req.type === "askAIQuestion") {
    if (!config.apiKey) {
      config.apiKey = readApiKeyFromKeychain() || process.env.GEMINI_API_KEY || "";
    }
    const providerCfg = resolveProviderConfig(config.provider, config.customBaseUrl);
    if (providerCfg.requiresKey && !config.apiKey) {
      return {
        ok: false,
        id: req.id,
        code: "MISSING_API_KEY",
        error: `${providerCfg.label} API key not found in macOS Keychain.`,
      };
    }
    try {
      const output = await askAIQuestion({
        question: String(req.question || ""),
        text: String(req.text || ""),
        primaryLanguage: config.primaryLanguage,
        secondaryLanguage: config.secondaryLanguage,
        provider: config.provider,
        customBaseUrl: config.customBaseUrl,
        apiKey: config.apiKey,
        model: config.model,
      });
      return { ok: true, id: req.id, result: output };
    } catch (err) {
      return { ok: false, id: req.id, error: err?.message || String(err) };
    }
  }

  return { ok: false, id: req.id, error: `Unknown type: ${req.type}` };
}

// Run stdio loop when invoked as main script
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: "Invalid JSON" }) + "\n");
      return;
    }
    const res = await handleRequest(req);
    process.stdout.write(JSON.stringify(res) + "\n");
  });
}

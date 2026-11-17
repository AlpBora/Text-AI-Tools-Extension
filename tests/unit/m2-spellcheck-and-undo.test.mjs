import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const enLexicon = require(path.join(ROOT_DIR, "shared/lexicons/en.json"));
const trLexicon = require(path.join(ROOT_DIR, "shared/lexicons/tr.json"));

// Load M1 + M2 modules via Node require
const LanguageRegistry = require(path.join(ROOT_DIR, "content/language-registry.js"));
const TurkishMorphology = require(path.join(ROOT_DIR, "content/morphology-tr.js"));
const TurkishDeasciifier = require(path.join(ROOT_DIR, "content/deasciifier-tr.js"));
const SpellcheckEngine = require(path.join(ROOT_DIR, "content/spellcheck-engine.js"));
const PersonalModel = require(path.join(ROOT_DIR, "content/personal-model.js"));
const UndoManager = require(path.join(ROOT_DIR, "content/undo-manager.js"));

const LEXICONS = { tr: trLexicon, en: enLexicon };

describe("M2: Global UMD-lite Namespace & Browser VM Isolation", () => {
  it("attaches SpellcheckEngine and UndoManager to globalThis.__TEXT_AI_TOOLS__", () => {
    assert.ok(globalThis.__TEXT_AI_TOOLS__);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.LanguageRegistry, LanguageRegistry);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.TurkishMorphology, TurkishMorphology);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.TurkishDeasciifier, TurkishDeasciifier);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.SpellcheckEngine, SpellcheckEngine);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.UndoManager, UndoManager);
  });

  it("works in an isolated browser-like VM IIFE context without module or require", () => {
    const sandbox = { globalThis: null, self: null };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);

    const files = [
      "content/language-registry.js",
      "content/morphology-tr.js",
      "content/deasciifier-tr.js",
      "content/spellcheck-engine.js",
      "content/undo-manager.js",
    ];
    for (const rel of files) {
      const code = fs.readFileSync(path.join(ROOT_DIR, rel), "utf8");
      vm.runInContext(code, sandbox, { filename: rel });
    }

    const ns = sandbox.__TEXT_AI_TOOLS__;
    assert.ok(ns.SpellcheckEngine);
    assert.ok(ns.UndoManager);
    assert.equal(ns.SpellcheckEngine.isSkippedToken("https://example.com"), true);
    assert.equal(ns.SpellcheckEngine.isSkippedToken("recieve"), false);

    const check = ns.SpellcheckEngine.checkWord({
      word: "ozetle",
      contextTokens: ["Bugün"],
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(check.decision, "auto_correct");
    assert.equal(check.replacement, "özetle");

    const target = { id: "vm-box" };
    const id = ns.UndoManager.recordAutoCorrect({
      targetRef: target,
      start: 0,
      end: 6,
      originalWord: "ozetle",
      correctedWord: "özetle",
      timestamp: 1000,
    });
    assert.equal(ns.UndoManager.getLatest(target).originalWord, "ozetle");
    assert.equal(ns.UndoManager.consume(id).correctedWord, "özetle");
    assert.equal(ns.UndoManager.getLatest(target), null);
  });
});

describe("M2 / F1: Non-Prose Skip Guards", () => {
  it("skips empty, 1-char, URLs, emails, digits/alphanumeric, mentions, hashtags, ALL_CAPS, and code identifiers", () => {
    const skipped = [
      "",
      "   ",
      "a",
      "I",
      "http://example.com",
      "https://sub.domain.org/path?x=1",
      "www.google.com",
      "foo.com/bar",
      "example.org",
      "user@example.com",
      "alp.bora+dev@gmail.com",
      "2026",
      "v2",
      "mp3",
      "100ms",
      "utf8",
      "@alpbora",
      "#javascript",
      "API",
      "HTML",
      "NASA",
      "TBMM",
      "USA",
      "snake_case",
      "my_var_name",
      "camelCase",
      "getElementById",
      "kebab-case",
      "data-testid",
    ];
    for (const tok of skipped) {
      assert.equal(SpellcheckEngine.isSkippedToken(tok), true, `Expected skip for "${tok}"`);
      const res = SpellcheckEngine.checkWord({
        word: tok,
        primaryLang: "tr",
        secondaryLang: "en",
        lexiconsByLang: LEXICONS,
      });
      assert.equal(res.decision, "skip", `Expected checkWord decision="skip" for "${tok}"`);
      assert.equal(res.valid, true);
    }
  });

  it("skips via context flags (password/email/url inputs and insideCode)", () => {
    assert.equal(SpellcheckEngine.isSkippedToken("recieve", { inputType: "password" }), true);
    assert.equal(SpellcheckEngine.isSkippedToken("recieve", { inputType: "email" }), true);
    assert.equal(SpellcheckEngine.isSkippedToken("recieve", { inputType: "url" }), true);
    assert.equal(SpellcheckEngine.isSkippedToken("recieve", { insideCode: true }), true);
  });

  it("does NOT skip regular prose words or apostrophe words", () => {
    for (const tok of ["teh", "Teh", "don't", "Ankara'ya", "ozetle", "saykoloci", "kitapda"]) {
      assert.equal(SpellcheckEngine.isSkippedToken(tok), false, `Did not expect skip for "${tok}"`);
    }
  });
});

describe("M2 / F3: English Typos & Casing Preservation", () => {
  it("auto-corrects common English typos and preserves capitalization", () => {
    const cases = [
      { word: "teh", expected: "the" },
      { word: "Teh", expected: "The" },
      { word: "recieve", expected: "receive" },
      { word: "mesage", expected: "message" },
      { word: "seperate", expected: "separate" },
    ];
    for (const { word, expected } of cases) {
      const res = SpellcheckEngine.checkWord({
        word,
        contextTokens: ["Please", "check"],
        primaryLang: "English",
        secondaryLang: "Turkish",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.valid, false);
      assert.equal(res.decision, "auto_correct", `Expected auto_correct for "${word}", got ${res.decision}`);
      assert.equal(res.replacement, expected);
      assert.equal(res.candidates[0].word, expected);
      assert.equal(res.detectedLang, "en");
    }
  });

  it("handles apostrophes cleanly for English contractions and possessives", () => {
    for (const validWord of ["don't", "book's"]) {
      const res = SpellcheckEngine.checkWord({
        word: validWord,
        primaryLang: "en",
        secondaryLang: "tr",
        lexiconsByLang: LEXICONS,
      });
      assert.equal(res.valid, true, `Expected "${validWord}" to be valid`);
      assert.equal(res.decision, "valid");
    }
  });
});

describe("M2 / F3 & F4: Bilingual Phonetic / Approximate Matching & Uncertainty Guard", () => {
  it("surfaces intended English words for phonetic attempts without blind auto-replacement", () => {
    const phoneticCases = [
      { word: "saykoloci", target: "psychology", primaryLang: "English", secondaryLang: "Turkish", ctx: ["I", "study"] },
      { word: "nesesery", target: "necessary", primaryLang: "Turkish", secondaryLang: "English", ctx: ["It", "is"] },
      { word: "skedul", target: "schedule", primaryLang: "Turkish", secondaryLang: "English", ctx: ["The", "new"] },
      { word: "burokrasi", target: "bureaucracy", primaryLang: "English", secondaryLang: "Turkish", ctx: ["Too", "much", "burokrasi", "here"] },
      { word: "envayrınmınt", target: "environment", primaryLang: "Turkish", secondaryLang: "English", ctx: [] },
      { word: "ekspiriens", target: "experience", primaryLang: "Turkish", secondaryLang: "English", ctx: [] },
    ];

    for (const { word, target, primaryLang, secondaryLang, ctx } of phoneticCases) {
      const res = SpellcheckEngine.checkWord({
        word,
        contextTokens: ctx,
        primaryLang,
        secondaryLang,
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.valid, false);
      assert.equal(
        res.decision,
        "uncertain",
        `Expected phonetic guess "${word}" to be uncertain, got ${res.decision} (${res.replacement})`
      );
      assert.equal(res.replacement, undefined);
      assert.ok(res.candidates.length >= 1 && res.candidates.length <= 5);
      assert.equal(
        res.candidates[0].word,
        target,
        `Expected "${target}" as #1 for "${word}", got ${res.candidates.map((c) => c.word).join(", ")}`
      );
    }
  });

  it("handles 'definately' -> 'definitely' cleanly as top candidate", () => {
    const res = SpellcheckEngine.checkWord({
      word: "definately",
      contextTokens: ["I", "will"],
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(res.valid, false);
    assert.equal(res.candidates[0].word, "definitely");
    assert.equal(res.decision, "auto_correct");
    assert.equal(res.replacement, "definitely");
  });

  it("never auto-corrects when autoCorrectEnabled is false", () => {
    for (const word of ["teh", "ozetle", "kitapda", "definately"]) {
      const res = SpellcheckEngine.checkWord({
        word,
        primaryLang: "tr",
        secondaryLang: "en",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: false,
      });
      assert.equal(res.decision, "uncertain");
      assert.equal(res.replacement, undefined);
      assert.ok(res.candidates.length >= 1);
    }
  });
});

describe("M2: Turkish Morphology, Deasciifier, Homographs & Ambiguity Integration", () => {
  it("accepts complex valid Turkish inflections and apostrophe proper nouns", () => {
    for (const validWord of ["evlerimizdekilerden", "anlayamadıklarımızdan", "Ankara'ya"]) {
      const res = SpellcheckEngine.checkWord({
        word: validWord,
        primaryLang: "Turkish",
        secondaryLang: "English",
        lexiconsByLang: LEXICONS,
      });
      assert.equal(res.valid, true, `Expected "${validWord}" valid`);
      assert.equal(res.decision, "valid");
      assert.equal(res.detectedLang, "tr");
    }
  });

  it("auto-corrects Turkish inflected morphology typos and ASCII deasciification with casing preservation", () => {
    const trFixes = [
      { word: "kitapda", expected: "kitapta" },
      { word: "saatda", expected: "saatte" },
      { word: "ozetle", expected: "özetle" },
      { word: "Ozetle", expected: "Özetle" },
      { word: "tesekkurler", expected: "teşekkürler" },
      { word: "ozetliyorum", expected: "özetliyorum" },
      { word: "gorusecegiz", expected: "görüşeceğiz" },
      { word: "Turkiye'de", expected: "Türkiye'de" },
    ];
    for (const { word, expected } of trFixes) {
      const res = SpellcheckEngine.checkWord({
        word,
        contextTokens: ["Bugün"],
        primaryLang: "Turkish",
        secondaryLang: "English",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.decision, "auto_correct", `Expected auto_correct for "${word}", got ${res.decision}`);
      assert.equal(res.replacement, expected);
      assert.equal(res.detectedLang, "tr");
    }
  });

  it("leaves Turkish ASCII homographs untouched", () => {
    for (const homograph of ["oldu", "kar", "yasa", "on", "sac", "bul"]) {
      const res = SpellcheckEngine.checkWord({
        word: homograph,
        primaryLang: "tr",
        secondaryLang: "en",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.valid, true, `Expected homograph "${homograph}" valid`);
      assert.equal(res.decision, "valid");
      assert.equal(res.replacement, undefined);
    }
  });

  it("marks ambiguous Turkish ASCII inputs (uc, soyle) as uncertain with expected candidates", () => {
    const ucRes = SpellcheckEngine.checkWord({
      word: "uc",
      contextTokens: ["Bir"],
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(ucRes.decision, "uncertain");
    assert.equal(ucRes.replacement, undefined);
    const ucWords = ucRes.candidates.map((c) => c.word);
    assert.ok(ucWords.includes("uç"), `Expected 'uç' in ${ucWords}`);
    assert.ok(ucWords.includes("üç"), `Expected 'üç' in ${ucWords}`);

    const soyleRes = SpellcheckEngine.checkWord({
      word: "soyle",
      contextTokens: ["Bana"],
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(soyleRes.decision, "uncertain");
    const soyleWords = soyleRes.candidates.map((c) => c.word);
    assert.ok(soyleWords.includes("söyle"));
    assert.ok(soyleWords.includes("şöyle"));
  });

  it("auto-corrects agaclık -> ağaçlık, sarkı -> şarkı, caglayan -> çağlayan, and gore -> göre without false uncertainty", () => {
    const cases = [
      ["agaclık", "ağaçlık"],
      ["agaclik", "ağaçlık"],
      ["sarkı", "şarkı"],
      ["sarki", "şarkı"],
      ["caglayan", "çağlayan"],
      ["gore", "göre"],
      ["boyle", "böyle"],
      ["degil", "değil"],
      ["simdi", "şimdi"],
      ["kisi", "kişi"],
    ];
    for (const [input, expected] of cases) {
      const res = SpellcheckEngine.checkWord({
        word: input,
        primaryLang: "tr",
        secondaryLang: "en",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.decision, "auto_correct", `Expected auto_correct for "${input}", got ${res.decision}`);
      assert.equal(res.replacement, expected);
    }
  });

  it("normalizes colloquial Turkish shorthands (bikac, uyuyom, yatiyom, bekliyo, bisi) and adapts to userHabits", () => {
    const colloquialCases = [
      ["bikac", "birkaç"],
      ["uyuyom", "uyuyorum"],
      ["yatiyom", "yatıyorum"],
      ["geliyom", "geliyorum"],
      ["bekliyo", "bekliyor"],
      ["cikiyo", "çıkıyor"],
      ["kullanamiyom", "kullanamıyorum"],
      ["bisi", "bir şey"],
      ["heralde", "herhalde"],
      ["galba", "galiba"],
    ];
    for (const [input, expected] of colloquialCases) {
      const res = SpellcheckEngine.checkWord({
        word: input,
        primaryLang: "tr",
        secondaryLang: "en",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(res.decision, "auto_correct", `Expected auto_correct for colloquial "${input}", got ${res.decision}`);
      assert.equal(res.replacement, expected);
    }

    // Ambiguous 'soyle' becomes auto_correct when userHabits has personal usage of 'şöyle' or learned correction
    const habitWordCountRes = SpellcheckEngine.checkWord({
      word: "soyle",
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
      userHabits: { wordCounts: { şöyle: 5 } },
    });
    assert.equal(habitWordCountRes.decision, "auto_correct");
    assert.equal(habitWordCountRes.replacement, "şöyle");

    const habitCorrectionRes = SpellcheckEngine.checkWord({
      word: "uc",
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
      userHabits: { corrections: { uc: { üç: 1 } } },
    });
    assert.equal(habitCorrectionRes.decision, "auto_correct");
    assert.equal(habitCorrectionRes.replacement, "üç");

    // Ignored word (undone >= 2 times) is left untouched as valid
    const ignoredRes = SpellcheckEngine.checkWord({
      word: "uyuyom",
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
      userHabits: { ignored: { uyuyom: 2 } },
    });
    assert.equal(ignoredRes.decision, "valid");
  });

  it("PersonalModel generalizes charEdits to unseen words and uses bigram + domain context", () => {
    const habits = {};
    // User repeatedly omits 'r' in one word -> learns del:r pattern
    PersonalModel.learnCharEdits(habits, "bikas", "birkaş", 3);
    PersonalModel.learnCharEdits(habits, "fakat", "farkat", 3);
    assert.ok(habits.charEdits["del:r"] >= 3, "Expected del:r edit pattern to be learned");

    // Generalizes to an unseen word where 'r' was omitted ("yain" -> "yarın")
    const bonusYarin = PersonalModel.scoreCharHabit("yain", "yarın", habits);
    const bonusYakin = PersonalModel.scoreCharHabit("yain", "yakın", habits);
    assert.ok(bonusYarin > bonusYakin, "Learned del:r should generalize to unseen word 'yain' -> 'yarın'");

    // Bigram + domain disambiguation on ambiguous "soyle"
    PersonalModel.recordBigram(habits, "yarın", "şöyle", 4);
    PersonalModel.recordDomainWord(habits, "mail.google.com", "şöyle", 4);

    const ctxRes = SpellcheckEngine.checkWord({
      word: "soyle",
      contextTokens: ["yarın"],
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
      userHabits: habits,
      context: { domain: "mail.google.com" },
    });
    assert.equal(ctxRes.decision, "auto_correct");
    assert.equal(ctxRes.replacement, "şöyle");
  });
});

describe("M2: Bilingual Code-Switching & Custom Unbundled Languages", () => {
  it("allows valid secondary-language words inside primary-language prose without false-flagging", () => {
    const enInTr = SpellcheckEngine.checkWord({
      word: "meeting",
      contextTokens: ["Bugün", "uzun", "bir"],
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
    });
    assert.equal(enInTr.valid, true);
    assert.equal(enInTr.decision, "valid");
    assert.equal(enInTr.detectedLang, "en");

    const trInEn = SpellcheckEngine.checkWord({
      word: "teşekkürler",
      contextTokens: ["Thank", "you"],
      primaryLang: "English",
      secondaryLang: "Turkish",
      lexiconsByLang: LEXICONS,
    });
    assert.equal(trInEn.valid, true);
    assert.equal(trInEn.decision, "valid");
    assert.equal(trInEn.detectedLang, "tr");
  });

  it("handles custom or unbundled languages gracefully without crashing or false-flagging", () => {
    const deAlone = SpellcheckEngine.checkWord({
      word: "Straße",
      contextTokens: ["Das", "ist", "eine", "große"],
      primaryLang: "German",
      secondaryLang: "",
      lexiconsByLang: {},
    });
    assert.equal(deAlone.valid, true);
    assert.equal(deAlone.decision, "valid");
    assert.equal(deAlone.detectedLang, "de");

    const customAlone = SpellcheckEngine.checkWord({
      word: "Saluton",
      primaryLang: "Esperanto",
      secondaryLang: "",
      lexiconsByLang: {},
    });
    assert.equal(customAlone.valid, true);
    assert.equal(customAlone.decision, "valid");
    assert.equal(customAlone.detectedLang, "esperanto");

    // German primary + English secondary with only EN lexicon loaded
    const deWithEnSec = SpellcheckEngine.checkWord({
      word: "Straße",
      contextTokens: ["Das", "ist", "eine", "große"],
      primaryLang: "German",
      secondaryLang: "English",
      lexiconsByLang: { en: enLexicon },
    });
    assert.equal(deWithEnSec.valid, true);
    assert.equal(deWithEnSec.decision, "valid");
  });
});

describe("M2 / F4: UndoManager 1-Step Lifecycle & Multi-Target Isolation", () => {
  it("records, retrieves, consumes once, and isolates entries across targets", () => {
    UndoManager.clear();
    const targetA = { name: "textarea-a" };
    const targetB = { name: "input-b" };

    const idA1 = UndoManager.recordAutoCorrect({
      targetRef: targetA,
      start: 0,
      end: 3,
      originalWord: "teh",
      correctedWord: "the",
      timestamp: 100,
    });
    const idB1 = UndoManager.recordAutoCorrect({
      targetRef: targetB,
      start: 5,
      end: 11,
      originalWord: "ozetle",
      correctedWord: "özetle",
      timestamp: 200,
    });
    const idA2 = UndoManager.recordAutoCorrect({
      targetRef: targetA,
      start: 4,
      end: 11,
      originalWord: "recieve",
      correctedWord: "receive",
      timestamp: 300,
    });

    assert.ok(typeof idA1 === "string" && idA1.length > 0);
    assert.notEqual(idA1, idA2);

    // Global latest is A2
    assert.equal(UndoManager.getLatest().undoId, idA2);
    // Per-target latest
    assert.equal(UndoManager.getLatest(targetA).undoId, idA2);
    assert.equal(UndoManager.getLatest(targetB).undoId, idB1);

    // 1-step consume on A2
    const consumed = UndoManager.consume(idA2);
    assert.equal(consumed.originalWord, "recieve");
    assert.equal(consumed.correctedWord, "receive");
    assert.equal(consumed.start, 4);
    assert.equal(consumed.end, 11);
    // Cannot consume twice
    assert.equal(UndoManager.consume(idA2), null);

    // Target A falls back to A1; target B untouched
    assert.equal(UndoManager.getLatest(targetA).undoId, idA1);
    assert.equal(UndoManager.getLatest(targetB).undoId, idB1);

    // Clear only targetA
    UndoManager.clear(targetA);
    assert.equal(UndoManager.getLatest(targetA), null);
    assert.equal(UndoManager.getLatest(targetB).undoId, idB1);

    // Global clear
    UndoManager.clear();
    assert.equal(UndoManager.getLatest(), null);
    assert.equal(UndoManager.getLatest(targetB), null);
  });

  it("bounds history capacity cleanly", () => {
    const mgr = UndoManager.create({ maxHistory: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        mgr.recordAutoCorrect({
          targetRef: "t",
          start: i,
          end: i + 1,
          originalWord: `w${i}`,
          correctedWord: `c${i}`,
          timestamp: i,
        })
      );
    }
    assert.equal(mgr.size(), 3);
    assert.equal(mgr.consume(ids[0]), null);
    assert.equal(mgr.consume(ids[1]), null);
    assert.equal(mgr.getLatest().undoId, ids[4]);
  });
});

describe("M2: Warm-Index Performance Benchmark", () => {
  it("averages <5ms per checkWord call once lexicon indexes are built", () => {
    // Warm up WeakMap indexes
    SpellcheckEngine.checkWord({
      word: "warmup",
      primaryLang: "tr",
      secondaryLang: "en",
      lexiconsByLang: LEXICONS,
    });

    const sampleWords = [
      "the", "teh", "hello", "recieve", "mesage", "seperate",
      "saykoloci", "nesesery", "skedul", "envayrınmınt", "ekspiriens", "definately",
      "kitapda", "saatda", "ozetle", "tesekkurler", "ozetliyorum", "gorusecegiz",
      "oldu", "kar", "evlerimizdekilerden", "anlayamadıklarımızdan",
      "world", "computer", "program", "language", "turkish", "english", "correct", "mistake",
    ];

    const rounds = 4;
    const totalCalls = sampleWords.length * rounds;
    const t0 = performance.now();
    for (let r = 0; r < rounds; r++) {
      for (const w of sampleWords) {
        SpellcheckEngine.checkWord({
          word: w,
          primaryLang: "tr",
          secondaryLang: "en",
          lexiconsByLang: LEXICONS,
        });
      }
    }
    const elapsedMs = performance.now() - t0;
    const avgMs = elapsedMs / totalCalls;
    assert.ok(avgMs < 5.0, `Expected <5ms/word average, got ${avgMs.toFixed(2)}ms/word`);
  });
});

describe("M5 Regression: Bilingual Context, Non-Latin Script Guard & Transposition Margin", () => {
  it("I-1: allows valid secondary-language typo auto-correction after strong primary Turkish context", () => {
    const cases = [
      { word: "recieve", ctx: ["özetle"], expected: "receive" },
      { word: "teh", ctx: ["özetle"], expected: "the" },
      { word: "mesage", ctx: ["özetle"], expected: "message" },
      { word: "teh", ctx: ["özetle", "npm", "build", "tamamlandı"], expected: "the" },
    ];
    for (const { word, ctx, expected } of cases) {
      const res = SpellcheckEngine.checkWord({
        word,
        contextTokens: ctx,
        primaryLang: "Turkish",
        secondaryLang: "English",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(
        res.decision,
        "auto_correct",
        `Expected auto_correct for "${word}" after [${ctx.join(", ")}], got ${res.decision}`
      );
      assert.equal(res.replacement, expected);
      assert.equal(res.detectedLang, "en");
    }

    // Cross-lingual ambiguous 'burokrasi' in strong English context still surfaces 'bureaucracy' #1 as uncertain
    const ambig = SpellcheckEngine.checkWord({
      word: "burokrasi",
      contextTokens: ["Too", "much", "burokrasi", "here"],
      primaryLang: "English",
      secondaryLang: "Turkish",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(ambig.decision, "uncertain");
    assert.equal(ambig.candidates[0].word, "bureaucracy");
  });

  it("I-2: does not skip Latin-script typos as valid unbundled non-Latin words after Cyrillic/Arabic tokens", () => {
    const enTrRes = SpellcheckEngine.checkWord({
      word: "teh",
      contextTokens: ["привет", "مرحبا"],
      primaryLang: "English",
      secondaryLang: "Turkish",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(enTrRes.decision, "auto_correct");
    assert.equal(enTrRes.replacement, "the");
    assert.equal(enTrRes.detectedLang, "en");

    // Even when Russian is configured as an unbundled active primary language, Latin 'teh' is checked in English
    const ruEnRes = SpellcheckEngine.checkWord({
      word: "teh",
      contextTokens: ["привет"],
      primaryLang: "Russian",
      secondaryLang: "English",
      lexiconsByLang: { en: enLexicon },
      autoCorrectEnabled: true,
    });
    assert.equal(ruEnRes.decision, "auto_correct");
    assert.equal(ruEnRes.replacement, "the");
    assert.equal(ruEnRes.detectedLang, "en");

    // Cyrillic word in Russian+English config still remains valid Russian
    const ruValid = SpellcheckEngine.checkWord({
      word: "мир",
      contextTokens: ["привет"],
      primaryLang: "Russian",
      secondaryLang: "English",
      lexiconsByLang: { en: enLexicon },
      autoCorrectEnabled: true,
    });
    assert.equal(ruValid.valid, true);
    assert.equal(ruValid.decision, "valid");
    assert.equal(ruValid.detectedLang, "ru");
  });

  it("I-3: auto-corrects high-frequency 3-letter transposition 'nad' -> 'and' while keeping ambiguous cases uncertain", () => {
    const res = SpellcheckEngine.checkWord({
      word: "nad",
      contextTokens: ["bread"],
      primaryLang: "English",
      secondaryLang: "Turkish",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(res.decision, "auto_correct");
    assert.equal(res.replacement, "and");
    assert.equal(res.detectedLang, "en");
  });

  it("guards against unattested vowel-rewritten morph_repair auto-corrections while preserving genuine TR morph repairs", () => {
    const yapicam = SpellcheckEngine.checkWord({
      word: "yapıcam",
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.notEqual(yapicam.replacement, "yapıcım");
    assert.notEqual(yapicam.decision, "auto_correct");

    const kom = SpellcheckEngine.checkWord({
      word: "komunikeysin",
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.notEqual(kom.replacement, "komünikeysen");
    assert.notEqual(kom.decision, "auto_correct");

    const herkez = SpellcheckEngine.checkWord({
      word: "herkez",
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
      autoCorrectEnabled: true,
    });
    assert.equal(herkez.candidates[0].word, "herkes");
    assert.equal(herkez.candidates.some((c) => c.word === "herkiz"), false);

    for (const [typo, expected] of [
      ["kitapda", "kitapta"],
      ["saatda", "saatte"],
      ["ozetliyorum", "özetliyorum"],
      ["gorusecegiz", "görüşeceğiz"],
      ["köprülar", "köprüler"],
      ["otobüsda", "otobüste"],
    ]) {
      const ok = SpellcheckEngine.checkWord({
        word: typo,
        primaryLang: "Turkish",
        secondaryLang: "English",
        lexiconsByLang: LEXICONS,
        autoCorrectEnabled: true,
      });
      assert.equal(ok.decision, "auto_correct", `Expected auto_correct for ${typo}`);
      assert.equal(ok.replacement, expected);
    }
  });

  it("normalizes NFD-decomposed Turkish I\\u0307 before I->ı replacement", () => {
    assert.equal(LanguageRegistry.trLower("I\u0307stanbul"), "istanbul");
    assert.equal(TurkishMorphology.isValidWord("I\u0307stanbul'da", trLexicon), true);
    const res = SpellcheckEngine.checkWord({
      word: "I\u0307stanbul'da",
      primaryLang: "Turkish",
      secondaryLang: "English",
      lexiconsByLang: LEXICONS,
    });
    assert.equal(res.valid, true);
    assert.equal(res.decision, "valid");
  });
});


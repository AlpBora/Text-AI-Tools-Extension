import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const enLexicon = require(path.join(ROOT_DIR, "shared/lexicons/en.json"));
const trLexicon = require(path.join(ROOT_DIR, "shared/lexicons/tr.json"));

const LanguageRegistry = require(path.join(ROOT_DIR, "content/language-registry.js"));
const TurkishMorphology = require(path.join(ROOT_DIR, "content/morphology-tr.js"));
const TurkishDeasciifier = require(path.join(ROOT_DIR, "content/deasciifier-tr.js"));

describe("M1: Global UMD-lite Namespace Registration", () => {
  it("attaches modules to globalThis.__TEXT_AI_TOOLS__", () => {
    assert.ok(globalThis.__TEXT_AI_TOOLS__);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.LanguageRegistry, LanguageRegistry);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.TurkishMorphology, TurkishMorphology);
    assert.equal(globalThis.__TEXT_AI_TOOLS__.TurkishDeasciifier, TurkishDeasciifier);
  });
});

describe("M1 / F2: Compiled Lexicons Sanity & Licenses", () => {
  it("compiles a frequency-ranked English lexicon of 25k-45k valid entries without subtitle typos", () => {
    const enPath = path.join(ROOT_DIR, "shared/lexicons/en.json");
    const sizeBytes = fs.statSync(enPath).size;
    assert.ok(sizeBytes > 200_000 && sizeBytes < 3_000_000, `en.json size ${sizeBytes} out of bounds`);

    const keys = Object.keys(enLexicon.words);
    assert.ok(keys.length >= 25_000 && keys.length <= 45_000, `Unexpected EN count: ${keys.length}`);

    // Frequency ordering sanity
    assert.ok(enLexicon.words["the"] > enLexicon.words["necessary"]);
    assert.ok(enLexicon.words["necessary"] > enLexicon.words["bureaucracy"]);
    assert.ok(enLexicon.words["psychology"] > 0);
    assert.ok(enLexicon.words["schedule"] > 0);
    assert.ok(enLexicon.words["environment"] > 0);
    assert.ok(enLexicon.words["don't"] > 0);

    // Reject common subtitle/raw-web2 typos & archaic junk
    for (const bad of ["teh", "recieve", "untill", "occured", "wich", "seperate", "aal", "aam"]) {
      assert.equal(enLexicon.words[bad], undefined, `Unexpected bad EN entry: ${bad}`);
    }
  });

  it("compiles a Turkish root + surface lexicon with POS/irregularity flags", () => {
    const trPath = path.join(ROOT_DIR, "shared/lexicons/tr.json");
    const sizeBytes = fs.statSync(trPath).size;
    assert.ok(sizeBytes > 300_000 && sizeBytes < 3_000_000, `tr.json size ${sizeBytes} out of bounds`);

    const rootCount = Object.keys(trLexicon.roots).length;
    const wordCount = Object.keys(trLexicon.words).length;
    assert.ok(rootCount >= 20_000 && rootCount <= 40_000, `Unexpected TR rootCount: ${rootCount}`);
    assert.ok(wordCount >= 20_000 && wordCount <= 40_000, `Unexpected TR wordCount: ${wordCount}`);

    // Check irregularity flags preserved from Zemberek
    assert.match(trLexicon.roots["saat"], /ih/);
    assert.match(trLexicon.roots["saat"], /nv/);
    assert.match(trLexicon.roots["burun"], /vd/);
    assert.match(trLexicon.roots["hak"], /db/);
    assert.match(trLexicon.roots["git"], /V\|v/);

    // Check high-frequency surface words
    assert.ok(trLexicon.words["bir"] > trLexicon.words["teşekkürler"]);
    assert.ok(trLexicon.words["teşekkürler"] > 0);
    assert.equal(trLexicon.words["restorant"], undefined);
    assert.equal(trLexicon.words["chai"], undefined);
  });

  it("records permissive open-source licenses in shared/lexicons/LICENSES.md", () => {
    const lic = fs.readFileSync(path.join(ROOT_DIR, "shared/lexicons/LICENSES.md"), "utf8");
    assert.match(lic, /MIT/i);
    assert.match(lic, /Apache License 2\.0/i);
    assert.match(lic, /FrequencyWords/i);
    assert.match(lic, /zemberek-nlp/i);
  });
});

describe("M1 / F5: Extensible LanguageRegistry & Context Language Detection", () => {
  it("normalizes all 13 options.html languages and aliases", () => {
    const cases = [
      ["Turkish", "tr"],
      ["Türkçe", "tr"],
      ["tr", "tr"],
      ["tr-TR", "tr"],
      ["English", "en"],
      ["en-US", "en"],
      ["German", "de"],
      ["Deutsch", "de"],
      ["Almanca", "de"],
      ["French", "fr"],
      ["Français", "fr"],
      ["Spanish", "es"],
      ["Español", "es"],
      ["Italian", "it"],
      ["Italiano", "it"],
      ["Portuguese", "pt"],
      ["Português", "pt"],
      ["Dutch", "nl"],
      ["Nederlands", "nl"],
      ["Russian", "ru"],
      ["Русский", "ru"],
      ["Arabic", "ar"],
      ["العربية", "ar"],
      ["Japanese", "ja"],
      ["日本語", "ja"],
      ["Korean", "ko"],
      ["한국어", "ko"],
      ["Chinese", "zh"],
      ["中文", "zh"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(LanguageRegistry.normalizeLang(input), expected, `Failed for ${input}`);
    }
  });

  it("supports arbitrary custom languages via deterministic fallback profile without hardcoding", () => {
    const slug = LanguageRegistry.normalizeLang("Esperanto");
    assert.equal(slug, "esperanto");
    const prof = LanguageRegistry.getProfile("Esperanto");
    assert.equal(prof.id, "esperanto");
    assert.equal(prof.displayName, "Esperanto");
    assert.equal(prof.script, "latin");
    assert.equal(prof.hasBundledLexicon, false);
    assert.equal(prof.fold("Ĉu"), "cu");
    assert.ok(prof.stopwords instanceof Set);
  });

  it("handles Turkish-specific İ/I case folding properly", () => {
    const trProf = LanguageRegistry.getProfile("tr");
    assert.equal(trProf.hasBundledLexicon, true);
    assert.equal(trProf.fold("İSTANBUL"), "istanbul");
    assert.equal(trProf.fold("IĞDIR"), "igdir");
    assert.equal(trProf.fold("ÇĞİÖŞÜ"), "cgiosu");
  });

  it("guesses context language accurately across configured primary/secondary pairs", () => {
    const lexicons = { tr: trLexicon, en: enLexicon };

    const trGuess = LanguageRegistry.detectContextLanguage(
      ["Bugün", "toplantıda", "çok", "güzel", "konular", "konuştuk"],
      "Turkish",
      "English",
      lexicons
    );
    assert.equal(trGuess.primary, "tr");
    assert.deepEqual(trGuess.orderedLangs.slice(0, 2), ["tr", "en"]);

    const enGuess = LanguageRegistry.detectContextLanguage(
      ["The", "project", "schedule", "is", "ready", "for", "review"],
      "Turkish",
      "English",
      lexicons
    );
    assert.equal(enGuess.primary, "en");
    assert.deepEqual(enGuess.orderedLangs.slice(0, 2), ["en", "tr"]);

    // Non-TR/EN language guessing (German vs French)
    const deGuess = LanguageRegistry.detectContextLanguage(
      ["Das", "ist", "eine", "sehr", "große", "Straße"],
      "French",
      "German",
      {}
    );
    assert.equal(deGuess.primary, "de");

    const frGuess = LanguageRegistry.detectContextLanguage(
      ["Bonjour", "les", "amis", "merci", "pour", "votre", "aide"],
      "German",
      "French",
      {}
    );
    assert.equal(frGuess.primary, "fr");

    // Empty tokens preserve primary > secondary priority
    const emptyGuess = LanguageRegistry.detectContextLanguage([], "Spanish", "Italian", {});
    assert.equal(emptyGuess.primary, "es");
    assert.deepEqual(emptyGuess.orderedLangs, ["es", "it"]);
  });
});

describe("M1 / F6: TurkishMorphology FSM Validator & Re-inflector", () => {
  it("accepts 35+ valid Turkish inflected words across harmony, softening, assimilation, vowel drop, narrowing, and chains", () => {
    const validWords = [
      // Basic & harmony
      "kitap", "kitaplar", "evler", "masalar", "gözler", "okullar",
      // Softening & exceptions
      "kitabı", "kitaba", "ağaca", "çocuğum", "rengi", "sokağa", "gidiyor", "ediyor",
      "atı", "atta", "özeti", "özette", "sepeti", "sepette",
      // Palatal loanwords (inverse harmony)
      "saati", "saatte", "saatler", "hayali", "kalbi", "kalpte", "alkolü", "harfi",
      // Fıstıkçı Şahap assimilation
      "kitapta", "kitaptan", "gitti", "çalıştı", "ağaççı", "Türkçe",
      // Buffer letters
      "arabaya", "arabayı", "arabanın", "arabası", "arabasında", "suyu", "suyun", "neyi",
      // Vowel drop & doubling
      "burnu", "aklı", "şehri", "şehre", "oğlu", "ismi", "vakti", "hakkı", "affı",
      // -yor narrowing & ye/de
      "bekliyor", "anlıyor", "söylüyor", "özetliyorum", "yiyen", "diyen", "yiyor", "diyecek",
      // Complex chains & -ki & proper nouns
      "evlerimizdekilerden", "anlayamadıklarımızdan", "görüşeceğiz", "teşekkürler",
      "görüşürüz", "çalışıyorum", "olsaydı", "baksana", "dünkü", "bugünkü",
      "Ankara'ya", "Türkiye'de",
    ];
    for (const w of validWords) {
      assert.equal(TurkishMorphology.isValidWord(w, trLexicon), true, `Expected valid Turkish word: ${w}`);
    }
  });

  it("rejects invalid vowel harmony, assimilation, voicing, vowel-drop, and non-narrowed forms", () => {
    const invalidWords = [
      "kitapda", "kitapdan", "kitapı",
      "saatda", "saatı", "saadi",
      "evte", "evten",
      "sepetde", "sepedi",
      "şehiri", "bekleyor", "gidyor",
      "ozetle", "ozetliyorum", "gorusecegiz", "tesekkurler", "gorusuruz", "calisiyorum", "turkce",
      "xyzabc", "qwerty",
    ];
    for (const w of invalidWords) {
      assert.equal(TurkishMorphology.isValidWord(w, trLexicon), false, `Expected invalid Turkish word: ${w}`);
    }
  });

  it("returns structured morpheme analyses and reinflectSuggestion", () => {
    const res1 = TurkishMorphology.analyze("evlerimizdekilerden", trLexicon);
    assert.ok(res1.length > 0 && res1[0].valid === true);
    assert.equal(res1[0].stem, "ev");
    assert.ok(res1[0].suffixes.includes("ki"));

    const res2 = TurkishMorphology.analyze("kitapda", trLexicon);
    assert.equal(res2[0].valid, false);
    assert.equal(res2[0].reinflectSuggestion, "kitapta");
  });

  it("repairs inflected typos via generateInflectedCandidates", () => {
    const repairCases = [
      ["kitapda", "kitapta"],
      ["saatda", "saatte"],
      ["ozetliyorum", "özetliyorum"],
      ["gorusecegiz", "görüşeceğiz"],
      ["kitapı", "kitabı"],
      ["burunu", "burnu"],
      ["kıtaplar", "kitaplar"],
      ["teşekürler", "teşekkürler"],
      ["ktaplar", "kitaplar"],
    ];
    for (const [typo, expected] of repairCases) {
      const cands = TurkishMorphology.generateInflectedCandidates(typo, trLexicon, 5);
      const words = cands.map((c) => c.word);
      assert.ok(words.includes(expected), `Expected "${expected}" in candidates for "${typo}", got: ${JSON.stringify(words)}`);
    }
    // Check top-1 accuracy on unambiguous morphological fixes
    assert.equal(TurkishMorphology.generateInflectedCandidates("kitapda", trLexicon, 3)[0].word, "kitapta");
    assert.equal(TurkishMorphology.generateInflectedCandidates("ozetliyorum", trLexicon, 3)[0].word, "özetliyorum");
    assert.equal(TurkishMorphology.generateInflectedCandidates("gorusecegiz", trLexicon, 3)[0].word, "görüşeceğiz");
  });
});

describe("M1 / F7: TurkishDeasciifier Homograph-Safe ASCII Restoration", () => {
  it("unambiguously restores common & inflected ASCII Turkish words while preserving casing", () => {
    const cases = [
      ["ozetle", "özetle"],
      ["Ozetle", "Özetle"],
      ["OZETLE", "ÖZETLE"],
      ["tesekkurler", "teşekkürler"],
      ["gorusuruz", "görüşürüz"],
      ["turkce", "türkçe"],
      ["Turkce", "Türkçe"],
      ["calisiyorum", "çalışıyorum"],
      ["cok", "çok"],
      ["guzel", "güzel"],
      ["ozetliyorum", "özetliyorum"],
      ["gorusecegiz", "görüşeceğiz"],
      ["kitaplarimizda", "kitaplarımızda"],
      ["Turkiye'de", "Türkiye'de"],
    ];
    for (const [ascii, expected] of cases) {
      const res = TurkishDeasciifier.deasciifyWord(ascii, trLexicon, TurkishMorphology);
      assert.equal(res.status, "unambiguous", `Expected unambiguous for "${ascii}", got ${res.status} (${JSON.stringify(res.candidates)})`);
      assert.equal(res.candidates[0].word, expected, `Expected "${expected}" for "${ascii}"`);
    }
  });

  it("preserves valid ASCII Turkish homographs safely without auto-replacing", () => {
    const homographsWithTwins = ["oldu", "kar", "yasa", "on", "sac", "kor", "tor", "yar", "saz"];
    for (const w of homographsWithTwins) {
      const res = TurkishDeasciifier.deasciifyWord(w, trLexicon, TurkishMorphology);
      assert.equal(res.status, "homograph_kept", `Expected homograph_kept for "${w}", got ${res.status}`);
    }

    const validAsciiWords = ["bul", "at", "yat", "sol", "al"];
    for (const w of validAsciiWords) {
      const res = TurkishDeasciifier.deasciifyWord(w, trLexicon, TurkishMorphology);
      assert.ok(
        res.status === "unchanged" || res.status === "homograph_kept",
        `Valid Turkish word "${w}" must not be modified (got ${res.status})`
      );
    }
  });

  it("returns ambiguous status for multi-target invalid ASCII words like uc -> uç / üç", () => {
    const resUc = TurkishDeasciifier.deasciifyWord("uc", trLexicon, TurkishMorphology);
    assert.equal(resUc.status, "ambiguous");
    const wordsUc = resUc.candidates.map((c) => c.word);
    assert.ok(wordsUc.includes("uç"));
    assert.ok(wordsUc.includes("üç"));

    const resSoyle = TurkishDeasciifier.deasciifyWord("soyle", trLexicon, TurkishMorphology);
    assert.equal(resSoyle.status, "ambiguous");
    const wordsSoyle = resSoyle.candidates.map((c) => c.word);
    assert.ok(wordsSoyle.includes("söyle"));
    assert.ok(wordsSoyle.includes("şöyle"));
  });

  it("leaves already-diacritic valid Turkish words unchanged", () => {
    for (const w of ["özetle", "teşekkürler", "görüşürüz", "Türkçe", "çalışıyorum"]) {
      const res = TurkishDeasciifier.deasciifyWord(w, trLexicon, TurkishMorphology);
      assert.equal(res.status, "unchanged");
    }
  });

  it("validates and deasciifies efficiently within interactive latency budgets", () => {
    const sample = ["ozetle", "kitaplarımızda", "oldu", "evlerimizdekilerden", "tesekkurler", "uc"];
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      for (const w of sample) {
        TurkishDeasciifier.deasciifyWord(w, trLexicon, TurkishMorphology);
      }
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 500, `1200 deasciifyWord calls took ${elapsedMs.toFixed(1)}ms`);
  });
});

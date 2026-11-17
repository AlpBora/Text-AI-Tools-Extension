#!/usr/bin/env node
/**
 * Reproducible offline lexicon compiler for Text AI Tools.
 *
 * Downloads open-source dictionaries & frequency lists (cached in os.tmpdir()),
 * validates & compiles compact JSON lexicons into:
 *   - shared/lexicons/en.json
 *   - shared/lexicons/tr.json
 *   - shared/lexicons/LICENSES.md
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "shared", "lexicons");
const CACHE_DIR = path.join(os.tmpdir(), "text-ai-tools-lexicon-cache");
const TurkishMorphology = require(path.join(ROOT_DIR, "content", "morphology-tr.js"));

const SOURCES = {
  enFreq: "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
  enDic: "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic",
  enAff: "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.aff",
  trFreq: "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/tr/tr_50k.txt",
  zemberekMaster: "https://raw.githubusercontent.com/ahmetaa/zemberek-nlp/master/morphology/src/main/resources/tr/master-dictionary.dict",
  zemberekProper: "https://raw.githubusercontent.com/ahmetaa/zemberek-nlp/master/morphology/src/main/resources/tr/proper.dict",
  trDic: "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/tr/index.dic",
  trAff: "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/tr/index.aff",
};

function trLower(str) {
  return String(str)
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .normalize("NFC");
}

async function fetchCached(name, url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, name);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf8");
  }
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  fs.writeFileSync(cachePath, text, "utf8");
  return text;
}

/**
 * Expands a Hunspell .dic + .aff pair into a Set of valid lowercase surface words.
 * Supports single-char flags (like en_US) and numeric flags (`FLAG num`, like tr_TR).
 */
function expandHunspell(dicText, affText, lowercaseFn = (s) => s.toLowerCase()) {
  let flagMode = "char";
  const pfxRules = new Map();
  const sfxRules = new Map();

  const affLines = affText.split(/\r?\n/);
  for (let i = 0; i < affLines.length; i++) {
    const line = affLines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "FLAG" && parts[1] === "num") {
      flagMode = "num";
      continue;
    }
    if ((parts[0] === "PFX" || parts[0] === "SFX") && parts.length >= 4 && (parts[2] === "Y" || parts[2] === "N")) {
      const type = parts[0];
      const flag = parts[1];
      const cross = parts[2] === "Y";
      const count = parseInt(parts[3], 10);
      const entries = [];
      for (let j = 0; j < count && i + 1 < affLines.length; j++) {
        i++;
        const rLine = affLines[i].trim();
        if (!rLine || rLine.startsWith("#")) continue;
        const rp = rLine.split(/\s+/);
        if (rp[0] !== type || rp[1] !== flag || rp.length < 5) continue;
        const strip = rp[2] === "0" ? "" : rp[2];
        const add = rp[3] === "0" ? "" : rp[3].split("/")[0];
        const cond = rp[4];
        let regex = null;
        if (cond && cond !== ".") {
          try {
            regex = type === "PFX" ? new RegExp(`^${cond}`, "u") : new RegExp(`${cond}$`, "u");
          } catch {
            regex = null;
          }
        }
        entries.push({ strip, add, regex });
      }
      const map = type === "PFX" ? pfxRules : sfxRules;
      map.set(flag, { cross, entries });
    }
  }

  const valid = new Set();
  const dicLines = dicText.split(/\r?\n/);
  for (let i = 1; i < dicLines.length; i++) {
    const raw = dicLines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const firstTab = raw.split(/\s+/)[0];
    const slashIdx = firstTab.indexOf("/");
    const baseWord = slashIdx >= 0 ? firstTab.slice(0, slashIdx) : firstTab;
    const flagStr = slashIdx >= 0 ? firstTab.slice(slashIdx + 1) : "";
    if (!baseWord || /\d/.test(baseWord)) continue;

    valid.add(lowercaseFn(baseWord));

    if (!flagStr) continue;
    const flags = flagMode === "num" ? flagStr.split(",").filter(Boolean) : flagStr.split("");

    const appliedPrefixes = [];
    for (const f of flags) {
      const pr = pfxRules.get(f);
      if (!pr) continue;
      for (const e of pr.entries) {
        if (e.regex && !e.regex.test(baseWord)) continue;
        if (e.strip && !baseWord.startsWith(e.strip)) continue;
        const stem = e.strip ? baseWord.slice(e.strip.length) : baseWord;
        const derived = e.add + stem;
        valid.add(lowercaseFn(derived));
        if (pr.cross) appliedPrefixes.push(derived);
      }
    }

    for (const f of flags) {
      const sr = sfxRules.get(f);
      if (!sr) continue;
      for (const e of sr.entries) {
        if (!e.regex || e.regex.test(baseWord)) {
          if (!e.strip || baseWord.endsWith(e.strip)) {
            const stem = e.strip ? baseWord.slice(0, baseWord.length - e.strip.length) : baseWord;
            valid.add(lowercaseFn(stem + e.add));
          }
        }
        if (sr.cross && appliedPrefixes.length > 0) {
          for (const pWord of appliedPrefixes) {
            if (e.regex && !e.regex.test(pWord)) continue;
            if (e.strip && !pWord.endsWith(e.strip)) continue;
            const stem = e.strip ? pWord.slice(0, pWord.length - e.strip.length) : pWord;
            valid.add(lowercaseFn(stem + e.add));
          }
        }
      }
    }
  }
  return valid;
}

const EN_CONTRACTIONS = [
  "i'm", "you're", "he's", "she's", "it's", "we're", "they're",
  "i've", "you've", "we've", "they've",
  "i'll", "you'll", "he'll", "she'll", "it'll", "we'll", "they'll",
  "i'd", "you'd", "he'd", "she'd", "it'd", "we'd", "they'd",
  "isn't", "aren't", "wasn't", "weren't",
  "hasn't", "haven't", "hadn't",
  "doesn't", "don't", "didn't",
  "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't", "needn't",
  "that's", "what's", "who's", "where's", "when's", "why's", "how's",
  "there's", "here's", "let's", "ma'am", "o'clock"
];

function buildEnglishLexicon(enFreqText, enDicText, enAffText) {
  const scowlValid = expandHunspell(enDicText, enAffText, (s) => s.toLowerCase());
  for (const c of EN_CONTRACTIONS) scowlValid.add(c);

  const words = {};
  const lines = enFreqText.split(/\r?\n/);
  const MAX_WORDS = 40000;
  let countAdded = 0;

  for (const line of lines) {
    if (!line) continue;
    const sp = line.trim().split(/\s+/);
    if (sp.length < 2) continue;
    const rawWord = sp[0].toLowerCase().replace(/’/g, "'");
    const freq = parseInt(sp[1], 10);
    if (!Number.isFinite(freq) || freq <= 0) continue;

    // Filter single-letter noise: only "a" and "i" are standard English single-letter words
    if (rawWord.length === 1 && rawWord !== "a" && rawWord !== "i") continue;
    if (!/^[a-z]+(?:'[a-z]+)?$/.test(rawWord)) continue;
    if (!scowlValid.has(rawWord)) continue;

    if (!(rawWord in words)) {
      // Log10 frequency scaled x100 (e.g., 28M -> 746, 150 -> 218)
      words[rawWord] = Math.round(Math.log10(freq + 1) * 100);
      countAdded++;
      if (countAdded >= MAX_WORDS) break;
    }
  }

  // Ensure contractions & essential high-utility words are present
  let totalWords = countAdded;
  for (const c of EN_CONTRACTIONS) {
    if (!(c in words)) {
      words[c] = 450;
      totalWords++;
    }
  }

  // Supplement with core SCOWL base words (length >= 3) if under target count
  for (const w of scowlValid) {
    if (totalWords >= 42000) break;
    if (w.length >= 3 && /^[a-z]+$/.test(w) && !(w in words)) {
      words[w] = 160;
      totalWords++;
    }
  }

  return {
    version: 1,
    lang: "en",
    source: "hermitdave/FrequencyWords (en_50k, MIT) validated against wooorm/dictionaries en (SCOWL)",
    count: totalWords,
    words,
  };
}

const POS_MAP = {
  Noun: "N",
  Verb: "V",
  Adj: "A",
  Adv: "R",
  Proper: "P",
  Num: "M",
  Card: "M",
  Ord: "M",
  Dist: "M",
  Pron: "O",
  Conj: "O",
  Det: "O",
  Postp: "O",
  Interj: "O",
  Ques: "O",
  Pers: "O",
  Demons: "O",
  Reflex: "O",
  Quant: "O",
  Time: "N",
  Dup: "O",
};

const ATTR_MAP = {
  Voicing: "v",
  NoVoicing: "nv",
  LastVowelDrop: "vd",
  InverseHarmony: "ih",
  Doubling: "db",
  Aorist_A: "aa",
  Aorist_I: "ai",
  NoSuffix: "ns",
  CompoundP3sg: "cp",
  ImplicitDative: "id",
  ImplicitPlural: "ip",
};

function parseZemberekLine(line, defaultPos) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const bracketIdx = trimmed.indexOf("[");
  const headword = (bracketIdx >= 0 ? trimmed.slice(0, bracketIdx) : trimmed).trim();
  if (!headword) return null;

  const meta = bracketIdx >= 0 ? trimmed.slice(bracketIdx + 1, trimmed.lastIndexOf("]")) : "";
  if (meta.includes("P:Punc")) return null;

  // Skip entries with non-Turkish symbols, spaces, dots, hyphens
  const lower = trLower(headword);
  if (!/^[a-zçğıöşüâîû]+$/.test(lower)) return null;

  let rawPosList = [];
  const rawAttrs = new Set();

  if (meta) {
    for (const part of meta.split(";")) {
      const p = part.trim();
      if (p.startsWith("P:")) {
        for (const item of p.slice(2).split(",")) {
          const k = item.trim();
          if (k) rawPosList.push(k);
        }
      } else if (p.startsWith("A:")) {
        for (const item of p.slice(2).split(",")) {
          const k = item.trim();
          if (ATTR_MAP[k]) rawAttrs.add(ATTR_MAP[k]);
        }
      }
    }
  }

  let isVerb = false;
  if (rawPosList.length === 0) {
    if (!defaultPos && (lower.endsWith("mak") || lower.endsWith("mek")) && lower.length > 4) {
      rawPosList = ["Verb"];
      isVerb = true;
    } else {
      rawPosList = [defaultPos || "Noun"];
    }
  } else if (rawPosList.includes("Verb")) {
    isVerb = true;
  }

  const mappedPos = new Set();
  for (const p of rawPosList) {
    if (POS_MAP[p]) mappedPos.add(POS_MAP[p]);
  }
  if (mappedPos.size === 0) mappedPos.add("N");

  let stem = lower;
  if (isVerb && (lower.endsWith("mak") || lower.endsWith("mek")) && lower.length > 4) {
    stem = lower.slice(0, -3);
  }

  const attrs = Array.from(rawAttrs).sort().join(",");
  return { stem, posList: Array.from(mappedPos), attrs };
}

function buildTurkishLexicon(masterText, properText, trFreqText, trDicText, trAffText) {
  const rootMap = new Map(); // stem -> Set of "POS" or "POS|flags"

  const addRoot = (stem, pos, attrs) => {
    const spec = attrs ? `${pos}|${attrs}` : pos;
    let set = rootMap.get(stem);
    if (!set) {
      set = new Set();
      rootMap.set(stem, set);
    }
    set.add(spec);
  };

  for (const line of masterText.split(/\r?\n/)) {
    const parsed = parseZemberekLine(line, null);
    if (!parsed) continue;
    for (const pos of parsed.posList) {
      addRoot(parsed.stem, pos, parsed.attrs);
    }
  }

  for (const line of properText.split(/\r?\n/)) {
    const parsed = parseZemberekLine(line, "Proper");
    if (!parsed) continue;
    addRoot(parsed.stem, "P", parsed.attrs);
  }

  // Ensure key pronouns / question particles / common stems exist
  const essentialRoots = [
    ["ben", "O", ""],
    ["sen", "O", ""],
    ["o", "O", ""],
    ["biz", "O", ""],
    ["siz", "O", ""],
    ["onlar", "O", ""],
    ["bu", "O", ""],
    ["şu", "O", ""],
    ["mı", "O", ""],
    ["mi", "O", ""],
    ["mu", "O", ""],
    ["mü", "O", ""],
    ["de", "V", ""],
    ["ye", "V", ""],
    ["türkçe", "P", ""],
    ["türkiye", "P", ""],
    ["türk", "P", "nv"],
    ["ingilizce", "P", ""],
    ["almanca", "P", ""],
  ];
  for (const [stem, pos, attrs] of essentialRoots) {
    addRoot(stem, pos, attrs);
  }

  // Add circumflex-stripped root aliases (e.g. silah <- silâh, evlat <- evlât, herhalde <- herhâlde)
  // ONLY when the circumflex-less stem does not already exist (preserves kar vs kâr, yar vs yâr, etc.)
  const circumflexAdditions = [];
  for (const [stem, specSet] of rootMap.entries()) {
    if (/[âîû]/.test(stem)) {
      const stripped = stem.replace(/â/g, "a").replace(/î/g, "i").replace(/û/g, "u");
      if (!rootMap.has(stripped)) {
        circumflexAdditions.push([stripped, Array.from(specSet)]);
      }
    }
  }
  for (const [stripped, specs] of circumflexAdditions) {
    if (!rootMap.has(stripped)) {
      rootMap.set(stripped, new Set(specs));
    }
  }

  const roots = {};
  for (const [stem, specSet] of rootMap.entries()) {
    const specs = Array.from(specSet);
    const hasNv = specs.some((s) => s.includes("|") && s.split("|")[1].split(",").includes("nv"));
    const hasV = specs.some((s) => s.includes("|") && s.split("|")[1].split(",").includes("v"));
    const hasVd = specs.some((s) => s.includes("|") && s.split("|")[1].split(",").includes("vd"));
    const hasDb = specs.some((s) => s.includes("|") && s.split("|")[1].split(",").includes("db"));

    roots[stem] = specs
      .map((s) => {
        const [p, fl] = s.includes("|") ? s.split("|") : [s, ""];
        const flSet = new Set(fl ? fl.split(",").filter(Boolean) : []);
        if (hasNv && !hasV) flSet.add("nv");
        if (hasVd) flSet.add("vd");
        if (hasDb) flSet.add("db");
        return flSet.size > 0 ? `${p}|${Array.from(flSet).sort().join(",")}` : p;
      })
      .join(";");
  }

  // Validate tr_50k surface forms using our own TurkishMorphology FSM over compiled roots
  // (eliminates OpenSubtitles ASCII typos like "simdi"/"restorant" and foreign words like "john"/"chai")
  const morphLex = { roots };
  const words = {};
  const MAX_SURF = 35000;
  let surfCount = 0;

  for (const line of trFreqText.split(/\r?\n/)) {
    if (!line) continue;
    const sp = line.trim().split(/\s+/);
    if (sp.length < 2) continue;
    const w = trLower(sp[0]);
    const freq = parseInt(sp[1], 10);
    if (!Number.isFinite(freq) || freq <= 0) continue;

    if (!/^[a-zçğıöşüâîû]+$/.test(w)) continue;
    if (w.length === 1 && w !== "o") continue;
    if (/[qwx]/.test(w)) continue;

    if (!TurkishMorphology.isValidWord(w, morphLex)) continue;

    if (!(w in words)) {
      words[w] = Math.round(Math.log10(freq + 1) * 100);
      surfCount++;
      if (surfCount >= MAX_SURF) break;
    }
  }

  return {
    version: 1,
    lang: "tr",
    source: "ahmetaa/zemberek-nlp (Apache-2.0) + hermitdave/FrequencyWords tr_50k (MIT) validated via TurkishMorphology",
    rootCount: Object.keys(roots).length,
    wordCount: Object.keys(words).length,
    roots,
    words,
  };
}

function writeLicenses() {
  const md = `# Bundled Lexicon Sources & Licenses

All lexicons in \`shared/lexicons/\` are compiled by \`scripts/build_lexicons.mjs\` exclusively from permissive open-source datasets:

## 1. hermitdave/FrequencyWords (2018 OpenSubtitles)
- **Files used**: \`en_50k.txt\`, \`tr_50k.txt\`
- **Repository**: https://github.com/hermitdave/FrequencyWords
- **License**: MIT License (Copyright (c) 2016 Hermit Dave)
- **Usage**: Frequency weights (\`Math.round(Math.log10(count + 1) * 100)\`) for English and Turkish surface words.

## 2. wooorm/dictionaries (SCOWL en & Turkish Hunspell)
- **Files used**: \`dictionaries/en/index.dic\`, \`dictionaries/en/index.aff\`, \`dictionaries/tr/index.dic\`, \`dictionaries/tr/index.aff\`
- **Repository**: https://github.com/wooorm/dictionaries
- **Licenses**:
  - \`dictionaries/en\`: SCOWL / MIT-style permissive license (http://wordlist.sourceforge.net)
  - \`dictionaries/tr\`: MIT License (Copyright (c) 2014 Harun Reşit Zafer)
- **Usage**: Validation/filtering of OpenSubtitles corpus entries to eliminate subtitle typos and non-target-language artifacts.

## 3. ahmetaa/zemberek-nlp (Turkish Morphological Lexicon)
- **Files used**: \`morphology/src/main/resources/tr/master-dictionary.dict\`, \`proper.dict\`
- **Repository**: https://github.com/ahmetaa/zemberek-nlp
- **License**: Apache License 2.0 (Copyright 2018 Ahmet A. Akın, Mehmet D. Akın)
- **Usage**: Turkish root lemmas, POS tags (\`Noun\`, \`Verb\`, \`Adj\`, \`Adv\`, \`Proper\`, \`Num\`, \`Other\`), and morphophonological irregularity flags (\`Voicing\`, \`NoVoicing\`, \`LastVowelDrop\`, \`InverseHarmony\`, \`Doubling\`, \`Aorist_A\`, \`Aorist_I\`, etc.).
`;
  fs.writeFileSync(path.join(OUT_DIR, "LICENSES.md"), md, "utf8");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const [
    enFreqText,
    enDicText,
    enAffText,
    trFreqText,
    masterText,
    properText,
    trDicText,
    trAffText,
  ] = await Promise.all([
    fetchCached("en_50k.txt", SOURCES.enFreq),
    fetchCached("en_index.dic", SOURCES.enDic),
    fetchCached("en_index.aff", SOURCES.enAff),
    fetchCached("tr_50k.txt", SOURCES.trFreq),
    fetchCached("zemberek_master.dict", SOURCES.zemberekMaster),
    fetchCached("zemberek_proper.dict", SOURCES.zemberekProper),
    fetchCached("tr_index.dic", SOURCES.trDic),
    fetchCached("tr_index.aff", SOURCES.trAff),
  ]);

  console.log("Compiling English lexicon...");
  const enLexicon = buildEnglishLexicon(enFreqText, enDicText, enAffText);
  const enOutPath = path.join(OUT_DIR, "en.json");
  fs.writeFileSync(enOutPath, JSON.stringify(enLexicon), "utf8");
  console.log(`Wrote ${enOutPath}: ${enLexicon.count} words (${(fs.statSync(enOutPath).size / 1024).toFixed(1)} KB)`);

  console.log("Compiling Turkish lexicon...");
  const trLexicon = buildTurkishLexicon(masterText, properText, trFreqText, trDicText, trAffText);
  const trOutPath = path.join(OUT_DIR, "tr.json");
  fs.writeFileSync(trOutPath, JSON.stringify(trLexicon), "utf8");
  console.log(`Wrote ${trOutPath}: ${trLexicon.rootCount} roots, ${trLexicon.wordCount} surface words (${(fs.statSync(trOutPath).size / 1024).toFixed(1)} KB)`);

  writeLicenses();
  console.log(`Wrote ${path.join(OUT_DIR, "LICENSES.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

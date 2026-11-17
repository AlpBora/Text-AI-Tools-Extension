(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

  function resolveDep(nsKey, nodePath) {
    if (NS[nsKey]) return NS[nsKey];
    if (typeof require === "function") {
      try {
        const mod = require(nodePath);
        if (mod) NS[nsKey] = mod;
        return mod;
      } catch {
        return null;
      }
    }
    return null;
  }

  function trLower(str) {
    return String(str)
      .normalize("NFC")
      .replace(/İ/g, "i")
      .replace(/I/g, "ı")
      .toLowerCase()
      .replace(/i\u0307/g, "i")
      .normalize("NFC");
  }

  function trUpper(str) {
    return String(str)
      .replace(/i/g, "İ")
      .replace(/ı/g, "I")
      .toUpperCase();
  }

  function trFold(str) {
    return trLower(str)
      .replace(/ç/g, "c")
      .replace(/ğ/g, "g")
      .replace(/ı/g, "i")
      .replace(/ö/g, "o")
      .replace(/ş/g, "s")
      .replace(/ü/g, "u")
      .replace(/â/g, "a")
      .replace(/î/g, "i")
      .replace(/û/g, "u");
  }

  function applyCasing(targetWord, originalWord, langId) {
    if (!targetWord || !originalWord) return targetWord;
    const isTr = langId === "tr";
    const toUp = isTr ? trUpper : (s) => s.toUpperCase();
    const toLow = isTr ? trLower : (s) => s.toLowerCase();

    const cleanOrig = originalWord.trim();
    if (cleanOrig.length >= 2 && cleanOrig === toUp(cleanOrig) && cleanOrig !== toLow(cleanOrig)) {
      return toUp(targetWord);
    }
    const first = cleanOrig[0];
    if (first && first === toUp(first) && first !== toLow(first)) {
      return toUp(targetWord[0]) + targetWord.slice(1);
    }
    return targetWord;
  }

  function normalizeApostrophes(str) {
    return String(str || "").replace(/[\u2018\u2019\u02BC]/g, "'");
  }

  // --- F1: Non-Prose Skip Guards ---
  const URL_SCHEME_RE = /^(?:https?|ftp|file):\/\//i;
  const URL_WWW_RE = /^www\.[^\s]+/i;
  const URL_DOMAIN_PATH_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;
  const URL_DOMAIN_TLD_RE =
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|dev|app|ai|co|uk|de|fr|tr|info|biz|me|xyz|tv|cc|gg|ly|to|sh|js|ts|mjs|cjs|py|json|html|css|md|xml|yml|yaml|txt)$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CODE_PUNCT_RE = /[$\\/=<> {}[\]()*+:;~^`|]/;
  const SKIPPED_INPUT_TYPES = new Set(["password", "email", "url", "hidden", "number"]);

  function isSkippedToken(token, context) {
    if (context && typeof context === "object") {
      if (context.skip === true || context.insideCode === true) return true;
      if (typeof context.inputType === "string" && SKIPPED_INPUT_TYPES.has(context.inputType.toLowerCase())) {
        return true;
      }
    }

    if (!token || typeof token !== "string") return true;
    const t = normalizeApostrophes(token.trim());
    if (t.length <= 1) return true;

    if (t.startsWith("@") || t.startsWith("#")) return true;
    if (URL_SCHEME_RE.test(t) || URL_WWW_RE.test(t) || t.includes("://")) return true;
    if (URL_DOMAIN_PATH_RE.test(t) || URL_DOMAIN_TLD_RE.test(t)) return true;
    if (EMAIL_RE.test(t)) return true;

    // Numbers & alphanumeric identifiers (2026, v2, mp3, 10px, utf8)
    if (/\d/.test(t)) return true;

    // Code identifiers: snake_case, camelCase/internal PascalCase, kebab-case, code symbols
    if (t.includes("_")) return true;
    if (/\p{Ll}\p{Lu}/u.test(t)) return true;
    if (/[\p{L}\d]-[\p{L}\d]/u.test(t) || t.startsWith("-") || t.endsWith("-")) return true;
    if (CODE_PUNCT_RE.test(t)) return true;

    // Must contain at least 2 Unicode letters
    const letters = t.match(/\p{L}/gu);
    if (!letters || letters.length < 2) return true;

    // ALL_CAPS (>= 2 uppercase letters and zero lowercase letters)
    if (!/\p{Ll}/u.test(t) && /\p{Lu}/u.test(t)) return true;

    return false;
  }

  // --- QWERTY Keyboard Adjacency Map (US + TR-Q layout) ---
  const QWERTY_ROWS = [
    "qwertyuıopğü",
    "qwertyuiop",
    "asdfghjklşi",
    "asdfghjkl",
    "zxcvbnmöç",
    "zxcvbnm",
  ];
  const ADJACENT_KEYS = new Map();
  (function buildKeyboardAdjacency() {
    const addEdge = (a, b) => {
      if (!a || !b || a === b) return;
      let sa = ADJACENT_KEYS.get(a);
      if (!sa) {
        sa = new Set();
        ADJACENT_KEYS.set(a, sa);
      }
      sa.add(b);
    };
    for (const row of QWERTY_ROWS) {
      for (let i = 0; i < row.length; i++) {
        if (i > 0) {
          addEdge(row[i], row[i - 1]);
          addEdge(row[i - 1], row[i]);
        }
      }
    }
    const verticalPairs = [
      ["q", "a"], ["w", "a"], ["w", "s"], ["e", "s"], ["e", "d"], ["r", "d"], ["r", "f"],
      ["t", "f"], ["t", "g"], ["y", "g"], ["y", "h"], ["u", "h"], ["u", "j"], ["i", "j"],
      ["i", "k"], ["ı", "k"], ["o", "k"], ["o", "l"], ["p", "l"], ["p", "ş"], ["ğ", "ş"],
      ["a", "z"], ["s", "z"], ["s", "x"], ["d", "x"], ["d", "c"], ["f", "c"], ["f", "v"],
      ["g", "v"], ["g", "b"], ["h", "b"], ["h", "n"], ["j", "n"], ["j", "m"], ["k", "m"],
      ["k", "ö"], ["l", "ö"], ["l", "ç"], ["ş", "ç"],
    ];
    for (const [a, b] of verticalPairs) {
      addEdge(a, b);
      addEdge(b, a);
    }
  })();

  const FOLDED_VOWELS = new Set(["a", "e", "i", "o", "u"]);

  function isKeyboardAdjacent(a, b) {
    const set = ADJACENT_KEYS.get(a);
    return Boolean(set && set.has(b));
  }

  // Reusable 1D DP buffers (up to word length 63) for zero-allocation edit distance
  const DP_STRIDE = 64;
  const W_DP = new Float64Array(DP_STRIDE * DP_STRIDE);
  const R_DP = new Uint8Array(DP_STRIDE * DP_STRIDE);
  const P_DP = new Float64Array(DP_STRIDE * DP_STRIDE);

  // --- Weighted Damerau-Levenshtein (G2) ---
  // Returns { weightedDist, rawDist }
  function weightedDamerauLevenshtein(rawA, rawB, foldFn) {
    const la = rawA.length;
    const lb = rawB.length;
    if (Math.abs(la - lb) > 3 || la >= DP_STRIDE || lb >= DP_STRIDE) {
      return { weightedDist: 99, rawDist: 99 };
    }

    const foldA = foldFn ? foldFn(rawA) : trFold(rawA);
    const foldB = foldFn ? foldFn(rawB) : trFold(rawB);
    const stride = lb + 1;

    for (let i = 0; i <= la; i++) {
      W_DP[i * stride] = i;
      R_DP[i * stride] = i;
    }
    for (let j = 0; j <= lb; j++) {
      W_DP[j] = j;
      R_DP[j] = j;
    }

    for (let i = 1; i <= la; i++) {
      const ca = rawA[i - 1];
      const fa = foldA[i - 1] || ca;
      const row = i * stride;
      const prevRow = (i - 1) * stride;

      for (let j = 1; j <= lb; j++) {
        const cb = rawB[j - 1];
        const fb = foldB[j - 1] || cb;

        let subCost = 0;
        let rawSub = 0;
        if (ca !== cb) {
          rawSub = 1;
          if (fa === fb) {
            subCost = 0.15; // diacritic difference only
          } else if (isKeyboardAdjacent(fa, fb)) {
            subCost = 0.55;
          } else if (FOLDED_VOWELS.has(fa) && FOLDED_VOWELS.has(fb)) {
            subCost = 0.65;
          } else {
            subCost = 1.0;
          }
        }

        const insCost = j > 1 && foldB[j - 1] === foldB[j - 2] ? 0.35 : 1.0;
        const delCost = i > 1 && foldA[i - 1] === foldA[i - 2] ? 0.35 : 1.0;

        let bestW = Math.min(
          W_DP[prevRow + j] + delCost,
          W_DP[row + j - 1] + insCost,
          W_DP[prevRow + j - 1] + subCost
        );
        let bestR = Math.min(
          R_DP[prevRow + j] + 1,
          R_DP[row + j - 1] + 1,
          R_DP[prevRow + j - 1] + rawSub
        );

        if (i > 1 && j > 1 && rawA[i - 1] === rawB[j - 2] && rawA[i - 2] === rawB[j - 1]) {
          const prev2Row = (i - 2) * stride;
          const transW = W_DP[prev2Row + j - 2] + 0.50;
          if (transW < bestW) bestW = transW;
          const transR = R_DP[prev2Row + j - 2] + 1;
          if (transR < bestR) bestR = transR;
        } else if (i > 1 && j > 1 && fa === foldB[j - 2] && foldA[i - 2] === fb) {
          const prev2Row = (i - 2) * stride;
          const transW = W_DP[prev2Row + j - 2] + 0.60;
          if (transW < bestW) bestW = transW;
        }

        W_DP[row + j] = bestW;
        R_DP[row + j] = bestR;
      }
    }

    return {
      weightedDist: W_DP[la * stride + lb],
      rawDist: R_DP[la * stride + lb],
    };
  }

  // --- G3: Cross-Lingual Phonetic Key & Fuzzy Consonant Skeleton ---
  function computePhonetic(word) {
    let s = String(word || "")
      .toLowerCase()
      .replace(/['’\-]/g, "")
      .replace(/ç/g, "ch")
      .replace(/ş/g, "sh")
      .replace(/ğ/g, "g")
      .replace(/ı/g, "i")
      .replace(/ö/g, "o")
      .replace(/ü/g, "u")
      .replace(/â/g, "a")
      .replace(/î/g, "i")
      .replace(/û/g, "u")
      .replace(/ß/g, "ss");

    // Silent leading clusters
    s = s
      .replace(/^(kn|gn|pn)/, "n")
      .replace(/^ps/, "s")
      .replace(/^wr/, "r")
      .replace(/^wh/, "v")
      .replace(/^pt/, "t");

    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c0 = s[i];
      const c1 = i + 1 < n ? s[i + 1] : "";
      const c2 = i + 2 < n ? s[i + 2] : "";

      if (c0 === "t" && c1 === "c" && c2 === "h") {
        out += "C";
        i += 3;
        continue;
      }
      if (c0 === "s" && c1 === "c" && c2 === "h") {
        out += "SK";
        i += 3;
        continue;
      }
      if (c0 === "g" && c1 === "h" && c2 === "t") {
        out += "T";
        i += 3;
        continue;
      }
      if (c0 === "c" && c1 === "h") {
        out += "C";
        i += 2;
        continue;
      }
      if (c0 === "s" && c1 === "h") {
        out += "X";
        i += 2;
        continue;
      }
      if (c0 === "p" && c1 === "h") {
        out += "F";
        i += 2;
        continue;
      }
      if (c0 === "t" && c1 === "h") {
        out += "T";
        i += 2;
        continue;
      }
      if (c0 === "g" && c1 === "h") {
        if (i === 0) out += "G";
        i += 2;
        continue;
      }
      if (c0 === "c" && c1 === "k") {
        out += "K";
        i += 2;
        continue;
      }
      if (c0 === "s" && c1 === "s" && c2 === "i" && i + 3 < n && "aeiou".includes(s[i + 3])) {
        out += "X";
        i += 2;
        continue;
      }
      if ((c0 === "t" || c0 === "c" || c0 === "s") && c1 === "i" && c2 && "aeiou".includes(c2)) {
        out += "X";
        i += 1;
        continue;
      }

      if (c0 === "x") {
        out += "KS";
        i++;
        continue;
      }
      if (c0 === "q") {
        out += "K";
        i++;
        continue;
      }
      if (c0 === "c") {
        out += c1 === "e" || c1 === "i" || c1 === "y" ? "S" : "K";
        i++;
        continue;
      }
      if (c0 === "g") {
        out += c1 === "e" || c1 === "i" || c1 === "y" ? "J" : "G";
        i++;
        continue;
      }
      if (c0 === "w") {
        out += "V";
        i++;
        continue;
      }
      if (c0 === "h") {
        if (i === 0) out += "H";
        i++;
        continue;
      }
      if (c0 === "y") {
        out += i === 0 ? "Y" : "a";
        i++;
        continue;
      }
      if (c0 === "a" || c0 === "e" || c0 === "i" || c0 === "o" || c0 === "u") {
        out += "a";
        i++;
        continue;
      }
      if (c0 >= "a" && c0 <= "z") {
        out += c0.toUpperCase();
      }
      i++;
    }

    let phon = "";
    for (let j = 0; j < out.length; j++) {
      if (j === 0 || out[j] !== out[j - 1]) phon += out[j];
    }

    const skel = phon.replace(/a/g, "");
    let coarse = "";
    for (let j = 0; j < skel.length; j++) {
      let ch = skel[j];
      if (ch === "C" || ch === "G") ch = "K";
      else if (ch === "Z" || ch === "J") ch = "S";
      else if (ch === "D") ch = "T";
      else if (ch === "B") ch = "P";
      else if (ch === "V") ch = "F";
      if (coarse.length === 0 || coarse[coarse.length - 1] !== ch) {
        coarse += ch;
      }
    }

    return { phon, skel, coarse };
  }

  function phonSubstitutionCost(a, b) {
    if (a === b) return 0;
    if ((a === "C" && b === "K") || (a === "K" && b === "C")) return 0.06;
    if ((a === "S" && b === "J") || (a === "J" && b === "S")) return 0.22;
    if ((a === "S" && b === "Z") || (a === "Z" && b === "S")) return 0.22;
    if ((a === "G" && b === "J") || (a === "J" && b === "G")) return 0.25;
    if ((a === "G" && b === "K") || (a === "K" && b === "G")) return 0.30;
    if ((a === "T" && b === "D") || (a === "D" && b === "T")) return 0.25;
    if ((a === "P" && b === "B") || (a === "B" && b === "P")) return 0.25;
    if ((a === "F" && b === "V") || (a === "V" && b === "F")) return 0.25;
    if ((a === "X" && b === "S") || (a === "S" && b === "X")) return 0.30;
    if ((a === "X" && b === "C") || (a === "C" && b === "X")) return 0.30;
    if (a === "a" || b === "a") return 0.65;
    return 1.0;
  }

  function phoneticEditDistance(a, b) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 5 || la >= DP_STRIDE || lb >= DP_STRIDE) return 99;
    const stride = lb + 1;

    for (let i = 0; i <= la; i++) P_DP[i * stride] = i * 0.60;
    for (let j = 0; j <= lb; j++) P_DP[j] = j * 0.60;

    for (let i = 1; i <= la; i++) {
      const ca = a[i - 1];
      const delCost = ca === "a" || ca === "H" ? 0.55 : 0.95;
      const row = i * stride;
      const prevRow = (i - 1) * stride;
      for (let j = 1; j <= lb; j++) {
        const cb = b[j - 1];
        const insCost = cb === "a" || cb === "H" ? 0.55 : 0.95;
        const subCost = phonSubstitutionCost(ca, cb);
        let best = Math.min(P_DP[prevRow + j] + delCost, P_DP[row + j - 1] + insCost, P_DP[prevRow + j - 1] + subCost);
        if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) {
          const trans = P_DP[(i - 2) * stride + j - 2] + 0.45;
          if (trans < best) best = trans;
        }
        P_DP[row + j] = best;
      }
    }
    return P_DP[la * stride + lb];
  }

  function extractBigrams(str) {
    if (!str) return [];
    const padded = `^${str}$`;
    const seen = new Set();
    const out = [];
    for (let i = 0; i < padded.length - 1; i++) {
      const bg = padded.slice(i, i + 2);
      if (!seen.has(bg)) {
        seen.add(bg);
        out.push(bg);
      }
    }
    return out;
  }

  // --- WeakMap<lexicon, Map<langId, LexiconIndex>> ---
  const LEXICON_INDEX_CACHE = new WeakMap();

  function addToBucketMap(map, key, id) {
    if (!key) return;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(id);
  }

  function getLexiconIndex(lexicon, profile) {
    if (!lexicon || typeof lexicon !== "object") return null;
    const langKey = (profile && profile.id) || lexicon.lang || "generic";

    let byLang = LEXICON_INDEX_CACHE.get(lexicon);
    if (!byLang) {
      byLang = new Map();
      LEXICON_INDEX_CACHE.set(lexicon, byLang);
    }
    if (byLang.has(langKey)) {
      return byLang.get(langKey);
    }

    const foldFn =
      profile && typeof profile.fold === "function"
        ? profile.fold
        : langKey === "tr"
          ? trFold
          : (s) => String(s).toLowerCase();

    const exactMap = new Map();
    const wordsObj = lexicon.words || {};
    let maxFreq = 1;

    for (const w of Object.keys(wordsObj)) {
      const f = Number(wordsObj[w]) || 1;
      exactMap.set(w, f);
      if (f > maxFreq) maxFreq = f;
    }

    const rootsObj = lexicon.roots || {};
    for (const r of Object.keys(rootsObj)) {
      if (!exactMap.has(r)) {
        exactMap.set(r, 140);
      }
    }

    const total = exactMap.size;
    const wordsArr = new Array(total);
    const foldedArr = new Array(total);
    const freqsArr = new Float64Array(total);
    const lensArr = new Uint16Array(total);
    const phonArr = new Array(total);
    const skelArr = new Array(total);
    const coarseArr = new Array(total);

    const foldedMap = new Map();
    const foldedBigramIndex = new Map();
    const coarseMap = new Map();
    const coarseBigramIndex = new Map();

    let id = 0;
    for (const [w, freq] of exactMap.entries()) {
      const folded = foldFn(w);
      const { phon, skel, coarse } = computePhonetic(folded);

      wordsArr[id] = w;
      foldedArr[id] = folded;
      freqsArr[id] = freq;
      lensArr[id] = folded.length;
      phonArr[id] = phon;
      skelArr[id] = skel;
      coarseArr[id] = coarse;

      let fList = foldedMap.get(folded);
      if (!fList) {
        fList = [];
        foldedMap.set(folded, fList);
      }
      fList.push({ word: w, freq });

      const fBigrams = extractBigrams(folded);
      for (let b = 0; b < fBigrams.length; b++) {
        addToBucketMap(foldedBigramIndex, fBigrams[b], id);
      }

      addToBucketMap(coarseMap, coarse, id);
      if (coarse.length >= 2) {
        const cBigrams = extractBigrams(coarse);
        for (let b = 0; b < cBigrams.length; b++) {
          addToBucketMap(coarseBigramIndex, cBigrams[b], id);
        }
      }

      id++;
    }

    for (const fList of foldedMap.values()) {
      if (fList.length > 1) {
        fList.sort((a, b) => b.freq - a.freq);
      }
    }

    const index = {
      langKey,
      foldFn,
      total,
      maxFreq,
      exactMap,
      foldedMap,
      wordsArr,
      foldedArr,
      freqsArr,
      lensArr,
      phonArr,
      skelArr,
      coarseArr,
      foldedBigramIndex,
      coarseMap,
      coarseBigramIndex,
      seenGen: new Uint32Array(total),
      hitCounts: new Uint16Array(total),
      genCounter: 1,
    };

    byLang.set(langKey, index);
    return index;
  }

  function nextGen(idx) {
    idx.genCounter += 1;
    if (idx.genCounter >= 0xfffffffe) {
      idx.seenGen.fill(0);
      idx.genCounter = 1;
    }
    return idx.genCounter;
  }

  function queryBigramCandidates(idx, queryStr, bigramIndex, minLen, maxLen, minShared, maxSelect) {
    const bigrams = extractBigrams(queryStr);
    if (bigrams.length === 0) return [];

    const gen = nextGen(idx);
    const seenGen = idx.seenGen;
    const hitCounts = idx.hitCounts;
    const lensArr = idx.lensArr;
    const touched = [];

    for (let b = 0; b < bigrams.length; b++) {
      const bucket = bigramIndex.get(bigrams[b]);
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const id = bucket[k];
        if (seenGen[id] !== gen) {
          seenGen[id] = gen;
          hitCounts[id] = 1;
          touched.push(id);
        } else {
          hitCounts[id] += 1;
        }
      }
    }

    const filtered = [];
    const freqWeight = maxLen <= 6 ? 16 : 8;
    const sharedWeight = maxLen <= 6 ? 9 : 12;
    for (let i = 0; i < touched.length; i++) {
      const id = touched[i];
      const len = lensArr[id];
      if (len < minLen || len > maxLen) continue;
      const shared = hitCounts[id];
      if (shared < minShared) continue;
      const rankKey = shared * sharedWeight + (idx.freqsArr[id] / idx.maxFreq) * freqWeight;
      filtered.push({ id, rankKey });
    }

    filtered.sort((a, b) => b.rankKey - a.rankKey);
    if (filtered.length > maxSelect) filtered.length = maxSelect;
    return filtered;
  }

  function queryCoarseBigramCandidates(idx, coarseQuery, minSkelLen, maxSkelLen, minShared, maxSelect) {
    const bigrams = extractBigrams(coarseQuery);
    if (bigrams.length === 0) return [];

    const gen = nextGen(idx);
    const seenGen = idx.seenGen;
    const hitCounts = idx.hitCounts;
    const coarseArr = idx.coarseArr;
    const touched = [];

    for (let b = 0; b < bigrams.length; b++) {
      const bucket = idx.coarseBigramIndex.get(bigrams[b]);
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const id = bucket[k];
        if (seenGen[id] !== gen) {
          seenGen[id] = gen;
          hitCounts[id] = 1;
          touched.push(id);
        } else {
          hitCounts[id] += 1;
        }
      }
    }

    const filtered = [];
    for (let i = 0; i < touched.length; i++) {
      const id = touched[i];
      const clen = coarseArr[id].length;
      if (clen < minSkelLen || clen > maxSkelLen) continue;
      const shared = hitCounts[id];
      if (shared < minShared) continue;
      const rankKey = shared * 14 + (idx.freqsArr[id] / idx.maxFreq) * 10 - Math.abs(clen - coarseQuery.length) * 3;
      filtered.push({ id, rankKey });
    }

    filtered.sort((a, b) => b.rankKey - a.rankKey);
    if (filtered.length > maxSelect) filtered.length = maxSelect;
    return filtered;
  }

  function isValidInSingleLexicon(cleanWord, langId, lexicon, profile, morph) {
    if (!lexicon) return false;
    const lower = langId === "tr" ? trLower(cleanWord) : cleanWord.toLowerCase();

    if (langId === "tr" && morph && typeof morph.isValidWord === "function") {
      if (morph.isValidWord(cleanWord, lexicon)) return true;
    }

    const idx = getLexiconIndex(lexicon, profile);
    if (!idx) return false;
    if (idx.exactMap.has(lower)) return true;

    if (langId !== "tr" && lower.includes("'")) {
      if (lower.endsWith("'s") && lower.length > 3 && idx.exactMap.has(lower.slice(0, -2))) {
        return true;
      }
      if (lower.endsWith("s'") && lower.length > 3 && idx.exactMap.has(lower.slice(0, -1))) {
        return true;
      }
    }

    return false;
  }

  function hasUnbundledSignal(word, profile) {
    if (!profile) return false;
    if (profile.uniqueChars) {
      for (let i = 0; i < word.length; i++) {
        if (profile.uniqueChars.includes(word[i])) return true;
      }
    }
    if (profile.stopwords && profile.stopwords.has(word.toLowerCase())) return true;
    return false;
  }

  function isWordScriptCompatible(word, script) {
    if (!word) return false;
    if (script === "cyrillic") return /[\u0400-\u04FF]/.test(word);
    if (script === "arabic") return /[\u0600-\u06FF\u0750-\u077F]/.test(word);
    if (script === "hangul") return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(word);
    if (script === "cjk") return /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(word);
    return /\p{Script=Latin}/u.test(word);
  }

  function generateLanguageCandidates(cleanWord, langId, lexicon, profile, morph, deasciifier) {
    const idx = getLexiconIndex(lexicon, profile);
    if (!idx) return { candidates: [], deasciifyStatus: "unchanged" };

    const lower = langId === "tr" ? trLower(cleanWord) : cleanWord.toLowerCase();
    const folded = idx.foldFn(lower);
    const candidates = [];
    let deasciifyStatus = "unchanged";

    // --- Turkish Specialized Generators (Deasciifier + FSM Morphology) ---
    if (langId === "tr") {
      if (deasciifier && typeof deasciifier.deasciifyWord === "function") {
        const dRes = deasciifier.deasciifyWord(cleanWord, lexicon, morph);
        deasciifyStatus = dRes.status || "unchanged";
        if (dRes.status === "unambiguous" || dRes.status === "ambiguous") {
          for (let i = 0; i < dRes.candidates.length; i++) {
            const c = dRes.candidates[i];
            const cLower = trLower(c.word);
            const freq = idx.exactMap.get(cLower) || 0;
            const baseDeasc =
              dRes.status === "unambiguous"
                ? i === 0
                  ? 0.94
                  : 0.74
                : 0.80;
            const normScore = Number(
              Math.min(0.99, baseDeasc + (freq / idx.maxFreq) * 0.05 - i * 0.03).toFixed(4)
            );
            candidates.push({
              word: c.word,
              lowerWord: cLower,
              score: normScore,
              source: "deasciify",
              lang: "tr",
              freq,
              weightedDist: 0.15,
              rawDist: 1,
            });
          }
        }
      }

      if (morph && typeof morph.generateInflectedCandidates === "function") {
        const mRes = morph.generateInflectedCandidates(cleanWord, lexicon, 6);
        const hasApo = cleanWord.includes("'");
        for (let i = 0; i < mRes.length; i++) {
          const m = mRes[i];
          const mLower = trLower(m.word);
          if (hasApo && !mLower.includes("'")) continue;
          const freq = idx.exactMap.get(mLower) || 0;
          const isColloquial = m.reason === "colloquial_repair";
          const isFoldedOnly = m.reason === "folded_morph" || m.reason === "folded_root";
          const isStrictRepair =
            isColloquial ||
            m.reason === "vowel_drop_repair" ||
            m.reason === "voicing_repair" ||
            (m.reason === "morph_repair" && !m.hasVowelRepair);
          const isAttestedHarmonyRepair =
            m.reason === "morph_repair" &&
            m.hasVowelRepair &&
            (freq >= 250 ||
              (m.twoWayHarmonyOnly &&
                typeof m.stem === "string" &&
                m.stem.length >= 4 &&
                /[çğıöşü]/.test(m.stem)));
          const isStrongRepair = isStrictRepair || isAttestedHarmonyRepair;
          const base = isColloquial
            ? 0.96
            : isFoldedOnly
              ? 0.82
              : isStrongRepair
                ? 0.79
                : m.reason === "morph_repair"
                  ? 0.62
                  : 0.60;
          const effFreq = isColloquial && freq === 0 ? 750 : freq;
          const normScore = Number(
            Math.min(0.985, base + (m.score ? Math.min(0.11, m.score * 0.08) : 0) + (effFreq / idx.maxFreq) * 0.07 - i * 0.03).toFixed(4)
          );
          candidates.push({
            word: applyCasing(mLower, cleanWord, "tr"),
            lowerWord: mLower,
            score: normScore,
            source: isColloquial ? "colloquial" : "morph",
            lang: "tr",
            freq: effFreq,
            weightedDist: isFoldedOnly || isColloquial ? 0.15 : 0.55,
            rawDist: 1,
            morphAllowAutoCorrect: isColloquial || isFoldedOnly || isStrongRepair,
          });
        }
      }

      if (morph && typeof morph.repairStandaloneSuffixChain === "function" && !cleanWord.includes("'")) {
        const chainRes = morph.repairStandaloneSuffixChain(cleanWord);
        for (const ch of chainRes) {
          const cLower = trLower(ch.word);
          candidates.push({
            word: applyCasing(cLower, cleanWord, "tr"),
            lowerWord: cLower,
            score: 0.97,
            source: "colloquial",
            lang: "tr",
            freq: 500,
            weightedDist: 0.15,
            rawDist: 1,
            morphAllowAutoCorrect: true,
          });
        }
      }
    }

    // --- G1: Exact & Diacritic-Folded Lookup ---
    const exactFoldHits = idx.foldedMap.get(folded);
    if (exactFoldHits) {
      for (let i = 0; i < Math.min(exactFoldHits.length, 4); i++) {
        const hit = exactFoldHits[i];
        if (hit.word === lower) continue;
        const score = Number(Math.min(0.95, 0.81 + (hit.freq / idx.maxFreq) * 0.14 - i * 0.03).toFixed(4));
        candidates.push({
          word: applyCasing(hit.word, cleanWord, langId),
          lowerWord: hit.word,
          score,
          source: "exact_fold",
          lang: langId,
          freq: hit.freq,
          weightedDist: 0.15,
          rawDist: 1,
        });
      }
    }

    // --- G2: Weighted Damerau-Levenshtein via Length + Bigram Inverted Index ---
    const qLen = folded.length;
    const minLen = Math.max(2, qLen - 2);
    const maxLen = qLen + 2;
    const qBigrams = extractBigrams(folded);
    const minShared = qLen <= 3 ? 1 : Math.max(1, qBigrams.length - 4);
    const g2Limit = qLen <= 4 ? 220 : 95;
    const g2Pool = queryBigramCandidates(idx, folded, idx.foldedBigramIndex, minLen, maxLen, minShared, g2Limit);

    for (let i = 0; i < g2Pool.length; i++) {
      const id = g2Pool[i].id;
      const candWord = idx.wordsArr[id];
      if (candWord === lower) continue;
      const { weightedDist, rawDist } = weightedDamerauLevenshtein(lower, candWord, idx.foldFn);
      if (weightedDist > 2.25 && rawDist > 2) continue;

      const freq = idx.freqsArr[id];
      const freqBonus = (freq / idx.maxFreq) * 0.22;
      const score = Number(Math.max(0.05, Math.min(0.97, 0.88 - weightedDist * 0.31 + freqBonus)).toFixed(4));
      candidates.push({
        word: applyCasing(candWord, cleanWord, langId),
        lowerWord: candWord,
        score,
        source: "edit",
        lang: langId,
        freq,
        weightedDist,
        rawDist,
      });
    }

    // --- G3: Cross-Lingual Phonetic Key & Fuzzy Consonant Skeleton ---
    const qPhonObj = computePhonetic(folded);
    if (qPhonObj.coarse.length >= 2) {
      const g3IdSet = new Set();
      const exactCoarse = idx.coarseMap.get(qPhonObj.coarse);
      if (exactCoarse) {
        for (let i = 0; i < exactCoarse.length; i++) g3IdSet.add(exactCoarse[i]);
      }

      if (qPhonObj.coarse.length >= 3 && g3IdSet.size < 12) {
        const cBigrams = extractBigrams(qPhonObj.coarse);
        const minCShared = qPhonObj.coarse.length <= 3 ? 1 : Math.max(1, cBigrams.length - 3);
        const fuzzyCoarse = queryCoarseBigramCandidates(
          idx,
          qPhonObj.coarse,
          Math.max(2, qPhonObj.coarse.length - 2),
          qPhonObj.coarse.length + 2,
          minCShared,
          45
        );
        for (let i = 0; i < fuzzyCoarse.length; i++) {
          g3IdSet.add(fuzzyCoarse[i].id);
        }
      }

      for (const id of g3IdSet) {
        const candWord = idx.wordsArr[id];
        if (candWord === lower) continue;
        const cPhon = idx.phonArr[id];
        const cSkel = idx.skelArr[id];

        const pDist = phoneticEditDistance(qPhonObj.phon, cPhon);
        const sDist = phoneticEditDistance(qPhonObj.skel, cSkel);
        const maxPhonLen = Math.max(qPhonObj.phon.length, cPhon.length, 1);
        const maxSkelLen = Math.max(qPhonObj.skel.length, cSkel.length, 1);

        const normPDist = pDist / maxPhonLen;
        const normSDist = sDist / maxSkelLen;
        if (normPDist > 0.52 && normSDist > 0.55) continue;

        const freq = idx.freqsArr[id];
        const freqBonus = (freq / idx.maxFreq) * 0.14;
        const lenDiffPenalty = Math.abs(qLen - idx.lensArr[id]) * 0.015;
        const score = Number(
          Math.max(0.05, Math.min(0.68, 0.62 - normPDist * 0.45 - normSDist * 0.25 + freqBonus - lenDiffPenalty)).toFixed(4)
        );
        candidates.push({
          word: applyCasing(candWord, cleanWord, langId),
          lowerWord: candWord,
          score,
          source: "phonetic",
          lang: langId,
          freq,
          weightedDist: 99,
          rawDist: 99,
        });
      }
    }

    return { candidates, deasciifyStatus };
  }

  function checkWord(params) {
    const opts = params || {};
    const rawWord = typeof opts.word === "string" ? opts.word : "";
    const autoCorrectEnabled = opts.autoCorrectEnabled !== false;
    const lexiconsByLang = opts.lexiconsByLang && typeof opts.lexiconsByLang === "object" ? opts.lexiconsByLang : {};

    const registry = resolveDep("LanguageRegistry", "./language-registry.js");
    const morph = resolveDep("TurkishMorphology", "./morphology-tr.js");
    const deasciifier = resolveDep("TurkishDeasciifier", "./deasciifier-tr.js");
    const personalModel = resolveDep("PersonalModel", "./personal-model.js");

    const normalize = registry ? registry.normalizeLang : (s) => String(s || "").trim().toLowerCase();
    const getProfile = registry
      ? registry.getProfile
      : (id) => ({ id, fold: (s) => String(s).toLowerCase(), stopwords: new Set(), uniqueChars: "" });

    const primaryId = normalize(opts.primaryLang || "tr") || "tr";
    const secondaryId = normalize(opts.secondaryLang || "");

    const activeLangs = [primaryId];
    if (secondaryId && secondaryId !== primaryId) activeLangs.push(secondaryId);

    const normLexicons = {};
    for (const key of Object.keys(lexiconsByLang)) {
      const nk = normalize(key);
      if (nk && lexiconsByLang[key]) {
        normLexicons[nk] = lexiconsByLang[key];
      }
    }

    if (isSkippedToken(rawWord, opts.context)) {
      return {
        valid: true,
        decision: "skip",
        detectedLang: primaryId,
        candidates: [],
      };
    }

    const cleanWord = normalizeApostrophes(rawWord.trim());
    const userHabits = opts.userHabits && typeof opts.userHabits === "object" ? opts.userHabits : null;
    const trLowerWord = trLower(cleanWord);
    const trFoldWord = trFold(trLowerWord);

    // 0. If user explicitly undid/dismissed this word >= 2 times, respect personal habit and treat as valid
    if (
      userHabits &&
      userHabits.ignored &&
      ((userHabits.ignored[trLowerWord] || 0) >= 2 || (userHabits.ignored[cleanWord.toLowerCase()] || 0) >= 2)
    ) {
      return {
        valid: true,
        decision: "valid",
        detectedLang: primaryId,
        candidates: [],
      };
    }

    const contextSlice = Array.isArray(opts.contextTokens) ? opts.contextTokens.slice(-12) : opts.contextTokens || [];
    const prevContextToken =
      Array.isArray(contextSlice) && contextSlice.length > 0 ? contextSlice[contextSlice.length - 1] : "";
    const domain = String(opts.context?.domain || opts.domain || "").trim().toLowerCase();

    const guess = registry
      ? registry.detectContextLanguage(contextSlice, primaryId, secondaryId, normLexicons)
      : { primary: primaryId, orderedLangs: activeLangs, scores: { [primaryId]: 0.25 } };

    const orderedActive = [];
    for (const l of guess.orderedLangs) {
      if (activeLangs.includes(l) && !orderedActive.includes(l)) orderedActive.push(l);
    }
    for (const l of activeLangs) {
      if (!orderedActive.includes(l)) orderedActive.push(l);
    }

    const activeWithLexicon = orderedActive.filter((l) => Boolean(normLexicons[l]));

    if (activeWithLexicon.length === 0) {
      return {
        valid: true,
        decision: "valid",
        detectedLang: guess.primary || primaryId,
        candidates: [],
      };
    }

    // Pre-check if Turkish deasciifier has an unambiguous diacritic restoration or a genuine 5+ char homograph twin
    let preDeascTr = null;
    let trHomographAlts = null;
    if (
      activeWithLexicon.includes("tr") &&
      normLexicons.tr &&
      deasciifier &&
      typeof deasciifier.deasciifyWord === "function" &&
      !/[çğıöşüâîûÇĞİÖŞÜÂÎÛ]/.test(cleanWord)
    ) {
      const dRes = deasciifier.deasciifyWord(cleanWord, normLexicons.tr, morph);
      const trIdx = getLexiconIndex(normLexicons.tr, getProfile("tr"));
      if (dRes && dRes.status === "unambiguous" && dRes.candidates && dRes.candidates.length > 0) {
        const topTrWord = trLower(dRes.candidates[0].word);
        const trFreq = (trIdx && trIdx.exactMap.get(topTrWord)) || 0;
        preDeascTr = { dRes, topTrWord, trFreq };
      } else if (
        dRes &&
        dRes.status === "homograph_kept" &&
        cleanWord.length >= 5 &&
        !(trLowerWord.startsWith("ol")) &&
        !/^m[iıuü]/.test(trLowerWord)
      ) {
        const filteredAlts = (dRes.candidates || []).filter((c) => {
          const cLow = trLower(c.word);
          if (cLow === trLowerWord) return false;
          // Skip circumflex-only spelling variants (e.g., herhalde/herhâlde, tabii/tabiî)
          const noCirc = cLow.replace(/â/g, "a").replace(/î/g, "i").replace(/û/g, "u");
          if (noCirc === trLowerWord) return false;
          const altFreq = (trIdx && trIdx.exactMap.get(cLow)) || 0;
          return altFreq >= 280;
        });
        if (filteredAlts.length > 0) {
          trHomographAlts = filteredAlts;
        }
      }
    }

    const hasStrongEnContext =
      Array.isArray(contextSlice) &&
      contextSlice.length >= 2 &&
      (guess.scores.en ?? 0) - (guess.scores.tr ?? 0) >= 1.5;

    const COLLOQUIAL_TR_KEYS = new Set([
      "bikac", "bisi", "bisey", "birsey", "bisiler", "biseyler", "birseyler",
      "hersey", "hicbi", "hicbisi", "hicbirsey", "bitakim", "heralde", "galba",
      "yalnis", "yanliz", "noldu", "nolur", "noluyo", "noluyor", "napiyon", "napiyosun", "napiyom"
    ]);
    const isColloquialTrKey = activeWithLexicon.includes("tr") && COLLOQUIAL_TR_KEYS.has(trFoldWord);

    // 1. Check if word is valid in ANY active configured language (bilingual code-switching)
    for (const langId of activeWithLexicon) {
      const profile = getProfile(langId);
      if (isValidInSingleLexicon(cleanWord, langId, normLexicons[langId], profile, morph)) {
        if (langId === "tr" && (preDeascTr || isColloquialTrKey)) {
          continue;
        }
        if (langId === "tr" && trHomographAlts && trHomographAlts.length > 0) {
          const cands = [
            { word: cleanWord, score: 0.90, source: "homograph", lang: "tr" },
            ...trHomographAlts.slice(0, 4).map((a, idx) => ({
              word: a.word,
              score: Number((0.88 - idx * 0.03).toFixed(4)),
              source: "deasciify",
              lang: "tr",
            })),
          ];
          return {
            valid: false,
            decision: "uncertain",
            detectedLang: "tr",
            candidates: cands,
          };
        }
        // - Or in a secondary language when Turkish is the active context/primary language and the Turkish
        //   diacritic word is higher-frequency than the secondary-language homograph (e.g. gore -> göre, boyle -> böyle, gun -> gün, once -> önce)
        if (langId !== "tr" && preDeascTr && preDeascTr.trFreq >= 420) {
          const secIdx = getLexiconIndex(normLexicons[langId], profile);
          const secFreq = (secIdx && secIdx.exactMap.get(cleanWord.toLowerCase())) || 0;
          if (guess.primary === "tr" && preDeascTr.trFreq > secFreq) {
            continue;
          }
          if (cleanWord.length >= 4 && preDeascTr.trFreq >= 500 && !hasStrongEnContext) {
            return {
              valid: false,
              decision: "uncertain",
              detectedLang: langId,
              candidates: [
                { word: preDeascTr.dRes.candidates[0].word, score: 0.89, source: "deasciify", lang: "tr" },
                { word: cleanWord, score: 0.88, source: "homograph", lang: langId },
              ],
            };
          }
        }
        return {
          valid: true,
          decision: "valid",
          detectedLang: langId,
          candidates: [],
        };
      }
    }

    // 1b. Foreign / Proper-Noun Stem + Turkish Apostrophe Suffix (e.g. Hogwarts'i -> Hogwarts'ı, Google'da -> valid)
    const apoIdx = cleanWord.indexOf("'");
    if (
      apoIdx > 0 &&
      apoIdx < cleanWord.length - 1 &&
      activeWithLexicon.includes("tr") &&
      morph &&
      typeof morph.analyzeOrRepairForeignApostrophe === "function"
    ) {
      const rawStem = cleanWord.slice(0, apoIdx);
      const rawSuffix = cleanWord.slice(apoIdx + 1);
      const stemHasTrDeasc =
        deasciifier &&
        typeof deasciifier.deasciifyWord === "function" &&
        deasciifier.deasciifyWord(rawStem, normLexicons.tr, morph).status !== "unchanged";
      const isKnownStem = activeWithLexicon.some((lid) =>
        isValidInSingleLexicon(rawStem, lid, normLexicons[lid], getProfile(lid), morph)
      );
      const isCapitalizedProper = /^\p{Lu}/u.test(rawStem) && rawStem.length >= 2;
      if (!stemHasTrDeasc && (isKnownStem || isCapitalizedProper || (guess.primary === "tr" && rawStem.length >= 3))) {
        const apoRes = morph.analyzeOrRepairForeignApostrophe(rawStem, rawSuffix);
        if (apoRes.valid) {
          return {
            valid: true,
            decision: "valid",
            detectedLang: "tr",
            candidates: [],
          };
        }
        if (apoRes.candidates && apoRes.candidates.length > 0) {
          const topApo = apoRes.candidates[0];
          const secondApo = apoRes.candidates[1] || null;
          const mappedCands = apoRes.candidates.slice(0, 5).map((c) => ({
            word: `${rawStem}'${c.suffix}`,
            score: c.score,
            source: "morph",
            lang: "tr",
          }));
          const canAuto =
            autoCorrectEnabled &&
            (topApo.pureFold || topApo.score >= 0.84) &&
            (!secondApo || topApo.score - secondApo.score >= 0.04);
          if (canAuto) {
            return {
              valid: false,
              decision: "auto_correct",
              detectedLang: "tr",
              replacement: mappedCands[0].word,
              candidates: mappedCands,
            };
          }
          return {
            valid: false,
            decision: "uncertain",
            detectedLang: "tr",
            candidates: mappedCands,
          };
        }
      }
    }

    // 2. Guard for active unbundled languages
    for (const langId of orderedActive) {
      if (!normLexicons[langId]) {
        const prof = getProfile(langId);
        if (hasUnbundledSignal(cleanWord, prof)) {
          return {
            valid: true,
            decision: "valid",
            detectedLang: langId,
            candidates: [],
          };
        }
      }
    }
    if (!normLexicons[guess.primary] && activeWithLexicon.length > 0) {
      const guessProfile = getProfile(guess.primary);
      if (
        activeLangs.includes(guess.primary) &&
        isWordScriptCompatible(cleanWord, guessProfile.script)
      ) {
        const bestBundledScore = Math.max(...activeWithLexicon.map((l) => guess.scores[l] ?? 0));
        if ((guess.scores[guess.primary] ?? 0) > bestBundledScore + 1.0) {
          return {
            valid: true,
            decision: "valid",
            detectedLang: guess.primary,
            candidates: [],
          };
        }
      }
    }

    // 3. Collect candidates across active languages with lexicons
    const hasContext = Array.isArray(contextSlice)
      ? contextSlice.length > 0
      : typeof contextSlice === "string" && contextSlice.trim().length > 0;
    const primaryScore = guess.scores[guess.primary] ?? 0;
    const guessPrimaryProfile = getProfile(guess.primary);
    const isGuessPrimaryActiveAndCompatible =
      activeLangs.includes(guess.primary) &&
      isWordScriptCompatible(cleanWord, guessPrimaryProfile.script);
    const hasStrongContextWinner =
      hasContext &&
      isGuessPrimaryActiveAndCompatible &&
      orderedActive.length > 1 &&
      primaryScore - (guess.scores[orderedActive[1]] ?? 0) >= 1.5;

    const allCandidates = [];
    let trDeasciifyStatus = "unchanged";

    for (const langId of activeWithLexicon) {
      const profile = getProfile(langId);
      const res = generateLanguageCandidates(
        cleanWord,
        langId,
        normLexicons[langId],
        profile,
        morph,
        deasciifier
      );
      if (langId === "tr") {
        trDeasciifyStatus = res.deasciifyStatus;
      }

      for (const c of res.candidates) {
        let langBias = 0;
        if (hasStrongContextWinner) {
          if (langId !== guess.primary) {
            const isFoldedDiacriticMatch =
              c.source === "deasciify" ||
              c.source === "exact_fold" ||
              profile.fold(cleanWord) === profile.fold(c.lowerWord);
            if (!activeLangs.includes(langId) || isFoldedDiacriticMatch) {
              langBias = -0.32;
            } else {
              langBias = -0.03;
            }
          }
        } else if (langId === primaryId) {
          langBias = 0.025;
        }
        let habitBonus = 0;
        if (userHabits) {
          if (userHabits.wordCounts) {
            const uCount = Number(userHabits.wordCounts[c.lowerWord]) || 0;
            if (uCount > 0) {
              habitBonus += Math.min(0.10, Math.log2(uCount + 1) * 0.035);
            }
          }
          if (personalModel) {
            if (prevContextToken) {
              habitBonus += personalModel.scoreBigram(prevContextToken, c.lowerWord, userHabits);
            }
            if (domain) {
              habitBonus += personalModel.scoreDomain(domain, c.lowerWord, userHabits);
            }
            if (c.source === "edit" || c.source === "morph" || c.source === "phonetic" || c.source === "deasciify") {
              habitBonus += personalModel.scoreCharHabit(cleanWord, c.lowerWord, userHabits);
            }
          }
        }
        const baseClamped = Math.max(0.01, Math.min(0.995, c.score + langBias));
        allCandidates.push({
          ...c,
          habitBonus,
          score: Number((baseClamped + habitBonus).toFixed(4)),
        });
      }
    }

    // Inject personal learned typo -> target mappings from userHabits.corrections
    if (userHabits && userHabits.corrections) {
      const corrBucket =
        userHabits.corrections[trLowerWord] ||
        userHabits.corrections[cleanWord.toLowerCase()] ||
        userHabits.corrections[trFoldWord] ||
        null;
      if (corrBucket && typeof corrBucket === "object") {
        const entries = Object.entries(corrBucket)
          .filter(([target, cnt]) => target && target !== trLowerWord && Number(cnt) >= 1)
          .sort((a, b) => Number(b[1]) - Number(a[1]));
        for (let i = 0; i < Math.min(entries.length, 2); i++) {
          const [targetLower, cnt] = entries[i];
          const targetLang = guess.primary || primaryId;
          allCandidates.push({
            word: applyCasing(targetLower, cleanWord, targetLang),
            lowerWord: targetLower,
            score: Number((1.05 + Math.min(0.05, Number(cnt) * 0.01) - i * 0.03).toFixed(4)),
            source: "user_habit",
            lang: targetLang,
            freq: 900,
            weightedDist: 0.1,
            rawDist: 1,
          });
        }
      }
    }

    const SOURCE_PRIORITY = { user_habit: 7, colloquial: 6, deasciify: 5, morph: 4, exact_fold: 3, edit: 2, phonetic: 1 };
    const dedupMap = new Map();
    for (const c of allCandidates) {
      const key = `${c.lang}:${c.lowerWord}`;
      const prev = dedupMap.get(key);
      if (!prev) {
        dedupMap.set(key, c);
      } else {
        const betterScore = c.score > prev.score + 0.005;
        const tiedBetterSource =
          Math.abs(c.score - prev.score) <= 0.005 &&
          (SOURCE_PRIORITY[c.source] || 0) > (SOURCE_PRIORITY[prev.source] || 0);
        if (betterScore || tiedBetterSource) {
          const minW = Math.min(c.weightedDist, prev.weightedDist);
          const minR = Math.min(c.rawDist, prev.rawDist);
          const keepPrevSource =
            prev.source === "user_habit" ||
            (prev.source === "deasciify" && c.source !== "user_habit" && c.source !== "colloquial") ||
            (c.source === "phonetic" && prev.source !== "phonetic" && prev.score >= c.score - 0.05) ||
            (prev.source === "morph" && c.source === "edit" && prev.score >= c.score - 0.04);
          dedupMap.set(key, {
            ...c,
            weightedDist: minW,
            rawDist: minR,
            source: keepPrevSource ? prev.source : c.source,
            morphAllowAutoCorrect: c.morphAllowAutoCorrect ?? prev.morphAllowAutoCorrect,
          });
        } else {
          prev.weightedDist = Math.min(prev.weightedDist, c.weightedDist);
          prev.rawDist = Math.min(prev.rawDist, c.rawDist);
          if (
            c.source === "deasciify" ||
            ((SOURCE_PRIORITY[c.source] || 0) > (SOURCE_PRIORITY[prev.source] || 0) && c.score >= prev.score - 0.04)
          ) {
            prev.source = c.source;
          }
          if (c.morphAllowAutoCorrect !== undefined && prev.morphAllowAutoCorrect === undefined) {
            prev.morphAllowAutoCorrect = c.morphAllowAutoCorrect;
          }
        }
      }
    }

    const ranked = Array.from(dedupMap.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.freq || 0) - (a.freq || 0);
    });

    const top5 = ranked.slice(0, 5).map((c) => ({
      word: c.word,
      score: c.score,
      source: c.source,
      lang: c.lang,
    }));

    if (ranked.length === 0) {
      return {
        valid: false,
        decision: "uncertain",
        detectedLang: guess.primary || primaryId,
        candidates: [],
      };
    }

    const top = ranked[0];
    const second = ranked.length > 1 ? ranked[1] : null;
    const sameLangCompetitor = ranked.find((c, idx) => idx > 0 && c.lang === top.lang) || null;
    const margin = second ? top.score - second.score : 1.0;
    const sameLangMargin = sameLangCompetitor ? top.score - sameLangCompetitor.score : 1.0;

    let allowAutoCorrect = false;
    if (autoCorrectEnabled) {
      let contextConflict = false;
      if (hasStrongContextWinner && top.lang !== guess.primary) {
        if (!activeLangs.includes(top.lang) || top.source === "deasciify" || top.source === "exact_fold") {
          contextConflict = true;
        } else {
          const primaryCompetitor = ranked.find(
            (c) => c.lang === guess.primary && c.source !== "phonetic"
          );
          if (primaryCompetitor && top.score - primaryCompetitor.score <= 0.15) {
            const clearHighConfEdit =
              top.source === "edit" &&
              top.weightedDist <= 0.55 &&
              top.score >= 0.85 &&
              top.score - primaryCompetitor.score >= 0.05;
            if (!clearHighConfEdit) {
              contextConflict = true;
            }
          }
        }
      }
      if (!contextConflict) {
        const topUserCount = Number(userHabits?.wordCounts?.[top.lowerWord]) || 0;
        const secondUserCount = second ? Number(userHabits?.wordCounts?.[second.lowerWord]) || 0 : 0;
        const topPersonalScore = top.habitBonus || 0;
        const secondPersonalScore = second?.habitBonus || 0;
        const userHabitTieBreaker =
          ((topUserCount >= 1 && topUserCount > secondUserCount) ||
            (topPersonalScore >= 0.04 && topPersonalScore > secondPersonalScore + 0.02)) &&
          margin >= 0.02;

        if (top.source === "user_habit" || top.source === "colloquial") {
          allowAutoCorrect = margin >= 0.005;
        } else if (top.source === "deasciify") {
          allowAutoCorrect = (trDeasciifyStatus === "unambiguous" && margin >= 0.02) || userHabitTieBreaker;
        } else if (top.source === "morph") {
          const weakOrZeroCompetitor = !sameLangCompetitor || (sameLangCompetitor.freq || 0) === 0;
          allowAutoCorrect =
            top.morphAllowAutoCorrect !== false &&
            top.score >= 0.78 &&
            (margin >= 0.04 || (weakOrZeroCompetitor && margin >= 0.02) || userHabitTieBreaker);
        } else if (top.source === "exact_fold") {
          allowAutoCorrect = top.score >= 0.80 && (margin >= 0.05 || userHabitTieBreaker);
        } else if (top.source === "edit") {
          const isHighFreqTransposition =
            top.weightedDist <= 0.50 &&
            top.rawDist <= 2 &&
            top.score >= 0.90 &&
            (top.freq || 0) >= 650 &&
            (!sameLangCompetitor || (top.freq || 0) - (sameLangCompetitor.freq || 0) >= 50);
          const isFreqDominant =
            top.weightedDist <= 0.70 &&
            top.rawDist <= 2 &&
            (top.freq || 0) >= 250 &&
            (!sameLangCompetitor ||
              (sameLangCompetitor.freq || 0) === 0 ||
              (top.freq || 0) - (sameLangCompetitor.freq || 0) >= 120);
          const minSameLangMargin = userHabitTieBreaker
            ? 0.02
            : isFreqDominant
              ? 0.025
              : isHighFreqTransposition
                ? 0.035
                : 0.08;
          const minMargin = userHabitTieBreaker
            ? 0.02
            : isFreqDominant
              ? 0.025
              : isHighFreqTransposition
                ? 0.035
                : 0.05;
          allowAutoCorrect =
            top.weightedDist <= 1.15 &&
            top.rawDist <= 2 &&
            top.score >= 0.70 &&
            ((top.freq || 0) >= 250 || topUserCount >= 1) &&
            sameLangMargin >= minSameLangMargin &&
            margin >= minMargin;
        } else if (top.source === "phonetic" && userHabitTieBreaker && top.score >= 0.65) {
          allowAutoCorrect = true;
        }
      }
    }

    if (allowAutoCorrect) {
      return {
        valid: false,
        decision: "auto_correct",
        detectedLang: top.lang,
        replacement: top.word,
        candidates: top5,
      };
    }

    return {
      valid: false,
      decision: "uncertain",
      detectedLang: top.lang || guess.primary || primaryId,
      candidates: top5,
    };
  }

  const SpellcheckEngine = {
    isSkippedToken,
    checkWord,
    computePhonetic,
    weightedDamerauLevenshtein,
    _clearCache: () => {},
  };

  NS.SpellcheckEngine = SpellcheckEngine;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SpellcheckEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

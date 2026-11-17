(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

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

  function applyCasing(targetLower, original) {
    if (!original || !targetLower) return targetLower;
    if (original.length >= 2 && original === trUpper(original)) {
      return trUpper(targetLower);
    }
    const first = original[0];
    if (first === trUpper(first) && first !== trLower(first)) {
      return trUpper(targetLower[0]) + targetLower.slice(1);
    }
    return targetLower;
  }

  const INDEX_CACHE = new WeakMap();

  function getDeasciifierIndex(trLexicon) {
    if (!trLexicon || typeof trLexicon !== "object") {
      return { foldedWords: new Map(), foldedRoots: new Map() };
    }
    let idx = INDEX_CACHE.get(trLexicon);
    if (idx) return idx;

    const foldedWords = new Map();
    const words = trLexicon.words || {};
    for (const w of Object.keys(words)) {
      const f = trFold(w);
      let arr = foldedWords.get(f);
      if (!arr) {
        arr = [];
        foldedWords.set(f, arr);
      }
      arr.push({ word: w, freq: words[w] || 0 });
    }
    for (const arr of foldedWords.values()) {
      arr.sort((a, b) => b.freq - a.freq);
    }

    const foldedRoots = new Map();
    const roots = trLexicon.roots || {};
    for (const r of Object.keys(roots)) {
      const f = trFold(r);
      let arr = foldedRoots.get(f);
      if (!arr) {
        arr = [];
        foldedRoots.set(f, arr);
      }
      arr.push(r);
    }

    idx = { foldedWords, foldedRoots };
    INDEX_CACHE.set(trLexicon, idx);
    return idx;
  }

  function isValidTurkish(lowerWord, trLexicon, morph) {
    if (morph && typeof morph.isValidWord === "function") {
      if (morph.isValidWord(lowerWord, trLexicon)) return true;
    }
    if (trLexicon) {
      if (trLexicon.roots && Object.prototype.hasOwnProperty.call(trLexicon.roots, lowerWord)) {
        return true;
      }
      if (trLexicon.words && Object.prototype.hasOwnProperty.call(trLexicon.words, lowerWord)) {
        return true;
      }
    }
    return false;
  }

  function deasciifyWord(word, trLexicon, morphology) {
    if (!word || typeof word !== "string") {
      return { status: "unchanged", candidates: [] };
    }
    const trimmed = word.trim();
    if (!trimmed || !/^[a-zA-ZçğıöşüÇĞİÖŞÜâîûÂÎÛ]+(?:'[a-zA-ZçğıöşüÇĞİÖŞÜâîûÂÎÛ]+)?$/.test(trimmed)) {
      return { status: "unchanged", candidates: [] };
    }

    const morph = morphology || NS.TurkishMorphology || null;
    const lower = trLower(trimmed);
    const folded = trFold(lower);
    const hasDiacritics = /[çğıöşüâîûÇĞİÖŞÜÂÎÛ]/.test(trimmed);
    const idx = getDeasciifierIndex(trLexicon);

    const currentlyValid = isValidTurkish(lower, trLexicon, morph);
    if (currentlyValid && hasDiacritics) {
      return { status: "unchanged", candidates: [] };
    }

    // Collect all valid Turkish forms that fold to the exact same ASCII string
    const candMap = new Map(); // candLower -> { word, freq, score, isRoot }

    const addCand = (candLower, baseScore) => {
      if (!candLower) return;
      if (trFold(candLower) !== folded) return;
      const freq = trLexicon && trLexicon.words && trLexicon.words[candLower] ? trLexicon.words[candLower] : 0;
      const isRoot = Boolean(trLexicon && trLexicon.roots && Object.prototype.hasOwnProperty.call(trLexicon.roots, candLower));
      const score = Number((baseScore + freq / 1000 + (isRoot ? 0.08 : 0)).toFixed(4));
      const prev = candMap.get(candLower);
      if (!prev || score > prev.score) {
        candMap.set(candLower, { word: candLower, freq, score, isRoot });
      }
    };

    const wordHits = idx.foldedWords.get(folded);
    if (wordHits) {
      for (const h of wordHits) {
        addCand(h.word, 0.75);
      }
    }

    const rootHits = idx.foldedRoots.get(folded);
    if (rootHits) {
      for (const r of rootHits) {
        addCand(r, 0.8);
      }
    }

    if (
      morph &&
      typeof morph.generateInflectedCandidates === "function" &&
      !hasDiacritics
    ) {
      const morphCands = morph.generateInflectedCandidates(lower, trLexicon, 12, { foldedOnly: true });
      for (const mc of morphCands) {
        if (trFold(mc.word) === folded) {
          addCand(mc.word, 0.7 + (mc.score || 0) * 0.15);
        }
      }
    }

    // Handle apostrophe proper noun restoration if missed (e.g. Turkiye'de -> Türkiye'de)
    const apoIdx = lower.indexOf("'");
    if (apoIdx > 0 && candMap.size === 0 && morph && typeof morph.isValidWord === "function") {
      const preFold = folded.slice(0, apoIdx);
      const postFold = folded.slice(apoIdx + 1);
      const preRoots = idx.foldedRoots.get(preFold) || [];
      for (const pr of preRoots) {
        // Try standard apostrophe suffix restoration via folded roots
        const postCands = [postFold];
        const postAlt = postFold
          .replace(/i/g, "ı")
          .replace(/u/g, "ü");
        if (postAlt !== postFold) postCands.push(postAlt);
        for (const pc of postCands) {
          const joined = `${pr}'${pc}`;
          if (morph.isValidWord(joined, trLexicon)) {
            addCand(joined, 0.85);
          }
        }
      }
    }

    const sortedAll = Array.from(candMap.values()).sort((a, b) => {
      if (b.freq !== a.freq) return b.freq - a.freq;
      if (b.isRoot !== a.isRoot) return (b.isRoot ? 1 : 0) - (a.isRoot ? 1 : 0);
      return b.score - a.score;
    });

    // Pure ASCII word that passed morphological/root check, yet has a dominant diacritic twin
    // (e.g. degil -> değil, simdi -> şimdi, baska -> başka, kotu -> kötü, kisi -> kişi, aksam -> akşam, kopek -> köpek)
    const asciiFreq = trLexicon && trLexicon.words && trLexicon.words[lower] ? trLexicon.words[lower] : 0;
    const alternatives = sortedAll.filter((c) => c.word !== lower);
    const dominantDiacriticOverride =
      !hasDiacritics &&
      alternatives.length > 0 &&
      (lower.length >= 4 || lower === "tum" || lower === "dun") &&
      alternatives[0].freq >= 435 &&
      alternatives[0].freq - asciiFreq >= 175 &&
      (alternatives.length === 1 ||
        alternatives[1].freq === 0 ||
        alternatives[0].freq - alternatives[1].freq >= 150);

    // If input word is ALREADY a valid Turkish word (and not overridden by a dominant diacritic form):
    if (currentlyValid && !dominantDiacriticOverride) {
      if (hasDiacritics) {
        return { status: "unchanged", candidates: [] };
      }
      // Pure ASCII valid Turkish word: check if diacritic-restored homographs exist
      if (alternatives.length > 0) {
        return {
          status: "homograph_kept",
          candidates: sortedAll.map((c) => ({
            word: applyCasing(c.word, trimmed),
            score: c.score,
          })),
        };
      }
      return { status: "unchanged", candidates: [] };
    }

    // Input is NOT valid as-is: evaluate diacritic-restored candidates
    const restorations = sortedAll.filter((c) => c.word !== lower);
    if (restorations.length === 0) {
      return { status: "unchanged", candidates: [] };
    }

    const formatted = restorations.map((c) => ({
      word: applyCasing(c.word, trimmed),
      score: c.score,
    }));

    if (restorations.length === 1) {
      return { status: "unambiguous", candidates: formatted };
    }

    // Multiple valid diacritic targets exist (e.g., uc -> uç / üç, soyle -> söyle / şöyle):
    // Auto-resolve as unambiguous when:
    // 1) #1 is an attested corpus word (freq > 0) and #2 has 0 corpus occurrences (unattested/archaic/synthetic), OR
    // 2) #1 is a dictionary root while #2 is not a root and has low frequency (< 220), OR
    // 3) #1 strongly dominates #2 by corpus frequency.
    const top = restorations[0];
    const second = restorations[1];
    if (
      (top.freq > 0 && second.freq === 0) ||
      (top.isRoot && !second.isRoot && second.freq < 220) ||
      (top.freq >= 300 && second.freq < 220 && top.freq - second.freq >= 100) ||
      (top.freq >= 400 && top.freq - second.freq >= 195)
    ) {
      return { status: "unambiguous", candidates: formatted };
    }

    return { status: "ambiguous", candidates: formatted };
  }

  const TurkishDeasciifier = {
    deasciifyWord,
    trLower,
    trUpper,
    trFold,
  };

  NS.TurkishDeasciifier = TurkishDeasciifier;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TurkishDeasciifier;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

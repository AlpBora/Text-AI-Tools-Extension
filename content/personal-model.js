(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

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

  function ensureHabitsShape(habits) {
    if (!habits || typeof habits !== "object") {
      return {
        corrections: Object.create(null),
        wordCounts: Object.create(null),
        ignored: Object.create(null),
        bigrams: Object.create(null),
        domainCounts: Object.create(null),
        charEdits: Object.create(null),
      };
    }
    if (!habits.corrections || typeof habits.corrections !== "object") habits.corrections = Object.create(null);
    if (!habits.wordCounts || typeof habits.wordCounts !== "object") habits.wordCounts = Object.create(null);
    if (!habits.ignored || typeof habits.ignored !== "object") habits.ignored = Object.create(null);
    if (!habits.bigrams || typeof habits.bigrams !== "object") habits.bigrams = Object.create(null);
    if (!habits.domainCounts || typeof habits.domainCounts !== "object") habits.domainCounts = Object.create(null);
    if (!habits.charEdits || typeof habits.charEdits !== "object") habits.charEdits = Object.create(null);
    return habits;
  }

  /**
   * Extracts minimal character-level edit operations transforming `orig` -> `target`.
   * Operations:
   *  - `sub:a>b` (substitution)
   *  - `del:b`   (user omitted character `b`)
   *  - `ins:a`   (user inserted extra character `a`)
   *  - `swap:ab` (adjacent transposition `ab` -> `ba`)
   */
  function extractEditOps(rawOrig, rawTarget) {
    const a = trLower(rawOrig);
    const b = trLower(rawTarget);
    if (!a || !b || a === b) return [];
    if (a.length > 28 || b.length > 28 || Math.abs(a.length - b.length) > 4) return [];

    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let best = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          best = Math.min(best, dp[i - 2][j - 2] + 1);
        }
        dp[i][j] = best;
      }
    }

    if (dp[m][n] === 0 || dp[m][n] > 4) return [];

    const ops = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
        i--;
        j--;
      } else if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1] &&
        dp[i][j] === dp[i - 2][j - 2] + 1
      ) {
        ops.push(`swap:${a[i - 2]}${a[i - 1]}`);
        i -= 2;
        j -= 2;
      } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
        ops.push(`sub:${a[i - 1]}>${b[j - 1]}`);
        i--;
        j--;
      } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
        ops.push(`del:${b[j - 1]}`);
        j--;
      } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
        ops.push(`ins:${a[i - 1]}`);
        i--;
      } else {
        break;
      }
    }
    return ops;
  }

  function learnCharEdits(habits, origWord, targetWord, weight = 1) {
    const h = ensureHabitsShape(habits);
    const ops = extractEditOps(origWord, targetWord);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const nextVal = (Number(h.charEdits[op]) || 0) + weight;
      if (nextVal <= 0) {
        delete h.charEdits[op];
      } else {
        h.charEdits[op] = Number(Math.min(500, nextVal).toFixed(2));
      }
    }
    return ops;
  }

  function recordBigram(habits, prevWord, nextWord, weight = 1) {
    const h = ensureHabitsShape(habits);
    const prev = trLower(prevWord);
    const next = trLower(nextWord);
    if (!prev || !next || prev.length < 2 || next.length < 2) return;
    if (!h.bigrams[prev] || typeof h.bigrams[prev] !== "object") {
      h.bigrams[prev] = Object.create(null);
    }
    h.bigrams[prev][next] = Math.min(500, (Number(h.bigrams[prev][next]) || 0) + weight);
  }

  function recordDomainWord(habits, domain, word, weight = 1) {
    const h = ensureHabitsShape(habits);
    const dom = String(domain || "").trim().toLowerCase();
    const w = trLower(word);
    if (!dom || !w || w.length < 2) return;
    if (!h.domainCounts[dom] || typeof h.domainCounts[dom] !== "object") {
      h.domainCounts[dom] = Object.create(null);
    }
    h.domainCounts[dom][w] = Math.min(500, (Number(h.domainCounts[dom][w]) || 0) + weight);
  }

  function scoreCharHabit(inputWord, candidateWord, habits) {
    if (!habits || !habits.charEdits) return 0;
    const ops = extractEditOps(inputWord, candidateWord);
    if (ops.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < ops.length; i++) {
      const cnt = Number(habits.charEdits[ops[i]]) || 0;
      if (cnt > 0) {
        total += Math.min(0.055, Math.log2(cnt + 1) * 0.018);
      }
    }
    return Math.min(0.11, total);
  }

  function scoreBigram(prevWord, candidateWord, habits) {
    if (!habits || !habits.bigrams || !prevWord || !candidateWord) return 0;
    const prev = trLower(prevWord);
    const cand = trLower(candidateWord);
    const bucket = habits.bigrams[prev];
    if (!bucket || typeof bucket !== "object") return 0;
    const cnt = Number(bucket[cand]) || 0;
    if (cnt <= 0) return 0;
    return Math.min(0.12, Math.log2(cnt + 1) * 0.04);
  }

  function scoreDomain(domain, candidateWord, habits) {
    if (!habits || !habits.domainCounts || !domain || !candidateWord) return 0;
    const dom = String(domain).trim().toLowerCase();
    const cand = trLower(candidateWord);
    const bucket = habits.domainCounts[dom];
    if (!bucket || typeof bucket !== "object") return 0;
    const cnt = Number(bucket[cand]) || 0;
    if (cnt <= 0) return 0;
    return Math.min(0.08, Math.log2(cnt + 1) * 0.028);
  }

  function pruneTopEntries(obj, limit) {
    if (!obj || typeof obj !== "object") return {};
    const entries = Object.entries(obj);
    if (entries.length <= limit) return { ...obj };
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    const out = {};
    for (let i = 0; i < limit; i++) {
      out[entries[i][0]] = entries[i][1];
    }
    return out;
  }

  function pruneHabits(habits) {
    const h = ensureHabitsShape(habits);

    const prunedBigrams = {};
    const bigramKeys = Object.keys(h.bigrams).slice(-350);
    for (const k of bigramKeys) {
      prunedBigrams[k] = pruneTopEntries(h.bigrams[k], 8);
    }

    const prunedDomains = {};
    const domEntries = Object.entries(h.domainCounts).slice(-25);
    for (const [dom, map] of domEntries) {
      prunedDomains[dom] = pruneTopEntries(map, 150);
    }

    return {
      corrections: { ...h.corrections },
      wordCounts: pruneTopEntries(h.wordCounts, 1200),
      ignored: pruneTopEntries(h.ignored, 250),
      bigrams: prunedBigrams,
      domainCounts: prunedDomains,
      charEdits: pruneTopEntries(h.charEdits, 120),
    };
  }

  const PersonalModel = {
    extractEditOps,
    learnCharEdits,
    recordBigram,
    recordDomainWord,
    scoreCharHabit,
    scoreBigram,
    scoreDomain,
    pruneHabits,
  };

  NS.PersonalModel = PersonalModel;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = PersonalModel;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

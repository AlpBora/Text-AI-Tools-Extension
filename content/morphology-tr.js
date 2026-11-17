(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

  const VOWELS = new Set(["a", "e", "ı", "i", "o", "ö", "u", "ü", "â", "î", "û"]);
  const FRONT_VOWELS = new Set(["e", "i", "ö", "ü", "î"]);
  const ROUNDED_VOWELS = new Set(["o", "ö", "u", "ü", "û"]);
  const VOICELESS = new Set(["f", "s", "t", "k", "ç", "ş", "h", "p"]);
  const SOFTEN_MAP = { p: "b", ç: "c", t: "d", k: "ğ" };
  const UNSOFTEN_MAP = { b: "p", c: "ç", d: "t", ğ: "k" };

  function trLower(str) {
    return String(str)
      .normalize("NFC")
      .replace(/İ/g, "i")
      .replace(/I/g, "ı")
      .toLowerCase()
      .replace(/i\u0307/g, "i")
      .normalize("NFC");
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

  function countVowels(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      if (VOWELS.has(str[i])) n++;
    }
    return n;
  }

  function getLastVowel(str) {
    for (let i = str.length - 1; i >= 0; i--) {
      if (VOWELS.has(str[i])) return str[i];
    }
    return "e";
  }

  function getPrevVowelBeforeLast(str) {
    let seenLast = false;
    for (let i = str.length - 1; i >= 0; i--) {
      if (VOWELS.has(str[i])) {
        if (!seenLast) seenLast = true;
        else return str[i];
      }
    }
    return getLastVowel(str);
  }

  function isFrontVowel(v, inverseHarmony) {
    if (inverseHarmony) {
      if (v === "a" || v === "o" || v === "u" || v === "â" || v === "û") return true;
    }
    return FRONT_VOWELS.has(v);
  }

  function isRoundedVowel(v) {
    return ROUNDED_VOWELS.has(v);
  }

  function harmony2(lastVowel, inverseHarmony) {
    return isFrontVowel(lastVowel, inverseHarmony) ? "e" : "a";
  }

  function harmony4(lastVowel, inverseHarmony) {
    const front = isFrontVowel(lastVowel, inverseHarmony);
    const round = isRoundedVowel(lastVowel);
    if (front) return round ? "ü" : "i";
    return round ? "u" : "ı";
  }

  function canStemSoften(stem, pos, flags) {
    if (flags.nv) return false;
    if (flags.v) return true;
    if (pos === "V") return false;
    if (stem.endsWith("nk")) return true;
    const last = stem[stem.length - 1];
    if (!SOFTEN_MAP[last]) return false;
    return countVowels(stem) >= 2;
  }

  function softenStem(stem) {
    if (stem.endsWith("nk")) return stem.slice(0, -1) + "g";
    const last = stem[stem.length - 1];
    if (SOFTEN_MAP[last]) return stem.slice(0, -1) + SOFTEN_MAP[last];
    return stem;
  }

  function dropLastVowel(stem) {
    for (let i = stem.length - 1; i >= 0; i--) {
      if (VOWELS.has(stem[i])) {
        return stem.slice(0, i) + stem.slice(i + 1);
      }
    }
    return stem;
  }

  function doubleFinalConsonant(stem) {
    const last = stem[stem.length - 1];
    if (last === "t") return stem.slice(0, -1) + "dd";
    if (last === "p") return stem.slice(0, -1) + "bb";
    return stem + last;
  }

  const INDEX_CACHE = new WeakMap();

  function parseFlags(flagStr) {
    const flags = {};
    if (!flagStr) return flags;
    for (const f of flagStr.split(",")) {
      if (f) flags[f] = true;
    }
    return flags;
  }

  function getLexiconIndex(trLexicon) {
    if (!trLexicon || typeof trLexicon !== "object") {
      return {
        parsedRoots: new Map(),
        foldedRoots: new Map(),
        words: null,
        validCache: new Map(),
      };
    }
    let idx = INDEX_CACHE.get(trLexicon);
    if (idx) return idx;

    const parsedRoots = new Map();
    const foldedRoots = new Map();
    const roots = trLexicon.roots || {};

    for (const stem of Object.keys(roots)) {
      const rawSpec = roots[stem];
      const entries = [];
      for (const part of String(rawSpec).split(";")) {
        if (!part) continue;
        const barIdx = part.indexOf("|");
        const pos = barIdx >= 0 ? part.slice(0, barIdx) : part;
        const flagStr = barIdx >= 0 ? part.slice(barIdx + 1) : "";
        entries.push({ stem, pos, flags: parseFlags(flagStr) });
      }
      if (entries.length === 0) continue;
      parsedRoots.set(stem, entries);

      const folded = trFold(stem);
      let fArr = foldedRoots.get(folded);
      if (!fArr) {
        fArr = [];
        foldedRoots.set(folded, fArr);
      }
      for (const e of entries) fArr.push(e);
    }

    idx = {
      parsedRoots,
      foldedRoots,
      rootsByLen: buildRootsByLen(foldedRoots),
      words: trLexicon.words || null,
      validCache: new Map(),
    };
    INDEX_CACHE.set(trLexicon, idx);
    return idx;
  }

  function buildRootsByLen(foldedRoots) {
    const byLen = new Map();
    for (const [fRoot, entries] of foldedRoots.entries()) {
      const len = fRoot.length;
      let bucket = byLen.get(len);
      if (!bucket) {
        bucket = [];
        byLen.set(len, bucket);
      }
      bucket.push([fRoot, entries]);
    }
    return byLen;
  }

  function makeState(fsmState, surface, lastVowel, pos, flags, rootEntry, suffixes, opts) {
    const lastChar = surface[surface.length - 1] || "";
    const endsWithVowel = VOWELS.has(lastChar);
    const endsWithVoiceless = VOICELESS.has(lastChar);
    return {
      fsmState,
      surface,
      lastVowel,
      inverseHarmony: Boolean(opts && opts.inverseHarmony),
      canSoftenStem: Boolean(opts && opts.canSoftenStem),
      canSoftenSuffixK: Boolean(opts && opts.canSoftenSuffixK),
      needsVowelDrop: Boolean(opts && opts.needsVowelDrop),
      strictExact: Boolean(opts && opts.strictExact),
      mustTakeVowelNext: Boolean(opts && opts.mustTakeVowelNext),
      isPoss3: Boolean(opts && opts.isPoss3),
      allowKi: Boolean(opts && opts.allowKi),
      endsWithVowel,
      endsWithVoiceless,
      pos,
      flags,
      rootEntry,
      suffixes,
      cost: (opts && opts.cost) || 0,
      hasApostrophe: Boolean(opts && opts.hasApostrophe),
    };
  }

  /**
   * Generates valid next states (morpheme transitions) from the current FSM state.
   * Each transition produces `{ suffix, nextState, label }`.
   */
  function getTransitions(st) {
    const out = [];
    const v2 = harmony2(st.lastVowel, st.inverseHarmony);
    const v4 = harmony4(st.lastVowel, st.inverseHarmony);
    const dChar = st.endsWithVoiceless ? "t" : "d";
    const cChar = st.endsWithVoiceless ? "ç" : "c";

    const add = (suffix, fsmState, nextLastVowel, extra) => {
      const startsWithVowel = suffix.length > 0 && VOWELS.has(suffix[0]);
      // If previous step pre-softened suffix-k to ğ, ONLY vowel-initial suffixes can follow
      if (st.mustTakeVowelNext && !startsWithVowel) return;
      // In strictExact mode, un-dropped LastVowelDrop stems cannot take vowel-initial suffixes directly
      if (st.strictExact && st.needsVowelDrop && startsWithVowel) return;
      // In strictExact mode, suffix-k (like -AcAk, -DIk, -lIk) cannot stay unsoftened before vowel-initial suffixes
      if (st.strictExact && st.canSoftenSuffixK && st.surface.endsWith("k") && startsWithVowel && !(extra && extra.alreadySoftenedK)) {
        return;
      }

      const nextSurface =
        extra && extra.replaceSurface !== undefined ? extra.replaceSurface : st.surface + suffix;
      const nextSuffixes = st.suffixes.concat(extra && extra.label ? extra.label : suffix);
      out.push({
        suffix,
        consumedSurface: extra && extra.consumedSurface !== undefined ? extra.consumedSurface : suffix,
        nextState: makeState(
          fsmState,
          nextSurface,
          nextLastVowel,
          (extra && extra.pos) || st.pos,
          st.flags,
          st.rootEntry,
          nextSuffixes,
          {
            inverseHarmony: false,
            canSoftenStem: false,
            needsVowelDrop: false,
            strictExact: st.strictExact,
            mustTakeVowelNext: Boolean(extra && extra.mustTakeVowelNext),
            canSoftenSuffixK: Boolean(extra && extra.canSoftenSuffixK),
            isPoss3: Boolean(extra && extra.isPoss3),
            allowKi: Boolean(extra && extra.allowKi),
            hasApostrophe: st.hasApostrophe,
          }
        ),
      });
    };

    const addSoftening = (suffix, fsmState, nextLastVowel, extra) => {
      const startsWithVowel = suffix.length > 0 && VOWELS.has(suffix[0]);
      if (st.canSoftenStem && startsWithVowel) {
        // In strictExact mode, unsoftened stem (kitap) cannot take vowel-initial suffix directly (must enter via softened kitab)
        if (st.strictExact && !st.hasApostrophe) return;
        const softened = softenStem(st.surface);
        add(suffix, fsmState, nextLastVowel, {
          ...extra,
          replaceSurface: softened + suffix,
          consumedSurface: suffix,
          stemSoftened: true,
        });
      } else if (st.canSoftenSuffixK && st.surface.endsWith("k") && startsWithVowel) {
        if (st.strictExact && !st.mustTakeVowelNext) {
          return;
        }
        const softened = st.mustTakeVowelNext ? st.surface : st.surface.slice(0, -1) + "ğ";
        add(suffix, fsmState, nextLastVowel, {
          ...extra,
          replaceSurface: softened + suffix,
          consumedSurface: suffix,
          stemSoftened: true,
          alreadySoftenedK: true,
        });
      } else {
        add(suffix, fsmState, nextLastVowel, extra);
      }
    };

    const s = st.fsmState;

    // --- NOMINAL CHAIN ---
    if (s === "NOM_STEM") {
      // Plural +lAr
      add("l" + v2 + "r", "NOM_PLUR", v2);

      // Derivations from NOM_STEM
      add("l" + v4 + "k", "NOM_STEM", v4, { canSoftenSuffixK: true });
      if (st.strictExact) {
        add("l" + v4 + "ğ", "NOM_STEM", v4, { mustTakeVowelNext: true, canSoftenSuffixK: true });
      }
      add("l" + v4, "NOM_STEM", v4);
      add("s" + v4 + "z", "NOM_STEM", v4);
      add(cChar + v4, "NOM_STEM", v4);
      add(cChar + v4 + "k", "NOM_STEM", v4, { canSoftenSuffixK: true });
      if (st.strictExact) {
        add(cChar + v4 + "ğ", "NOM_STEM", v4, { mustTakeVowelNext: true, canSoftenSuffixK: true });
      }
      add("gil", "NOM_STEM", "i");
      add("leyin", "END", "i");

      // Denominal verbs: +lA, +lAn, +lAş (plus direct -lIyor for denominal +lA + yor!)
      add("l" + v2, "VERB_STEM", v2, { pos: "V" });
      add("l" + v4 + "yor", "VERB_TENSE_IND", "o", { pos: "V" });
      add("l" + v2 + "n", "VERB_STEM", v2, { pos: "V" });
      add("l" + v2 + "ş", "VERB_STEM", v2, { pos: "V" });

      // Equative +CA
      add(cChar + v2, "NOM_CASE", v2);

      // Time-word -ki (dün -> dünkü, bugün -> bugünkü, sabah -> sabahki, etc.)
      if (st.rootEntry.stem === "dün" || st.rootEntry.stem === "bugün" || st.rootEntry.stem === "öbür") {
        add("kü", "NOM_STEM", "ü", { isPoss3: true });
      } else if (
        st.allowKi ||
        ["şimdi", "önce", "sonra", "sabah", "akşam", "gece", "yarın", "demin", "karşı", "yukarı", "aşağı", "ileri", "geri", "ora", "bura", "şura"].includes(
          st.rootEntry.stem
        )
      ) {
        add("ki", "NOM_STEM", "i", { isPoss3: true });
      }
    }

    if (s === "NOM_STEM" || s === "NOM_PLUR") {
      // Possessive
      const isSu = st.rootEntry.stem === "su" && s === "NOM_STEM";
      const isNe = st.rootEntry.stem === "ne" && s === "NOM_STEM";
      if (isSu || isNe) {
        const baseV = isSu ? "u" : "i";
        add("y" + baseV + "m", "NOM_POSS", baseV);
        add("y" + baseV + "n", "NOM_POSS", baseV);
        add("y" + baseV, "NOM_POSS3", baseV, { isPoss3: true });
        add("y" + baseV + "m" + baseV + "z", "NOM_POSS", baseV);
        add("y" + baseV + "n" + baseV + "z", "NOM_POSS", baseV);
      } else if (st.endsWithVowel) {
        add("m", "NOM_POSS", st.lastVowel);
        add("n", "NOM_POSS", st.lastVowel);
        add("s" + v4, "NOM_POSS3", v4, { isPoss3: true });
        add("m" + v4 + "z", "NOM_POSS", v4);
        add("n" + v4 + "z", "NOM_POSS", v4);
      } else {
        addSoftening(v4 + "m", "NOM_POSS", v4);
        addSoftening(v4 + "n", "NOM_POSS", v4);
        addSoftening(v4, "NOM_POSS3", v4, { isPoss3: true });
        addSoftening(v4 + "m" + v4 + "z", "NOM_POSS", v4);
        addSoftening(v4 + "n" + v4 + "z", "NOM_POSS", v4);
      }
      if (s === "NOM_STEM") {
        // 3pl possessive +lArI (note: NOM_PLUR +lAr + I is already handled above via s === "NOM_PLUR" + v4)
        add("l" + v2 + "r" + (v2 === "e" ? "i" : "ı"), "NOM_POSS3", v2 === "e" ? "i" : "ı", {
          isPoss3: true,
        });
      }
    }

    if (s === "NOM_STEM" || s === "NOM_PLUR" || s === "NOM_POSS" || s === "NOM_POSS3") {
      // Cases
      const useN = st.isPoss3;
      const isSu = st.rootEntry.stem === "su" && s === "NOM_STEM";
      const isNe = st.rootEntry.stem === "ne" && s === "NOM_STEM";

      // Dative +(y)A
      if (useN) {
        add("n" + v2, "NOM_CASE", v2);
      } else if (st.endsWithVowel) {
        add("y" + v2, "NOM_CASE", v2);
      } else {
        addSoftening(v2, "NOM_CASE", v2);
      }

      // Locative +DA
      if (useN) {
        add("nd" + v2, "NOM_CASE_LOC", v2, { allowKi: true });
      } else {
        add(dChar + v2, "NOM_CASE_LOC", v2, { allowKi: true });
      }

      // Ablative +DAn
      if (useN) {
        add("nd" + v2 + "n", "NOM_CASE", v2);
      } else {
        add(dChar + v2 + "n", "NOM_CASE", v2);
      }

      // Accusative +(y)I
      if (useN) {
        add("n" + v4, "NOM_CASE", v4);
      } else if (st.endsWithVowel) {
        add("y" + v4, "NOM_CASE", v4);
      } else {
        addSoftening(v4, "NOM_CASE", v4);
      }

      // Genitive +(n)In
      if (isSu || isNe) {
        add("y" + v4 + "n", "NOM_CASE_GEN", v4, { allowKi: true });
      } else if (useN || st.endsWithVowel) {
        add("n" + v4 + "n", "NOM_CASE_GEN", v4, { allowKi: true });
      } else {
        addSoftening(v4 + "n", "NOM_CASE_GEN", v4, { allowKi: true });
      }

      // Instrumental +(y)lA
      if (st.endsWithVowel) {
        add("yl" + v2, "NOM_CASE", v2);
      } else {
        add("l" + v2, "NOM_CASE", v2);
      }
    }

    if (s === "NOM_CASE_LOC" || s === "NOM_CASE_GEN") {
      // Relative -ki (e.g., evdeki, benimki, evlerimizdekilerden)
      add("ki", "NOM_STEM", "i", { isPoss3: true });
    }

    if (
      s === "NOM_STEM" ||
      s === "NOM_PLUR" ||
      s === "NOM_POSS" ||
      s === "NOM_POSS3" ||
      s === "NOM_CASE" ||
      s === "NOM_CASE_LOC" ||
      s === "NOM_CASE_GEN"
    ) {
      // Copula / Nominal Predicates (only when not apostrophe-broken unless proper case)
      // Past copula +(y)DI, Evidential +(y)mIş, Conditional +(y)sA, Converb +(y)ken
      if (st.endsWithVowel) {
        add("yd" + v4, "COP_K", v4);
        add("ym" + v4 + "ş", "COP_IND", v4);
        add("ys" + v2, "COP_K", v2);
        add("yken", "END", "e");
      } else {
        add(dChar + v4, "COP_K", v4);
        add("m" + v4 + "ş", "COP_IND", v4);
        add("s" + v2, "COP_K", v2);
        add("ken", "END", "e");
      }

      // Present Nominal Person (1sg, 2sg, 3sg -DIr, 1pl, 2pl, 3pl)
      if (s === "NOM_STEM" || s === "NOM_PLUR" || s === "NOM_POSS" || s === "NOM_CASE_LOC" || s === "NOM_CASE_GEN" || s === "NOM_CASE") {
        if (st.endsWithVowel) {
          add("y" + v4 + "m", "END", v4);
          add("y" + v4 + "z", "END", v4);
        } else {
          addSoftening(v4 + "m", "END", v4);
          addSoftening(v4 + "z", "END", v4);
        }
        add("s" + v4 + "n", "END", v4);
        add("s" + v4 + "n" + v4 + "z", "END", v4);
        add(dChar + v4 + "r", "COP_DIR", v4);
      }
    }

    if (s === "COP_DIR") {
      add("l" + v2 + "r", "END", v2);
    }

    if (s === "NOM_INF") {
      // Infinitive -mAk allows Dative (+A), Locative (+tA), Ablative (+tAn), Instrumental (+lA)
      addSoftening(v2, "END", v2); // gitmeğe/yapmağa (rare) or standard gitmeye via -mA
      add(dChar + v2, "NOM_CASE_LOC", v2);
      add(dChar + v2 + "n", "END", v2);
      add("l" + v2, "END", v2);
    }

    // --- VERBAL CHAIN ---
    if (s === "VERB_STEM" || s === "VERB_VOICE") {
      // Voice suffixes (allow 1-2 voice transitions from VERB_STEM, limited from VERB_VOICE)
      if (s === "VERB_STEM") {
        // Reciprocal +(I)ş
        if (st.endsWithVowel) add("ş", "VERB_VOICE", st.lastVowel);
        else addSoftening(v4 + "ş", "VERB_VOICE", v4);

        // Reflexive/Passive +(I)n, +(I)l
        if (st.endsWithVowel) {
          add("n", "VERB_VOICE", st.lastVowel);
          add("l", "VERB_VOICE", st.lastVowel);
        } else if (st.surface.endsWith("l")) {
          add(v4 + "n", "VERB_VOICE", v4);
        } else {
          addSoftening(v4 + "n", "VERB_VOICE", v4);
          addSoftening(v4 + "l", "VERB_VOICE", v4);
        }

        // Causative +DIr, +t
        add(dChar + v4 + "r", "VERB_VOICE", v4);
        if (st.endsWithVowel || ((st.surface.endsWith("l") || st.surface.endsWith("r")) && countVowels(st.surface) >= 2)) {
          add("t", "VERB_VOICE", st.lastVowel);
        }
      } else {
        // After first voice, allow causative +DIr / +t or passive +Il / +In
        add(dChar + v4 + "r", "VERB_VOICE2", v4);
        if (st.surface.endsWith("ş") || st.surface.endsWith("r")) {
          add(v4 + "l", "VERB_VOICE2", v4);
        }
      }
    }

    if (s === "VERB_STEM" || s === "VERB_VOICE" || s === "VERB_VOICE2") {
      // Potential +(y)Abil
      if (st.endsWithVowel) {
        add("y" + v2 + "bil", "VERB_MOD", "i");
        add("y" + v2, "VERB_POT_NEG", v2);
      } else {
        addSoftening(v2 + "bil", "VERB_MOD", "i");
        addSoftening(v2, "VERB_POT_NEG", v2);
      }
    }

    if (s === "VERB_STEM" || s === "VERB_VOICE" || s === "VERB_VOICE2" || s === "VERB_MOD" || s === "VERB_POT_NEG") {
      // Negation +mA (and +mI before -yor!)
      add("m" + v2, "VERB_NEG", v2);
      const negNarrowV = harmony4(st.lastVowel, st.inverseHarmony);
      add("m" + negNarrowV, "VERB_NEG_YOR", negNarrowV);
      // Aorist negative (+mAz, +mAm, +mAyIz)
      add("m" + v2 + "z", "VERB_TENSE_IND", v2);
      add("m" + v2 + "m", "END", v2);
      add("m" + v2 + "y" + (v2 === "e" ? "i" : "ı") + "z", "END", v2 === "e" ? "i" : "ı");
    }

    if (s === "VERB_NEG_YOR") {
      add("yor", "VERB_TENSE_IND", "o");
    }

    if (
      s === "VERB_STEM" ||
      s === "VERB_VOICE" ||
      s === "VERB_VOICE2" ||
      s === "VERB_MOD" ||
      s === "VERB_NEG"
    ) {
      // Progressive -(I)yor
      if (s === "VERB_STEM" && (st.surface === "ye" || st.surface === "de")) {
        if (!st.strictExact) {
          const narrowed = st.surface[0] + "i";
          add("yor", "VERB_TENSE_IND", "o", { replaceSurface: narrowed + "yor", consumedSurface: "yor" });
        }
      } else if (s === "VERB_STEM" && (st.surface === "yi" || st.surface === "di")) {
        add("yor", "VERB_TENSE_IND", "o");
      } else if (st.endsWithVowel && (st.surface.endsWith("a") || st.surface.endsWith("e"))) {
        if (!st.strictExact) {
          // Vowel narrowing in synthesis mode: bekle + yor -> bekliyor, anla + yor -> anlıyor, söyle + yor -> söylüyor
          const prevV = getPrevVowelBeforeLast(st.surface);
          const narrowedV = harmony4(prevV, false);
          const narrowedStem = st.surface.slice(0, -1) + narrowedV;
          add("yor", "VERB_TENSE_IND", "o", { replaceSurface: narrowedStem + "yor", consumedSurface: "yor" });
        }
      } else if (st.endsWithVowel) {
        add("yor", "VERB_TENSE_IND", "o");
      } else {
        addSoftening(v4 + "yor", "VERB_TENSE_IND", "o");
      }

      // Future +(y)AcAk (softens k->ğ before vowel-initial person suffix!)
      if (s === "VERB_STEM" && (st.surface === "ye" || st.surface === "de")) {
        if (!st.strictExact) {
          const narrowed = st.surface[0] + "i";
          add("yecek", "VERB_TENSE_IND", "e", {
            replaceSurface: narrowed + "yecek",
            consumedSurface: "yecek",
            canSoftenSuffixK: true,
          });
        }
      } else if (s === "VERB_STEM" && (st.surface === "yi" || st.surface === "di")) {
        add("yecek", "VERB_TENSE_IND", "e", { canSoftenSuffixK: true });
        if (st.strictExact) add("yeceğ", "VERB_TENSE_IND", "e", { mustTakeVowelNext: true, canSoftenSuffixK: true });
      } else if (st.endsWithVowel) {
        add("y" + v2 + "c" + v2 + "k", "VERB_TENSE_IND", v2, { canSoftenSuffixK: true });
        if (st.strictExact) {
          add("y" + v2 + "c" + v2 + "ğ", "VERB_TENSE_IND", v2, { mustTakeVowelNext: true, canSoftenSuffixK: true });
        }
      } else {
        addSoftening(v2 + "c" + v2 + "k", "VERB_TENSE_IND", v2, { canSoftenSuffixK: true });
        if (st.strictExact) {
          addSoftening(v2 + "c" + v2 + "ğ", "VERB_TENSE_IND", v2, { mustTakeVowelNext: true, canSoftenSuffixK: true });
        }
      }

      // Past Definite +DI
      add(dChar + v4, "VERB_TENSE_DI", v4);

      // Evidential +mIş
      add("m" + v4 + "ş", "VERB_TENSE_IND", v4);

      // Aorist (positive; negative handled above)
      if (s !== "VERB_NEG") {
        if (st.endsWithVowel) {
          add("r", "VERB_TENSE_IND", st.lastVowel);
        } else {
          const isRoot = s === "VERB_STEM";
          const useIr =
            !isRoot ||
            st.flags.ai ||
            (!st.flags.aa && countVowels(st.surface) >= 2);
          const aorV = useIr ? v4 : v2;
          addSoftening(aorV + "r", "VERB_TENSE_IND", aorV);
        }
      }

      // Necessitative +mAlI
      add("m" + v2 + "l" + (v2 === "e" ? "i" : "ı"), "VERB_TENSE_IND", v2 === "e" ? "i" : "ı");

      // Conditional +sA
      add("s" + v2, "VERB_TENSE_COND", v2);

      // Optative +(y)A + 1sg/1pl
      const optV4 = v2 === "e" ? "i" : "ı";
      if (st.endsWithVowel) {
        add("y" + v2, "END", v2);
        add("y" + v2 + "y" + optV4 + "m", "END", optV4);
        add("y" + v2 + "l" + optV4 + "m", "END", optV4);
      } else {
        addSoftening(v2, "END", v2);
        addSoftening(v2 + "y" + optV4 + "m", "END", optV4);
        addSoftening(v2 + "l" + optV4 + "m", "END", optV4);
      }

      // Imperative 2pl, 3sg, 3pl, emphatic +sAnA (2sg is bare VERB_STEM)
      if (st.endsWithVowel) {
        add("y" + v4 + "n", "END", v4);
        add("y" + v4 + "n" + v4 + "z", "END", v4);
      } else {
        addSoftening(v4 + "n", "END", v4);
        addSoftening(v4 + "n" + v4 + "z", "END", v4);
      }
      add("s" + v4 + "n", "END", v4);
      add("s" + v4 + "nl" + v2 + "r", "END", v2);
      add("s" + v2 + "n" + v2, "END", v2);

      // Deverbal Derivations / Participles / Infinitives -> Nominal states
      add("m" + v2 + "k", "NOM_INF", v2, { pos: "N" });
      add("m" + v2, "NOM_STEM", v2, { pos: "N" });
      if (st.endsWithVowel) {
        add("y" + v4 + "ş", "NOM_STEM", v4, { pos: "N" });
      } else {
        addSoftening(v4 + "ş", "NOM_STEM", v4, { pos: "N" });
      }

      // Participle +DIk (k->ğ softening) -> NOM_STEM
      add(dChar + v4 + "k", "NOM_STEM", v4, { pos: "A", canSoftenSuffixK: true });
      if (st.strictExact) {
        add(dChar + v4 + "ğ", "NOM_STEM", v4, { pos: "A", mustTakeVowelNext: true, canSoftenSuffixK: true });
      }
      // Participle +(y)AcAk -> NOM_STEM
      if (st.endsWithVowel) {
        add("y" + v2 + "c" + v2 + "k", "NOM_STEM", v2, { pos: "A", canSoftenSuffixK: true });
        if (st.strictExact) {
          add("y" + v2 + "c" + v2 + "ğ", "NOM_STEM", v2, { pos: "A", mustTakeVowelNext: true, canSoftenSuffixK: true });
        }
      } else {
        addSoftening(v2 + "c" + v2 + "k", "NOM_STEM", v2, { pos: "A", canSoftenSuffixK: true });
        if (st.strictExact) {
          addSoftening(v2 + "c" + v2 + "ğ", "NOM_STEM", v2, { pos: "A", mustTakeVowelNext: true, canSoftenSuffixK: true });
        }
      }
      // Participle +(y)An -> NOM_STEM
      if (s === "VERB_STEM" && (st.surface === "ye" || st.surface === "de")) {
        if (!st.strictExact) {
          const narrowed = st.surface[0] + "i";
          add("yen", "NOM_STEM", "e", { replaceSurface: narrowed + "yen", consumedSurface: "yen", pos: "A" });
        }
      } else if (s === "VERB_STEM" && (st.surface === "yi" || st.surface === "di")) {
        add("yen", "NOM_STEM", "e", { pos: "A" });
      } else if (st.endsWithVowel) {
        add("y" + v2 + "n", "NOM_STEM", v2, { pos: "A" });
      } else {
        addSoftening(v2 + "n", "NOM_STEM", v2, { pos: "A" });
      }
      // Participle +mIş -> NOM_STEM
      add("m" + v4 + "ş", "NOM_STEM", v4, { pos: "A" });

      // Converbs: +(y)Ip, +(y)ArAk, +(y)IncA, +DIkçA, +(y)AlI, +(y)ken
      if (s === "VERB_STEM" && (st.surface === "ye" || st.surface === "de")) {
        if (!st.strictExact) {
          const narrowed = st.surface[0] + "i";
          add("yip", "END", "i", { replaceSurface: narrowed + "yip", consumedSurface: "yip" });
          add("yerek", "END", "e", { replaceSurface: narrowed + "yerek", consumedSurface: "yerek" });
          add("yince", "END", "e", { replaceSurface: narrowed + "yince", consumedSurface: "yince" });
        }
      } else if (s === "VERB_STEM" && (st.surface === "yi" || st.surface === "di")) {
        add("yip", "END", "i");
        add("yerek", "END", "e");
        add("yince", "END", "e");
      } else if (st.endsWithVowel) {
        add("y" + v4 + "p", "END", v4);
        add("y" + v2 + "r" + v2 + "k", "END", v2);
        add("y" + v4 + "nc" + v2, "END", v2);
        add("y" + v2 + "l" + (v2 === "e" ? "i" : "ı"), "END", v2 === "e" ? "i" : "ı");
      } else {
        addSoftening(v4 + "p", "END", v4);
        addSoftening(v2 + "r" + v2 + "k", "END", v2);
        addSoftening(v4 + "nc" + v2, "END", v2);
        addSoftening(v2 + "l" + (v2 === "e" ? "i" : "ı"), "END", v2 === "e" ? "i" : "ı");
      }
      add(dChar + v4 + "k" + "ç" + v2, "END", v2);
      // -ken after aorist / tense is handled below; also verb+ken rare, usually tense+ken
    }

    // --- TENSE -> COMPOUND + PERSON ---
    if (s === "VERB_TENSE_IND") {
      // Compound tenses +(y)DI, +(y)mIş, +(y)sA, +(y)ken
      if (st.endsWithVowel) {
        add("yd" + v4, "VERB_TENSE_K", v4);
        add("ym" + v4 + "ş", "VERB_TENSE_IND2", v4);
        add("ys" + v2, "VERB_TENSE_K", v2);
        add("yken", "END", "e");
      } else {
        add(dChar + v4, "VERB_TENSE_K", v4);
        add("m" + v4 + "ş", "VERB_TENSE_IND2", v4);
        add("s" + v2, "VERB_TENSE_K", v2);
        add("ken", "END", "e");
      }
      // Person IND
      if (st.endsWithVowel) {
        add("y" + v4 + "m", "END", v4);
        add("y" + v4 + "z", "END", v4);
      } else {
        addSoftening(v4 + "m", "END", v4);
        addSoftening(v4 + "z", "END", v4);
      }
      add("s" + v4 + "n", "END", v4);
      add("s" + v4 + "n" + v4 + "z", "END", v4);
      add("l" + v2 + "r", "END", v2);
      add(dChar + v4 + "r", "COP_DIR", v4);
    }

    if (s === "VERB_TENSE_IND2" || s === "COP_IND") {
      if (st.endsWithVowel) {
        add("y" + v4 + "m", "END", v4);
        add("y" + v4 + "z", "END", v4);
      } else {
        addSoftening(v4 + "m", "END", v4);
        addSoftening(v4 + "z", "END", v4);
      }
      add("s" + v4 + "n", "END", v4);
      add("s" + v4 + "n" + v4 + "z", "END", v4);
      add("l" + v2 + "r", "END", v2);
      add(dChar + v4 + "r", "COP_DIR", v4);
    }

    if (s === "VERB_TENSE_DI") {
      // +DI allows compound +(y)sA (`olduysa`) and +K person endings (`oldum`, `oldunuz`)
      add("ys" + v2, "VERB_TENSE_K", v2);
    }

    if (s === "VERB_TENSE_COND") {
      // +sA allows compound +(y)DI (`olsaydı`) and +(y)mIş (`olsaymış`) and +K person endings
      add("yd" + v4, "VERB_TENSE_K", v4);
      add("ym" + v4 + "ş", "VERB_TENSE_IND2", v4);
    }

    if (s === "VERB_TENSE_K" || s === "VERB_TENSE_DI" || s === "VERB_TENSE_COND" || s === "COP_K") {
      add("m", "END", st.lastVowel);
      add("n", "END", st.lastVowel);
      add("k", "END", st.lastVowel);
      add("n" + v4 + "z", "END", v4);
      add("l" + v2 + "r", "END", v2);
    }

    return out;
  }

  function isAcceptingState(st) {
    return (
      st.fsmState !== "VERB_POT_NEG" &&
      st.fsmState !== "VERB_NEG_YOR" &&
      !st.mustTakeVowelNext
    );
  }

  /**
   * Enumerates initial root matches for a lowercase word (or folded word if foldedMode=true).
   */
  function findInitialStates(word, idx, foldedMode) {
    const results = [];
    const len = word.length;
    const rootMap = foldedMode ? idx.foldedRoots : idx.parsedRoots;

    const pushEntries = (entries, remainder, surfaceOverride, opts) => {
      for (const entry of entries) {
        if (opts && opts.requireVerb && entry.pos !== "V") continue;
        if (opts && opts.requireNonVerb && entry.pos === "V") continue;
        if (opts && opts.requireFlag && !entry.flags[opts.requireFlag]) continue;
        if (entry.flags.ns && remainder.length > 0) continue;

        const isVerb = entry.pos === "V";
        const initState = isVerb ? "VERB_STEM" : "NOM_STEM";
        const surface = surfaceOverride || entry.stem;
        const lastVowel = getLastVowel(entry.stem);
        const allowSoften = canStemSoften(entry.stem, entry.pos, entry.flags);

        results.push({
          remainder,
          state: makeState(initState, surface, lastVowel, entry.pos, entry.flags, entry, [], {
            inverseHarmony: Boolean(entry.flags.ih),
            canSoftenStem: allowSoften && !(opts && opts.alreadyModified),
            needsVowelDrop: Boolean(entry.flags.vd) && !(opts && opts.alreadyModified),
            strictExact: !foldedMode,
            hasApostrophe: Boolean(opts && opts.hasApostrophe),
          }),
        });
      }
    };

    // Handle optional apostrophe for proper nouns (e.g., Ankara'ya, Türkiye'de)
    const apoIdx = word.indexOf("'");
    if (apoIdx > 0) {
      const pre = word.slice(0, apoIdx);
      const post = word.slice(apoIdx + 1);
      const entries = rootMap.get(pre);
      if (entries) {
        pushEntries(entries, post, pre, { requireNonVerb: true, hasApostrophe: true });
      }
      return results;
    }

    for (let k = len; k >= 1; k--) {
      const prefix = word.slice(0, k);
      const remainder = word.slice(k);

      // 1. Direct root match
      const direct = rootMap.get(prefix);
      if (direct) {
        pushEntries(direct, remainder, null, null);
      }

      // Remaining alternations only apply when a suffix follows
      if (remainder.length === 0) continue;
      const remFirst = remainder[0];

      // 2. Un-soften stem-final consonant (b->p, c->ç, d->t, ğ->k, ng->nk)
      if (!foldedMode) {
        const last = prefix[prefix.length - 1];
        if (UNSOFTEN_MAP[last] && VOWELS.has(remFirst)) {
          const base = prefix.slice(0, -1) + UNSOFTEN_MAP[last];
          const entries = rootMap.get(base);
          if (entries) {
            for (const entry of entries) {
              if (canStemSoften(entry.stem, entry.pos, entry.flags)) {
                pushEntries([entry], remainder, prefix, { alreadyModified: true });
              }
            }
          }
        }
        if (prefix.endsWith("ng") && VOWELS.has(remFirst)) {
          const base = prefix.slice(0, -1) + "k";
          const entries = rootMap.get(base);
          if (entries) {
            for (const entry of entries) {
              if (canStemSoften(entry.stem, entry.pos, entry.flags)) {
                pushEntries([entry], remainder, prefix, { alreadyModified: true });
              }
            }
          }
        }
      } else {
        // Folded mode: g could be ğ (<- k), c could be ç, d could be t, b could be p
        // Stem consonant softening ONLY occurs before a vowel-initial suffix (VOWELS.has(remFirst))
        const last = prefix[prefix.length - 1];
        const foldedUnsoften = { b: ["p"], c: ["c"], d: ["t"], g: ["k"] };
        if (foldedUnsoften[last] && VOWELS.has(remFirst)) {
          for (const orig of foldedUnsoften[last]) {
            const base = prefix.slice(0, -1) + orig;
            const entries = rootMap.get(base);
            if (entries) {
              for (const entry of entries) {
                if (canStemSoften(entry.stem, entry.pos, entry.flags)) {
                  const softReal = softenStem(entry.stem);
                  pushEntries([entry], remainder, softReal, { alreadyModified: true });
                }
              }
            }
          }
        }
        if (prefix.endsWith("ng") && VOWELS.has(remFirst)) {
          const base = prefix.slice(0, -1) + "k";
          const entries = rootMap.get(base);
          if (entries) {
            for (const entry of entries) {
              if (canStemSoften(entry.stem, entry.pos, entry.flags)) {
                pushEntries([entry], remainder, softenStem(entry.stem), { alreadyModified: true });
              }
            }
          }
        }
      }

      // 3. Vowel drop restoration (e.g., burnu -> burun, aklı -> akıl, şehri -> şehir, oğlu -> oğul)
      if (prefix.length >= 3 && !VOWELS.has(prefix[prefix.length - 1]) && !VOWELS.has(prefix[prefix.length - 2])) {
        const dropVowels = foldedMode ? ["i", "u"] : ["ı", "i", "u", "ü"];
        for (const dv of dropVowels) {
          const candBase = prefix.slice(0, -1) + dv + prefix[prefix.length - 1];
          const entries = rootMap.get(candBase);
          if (entries) {
            for (const entry of entries) {
              if (!entry.flags.vd) continue;
              const droppedSurface = dropLastVowel(entry.stem);
              pushEntries([entry], remainder, droppedSurface, { alreadyModified: true });
            }
          }
        }
      }

      // 4. Consonant doubling restoration (e.g., hakkı -> hak, affı -> af, reddi -> ret/red, tıbbı -> tıp)
      if (prefix.length >= 3 && prefix[prefix.length - 1] === prefix[prefix.length - 2] && !VOWELS.has(prefix[prefix.length - 1])) {
        const c = prefix[prefix.length - 1];
        const bases = [prefix.slice(0, -1)];
        if (c === "d") bases.push(prefix.slice(0, -2) + "t");
        if (c === "b") bases.push(prefix.slice(0, -2) + "p");
        for (const b of bases) {
          const entries = rootMap.get(b);
          if (entries) {
            for (const entry of entries) {
              if (!entry.flags.db) continue;
              const doubledSurface = doubleFinalConsonant(entry.stem);
              pushEntries([entry], remainder, doubledSurface, { alreadyModified: true });
            }
          }
        }
      }

      // 5. -yor vowel narrowing / ye-de restoration
      const last = prefix[prefix.length - 1];
      const isNarrowCandidate = foldedMode ? last === "i" || last === "u" : last === "ı" || last === "i" || last === "u" || last === "ü";
      if (isNarrowCandidate && remainder.startsWith("yor")) {
        const tryVowels = foldedMode ? ["a", "e"] : last === "ı" || last === "u" ? ["a"] : ["e"];
        for (const ov of tryVowels) {
          const base = prefix.slice(0, -1) + ov;
          const entries = rootMap.get(base);
          if (entries) {
            for (const entry of entries) {
              if (entry.pos !== "V") continue;
              if (!foldedMode) {
                const expectedNarrow = harmony4(getPrevVowelBeforeLast(entry.stem), false);
                if (expectedNarrow !== last) continue;
              }
              const expectedNarrow = harmony4(getPrevVowelBeforeLast(entry.stem), false);
              const narrowedSurface = entry.stem.slice(0, -1) + expectedNarrow;
              pushEntries([entry], remainder, narrowedSurface, {
                requireVerb: true,
                alreadyModified: true,
              });
            }
          }
        }
      }

      // ye/de narrowing: yi/di + y... -> ye/de
      if ((prefix === "yi" || prefix === "di") && remainder.startsWith("y")) {
        const base = prefix[0] + "e";
        const entries = rootMap.get(base);
        if (entries) {
          pushEntries(entries, remainder, prefix, { requireVerb: true, alreadyModified: true });
        }
      }
    }

    return results;
  }

  function runExactFSM(word, idx) {
    const initials = findInitialStates(word, idx, false);
    const analyses = [];
    const seen = new Set();

    for (const init of initials) {
      if (init.remainder.length === 0) {
        if (isAcceptingState(init.state)) {
          const key = `${init.state.rootEntry.stem}:${init.state.pos}:`;
          if (!seen.has(key)) {
            seen.add(key);
            analyses.push({
              valid: true,
              stem: init.state.rootEntry.stem,
              pos: init.state.pos,
              suffixes: [],
            });
          }
        }
        continue;
      }

      // BFS/DFS stack with visited state guard
      const stack = [{ state: init.state, pos: 0 }];
      const visited = new Set();

      while (stack.length > 0) {
        const { state, pos } = stack.pop();
        if (pos === init.remainder.length) {
          if (isAcceptingState(state)) {
            const key = `${state.rootEntry.stem}:${state.pos}:${state.suffixes.join("+")}`;
            if (!seen.has(key)) {
              seen.add(key);
              analyses.push({
                valid: true,
                stem: state.rootEntry.stem,
                pos: state.pos,
                suffixes: state.suffixes.slice(),
              });
            }
          }
          continue;
        }

        const visitKey = `${state.fsmState}|${pos}|${state.lastVowel}|${state.isPoss3 ? 1 : 0}|${state.canSoftenSuffixK ? 1 : 0}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        const transitions = getTransitions(state);
        const remSlice = init.remainder.slice(pos);
        for (let i = 0; i < transitions.length; i++) {
          const tr = transitions[i];
          const suf = tr.consumedSurface;
          if (suf.length > 0 && remSlice.startsWith(suf)) {
            stack.push({ state: tr.nextState, pos: pos + suf.length });
          }
        }
      }
    }

    return analyses;
  }

  function isValidWord(word, trLexicon) {
    if (!word || typeof word !== "string") return false;
    const lower = trLower(word.trim());
    if (!lower) return false;
    // Reject non-Turkish alphabet characters
    if (!/^[a-zçğıöşüâîû]+(?:'[a-zçğıöşüâîû]+)?$/.test(lower)) return false;

    const idx = getLexiconIndex(trLexicon);
    if (idx.validCache.has(lower)) {
      return idx.validCache.get(lower);
    }

    let valid = false;
    // Direct root or validated surface word check (without apostrophe)
    if (idx.parsedRoots.has(lower)) {
      valid = true;
    } else if (idx.words && Object.prototype.hasOwnProperty.call(idx.words, lower)) {
      valid = true;
    } else {
      const analyses = runExactFSM(lower, idx);
      valid = analyses.length > 0;
    }

    if (idx.validCache.size > 4096) idx.validCache.clear();
    idx.validCache.set(lower, valid);
    return valid;
  }

  /**
   * Computes similarity cost between a noisy suffix chunk and an expected canonical suffix.
   * Handles assimilation (d<->t, c<->ç, g<->k), voicing (p<->b, t<->d, k<->ğ), and vowel harmony errors.
   */
  function matchFuzzySuffixPrefix(remFolded, expectedSuffix) {
    const expFold = trFold(expectedSuffix);
    if (remFolded.startsWith(expFold)) {
      return { consumed: expFold.length, cost: 0, hasVowelChange: false, hasConsonantChange: false, twoWayOnly: true };
    }
    if (remFolded.length < expFold.length) return null;

    // Same-length phonological slip check (e.g., "da" vs "ta", "dan" vs "tan", "ce" vs "çe", "ler" vs "lar")
    let cost = 0;
    let hasVowelChange = false;
    let hasConsonantChange = false;
    let twoWayOnly = true;
    const len = expFold.length;
    const VOICING_PAIR = { d: "t", t: "d", c: "ç", ç: "c", g: "k", k: "g", p: "b", b: "p" };
    const TWO_WAY_HARMONY = { a: "e", e: "a" };
    const FOUR_WAY_HARMONY = { i: "u", u: "i" };

    for (let i = 0; i < len; i++) {
      const a = remFolded[i];
      const b = expFold[i];
      if (a === b) continue;
      // Assimilation or voicing slip on consonant or k/g
      if (VOICING_PAIR[a] === b || VOICING_PAIR[b] === a) {
        cost += 0.25;
        hasConsonantChange = true;
      } else if (TWO_WAY_HARMONY[a] === b) {
        // Genuine 2-way Turkish vowel harmony slip (a <-> e, e.g. -lar/-ler, -da/-de)
        cost += 0.35;
        hasVowelChange = true;
      } else if (FOUR_WAY_HARMONY[a] === b) {
        // 4-way roundedness slip (ı/i <-> u/ü)
        cost += 0.4;
        hasVowelChange = true;
        twoWayOnly = false;
      } else {
        return null;
      }
      if (cost > 0.7) return null;
    }

    return { consumed: len, cost, hasVowelChange, hasConsonantChange, twoWayOnly };
  }

  function damerauLevenshtein(a, b) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 2) return 99;
    const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
    for (let i = 0; i <= la; i++) dp[i][0] = i;
    for (let j = 0; j <= lb; j++) dp[0][j] = j;
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          val = Math.min(val, dp[i - 2][j - 2] + 0.6);
        }
        dp[i][j] = val;
      }
    }
    return dp[la][lb];
  }

  function generateInflectedCandidates(word, trLexicon, maxResults = 5, options = {}) {
    if (!word || typeof word !== "string") return [];
    const lower = trLower(word.trim());
    if (!lower) return [];
    const folded = trFold(lower);
    const idx = getLexiconIndex(trLexicon);

    const bestByWord = new Map();
    const recordCandidate = (candWord, stem, score, reason, meta = null) => {
      if (!candWord || candWord === lower) return;
      const existing = bestByWord.get(candWord);
      if (!existing || score > existing.score) {
        const entry = { word: candWord, stem, score, reason };
        if (meta) {
          if (meta.hasVowelRepair !== undefined) entry.hasVowelRepair = meta.hasVowelRepair;
          if (meta.twoWayHarmonyOnly !== undefined) entry.twoWayHarmonyOnly = meta.twoWayHarmonyOnly;
        }
        bestByWord.set(candWord, entry);
      }
    };

    // 1. Folded & Phonological-Repair FSM (handles ASCII diacritic restoration + assimilation + voicing + vowel drop slips!)
    const initials = findInitialStates(folded, idx, true);
    for (const init of initials) {
      const baseFoldedMatchCost = trFold(init.state.surface) === folded.slice(0, folded.length - init.remainder.length) ? 0 : 0.2;
      if (init.remainder.length === 0) {
        if (isAcceptingState(init.state)) {
          const cand = init.state.surface;
          const exactDiacriticCount = countDiffChars(lower, cand);
          const freqBonus = idx.words && idx.words[cand] ? idx.words[cand] / 1000 : 0;
          recordCandidate(
            cand,
            init.state.rootEntry.stem,
            1.0 - exactDiacriticCount * 0.02 + freqBonus,
            "folded_root"
          );
        }
        continue;
      }

      const stack = [{
        state: init.state,
        pos: 0,
        cost: baseFoldedMatchCost,
        hasVowelRepair: baseFoldedMatchCost > 0,
        twoWayHarmonyOnly: baseFoldedMatchCost === 0,
      }];
      const visited = new Map();

      while (stack.length > 0) {
        const { state, pos, cost, hasVowelRepair, twoWayHarmonyOnly } = stack.pop();
        if (cost > 1.0) continue;

        if (pos === init.remainder.length) {
          if (isAcceptingState(state)) {
            const cand = state.surface;
            // Verify the generated surface word actually validates cleanly or came from strict FSM
            const freq = idx.words && idx.words[cand] ? idx.words[cand] : 0;
            const isKnownRoot = idx.parsedRoots.has(cand);
            const freqBonus = freq ? freq / 800 : 0;
            const rootBonus = isKnownRoot ? 0.12 : 0;
            const unattestedMultiSuffixPenalty = !freq && !isKnownRoot && state.suffixes.length >= 2 ? 0.08 : 0;
            const diacriticDiff = countDiffChars(lower, cand);
            const reason = cost > 0 ? "morph_repair" : "folded_morph";
            const score = Math.max(
              0.1,
              1.0 - cost * 0.45 - diacriticDiff * 0.015 + freqBonus + rootBonus - unattestedMultiSuffixPenalty
            );
            recordCandidate(cand, state.rootEntry.stem, score, reason, {
              hasVowelRepair,
              twoWayHarmonyOnly,
            });
          }
          continue;
        }

        const visitKey = `${state.fsmState}|${pos}|${state.lastVowel}|${state.isPoss3 ? 1 : 0}`;
        const prevCost = visited.get(visitKey);
        if (prevCost !== undefined && cost >= prevCost) continue;
        visited.set(visitKey, cost);

        const remSlice = init.remainder.slice(pos);
        const transitions = getTransitions(state);

        for (let i = 0; i < transitions.length; i++) {
          const tr = transitions[i];
          if (!tr.consumedSurface) continue;
          const m = matchFuzzySuffixPrefix(remSlice, tr.consumedSurface);
          if (m && cost + m.cost <= 1.0) {
            stack.push({
              state: tr.nextState,
              pos: pos + m.consumed,
              cost: cost + m.cost,
              hasVowelRepair: hasVowelRepair || m.hasVowelChange,
              twoWayHarmonyOnly: twoWayHarmonyOnly && m.twoWayOnly,
            });
          }
        }
      }
    }

    // 1b. Handle failed vowel drop or failed stem softening explicitly (e.g. "burunu" -> "burnu", "kitapı" -> "kitabı", "sehire" -> "şehre")
    for (let k = folded.length - 1; k >= 2; k--) {
      const prefix = folded.slice(0, k);
      const rem = folded.slice(k);
      const entries = idx.foldedRoots.get(prefix);
      if (!entries || !rem) continue;

      for (const entry of entries) {
        if (entry.flags.vd && VOWELS.has(rem[0])) {
          // Try re-inflecting from dropped stem
          const droppedSurface = dropLastVowel(entry.stem);
          const st = makeState(
            entry.pos === "V" ? "VERB_STEM" : "NOM_STEM",
            droppedSurface,
            getLastVowel(entry.stem),
            entry.pos,
            entry.flags,
            entry,
            [],
            { inverseHarmony: Boolean(entry.flags.ih), canSoftenStem: false }
          );
          const stack = [{ state: st, pos: 0, cost: 0.2 }];
          while (stack.length > 0) {
            const cur = stack.pop();
            if (cur.pos === rem.length && isAcceptingState(cur.state)) {
              const cand = cur.state.surface;
              const freqBonus = idx.words && idx.words[cand] ? idx.words[cand] / 1000 : 0;
              recordCandidate(cand, entry.stem, 0.88 + freqBonus, "vowel_drop_repair");
              continue;
            }
            const remSlice = rem.slice(cur.pos);
            for (const tr of getTransitions(cur.state)) {
              if (!tr.consumedSurface) continue;
              const m = matchFuzzySuffixPrefix(remSlice, tr.consumedSurface);
              if (m && cur.cost + m.cost <= 0.7) {
                stack.push({ state: tr.nextState, pos: cur.pos + m.consumed, cost: cur.cost + m.cost });
              }
            }
          }
        }
        if (canStemSoften(entry.stem, entry.pos, entry.flags) && VOWELS.has(rem[0])) {
          // Handle un-softened input like "kitapı" -> "kitabı"
          const st = makeState(
            entry.pos === "V" ? "VERB_STEM" : "NOM_STEM",
            entry.stem,
            getLastVowel(entry.stem),
            entry.pos,
            entry.flags,
            entry,
            [],
            { inverseHarmony: Boolean(entry.flags.ih), canSoftenStem: true }
          );
          const stack = [{ state: st, pos: 0, cost: 0.25 }];
          while (stack.length > 0) {
            const cur = stack.pop();
            if (cur.pos === rem.length && isAcceptingState(cur.state)) {
              const cand = cur.state.surface;
              const freqBonus = idx.words && idx.words[cand] ? idx.words[cand] / 1000 : 0;
              recordCandidate(cand, entry.stem, 0.85 + freqBonus, "voicing_repair");
              continue;
            }
            const remSlice = rem.slice(cur.pos);
            for (const tr of getTransitions(cur.state)) {
              if (!tr.consumedSurface) continue;
              const m = matchFuzzySuffixPrefix(remSlice, tr.consumedSurface);
              if (m && cur.cost + m.cost <= 0.7) {
                stack.push({ state: tr.nextState, pos: cur.pos + m.consumed, cost: cur.cost + m.cost });
              }
            }
          }
        }
      }
    }

    // 2. Stem-typo + Suffix-tail Re-inflection (e.g., "ktaplar" -> "kitaplar", "teşekürler" -> "teşekkürler", "kitpda" -> "kitapta")
    if (!options.foldedOnly && bestByWord.size < maxResults && lower.length >= 4) {
      const commonTailRegex =
        /(?:yorum|yorsun|yoruz|yorsunuz|yorlar|yor|acak|ecek|acağım|eceğim|acağız|eceğiz|dım|dim|dum|düm|tım|tim|tum|tüm|lar|ler|ımız|imiz|umuz|ümüz|larım|lerim|ları|leri|da|de|ta|te|dan|den|tan|ten|ya|ye|yı|yi|yu|yü|nın|nin|nun|nün|la|le|yla|yle|lık|lik|luk|lük)$/;
      const m = folded.match(commonTailRegex);
      if (m && m.index >= 2) {
        const stemTypo = folded.slice(0, m.index);
        const tailFolded = folded.slice(m.index);
        const nearRoots = [];
        for (const targetLen of [stemTypo.length, stemTypo.length - 1, stemTypo.length + 1]) {
          const bucket = idx.rootsByLen.get(targetLen);
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const [fRoot, entries] = bucket[i];
            if (fRoot[0] !== stemTypo[0] && fRoot[fRoot.length - 1] !== stemTypo[stemTypo.length - 1]) continue;
            const dist = damerauLevenshtein(stemTypo, fRoot);
            if (dist > 0 && dist <= 1.5) {
              nearRoots.push({ dist, entries });
              if (nearRoots.length >= 25) break;
            }
          }
          if (nearRoots.length >= 25) break;
        }
        nearRoots.sort((a, b) => a.dist - b.dist);

        for (const nr of nearRoots.slice(0, 8)) {
          for (const entry of nr.entries) {
            const st = makeState(
              entry.pos === "V" ? "VERB_STEM" : "NOM_STEM",
              entry.stem,
              getLastVowel(entry.stem),
              entry.pos,
              entry.flags,
              entry,
              [],
              {
                inverseHarmony: Boolean(entry.flags.ih),
                canSoftenStem: canStemSoften(entry.stem, entry.pos, entry.flags),
              }
            );
            const stack = [{ state: st, pos: 0, cost: nr.dist * 0.35 }];
            while (stack.length > 0) {
              const cur = stack.pop();
              if (cur.pos === tailFolded.length && isAcceptingState(cur.state)) {
                const cand = cur.state.surface;
                const freqBonus = idx.words && idx.words[cand] ? idx.words[cand] / 1200 : 0;
                recordCandidate(cand, entry.stem, Math.max(0.1, 0.8 - cur.cost + freqBonus), "stem_typo_reinflect");
                continue;
              }
              const remSlice = tailFolded.slice(cur.pos);
              for (const tr of getTransitions(cur.state)) {
                if (!tr.consumedSurface) continue;
                const fm = matchFuzzySuffixPrefix(remSlice, tr.consumedSurface);
                if (fm && cur.cost + fm.cost <= 0.9) {
                  stack.push({ state: tr.nextState, pos: cur.pos + fm.consumed, cost: cur.cost + fm.cost });
                }
              }
            }
          }
        }
      }
    }

    return Array.from(bestByWord.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  function countDiffChars(a, b) {
    if (a.length !== b.length) return Math.abs(a.length - b.length) + 1;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) d++;
    }
    return d;
  }

  function analyze(word, trLexicon) {
    if (!word || typeof word !== "string") return [{ valid: false }];
    const lower = trLower(word.trim());
    if (!lower) return [{ valid: false }];

    const idx = getLexiconIndex(trLexicon);
    const analyses = runExactFSM(lower, idx);
    if (analyses.length > 0) {
      return analyses;
    }

    // Check if present as a known surface word even if irregular
    if (idx.words && Object.prototype.hasOwnProperty.call(idx.words, lower)) {
      return [{ valid: true, stem: lower, pos: "N", suffixes: [] }];
    }

    const repairs = generateInflectedCandidates(lower, trLexicon, 1);
    if (repairs.length > 0) {
      return [
        {
          valid: false,
          stem: repairs[0].stem,
          reinflectSuggestion: repairs[0].word,
        },
      ];
    }

    return [{ valid: false }];
  }

  const TurkishMorphology = {
    isValidWord,
    analyze,
    generateInflectedCandidates,
    trLower,
    trFold,
  };

  NS.TurkishMorphology = TurkishMorphology;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TurkishMorphology;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

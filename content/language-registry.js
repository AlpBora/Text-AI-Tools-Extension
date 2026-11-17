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

  function genericLatinFold(str, diacriticMap) {
    let s = String(str).toLowerCase();
    if (diacriticMap) {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        out += diacriticMap[ch] || ch;
      }
      s = out;
    }
    return s
      .replace(/ß/g, "ss")
      .replace(/œ/g, "oe")
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/ł/g, "l")
      .replace(/đ/g, "d")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC");
  }

  function normalizeSlug(raw) {
    return trFold(String(raw || ""))
      .trim()
      .replace(/[_\s]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "");
  }

  const SCRIPT_REGEX = {
    cyrillic: /[\u0400-\u04FF]/,
    arabic: /[\u0600-\u06FF\u0750-\u077F]/,
    cjk: /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/,
    japanese: /[\u3040-\u309F\u30A0-\u30FF]/,
    hangul: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/,
    latin: /[a-zA-ZçğıöşüÇĞİÖŞÜâîûÂÎÛßäöüÄÖÜéèêëàùçœæñáíóúãõìò]/,
  };

  const PROFILES = new Map();
  const ALIAS_MAP = new Map();

  function buildProfile(def) {
    const diacriticMap = def.diacriticMap || {};
    const stopwords = def.stopwords instanceof Set ? def.stopwords : new Set(def.stopwords || []);
    const fold =
      def.fold ||
      (def.id === "tr"
        ? trFold
        : def.script === "latin"
          ? (str) => genericLatinFold(str, diacriticMap)
          : (str) => String(str).toLowerCase().normalize("NFKC"));

    return {
      id: def.id,
      displayName: def.displayName,
      aliases: def.aliases || [def.id, def.displayName.toLowerCase()],
      script: def.script || "latin",
      diacriticMap,
      fold,
      stopwords,
      uniqueChars: def.uniqueChars || "",
      softChars: def.softChars || "",
      hasBundledLexicon: Boolean(def.hasBundledLexicon),
      lexiconFile: def.lexiconFile || undefined,
    };
  }

  function registerLanguage(def) {
    const profile = buildProfile(def);
    PROFILES.set(profile.id, profile);
    ALIAS_MAP.set(profile.id, profile.id);
    ALIAS_MAP.set(normalizeSlug(profile.displayName), profile.id);
    for (const alias of profile.aliases) {
      const slug = normalizeSlug(alias);
      if (slug) ALIAS_MAP.set(slug, profile.id);
      const rawLower = String(alias).trim().toLowerCase();
      if (rawLower) ALIAS_MAP.set(rawLower, profile.id);
    }
    return profile;
  }

  const BUILTIN_DEFS = [
    {
      id: "tr",
      displayName: "Turkish",
      aliases: ["tr", "tr-tr", "tur", "turkish", "türkçe", "turkce"],
      script: "latin",
      diacriticMap: { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" },
      uniqueChars: "ğşçıİ",
      softChars: "çöüâîû",
      stopwords: [
        "bir", "bu", "ve", "için", "mi", "mı", "mu", "mü", "de", "da", "o", "ben", "sen",
        "biz", "siz", "onlar", "çok", "ama", "evet", "hayır", "var", "yok", "değil", "şey",
        "daha", "kadar", "gibi", "iyi", "tamam", "her", "ki", "ya", "neden", "zaman", "sadece",
        "burada", "nasıl", "hiç", "sonra", "şimdi", "en", "öyle", "şu", "ile", "olarak", "olan",
        "ancak", "veya", "hem", "ise", "diye", "beni", "seni", "bana", "sana", "benim", "senin",
      ],
      hasBundledLexicon: true,
      lexiconFile: "shared/lexicons/tr.json",
    },
    {
      id: "en",
      displayName: "English",
      aliases: ["en", "en-us", "en-gb", "eng", "english", "ingilizce", "i̇ngilizce"],
      script: "latin",
      diacriticMap: {},
      uniqueChars: "",
      softChars: "",
      stopwords: [
        "the", "and", "is", "are", "was", "were", "be", "been", "to", "of", "in", "for", "on",
        "that", "this", "with", "you", "have", "has", "had", "from", "not", "but", "they",
        "what", "which", "she", "he", "it", "we", "they", "my", "your", "his", "her", "our",
        "their", "would", "could", "should", "will", "can", "about", "there", "here", "when",
        "where", "why", "how", "all", "just", "very", "please", "thank", "thanks", "hello",
      ],
      hasBundledLexicon: true,
      lexiconFile: "shared/lexicons/en.json",
    },
    {
      id: "de",
      displayName: "German",
      aliases: ["de", "de-de", "de-at", "deu", "ger", "german", "deutsch", "almanca"],
      script: "latin",
      diacriticMap: { ä: "a", ö: "o", ü: "u", ß: "ss" },
      uniqueChars: "ß",
      softChars: "äöü",
      stopwords: [
        "der", "die", "das", "und", "ist", "sind", "war", "nicht", "mit", "für", "auf", "ein",
        "eine", "einen", "einem", "ich", "du", "er", "sie", "wir", "ihr", "es", "zu", "von",
        "im", "in", "den", "dem", "des", "auch", "noch", "aber", "oder", "wie", "wenn", "als",
        "sehr", "bitte", "danke", "hallo", "guten", "haben", "werden", "kann", "muss",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "fr",
      displayName: "French",
      aliases: ["fr", "fr-fr", "fr-ca", "fra", "fre", "french", "français", "francais", "fransızca", "fransizca"],
      script: "latin",
      diacriticMap: { à: "a", â: "a", é: "e", è: "e", ê: "e", ë: "e", î: "i", ï: "i", ô: "o", ù: "u", û: "u", ü: "u", ÿ: "y", ç: "c", œ: "oe", æ: "ae" },
      uniqueChars: "œæêèàù",
      softChars: "éçîïôû",
      stopwords: [
        "le", "la", "les", "de", "des", "du", "un", "une", "et", "est", "sont", "pour", "dans",
        "pas", "que", "qui", "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "avec",
        "sur", "au", "aux", "ce", "cette", "ces", "mais", "ou", "donc", "très", "bonjour", "merci",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "es",
      displayName: "Spanish",
      aliases: ["es", "es-es", "es-419", "spa", "spanish", "español", "espanol", "ispanyolca", "İspanyolca"],
      script: "latin",
      diacriticMap: { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n" },
      uniqueChars: "ñ¿¡",
      softChars: "áéíóú",
      stopwords: [
        "el", "la", "los", "las", "de", "del", "y", "es", "son", "en", "para", "con", "por",
        "que", "un", "una", "unos", "unas", "no", "si", "sí", "yo", "tú", "él", "ella", "nosotros",
        "pero", "como", "muy", "hola", "gracias", "buenos", "esta", "este", "está", "todo",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "it",
      displayName: "Italian",
      aliases: ["it", "it-it", "ita", "italian", "italiano", "italyanca", "İtalyanca"],
      script: "latin",
      diacriticMap: { à: "a", è: "e", é: "e", ì: "i", ò: "o", ù: "u" },
      uniqueChars: "ìò",
      softChars: "àèéù",
      stopwords: [
        "il", "lo", "la", "i", "gli", "le", "di", "del", "della", "un", "una", "uno", "e",
        "è", "sono", "che", "non", "per", "con", "in", "su", "da", "a", "ma", "come", "molto",
        "ciao", "grazie", "prego", "questo", "questa", "tutto", "tutti",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "pt",
      displayName: "Portuguese",
      aliases: ["pt", "pt-br", "pt-pt", "por", "portuguese", "português", "portugues", "portekizce"],
      script: "latin",
      diacriticMap: { á: "a", à: "a", â: "a", ã: "a", é: "e", ê: "e", í: "i", ó: "o", ô: "o", õ: "o", ú: "u", ç: "c" },
      uniqueChars: "ãõ",
      softChars: "áâêéíóôúç",
      stopwords: [
        "o", "a", "os", "as", "de", "do", "da", "dos", "das", "e", "é", "são", "em", "no", "na",
        "para", "com", "por", "que", "um", "uma", "não", "sim", "mas", "como", "muito", "olá",
        "obrigado", "obrigada", "você", "eu", "ele", "ela", "nós", "tudo", "bem",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "nl",
      displayName: "Dutch",
      aliases: ["nl", "nl-nl", "nl-be", "nld", "dut", "dutch", "nederlands", "hollandaca", "felemenkçe", "felemenkce"],
      script: "latin",
      diacriticMap: { é: "e", ë: "e", ï: "i", ö: "o", ü: "u" },
      uniqueChars: "",
      softChars: "ëï",
      stopwords: [
        "de", "het", "een", "en", "van", "ik", "te", "dat", "die", "in", "is", "zijn", "niet",
        "op", "voor", "met", "als", "maar", "om", "aan", "er", "hij", "zij", "wij", "jij",
        "u", "ook", "wel", "naar", "bij", "wat", "hallo", "dank", "bedankt",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "ru",
      displayName: "Russian",
      aliases: ["ru", "ru-ru", "rus", "russian", "русский", "rusça", "rusca"],
      script: "cyrillic",
      diacriticMap: { ё: "е" },
      uniqueChars: "",
      softChars: "",
      stopwords: [
        "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все",
        "она", "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "только",
        "ее", "мне", "было", "вот", "от", "меня", "еще", "нет", "о", "из", "привет", "спасибо",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "ar",
      displayName: "Arabic",
      aliases: ["ar", "ar-sa", "ara", "arabic", "العربية", "arapça", "arapca"],
      script: "arabic",
      diacriticMap: {},
      uniqueChars: "",
      softChars: "",
      stopwords: [
        "في", "من", "على", "إلى", "عن", "مع", "هذا", "هذه", "التي", "الذي", "أن", "إن",
        "كان", "لا", "ما", "هو", "هي", "نحن", "أنت", "و", "أو", "ثم", "لكن", "شكرا", "مرحبا",
      ],
      hasBundledLexicon: false,
    },
    {
      id: "ja",
      displayName: "Japanese",
      aliases: ["ja", "ja-jp", "jpn", "japanese", "日本語", "japonca"],
      script: "cjk",
      diacriticMap: {},
      uniqueChars: "",
      softChars: "",
      stopwords: ["です", "ます", "した", "ない", "ある", "いる", "これ", "それ", "この", "その", "わたし", "あなた", "ありがとう"],
      hasBundledLexicon: false,
    },
    {
      id: "ko",
      displayName: "Korean",
      aliases: ["ko", "ko-kr", "kor", "korean", "한국어", "korece"],
      script: "hangul",
      diacriticMap: {},
      uniqueChars: "",
      softChars: "",
      stopwords: ["나는", "내가", "그리고", "하지만", "입니다", "있습니다", "합니다", "감사합니다", "안녕하세요", "이것", "그것"],
      hasBundledLexicon: false,
    },
    {
      id: "zh",
      displayName: "Chinese",
      aliases: ["zh", "zh-cn", "zh-tw", "zho", "chi", "chinese", "mandarin", "中文", "汉语", "çince", "cince"],
      script: "cjk",
      diacriticMap: {},
      uniqueChars: "",
      softChars: "",
      stopwords: ["的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "我们", "你们", "谢谢", "你好"],
      hasBundledLexicon: false,
    },
  ];

  for (const def of BUILTIN_DEFS) {
    registerLanguage(def);
  }

  function normalizeLang(nameOrCode) {
    if (!nameOrCode || typeof nameOrCode !== "string") return "";
    const trimmed = nameOrCode.trim();
    if (!trimmed) return "";

    const rawLower = trimmed.toLowerCase();
    if (ALIAS_MAP.has(rawLower)) return ALIAS_MAP.get(rawLower);

    const trLowerVal = trLower(trimmed);
    if (ALIAS_MAP.has(trLowerVal)) return ALIAS_MAP.get(trLowerVal);

    const slug = normalizeSlug(trimmed);
    if (ALIAS_MAP.has(slug)) return ALIAS_MAP.get(slug);

    // Handle BCP-47 tags like "fr-FR" or "de_AT" -> prefix if registered
    const bcpPrefix = slug.split("-")[0];
    if (bcpPrefix && ALIAS_MAP.has(bcpPrefix)) return ALIAS_MAP.get(bcpPrefix);

    return slug || rawLower;
  }

  function createGenericFallbackProfile(langId, rawInput) {
    const id = langId || "unknown";
    const displayName =
      typeof rawInput === "string" && rawInput.trim()
        ? rawInput.trim()
        : id.charAt(0).toUpperCase() + id.slice(1);
    return buildProfile({
      id,
      displayName,
      aliases: [id],
      script: "latin",
      diacriticMap: {},
      stopwords: [],
      hasBundledLexicon: false,
    });
  }

  function getProfile(langId) {
    const normalized = normalizeLang(langId);
    if (!normalized) {
      return createGenericFallbackProfile("unknown", langId);
    }
    if (PROFILES.has(normalized)) {
      return PROFILES.get(normalized);
    }
    return createGenericFallbackProfile(normalized, langId);
  }

  function hasLexiconWord(lexicon, wordLower, profile) {
    if (!lexicon) return { exact: false, folded: false };
    const words = lexicon.words;
    const roots = lexicon.roots;

    if (words && Object.prototype.hasOwnProperty.call(words, wordLower)) {
      return { exact: true, folded: true };
    }
    if (roots && Object.prototype.hasOwnProperty.call(roots, wordLower)) {
      return { exact: true, folded: true };
    }

    // If Turkish morphology is loaded on global namespace, validate inflected forms!
    if (profile.id === "tr" && NS.TurkishMorphology && typeof NS.TurkishMorphology.isValidWord === "function") {
      if (NS.TurkishMorphology.isValidWord(wordLower, lexicon)) {
        return { exact: true, folded: true };
      }
    }

    // Check folded cache on lexicon if Latin
    if (profile.script === "latin" && words) {
      let foldedSet = lexicon.__foldedWordSet;
      if (!foldedSet) {
        foldedSet = new Set();
        for (const w in words) {
          foldedSet.add(profile.fold(w));
        }
        if (roots) {
          for (const r in roots) {
            foldedSet.add(profile.fold(r));
          }
        }
        try {
          Object.defineProperty(lexicon, "__foldedWordSet", { value: foldedSet, enumerable: false });
        } catch {
          // ignore if frozen
        }
      }
      if (foldedSet.has(profile.fold(wordLower))) {
        return { exact: false, folded: true };
      }
    }

    return { exact: false, folded: false };
  }

  function scoreTokenForProfile(token, profile, lexicon) {
    let score = 0;
    const lower = profile.id === "tr" ? trLower(token) : String(token).toLowerCase();

    // 1. Script check
    if (profile.script === "cyrillic") {
      if (SCRIPT_REGEX.cyrillic.test(token)) score += 8;
      else if (SCRIPT_REGEX.latin.test(token)) score -= 2;
      return score;
    }
    if (profile.script === "arabic") {
      if (SCRIPT_REGEX.arabic.test(token)) score += 8;
      else if (SCRIPT_REGEX.latin.test(token)) score -= 2;
      return score;
    }
    if (profile.script === "hangul") {
      if (SCRIPT_REGEX.hangul.test(token)) score += 8;
      else if (SCRIPT_REGEX.latin.test(token)) score -= 2;
      return score;
    }
    if (profile.script === "cjk") {
      if (profile.id === "ja" && SCRIPT_REGEX.japanese.test(token)) score += 10;
      else if (SCRIPT_REGEX.cjk.test(token)) score += 8;
      else if (SCRIPT_REGEX.latin.test(token)) score -= 2;
      return score;
    }

    // Latin-script scoring
    if (
      SCRIPT_REGEX.cyrillic.test(token) ||
      SCRIPT_REGEX.arabic.test(token) ||
      SCRIPT_REGEX.cjk.test(token) ||
      SCRIPT_REGEX.hangul.test(token)
    ) {
      return -2;
    }

    // Unique character markers
    if (profile.uniqueChars) {
      for (let i = 0; i < token.length; i++) {
        if (profile.uniqueChars.includes(token[i])) {
          score += 3.5;
        }
      }
    }
    if (profile.softChars) {
      for (let i = 0; i < token.length; i++) {
        if (profile.softChars.includes(token[i])) {
          score += 1.4;
        }
      }
    }

    // Turkish-specific negative signal for q/w/x
    if (profile.id === "tr" && /[qwxQWX]/.test(token)) {
      score -= 2.0;
    }
    // English-specific negative signal for non-ASCII Turkish/German/Spanish letters
    if (profile.id === "en" && /[çğıöşüÇĞİÖŞÜßñ¿¡]/.test(token)) {
      score -= 2.5;
    }

    // Stopword hit
    if (profile.stopwords.has(lower)) {
      score += 2.8;
    } else if (profile.id === "tr" && !/[qwxQWX]/.test(token)) {
      // Check ASCII-folded Turkish stopwords (e.g., "cok", "icin", "degil")
      const folded = trFold(lower);
      if (folded !== lower || /^[a-z]+$/.test(lower)) {
        let foldedStops = profile.__foldedStops;
        if (!foldedStops) {
          foldedStops = new Set();
          for (const sw of profile.stopwords) foldedStops.add(trFold(sw));
          profile.__foldedStops = foldedStops;
        }
        if (foldedStops.has(folded)) {
          // Only give moderate ASCII stopword boost if it isn't an English stopword
          const enProf = PROFILES.get("en");
          if (!enProf || !enProf.stopwords.has(lower)) {
            score += 1.2;
          }
        }
      }
    }

    // Dutch "ij" bigram mild signal
    if (profile.id === "nl" && /ij/.test(lower)) {
      score += 1.0;
    }

    // Lexicon hit
    if (lexicon) {
      const hit = hasLexiconWord(lexicon, lower, profile);
      if (hit.exact) score += 1.8;
      else if (hit.folded) score += 0.8;
    }

    return score;
  }

  function detectContextLanguage(tokens, primaryLang, secondaryLang, lexiconsByLang) {
    const tokenList = Array.isArray(tokens)
      ? tokens.filter((t) => typeof t === "string" && t.trim().length > 0)
      : typeof tokens === "string"
        ? tokens.trim().split(/\s+/).filter(Boolean)
        : [];

    const primaryId = normalizeLang(primaryLang) || "tr";
    const secondaryId = normalizeLang(secondaryLang);

    const candidateSet = new Set([primaryId]);
    if (secondaryId && secondaryId !== primaryId) {
      candidateSet.add(secondaryId);
    }

    // Also evaluate any loaded lexicons or non-Latin scripts detected in tokens
    if (lexiconsByLang && typeof lexiconsByLang === "object") {
      for (const k of Object.keys(lexiconsByLang)) {
        const nk = normalizeLang(k);
        if (nk) candidateSet.add(nk);
      }
    }
    const joined = tokenList.join(" ");
    if (SCRIPT_REGEX.cyrillic.test(joined)) candidateSet.add("ru");
    if (SCRIPT_REGEX.arabic.test(joined)) candidateSet.add("ar");
    if (SCRIPT_REGEX.hangul.test(joined)) candidateSet.add("ko");
    if (SCRIPT_REGEX.japanese.test(joined)) candidateSet.add("ja");
    else if (SCRIPT_REGEX.cjk.test(joined)) candidateSet.add("zh");

    const scores = {};
    for (const langId of candidateSet) {
      const profile = getProfile(langId);
      const lexicon =
        (lexiconsByLang && (lexiconsByLang[langId] || lexiconsByLang[profile.id])) || null;
      let s = 0;
      for (const tok of tokenList) {
        s += scoreTokenForProfile(tok, profile, lexicon);
      }
      // Small tie-breaker bias preserving configured primary > secondary order
      if (langId === primaryId) s += 0.25;
      else if (langId === secondaryId) s += 0.1;
      scores[langId] = Number(s.toFixed(3));
    }

    const orderedLangs = Array.from(candidateSet).sort((a, b) => {
      if (scores[b] !== scores[a]) return scores[b] - scores[a];
      if (a === primaryId) return -1;
      if (b === primaryId) return 1;
      if (a === secondaryId) return -1;
      if (b === secondaryId) return 1;
      return a.localeCompare(b);
    });

    return {
      primary: orderedLangs[0] || primaryId,
      orderedLangs,
      scores,
    };
  }

  const LanguageRegistry = {
    normalizeLang,
    getProfile,
    detectContextLanguage,
    registerLanguage,
    listSupportedLanguages: () => Array.from(PROFILES.keys()),
    trLower,
    trFold,
  };

  NS.LanguageRegistry = LanguageRegistry;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LanguageRegistry;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);

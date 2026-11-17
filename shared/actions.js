export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_PRIMARY_LANGUAGE = "Turkish";
export const DEFAULT_SECONDARY_LANGUAGE = "English";
export const SUPPORTED_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-flash-lite-latest"
];

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  primaryLanguage: DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage: DEFAULT_SECONDARY_LANGUAGE,
  copyOnReplace: true,
  spellcheckEnabled: true,
  autoCorrectEnabled: true
};

export const ACTIONS = {
  fix: {
    id: "fix",
    title: "Fix & Paste Text",
    shortTitle: "Fix & Paste",
    mode: "replace",
    dialogTitle: "Fixed Text",
    copiedNotice: "Fixed text copied to clipboard.",
    systemPrompt:
      "Detect the language of the following text. Fix spelling, grammar, and punctuation to make it natural, fluent, and clear in that same language. Do not overuse punctuation. Output only the corrected text, with no extra explanation."
  },
  professional: {
    id: "professional",
    title: "Make Text Professional",
    shortTitle: "Professional",
    mode: "replace",
    dialogTitle: "Professional Text",
    copiedNotice: "Professional text copied to clipboard.",
    systemPrompt:
      "Detect the language of the following text. Rewrite it in a more formal, polite, and professional tone in that same language without changing its meaning. Output only the rewritten text, with no extra explanation."
  },
  translate: {
    id: "translate",
    title: "Translate Text",
    shortTitle: "Translate",
    mode: "modal",
    dialogTitle: "Translation",
    copiedNotice: "Translation copied to clipboard."
  },
  summarize: {
    id: "summarize",
    title: "Summarize Text",
    shortTitle: "Summarize",
    mode: "modal",
    dialogTitle: "Summary",
    copiedNotice: "Summary copied to clipboard."
  }
};

class GeminiRequestError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 503]);

const SENTENCE_SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    options: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["grammar", "fluency", "professional"]
          },
          label: { type: "string" },
          text: { type: "string" },
          explanation: { type: "string" }
        },
        required: ["category", "label", "text"],
        additionalProperties: false
      }
    }
  },
  required: ["options"],
  additionalProperties: false
};

const CONTEXTUAL_WORD_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          reason: { type: "string" }
        },
        required: ["word"],
        additionalProperties: false
      }
    }
  },
  required: ["suggestions"],
  additionalProperties: false
};

export function buildSystemPrompt(actionId, { primaryLanguage, secondaryLanguage } = {}) {
  const primary = (primaryLanguage || DEFAULT_PRIMARY_LANGUAGE).trim() || DEFAULT_PRIMARY_LANGUAGE;
  const secondary = (secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE).trim() || DEFAULT_SECONDARY_LANGUAGE;

  if (actionId === "translate") {
    return `Detect the language of the following text. If the text is in ${primary}, translate it naturally and fluently into ${secondary}. Otherwise, translate it naturally and fluently into ${primary}. Output only the translation, with no extra explanation.`;
  }
  if (actionId === "summarize") {
    return `Summarize the following text in ${primary} as short, clear, and concise bullet points. Output only the summary, without any introductory or closing sentences.`;
  }
  return ACTIONS[actionId]?.systemPrompt || "";
}

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    apiKey: (data.apiKey || "").trim(),
    model: (data.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    primaryLanguage: (data.primaryLanguage || DEFAULT_PRIMARY_LANGUAGE).trim() || DEFAULT_PRIMARY_LANGUAGE,
    secondaryLanguage: (data.secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE).trim() || DEFAULT_SECONDARY_LANGUAGE,
    copyOnReplace: Boolean(data.copyOnReplace),
    spellcheckEnabled: data.spellcheckEnabled !== undefined ? Boolean(data.spellcheckEnabled) : true,
    autoCorrectEnabled: data.autoCorrectEnabled !== undefined ? Boolean(data.autoCorrectEnabled) : true
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStructuredJson(rawText) {
  const trimmed = String(rawText || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // Fall through to GeminiRequestError
      }
    }
    throw new GeminiRequestError("Failed to parse structured JSON from Gemini response.", {
      retryable: false
    });
  }
}

async function requestGemini({
  apiKey,
  model = DEFAULT_MODEL,
  systemPrompt,
  userText,
  generationConfig = null,
  retryBaseDelayMs = 2000
}) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    throw new GeminiRequestError("Gemini API key is not configured.", { retryable: false });
  }
  if (!userText || !String(userText).trim()) {
    throw new GeminiRequestError("Select or enter some text first.", { retryable: false });
  }
  if (
    String(userText).trim() === cleanKey ||
    (cleanKey.length >= 12 && String(userText).includes(cleanKey))
  ) {
    throw new GeminiRequestError("API key detected in text; aborted for safety.", { retryable: false });
  }

  const resolvedModel = (model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    resolvedModel
  )}:generateContent`;

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: String(userText) }] }]
  };
  if (generationConfig && Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }
  const body = JSON.stringify(payload);

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": cleanKey,
          "Content-Type": "application/json"
        },
        body,
        signal: controller.signal
      });

      if (!res.ok) {
        const detail = await res.text();
        const isRetryable = RETRYABLE_HTTP_STATUSES.has(res.status);
        if (isRetryable && attempt < 2) {
          if (retryBaseDelayMs > 0) {
            await sleep(retryBaseDelayMs * (attempt + 1));
          }
          continue;
        }
        throw new GeminiRequestError(`HTTP ${res.status}: ${detail}`, {
          status: res.status,
          retryable: isRetryable
        });
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) {
        throw new GeminiRequestError("Failed to parse Gemini response.", { retryable: false });
      }
      const output = parts.map((p) => p?.text || "").join("");
      if (!output) {
        throw new GeminiRequestError("Gemini returned an empty response.", { retryable: false });
      }
      return output;
    } catch (err) {
      lastError = err;
      if (err?.retryable === false || attempt === 2) {
        throw lastError;
      }
      if (retryBaseDelayMs > 0) {
        await sleep(retryBaseDelayMs * (attempt + 1));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError || new Error("Gemini API request failed.");
}

export async function callGemini({
  apiKey,
  model = DEFAULT_MODEL,
  actionId,
  text,
  primaryLanguage = DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage = DEFAULT_SECONDARY_LANGUAGE,
  retryBaseDelayMs = 2000
}) {
  const action = ACTIONS[actionId];
  if (!action) {
    throw new Error(`Unknown action: ${actionId}`);
  }

  const systemPrompt = buildSystemPrompt(actionId, { primaryLanguage, secondaryLanguage });
  return requestGemini({
    apiKey,
    model,
    systemPrompt,
    userText: text,
    retryBaseDelayMs
  });
}

export async function fetchSentenceSuggestions({
  text,
  mode = "sentence",
  primaryLanguage = DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage = DEFAULT_SECONDARY_LANGUAGE,
  apiKey,
  model = DEFAULT_MODEL,
  retryBaseDelayMs = 2000
}) {
  const primary = (primaryLanguage || DEFAULT_PRIMARY_LANGUAGE).trim() || DEFAULT_PRIMARY_LANGUAGE;
  const secondary = (secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE).trim() || DEFAULT_SECONDARY_LANGUAGE;
  const targetLabel = mode === "selection" ? "selected text" : "single sentence";

  const systemPrompt = [
    `You are an expert writing assistant for a bilingual user (${primary} and ${secondary}).`,
    `Analyze ONLY the provided ${targetLabel}. Detect its language and keep the output in that same language.`,
    `Return 2 to 4 practical rewrite options covering "grammar" (fixing spelling/grammar/punctuation), "fluency" (more natural/clear phrasing), and "professional" (polite/formal wording).`,
    `Each option's "text" must be a complete drop-in replacement for ONLY that ${targetLabel}, with no surrounding quotes or commentary.`,
    `Provide a short "label" (2-4 words) and a brief optional "explanation".`
  ].join(" ");

  const raw = await requestGemini({
    apiKey,
    model,
    systemPrompt,
    userText: text,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: SENTENCE_SUGGESTIONS_SCHEMA
    },
    retryBaseDelayMs
  });

  const parsed = parseStructuredJson(raw);
  const allowedCategories = new Set(["grammar", "fluency", "professional"]);
  const rawOptions = Array.isArray(parsed?.options) ? parsed.options : [];
  const options = rawOptions
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => {
      const category = allowedCategories.has(item.category) ? item.category : "grammar";
      const label =
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim()
          : category.charAt(0).toUpperCase() + category.slice(1);
      const entry = {
        category,
        label,
        text: item.text.trim()
      };
      if (typeof item.explanation === "string" && item.explanation.trim()) {
        entry.explanation = item.explanation.trim();
      }
      return entry;
    });

  if (options.length === 0) {
    throw new GeminiRequestError("Gemini returned no valid sentence suggestions.", {
      retryable: false
    });
  }

  return { options };
}

export async function fetchContextualWordSuggestions({
  sentence,
  targetWord,
  primaryLanguage = DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage = DEFAULT_SECONDARY_LANGUAGE,
  apiKey,
  model = DEFAULT_MODEL,
  retryBaseDelayMs = 2000
}) {
  const cleanTarget = String(targetWord || "").trim();
  const cleanSentence = String(sentence || "").trim();
  if (!cleanTarget) {
    throw new GeminiRequestError("Target word is required.", { retryable: false });
  }
  if (!cleanSentence) {
    throw new GeminiRequestError("Sentence context is required.", { retryable: false });
  }

  const primary = (primaryLanguage || DEFAULT_PRIMARY_LANGUAGE).trim() || DEFAULT_PRIMARY_LANGUAGE;
  const secondary = (secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE).trim() || DEFAULT_SECONDARY_LANGUAGE;

  const systemPrompt = [
    `You help a bilingual writer (${primary} and ${secondary}) find the exact intended word when they typed an approximate, phonetic, or misspelled token.`,
    `Given the sentence context and the target token, infer the intended meaning and return 3 to 5 replacement words ranked from most likely to least likely.`,
    `Match the language, inflection, and casing of the sentence context. Return only single-word (or tight compound) replacements in "word" and a concise "reason".`
  ].join(" ");

  const userText = `Sentence context: ${cleanSentence}\nTarget word: ${cleanTarget}`;

  const raw = await requestGemini({
    apiKey,
    model,
    systemPrompt,
    userText,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: CONTEXTUAL_WORD_SCHEMA
    },
    retryBaseDelayMs
  });

  const parsed = parseStructuredJson(raw);
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const suggestions = rawSuggestions
    .filter((item) => item && typeof item.word === "string" && item.word.trim())
    .map((item) => {
      const entry = { word: item.word.trim() };
      if (typeof item.reason === "string" && item.reason.trim()) {
        entry.reason = item.reason.trim();
      }
      return entry;
    });

  if (suggestions.length === 0) {
    throw new GeminiRequestError("Gemini returned no contextual word suggestions.", {
      retryable: false
    });
  }

  return { suggestions };
}

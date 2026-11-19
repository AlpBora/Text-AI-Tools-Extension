export const DEFAULT_PROVIDER = "gemini";
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_PRIMARY_LANGUAGE = "Turkish";
export const DEFAULT_SECONDARY_LANGUAGE = "English";
export const AI_PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-3.5-flash-lite",
    defaultAskModel: "gemini-3.8-flash",
    models: [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-flash-lite-latest"
    ],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresKey: true,
    apiKeyPlaceholder: "AIza..."
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    defaultAskModel: "gpt-4.1",
    models: ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.1", "gpt-4o-mini", "o4-mini"],
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    apiKeyPlaceholder: "sk-..."
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openrouter/free",
    defaultAskModel: "openrouter/free",
    models: [
      "openrouter/free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-3-27b-it:free",
      "qwen/qwen3-32b:free"
    ],
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    apiKeyPlaceholder: "sk-or-v1-..."
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-3-5-haiku-latest",
    defaultAskModel: "claude-sonnet-4-0",
    models: [
      "claude-3-5-haiku-latest",
      "claude-sonnet-4-0",
      "claude-3-7-sonnet-latest"
    ],
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    apiKeyPlaceholder: "sk-ant-..."
  },
  groq: {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.1-8b-instant",
    defaultAskModel: "llama-3.3-70b-versatile",
    models: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    apiKeyPlaceholder: "gsk_..."
  },
  custom: {
    id: "custom",
    label: "Custom / Local (OpenAI-Compatible)",
    defaultModel: "llama3.2",
    defaultAskModel: "llama3.2",
    models: ["llama3.2", "qwen2.5:7b", "gemma3"],
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    apiKeyPlaceholder: "Optional for local Ollama / LM Studio"
  }
};
export const SUPPORTED_MODELS = AI_PROVIDERS.gemini.models;

export function detectProviderFromApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return null;
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("sk-")) return "openai";
  return null;
}

export function resolveProviderConfig(provider = DEFAULT_PROVIDER, customBaseUrl = "") {
  const profile = AI_PROVIDERS[provider] || AI_PROVIDERS[DEFAULT_PROVIDER];
  const baseUrl =
    profile.id === "custom"
      ? (String(customBaseUrl || "").trim() || profile.baseUrl).replace(/\/+$/, "")
      : profile.baseUrl;
  return { ...profile, baseUrl };
}

export const DEFAULT_SETTINGS = {
  uiLanguage: "en",
  provider: DEFAULT_PROVIDER,
  customBaseUrl: "",
  apiKey: "",
  model: DEFAULT_MODEL,
  askModel: "",
  primaryLanguage: DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage: DEFAULT_SECONDARY_LANGUAGE,
  copyOnReplace: true,
  spellcheckEnabled: true,
  autoCorrectEnabled: true
};

export const ACTIONS = {
  fix: {
    id: "fix",
    title: "Proofread Text",
    shortTitle: "Proofread",
    mode: "replace",
    dialogTitle: "Proofread Text",
    copiedNotice: "Proofread text copied to clipboard.",
    systemPrompt:
      "Detect the language of the following text. Proofread and fix spelling, grammar, and punctuation to make it natural, fluent, and clear in that same language without changing the meaning or tone. Do not overuse punctuation. Output only the corrected text, with no extra explanation."
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
  },
  keypoints: {
    id: "keypoints",
    title: "Extract Key Points",
    shortTitle: "Key Points",
    mode: "modal",
    dialogTitle: "Key Points",
    copiedNotice: "Key points copied to clipboard."
  },
  concise: {
    id: "concise",
    title: "Shorten Text (Keep Meaning)",
    shortTitle: "Shorten",
    mode: "replace",
    dialogTitle: "Shortened Text",
    copiedNotice: "Shortened text copied to clipboard.",
    systemPrompt:
      "Detect the language of the following text. Rewrite it in the same language to be more concise with fewer characters by removing filler words and redundancy, while strictly preserving the original structure, tone, and full meaning without omitting any key information. Output only the shortened text, with no extra explanation."
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
    return `Summarize the following text in ${primary} as a concise, cohesive paragraph of 2 to 4 sentences (no bullet points). Capture the overall meaning clearly. Output only the summary paragraph, with no introductory or closing sentences.`;
  }
  if (actionId === "keypoints") {
    return `Extract the key points and main takeaways from the following text in ${primary} as a crisp bulleted list (use "- " bullets, 3 to 6 short items focusing on core facts, decisions, or action items). Output only the bullet points, with no introductory or closing sentences.`;
  }
  return ACTIONS[actionId]?.systemPrompt || "";
}

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const provider = AI_PROVIDERS[data.provider] ? data.provider : DEFAULT_PROVIDER;
  const profile = AI_PROVIDERS[provider];
  return {
    uiLanguage: data.uiLanguage === "tr" ? "tr" : "en",
    provider,
    customBaseUrl: (data.customBaseUrl || "").trim(),
    apiKey: (data.apiKey || "").trim(),
    model: (data.model || profile.defaultModel).trim() || profile.defaultModel,
    askModel: (data.askModel || "").trim(),
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

function parseStructuredJson(rawText, providerLabel = "AI provider") {
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
    throw new GeminiRequestError(`Failed to parse structured JSON from ${providerLabel} response.`, {
      retryable: false
    });
  }
}

async function requestAI({
  provider = DEFAULT_PROVIDER,
  customBaseUrl = "",
  apiKey,
  model,
  systemPrompt,
  userText,
  generationConfig = null,
  jsonMode = false,
  retryBaseDelayMs = 2000
}) {
  const providerCfg = resolveProviderConfig(provider, customBaseUrl);
  const cleanKey = (apiKey || "").trim();
  if (providerCfg.requiresKey && !cleanKey) {
    throw new GeminiRequestError(`${providerCfg.label} API key is not configured.`, { retryable: false });
  }
  if (!userText || !String(userText).trim()) {
    throw new GeminiRequestError("Select or enter some text first.", { retryable: false });
  }
  if (
    cleanKey &&
    (String(userText).trim() === cleanKey ||
      (cleanKey.length >= 12 && String(userText).includes(cleanKey)))
  ) {
    throw new GeminiRequestError("API key detected in text; aborted for safety.", { retryable: false });
  }

  const resolvedModel = (model || providerCfg.defaultModel).trim() || providerCfg.defaultModel;
  const isGemini = providerCfg.id === "gemini";
  const isAnthropic = providerCfg.id === "anthropic";

  let endpoint;
  let headers;
  let payload;
  if (isGemini) {
    endpoint = `${providerCfg.baseUrl}/models/${encodeURIComponent(resolvedModel)}:generateContent`;
    headers = {
      "x-goog-api-key": cleanKey,
      "Content-Type": "application/json"
    };
    payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: String(userText) }] }]
    };
    if (generationConfig && Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }
  } else if (isAnthropic) {
    endpoint = `${providerCfg.baseUrl}/messages`;
    headers = {
      "x-api-key": cleanKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json"
    };
    payload = {
      model: resolvedModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: String(userText) }]
    };
  } else {
    endpoint = `${providerCfg.baseUrl}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (cleanKey) {
      headers.Authorization = `Bearer ${cleanKey}`;
    }
    payload = {
      model: resolvedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: String(userText) }
      ]
    };
    if (jsonMode) {
      payload.response_format = { type: "json_object" };
    }
  }

  let body = JSON.stringify(payload);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });

      if (!res.ok) {
        const detail = await res.text();
        if (!isGemini && !isAnthropic && jsonMode && payload.response_format && res.status === 400) {
          delete payload.response_format;
          body = JSON.stringify(payload);
          continue;
        }
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
      let output = "";
      if (isGemini) {
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) {
          throw new GeminiRequestError("Failed to parse AI response.", { retryable: false });
        }
        output = parts.map((p) => p?.text || "").join("");
      } else if (isAnthropic) {
        const blocks = data?.content;
        if (!Array.isArray(blocks)) {
          throw new GeminiRequestError("Failed to parse AI response.", { retryable: false });
        }
        output = blocks.map((b) => (b?.type === "text" ? b.text || "" : "")).join("");
      } else {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          output = content;
        } else if (Array.isArray(content)) {
          output = content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
        } else {
          throw new GeminiRequestError("Failed to parse AI response.", { retryable: false });
        }
      }
      if (!output) {
        throw new GeminiRequestError(`${providerCfg.label} returned an empty response.`, { retryable: false });
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
  throw lastError || new Error("AI API request failed.");
}

export async function callAI({
  provider = DEFAULT_PROVIDER,
  customBaseUrl = "",
  apiKey,
  model,
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
  return requestAI({
    provider,
    customBaseUrl,
    apiKey,
    model,
    systemPrompt,
    userText: text,
    retryBaseDelayMs
  });
}

export const callGemini = callAI;

export async function fetchSentenceSuggestions({
  text,
  mode = "sentence",
  primaryLanguage = DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage = DEFAULT_SECONDARY_LANGUAGE,
  provider = DEFAULT_PROVIDER,
  customBaseUrl = "",
  apiKey,
  model,
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
    `Provide a short "label" (2-4 words) and a brief optional "explanation".`,
    `Respond ONLY with valid JSON matching: {"options":[{"category":"grammar"|"fluency"|"professional","label":"...","text":"...","explanation":"..."}]}.`
  ].join(" ");

  const raw = await requestAI({
    provider,
    customBaseUrl,
    apiKey,
    model,
    systemPrompt,
    userText: text,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: SENTENCE_SUGGESTIONS_SCHEMA
    },
    jsonMode: true,
    retryBaseDelayMs
  });

  const providerCfg = resolveProviderConfig(provider, customBaseUrl);
  const parsed = parseStructuredJson(raw, providerCfg.label);
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
    throw new GeminiRequestError(`${providerCfg.label} returned no valid sentence suggestions.`, {
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
  provider = DEFAULT_PROVIDER,
  customBaseUrl = "",
  apiKey,
  model,
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
    `Match the language, inflection, and casing of the sentence context. Return only single-word (or tight compound) replacements in "word" and a concise "reason".`,
    `Respond ONLY with valid JSON matching: {"suggestions":[{"word":"...","reason":"..."}]}.`
  ].join(" ");

  const userText = `Sentence context: ${cleanSentence}\nTarget word: ${cleanTarget}`;

  const raw = await requestAI({
    provider,
    customBaseUrl,
    apiKey,
    model,
    systemPrompt,
    userText,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: CONTEXTUAL_WORD_SCHEMA
    },
    jsonMode: true,
    retryBaseDelayMs
  });

  const providerCfg = resolveProviderConfig(provider, customBaseUrl);
  const parsed = parseStructuredJson(raw, providerCfg.label);
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
    throw new GeminiRequestError(`${providerCfg.label} returned no contextual word suggestions.`, {
      retryable: false
    });
  }

  return { suggestions };
}

export async function askAIQuestion({
  question,
  text,
  history = [],
  primaryLanguage = DEFAULT_PRIMARY_LANGUAGE,
  secondaryLanguage = DEFAULT_SECONDARY_LANGUAGE,
  provider = DEFAULT_PROVIDER,
  customBaseUrl = "",
  apiKey,
  model,
  retryBaseDelayMs = 2000
}) {
  const cleanQ = String(question || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanQ) {
    throw new GeminiRequestError("Please enter a question first.", { retryable: false });
  }
  if (!cleanText) {
    throw new GeminiRequestError("Select or enter some text first.", { retryable: false });
  }
  const primary = (primaryLanguage || DEFAULT_PRIMARY_LANGUAGE).trim() || DEFAULT_PRIMARY_LANGUAGE;
  const systemPrompt = `You are a concise, helpful assistant. Answer the user's question about the provided text clearly and briefly (in ${primary} if the question is in ${primary}, otherwise match the question's language).`;
  const historyBlock = Array.isArray(history) && history.length > 0
    ? "\n\nPrevious conversation:\n" +
      history
        .slice(-6)
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${String(m.text || "").trim()}`)
        .join("\n")
    : "";
  const userText = `Text:\n${cleanText}${historyBlock}\n\nQuestion:\n${cleanQ}`;
  return requestAI({
    provider,
    customBaseUrl,
    apiKey,
    model,
    systemPrompt,
    userText,
    retryBaseDelayMs
  });
}

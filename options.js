import {
  AI_PROVIDERS,
  callAI,
  DEFAULT_PRIMARY_LANGUAGE,
  DEFAULT_PROVIDER,
  DEFAULT_SECONDARY_LANGUAGE,
  detectProviderFromApiKey,
  getSettings,
  resolveProviderConfig
} from "./shared/actions.js";

const providerSelect = document.getElementById("provider");
const customBaseUrlWrap = document.getElementById("custom-base-url-wrap");
const customBaseUrlInput = document.getElementById("custom-base-url");
const apiKeyInput = document.getElementById("api-key");
const toggleKeyBtn = document.getElementById("toggle-key");
const modelInput = document.getElementById("model");
const askModelInput = document.getElementById("ask-model");
const modelList = document.getElementById("model-list");
const modelHint = document.getElementById("model-hint");
const primaryLanguageInput = document.getElementById("primary-language");
const secondaryLanguageInput = document.getElementById("secondary-language");
const spellcheckEnabledCheckbox = document.getElementById("spellcheck-enabled");
const autoCorrectEnabledCheckbox = document.getElementById("auto-correct-enabled");
const copyOnReplaceCheckbox = document.getElementById("copy-on-replace");
const saveBtn = document.getElementById("save-btn");
const testBtn = document.getElementById("test-btn");
const statusEl = document.getElementById("status");

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function isKnownModelForAnotherProvider(modelVal, targetProviderId) {
  const clean = (modelVal || "").trim();
  if (!clean) return true;
  for (const [id, profile] of Object.entries(AI_PROVIDERS)) {
    if (id !== targetProviderId && profile.models.includes(clean)) {
      return true;
    }
  }
  return false;
}

function syncProviderUI(providerId, { updateModel = false } = {}) {
  const profile = AI_PROVIDERS[providerId] || AI_PROVIDERS[DEFAULT_PROVIDER];
  customBaseUrlWrap.style.display = profile.id === "custom" ? "block" : "none";
  apiKeyInput.placeholder = profile.apiKeyPlaceholder;
  modelInput.placeholder = profile.defaultModel;
  if (askModelInput) {
    askModelInput.placeholder = `Same as above (e.g. ${profile.defaultAskModel || profile.defaultModel})`;
  }

  modelList.replaceChildren(
    ...profile.models.map((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      return opt;
    })
  );

  modelHint.textContent = "";
  const prefix = document.createTextNode(`Default for ${profile.label}: `);
  const defCode = document.createElement("code");
  defCode.textContent = profile.defaultModel;
  modelHint.append(prefix, defCode, document.createTextNode(" (suggestions: "));
  profile.models.forEach((m, idx) => {
    if (idx > 0) modelHint.append(document.createTextNode(", "));
    const c = document.createElement("code");
    c.textContent = m;
    modelHint.append(c);
  });
  modelHint.append(document.createTextNode(")."));

  if (updateModel && isKnownModelForAnotherProvider(modelInput.value, profile.id)) {
    modelInput.value = profile.defaultModel;
  }
  if (updateModel && askModelInput && askModelInput.value.trim() && isKnownModelForAnotherProvider(askModelInput.value, profile.id)) {
    askModelInput.value = profile.defaultAskModel || "";
  }
}

async function ensureHostPermission(providerId, customBaseUrl) {
  if (providerId === "gemini" || !chrome?.permissions?.request) return true;
  try {
    const cfg = resolveProviderConfig(providerId, customBaseUrl);
    const originPattern = `${new URL(cfg.baseUrl).origin}/*`;
    return await chrome.permissions.request({ origins: [originPattern] });
  } catch {
    return true;
  }
}

async function load() {
  const settings = await getSettings();
  providerSelect.value = settings.provider || DEFAULT_PROVIDER;
  customBaseUrlInput.value = settings.customBaseUrl || "";
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model || AI_PROVIDERS[providerSelect.value].defaultModel;
  if (askModelInput) {
    askModelInput.value = settings.askModel || "";
  }
  syncProviderUI(providerSelect.value, { updateModel: false });
  primaryLanguageInput.value = settings.primaryLanguage || DEFAULT_PRIMARY_LANGUAGE;
  secondaryLanguageInput.value = settings.secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE;
  spellcheckEnabledCheckbox.checked = settings.spellcheckEnabled;
  autoCorrectEnabledCheckbox.checked = settings.autoCorrectEnabled;
  copyOnReplaceCheckbox.checked = settings.copyOnReplace;
}

providerSelect.addEventListener("change", () => {
  syncProviderUI(providerSelect.value, { updateModel: true });
});

apiKeyInput.addEventListener("input", () => {
  const detected = detectProviderFromApiKey(apiKeyInput.value);
  if (detected && detected !== providerSelect.value) {
    providerSelect.value = detected;
    syncProviderUI(detected, { updateModel: true });
  }
});

toggleKeyBtn.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  toggleKeyBtn.textContent = isHidden ? "Hide" : "Show";
});

saveBtn.addEventListener("click", async () => {
  const provider = AI_PROVIDERS[providerSelect.value] ? providerSelect.value : DEFAULT_PROVIDER;
  const customBaseUrl = customBaseUrlInput.value.trim();
  const profile = AI_PROVIDERS[provider];
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || profile.defaultModel;
  const askModel = askModelInput ? askModelInput.value.trim() : "";
  const primaryLanguage = primaryLanguageInput.value.trim() || DEFAULT_PRIMARY_LANGUAGE;
  const secondaryLanguage = secondaryLanguageInput.value.trim() || DEFAULT_SECONDARY_LANGUAGE;
  const spellcheckEnabled = spellcheckEnabledCheckbox.checked;
  const autoCorrectEnabled = autoCorrectEnabledCheckbox.checked;
  const copyOnReplace = copyOnReplaceCheckbox.checked;

  await ensureHostPermission(provider, customBaseUrl);
  await chrome.storage.local.set({
    provider,
    customBaseUrl,
    apiKey,
    model,
    askModel,
    primaryLanguage,
    secondaryLanguage,
    spellcheckEnabled,
    autoCorrectEnabled,
    copyOnReplace
  });
  modelInput.value = model;
  primaryLanguageInput.value = primaryLanguage;
  secondaryLanguageInput.value = secondaryLanguage;
  setStatus("Settings saved.", "ok");
});

testBtn.addEventListener("click", async () => {
  const provider = AI_PROVIDERS[providerSelect.value] ? providerSelect.value : DEFAULT_PROVIDER;
  const customBaseUrl = customBaseUrlInput.value.trim();
  const profile = AI_PROVIDERS[provider];
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || profile.defaultModel;
  if (profile.requiresKey && !apiKey) {
    setStatus(`Please enter a ${profile.label} API key first.`, "err");
    return;
  }
  const granted = await ensureHostPermission(provider, customBaseUrl);
  if (!granted) {
    setStatus("Host permission was not granted.", "err");
    return;
  }
  testBtn.disabled = true;
  setStatus(`Testing ${profile.label} connection...`);
  try {
    const out = await callAI({
      provider,
      customBaseUrl,
      apiKey,
      model,
      actionId: "fix",
      text: "this is a test mesage."
    });
    setStatus(`Connection successful: "${out.trim()}"`, "ok");
  } catch (err) {
    setStatus(`Test failed: ${err?.message || err}`, "err");
  } finally {
    testBtn.disabled = false;
  }
});

load();

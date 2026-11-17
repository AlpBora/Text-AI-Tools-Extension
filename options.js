import {
  callGemini,
  DEFAULT_MODEL,
  DEFAULT_PRIMARY_LANGUAGE,
  DEFAULT_SECONDARY_LANGUAGE,
  getSettings
} from "./shared/actions.js";

const apiKeyInput = document.getElementById("api-key");
const toggleKeyBtn = document.getElementById("toggle-key");
const modelInput = document.getElementById("model");
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

async function load() {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model || DEFAULT_MODEL;
  primaryLanguageInput.value = settings.primaryLanguage || DEFAULT_PRIMARY_LANGUAGE;
  secondaryLanguageInput.value = settings.secondaryLanguage || DEFAULT_SECONDARY_LANGUAGE;
  spellcheckEnabledCheckbox.checked = settings.spellcheckEnabled;
  autoCorrectEnabledCheckbox.checked = settings.autoCorrectEnabled;
  copyOnReplaceCheckbox.checked = settings.copyOnReplace;
}

toggleKeyBtn.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  toggleKeyBtn.textContent = isHidden ? "Hide" : "Show";
});

saveBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  const primaryLanguage = primaryLanguageInput.value.trim() || DEFAULT_PRIMARY_LANGUAGE;
  const secondaryLanguage = secondaryLanguageInput.value.trim() || DEFAULT_SECONDARY_LANGUAGE;
  const spellcheckEnabled = spellcheckEnabledCheckbox.checked;
  const autoCorrectEnabled = autoCorrectEnabledCheckbox.checked;
  const copyOnReplace = copyOnReplaceCheckbox.checked;

  await chrome.storage.local.set({
    apiKey,
    model,
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
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  if (!apiKey) {
    setStatus("Please enter an API key first.", "err");
    return;
  }
  testBtn.disabled = true;
  setStatus("Testing connection...");
  try {
    const out = await callGemini({
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

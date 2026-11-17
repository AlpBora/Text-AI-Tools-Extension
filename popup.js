import {
  AI_PROVIDERS,
  callAI,
  detectProviderFromApiKey,
  getSettings,
  resolveProviderConfig
} from "./shared/actions.js";

export function getShortcutsUrl(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""
) {
  const ua = String(userAgent || "");
  if (ua.includes("OPR/")) return "opera://extensions/shortcuts";
  if (ua.includes("Edg/")) return "edge://extensions/shortcuts";
  if (ua.includes("Vivaldi/")) return "vivaldi://extensions/shortcuts";
  return "chrome://extensions/shortcuts";
}

function initPopup() {
  if (typeof document === "undefined") return;

  const apiBanner = document.getElementById("api-banner");
  const quickKeyInput = document.getElementById("quick-key");
  const saveQuickKeyBtn = document.getElementById("save-quick-key");
  const inputText = document.getElementById("input-text");
  const outputText = document.getElementById("output-text");
  const resultCard = document.getElementById("result-card");
  const copyOutputBtn = document.getElementById("copy-output");
  const statusEl = document.getElementById("status");
  const actionButtons = Array.from(document.querySelectorAll(".action-btn"));
  const translateBtn = document.getElementById("translate-btn");
  const openOptionsBtn = document.getElementById("open-options");
  const openShortcutsBtn = document.getElementById("open-shortcuts");

  if (!apiBanner || !inputText || !statusEl) return;

  function setStatus(message, type = "") {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`.trim();
  }

  function setBusy(busy) {
    for (const btn of actionButtons) {
      btn.disabled = busy;
    }
  }

  async function refreshApiBanner() {
    const { apiKey, provider, customBaseUrl, primaryLanguage, secondaryLanguage } = await getSettings();
    const providerCfg = resolveProviderConfig(provider, customBaseUrl);
    apiBanner.classList.toggle("hidden", !providerCfg.requiresKey || Boolean(apiKey));
    if (translateBtn) {
      translateBtn.textContent = `Translate (${primaryLanguage} ↔ ${secondaryLanguage})`;
    }
  }

  saveQuickKeyBtn?.addEventListener("click", async () => {
    const key = quickKeyInput.value.trim();
    if (!key) {
      setStatus("Please enter a valid API key.", "err");
      return;
    }
    const detected = detectProviderFromApiKey(key);
    const updates = { apiKey: key };
    if (detected && AI_PROVIDERS[detected]) {
      updates.provider = detected;
      updates.model = AI_PROVIDERS[detected].defaultModel;
    }
    await chrome.storage.local.set(updates);
    quickKeyInput.value = "";
    await refreshApiBanner();
    setStatus("API key saved.", "ok");
  });

  for (const btn of actionButtons) {
    btn.addEventListener("click", async () => {
      const actionId = btn.dataset.action;
      const text = inputText.value.trim();
      if (!text) {
        setStatus("Please enter some text first.", "err");
        return;
      }

      const settings = await getSettings();
      const providerCfg = resolveProviderConfig(settings.provider, settings.customBaseUrl);
      if (providerCfg.requiresKey && !settings.apiKey) {
        apiBanner.classList.remove("hidden");
        setStatus(`Please save your ${providerCfg.label} API key first.`, "err");
        return;
      }

      setBusy(true);
      setStatus("Processing...");
      try {
        const result = await callAI({
          provider: settings.provider,
          customBaseUrl: settings.customBaseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          actionId,
          text,
          primaryLanguage: settings.primaryLanguage,
          secondaryLanguage: settings.secondaryLanguage
        });
        outputText.value = result;
        resultCard.classList.remove("hidden");
        setStatus("Done.", "ok");
      } catch (err) {
        setStatus(err?.message || "An error occurred.", "err");
      } finally {
        setBusy(false);
      }
    });
  }

  copyOutputBtn?.addEventListener("click", async () => {
    if (!outputText.value) return;
    await navigator.clipboard.writeText(outputText.value);
    copyOutputBtn.textContent = "Copied ✓";
    setTimeout(() => {
      copyOutputBtn.textContent = "Copy";
    }, 1500);
  });

  openOptionsBtn?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  openShortcutsBtn?.addEventListener("click", async () => {
    const url = getShortcutsUrl();
    try {
      const tab = await chrome.tabs.create({ url });
      if (tab) return;
    } catch {
      // Some Chromium browsers disallow programmatic navigation to chrome:// URLs
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus(`Copied ${url} — paste it in the address bar.`, "ok");
    } catch {
      setStatus(`Open ${url} in your browser's address bar.`, "err");
    }
  });

  refreshApiBanner();
}

initPopup();

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
  if (/Chrome\/|Chromium\/|Brave\//i.test(ua)) return "chrome://extensions/shortcuts";
  return null;
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
  const shortcutsCard = document.getElementById("shortcuts-card");
  const shortcutsListEl = document.getElementById("shortcuts-list");
  const closeShortcutsBtn = document.getElementById("close-shortcuts");
  const updateBanner = document.getElementById("update-banner");
  const updateLabel = document.getElementById("update-label");
  const updateNowBtn = document.getElementById("update-now-btn");

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

  closeShortcutsBtn?.addEventListener("click", () => {
    shortcutsCard?.classList.add("hidden");
  });

  async function renderInlineShortcuts() {
    if (!shortcutsCard || !shortcutsListEl) return;
    shortcutsListEl.textContent = "";
    let commands = [];
    try {
      if (chrome?.commands?.getAll) {
        commands = await chrome.commands.getAll();
      }
    } catch {
      commands = [];
    }
    if (commands.length > 0) {
      commands.forEach((cmd, idx) => {
        if (idx > 0) shortcutsListEl.append(document.createElement("br"));
        const name = cmd.description || (cmd.name === "_execute_action" ? "Open Extension Popup" : cmd.name);
        const keyText = cmd.shortcut ? cmd.shortcut : "Not set";
        const strong = document.createElement("b");
        strong.textContent = `${name}: `;
        const code = document.createElement("code");
        code.textContent = keyText;
        shortcutsListEl.append(strong, code);
      });
    } else {
      shortcutsListEl.textContent = "No custom extension shortcuts configured.";
    }
    shortcutsCard.classList.toggle("hidden");
  }

  openShortcutsBtn?.addEventListener("click", async () => {
    const url = getShortcutsUrl();
    if (!url) {
      await renderInlineShortcuts();
      return;
    }
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab?.id && !chrome.runtime?.lastError) {
        window.close();
        return;
      }
    } catch {
      // Fallback to inline panel if browser blocks chrome:// URLs
    }
    await renderInlineShortcuts();
  });

  function isNewerVersion(remote, local) {
    const pa = String(remote || "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(local || "").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0;
    }
    return false;
  }

  async function refreshUpdateBanner() {
    if (!updateBanner || !chrome?.storage?.local || !chrome?.runtime?.getManifest) return;
    try {
      const { latestRemoteVersion } = await chrome.storage.local.get({ latestRemoteVersion: "" });
      const localVersion = chrome.runtime.getManifest().version;
      if (latestRemoteVersion && isNewerVersion(latestRemoteVersion, localVersion)) {
        if (updateLabel) {
          updateLabel.textContent = `Update available: v${latestRemoteVersion}`;
        }
        updateBanner.classList.remove("hidden");
      } else {
        updateBanner.classList.add("hidden");
      }
    } catch {
      // ignore
    }
  }

  updateNowBtn?.addEventListener("click", async () => {
    updateNowBtn.disabled = true;
    updateNowBtn.textContent = "Updating...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "checkAndReloadUpdate" });
      if (res?.reloaded) {
        return;
      }
      setStatus("Disk files not synced yet — opening GitHub.", "ok");
      await chrome.tabs.create({
        url: "https://github.com/AlpBora/Text-AI-Tools-Extension",
        active: true
      });
    } catch {
      setStatus("Could not check update.", "err");
    } finally {
      updateNowBtn.disabled = false;
      updateNowBtn.textContent = "Update";
    }
  });

  refreshUpdateBanner();
  refreshApiBanner();
}

initPopup();

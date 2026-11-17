import { callGemini, getSettings } from "./shared/actions.js";

export function getShortcutsUrl(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""
) {
  return String(userAgent || "").includes("OPR/")
    ? "opera://extensions/shortcuts"
    : "chrome://extensions/shortcuts";
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
    const { apiKey, primaryLanguage, secondaryLanguage } = await getSettings();
    apiBanner.classList.toggle("hidden", Boolean(apiKey));
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
    await chrome.storage.local.set({ apiKey: key });
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
      if (!settings.apiKey) {
        apiBanner.classList.remove("hidden");
        setStatus("Please save your Gemini API key first.", "err");
        return;
      }

      setBusy(true);
      setStatus("Processing...");
      try {
        const result = await callGemini({
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

  openShortcutsBtn?.addEventListener("click", () => {
    chrome.tabs.create({ url: getShortcutsUrl() });
  });

  refreshApiBanner();
}

initPopup();

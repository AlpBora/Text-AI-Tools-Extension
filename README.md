# Text AI Tools

A unified, single-source-of-truth writing assistant combining **offline word-end spellchecking** (with Turkish morphological analysis, ASCII-to-Turkish restoration, bilingual approximate matching, and an adaptive personal habit model) with **optional, manually triggered AI text tools** (model-agnostic, bring-your-own-API-key).

Runs from the exact same core codebase in two ways:
1. **Chromium Browser Extension** (Manifest V3)
2. **macOS System-Wide Menu Bar App** (native `CGEventTap` + Node.js worker)

---

## Features

### 1. Offline Word-End Local Spellchecking (Zero Automatic API Calls)
- **Word-Boundary Trigger:** Checks only the last completed word when you type a space, newline, Tab, or punctuation—never on every keystroke and never sending typing to an external API automatically.
- **Turkish Morphology & English Keyboard Support:** Validates inflected Turkish words via morphological suffix rules (vowel harmony, consonant softening, assimilation, buffer consonants), handles Turkish apostrophe suffixes on foreign/proper-noun stems, and restores Turkish diacritics (`ç/ğ/ı/ö/ş/ü`) when typing on an English/ASCII keyboard.
- **Bilingual Approximate & Phonetic Matching:** Combines exact/folded lookup, QWERTY + diacritic weighted edit distance, and cross-lingual phonetic/consonant-skeleton matching for bilingual code-switching.
- **Adaptive Personal Habit Model:** Learns your personal character-edit patterns (`charEdits`), word frequencies, bigram context (`prevWord → nextWord`), app/domain preferences, and undone/ignored words locally—generalizing to unseen words over time.
- **Instant Undo & Uncertainty Guard:** Confident fixes auto-replace cleanly and can be reverted in one step with `Cmd+Z` / `Ctrl+Z` / `Backspace`; ambiguous or uncertain words are underlined with a candidate menu.

### 2. Optional, On-Demand AI Actions
Triggered **only** when you explicitly click a button or press the shortcut:
- **Fix Grammar** (`fix`) — fixes spelling, grammar, and punctuation in the detected language
- **Shorten** (`concise`) — reduces character count and filler words while preserving structure and meaning
- **Professional** (`professional`) — rewrites in a formal, polite tone
- **Translate** (`translate`) — translates between your configured Primary & Secondary languages
- **Summarize** (`summarize`) — summarizes into concise bullet points
- **Contextual Word Lookup** — infers an intended word from sentence context when local dictionaries are insufficient

---

## Installation & Usage

### A. Chromium Browser Extension

1. Open your Chromium browser's extensions page (e.g. `chrome://extensions` or your browser's equivalent).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository folder (`/path/to/text-ai-tools-extension`).
4. Click the extension icon → **Settings** to configure your API key, model name, and Primary / Secondary languages.
5. **Usage in Browser:**
   - Type normally in any `input`, `textarea`, `contenteditable`, or embedded `iframe`—local spellchecking runs automatically at word boundaries.
   - Select text (or place the caret at the end of a sentence) and click the **`✦`** button to run **Fix Grammar**, **Shorten**, **Professional**, **Translate**, or **Summarize** inline.

---

### B. macOS System-Wide App

The macOS app (`macos/TextAIToolsMac.app`) shares the exact same `content/` and `shared/` modules via `macos/engine-worker.mjs` with zero code duplication.

#### Build & Launch
```bash
bash macos/build.sh
open ~/Applications/TextAIToolsMac.app
```

#### Permissions
On first launch, macOS requires two permissions under **System Settings → Privacy & Security**:
1. **Accessibility** — enable **Text AI Tools**
2. **Input Monitoring** — enable **Text AI Tools**

*(If you rebuild the app later, remove and re-add `~/Applications/TextAIToolsMac.app` in those lists if macOS caches the previous binary signature.)*

#### Usage Outside the Browser
- **System-Wide Auto-Correct:** Works automatically at word boundaries across macOS apps (Notes, WhatsApp, Slack, Mail, etc.), while skipping password fields (`AXSecureTextField`), terminals, and browsers by default (configurable from the menu bar icon). Press `Cmd+Z` or immediate `Backspace` to revert a correction.
- **Global Shortcut (`Right ⌘ + .`):** Select text in any macOS app and press **Right Command + `.`** to open the floating liquid-glass menu (**1. Fix Grammar**, **2. Shorten**, **3. Professional**, **4. Translate**, **5. Summarize**).
- **CLI / Quick Actions Bridge:**
  ```bash
  echo "Your text here" | node macos/cli.mjs --action concise
  ```

---

## API Key Security

- **No hardcoded keys:** No API key is embedded anywhere in the repository.
- **Browser Extension:** Your API key is stored locally in your browser profile (`chrome.storage.local`); content scripts and web pages never see it.
- **macOS App:** Your API key is stored securely in your **macOS Keychain** (`TextAITools-Gemini-API-Key`) and never written to plaintext config files.

---

## Development & Tests

Run the full unit test suite:

```bash
node --test tests/unit/*.test.mjs
```

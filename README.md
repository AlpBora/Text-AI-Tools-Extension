# Text AI Tools — Chrome & Opera Extension

A Manifest V3 Chromium extension for **Google Chrome** and **Opera** combining offline word-end spellchecking (with Turkish morphology, ASCII-to-Turkish restoration, and bilingual phonetic/approximate matching) and optional, manually triggered **Google Gemini** writing tools.

## Features

### 1. Offline Word-End Local Spellchecking (Zero Automatic API Calls)
- **Word-Boundary Trigger:** Checks only the last completed word when you type a space, newline, Tab, or punctuation—never on every keystroke and never sending typing to Gemini automatically.
- **Bilingual Approximate & Phonetic Matching:** Combines exact/folded lookup, QWERTY + diacritic weighted edit distance, and cross-lingual phonetic/consonant-skeleton matching so bilingual phonetic spellings surface helpful local candidates without strict letter-order pruning.
- **Configurable Languages (Not Hardcoded):** Set any **Primary Language** and **Secondary Language** in Settings (with built-in language estimation and bilingual code-switching tolerance).
- **Turkish Suffix Analyzer & English Keyboard Support:** Validates inflected Turkish words via morphological suffix rules (vowel harmony, consonant softening, assimilation, buffer consonants) and restores Turkish diacritics (`ş/ç/ğ/ı/ö/ü`) when typing with an English/ASCII keyboard (e.g. `ozetle` → `özetle`), while preserving valid ASCII Turkish homographs (`oldu`, `kar`, `yasa`, `on`, `sac`).
- **Confident Auto-Correct + 1-Step Undo ("Geri al"):** High-confidence fixes auto-replace with a one-click **Geri al** pill (and Backspace/native undo support); uncertain words are underlined without overwriting so you can pick from a candidate menu.

### 2. Optional, Manually Triggered Gemini Tools
- **Sentence / Selection Icon & Suggestion Menu:** A small button appears near the caret at sentence end or beside selected text. Clicking it sends **only** that sentence or selection to Gemini and returns grammar, fluency, and professional options that replace only the targeted sentence/selection.
- **Manual Contextual Word Finder:** When local dictionaries lack an intended word, you can manually click **Ask Gemini (Context)** from the uncertain-word popover to infer the intended word from sentence context.
- **Classic Actions (Context Menu, Shortcuts & Popup):**
  - **Fix & Paste Text** (`fix`) — fixes spelling, grammar, and punctuation in the detected language
  - **Make Text Professional** (`professional`) — rewrites in a formal, polite tone
  - **Translate Text** (`translate`) — translates between your Primary & Secondary languages
  - **Summarize Text** (`summarize`) — summarizes into concise bullet points in your Primary Language
- **Gemini 3.5+ Compatible:** Defaults to `gemini-3.5-flash-lite` (also supports `gemini-3.8-flash`, `gemini-flash-lite-latest`, or custom models) with deprecated `temperature` removed from API requests.

### 3. Editor & Frame Coverage
- Works across `input` (excluding `password`, `email`, `url`), `textarea`, `contenteditable`, and embedded `iframe` editors (`all_frames: true`, `match_about_blank: true`).

## Installation

### Google Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository folder.
4. Click the extension icon → **Settings** to enter your Gemini API key and language preferences.

### Opera
1. Open `opera://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository folder.
4. Click the extension icon → **Settings** to enter your Gemini API key and language preferences.
5. Use **Shortcuts** in the popup (or visit `opera://extensions/shortcuts`) to customize keyboard shortcuts.

## API Key Security Boundaries

- **No hardcoded key:** No Gemini API key is embedded in the extension package.
- **Local browser storage:** Your API key is stored **locally and unencrypted** in `chrome.storage.local` inside your browser profile. Content scripts and web pages never receive the API key; Gemini requests are made only from the extension background service worker, popup, or options page directly to `https://generativelanguage.googleapis.com/*`.
- **Boundary:** Browser profile storage can still be read by anyone with local access to your OS user account or browser profile files. Stronger OS-level (Keychain / Credential Manager) or server-side key isolation requires a **local helper app (Native Messaging)** or a **backend proxy server**.

## Development & Tests

Run the Node unit test suite:

```bash
node --test tests/unit/*.test.mjs
```

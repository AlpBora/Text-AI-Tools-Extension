import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT } from "./browser-harness.mjs";
import {
  assertZeroGeminiCalls,
  clickSentenceTrigger,
  clickShadowButtonMatching,
  getCssHighlights,
  getShadowSnapshot,
  hasUncertainMarker,
  pressKey,
  readEditorText,
  selectSubstring,
  typeRealText,
  waitForCondition
} from "./opaque-helpers.mjs";

export function buildTier1Cases() {
  return [
    // =========================================================================
    // F1: Word-boundary local spellcheck trigger (5 cases)
    // =========================================================================
    {
      id: "T1-F01-01",
      feature: "F1",
      name: "Word check fires on Space boundary and corrects English typo with 0 Gemini calls",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).startsWith("the "),
          { label: "teh -> the on space" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.equal(val, "the ");
        await assertZeroGeminiCalls(session, "T1-F01-01 typing");
        await page.close();
      }
    },
    {
      id: "T1-F01-02",
      feature: "F1",
      name: "Word check triggers on sentence punctuation boundary (period)",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Please recieve.");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).includes("receive."),
          { label: "recieve. -> receive." }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.equal(val, "Please receive.");
        await assertZeroGeminiCalls(session, "T1-F01-02 punctuation");
        await page.close();
      }
    },
    {
      id: "T1-F01-03",
      feature: "F1",
      name: "Word check triggers on comma boundary without altering mid-word typing",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "mesage");
        // Before boundary, mid-word should not be prematurely altered
        const midVal = await readEditorText(page, "#main-textarea");
        assert.equal(midVal, "mesage");
        await typeRealText(page, "#main-textarea", ",", { clear: false });
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "message,",
          { label: "mesage, -> message," }
        );
        await assertZeroGeminiCalls(session, "T1-F01-03 comma boundary");
        await page.close();
      }
    },
    {
      id: "T1-F01-04",
      feature: "F1",
      name: "Word check triggers on Enter boundary in textarea",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "seperate");
        await pressKey(page, "#main-textarea", "Enter");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).startsWith("separate"),
          { label: "seperate + Enter -> separate" }
        );
        await assertZeroGeminiCalls(session, "T1-F01-04 Enter boundary");
        await page.close();
      }
    },
    {
      id: "T1-F01-05",
      feature: "F1",
      name: "Standard text input triggers local check at word boundary with 0 Gemini calls",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#text-input", "definately ");
        await waitForCondition(
          async () => (await readEditorText(page, "#text-input")).startsWith("definitely "),
          { label: "definately -> definitely in input[type=text]" }
        );
        await assertZeroGeminiCalls(session, "T1-F01-05 text input");
        await page.close();
      }
    },

    // =========================================================================
    // F2: Frequency-ranked lexicons & lazy delivery (5 cases)
    // =========================================================================
    {
      id: "T1-F02-01",
      feature: "F2",
      name: "Frequency ranking prefers 'the' over archaic short words for 'teh'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).startsWith("the "),
          { label: "teh -> the frequency priority" }
        );
        assert.equal(await readEditorText(page, "#main-textarea"), "the ");
        await page.close();
      }
    },
    {
      id: "T1-F02-02",
      feature: "F2",
      name: "Frequency ranking prefers 'and' over obscure tokens for 'nad'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "bread nad ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "bread and ",
          { label: "nad -> and frequency priority" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F02-03",
      feature: "F2",
      name: "Bundled lexicon files exist under shared/lexicons for EN and TR",
      async run() {
        const lexDir = path.join(PROJECT_ROOT, "shared/lexicons");
        assert.equal(fs.existsSync(lexDir), true, "shared/lexicons directory must exist");
        const files = fs.readdirSync(lexDir);
        assert.ok(files.some((f) => /en/i.test(f) && f.endsWith(".json")), "EN lexicon JSON missing");
        assert.ok(files.some((f) => /tr/i.test(f) && f.endsWith(".json")), "TR lexicon JSON missing");
      }
    },
    {
      id: "T1-F02-04",
      feature: "F2",
      name: "Non-editable fixture page initializes cleanly with zero shadow overlays or Gemini calls",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/non-editable.html");
        await page.waitForTimeout(300);
        const snap = await getShadowSnapshot(page);
        assert.equal(snap.buttons.length, 0, "No floating buttons should appear on non-editable page");
        await assertZeroGeminiCalls(session, "T1-F02-04 non-editable page");
        await page.close();
      }
    },
    {
      id: "T1-F02-05",
      feature: "F2",
      name: "Lazy lexicon load serves both primary TR and secondary EN on first focus",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetle recieve ");
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#main-textarea");
            return v.includes("özetle") && v.includes("receive");
          },
          { label: "Both TR and EN lexicons active lazily" }
        );
        await page.close();
      }
    },

    // =========================================================================
    // F3: Bilingual approximate & phonetic matching (5 cases)
    // =========================================================================
    {
      id: "T1-F03-01",
      feature: "F3",
      name: "Bilingual phonetic spelling 'nesesery' yields 'necessary' candidate or correction",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "It is nesesery ");
        await waitForCondition(async () => {
          const val = await readEditorText(page, "#main-textarea");
          if (val.includes("necessary")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /necessary/i.test(b.text));
        }, { label: "nesesery -> necessary" });
        await assertZeroGeminiCalls(session, "T1-F03-01 phonetic matching");
        await page.close();
      }
    },
    {
      id: "T1-F03-02",
      feature: "F3",
      name: "Bilingual phonetic spelling 'saykoloci' yields 'psychology' candidate or correction",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "study saykoloci ");
        await waitForCondition(async () => {
          const val = await readEditorText(page, "#main-textarea");
          if (val.includes("psychology")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /psychology/i.test(b.text));
        }, { label: "saykoloci -> psychology" });
        await assertZeroGeminiCalls(session, "T1-F03-02 phonetic matching");
        await page.close();
      }
    },
    {
      id: "T1-F03-03",
      feature: "F3",
      name: "Bilingual phonetic spelling 'skedul' yields 'schedule' candidate or correction",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "check skedul ");
        await waitForCondition(async () => {
          const val = await readEditorText(page, "#main-textarea");
          if (val.includes("schedule")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /schedule/i.test(b.text));
        }, { label: "skedul -> schedule" });
        await page.close();
      }
    },
    {
      id: "T1-F03-04",
      feature: "F3",
      name: "QWERTY keyboard proximity typo 'helkp' or 'wrold' resolves cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "hello wrold ");
        await waitForCondition(
          async () => {
            const val = await readEditorText(page, "#main-textarea");
            if (val.includes("world")) return true;
            const snap = await getShadowSnapshot(page);
            return snap.buttons.some((b) => /\bworld\b/i.test(b.text));
          },
          { label: "wrold -> world" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F03-05",
      feature: "F3",
      name: "Bilingual Turkish-phonetic English attempt 'envayrınmınt' surfaces 'environment'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "new envayrınmınt ");
        await waitForCondition(async () => {
          const val = await readEditorText(page, "#main-textarea");
          if (val.includes("environment")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /environment/i.test(b.text));
        }, { label: "envayrınmınt -> environment" });
        await page.close();
      }
    },

    // =========================================================================
    // F4: Confidence auto-correct, underline & 1-step Undo (5 cases)
    // =========================================================================
    {
      id: "T1-F04-01",
      feature: "F4",
      name: "Strong candidate auto-corrects and displays 'Geri al' / Undo pill",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "recieve ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "receive ",
          { label: "auto-correct recieve -> receive" }
        );
        const snap = await getShadowSnapshot(page);
        assert.ok(
          snap.buttons.some((b) => /geri al|undo/i.test(`${b.text} ${b.ariaLabel}`)),
          "Expected visible Geri al / Undo button after auto-correct"
        );
        await page.close();
      }
    },
    {
      id: "T1-F04-02",
      feature: "F4",
      name: "Clicking 'Geri al' / Undo pill restores original word in 1 step",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "recieve ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "receive ",
          { label: "auto-correct applied" }
        );
        const clicked = await clickShadowButtonMatching(page, /geri al|undo/i);
        assert.ok(clicked, "Geri al / Undo button must be clickable");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "recieve ",
          { label: "undo restored recieve" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F04-03",
      feature: "F4",
      name: "Weak/ambiguous candidate is NOT auto-replaced and shows underline or popover",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "frobozzq ");
        await page.waitForTimeout(300);
        const val = await readEditorText(page, "#ce-editor");
        assert.ok(val.includes("frobozzq"), "Unknown token without strong candidate must not be silently replaced");
        const marked = await hasUncertainMarker(page, "frobozzq");
        assert.equal(marked, true, "Uncertain word should show CSS highlight, underline, or candidate menu");
        await page.close();
      }
    },
    {
      id: "T1-F04-04",
      feature: "F4",
      name: "Clicking a candidate from uncertain-word popover replaces only that word",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "keep saykoloci here ");
        await waitForCondition(async () => {
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /psychology/i.test(b.text));
        }, { label: "candidate menu lists psychology" });
        await clickShadowButtonMatching(page, /^psychology$/i);
        const val = await readEditorText(page, "#main-textarea");
        assert.ok(val.includes("keep psychology here"), `Expected 'keep psychology here', got '${val}'`);
        await page.close();
      }
    },
    {
      id: "T1-F04-05",
      feature: "F4",
      name: "Disabling autoCorrectEnabled in settings suppresses auto-replace while still flagging",
      async run(session) {
        await session.resetStorage({
          primaryLanguage: "English",
          secondaryLanguage: "Turkish",
          autoCorrectEnabled: false
        });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "recieve ");
        await page.waitForTimeout(250);
        const val = await readEditorText(page, "#ce-editor");
        assert.equal(val, "recieve ", "With autoCorrectEnabled=false, text must not auto-replace");
        const marked = await hasUncertainMarker(page, "recieve");
        assert.equal(marked, true, "Word should still be flagged with underline/candidates");
        await page.close();
      }
    },

    // =========================================================================
    // F5: Configurable non-hardcoded language selection & estimation (5 cases)
    // =========================================================================
    {
      id: "T1-F05-01",
      feature: "F5",
      name: "Options page exposes non-hardcoded datalist with 10+ languages including German/French/Spanish",
      async run(session) {
        const page = await session.openOptionsPage();
        const opts = await page.evaluate(() =>
          Array.from(document.querySelectorAll("#language-list option")).map((o) => o.value)
        );
        assert.ok(opts.length >= 10, `Expected >=10 languages in datalist, got ${opts.length}`);
        for (const lang of ["Turkish", "English", "German", "French", "Spanish"]) {
          assert.ok(opts.includes(lang), `Missing ${lang} in language-list`);
        }
        await page.close();
      }
    },
    {
      id: "T1-F05-02",
      feature: "F5",
      name: "Saving German & French in Options persists to chrome.storage.local",
      async run(session) {
        await session.resetStorage();
        const page = await session.openOptionsPage();
        await page.fill("#primary-language", "German");
        await page.fill("#secondary-language", "French");
        await page.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await page.textContent("#status")) || ""),
          { label: "Options saved status" }
        );
        const stored = await session.getStorage();
        assert.equal(stored.primaryLanguage, "German");
        assert.equal(stored.secondaryLanguage, "French");
        await page.close();
      }
    },
    {
      id: "T1-F05-03",
      feature: "F5",
      name: "Popup Translate button reflects configured non-TR/EN language pair",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "German", secondaryLanguage: "Spanish" });
        const page = await session.openPopupPage();
        await page.waitForTimeout(200);
        const label = await page.textContent("#translate-btn");
        assert.ok(
          /German/i.test(label) && /Spanish/i.test(label),
          `Expected German & Spanish in popup translate button, got '${label}'`
        );
        await page.close();
      }
    },
    {
      id: "T1-F05-04",
      feature: "F5",
      name: "Local language estimator recognizes Turkish prose even when English is primary",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Bugun toplanti icin ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).includes("özetle"),
          { label: "Turkish context activates deasciify even as secondary language" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F05-05",
      feature: "F5",
      name: "Valid secondary-language English words in Turkish sentence are not false-flagged",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "Bu toplantıda deployment ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "Bu toplantıda deployment ");
        const highlights = await getCssHighlights(page);
        assert.equal(
          highlights.some((h) => h.text === "deployment"),
          false,
          "Valid English word 'deployment' must not be false-flagged"
        );
        await page.close();
      }
    },

    // =========================================================================
    // F6: Turkish suffix/morphological analyzer (5 cases)
    // =========================================================================
    {
      id: "T1-F06-01",
      feature: "F6",
      name: "Valid Turkish agglutinated word 'evlerimizdekilerden' is accepted without flag",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "evlerimizdekilerden ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "evlerimizdekilerden ");
        const hl = await getCssHighlights(page);
        assert.equal(hl.some((h) => h.text.includes("evlerimizdekilerden")), false);
        await page.close();
      }
    },
    {
      id: "T1-F06-02",
      feature: "F6",
      name: "Valid Turkish complex verb 'anlayamadıklarımızdan' is accepted without flag",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "anlayamadıklarımızdan ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "anlayamadıklarımızdan ");
        const hl = await getCssHighlights(page);
        assert.equal(hl.some((h) => h.text.includes("anlayamadıklarımızdan")), false);
        await page.close();
      }
    },
    {
      id: "T1-F06-03",
      feature: "F6",
      name: "Valid Turkish -yor narrowing 'çalışıyorlar' and 'bekliyorum' accepted cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "çalışıyorlar bekliyorum ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "çalışıyorlar bekliyorum ");
        const hl = await getCssHighlights(page);
        assert.equal(hl.length, 0, "Valid -yor verbs must not be underlined");
        await page.close();
      }
    },
    {
      id: "T1-F06-04",
      feature: "F6",
      name: "Turkish consonant assimilation typo 'kitapda' yields/corrects to 'kitapta'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Bu kitapda ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#main-textarea");
          if (v.includes("kitapta")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /kitapta/i.test(b.text));
        }, { label: "kitapda -> kitapta" });
        await page.close();
      }
    },
    {
      id: "T1-F06-05",
      feature: "F6",
      name: "Turkish consonant softening form 'kitabı' and 'ağaca' accepted as valid",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "kitabı ağaca ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "kitabı ağaca ");
        const hl = await getCssHighlights(page);
        assert.equal(hl.length, 0);
        await page.close();
      }
    },

    // =========================================================================
    // F7: Homograph-safe Turkish ASCII deasciifier (5 cases)
    // =========================================================================
    {
      id: "T1-F07-01",
      feature: "F7",
      name: "ASCII Turkish word 'ozetle' auto-restores to 'özetle' at word end",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "özetle ",
          { label: "ozetle -> özetle" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F07-02",
      feature: "F7",
      name: "ASCII Turkish word 'tesekkurler' restores ş and ü ('teşekkürler')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "tesekkurler ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "teşekkürler ",
          { label: "tesekkurler -> teşekkürler" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F07-03",
      feature: "F7",
      name: "ASCII Turkish word 'gorusuruz' restores ö/ü/ş ('görüşürüz')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "gorusuruz ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "görüşürüz ",
          { label: "gorusuruz -> görüşürüz" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F07-04",
      feature: "F7",
      name: "ASCII Turkish word 'cagdas' restores ç/ğ/ş ('çağdaş')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "cagdas ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#main-textarea");
          if (v.includes("çağdaş")) return true;
          const snap = await getShadowSnapshot(page);
          return snap.buttons.some((b) => /çağdaş/i.test(b.text));
        }, { label: "cagdas -> çağdaş" });
        await page.close();
      }
    },
    {
      id: "T1-F07-05",
      feature: "F7",
      name: "Deasciified word 'ozetle' -> 'özetle' is reversible via 'Geri al' pill",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "özetle ",
          { label: "ozetle -> özetle" }
        );
        const clicked = await clickShadowButtonMatching(page, /geri al|undo/i);
        assert.ok(clicked, "Undo pill must appear after Turkish deasciify");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "ozetle ",
          { label: "Undo restores ozetle" }
        );
        await page.close();
      }
    },

    // =========================================================================
    // F8: Floating sentence/selection icon & Gemini suggestion menu (5 cases)
    // =========================================================================
    {
      id: "T1-F08-01",
      feature: "F8",
      name: "Floating sentence button appears near caret at sentence end",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "This sentence is finished.");
        const snap = await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return s.buttons.length > 0 ? s : null;
        }, { label: "floating sentence trigger" });
        assert.ok(snap.buttons.length >= 1);
        await page.close();
      }
    },
    {
      id: "T1-F08-02",
      feature: "F8",
      name: "Clicking floating sentence icon triggers Gemini with ONLY active sentence",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(
          page,
          "#main-textarea",
          "First sentence stays intact. Second sentence needs polish."
        );
        await waitForCondition(() => clickSentenceTrigger(page), {
          label: "click sentence trigger"
        });
        await waitForCondition(() => session.getGeminiLog().length > 0, {
          label: "Gemini sentence call"
        });
        const req = session.getGeminiLog()[0];
        assert.ok(req.bodyRaw.includes("Second sentence needs polish."), "Active sentence must be sent");
        assert.equal(req.bodyRaw.includes("First sentence stays intact."), false, "Preceding sentence must NOT be sent");
        await page.close();
      }
    },
    {
      id: "T1-F08-03",
      feature: "F8",
      name: "Suggestion menu displays multiple options (Grammar / Fluency / Professional)",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "We goes to school.");
        await waitForCondition(() => clickSentenceTrigger(page), {
          label: "click sentence trigger"
        });
        const snap = await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /grammar|fluency|polished/i.test(`${b.text} ${b.ariaLabel}`))
            ? s
            : null;
        }, { label: "suggestion menu options" });
        assert.ok(snap.buttons.length >= 2, "Menu should render multiple suggestion options");
        await page.close();
      }
    },
    {
      id: "T1-F08-04",
      feature: "F8",
      name: "Selecting a sentence suggestion replaces ONLY the targeted sentence",
      async run(session) {
        await session.resetStorage();
        session.setGeminiResponder(() => ({
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        options: [
                          {
                            category: "grammar",
                            label: "Grammar",
                            text: "We go to school."
                          },
                          {
                            category: "fluency",
                            label: "Fluency",
                            text: "We attend school."
                          }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Intro stays here. We goes to school.");
        await waitForCondition(() => clickSentenceTrigger(page), {
          label: "click sentence trigger"
        });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /We go to school|Grammar/i),
          { label: "apply grammar option" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.ok(val.includes("Intro stays here."), "First sentence must remain untouched");
        assert.ok(val.includes("We go to school."), "Target sentence must be replaced");
        assert.equal(val.includes("We goes to school."), false);
        await page.close();
      }
    },
    {
      id: "T1-F08-05",
      feature: "F8",
      name: "Text selection trigger sends ONLY selected text and replaces only selection",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        session.setGeminiResponder(() => ({
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        options: [
                          { category: "fluency", label: "Fluency", text: "concise phrase" }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Prefix wordy rough draft suffix.");
        await selectSubstring(page, "#main-textarea", "wordy rough draft");
        await waitForCondition(() => clickSentenceTrigger(page), {
          label: "click selection trigger"
        });
        await waitForCondition(() => session.getGeminiLog().length > 0, {
          label: "Gemini selection call"
        });
        const req = session.getGeminiLog()[0];
        assert.ok(req.bodyRaw.includes("wordy rough draft"));
        assert.equal(req.bodyRaw.includes("Prefix"), false);
        assert.equal(req.bodyRaw.includes("suffix"), false);
        await waitForCondition(
          () => clickShadowButtonMatching(page, /concise phrase|Fluency/i),
          { label: "apply selection option" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.equal(val, "Prefix concise phrase suffix.");
        await page.close();
      }
    },

    // =========================================================================
    // F9: Manual-only Gemini contextual word finder (5 cases)
    // =========================================================================
    {
      id: "T1-F09-01",
      feature: "F9",
      name: "Unknown word does NOT auto-trigger Gemini contextual word call",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "I need xqzblorf ");
        await page.waitForTimeout(450);
        await assertZeroGeminiCalls(session, "T1-F09-01 unknown word typing");
        await page.close();
      }
    },
    {
      id: "T1-F09-02",
      feature: "F9",
      name: "Uncertain/unknown word popover offers manual Gemini contextual word button",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "I need xqzblorf ");
        const snap = await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /ask gemini|context|bağlam|kelime/i.test(`${b.text} ${b.ariaLabel}`))
            ? s
            : null;
        }, { label: "manual Gemini contextual button" });
        assert.ok(snap.buttons.length >= 1);
        await page.close();
      }
    },
    {
      id: "T1-F09-03",
      feature: "F9",
      name: "Clicking manual contextual word button sends sentence context + target word to Gemini",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "This is xqzblorf for safety. ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "click manual Gemini contextual button" }
        );
        await waitForCondition(() => session.getGeminiLog().length > 0, {
          label: "Gemini contextual request"
        });
        const req = session.getGeminiLog()[0];
        assert.ok(req.bodyRaw.includes("xqzblorf"), "Target token must be in contextual Gemini request");
        assert.ok(req.bodyRaw.includes("safety"), "Surrounding sentence context must be included");
        await page.close();
      }
    },
    {
      id: "T1-F09-04",
      feature: "F9",
      name: "Clicking returned contextual word replaces ONLY the target token",
      async run(session) {
        await session.resetStorage();
        session.setGeminiResponder(() => ({
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestions: [
                          { word: "mandatory", reason: "Fits safety context" },
                          { word: "essential", reason: "Alternative" }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "This is xqzblorf for safety. ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "click manual Gemini button" }
        );
        await waitForCondition(
          () => clickShadowButtonMatching(page, /^mandatory$/i),
          { label: "click returned word mandatory" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.ok(val.includes("This is mandatory for safety."), `Expected replacement, got '${val}'`);
        await page.close();
      }
    },
    {
      id: "T1-F09-05",
      feature: "F9",
      name: "Contextual word finder request goes via background service worker (API key not in page DOM)",
      async run(session) {
        await session.resetStorage({ apiKey: "secret-sentinel-key-999" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Need xqzblorf ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "trigger contextual word finder" }
        );
        await waitForCondition(() => session.getGeminiLog().length > 0, {
          label: "Gemini log entry"
        });
        const req = session.getGeminiLog()[0];
        assert.equal(req.headers["x-goog-api-key"], "secret-sentinel-key-999");
        const leaked = await page.evaluate(() => document.documentElement.innerHTML.includes("secret-sentinel-key-999"));
        assert.equal(leaked, false, "API key must never appear in page DOM");
        await page.close();
      }
    },

    // =========================================================================
    // F10: Chrome & Opera MV3 editor/iframe & Gemini 3.5+ compatibility (5 cases)
    // =========================================================================
    {
      id: "T1-F10-01",
      feature: "F10",
      name: "Works inside <div contenteditable='true'> editor",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#ce-editor")).startsWith("the "),
          { label: "contenteditable spellcheck" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F10-02",
      feature: "F10",
      name: "Works inside same-origin <iframe> textarea and contenteditable",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        const frame = page.frameLocator("#same-origin-iframe");
        const realFrame = page.frames().find((f) => f.url().includes("iframe-inner.html"));
        assert.ok(realFrame, "same-origin iframe frame must exist");
        await typeRealText(realFrame, "#iframe-textarea", "recieve ");
        await waitForCondition(
          async () => (await readEditorText(realFrame, "#iframe-textarea")) === "receive ",
          { label: "iframe textarea spellcheck" }
        );
        assert.ok(frame);
        await page.close();
      }
    },
    {
      id: "T1-F10-03",
      feature: "F10",
      name: "Works inside <iframe srcdoc='...'> due to match_about_blank",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        const srcdocFrame = page.frames().find((f) => f.url().startsWith("about:srcdoc"));
        assert.ok(srcdocFrame, "srcdoc frame must exist");
        await typeRealText(srcdocFrame, "#srcdoc-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(srcdocFrame, "#srcdoc-textarea")) === "özetle ",
          { label: "srcdoc iframe deasciify" }
        );
        await page.close();
      }
    },
    {
      id: "T1-F10-04",
      feature: "F10",
      name: "Gemini requests omit deprecated generationConfig.temperature for Gemini 3.5+ compatibility",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openPopupPage();
        await page.fill("#input-text", "Fix this sentence.");
        await page.click('.action-btn[data-action="fix"]');
        await waitForCondition(() => session.getGeminiLog().length > 0, {
          label: "popup fix Gemini call"
        });
        const req = session.getGeminiLog()[0];
        const temp = req.bodyJson?.generationConfig?.temperature;
        assert.equal(temp, undefined, `Deprecated 'temperature' must be omitted, got ${temp}`);
        await page.close();
      }
    },
    {
      id: "T1-F10-05",
      feature: "F10",
      name: "Popup Shortcuts button handles Chrome vs Opera URL cleanly without throwing",
      async run(session) {
        const page = await session.openPopupPage();
        const popupErrors = [];
        page.on("pageerror", (e) => popupErrors.push(e.message));
        const newTabPromise = session.context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
        await page.click("#open-shortcuts");
        const opened = await newTabPromise;
        if (opened) {
          const url = opened.url();
          if (session.browserName === "opera") {
            assert.ok(
              url.startsWith("opera://") || url.startsWith("chrome://extensions/shortcuts"),
              `Unexpected shortcuts URL in Opera: ${url}`
            );
          } else {
            assert.ok(url.includes("extensions/shortcuts"), `Unexpected shortcuts URL: ${url}`);
          }
          await opened.close().catch(() => {});
        }
        assert.equal(popupErrors.length, 0, `Popup threw errors: ${popupErrors.join("; ")}`);
        await page.close();
      }
    },

    // =========================================================================
    // F11: API key local storage & security-boundary disclosure (5 cases)
    // =========================================================================
    {
      id: "T1-F11-01",
      feature: "F11",
      name: "No hardcoded Gemini API keys (AIza...) anywhere in extension source files",
      async run() {
        const exts = [".js", ".mjs", ".html", ".json", ".css"];
        const walk = (dir) => {
          let hits = [];
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if ([".git", ".agents", "node_modules", "tests"].includes(ent.name)) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) hits = hits.concat(walk(full));
            else if (exts.includes(path.extname(ent.name))) {
              const txt = fs.readFileSync(full, "utf8");
              if (/AIza[0-9A-Za-z_-]{20,}/.test(txt)) hits.push(full);
            }
          }
          return hits;
        };
        const leaks = walk(PROJECT_ROOT);
        assert.deepEqual(leaks, [], `Hardcoded API key pattern found in: ${leaks.join(", ")}`);
      }
    },
    {
      id: "T1-F11-02",
      feature: "F11",
      name: "API key entered in Options saves solely to chrome.storage.local",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        const page = await session.openOptionsPage();
        await page.fill("#api-key", "custom-profile-key-abc");
        await page.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await page.textContent("#status")) || ""),
          { label: "options saved" }
        );
        const stored = await session.getStorage();
        assert.equal(stored.apiKey, "custom-profile-key-abc");
        await page.close();
      }
    },
    {
      id: "T1-F11-03",
      feature: "F11",
      name: "Options page explains local storage security boundary and native helper / proxy requirement",
      async run(session) {
        const page = await session.openOptionsPage();
        const bodyText = await page.textContent("body");
        assert.ok(
          /chrome\.storage\.local|local/i.test(bodyText),
          "Options page must explain local browser storage"
        );
        assert.ok(
          /helper|native|proxy|sunucu|aracı/i.test(bodyText),
          "Options page must explain that stronger protection needs a local helper app or proxy server"
        );
        await page.close();
      }
    },
    {
      id: "T1-F11-04",
      feature: "F11",
      name: "API key input is masked (type=password) by default and toggles Show/Hide",
      async run(session) {
        const page = await session.openOptionsPage();
        assert.equal(await page.getAttribute("#api-key", "type"), "password");
        await page.click("#toggle-key");
        assert.equal(await page.getAttribute("#api-key", "type"), "text");
        await page.click("#toggle-key");
        assert.equal(await page.getAttribute("#api-key", "type"), "password");
        await page.close();
      }
    },
    {
      id: "T1-F11-05",
      feature: "F11",
      name: "Content script global / web page window cannot read stored API key",
      async run(session) {
        await session.resetStorage({ apiKey: "top-secret-key-42" });
        const page = await session.openFixturePage("/index.html");
        const pageDump = await page.evaluate(() => {
          return JSON.stringify({
            ls: Object.assign({}, window.localStorage),
            ss: Object.assign({}, window.sessionStorage),
            globalTextTools: window.__TEXT_AI_TOOLS__ || null
          });
        });
        assert.equal(pageDump.includes("top-secret-key-42"), false, "Page world must never see API key");
        await page.close();
      }
    },

    // =========================================================================
    // F12: Git initialization & public Title Case GitHub repo (5 cases)
    // =========================================================================
    {
      id: "T1-F12-01",
      feature: "F12",
      name: "manifest.json name is 'Text AI Tools' matching Title Case GitHub slug",
      async run() {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")
        );
        assert.equal(manifest.name, "Text AI Tools");
      }
    },
    {
      id: "T1-F12-02",
      feature: "F12",
      name: "Git repository is initialized in project root",
      async run() {
        const out = execFileSync("git", ["-C", PROJECT_ROOT, "rev-parse", "--is-inside-work-tree"], {
          encoding: "utf8"
        }).trim();
        assert.equal(out, "true");
      }
    },
    {
      id: "T1-F12-03",
      feature: "F12",
      name: ".gitignore exists and excludes .agents/, .DS_Store, and node_modules/",
      async run() {
        const giPath = path.join(PROJECT_ROOT, ".gitignore");
        assert.equal(fs.existsSync(giPath), true, ".gitignore must exist");
        const content = fs.readFileSync(giPath, "utf8");
        assert.ok(content.includes(".agents"), ".gitignore must exclude .agents/");
        assert.ok(content.includes(".DS_Store"), ".gitignore must exclude .DS_Store");
      }
    },
    {
      id: "T1-F12-04",
      feature: "F12",
      name: "Git history contains at least one clean commit",
      async run() {
        const sha = execFileSync("git", ["-C", PROJECT_ROOT, "rev-parse", "HEAD"], {
          encoding: "utf8"
        }).trim();
        assert.match(sha, /^[0-9a-f]{40}$/);
      }
    },
    {
      id: "T1-F12-05",
      feature: "F12",
      name: "Git remote origin points to https://github.com/AlpBora/Text-AI-Tools",
      async run() {
        const remote = execFileSync("git", ["-C", PROJECT_ROOT, "remote", "get-url", "origin"], {
          encoding: "utf8"
        }).trim();
        assert.match(
          remote,
          /^https:\/\/github\.com\/AlpBora\/Text-AI-Tools(?:\.git)?$/,
          `Expected AlpBora/Text-AI-Tools remote, got '${remote}'`
        );
      }
    }
  ];
}

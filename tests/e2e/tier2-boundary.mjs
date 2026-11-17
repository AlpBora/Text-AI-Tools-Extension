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

export function buildTier2Cases() {
  return [
    // =========================================================================
    // F1: Boundary & Skip Guard Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F01-01",
      feature: "F1",
      name: "URLs, emails, digits, ALL_CAPS, snake_case, and camelCase are skipped untouched",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        const sample = "Visit https://example.com/teh email user@teh.org v2 12345 NASA snake_case_teh camelCaseTeh ";
        await typeRealText(page, "#main-textarea", sample, { delay: 8 });
        await page.waitForTimeout(300);
        const val = await readEditorText(page, "#main-textarea");
        assert.equal(val, sample, "Technical tokens, URLs, emails, digits, ALL_CAPS must not be modified");
        await assertZeroGeminiCalls(session, "T2-F01-01 skip guards");
        await page.close();
      }
    },
    {
      id: "T2-F01-02",
      feature: "F1",
      name: "type='password' input is NEVER spellchecked and shows no AI buttons",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#password-input", "teh recieve ozetle.");
        await page.waitForTimeout(300);
        assert.equal(await readEditorText(page, "#password-input"), "teh recieve ozetle.");
        const snap = await getShadowSnapshot(page);
        assert.equal(snap.buttons.length, 0, "Password fields must never display AI/undo/suggestion buttons");
        await assertZeroGeminiCalls(session, "T2-F01-02 password input");
        await page.close();
      }
    },
    {
      id: "T2-F01-03",
      feature: "F1",
      name: "type='email' and type='url' inputs are excluded from spellcheck",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#email-input", "teh@example.com ");
        await typeRealText(page, "#url-input", "https://teh.example.com/ozetle ");
        await page.waitForTimeout(250);
        // HTML5 <input type="email"> strips trailing whitespace per spec; verify "teh" stays untouched.
        assert.equal(await readEditorText(page, "#email-input"), "teh@example.com");
        assert.equal(await readEditorText(page, "#url-input"), "https://teh.example.com/ozetle ");
        const snap = await getShadowSnapshot(page);
        assert.equal(snap.buttons.length, 0, "Email/URL inputs must not display spellcheck/AI buttons");
        await assertZeroGeminiCalls(session, "T2-F01-03 email/url inputs");
        await page.close();
      }
    },
    {
      id: "T2-F01-04",
      feature: "F1",
      name: "Readonly input is ignored safely",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        await page.locator("#readonly-input").click();
        await page.waitForTimeout(200);
        assert.equal(await readEditorText(page, "#readonly-input"), "Immutable value");
        const snap = await getShadowSnapshot(page);
        assert.equal(snap.buttons.length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F01-05",
      feature: "F1",
      name: "Internal apostrophe contractions (don't, Ankara'ya) stay intact on boundary",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "I don't go to Ankara'ya ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "I don't go to Ankara'ya ");
        const hl = await getCssHighlights(page);
        assert.equal(hl.length, 0, "Valid apostrophe forms must not be flagged");
        await page.close();
      }
    },

    // =========================================================================
    // F2: Lexicon & Delivery Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F02-01",
      feature: "F2",
      name: "Empty and whitespace-only inputs do not crash or trigger checks",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "     ");
        await page.waitForTimeout(200);
        assert.equal(await readEditorText(page, "#main-textarea"), "     ");
        await assertZeroGeminiCalls(session, "T2-F02-01 whitespace");
        await page.close();
      }
    },
    {
      id: "T2-F02-02",
      feature: "F2",
      name: "Single-letter valid words ('a', 'I', 'o') are not corrupted",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "a I o ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "a I o ");
        await page.close();
      }
    },
    {
      id: "T2-F02-03",
      feature: "F2",
      name: "Punctuation-only bursts ('...', '---', '?!') do not crash or mutate text",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "... --- ?! ");
        await page.waitForTimeout(200);
        assert.equal(await readEditorText(page, "#main-textarea"), "... --- ?! ");
        await page.close();
      }
    },
    {
      id: "T2-F02-04",
      feature: "F2",
      name: "Very long 60-char nonsense token is handled rapidly without freezing",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        const longTok = "abcxyz".repeat(10) + " ";
        const t0 = Date.now();
        await typeRealText(page, "#main-textarea", longTok, { delay: 2 });
        await page.waitForTimeout(200);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 4000, `Long token took too long: ${elapsed}ms`);
        assert.equal(await readEditorText(page, "#main-textarea"), longTok);
        await page.close();
      }
    },
    {
      id: "T2-F02-05",
      feature: "F2",
      name: "spellcheckEnabled=false disables automatic local corrections",
      async run(session) {
        await session.resetStorage({ spellcheckEnabled: false });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "teh recieve ozetle ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "teh recieve ozetle ");
        await page.close();
      }
    },

    // =========================================================================
    // F3: Bilingual Approximate & Phonetic Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F03-01",
      feature: "F3",
      name: "Capitalization is preserved on auto-correction ('Teh ' -> 'The ')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "The ",
          { label: "Teh -> The capitalization" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F03-02",
      feature: "F3",
      name: "Bilingual phonetic attempt 'burokrasi' surfaces 'bureaucracy' or Turkish 'bürokrasi'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "burokrasi ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#main-textarea");
          if (/bürokrasi|bureaucracy/i.test(v)) return true;
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /bürokrasi|bureaucracy/i.test(b.text));
        }, { label: "burokrasi -> bürokrasi / bureaucracy" });
        await page.close();
      }
    },
    {
      id: "T2-F03-03",
      feature: "F3",
      name: "Double-letter / repeated-character typo 'tommorow' resolves to 'tomorrow'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "see you tommorow ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#main-textarea");
          if (v.includes("tomorrow")) return true;
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /tomorrow/i.test(b.text));
        }, { label: "tommorow -> tomorrow" });
        await page.close();
      }
    },
    {
      id: "T2-F03-04",
      feature: "F3",
      name: "Valid short 2-letter words ('in', 'on', 've', 'bu', 'is') are never mangled",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "bu ve in is ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "bu ve in is ");
        await page.close();
      }
    },
    {
      id: "T2-F03-05",
      feature: "F3",
      name: "Unmatchable random consonant cluster 'xqzwvk' does not force-replace",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "xqzwvk ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "xqzwvk ");
        await page.close();
      }
    },

    // =========================================================================
    // F4: Auto-Correct, Underline & Undo Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F04-01",
      feature: "F4",
      name: "Sequential auto-corrections revert the latest correction on Undo without corrupting earlier word",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "teh recieve ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "the receive ",
          { label: "both words auto-corrected" }
        );
        await clickShadowButtonMatching(page, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "the recieve ",
          { label: "latest word reverted to recieve while 'the' preserved" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F04-02",
      feature: "F4",
      name: "After Undo restores original word, typing next word does not re-overwrite reverted word",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "the ",
          { label: "teh -> the" }
        );
        await clickShadowButtonMatching(page, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "teh ",
          { label: "reverted to teh" }
        );
        await typeRealText(page, "#main-textarea", "cat ", { clear: false });
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "teh cat ");
        await page.close();
      }
    },
    {
      id: "T2-F04-03",
      feature: "F4",
      name: "Pressing Escape dismisses uncertain candidate popover without modifying editor text",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "frobozzq ");
        await waitForCondition(() => hasUncertainMarker(page, "frobozzq"), {
          label: "uncertain marker"
        });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        assert.equal(await readEditorText(page, "#main-textarea"), "frobozzq ");
        await page.close();
      }
    },
    {
      id: "T2-F04-04",
      feature: "F4",
      name: "Undo works inside <div contenteditable='true'> cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "recieve ");
        await waitForCondition(
          async () => (await readEditorText(page, "#ce-editor")) === "receive ",
          { label: "CE auto-correct" }
        );
        await clickShadowButtonMatching(page, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(page, "#ce-editor")) === "recieve ",
          { label: "CE undo restored recieve" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F04-05",
      feature: "F4",
      name: "Auto-correct + Undo works in <input type='search'>",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#search-input", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#search-input")) === "özetle ",
          { label: "search input deasciify" }
        );
        await clickShadowButtonMatching(page, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(page, "#search-input")) === "ozetle ",
          { label: "search input undo" }
        );
        await page.close();
      }
    },

    // =========================================================================
    // F5: Language Selection & Estimation Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F05-01",
      feature: "F5",
      name: "Custom unbundled language ('Elvish') saves cleanly and falls back without crashing",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Elvish", secondaryLanguage: "German" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "mellon pedo ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "mellon pedo ");
        assert.equal(session.getPageErrors().length, 0, "Custom language must not throw page errors");
        await page.close();
      }
    },
    {
      id: "T2-F05-02",
      feature: "F5",
      name: "Saving empty primary/secondary language in Options falls back to defaults",
      async run(session) {
        const page = await session.openOptionsPage();
        await page.fill("#primary-language", "   ");
        await page.fill("#secondary-language", "   ");
        await page.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await page.textContent("#status")) || ""),
          { label: "saved status" }
        );
        const stored = await session.getStorage();
        assert.ok(stored.primaryLanguage.length > 0, "Primary language fallback must be non-empty");
        assert.ok(stored.secondaryLanguage.length > 0, "Secondary language fallback must be non-empty");
        await page.close();
      }
    },
    {
      id: "T2-F05-03",
      feature: "F5",
      name: "When German & French are active, Turkish ASCII word 'ozetle' is NOT Turkish-deasciified",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "German", secondaryLanguage: "French" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetle ");
        await page.waitForTimeout(250);
        const val = await readEditorText(page, "#main-textarea");
        assert.equal(val.includes("özetle"), false, "Turkish deasciifier must not run when Turkish is inactive");
        await page.close();
      }
    },
    {
      id: "T2-F05-04",
      feature: "F5",
      name: "Non-Latin script tokens (Cyrillic/Arabic) do not break word-boundary checking",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "привет مرحبا teh ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).includes("the "),
          { label: "subsequent English typo still corrected" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F05-05",
      feature: "F5",
      name: "German Eszett 'Straße' is preserved without crashing",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "German", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Straße ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#main-textarea"), "Straße ");
        await page.close();
      }
    },

    // =========================================================================
    // F6: Turkish Morphology Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F06-01",
      feature: "F6",
      name: "Turkish proper noun with apostrophe ('İstanbul'dan', 'Ankara'ya') accepted cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "İstanbul'dan Ankara'ya ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "İstanbul'dan Ankara'ya ");
        assert.equal((await getCssHighlights(page)).length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F06-02",
      feature: "F6",
      name: "Turkish vowel-drop inflections ('burnu', 'ağzı', 'şehri') accepted without false flags",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "burnu ağzı şehri ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "burnu ağzı şehri ");
        assert.equal((await getCssHighlights(page)).length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F06-03",
      feature: "F6",
      name: "Turkish consonant doubling ('hakkı', 'affı', 'sırrı') accepted without false flags",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "hakkı affı sırrı ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "hakkı affı sırrı ");
        assert.equal((await getCssHighlights(page)).length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F06-04",
      feature: "F6",
      name: "Turkish palatalized loanwords ('saati', 'kalbi', 'hayali') accepted cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "saati kalbi hayali ");
        await page.waitForTimeout(250);
        assert.equal(await readEditorText(page, "#ce-editor"), "saati kalbi hayali ");
        assert.equal((await getCssHighlights(page)).length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F06-05",
      feature: "F6",
      name: "Non-existent Turkish suffix chain 'evlerimizdekilerx' is NOT falsely marked valid or auto-mangled",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "evlerimizdekilerx ");
        await page.waitForTimeout(250);
        const marked = await hasUncertainMarker(page, "evlerimizdekilerx");
        assert.equal(marked, true, "Invalid Turkish suffix should be flagged/uncertain");
        await page.close();
      }
    },

    // =========================================================================
    // F7: Homograph-Safe Deasciifier Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F07-01",
      feature: "F7",
      name: "Turkish homograph 'oldu' is NOT corrupted into 'öldü'",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Bu iyi oldu ");
        await page.waitForTimeout(300);
        assert.equal(await readEditorText(page, "#main-textarea"), "Bu iyi oldu ");
        await page.close();
      }
    },
    {
      id: "T2-F07-02",
      feature: "F7",
      name: "Turkish homographs 'kar', 'yasa', 'on', 'sac' are ALL preserved untouched",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "kar yasa on sac ");
        await page.waitForTimeout(300);
        assert.equal(await readEditorText(page, "#main-textarea"), "kar yasa on sac ");
        await page.close();
      }
    },
    {
      id: "T2-F07-03",
      feature: "F7",
      name: "Ambiguous ASCII Turkish 'uc' (uç vs üç) is NOT blindly auto-replaced",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "uc ");
        await page.waitForTimeout(300);
        assert.equal(await readEditorText(page, "#ce-editor"), "uc ", "Ambiguous 'uc' must not auto-replace");
        const snap = await getShadowSnapshot(page);
        const hl = await getCssHighlights(page);
        assert.ok(
          hl.length > 0 || snap.buttons.some((b) => /uç|üç/i.test(b.text)),
          "Ambiguous 'uc' should show underline or uç/üç candidates"
        );
        await page.close();
      }
    },
    {
      id: "T2-F07-04",
      feature: "F7",
      name: "Sentence-initial capitalized Turkish ASCII 'Ozetle ' preserves title case ('Özetle ')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "Özetle ",
          { label: "Ozetle -> Özetle" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F07-05",
      feature: "F7",
      name: "Homograph 'oldu' followed by deasciifiable 'ozetle' handles both correctly in one sentence",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Toplantı oldu ozetle ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")) === "Toplantı oldu özetle ",
          { label: "oldu preserved, ozetle -> özetle" }
        );
        await page.close();
      }
    },

    // =========================================================================
    // F8: Sentence Icon & Gemini Suggestion Menu Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F08-01",
      feature: "F8",
      name: "Multi-paragraph isolation: applying suggestion to paragraph 2 preserves paragraphs 1 and 3",
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
                        options: [{ category: "grammar", label: "Grammar", text: "Second paragraph is fixed." }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(
          page,
          "#main-textarea",
          "First paragraph untouched.\n\nSecond paragraph broken.\n\nThird paragraph untouched."
        );
        await selectSubstring(page, "#main-textarea", "Second paragraph broken.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /Second paragraph is fixed|Grammar/i),
          { label: "apply paragraph 2 fix" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.ok(val.includes("First paragraph untouched."), "Paragraph 1 must stay intact");
        assert.ok(val.includes("Second paragraph is fixed."), "Paragraph 2 must be updated");
        assert.ok(val.includes("Third paragraph untouched."), "Paragraph 3 must stay intact");
        await page.close();
      }
    },
    {
      id: "T2-F08-02",
      feature: "F8",
      name: "Abbreviation 'Dr.' does not truncate sentence extraction prematurely",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Dr. Smith arrived late today.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(() => session.getGeminiLog().length > 0, { label: "Gemini call" });
        const req = session.getGeminiLog()[0];
        assert.ok(req.bodyRaw.includes("Dr. Smith arrived late today."), "Full sentence with Dr. should be extracted");
        await page.close();
      }
    },
    {
      id: "T2-F08-03",
      feature: "F8",
      name: "Empty editor displays no floating sentence trigger",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        await page.locator("#main-textarea").click();
        await page.waitForTimeout(250);
        const snap = await getShadowSnapshot(page);
        assert.equal(snap.buttons.length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F08-04",
      feature: "F8",
      name: "Gemini HTTP 500 error during sentence suggestion shows error toast without altering text",
      async run(session) {
        await session.resetStorage();
        session.setGeminiResponder(() => ({
          status: 500,
          body: { error: { message: "Simulated server error" } }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Original text stays safe.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return /error|failed|hata/i.test(`${s.toastText} ${s.text}`);
        }, { label: "error feedback in shadow UI" });
        assert.equal(await readEditorText(page, "#main-textarea"), "Original text stays safe.");
        await page.close();
      }
    },
    {
      id: "T2-F08-05",
      feature: "F8",
      name: "Sentence suggestion works inside <div contenteditable='true'> preserving sibling lines",
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
                        options: [{ category: "fluency", label: "Fluency", text: "Updated line two." }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "Line one stays. Line two rough.");
        await selectSubstring(page, "#ce-editor", "Line two rough.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "CE trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /Updated line two|Fluency/i),
          { label: "apply CE option" }
        );
        const val = await readEditorText(page, "#ce-editor");
        assert.ok(val.includes("Line one stays."));
        assert.ok(val.includes("Updated line two."));
        await page.close();
      }
    },

    // =========================================================================
    // F9: Manual Contextual Word Finder Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F09-01",
      feature: "F9",
      name: "Missing API key on manual contextual word click prompts Settings without crashing",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Need xqzblorf ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual button click" }
        );
        await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return /api key|settings|ayarlar|anahtar/i.test(`${s.toastText} ${s.text}`);
        }, { label: "missing key prompt" });
        await assertZeroGeminiCalls(session, "T2-F09-01 missing API key");
        await page.close();
      }
    },
    {
      id: "T2-F09-02",
      feature: "F9",
      name: "Invalid API key HTTP 401 shows error without corrupting target word",
      async run(session) {
        await session.resetStorage({ apiKey: "invalid-key" });
        session.setGeminiResponder(() => ({
          status: 401,
          body: { error: { message: "API key not valid" } }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Need xqzblorf ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual button click" }
        );
        await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return /401|invalid|error|failed|hata/i.test(`${s.toastText} ${s.text}`);
        }, { label: "401 error message" });
        assert.equal(await readEditorText(page, "#main-textarea"), "Need xqzblorf ");
        await page.close();
      }
    },
    {
      id: "T2-F09-03",
      feature: "F9",
      name: "Empty suggestions array from Gemini handles gracefully with message",
      async run(session) {
        await session.resetStorage();
        session.setGeminiResponder(() => ({
          status: 200,
          body: {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ suggestions: [] }) }] } }]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Need xqzblorf ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual button click" }
        );
        await page.waitForTimeout(300);
        assert.equal(await readEditorText(page, "#main-textarea"), "Need xqzblorf ");
        assert.equal(session.getPageErrors().length, 0);
        await page.close();
      }
    },
    {
      id: "T2-F09-04",
      feature: "F9",
      name: "HTML/script metacharacters in Gemini suggestion are escaped safely (no XSS in contenteditable)",
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
                        suggestions: [{ word: "<img src=x onerror=window.__xss=1>", reason: "test" }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "Need xqzblorf ");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual button click" }
        );
        await waitForCondition(
          () => clickShadowButtonMatching(page, /onerror/i),
          { label: "click escaped suggestion" }
        );
        const xssTriggered = await page.evaluate(() => Boolean(window.__xss));
        assert.equal(xssTriggered, false, "Returned suggestion must not execute HTML/JS");
        await page.close();
      }
    },
    {
      id: "T2-F09-05",
      feature: "F9",
      name: "Contextual word replacement works inside same-origin <iframe>",
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
                        suggestions: [{ word: "reliable", reason: "Context fit" }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        const iframe = page.frames().find((f) => f.url().includes("iframe-inner.html"));
        await typeRealText(iframe, "#iframe-textarea", "Very xqzblorf tool. ");
        await waitForCondition(
          () => clickShadowButtonMatching(iframe, /ask gemini|context|bağlam|kelime bul/i),
          { label: "iframe manual Gemini button" }
        );
        await waitForCondition(
          () => clickShadowButtonMatching(iframe, /^reliable$/i),
          { label: "iframe contextual replacement" }
        );
        const val = await readEditorText(iframe, "#iframe-textarea");
        assert.ok(val.includes("Very reliable tool."));
        await page.close();
      }
    },

    // =========================================================================
    // F10: Chrome & Opera MV3 & Iframe Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F10-01",
      feature: "F10",
      name: "Small 220x100 iframe routes large modal result to top frame so modal is not clipped",
      async run(session) {
        await session.resetStorage();
        const page = await session.openFixturePage("/index.html");
        const smallFrame = page.frames().filter((f) => f.url().includes("iframe-inner.html"))[1];
        assert.ok(smallFrame, "Expected second small iframe");
        const sample = "Translate this long text.";
        await typeRealText(smallFrame, "#iframe-textarea", sample);
        await selectSubstring(smallFrame, "#iframe-textarea", sample);

        // Trigger the modal-mode translate result flow on smallFrame via the MV3 service worker
        // so content.js -> relayModalToTopFrame -> background.js -> showTopFrameModal runs end-to-end.
        const expectedTranslation = "Bu uzun metni çevirin. (Top-frame relayed modal)";
        const relayResult = await session.serviceWorker.evaluate(
          async ({ expectedSelection, translatedText }) => {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            const orderedTabs = [
              ...tabs.filter((t) => t.active),
              ...tabs.filter((t) => !t.active)
            ];
            for (const tab of orderedTabs) {
              if (!tab?.id) continue;
              for (let start = 1; start <= 2500; start += 100) {
                const batch = [];
                for (let fid = start; fid < start + 100; fid++) {
                  batch.push(
                    chrome.tabs
                      .sendMessage(tab.id, { type: "getSelection" }, { frameId: fid })
                      .then((res) => ({ fid, text: res?.text || "" }))
                      .catch(() => null)
                  );
                }
                const results = await Promise.all(batch);
                const hit = results.find((r) => r && r.text === expectedSelection);
                if (hit) {
                  await chrome.tabs.sendMessage(
                    tab.id,
                    {
                      type: "applyResult",
                      mode: "modal",
                      text: translatedText,
                      dialogTitle: "Translation",
                      copiedNotice: "Translation copied to clipboard.",
                      copyOnReplace: false
                    },
                    { frameId: hit.fid }
                  );
                  return { tabId: tab.id, frameId: hit.fid, selection: hit.text };
                }
              }
            }
            return null;
          },
          { expectedSelection: sample, translatedText: expectedTranslation }
        );
        assert.ok(relayResult, "Service worker must locate smallFrame selection and deliver applyResult");
        assert.equal(relayResult.selection, sample);

        const topSnap = await waitForCondition(
          async () => {
            const snap = await getShadowSnapshot(page);
            return snap.hasModal ? snap : null;
          },
          { timeout: 3500, label: "top frame modal from small iframe" }
        );
        assert.equal(topSnap.hasModal, true, "Large modal from small iframe must route to top frame");
        assert.ok(
          topSnap.modalText.includes(expectedTranslation),
          `Top frame modal must contain relayed translation, got '${topSnap.modalText}'`
        );
        const smallSnap = await getShadowSnapshot(smallFrame);
        assert.equal(smallSnap.hasModal, false, "Small 220x100 iframe must not render clipped modal locally");
        await page.close();
      }
    },
    {
      id: "T2-F10-02",
      feature: "F10",
      name: "Srcdoc contenteditable iframe supports spellcheck and deasciify",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        const srcdocFrame = page.frames().find((f) => f.url().startsWith("about:srcdoc"));
        assert.ok(srcdocFrame);
        await typeRealText(srcdocFrame, "#srcdoc-ce", "tesekkurler ");
        await waitForCondition(
          async () =>
            (await readEditorText(srcdocFrame, "#srcdoc-ce")).replace(/\u00A0/g, " ") ===
            "teşekkürler ",
          { label: "srcdoc contenteditable deasciify" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F10-03",
      feature: "F10",
      name: "Iframe <input type='text'> supports local spellcheck",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        const iframe = page.frames().find((f) => f.url().includes("iframe-inner.html"));
        await typeRealText(iframe, "#iframe-input", "teh ");
        await waitForCondition(
          async () => (await readEditorText(iframe, "#iframe-input")) === "the ",
          { label: "iframe input[type=text]" }
        );
        await page.close();
      }
    },
    {
      id: "T2-F10-04",
      feature: "F10",
      name: "ContentEditable with nested HTML elements preserves structure on replacement",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        const page = await session.openFixturePage("/index.html");
        await page.evaluate(() => {
          const ce = document.querySelector("#ce-editor");
          ce.innerHTML = "<p><strong>Bold</strong> stays.</p><p id='p2'>teh </p>";
          const p2 = ce.querySelector("#p2");
          ce.focus();
          const range = document.createRange();
          range.selectNodeContents(p2);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        });
        await page.keyboard.type("recieve ", { delay: 14 });
        await waitForCondition(
          async () => (await readEditorText(page, "#ce-editor")).includes("receive"),
          { label: "nested CE paragraph replacement" }
        );
        const strongCount = await page.locator("#ce-editor strong").count();
        assert.equal(strongCount, 1, "Sibling <strong> tag must not be destroyed");
        await page.close();
      }
    },
    {
      id: "T2-F10-05",
      feature: "F10",
      name: "Zero uncaught pageerrors across fixture & extension pages",
      async run(session) {
        await session.resetStorage();
        const errorsBefore = session.getPageErrors().length;
        const p1 = await session.openFixturePage("/index.html");
        const p2 = await session.openOptionsPage();
        const p3 = await session.openPopupPage();
        await p1.waitForTimeout(200);
        assert.equal(session.getPageErrors().length, errorsBefore, "No page errors should occur");
        await p1.close();
        await p2.close();
        await p3.close();
      }
    },

    // =========================================================================
    // F11: API Key & Security Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F11-01",
      feature: "F11",
      name: "Empty API key in Options Test Connection fails locally without outbound Gemini call",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        session.clearGeminiLog();
        const page = await session.openOptionsPage();
        await page.fill("#api-key", "");
        await page.click("#test-btn");
        await waitForCondition(
          async () => /enter an api key|key/i.test((await page.textContent("#status")) || ""),
          { label: "empty key warning" }
        );
        await assertZeroGeminiCalls(session, "T2-F11-01 empty API key");
        await page.close();
      }
    },
    {
      id: "T2-F11-02",
      feature: "F11",
      name: "Safety guard aborts if selected/entered text equals the API key",
      async run(session) {
        const key = "test-safety-abort-key-123";
        await session.resetStorage({ apiKey: key });
        session.clearGeminiLog();
        const page = await session.openPopupPage();
        await page.fill("#input-text", key);
        await page.click('.action-btn[data-action="fix"]');
        await waitForCondition(
          async () => /abort|api key/i.test((await page.textContent("#status")) || ""),
          { label: "API key in text safety abort" }
        );
        await assertZeroGeminiCalls(session, "T2-F11-02 API key safety abort");
        await page.close();
      }
    },
    {
      id: "T2-F11-03",
      feature: "F11",
      name: "Clearing API key in Options removes it from chrome.storage.local",
      async run(session) {
        await session.resetStorage({ apiKey: "temporary-key" });
        const page = await session.openOptionsPage();
        await page.fill("#api-key", "");
        await page.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await page.textContent("#status")) || ""),
          { label: "options cleared saved" }
        );
        const stored = await session.getStorage();
        assert.equal(stored.apiKey, "");
        await page.close();
      }
    },
    {
      id: "T2-F11-04",
      feature: "F11",
      name: "Opening Options page does not fire any automatic Gemini network calls",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openOptionsPage();
        await page.waitForTimeout(300);
        await assertZeroGeminiCalls(session, "T2-F11-04 options load");
        await page.close();
      }
    },
    {
      id: "T2-F11-05",
      feature: "F11",
      name: "Popup does not leak API key into output textarea or window.localStorage",
      async run(session) {
        await session.resetStorage({ apiKey: "my-private-key-777" });
        const page = await session.openPopupPage();
        const lsDump = await page.evaluate(() => JSON.stringify(window.localStorage));
        assert.equal(lsDump.includes("my-private-key-777"), false);
        await page.close();
      }
    },

    // =========================================================================
    // F12: Git & Repo Integrity Boundary Cases (5 cases)
    // =========================================================================
    {
      id: "T2-F12-01",
      feature: "F12",
      name: ".agents/ directory is ignored by git check-ignore",
      async run() {
        const out = execFileSync("git", ["-C", PROJECT_ROOT, "check-ignore", ".agents"], {
          encoding: "utf8"
        }).trim();
        assert.equal(out, ".agents");
      }
    },
    {
      id: "T2-F12-02",
      feature: "F12",
      name: "No .env or secret key files are tracked in git ls-files",
      async run() {
        const tracked = execFileSync("git", ["-C", PROJECT_ROOT, "ls-files"], {
          encoding: "utf8"
        })
          .split(/\r?\n/)
          .filter(Boolean);
        const forbidden = tracked.filter((f) => /(^\.env|\.pem$|\.key$|secret)/i.test(f));
        assert.deepEqual(forbidden, [], `Forbidden tracked files: ${forbidden.join(", ")}`);
      }
    },
    {
      id: "T2-F12-03",
      feature: "F12",
      name: "README.md documents both Google Chrome and Opera installation/support",
      async run() {
        const readme = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf8");
        assert.ok(/Chrome/i.test(readme), "README must mention Chrome");
        assert.ok(/Opera/i.test(readme), "README must mention Opera");
      }
    },
    {
      id: "T2-F12-04",
      feature: "F12",
      name: "All files declared in manifest.json exist on disk",
      async run() {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")
        );
        const pathsToCheck = [
          manifest.options_page,
          manifest.action?.default_popup,
          manifest.background?.service_worker,
          ...Object.values(manifest.icons || {}),
          ...(manifest.content_scripts || []).flatMap((cs) => cs.js || [])
        ].filter(Boolean);
        for (const rel of pathsToCheck) {
          assert.equal(
            fs.existsSync(path.join(PROJECT_ROOT, rel)),
            true,
            `Manifest referenced file missing: ${rel}`
          );
        }
      }
    },
    {
      id: "T2-F12-05",
      feature: "F12",
      name: "manifest.json declares static content_scripts with all_frames=true and match_about_blank=true",
      async run() {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")
        );
        assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);
        const cs = manifest.content_scripts[0];
        assert.equal(cs.all_frames, true);
        assert.equal(cs.match_about_blank, true);
      }
    }
  ];
}

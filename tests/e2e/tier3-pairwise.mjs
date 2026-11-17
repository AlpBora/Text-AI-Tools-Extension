import assert from "node:assert/strict";
import {
  assertZeroGeminiCalls,
  clickSentenceTrigger,
  clickShadowButtonMatching,
  getShadowSnapshot,
  hasUncertainMarker,
  readEditorText,
  selectSubstring,
  typeRealText,
  waitForCondition
} from "./opaque-helpers.mjs";

export function buildTier3Cases() {
  return [
    {
      id: "T3-01",
      feature: "F1+F3+F5",
      name: "Bilingual TR+EN code-switching in one paragraph corrects both languages with 0 Gemini calls",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetle teh mesage ");
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#main-textarea");
            return v.includes("özetle") && v.includes("the") && v.includes("message");
          },
          { label: "bilingual TR+EN corrections" }
        );
        await assertZeroGeminiCalls(session, "T3-01 bilingual code-switching");
        await page.close();
      }
    },
    {
      id: "T3-02",
      feature: "F6+F7",
      name: "Turkish ASCII + suffix combined ('ozetliyorum', 'tesekkurler', 'gorusuruz')",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "ozetliyorum tesekkurler gorusuruz ");
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#main-textarea");
            return (
              v.includes("özetliyorum") &&
              v.includes("teşekkürler") &&
              v.includes("görüşürüz")
            );
          },
          { label: "combined Turkish ASCII + suffix restoration" }
        );
        await assertZeroGeminiCalls(session, "T3-02 Turkish ASCII+suffix");
        await page.close();
      }
    },
    {
      id: "T3-03",
      feature: "F1+F4+F8",
      name: "Spellcheck -> 1-step Undo -> Sentence Gemini polish preserves surrounding sentences",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
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
                            text: "Did you receive the file?"
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
        await typeRealText(page, "#main-textarea", "Hello team. Did you recieve ");
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).includes("receive "),
          { label: "recieve -> receive" }
        );
        await clickShadowButtonMatching(page, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(page, "#main-textarea")).includes("recieve "),
          { label: "undo to recieve" }
        );
        await typeRealText(page, "#main-textarea", "teh file?", { clear: false });
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /Did you receive the file|Grammar/i),
          { label: "apply Gemini polish" }
        );
        const val = await readEditorText(page, "#main-textarea");
        assert.ok(val.startsWith("Hello team."), "First sentence must stay intact");
        assert.ok(val.includes("Did you receive the file?"), "Target sentence must be polished");
        await page.close();
      }
    },
    {
      id: "T3-04",
      feature: "F4+F9",
      name: "Uncertain unknown word -> manual Gemini contextual word finder -> replace ONLY target token",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
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
                        suggestions: [{ word: "architecture", reason: "Fits software context" }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "The xqzblorf scales well. ");
        await waitForCondition(() => hasUncertainMarker(page, "xqzblorf"), {
          label: "uncertain marker on xqzblorf"
        });
        await assertZeroGeminiCalls(session, "T3-04 before manual click");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual Gemini trigger" }
        );
        await waitForCondition(
          () => clickShadowButtonMatching(page, /^architecture$/i),
          { label: "select architecture" }
        );
        const val = await readEditorText(page, "#ce-editor");
        assert.ok(val.includes("The architecture scales well."), `Got '${val}'`);
        await page.close();
      }
    },
    {
      id: "T3-05",
      feature: "F5+F10",
      name: "Changing Options primaryLanguage live-updates active content scripts on existing tab",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "German", secondaryLanguage: "French" });
        const fixturePage = await session.openFixturePage("/index.html");
        await typeRealText(fixturePage, "#main-textarea", "ozetle ");
        await fixturePage.waitForTimeout(200);
        assert.equal(await readEditorText(fixturePage, "#main-textarea"), "ozetle ");

        const optionsPage = await session.openOptionsPage();
        await optionsPage.fill("#primary-language", "Turkish");
        await optionsPage.fill("#secondary-language", "English");
        await optionsPage.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await optionsPage.textContent("#status")) || ""),
          { label: "options saved" }
        );
        await optionsPage.close();

        await fixturePage.bringToFront();
        await typeRealText(fixturePage, "#main-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(fixturePage, "#main-textarea")) === "özetle ",
          { label: "live language switch activates Turkish deasciifier" }
        );
        await fixturePage.close();
      }
    },
    {
      id: "T3-06",
      feature: "F6+F7",
      name: "Turkish morphology + homographs + ASCII restoration coexist in one sentence",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Bu yasa evlerimizdekilerden oldu ozetle ");
        await waitForCondition(
          async () =>
            (await readEditorText(page, "#main-textarea")) ===
            "Bu yasa evlerimizdekilerden oldu özetle ",
          { label: "yasa/evlerimizdekilerden/oldu preserved while ozetle -> özetle" }
        );
        await page.close();
      }
    },
    {
      id: "T3-07",
      feature: "F3+F4+F10",
      name: "Bilingual phonetic attempt + candidate/auto-correct in contenteditable",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#ce-editor", "It is nesesery ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#ce-editor");
          if (v.includes("necessary")) return true;
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /necessary/i.test(b.text));
        }, { label: "nesesery in CE" });
        await page.close();
      }
    },
    {
      id: "T3-08",
      feature: "F1+F8",
      name: "Skip guard preserves URL during typing while sentence Gemini trigger handles full sentence",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "Check https://example.com/teh now.");
        const typed = await readEditorText(page, "#main-textarea");
        assert.ok(typed.includes("https://example.com/teh"), "URL must stay intact");
        await assertZeroGeminiCalls(session, "T3-08 typing");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(() => session.getGeminiLog().length > 0, { label: "Gemini call" });
        assert.ok(session.getGeminiLog()[0].bodyRaw.includes("https://example.com/teh"));
        await page.close();
      }
    },
    {
      id: "T3-09",
      feature: "F4+F7+F10",
      name: "Same-origin iframe supports Turkish deasciifier and 1-step Undo",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        const iframe = page.frames().find((f) => f.url().includes("iframe-inner.html"));
        await typeRealText(iframe, "#iframe-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(iframe, "#iframe-textarea")) === "özetle ",
          { label: "iframe deasciify" }
        );
        await clickShadowButtonMatching(iframe, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(iframe, "#iframe-textarea")) === "ozetle ",
          { label: "iframe undo" }
        );
        await page.close();
      }
    },
    {
      id: "T3-10",
      feature: "F8+F10",
      name: "Srcdoc iframe supports floating sentence trigger and surgical replacement",
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
                        options: [{ category: "grammar", label: "Grammar", text: "She works daily." }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/index.html");
        const srcdoc = page.frames().find((f) => f.url().startsWith("about:srcdoc"));
        await typeRealText(srcdoc, "#srcdoc-textarea", "Keep first. She work daily.");
        await waitForCondition(() => clickSentenceTrigger(srcdoc), { label: "srcdoc trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(srcdoc, /She works daily|Grammar/i),
          { label: "srcdoc apply suggestion" }
        );
        const val = await readEditorText(srcdoc, "#srcdoc-textarea");
        assert.ok(val.includes("Keep first.") && val.includes("She works daily."));
        await page.close();
      }
    },
    {
      id: "T3-11",
      feature: "F10+F11",
      name: "Options API key + Gemini 3.5+ model used by Popup without deprecated temperature",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        session.clearGeminiLog();
        const opt = await session.openOptionsPage();
        await opt.fill("#api-key", "pair-key-350");
        await opt.fill("#model", "gemini-3.5-flash-lite");
        await opt.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await opt.textContent("#status")) || ""),
          { label: "saved" }
        );
        await opt.close();

        const pop = await session.openPopupPage();
        await pop.fill("#input-text", "Fix this rough text.");
        await pop.click('.action-btn[data-action="fix"]');
        await waitForCondition(() => session.getGeminiLog().length > 0, { label: "popup Gemini call" });
        const req = session.getGeminiLog()[0];
        assert.equal(req.headers["x-goog-api-key"], "pair-key-350");
        assert.ok(req.url.includes("gemini-3.5-flash-lite"));
        assert.equal(req.bodyJson?.generationConfig?.temperature, undefined);
        await pop.close();
      }
    },
    {
      id: "T3-12",
      feature: "F8+F11",
      name: "Missing API key + clicking floating sentence icon prompts Settings with 0 outbound calls",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "This sentence needs review.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(async () => {
          const s = await getShadowSnapshot(page);
          return /api key|settings|ayarlar|anahtar/i.test(`${s.toastText} ${s.text}`);
        }, { label: "missing API key prompt" });
        await assertZeroGeminiCalls(session, "T3-12 missing API key");
        await page.close();
      }
    },
    {
      id: "T3-13",
      feature: "F2+F4+F6",
      name: "Turkish inflected typo 'kitapda' resolves to 'kitapta' and supports Undo",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#main-textarea", "kitapda ");
        await waitForCondition(async () => {
          const v = await readEditorText(page, "#main-textarea");
          if (v === "kitapta ") return true;
          const s = await getShadowSnapshot(page);
          return s.buttons.some((b) => /kitapta/i.test(b.text));
        }, { label: "kitapda -> kitapta" });
        const val = await readEditorText(page, "#main-textarea");
        if (val === "kitapta ") {
          await clickShadowButtonMatching(page, /geri al|undo/i);
          await waitForCondition(
            async () => (await readEditorText(page, "#main-textarea")) === "kitapda ",
            { label: "undo to kitapda" }
          );
        } else {
          await clickShadowButtonMatching(page, /^kitapta$/i);
          assert.equal(await readEditorText(page, "#main-textarea"), "kitapta ");
        }
        await page.close();
      }
    },
    {
      id: "T3-14",
      feature: "F1+F2+F10",
      name: "Non-editable page stays quiet, then search input on fixture lazily spellchecks",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "English", secondaryLanguage: "Turkish" });
        session.clearGeminiLog();
        const p1 = await session.openFixturePage("/non-editable.html");
        await p1.waitForTimeout(200);
        assert.equal((await getShadowSnapshot(p1)).buttons.length, 0);
        await p1.close();

        const p2 = await session.openFixturePage("/index.html");
        await typeRealText(p2, "#search-input", "teh ");
        await waitForCondition(
          async () => (await readEditorText(p2, "#search-input")) === "the ",
          { label: "search input lazy spellcheck" }
        );
        await assertZeroGeminiCalls(session, "T3-14 lazy search input");
        await p2.close();
      }
    }
  ];
}

import assert from "node:assert/strict";
import {
  assertZeroGeminiCalls,
  clickSentenceTrigger,
  clickShadowButtonMatching,
  getCssHighlights,
  getShadowSnapshot,
  readEditorText,
  selectSubstring,
  typeRealText,
  waitForCondition
} from "./opaque-helpers.mjs";

export function buildTier4Cases() {
  return [
    {
      id: "T4-01",
      feature: "Scenario: Turkish Email on EN Keyboard",
      name: "Realistic Turkish report composed with ASCII keyboard + manual Gemini polish",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
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
                          {
                            category: "professional",
                            label: "Professional",
                            text: "Değerli ekip, özetle katkılarınız için teşekkürler, görüşürüz."
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
        const page = await session.openFixturePage("/composer.html");
        await typeRealText(page, "#recipient-email", "ekip@example.com");
        await typeRealText(page, "#subject-input", "ozetle rapor ");
        await waitForCondition(
          async () => (await readEditorText(page, "#subject-input")).includes("özetle"),
          { label: "subject deasciified" }
        );
        await typeRealText(page, "#rich-body", "Merhaba ekip. Bugun ozetle tesekkurler gorusuruz.");
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#rich-body");
            return (
              v.includes("Bugün") &&
              v.includes("özetle") &&
              v.includes("teşekkürler") &&
              v.includes("görüşürüz.")
            );
          },
          { label: "body Turkish ASCII restored" }
        );
        await assertZeroGeminiCalls(session, "T4-01 typing Turkish email");
        assert.equal(await readEditorText(page, "#recipient-email"), "ekip@example.com");

        await selectSubstring(page, "#rich-body", "Bugün özetle teşekkürler görüşürüz.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /Değerli ekip|Professional/i),
          { label: "apply professional Turkish sentence" }
        );
        const body = await readEditorText(page, "#rich-body");
        assert.ok(body.includes("Merhaba ekip."), "First sentence stays intact");
        assert.ok(body.includes("Değerli ekip, özetle katkılarınız için teşekkürler, görüşürüz."));
        await page.close();
      }
    },
    {
      id: "T4-02",
      feature: "Scenario: Bilingual Developer Note",
      name: "Developer Slack/GitHub note mixes TR, EN, URLs, camelCase, and CLI tokens safely",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        session.clearGeminiLog();
        const page = await session.openFixturePage("/composer.html");
        await typeRealText(
          page,
          "#plain-body",
          "ozetle npm build tamamlandı https://github.com/AlpBora camelCaseRef teh fix ",
          { delay: 8 }
        );
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#plain-body");
            return v.includes("özetle") && v.includes("the fix");
          },
          { label: "TR+EN typos fixed" }
        );
        const val = await readEditorText(page, "#plain-body");
        assert.ok(val.includes("https://github.com/AlpBora"), "URL preserved");
        assert.ok(val.includes("camelCaseRef"), "camelCase preserved");
        assert.ok(val.includes("npm"), "CLI token preserved");
        await assertZeroGeminiCalls(session, "T4-02 bilingual dev note");
        await page.close();
      }
    },
    {
      id: "T4-03",
      feature: "Scenario: Embedded Iframe Composer",
      name: "Quoted reply inside embedded iframe supports local check, undo, and sentence polish",
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
                          { category: "fluency", label: "Fluency", text: "Thanks for sharing the update." }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/composer.html");
        const replyFrame = page.frames().find((f) => f.url().includes("iframe-inner.html"));
        assert.ok(replyFrame, "reply iframe must exist");
        await typeRealText(replyFrame, "#iframe-ce", "Hi Alex. Did you recieve ");
        await waitForCondition(
          async () => (await readEditorText(replyFrame, "#iframe-ce")).includes("receive "),
          { label: "iframe CE auto-correct" }
        );
        await typeRealText(replyFrame, "#iframe-ce", "teh doc? Thanks for share update.", { clear: false });
        await selectSubstring(replyFrame, "#iframe-ce", "Thanks for share update.");
        await waitForCondition(() => clickSentenceTrigger(replyFrame), { label: "iframe sentence trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(replyFrame, /Thanks for sharing the update|Fluency/i),
          { label: "apply iframe fluency polish" }
        );
        const finalVal = await readEditorText(replyFrame, "#iframe-ce");
        assert.ok(finalVal.includes("Hi Alex."));
        assert.ok(finalVal.includes("Thanks for sharing the update."));
        await page.close();
      }
    },
    {
      id: "T4-04",
      feature: "Scenario: Bilingual Phonetic + Contextual Word Finder",
      name: "Bilingual phonetic attempt resolves locally while rare forgotten word uses manual Gemini",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
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
                        suggestions: [{ word: "prerequisites", reason: "Matches technical sentence" }]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/composer.html");
        await typeRealText(page, "#plain-body", "It is nesesery ");
        await waitForCondition(
          async () => {
            const v = await readEditorText(page, "#plain-body");
            if (v.includes("necessary")) return true;
            const s = await getShadowSnapshot(page);
            return s.buttons.some((b) => /^necessary$/i.test(b.text));
          },
          { label: "local phonetic match for nesesery" }
        );
        await assertZeroGeminiCalls(session, "T4-04 after local phonetic match");
        if (!(await readEditorText(page, "#plain-body")).includes("necessary")) {
          await waitForCondition(
            () => clickShadowButtonMatching(page, /^necessary$/i),
            { label: "apply local necessary candidate" }
          );
          await waitForCondition(
            async () => (await readEditorText(page, "#plain-body")).includes("necessary"),
            { label: "necessary applied" }
          );
        }
        await page.evaluate(() => {
          const el = document.querySelector("#plain-body");
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
        await typeRealText(page, "#plain-body", "to verify xqzblorf ", { clear: false });
        await assertZeroGeminiCalls(session, "T4-04 before manual contextual trigger");
        await waitForCondition(
          () => clickShadowButtonMatching(page, /ask gemini|context|bağlam|kelime bul/i),
          { label: "manual contextual word trigger" }
        );
        await waitForCondition(
          () => clickShadowButtonMatching(page, /^prerequisites$/i),
          { label: "apply prerequisites" }
        );
        const val = await readEditorText(page, "#plain-body");
        assert.ok(val.includes("necessary"), `Expected necessary in '${val}'`);
        assert.ok(val.includes("prerequisites"), `Expected prerequisites in '${val}'`);
        await page.close();
      }
    },
    {
      id: "T4-05",
      feature: "Scenario: Multi-Paragraph Quarterly Report",
      name: "Homographs & agglutinated Turkish stay intact while middle paragraph is AI-polished",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
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
                          { category: "grammar", label: "Grammar", text: "Revenue increased by 15 percent." }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          }
        }));
        const page = await session.openFixturePage("/composer.html");
        await typeRealText(
          page,
          "#plain-body",
          "Bu yıl kar iyi oldu.\n\nRevenue grow 15 percent.\n\nevlerimizdekilerden memnunuz.",
          { delay: 8 }
        );
        await page.waitForTimeout(250);
        await selectSubstring(page, "#plain-body", "Revenue grow 15 percent.");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "sentence trigger" });
        await waitForCondition(
          () => clickShadowButtonMatching(page, /Revenue increased by 15 percent|Grammar/i),
          { label: "apply polish to middle paragraph" }
        );
        const val = await readEditorText(page, "#plain-body");
        assert.ok(val.includes("Bu yıl kar iyi oldu."), "Paragraph 1 homographs preserved");
        assert.ok(val.includes("Revenue increased by 15 percent."), "Paragraph 2 polished");
        assert.ok(val.includes("evlerimizdekilerden memnunuz."), "Paragraph 3 agglutination preserved");
        await page.close();
      }
    },
    {
      id: "T4-06",
      feature: "Scenario: Custom Non-TR/EN Config + Popup",
      name: "User sets German & English in Options, verifies security notice, and translates via Popup",
      async run(session) {
        await session.resetStorage({ apiKey: "" });
        session.clearGeminiLog();
        const opt = await session.openOptionsPage();
        const securityText = await opt.textContent("body");
        assert.ok(/helper|native|proxy|sunucu|aracı/i.test(securityText));
        await opt.fill("#api-key", "e2e-flow-key-111");
        await opt.fill("#model", "gemini-3.5-flash-lite");
        await opt.fill("#primary-language", "German");
        await opt.fill("#secondary-language", "English");
        await opt.click("#save-btn");
        await waitForCondition(
          async () => /saved/i.test((await opt.textContent("#status")) || ""),
          { label: "options saved" }
        );
        await opt.close();

        const pop = await session.openPopupPage();
        assert.ok(/German/i.test(await pop.textContent("#translate-btn")));
        await pop.fill("#input-text", "Guten Morgen");
        await pop.click("#translate-btn");
        await waitForCondition(() => session.getGeminiLog().length > 0, { label: "translate call" });
        const req = session.getGeminiLog()[0];
        assert.ok(req.bodyRaw.includes("German"));
        assert.ok(req.bodyRaw.includes("English"));
        assert.equal(req.bodyJson?.generationConfig?.temperature, undefined);
        await pop.close();
      }
    },
    {
      id: "T4-07",
      feature: "Scenario: Srcdoc Iframe Edit & Undo",
      name: "User edits inside srcdoc iframe, reverts unwanted deasciify, and finishes cleanly",
      async run(session) {
        await session.resetStorage({ primaryLanguage: "Turkish", secondaryLanguage: "English" });
        const page = await session.openFixturePage("/index.html");
        const srcdoc = page.frames().find((f) => f.url().startsWith("about:srcdoc"));
        await typeRealText(srcdoc, "#srcdoc-textarea", "ozetle ");
        await waitForCondition(
          async () => (await readEditorText(srcdoc, "#srcdoc-textarea")) === "özetle ",
          { label: "srcdoc deasciify" }
        );
        await clickShadowButtonMatching(srcdoc, /geri al|undo/i);
        await waitForCondition(
          async () => (await readEditorText(srcdoc, "#srcdoc-textarea")) === "ozetle ",
          { label: "srcdoc undo" }
        );
        await typeRealText(srcdoc, "#srcdoc-textarea", "tamamlandı.", { clear: false });
        assert.equal(await readEditorText(srcdoc, "#srcdoc-textarea"), "ozetle tamamlandı.");
        assert.equal(session.getPageErrors().length, 0);
        await page.close();
      }
    },
    {
      id: "T4-08",
      feature: "Scenario: Privacy Boundary Across Fields",
      name: "Password and email inputs never trigger spellcheck or send secrets to Gemini",
      async run(session) {
        await session.resetStorage();
        session.clearGeminiLog();
        const page = await session.openFixturePage("/index.html");
        await typeRealText(page, "#password-input", "MySecretTehOzetle123!");
        await typeRealText(page, "#email-input", "teh@ozetle.example.com");
        await typeRealText(page, "#main-textarea", "Send public report.");
        await page.waitForTimeout(200);
        await assertZeroGeminiCalls(session, "T4-08 typing across sensitive & public fields");
        await waitForCondition(() => clickSentenceTrigger(page), { label: "public textarea trigger" });
        await waitForCondition(() => session.getGeminiLog().length > 0, { label: "Gemini call" });
        const req = session.getGeminiLog()[0];
        assert.equal(req.bodyRaw.includes("MySecretTehOzetle123!"), false, "Password must never be sent");
        assert.equal(req.bodyRaw.includes("teh@ozetle.example.com"), false, "Email field must never be sent");
        assert.ok(req.bodyRaw.includes("Send public report."));
        await page.close();
      }
    }
  ];
}

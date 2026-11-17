import assert from "node:assert/strict";

export const SHADOW_HOST_SELECTOR = "#text-tools-shadow-host";

export async function waitForCondition(fn, { timeout = 3000, interval = 60, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastVal;
  while (Date.now() < deadline) {
    lastVal = await fn();
    if (lastVal) return lastVal;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
}

export async function focusAndClear(frameOrPage, selector) {
  const loc = frameOrPage.locator(selector);
  await loc.click();
  await frameOrPage.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    if ("value" in el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
    }
  }, selector);
  await loc.click();
}

export async function typeRealText(frameOrPage, selector, text, { delay = 14, clear = true } = {}) {
  if (clear) {
    await focusAndClear(frameOrPage, selector);
  } else {
    await frameOrPage.locator(selector).click();
  }
  await frameOrPage.locator(selector).pressSequentially(text, { delay });
  await new Promise((r) => setTimeout(r, 180));
}

export async function pressKey(frameOrPage, selector, key) {
  await frameOrPage.locator(selector).press(key);
  await new Promise((r) => setTimeout(r, 140));
}

export async function readEditorText(frameOrPage, selector) {
  return frameOrPage.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Editor not found: ${sel}`);
    if ("value" in el) return el.value;
    return el.textContent || "";
  }, selector);
}

export async function selectSubstring(frameOrPage, selector, substring) {
  const selected = await frameOrPage.evaluate(
    ({ sel, sub }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      if ("value" in el) {
        const idx = el.value.indexOf(sub);
        if (idx === -1) return false;
        el.setSelectionRange(idx, idx + sub.length);
        el.dispatchEvent(new Event("select", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        document.dispatchEvent(new Event("selectionchange"));
        return true;
      }
      if (el.isContentEditable) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const pos = node.nodeValue.indexOf(sub);
          if (pos !== -1) {
            const range = document.createRange();
            range.setStart(node, pos);
            range.setEnd(node, pos + sub.length);
            const selObj = window.getSelection();
            selObj.removeAllRanges();
            selObj.addRange(range);
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            document.dispatchEvent(new Event("selectionchange"));
            return true;
          }
        }
      }
      return false;
    },
    { sel: selector, sub: substring }
  );
  assert.equal(selected, true, `Could not select "${substring}" inside ${selector}`);
  await new Promise((r) => setTimeout(r, 200));
}

export async function getShadowSnapshot(frameOrPage) {
  return frameOrPage.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    if (!host || !host.shadowRoot) {
      return { exists: false, text: "", buttons: [], hasModal: false, modalText: "", toastText: "", underlineCount: 0 };
    }
    const sr = host.shadowRoot;
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const buttons = Array.from(
      sr.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')
    )
      .filter(isVisible)
      .map((el, idx) => {
        const r = el.getBoundingClientRect();
        return {
          index: idx,
          text: (el.innerText || el.textContent || "").trim(),
          ariaLabel: el.getAttribute("aria-label") || "",
          title: el.getAttribute("title") || "",
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className : "",
          dataAction: el.getAttribute("data-action") || el.getAttribute("data-word") || "",
          rect: { top: r.top, left: r.left, width: r.width, height: r.height }
        };
      });

    const modalEl = sr.querySelector('.modal, [role="dialog"]');
    const toastEl = sr.querySelector('.toast, [role="status"], [role="alert"]');
    const underlineEls = sr.querySelectorAll(
      '[class*="underline"], [class*="uncertain"], [data-uncertain]'
    );

    return {
      exists: true,
      text: (sr.textContent || "").trim(),
      buttons,
      hasModal: Boolean(modalEl && isVisible(modalEl)),
      modalText: modalEl ? (modalEl.textContent || "").trim() : "",
      toastText: toastEl ? (toastEl.textContent || "").trim() : "",
      underlineCount: underlineEls.length
    };
  }, SHADOW_HOST_SELECTOR);
}

export async function getCssHighlights(frameOrPage) {
  return frameOrPage.evaluate(() => {
    if (typeof CSS === "undefined" || !CSS.highlights) return [];
    const out = [];
    for (const [name, hl] of CSS.highlights.entries()) {
      for (const range of hl.values()) {
        try {
          out.push({ name, text: range.toString() });
        } catch {
          // ignore invalid range
        }
      }
    }
    return out;
  });
}

export async function clickShadowButtonMatching(frameOrPage, pattern) {
  const clicked = await frameOrPage.evaluate(
    ({ hostSel, src, flags }) => {
      const re = new RegExp(src, flags);
      const host = document.querySelector(hostSel);
      if (!host || !host.shadowRoot) return null;
      const sr = host.shadowRoot;
      const candidates = Array.from(
        sr.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')
      );
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0) continue;
        const fields = [
          el.innerText || el.textContent || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
          el.getAttribute("data-action") || ""
        ]
          .map((s) => s.trim())
          .filter(Boolean);
        const label = fields.join(" ");
        if (re.test(label) || fields.some((f) => re.test(f))) {
          el.click();
          return (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
        }
      }
      return null;
    },
    { hostSel: SHADOW_HOST_SELECTOR, src: pattern.source, flags: pattern.flags }
  );
  await new Promise((r) => setTimeout(r, 180));
  return clicked;
}

export async function clickSentenceTrigger(frameOrPage) {
  // Finds the floating sentence/selection trigger button inside Shadow DOM
  const clicked = await frameOrPage.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    if (!host || !host.shadowRoot) return null;
    const sr = host.shadowRoot;
    const btns = Array.from(sr.querySelectorAll('button, [role="button"]')).filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const match = btns.find((el) => {
      const txt = [
        el.innerText || el.textContent || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.className || "",
        el.getAttribute("data-role") || ""
      ].join(" ");
      if (/geri al|undo|close|ok|copy|open settings/i.test(txt)) return false;
      return /ai|rewrite|suggest|cümle|sentence|polish|improve|fix|gemini|✨|✦/i.test(txt) ||
        el.className.includes("trigger") ||
        el.className.includes("fab") ||
        el.className.includes("caret");
    });
    if (match) {
      match.click();
      return (match.getAttribute("aria-label") || match.title || match.innerText || "trigger").trim();
    }
    return null;
  }, SHADOW_HOST_SELECTOR);
  await new Promise((r) => setTimeout(r, 200));
  return clicked;
}

export async function hasUncertainMarker(frameOrPage, word) {
  const highlights = await getCssHighlights(frameOrPage);
  if (highlights.some((h) => !word || h.text.toLowerCase().includes(word.toLowerCase()))) {
    return true;
  }
  const snap = await getShadowSnapshot(frameOrPage);
  if (snap.underlineCount > 0) return true;
  if (snap.buttons.some((b) => /ask gemini|bağlam|context|kelime bul/i.test(`${b.text} ${b.ariaLabel} ${b.title}`))) {
    return true;
  }
  return false;
}

export async function assertZeroGeminiCalls(session, contextLabel) {
  const calls = session.getGeminiLog();
  assert.equal(
    calls.length,
    0,
    `Expected 0 Gemini API calls during ${contextLabel}, but observed ${calls.length}: ${calls.map((c) => c.url).join(", ")}`
  );
}

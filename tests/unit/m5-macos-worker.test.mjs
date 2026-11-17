import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../../macos/engine-worker.mjs";

describe("macOS single-source-of-truth engine-worker", () => {
  it("loads extension lexicons and handles ping + checkWord + recordUndo", async () => {
    const ping = await handleRequest({ id: 1, type: "ping" });
    assert.equal(ping.ok, true);
    assert.ok(ping.langs.includes("tr"));
    assert.ok(ping.langs.includes("en"));

    const res = await handleRequest({
      id: 2,
      type: "checkWord",
      word: "ozetle",
      contextTokens: ["Bugün"],
      appName: "com.apple.Notes",
    });
    assert.equal(res.ok, true);
    assert.equal(res.decision, "auto_correct");
    assert.equal(res.replacement, "özetle");

    const undoRes = await handleRequest({
      id: 3,
      type: "recordUndo",
      originalWord: "testword",
      correctedWord: "test",
    });
    assert.equal(undoRes.ok, true);
  });
});

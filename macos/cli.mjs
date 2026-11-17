#!/usr/bin/env node
/**
 * CLI / macOS Quick Action bridge for Text AI Tools.
 * Reads stdin text and runs any action (fix, concise, professional, translate, summarize)
 * or local word check using the exact same single-source-of-truth engine.
 *
 * Usage:
 *   echo "text" | node macos/cli.mjs --action fix
 */
import { handleRequest } from "./engine-worker.mjs";

const args = process.argv.slice(2);
const actionIdx = args.indexOf("--action");
const actionId = actionIdx >= 0 ? args[actionIdx + 1] : "fix";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

if (!input.trim()) {
  process.exit(0);
}

const res = await handleRequest({ type: "inlineAction", actionId, text: input });
if (!res.ok) {
  process.stderr.write((res.error || "Failed") + "\n");
  process.exit(1);
}
process.stdout.write(res.result);

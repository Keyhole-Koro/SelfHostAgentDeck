#!/usr/bin/env node
// Lean entry point for Claude Code's status line: loads only what the line needs, prints one line
// (or nothing) and never fails.
import { statusLineFor } from "./statusline.ts";

let stdin = "";
if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
try {
  const line = statusLineFor(stdin);
  if (line) process.stdout.write(line + "\n");
} catch {
  // a status line must never break the prompt
}

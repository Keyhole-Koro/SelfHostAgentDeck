import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { tempDir } from "./tmp.ts";

/** The hook as the agents run it: JSON on stdin, a note on stdout only when there is one. */

const ENTRY = join(import.meta.dirname, "..", "src", "hook-entry.ts");
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = tempDir("adv-hook-home-");
  repo = tempDir("adv-hook-repo-");
  env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.ts"), "one\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
});

function hook(agent: "claude" | "codex", event: "PreToolUse" | "PostToolUse", session: string, call: string): string {
  const input = { session_id: session, cwd: repo, hook_event_name: event, tool_name: "Edit", tool_use_id: call, tool_input: { file_path: join(repo, "shared.ts") } };
  return execFileSync(process.execPath, [ENTRY, "--agent", agent], { env, encoding: "utf8", input: JSON.stringify(input) });
}

function running(id: string, pid: number): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, name: `name-${id}`, status: "busy" }));
}

/** The other session edits shared.ts, with the hook recording it. */
function otherEdits(text: string, call: string): void {
  hook("claude", "PreToolUse", "other", call);
  writeFileSync(join(repo, "shared.ts"), text);
  hook("claude", "PostToolUse", "other", call);
}

describe("hook: a file another running session changed", () => {
  it("tells Claude once, before it edits the file, and again after new changes", () => {
    running("other", process.pid);
    otherEdits("one\ntwo\n", "o1");
    const out = hook("claude", "PreToolUse", "me", "m1");
    const note = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string; permissionDecision?: string } };
    assert.equal(note.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(note.hookSpecificOutput.permissionDecision, undefined, "it never decides permissions");
    assert.match(note.hookSpecificOutput.additionalContext, /shared\.ts also has uncommitted changes from another running session: name-other \(Claude other\)/);
    hook("claude", "PostToolUse", "me", "m1");

    assert.equal(hook("claude", "PreToolUse", "me", "m2"), "", "not again for the same changes");
    hook("claude", "PostToolUse", "me", "m2");
    otherEdits("one\ntwo\nthree\n", "o2");
    assert.match(hook("claude", "PreToolUse", "me", "m3"), /additionalContext/, "again after the other session changed it again");
  });

  it("stays quiet when the other session is no longer running, for its own edits, and for Codex", () => {
    otherEdits("one\ntwo\n", "o1"); // "other" has no running process
    assert.equal(hook("claude", "PreToolUse", "me", "m1"), "");
    running("other", process.pid);
    assert.equal(hook("claude", "PreToolUse", "other", "o3"), "", "a session's own changes");
    assert.equal(hook("codex", "PreToolUse", "codex-thread", "c1"), "", "Codex gets no note");
  });

  it("stays quiet once the other session's changes are committed", () => {
    running("other", process.pid);
    otherEdits("one\ntwo\n", "o1");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "theirs"], { cwd: repo });
    assert.equal(hook("claude", "PreToolUse", "me", "m1"), "");
  });
});

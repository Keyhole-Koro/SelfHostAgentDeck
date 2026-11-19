import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

/** Agent Deck was agent-diff: what was set up under the old name keeps working, or moves over. */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

describe("from agent-diff to Agent Deck", () => {
  it("moves the state (holds, the page's token, devices) to its new folder, once", () => {
    const home = mkdtempSync(join(tmpdir(), "adv-rename-"));
    const state = join(home, "state");
    mkdirSync(join(state, "agent-diff"), { recursive: true });
    writeFileSync(join(state, "agent-diff", "token"), "0123456789abcdef0123456789abcdef\n");
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "abc123", cwd: home, name: "old", status: "idle", statusUpdatedAt: Date.now() }));
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: state, AGENT_DECK_STATE_DIR: "", AGENT_DIFF_STATE_DIR: "", NO_COLOR: "1" };
    execFileSync(process.execPath, [CLI, "done", "abc"], { cwd: home, env, encoding: "utf8" });
    assert.equal(existsSync(join(state, "agent-diff")), false);
    assert.equal(readFileSync(join(state, "agent-deck", "token"), "utf8"), "0123456789abcdef0123456789abcdef\n");
    assert.ok(existsSync(join(state, "agent-deck", "holds.json")));
  });

  it("reads settings under their old names too", async () => {
    const { env } = await import("../src/env.ts");
    process.env["AGENT_DIFF_SOMETHING"] = "old";
    assert.equal(env("SOMETHING"), "old");
    process.env["AGENT_DECK_SOMETHING"] = "new";
    assert.equal(env("SOMETHING"), "new");
    assert.equal(env("NOTHING_SET"), undefined);
  });

  it("replaces the hooks, status line and skill installed under the old name", async () => {
    const claude = mkdtempSync(join(tmpdir(), "adv-rename-claude-"));
    process.env["CLAUDE_CONFIG_DIR"] = claude;
    writeFileSync(
      join(claude, "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "^(Edit)$", hooks: [{ type: "command", command: "agent-diff-hook --agent claude" }] }, { matcher: "x", hooks: [{ type: "command", command: "someone-else" }] }] },
        statusLine: { type: "command", command: "agent-diff-statusline" },
      }),
    );
    mkdirSync(join(claude, "skills", "agent-diff-commit"), { recursive: true });
    writeFileSync(join(claude, "skills", "agent-diff-commit", ".installed-by-agent-diff"), "");
    const { installHooks, installSkills, installStatusLine } = await import("../src/install.ts");
    installHooks("claude");
    installStatusLine();
    const skills = installSkills("claude");
    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse as { hooks: { command: string }[] }[];
    assert.equal(pre.length, 2, "the old hook replaced, not doubled; someone else's kept");
    assert.ok(pre.some((g) => g.hooks[0]!.command === "someone-else"));
    assert.ok(pre.some((g) => g.hooks[0]!.command.includes("agent-deck-hook")));
    assert.match(settings.statusLine.command, /agent-deck-statusline/);
    assert.equal(existsSync(join(claude, "skills", "agent-diff-commit")), false);
    assert.ok(skills.installed.includes("agent-deck-commit"));
  });
});

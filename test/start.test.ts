import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { tempDir } from "./tmp.ts";

/** A herdr that logs each call (one per line, its arguments joined by |) and answers like herdr. */
const dir = tempDir("adv-start-");
const log = join(dir, "calls.log");
mkdirSync(join(dir, "config", "herdr"), { recursive: true });
writeFileSync(join(dir, "config", "herdr", "herdr.sock"), "");
process.env["XDG_CONFIG_HOME"] = join(dir, "config");
const fake = join(dir, "herdr");
const answers = join(dir, "workspaces.json");
writeFileSync(
  fake,
  `#!/bin/sh
(IFS='|'; printf '%s\\n' "$*") >> "${log}"
case "$1 $2" in
  "workspace list") printf '{"result":{"type":"workspace_list","workspaces":%s}}\\n' "$(cat "${answers}")" ;;
  "tab create") printf '%s\\n' '{"result":{"type":"tab_created","root_pane":{"pane_id":"w7:p9","cwd":"/w/app"},"tab":{}}}' ;;
  "workspace create") printf '%s\\n' '{"result":{"type":"workspace_created","root_pane":{"pane_id":"w2:p1","cwd":"/w/other"},"tab":{},"workspace":{}}}' ;;
  "worktree create") printf '%s\\n' '{"result":{"type":"worktree_created","root_pane":{"pane_id":"w8:p1"},"worktree":{"path":"/w/app-export","branch":"agent/export"}}}' ;;
  "agent list") printf '%s\\n' '{"result":{"type":"agent_list","agents":[]}}' ;;
  *) printf '%s\\n' '{"result":{"type":"ok"}}' ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env["AGENT_DECK_HERDR"] = fake;
const { agentArgs, checkStart, startSession } = await import("../src/start.ts");
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("agent|list"));

beforeEach(() => {
  if (existsSync(log)) rmSync(log);
  writeFileSync(answers, JSON.stringify([{ workspace_id: "w7", worktree: { checkout_path: "/w/app", repo_root: "/w/app" } }]));
});

describe("starting a session in herdr", () => {
  it("opens a tab in the folder's workspace, starts Claude Code with its model, effort and session id, and prompts it", async () => {
    const s = await startSession({ dir: "/w/app", agent: "claude", model: "opus", effort: "high", prompt: "Add CSV export", files: ["/w/app/.agent-deck/uploads/x.png"] });
    const [list, tab, start, prompt] = calls();
    assert.equal(list, "workspace|list");
    assert.equal(tab, "tab|create|--workspace|w7|--cwd|/w/app|--label|Add CSV export|--no-focus");
    const id = /--session-id\|([0-9a-f-]{36})\|/.exec(start!)?.[1];
    assert.match(start!, /^agent\|start\|app-[0-9a-f]{4}\|--kind\|claude\|--pane\|w7:p9\|--timeout\|60000\|--\|--session-id\|[0-9a-f-]{36}\|--model\|opus\|--effort\|high$/);
    assert.equal(prompt, "agent|prompt|w7:p9|Add CSV export");
    assert.ok(readFileSync(log, "utf8").includes("Files I sent you:\n- /w/app/.agent-deck/uploads/x.png"));
    assert.deepEqual(s, { pane: "w7:p9", socket: join(dir, "config", "herdr", "herdr.sock"), dir: "/w/app", key: `claude:${id}` });
  });

  it("opens a workspace for a folder that has none, and starts Codex", async () => {
    const s = await startSession({ dir: "/w/other", agent: "codex", model: "gpt-6-luna", effort: "max", prompt: "Look around" });
    assert.deepEqual(calls().slice(1, 3), ["workspace|create|--cwd|/w/other|--label|other|--no-focus", 'agent|start|' + calls()[2]!.split("|")[2] + '|--kind|codex|--pane|w2:p1|--timeout|60000|--|-m|gpt-6-luna|-c|model_reasoning_effort="max"']);
    assert.equal(s.key, undefined, "Codex's thread id is known once it shows up");
  });

  it("starts in a new worktree on a branch", async () => {
    const s = await startSession({ dir: "/w/app", agent: "claude", branch: "agent/export", prompt: "Export" });
    assert.equal(calls()[0], "worktree|create|--cwd|/w/app|--branch|agent/export|--label|Export|--no-focus");
    assert.equal(s.dir, "/w/app-export");
  });

  it("opens a session again by its id, with the same conversation, in a tab named after it", async () => {
    const id = "4f2a9c1e-7b3d-4e8a-9c21-5d6e7f8a9b0c";
    const s = await startSession({ dir: "/w/app", agent: "claude", prompt: "", resume: id, label: "Add due dates" });
    const [, tab, start, ...more] = calls();
    assert.equal(tab, "tab|create|--workspace|w7|--cwd|/w/app|--label|Add due dates|--no-focus");
    assert.match(start!, new RegExp(`\\|--kind\\|claude\\|--pane\\|w7:p9\\|--timeout\\|60000\\|--\\|--resume\\|${id}$`));
    assert.deepEqual(more, [], "nothing is typed into it");
    assert.equal(s.key, `claude:${id}`, "Claude Code keeps the id it resumes");
    assert.deepEqual(agentArgs({ agent: "codex", resume: "019a3c5e-2f1b-7d40-8e6a-b1c2d3e4f5a6", model: "x" }), ["resume", "019a3c5e-2f1b-7d40-8e6a-b1c2d3e4f5a6"]);
    assert.throws(() => checkStart({ dir: "/w/app", agent: "claude", prompt: "", resume: "--dangerously-skip-permissions" }), /session id/);
  });

  it("takes only a model name, a known effort and a branch git takes", () => {
    const ok = { dir: "/w/app", agent: "claude" as const, prompt: "x" };
    assert.throws(() => checkStart({ ...ok, model: "opus; rm -rf /" }), /model/);
    assert.throws(() => checkStart({ ...ok, effort: "extreme" }), /Effort/);
    assert.throws(() => checkStart({ ...ok, branch: "../main" }), /branch/);
    assert.throws(() => checkStart({ ...ok, branch: "-x" }), /branch/);
    assert.doesNotThrow(() => checkStart({ ...ok, model: "claude-opus-5-5", effort: "max", branch: "agent/export-2" }));
    assert.deepEqual(agentArgs({ agent: "claude" }), []);
  });
});

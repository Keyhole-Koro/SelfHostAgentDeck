import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { codexCommand, endsWithQuestion, readInbox, terminalApp, transcriptOf, type InboxItem } from "../src/inbox.ts";

const HOUR = 36e5;
let home: string; // stands for ~/.claude
let codex: string; // stands for ~/.codex
const holders: ChildProcess[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "adv-inbox-"));
  home = join(root, "claude");
  codex = join(root, "codex");
});

after(() => {
  // flock runs sleep as a child: stop the whole group, or the sleep outlives the test.
  for (const h of holders) if (h.pid) process.kill(-h.pid, "SIGTERM");
});

const iso = (ms: number) => new Date(ms).toISOString();
const inbox = (opts: { now?: number; staleAfter?: number; light?: boolean } = {}) => readInbox({ claudeHome: home, codexHome: codex, ...opts });
const byKey = (items: InboxItem[]) => Object.fromEntries(items.map((i) => [i.key, i]));

/** A running Claude Code process's record, as Claude Code writes it. */
function running(id: string, record: object = {}, pid = process.pid): void {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: "/w/app", name: `name-${id}`, kind: "interactive", status: "idle", statusUpdatedAt: Date.now(), ...record }));
}

function transcript(id: string, rows: object[]): string {
  const dir = join(home, "projects", "-w-app");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify({ sessionId: id, timestamp: iso(Date.now()), ...r })).join("\n") + "\n");
  return file;
}

const say = (text: string, usage?: object) => ({ type: "assistant", message: { content: [{ type: "text", text }], ...(usage && { usage }) } });
const prompt = (text: string) => ({ type: "user", message: { content: text } });
const tool = (id: string, name: string, input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, toolUseResult: object = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult });

describe("inbox: what a Claude transcript adds", () => {
  it("reads the title, your last prompt, the last reply and Claude Code's recap", () => {
    transcript("s1", [
      prompt("Fix the flaky login test"),
      { type: "last-prompt", lastPrompt: "Fix the flaky login test" },
      { type: "ai-title", aiTitle: "Flaky login test" },
      say("Fixed it.\n\nShall I open a PR?"),
      { type: "system", subtype: "away_summary", content: "You asked me to fix the flaky login test; I fixed the race." },
    ]);
    running("s1");
    const [item] = inbox().items;
    assert.equal(item?.title, "Flaky login test");
    assert.equal(item?.name, "name-s1");
    assert.equal(item?.lastPrompt, "Fix the flaky login test");
    assert.match(item?.lastMessage ?? "", /Shall I open a PR\?$/);
    assert.equal(item?.asks, true);
    assert.match(item?.awaySummary ?? "", /fixed the race/);
  });

  it("drops the recap once you prompted again", () => {
    transcript("s1", [
      prompt("one"),
      { type: "last-prompt", lastPrompt: "one" },
      { type: "system", subtype: "away_summary", content: "Recap of one." },
      prompt("two"),
      { type: "last-prompt", lastPrompt: "two" },
    ]);
    running("s1");
    const [item] = inbox().items;
    assert.equal(item?.awaySummary, undefined);
    assert.equal(item?.lastPrompt, "two");
  });

  it("follows the task list: created, started, finished, deleted", () => {
    transcript("s1", [
      tool("c1", "TaskCreate", { subject: "Write the parser", activeForm: "Writing the parser" }),
      result("c1", { task: { id: "1", subject: "Write the parser" } }),
      tool("c2", "TaskCreate", { subject: "Test it" }),
      result("c2", { task: { id: "2" } }),
      tool("c3", "TaskCreate", { subject: "Dropped" }),
      result("c3", { task: { id: "3" } }),
      tool("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      tool("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }),
      tool("u3", "TaskUpdate", { taskId: "3", status: "deleted" }),
    ]);
    running("s1");
    const [item] = inbox().items;
    assert.deepEqual(
      item?.tasks?.map((t) => [t.id, t.subject, t.status]),
      [
        ["1", "Write the parser", "completed"],
        ["2", "Test it", "in_progress"],
      ],
    );
  });

  it("reads a TodoWrite list too", () => {
    transcript("s1", [tool("t1", "TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B", status: "pending" }] })]);
    running("s1");
    assert.deepEqual(inbox().items[0]?.tasks?.map((t) => t.status), ["completed", "pending"]);
  });

  it("lists background commands and monitors until they finish or are stopped", () => {
    const started = Date.now() - 2 * HOUR;
    transcript("s1", [
      { ...tool("b1", "Bash", { command: "npm run e2e", description: "Run the e2e suite", run_in_background: true }), timestamp: iso(started) },
      result("b1", { backgroundTaskId: "bg1" }),
      tool("b2", "Bash", { command: "sleep 1", run_in_background: true }),
      result("b2", { backgroundTaskId: "bg2" }),
      tool("m1", "Monitor", { command: "gh pr checks 5 --watch", description: "Watch PR 5's checks" }),
      result("m1", { taskId: "mon1" }),
      tool("m2", "Monitor", { command: "tail -f log" }),
      result("m2", { taskId: "mon2" }),
      prompt("<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n</task-notification>"),
      { type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>mon1</task-id>\n<status>completed</status>" },
      tool("s1", "TaskStop", { task_id: "mon2" }),
    ]);
    running("s1", { status: "shell" });
    const [item] = inbox().items;
    assert.equal(item?.state, "working");
    assert.equal(item?.reason, "background command");
    assert.deepEqual(item?.background?.map((b) => [b.id, b.kind, b.command]), [["bg1", "command", "Run the e2e suite"]]);
    assert.equal(item?.background?.[0]?.since, Date.parse(iso(started)));
  });

  it("keeps the pull requests the session opened", () => {
    transcript("s1", [
      { type: "pr-link", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prRepository: "o/r" },
      { type: "pr-link", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prRepository: "o/r" },
      { type: "pr-link", prNumber: 8, prUrl: "https://github.com/o/r/pull/8", prRepository: "o/r" },
    ]);
    running("s1");
    assert.deepEqual(inbox().items[0]?.prs, [
      { url: "https://github.com/o/r/pull/7", number: 7, repo: "o/r" },
      { url: "https://github.com/o/r/pull/8", number: 8, repo: "o/r" },
    ]);
  });

  it("keeps the pages the session published, with the MCP tool or the CLI, and where its transcript is", () => {
    const file = transcript("s1", [
      tool("p1", "mcp__artifact__publish", { file_path: "/tmp/x/report.html", title: "Outage report" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "Published: https://pages.example/a/abc (version 1, private)" }] } },
      tool("p2", "Bash", { command: "artifact publish notes.html --title 'Notes' --json" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p2", content: JSON.stringify({ url: "https://pages.example/a/def", created: true }) }] } },
      tool("p3", "mcp__artifact__publish", { file_path: "/tmp/x/failed.html" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p3", content: "Error: not allowed" }] } },
      tool("b1", "Bash", { command: "npm test" }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "see https://example.com/docs" }] } },
    ]);
    running("s1");
    const item = inbox().items[0]!;
    assert.deepEqual(item.pages?.map((p) => [p.url, p.title]), [
      ["https://pages.example/a/abc", "Outage report"],
      ["https://pages.example/a/def", "Notes"],
    ]);
    assert.equal(transcriptOf(item), file);
    assert.equal(Object.keys(item).includes("transcript"), false, "kept off what the page is sent");
  });

  it("measures the context, and remembers where it was last compacted", () => {
    transcript("s1", [
      say("a", { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 10 }),
      { type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 190000 } },
    ]);
    running("s1");
    assert.deepEqual(inbox().items[0]?.context, { compactions: 1, lastCompactTokens: 190000 }, "unknown right after compacting");
    appendFileSync(join(home, "projects", "-w-app", "s1.jsonl"), JSON.stringify(say("b", { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 40000 })) + "\n");
    assert.deepEqual(inbox().items[0]?.context, { compactions: 1, lastCompactTokens: 190000, tokens: 40003 });
  });

  it("reads only what was appended since the last look", () => {
    const file = transcript("s1", [{ type: "ai-title", aiTitle: "First" }, { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 1 } }]);
    running("s1");
    assert.equal(inbox().items[0]?.title, "First");
    appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "Second" }) + "\n" + '{"type":"ai-title","aiTi'); // a line still being written
    const item = inbox().items[0];
    assert.equal(item?.title, "Second");
    assert.equal(item?.context?.compactions, 1, "lines already read are not counted again");
    appendFileSync(file, 'tle":"Third"}\n');
    assert.equal(inbox().items[0]?.title, "Third");
  });

  it("shows the unanswered AskUserQuestion of a waiting session, not answered ones", () => {
    transcript("s1", [
      tool("q1", "AskUserQuestion", { questions: [{ question: "Old?", options: [{ label: "x" }] }] }),
      result("q1"),
      tool("q2", "AskUserQuestion", { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] }),
    ]);
    running("s1", { status: "waiting", waitingFor: "input needed" });
    assert.deepEqual(inbox().items[0]?.questions, [{ question: "Which one?", options: ["A", "B"] }]);
  });

  it("shows the plan a waiting session asks you to approve, and the model it answers with", () => {
    transcript("s1", [
      { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Here is my plan." }] } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API error" }] } },
      tool("p1", "ExitPlanMode", { plan: "## Plan\n1. Add the column" }),
    ]);
    running("s1", { status: "waiting", waitingFor: "approve ExitPlanMode" });
    const item = inbox().items[0]!;
    assert.equal(item.plan, "## Plan\n1. Add the column");
    assert.equal(item.model, "claude-opus-5-5");
  });

  it("reads only the title in light mode", () => {
    transcript("s1", [{ type: "ai-title", aiTitle: "T" }, say("hi")]);
    running("s1", { status: "waiting", waitingFor: "approve Bash: ls" });
    const [item] = inbox({ light: true }).items;
    assert.equal(item?.state, "needs-answer");
    assert.equal(item?.reason, "approve Bash: ls");
    assert.equal(item?.title, "T");
    assert.equal(item?.lastMessage, undefined);
  });

  it("measures the process's memory on Linux", { skip: process.platform !== "linux" }, () => {
    running("s1");
    assert.ok((inbox().items[0]?.memory ?? 0) > 1e6);
  });
});

describe("inbox: Claude Code background sessions", () => {
  function job(short: string, state: object): void {
    const dir = join(home, "jobs", short);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ daemonShort: short, cwd: "/w/app", name: `job ${short}`, ...state }));
  }

  it("lists a parked session that is blocked on you, with what it needs and its PRs", () => {
    job("ab12cd34", {
      state: "blocked",
      sessionId: "parked",
      needs: "approve the npm release with 2FA",
      detail: "staged",
      updatedAt: iso(Date.now() - HOUR),
      children: [{ kind: "pr", href: "https://github.com/o/r/pull/51" }],
    });
    const [item] = inbox().items;
    assert.equal(item?.key, "claude:parked");
    assert.equal(item?.state, "needs-answer");
    assert.equal(item?.reason, "approve the npm release with 2FA");
    assert.equal(item?.resume, "claude attach ab12cd34");
    assert.deepEqual(item?.prs, [{ url: "https://github.com/o/r/pull/51", number: 51, repo: "o/r" }]);
  });

  it("folds a blocked session nobody answered for days into stale", () => {
    job("old", { state: "blocked", sessionId: "old", needs: "x", updatedAt: iso(Date.now() - 5 * 24 * HOUR) });
    job("done", { state: "done", sessionId: "done", updatedAt: iso(Date.now() - HOUR) });
    const by = byKey(inbox().items);
    assert.equal(by["claude:old"]?.state, "stale");
    assert.equal(by["claude:done"]?.state, "your-turn");
  });

  it("joins a running background session's record with its job", () => {
    job("cafe0001", { state: "blocked", sessionId: "live", needs: "pick a name" });
    running("live", { kind: "bg", status: "waiting", waitingFor: "input needed" });
    const items = inbox().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.jobId, "cafe0001");
    assert.equal(items[0]?.resume, "claude attach cafe0001");
    assert.equal(items[0]?.reason, "input needed · pick a name");
  });
});

describe("inbox: Codex", () => {
  function thread(id: string, events: object[], { hold = true } = {}): string {
    const dir = join(codex, "sessions", "2026", "11", "19");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-19T00-00-00-${id}.jsonl`);
    writeFileSync(file, [{ timestamp: iso(Date.now()), type: "session_meta", payload: { id, cwd: "/w/app" } }, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const locks = join(codex, "thread-writer-locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${id}.lock`), "");
    if (hold && process.platform === "linux") holders.push(spawn("flock", [join(locks, `${id}.lock`), "sleep", "60"], { stdio: "ignore", detached: true }));
    return file;
  }
  const ev = (payload: object, at = Date.now()) => ({ timestamp: iso(at), type: "event_msg", payload });
  const call = (callId: string, input: string, at: number) => ({ timestamp: iso(at), type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input } });
  const output = (callId: string) => ({ timestamp: iso(Date.now()), type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: [] } });
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it("reads your last prompt, the context, and the account's rate limits", { skip: process.platform === "linux" && !existsSync("/usr/bin/flock") }, async () => {
    const id = "01a1e377-0000-7000-8000-000000000001";
    thread(id, [
      ev({ type: "task_started" }),
      ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Where is validation done?" }] } }),
      ev({ type: "token_count", info: { last_token_usage: { input_tokens: 20000, total_tokens: 21000 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1800000000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1800500000 } } }),
      ev({ type: "task_complete", last_agent_message: "In contracts/." }),
    ]);
    await settle();
    const r = inbox();
    const item = byKey(r.items)[`codex:${id}`];
    assert.equal(item?.state, "your-turn");
    assert.equal(item?.lastPrompt, "Where is validation done?");
    assert.deepEqual(item?.context, { tokens: 21000, compactions: 0, window: 258400 });
    assert.deepEqual(r.codexLimits?.primary, { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1800000000000 });
    assert.equal(r.codexLimits?.secondary?.usedPercent, 40);
  });

  it("flags a command that has waited long without output as maybe needing approval", { skip: process.platform === "linux" && !existsSync("/usr/bin/flock") }, async () => {
    const slow = "01a1e377-0000-7000-8000-000000000002";
    const quick = "01a1e377-0000-7000-8000-000000000003";
    const answered = "01a1e377-0000-7000-8000-000000000004";
    thread(slow, [ev({ type: "task_started" }), call("c1", 'const r = await tools.exec_command({cmd:"rm -rf build \\"out\\"",workdir:"/w"});', Date.now() - 5 * 60_000)]);
    thread(quick, [ev({ type: "task_started" }), call("c2", 'tools.exec_command({cmd:"ls"})', Date.now() - 1000)]);
    thread(answered, [ev({ type: "task_started" }), call("c3", 'tools.exec_command({cmd:"ls"})', Date.now() - 5 * 60_000), output("c3")]);
    await settle();
    const by = byKey(inbox().items);
    assert.equal(by[`codex:${slow}`]?.state, "working");
    assert.equal(by[`codex:${slow}`]?.reason, 'may need approval: rm -rf build "out"');
    assert.equal(by[`codex:${quick}`]?.reason, undefined);
    assert.equal(by[`codex:${quick}`]?.inFlight?.command, "ls");
    assert.equal(by[`codex:${answered}`]?.inFlight, undefined);
  });

  it("knows the process that holds a thread, and so its herdr pane", { skip: process.platform !== "linux" || !existsSync("/usr/bin/flock") }, async () => {
    const id = "01a1e377-0000-7000-8000-000000000005";
    thread(id, [ev({ type: "task_complete", last_agent_message: "Done." })], { hold: false });
    const holder = spawn("flock", [join(codex, "thread-writer-locks", `${id}.lock`), "sleep", "60"], { stdio: "ignore", detached: true, env: { ...process.env, HERDR_PANE_ID: "w3:p2", HERDR_SOCKET_PATH: "/run/h.sock" } });
    holders.push(holder);
    await settle();
    const item = byKey(inbox().items)[`codex:${id}`];
    assert.equal(item?.pid, holder.pid);
    assert.deepEqual(item?.terminal, { herdrPane: "w3:p2", herdrSocket: "/run/h.sock" });
    assert.equal(item?.runsIn, undefined, "in herdr, the terminal app does not matter");
  });

  it("reads the command out of exec's JavaScript and out of JSON arguments", () => {
    assert.equal(codexCommand("exec", 'tools.exec_command({cmd:"git status",workdir:"/w"})'), "git status");
    assert.equal(codexCommand("shell", JSON.stringify({ command: ["bash", "-lc", "npm test"] })), "bash -lc npm test");
    assert.equal(codexCommand("apply_patch", 42), "apply_patch");
  });
});

describe("inbox: where a session runs outside herdr", () => {
  it("names the terminal app, from the session's parent processes", { skip: process.platform !== "linux" }, async () => {
    // A stand-in for Ptyxis's process, with a session (sleep) under it.
    const dir = mkdtempSync(join(tmpdir(), "adv-app-"));
    const app = join(dir, "ptyxis-agent");
    writeFileSync(app, '#!/bin/sh\nsleep 60 &\necho $! > "$1"\nwait\n');
    chmodSync(app, 0o755);
    holders.push(spawn(app, [join(dir, "pid")], { stdio: "ignore", detached: true }));
    let pid = 0;
    for (let n = 0; n < 50 && !pid; n++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = existsSync(join(dir, "pid")) ? Number(readFileSync(join(dir, "pid"), "utf8")) : 0;
    }
    assert.equal(terminalApp(pid), "Ptyxis");
    running("outside", {}, pid);
    const item = byKey(inbox().items)["claude:outside"];
    assert.equal(item?.runsIn, "Ptyxis");
    assert.equal(item?.terminal, undefined);
    assert.equal(terminalApp(999_999_999), undefined);
  });
});

describe("endsWithQuestion", () => {
  it("finds a question in the last paragraph, Japanese ones ending in か。 too", () => {
    assert.equal(endsWithQuestion("Pushed.\n\nShall I open the PR?"), true);
    assert.equal(endsWithQuestion("A はこのまま消してよいですか。B は残します。"), true);
    assert.equal(endsWithQuestion("消してよいですか？\n\n消さずに残しました。"), false);
    assert.equal(endsWithQuestion("テストは全部通っています。"), false);
  });
});

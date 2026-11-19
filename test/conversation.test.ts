import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chatImage, readChat, type ChatMessage } from "../src/conversation.ts";
import { tempDir } from "./tmp.ts";

const dir = tempDir("adv-chat-");
let n = 0;
const file = (lines: object[], tail = "") => {
  const f = join(dir, `t${n++}.jsonl`);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + tail);
  return f;
};
const T = (min: number) => new Date(Date.UTC(2026, 10, 19, 0, min)).toISOString();
const user = (content: unknown, extra: object = {}) => ({ type: "user", timestamp: T(0), message: { role: "user", content }, ...extra });
const assistant = (...content: object[]) => ({ type: "assistant", timestamp: T(1), message: { role: "assistant", content } });
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: unknown, isError = false) => user([{ type: "tool_result", tool_use_id: id, content, ...(isError && { is_error: true }) }]);
const brief = (m: ChatMessage) => [m.role, m.kind ?? m.tool ?? "", m.text ?? m.detail ?? "", m.error ? "failed" : ""].filter(Boolean).join(" | ");

describe("Claude Code transcripts", () => {
  it("keeps what you and it said, and its steps; leaves out tool output and harness text", () => {
    const cwd = "/work/app";
    const f = file([
      { type: "mode", mode: "default" },
      user("Fix the login bug"),
      user("<system-reminder>be nice</system-reminder>"),
      user("Base directory for this skill: …", { isMeta: true }),
      assistant({ type: "thinking", thinking: "hmm" }, text("Looking at it.")),
      assistant(use("b1", "Bash", { command: "npm test", description: "Run tests" })),
      result("b1", "1 failing", true),
      assistant(use("e1", "Edit", { file_path: "/work/app/src/login.ts", old_string: "a", new_string: "b" })),
      result("e1", "ok"),
      assistant(use("q1", "AskUserQuestion", { questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }] })),
      result("q1", 'User has answered your questions: "Ship it?"="Yes". You can now continue.'),
      { type: "assistant", isSidechain: true, message: { content: [text("subagent chatter")] } },
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 1 } },
      user("This session is being continued from a previous conversation…", { isCompactSummary: true }),
      user("<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>"),
      user("<bash-input>git status</bash-input>"),
      user("<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>"),
      user("<task-notification><task-id>x</task-id><summary>Background command \"build\" completed</summary></task-notification>"),
      user([text("[Request interrupted by user]")]),
      { type: "system", subtype: "away_summary", content: "You asked for a fix; tests fail." },
      assistant(text("Done. Want a PR?")),
    ]);
    const page = readChat(f, "claude", { cwd });
    assert.deepEqual(page.messages.map(brief), [
      "user | Fix the login bug",
      "assistant | Looking at it.",
      "tool | Bash | npm test | failed",
      "tool | Edit | src/login.ts",
      "tool | Asked | Ship it?",
      "user | answer | Ship it? → Yes",
      "event | compact | Conversation compacted",
      "event | summary | This session is being continued from a previous conversation…",
      "user | command | /model opus",
      "user | shell | ! git status",
      "event | output | clean",
      'event | task | Background command "build" completed',
      "event | interrupted | Interrupted",
      "event | recap | You asked for a fix; tests fail.",
      "assistant | Done. Want a PR?",
    ]);
    assert.equal(page.messages[3]!.path, "/work/app/src/login.ts");
    assert.equal(page.before, undefined, "the whole conversation fit");
    assert.equal(new Set(page.messages.map((m) => m.id)).size, page.messages.length, "ids are unique");
  });

  it("marks a step failed from a result too big to parse", () => {
    const big = "x".repeat(400_000);
    const f = file([assistant(use("r1", "Read", { file_path: "/a/big.log" })), result("r1", big, true)]);
    const [step] = readChat(f, "claude").messages;
    assert.equal(step!.error, true);
  });

  it("points at the images you sent and those its tools saw, to fetch one at a time", () => {
    const png = (b: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(b).toString("base64") } });
    const big = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("J".repeat(300_000)).toString("base64") } };
    const f = file([
      user([png("mine"), text("[Image #1] why is this cut off?")]),
      user([png("alone")]),
      assistant(use("r1", "Read", { file_path: "/w/shot.png" })),
      // Claude Code keeps the image again under toolUseResult: not a second one.
      { ...result("r1", [png("read")]), toolUseResult: { type: "image", file: { base64: "x", type: "image/png" } } },
      assistant(use("s1", "mcp__browser__screenshot", {})),
      { ...result("s1", [text("a screenshot"), big]), toolUseResult: { type: "image", file: { base64: "y" } } },
    ]);
    const m = readChat(f, "claude").messages;
    assert.deepEqual(m.map((x) => [x.role, x.text ?? x.tool, x.images?.length ?? 0]), [
      ["user", "[Image #1] why is this cut off?", 1],
      ["user", undefined, 1],
      ["tool", "Read", 1],
      ["tool", "browser · screenshot", 1],
    ]);
    const get = (ref: string) => {
      const [at, n] = ref.split(":").map(Number);
      const img = chatImage(f, "claude", at!, n!);
      return img && "data" in img ? `${img.type} ${Buffer.from(img.data, "base64").toString().slice(0, 5)}` : img;
    };
    assert.deepEqual(m.map((x) => get(x.images![0]!)), ["image/png mine", "image/png alone", "image/png read", "image/jpeg JJJJJ"], "the big line too");
    const at = Number(m[0]!.images![0]!.split(":")[0]);
    assert.equal(chatImage(f, "claude", at + 1, 0), undefined, "only where a line starts");
    assert.equal(chatImage(f, "claude", at, 5), undefined);
  });

  it("pages back to the start without gaps or repeats", () => {
    const lines: object[] = [];
    for (let i = 0; i < 100; i++) lines.push(user(`question ${i}`), assistant(use(`t${i}`, "Bash", { command: `step ${i}` })), result(`t${i}`, "ok"), assistant(text(`answer ${i}`)));
    const f = file(lines);
    const pages = [];
    let page = readChat(f, "claude", { limit: 30 });
    pages.unshift(page.messages);
    assert.deepEqual(page.messages.slice(-1).map((m) => m.text), ["answer 99"]);
    while (page.before !== undefined) {
      page = readChat(f, "claude", { limit: 30, before: page.before });
      pages.unshift(page.messages);
    }
    const all = pages.flat();
    const said = all.filter((m) => m.role !== "tool").map((m) => m.text);
    assert.deepEqual(said, Array.from({ length: 100 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat());
    assert.equal(all.filter((m) => m.role === "tool").length, 100);
    assert.equal(new Set(all.map((m) => m.id)).size, all.length);
    assert.ok(pages.length >= 7, `read in pages (${pages.length})`);
  });

  it("follows what is written next, leaving a half-written line for later", () => {
    const f = file([user("one"), assistant(text("two"))], JSON.stringify(assistant(text("three"))).slice(0, 20));
    const first = readChat(f, "claude");
    assert.deepEqual(first.messages.map((m) => m.text), ["one", "two"], "the half-written line is not read");
    const rest = JSON.stringify(assistant(text("three"))).slice(20);
    appendFileSync(f, rest + "\n" + JSON.stringify(user("four")) + "\n");
    const next = readChat(f, "claude", { after: first.end });
    assert.deepEqual(next.messages.map((m) => m.text), ["three", "four"]);
    assert.deepEqual(readChat(f, "claude", { after: next.end }).messages, [], "nothing new");
    assert.equal(readChat(f, "claude", { after: next.end + 10_000 }).reset, true, "a cursor past the end means the file changed");
  });
});

describe("Codex rollouts", () => {
  const ev = (type: string, payload: object, min = 0) => ({ timestamp: T(min), type, payload });
  it("reads the newer item records, without the duplicate tool calls", () => {
    const f = file([
      ev("session_meta", { cwd: "/w" }),
      ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] }),
      ev("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Where is validation?" }] } }),
      ev("response_item", { type: "custom_tool_call", name: "exec", call_id: "c1", input: 'tools.exec_command({cmd:"rg zod"})' }),
      ev("event_msg", { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", "rg zod"], exit_code: 1 } }),
      ev("event_msg", { type: "item_completed", item: { type: "FileChange", changes: { "/w/src/a.ts": {} } } }),
      ev("event_msg", { type: "item_completed", item: { type: "Reasoning" } }),
      ev("event_msg", { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "In src/schema.ts." }] } }),
      ev("event_msg", { type: "turn_aborted" }),
    ]);
    assert.deepEqual(readChat(f, "codex", { cwd: "/w" }).messages.map(brief), [
      "user | Where is validation?",
      "tool | Shell | rg zod | failed",
      "tool | Edit | src/a.ts",
      "assistant | In src/schema.ts.",
      "event | interrupted | Interrupted",
    ]);
  });

  it("points at the images you attached, one it viewed, and a tool's", () => {
    const url = (b: string) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;
    const f = file([
      ev("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "local_image", path: "/home/me/Pictures/shot.png" }, { type: "text", text: "This looks off [Image #1]" }] } }),
      ev("event_msg", { type: "item_completed", item: { type: "ImageView", path: "file:///w/out.png" } }),
      ev("response_item", { type: "function_call", name: "shell", call_id: "c9", arguments: "{}" }),
      ev("response_item", { type: "function_call_output", call_id: "c9", output: [{ type: "input_text", text: "done" }, { type: "input_image", image_url: url("tool") }] }),
    ]);
    const m = readChat(f, "codex", { cwd: "/w" }).messages;
    assert.deepEqual(m.map((x) => [brief(x), x.images?.length ?? 0]), [
      ["user | This looks off [Image #1]", 1],
      ["tool | View image | out.png", 1],
    ]);
    const get = (ref: string) => {
      const [at, n] = ref.split(":").map(Number);
      return chatImage(f, "codex", at!, n!);
    };
    assert.deepEqual(get(m[0]!.images![0]!), { path: "/home/me/Pictures/shot.png" });
    assert.deepEqual(get(m[1]!.images![0]!), { path: "/w/out.png" });
    const old = file([ev("response_item", { type: "function_call", name: "shell", call_id: "c9", arguments: "{}" }), ev("response_item", { type: "function_call_output", call_id: "c9", output: [{ type: "input_image", image_url: url("tool") }] })]);
    const [step] = readChat(old, "codex").messages;
    const img = chatImage(old, "codex", Number(step!.images![0]!.split(":")[0]), 0);
    assert.deepEqual(img, { type: "image/png", data: Buffer.from("tool").toString("base64") }, "an older rollout's tool output");
  });

  it("reads older rollouts: messages as events, tools as response items", () => {
    const f = file([
      ev("event_msg", { type: "user_message", message: "Run the tests" }),
      ev("response_item", { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"] }) }),
      ev("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n*** End Patch" }),
      ev("event_msg", { type: "agent_message", message: "All green." }),
    ]);
    assert.deepEqual(readChat(f, "codex").messages.map(brief), ["user | Run the tests", "tool | Shell | bash -lc npm test", "tool | apply_patch | src/x.ts", "assistant | All green."]);
  });
});

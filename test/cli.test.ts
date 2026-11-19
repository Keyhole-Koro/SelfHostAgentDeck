import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Run inside herdr or not, the processes these tests start must not inherit a real herdr pane.
delete process.env["HERDR_PANE_ID"];
delete process.env["HERDR_SOCKET_PATH"];

/** The CLI run as a user would, against a made-up home: sessions, holds and settings all live there. */

const SRC = join(import.meta.dirname, "..", "src");
const CLI = join(SRC, "cli.ts");
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "adv-cli-"));
  env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DECK_STATE_DIR: "", NO_COLOR: "1" };
});

function run(args: string[], input?: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf8", input });
}

function running(id: string, record: object, pid = process.pid): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: home, name: `name-${id}`, statusUpdatedAt: Date.now(), ...record }));
}

describe("later, done, unhold", () => {
  it("takes a session off the list and puts it back", () => {
    running("abc123", { status: "idle" });
    assert.match(run(["inbox"]), /Your turn \(1\)/);
    assert.match(run(["done", "abc"]), /name-abc123: done, until it does something new/);
    const out = run(["inbox"]);
    assert.match(out, /Nothing waits on you/);
    assert.match(out, /On hold \(1\): name-abc123 \(done\)/);
    assert.match(run(["unhold", "claude:abc"]), /waits again/);
    assert.match(run(["inbox"]), /Your turn \(1\)/);
  });

  it("puts one off until a given time", () => {
    running("abc123", { status: "waiting", waitingFor: "input needed" });
    assert.match(run(["later", "abc", "--until", "2h"]), /later, until/);
    assert.equal(JSON.parse(run(["inbox", "--json"])).items[0].hold.kind, "later");
  });

  it("says which session is meant when a prefix is ambiguous", () => {
    running("abc1", { status: "idle" }, process.pid);
    running("abc2", { status: "idle" }, process.ppid);
    assert.throws(() => run(["done", "abc"]), /matches 2 sessions/);
  });
});

describe("statusline", () => {
  it("prints the other sessions waiting, from Claude Code's status-line JSON", () => {
    running("me", { status: "waiting", waitingFor: "input needed" }, process.pid);
    running("other", { status: "waiting", waitingFor: "approve Bash: ls" }, process.ppid);
    const input = JSON.stringify({ session_id: "me", cwd: home });
    const expected = "⏳ 1 needs an answer (name-other: approve Bash: ls)\n";
    assert.equal(run(["statusline"], input), expected);
    const entry = execFileSync(process.execPath, [join(SRC, "statusline-entry.ts")], { cwd: home, env, encoding: "utf8", input });
    assert.equal(entry, expected);
  });

  it("prints nothing when nothing waits, and never fails", () => {
    assert.equal(run(["statusline"], "not json"), "");
  });

  it("is set up by install --statusline, without replacing someone else's", () => {
    const settings = join(home, ".claude", "settings.json");
    run(["install", "--agent", "claude", "--statusline"]);
    assert.match(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, /agent-deck-statusline/);
    run(["uninstall", "--agent", "claude"]);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine, undefined);

    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "my-line" } }));
    assert.match(run(["install", "--agent", "claude", "--statusline"]), /already runs my-line; left as it is/);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, "my-line");
  });
});

describe("inbox --watch --notify", () => {
  it("notifies when a session starts waiting", async () => {
    running("w1", { status: "busy", name: "builder" });
    const log = join(home, "notified.txt");
    const notifier = join(home, "notify.sh");
    writeFileSync(notifier, `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "${log}"\n`);
    chmodSync(notifier, 0o755);
    const child = spawn(process.execPath, [CLI, "inbox", "--watch", "--notify", "--interval", "0.1"], { cwd: home, env: { ...env, AGENT_DECK_NOTIFY: notifier } });
    try {
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += String(d)));
      await until(() => out.includes("watching 1 sessions"));
      running("w1", { status: "waiting", waitingFor: "approve Bash: npm publish", name: "builder" });
      await until(() => existsSync(log) && readFileSync(log, "utf8").includes("\n"));
      assert.equal(readFileSync(log, "utf8"), "builder needs an answer|approve Bash: npm publish\n");
      assert.match(out, /builder needs an answer/);
    } finally {
      child.kill();
    }
  });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("inbox --publish", () => {
  it("publishes a private snapshot with the artifact CLI and prints its URL", () => {
    running("p1", { status: "waiting", waitingFor: "approve Bash: npm publish", name: "releaser" });
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "p1.jsonl"), JSON.stringify({ type: "assistant", sessionId: "p1", message: { content: [{ type: "text", text: "Ready to publish. <script>alert(1)</script>" }] } }) + "\n");
    const copy = join(home, "published.html");
    const args = join(home, "args.txt");
    const fake = join(home, "artifact");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" > "${args}"\ncp "$2" "${copy}"\nprintf '%s\\n' '{"url":"https://artifacts.example/a/abc","version":1,"created":true}'\n`);
    chmodSync(fake, 0o755);
    const out = execFileSync(process.execPath, [CLI, "inbox", "--publish"], { cwd: home, env: { ...env, AGENT_DECK_ARTIFACT: fake, AGENT_DECK_GH: "/nonexistent/gh" }, encoding: "utf8" });
    assert.equal(out, "Published: https://artifacts.example/a/abc\n");
    assert.match(readFileSync(args, "utf8"), /^publish \S+agent-inbox\.html --title Agent inbox .*--json$/m);
    const html = readFileSync(copy, "utf8");
    assert.match(html, /<h3>releaser<\/h3>/);
    assert.match(html, /approve Bash: npm publish/);
    assert.match(html, /http-equiv="refresh"/);
    assert.ok(!html.includes("<script>"), "content is escaped");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("says why when publishing fails", () => {
    running("p1", { status: "idle" });
    assert.throws(() => execFileSync(process.execPath, [CLI, "inbox", "--publish"], { cwd: home, env: { ...env, AGENT_DECK_ARTIFACT: "/nonexistent/artifact" }, encoding: "utf8", stdio: "pipe" }), /ENOENT|not found|nonexistent/);
  });
});

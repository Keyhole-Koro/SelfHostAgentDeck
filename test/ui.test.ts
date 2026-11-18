import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The page in a real browser (Playwright's Chromium), against a made-up home: sessions waiting in
 * herdr panes, one sharing a file with another, a pull request, a session idle for days. herdr and
 * gh are fakes that log what they were asked. Skipped when Chromium cannot start (no browsers).
 */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const PAST = "2026-01-01T00:00:00Z";

let chromium: typeof import("playwright").chromium | undefined;
try {
  ({ chromium } = await import("playwright"));
  const b = await chromium.launch();
  await b.close();
} catch {
  chromium = undefined;
}

describe("page", { skip: (!chromium && "no browser") || (process.platform !== "linux" && "reads /proc") }, () => {
  const home = mkdtempSync(join(tmpdir(), "adv-ui-home-"));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "adv-ui-repo-")));
  const herdrLog = join(home, "herdr.log");
  const socket = join(home, "herdr.sock");
  const kids: ChildProcess[] = [];
  let url = "";
  let browser: import("playwright").Browser;
  let page: import("playwright").Page;
  const errors: string[] = [];

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  /** A process standing in for a session's own, in a herdr pane when `pane` is given. */
  const proc = (pane?: string) => {
    const p = spawn("sleep", ["120"], { env: { ...process.env, ...(pane && { HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: socket }) } });
    kids.push(p);
    return p.pid!;
  };
  const running = (id: string, pid: number, record: object) => {
    const dir = join(home, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: repo, name: id, statusUpdatedAt: Date.now(), ...record }));
  };
  const transcript = (id: string, rows: object[]) => {
    const dir = join(home, ".claude", "projects", "-repo");
    mkdirSync(dir, { recursive: true });
    const base = { sessionId: id, cwd: repo, timestamp: new Date().toISOString() };
    writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify({ ...base, ...r })).join("\n") + "\n");
  };
  const tool = (id: string, name: string, input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, toolUseResult: object = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult });
  /** With AGENT_DIFF_UI_SHOTS=<dir>, screenshots of each step for a look by eye. */
  const shot = async (name: string) => {
    const dir = process.env["AGENT_DIFF_UI_SHOTS"];
    if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const herdrCalls = () => (existsSync(herdrLog) ? readFileSync(herdrLog, "utf8").split("\n").filter((l) => l && !l.includes("agent list")) : []);
  async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  before(async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "", "", "", "", "", "", "", "", "const z = 26;", ""].join("\n"));
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "const due = true;", "", "", "", "", "", "", "", "", "const z = 26;", "const fixed = true;", ""].join("\n"));

    transcript("asker", [
      { type: "ai-title", aiTitle: "Pick a sort order" },
      tool("q1", "AskUserQuestion", { questions: [{ question: "Which default sort?", options: [{ label: "Relevance" }, { label: "Newest" }] }] }),
    ]);
    running("asker", proc("w1:p1"), { status: "waiting", waitingFor: "input needed" });

    transcript("builder", [
      { type: "user", message: { content: "Add due dates" } },
      { type: "last-prompt", lastPrompt: "Add due dates" },
      { type: "ai-title", aiTitle: "Add due dates" },
      tool("c1", "TaskCreate", { subject: "Schema" }),
      result("c1", { task: { id: "1" } }),
      tool("c2", "TaskCreate", { subject: "Helper" }),
      result("c2", { task: { id: "2" } }),
      tool("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      tool("e1", "Edit", { file_path: join(repo, "shared.ts"), old_string: "const a = 1;", new_string: "const a = 1;\nconst due = true;" }),
      { type: "pr-link", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prRepository: "o/r" },
      { type: "assistant", message: { content: [{ type: "text", text: "Added `due`.\n\nShall I open the PR?" }] } },
      { type: "system", subtype: "away_summary", content: "You asked for due dates; I added them." },
    ]);
    running("builder", proc("w1:p2"), { status: "idle" });

    transcript("fixer", [{ type: "ai-title", aiTitle: "Fix z" }, tool("e2", "Edit", { file_path: join(repo, "shared.ts"), old_string: "const z = 26;", new_string: "const z = 26;\nconst fixed = true;" })]);
    running("fixer", proc(), { status: "busy" });

    transcript("old", [{ type: "ai-title", aiTitle: "Old idea" }]);
    running("old", proc(), { status: "idle", statusUpdatedAt: Date.now() - 5 * 864e5 });

    const herdr = join(home, "herdr");
    const agents = [
      { pane_id: "w1:p1", agent_status: "blocked", agent: "claude", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p2", agent_status: "idle", agent: "claude", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
    ];
    writeFileSync(
      herdr,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${herdrLog}"
case "$1 $2" in
  "agent list") printf '%s\\n' '${JSON.stringify({ id: "l", result: { type: "agent_list", agents } })}' ;;
  "agent read") printf '%s\\n' '${JSON.stringify({ id: "r", result: { type: "pane_read", read: { text: "Which default sort?\n> 1. Relevance\n  2. Newest" } } })}' ;;
  *) printf '%s\\n' '{"id":"x","result":{"type":"agent_info"}}' ;;
esac
`,
    );
    const gh = join(home, "gh");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ number: 7, title: "Due dates", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/7", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] })}'\n`);
    chmodSync(herdr, 0o755);
    chmodSync(gh, 0o755);

    const server = spawn(process.execPath, [CLI, "view", "--port", "0"], {
      cwd: repo,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DIFF_STATE_DIR: "", AGENT_DIFF_HERDR: herdr, AGENT_DIFF_GH: gh },
    });
    kids.push(server);
    url = await new Promise<string>((resolve) => server.stdout!.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0])));
    browser = await chromium!.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url);
  });

  after(async () => {
    await browser?.close();
    for (const k of kids) k.kill();
  });

  it("groups the sessions under their project and opens on the one that needs an answer", async () => {
    await page.waitForSelector('.session[data-key="claude:asker"][aria-current="true"]');
    assert.match(await page.locator(".project").first().innerText(), new RegExp(repo.split("/").pop()!));
    assert.match(await page.locator("#detail").innerText(), /Which default sort\?[\s\S]*1\. Relevance/);
    assert.match(await page.locator("#summary").innerText(), /1 needs an answer/);
  });

  it("answers through herdr: shows the screen and sends a key", async () => {
    await page.click('[data-act="screen"]');
    await page.waitForSelector("#screen:not([hidden])");
    assert.match(await page.locator("#screen").innerText(), /1\. Relevance/);
    await shot("1-needs-answer");
    await page.click('[data-key-press="1"]');
    await until(() => herdrCalls().includes("agent send-keys w1:p1 1"));
  });

  it("shows what a finished session did: recap, prompt, tasks, PR, shared file", async () => {
    await page.click('.session[data-key="claude:builder"]');
    await page.waitForSelector("text=While you were away");
    const detail = await page.locator("main").innerText();
    assert.match(detail, /You asked for due dates; I added them\./);
    // Labels are uppercased by CSS, and innerText returns what is shown.
    assert.match(detail, /You asked\s+Add due dates/i);
    assert.match(detail, /Tasks 1\/2/i);
    assert.match(detail, /Shared files[\s\S]*shared\.ts with Fix z/);
    await until(async () => /CI: 1 failed/.test(await page.locator("#info").innerText()));
    await shot("2-your-turn");
    assert.ok(await page.locator('.session[data-key="claude:builder"] .chip.conflict').count());
  });

  it("sends a prompt, and a review of its hunks", async () => {
    await page.fill("#prompt", "Open the PR");
    await page.click('[data-act="prompt"]');
    await until(() => herdrCalls().includes("agent prompt w1:p2 Open the PR"));
    await page.waitForSelector(".comment-btn");
    await page.locator(".comment-btn").first().click();
    await page.locator("[data-editor]:not([hidden]) textarea").fill("Name it dueAt");
    await page.locator("[data-editor]:not([hidden]) [data-save-comment]").click();
    await page.waitForSelector(".review");
    await page.locator(".review").scrollIntoViewIfNeeded();
    await shot("3-review");
    assert.match(await page.locator(".review").innerText(), /1 comment/);
    await page.click('[data-act="send-review"]');
    await until(() => herdrCalls().some((l) => l.startsWith("agent prompt w1:p2 Review comments on your uncommitted changes:") || l.includes("Name it dueAt")));
  });

  it("puts a session off with Later", async () => {
    await page.click('[data-act="later"][data-until="1h"]');
    await page.waitForSelector('.fold[data-fold="held"]');
    assert.match(await page.locator('.fold[data-fold="held"]').innerText(), /1 on hold/);
  });

  it("lists what can be cleaned up", async () => {
    await page.click("#cleanup");
    await page.waitForSelector('[data-goto="claude:old"]');
    assert.match(await page.locator("#detail").innerText(), /Idle sessions · 1[\s\S]*Old idea/i);
    await shot("4-cleanup");
    await page.click("#cleanup");
    await page.waitForSelector(".session[aria-current=\"true\"]");
  });

  it("logged no errors", () => {
    assert.deepEqual(errors, []);
  });
});

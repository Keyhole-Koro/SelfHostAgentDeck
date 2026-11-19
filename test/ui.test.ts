import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inTerminal } from "./terminal.ts";
import { after, before, describe, it } from "node:test";

// Run inside herdr or not, the processes these tests start must not inherit a real herdr pane.
delete process.env["HERDR_PANE_ID"];
delete process.env["HERDR_SOCKET_PATH"];

/**
 * The page in a real browser (Playwright's Chromium), against a made-up home: sessions waiting in
 * herdr panes, one sharing a file with another, a pull request, a session idle for days, a long
 * conversation. herdr and gh are fakes that log what they were asked. Then the same page at a
 * phone's and a tablet's size, and in the dark. Skipped when Chromium cannot start (no browsers).
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
  let fixer = 0;
  let browser: import("playwright").Browser;
  let page: import("playwright").Page;
  const errors: string[] = [];
  /** Another page on the same server: a phone, a tablet, the dark. */
  const another = async (opts: import("playwright").BrowserContextOptions, hash = "") => {
    const p = await browser.newPage(opts);
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && !/status of 409/.test(m.text()) && errors.push(m.text()));
    await p.goto(url + hash);
    await p.waitForSelector(".session");
    return p;
  };

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
  /** With AGENT_DECK_UI_SHOTS=<dir>, screenshots of each step for a look by eye. */
  const shot = async (name: string) => {
    const dir = process.env["AGENT_DECK_UI_SHOTS"];
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
    fixer = proc("w1:p5");
    running("fixer", fixer, { status: "busy" });

    transcript("planner", [{ type: "ai-title", aiTitle: "Plan the export" }, tool("x1", "ExitPlanMode", { plan: "## Export plan\n\n1. Add a CSV writer\n2. Wire the button" })]);
    running("planner", proc("w1:p4"), { status: "waiting", waitingFor: "approve ExitPlanMode", statusUpdatedAt: Date.now() - 120_000 });

    writeFileSync(join(repo, "notes.md"), "# Release notes\n\n- due dates\n");
    writeFileSync(join(repo, ".env"), "TOKEN=secret");
    const chatty: object[] = [{ type: "ai-title", aiTitle: "Long talk" }];
    for (let n = 0; n < 45; n++) chatty.push({ type: "user", message: { content: `question ${n}` } }, { type: "assistant", message: { content: [{ type: "text", text: `answer ${n}` }] } });
    const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1×1 PNG
    chatty.push({ type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: dot } }, { type: "text", text: "[Image #1] look at this" }] } });
    chatty.push(tool("t1", "Bash", { command: "npm test" }), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failing", is_error: true }] } });
    chatty.push({ type: "assistant", message: { content: [{ type: "text", text: 'See `notes.md` for **details**.\n\n<img src=x onerror="window.__xss=1">' }] } });
    transcript("chatty", chatty);
    running("chatty", proc("w1:p3"), { status: "idle", statusUpdatedAt: Date.now() - 60_000 });

    transcript("old", [{ type: "ai-title", aiTitle: "Old idea" }]);
    running("old", proc(), { status: "idle", statusUpdatedAt: Date.now() - 5 * 864e5 });

    const layouts = join(home, "layouts");
    mkdirSync(layouts, { recursive: true });
    writeFileSync(
      join(layouts, "asks.js"),
      `const closing = "</script>"; // must not end the page's script
AgentDeck.registerLayout({
  id: "asks",
  label: "Asks",
  paint(root, deck) {
    if (!root.firstChild) root.innerHTML = '<div class="grid-tiles"></div>';
    deck.cards(root.firstChild, deck.sessions().filter((s) => s.state === "needs-answer"), "tile");
  },
});`,
    );
    const herdr = join(home, "herdr");
    const agents = [
      { pane_id: "w1:p1", agent_status: "blocked", agent: "claude", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p2", agent_status: "idle", agent: "claude", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p3", agent_status: "idle", agent: "claude", terminal_id: "t3", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p4", agent_status: "blocked", agent: "claude", terminal_id: "t4", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p5", agent_status: "working", agent: "claude", terminal_id: "t5", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
    ];
    writeFileSync(
      herdr,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${herdrLog}"
case "$1 $2" in
  "agent list") printf '%s\\n' '${JSON.stringify({ id: "l", result: { type: "agent_list", agents } })}' ;;
  "agent read") printf '%s\\n' '${JSON.stringify({ id: "r", result: { type: "pane_read", read: { text: "Which default sort?\n> 1. Relevance\n  2. Newest" } } })}' ;;
  "agent prompt") [ "$4" = "Slow one" ] && sleep 1; printf '%s\\n' '{"id":"x","result":{"type":"agent_info"}}' ;;
  "workspace list") printf '%s\\n' '{"result":{"type":"workspace_list","workspaces":[]}}' ;;
  "workspace create") printf '%s\\n' '{"result":{"type":"workspace_created","root_pane":{"pane_id":"w9:p1"},"tab":{},"workspace":{}}}' ;;
  *) printf '%s\\n' '{"id":"x","result":{"type":"agent_info"}}' ;;
esac
`,
    );
    const gh = join(home, "gh");
    const checks = [{ name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/42/job/1" }];
    writeFileSync(
      gh,
      `#!/bin/sh
case "$1 $2" in
  "pr checks") printf '%s\\n' '${JSON.stringify(checks)}'; exit 1 ;;
  "run view") printf 'test\\tRun tests\\t2026-11-19T00:00:00.0Z Expected 1, got 2\\n' ;;
  *) printf '%s\\n' '${JSON.stringify({ number: 7, title: "Due dates", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/7", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] })}' ;;
esac
`,
    );
    chmodSync(herdr, 0o755);
    chmodSync(gh, 0o755);

    const server = spawn(process.execPath, [CLI, "view", "--port", "0"], {
      cwd: repo,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DECK_STATE_DIR: "", AGENT_DECK_HERDR: herdr, AGENT_DECK_GH: gh, AGENT_DECK_WATCH_MS: "300", AGENT_DECK_LAYOUTS_DIR: join(home, "layouts") },
    });
    kids.push(server);
    url = await new Promise<string>((resolve) => server.stdout!.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0])));
    browser = await chromium!.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/status of 409/.test(m.text()) && errors.push(m.text()));
    await page.goto(url);
  });

  after(async () => {
    await browser?.close();
    for (const k of kids) k.kill();
  });

  it("groups the sessions under their project and opens on the one that needs an answer", async () => {
    await page.waitForSelector('.session[data-key="claude:asker"][aria-current="true"]');
    assert.match(await page.locator(".project").first().innerText(), new RegExp(repo.split("/").pop()!));
    assert.match(await page.locator("#dock").innerText(), /Which default sort\?[\s\S]*Relevance[\s\S]*Newest/);
    assert.match(await page.locator("#summary").innerText(), /2 need an answer/);
  });

  it("answers through herdr with one tap on a choice its screen shows", async () => {
    await page.waitForSelector("#dock .choice");
    assert.deepEqual(await page.locator("#dock .choice span:last-child").allInnerTexts(), ["Relevance", "Newest"]);
    assert.equal(await page.locator("#screen").isVisible(), false, "the raw screen is folded away");
    await shot("1-needs-answer");
    await page.click('#dock .choice[data-choose="0"]');
    await until(() => herdrCalls().includes("agent send-keys w1:p1 enter"));
    assert.equal(herdrCalls().filter((l) => l.startsWith("agent send-keys")).length, 1, "already on it: Enter alone");
    await page.click("#dock .more-keys > summary");
    assert.match(await page.locator("#screen").innerText(), /1\. Relevance/);
  });

  it("shows the plan a session wants approved", async () => {
    await page.click('.session[data-key="claude:planner"]');
    await page.waitForSelector("#dock .plan-doc .md h2");
    assert.equal(await page.locator("#dock .plan-doc .md h2").innerText(), "Export plan");
    assert.equal(await page.locator("#dock .plan-doc .md ol li").count(), 2);
    await page.waitForSelector("#dock .choice");
  });

  it("stops a working session with one tap", async () => {
    await page.click('.session[data-key="claude:fixer"]');
    await page.click('#dock [data-key-press="esc"]');
    await until(() => herdrCalls().includes("agent send-keys w1:p5 esc"));
  });

  it("keeps a timeline of what happened, also while no one looks", async () => {
    running("fixer", fixer, { status: "idle" });
    await page.click("#activity");
    await until(async () => /Fix z finished its turn/.test(await page.locator("#special").innerText()));
    await page.locator('#special .feed [data-goto="claude:fixer"]').first().click();
    await page.waitForSelector('.session[data-key="claude:fixer"][aria-current="true"]');
  });

  it("shows what a finished session did: recap, prompt, tasks, PR, shared file", async () => {
    await page.click('.session[data-key="claude:builder"]');
    await page.waitForSelector("#chat .recap");
    const said = await page.locator("#chat").innerText();
    assert.match(said, /Add due dates[\s\S]*Shall I open the PR\?[\s\S]*You asked for due dates; I added them\./);
    assert.equal(await page.locator("#chat .msg.me .bubble").first().innerText(), "Add due dates");
    // Labels are uppercased by CSS, and innerText returns what is shown.
    const info = await page.locator("#info").innerText();
    assert.match(info, /Tasks\s+1\/2/i);
    assert.match(info, /Shared files[\s\S]*shared\.ts with Fix z/i);
    assert.ok(await page.locator("aside#side #info").isVisible(), "beside the conversation on a wide screen");
    await until(async () => /CI: 1 failed/.test(await page.locator("#info").innerText()));
    await page.click('#info [data-ci="https://github.com/o/r/pull/7"]');
    await page.waitForSelector("#info .ci-log pre");
    assert.match(await page.locator("#info .ci-log pre").innerText(), /test › Run tests\nExpected 1, got 2/);
    await page.click('#info [data-ci-send="https://github.com/o/r/pull/7"]');
    await until(() => herdrCalls().some((l) => l.includes("agent prompt w1:p2 CI failed on https://github.com/o/r/pull/7 (test)")));
    await shot("2-your-turn");
    assert.ok(await page.locator('.session[data-key="claude:builder"] .chip.conflict').count());
  });

  it("sends a prompt, and a review of its hunks", async () => {
    await page.fill("#prompt", "Open the PR");
    await page.press("#prompt", "Enter");
    assert.ok(!herdrCalls().some((l) => l.includes("Open the PR")), "Enter alone does not send");
    await page.press("#prompt", "Control+Enter");
    await until(() => herdrCalls().includes("agent prompt w1:p2 Open the PR"));
    await page.fill("#prompt", "Twice");
    await page.dblclick('#dock [data-act="prompt"]');
    await until(async () => (await page.inputValue("#prompt")) === "");
    assert.equal(herdrCalls().filter((l) => l === "agent prompt w1:p2 Twice").length, 1, "a double click sends once");
    // Typing on while it sends: what was typed after stays in the box, and the box keeps the focus
    // when the session's part of the page is drawn again.
    await page.fill("#prompt", "Slow one");
    await page.press("#prompt", "Control+Enter");
    await page.keyboard.type("next");
    await until(() => herdrCalls().includes("agent prompt w1:p2 Slow one"));
    await until(async () => (await page.inputValue("#prompt")) === "next");
    await page.evaluate('shown.dock = ""; paintDock(entry(selected))'); // the page's own globals
    await page.keyboard.type(" step");
    assert.equal(await page.inputValue("#prompt"), "next step");
    await page.fill("#prompt", "");
    assert.equal(await page.locator("#dock [data-quick]").count(), 0, "no one-tap replies until you add some");
    await page.click('#dock [data-act="tune"]');
    page.once("dialog", (d) => void d.accept("続けて | Continue"));
    await page.click('#dock [data-act="edit-quick"]');
    await page.click('#dock [data-quick="Continue"]');
    await until(() => herdrCalls().includes("agent prompt w1:p2 Continue"));
    await page.click('#dock [data-slash="/model opus"]');
    await until(() => herdrCalls().includes("agent prompt w1:p2 /model opus"));
    await page.setInputFiles("#attach", { name: "shot.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await page.waitForSelector("#dock .att");
    // A screenshot pasted into the box goes with it too, named by when it was pasted.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" }));
      document.getElementById("prompt")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await until(async () => (await page.locator("#dock .att").count()) === 2);
    assert.match(await page.locator("#dock .att .nm").last().innerText(), /^pasted-\d{6}\.png$/);
    assert.equal(await page.locator("#dock .att img").count(), 2, "a preview of each image");
    await page.fill("#prompt", "Look at this");
    await page.click('[data-act="prompt"]');
    await until(() => herdrCalls().some((l) => l.includes("Look at this")) && herdrCalls().some((l) => /\.agent-deck\/uploads\/\d{8}-\d{6}-shot\.png/.test(l)) && herdrCalls().some((l) => /\.agent-deck\/uploads\/\d{8}-\d{6}-pasted-\d{6}\.png/.test(l)));
    assert.equal(await page.locator("#dock .att").count(), 0, "sent with the prompt");
    await page.click('[data-tab="changes"]');
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
    await page.click('[data-tab="chat"]');
  });

  it("puts a session off with Later", async () => {
    await page.click("#head details.menu > summary"); // Later is a menu: for an hour, until tomorrow
    await page.click('[data-act="later"][data-until="1h"]');
    await page.waitForSelector('.fold[data-fold="held"]');
    assert.match(await page.locator('.fold[data-fold="held"]').innerText(), /1 on hold/);
  });

  it("starts a new session in herdr, with the model and effort picked", async () => {
    await page.click("#new");
    await page.waitForSelector("#ns-dir option", { state: "attached" });
    assert.equal(await page.locator("#ns-dir").inputValue(), repo, "the folder of the session picked before");
    await page.fill("#ns-model", "opus");
    await page.selectOption("#ns-effort", "high");
    await page.fill("#ns-prompt", "Add CSV export");
    await page.click('[data-act="ns-start"]');
    await until(() => herdrCalls().some((l) => /^agent start \S+ --kind claude --pane w9:p1 --timeout 60000 -- --session-id [0-9a-f-]{36} --model opus --effort high$/.test(l)));
    await until(() => herdrCalls().includes("agent prompt w9:p1 Add CSV export"));
    assert.match(await page.locator("#ns-note").innerText(), /Started/);
    await page.click("#new");
  });

  it("lists what can be cleaned up", async () => {
    await page.click("#more > summary");
    await page.click("#cleanup");
    await page.waitForSelector('[data-goto="claude:old"]');
    assert.match(await page.locator("#special").innerText(), /Idle sessions · 1[\s\S]*Old idea/i);
    await shot("4-cleanup");
    await page.click("#more > summary");
    await page.click("#cleanup");
    await page.waitForSelector(".session[aria-current=\"true\"]");
  });

  it("shows a long conversation a page at a time, its steps folded, its HTML as text", async () => {
    await page.click('.session[data-key="claude:chatty"]');
    await page.waitForSelector("#chat .steps");
    const text = () => page.locator("#chat").innerText();
    assert.match(await text(), /question 44[\s\S]*answer 44[\s\S]*1 step[\s\S]*Bash[\s\S]*1 failed[\s\S]*See notes\.md for details\./);
    assert.doesNotMatch(await text(), /question 0\b/, "only the latest page at first");
    assert.match(await page.locator("#chat .msg.ai").last().innerHTML(), /<strong>details<\/strong>[\s\S]*&lt;img src=x/);
    assert.equal(await page.locator("#chat .msg.ai img").count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
    // The image you sent, in your message; a tap shows it large, a tap closes it.
    const pic = page.locator("#chat .msg.me .pic img");
    await until(async () => (await pic.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)) === 1);
    await page.locator("#chat .msg.me .pic").click();
    assert.equal(await page.locator("#lightbox").isVisible(), true);
    await page.locator("#lightbox").click();
    assert.equal(await page.locator("#lightbox").isVisible(), false);
    for (let n = 0; n < 6 && !(await page.locator("#chat .start").count()); n++) {
      await page.locator('[data-act="earlier"]').click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.waitForSelector("#chat .start");
    assert.match(await text(), /question 0\b[\s\S]*question 44/);
    assert.equal((await text()).match(/question 7\b/g)?.length, 1, "no page twice");
  });

  it("opens a file the conversation names, and keeps secrets out of the listing", async () => {
    await page.locator('#chat a.file[data-file="notes.md"]').last().click();
    await page.waitForSelector("#files .doc h1");
    assert.equal(await page.locator("#files .doc h1").innerText(), "Release notes");
    assert.ok(await page.locator('[data-tab="files"][aria-selected="true"]').count());
    await page.locator("#files .crumbs button").first().click();
    await page.waitForSelector("#files .dir");
    const names = await page.locator("#files .entry .nm").allInnerTexts();
    assert.ok(names.includes("notes.md") && names.includes("shared.ts"), names.join(" "));
    assert.ok(!names.includes(".env") && !names.includes(".git/"), names.join(" "));
    await page.click('[data-tab="chat"]');
  });

  it("fits a phone: the list, then one session with its reply box, and Back", async () => {
    // Picked already (from the URL), so its reply box is first drawn while the list hides it.
    const phone = await another({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "&s=claude:chatty");
    assert.equal(await phone.evaluate(() => document.body.dataset.view), "list");
    assert.equal(await phone.locator("main").isVisible(), false);
    await phone.click('.session[data-key="claude:chatty"]');
    await phone.waitForSelector("#prompt");
    assert.equal(await phone.locator("#nav").isVisible(), false);
    const box = (await phone.locator("#prompt").boundingBox())!;
    assert.ok(box.y > 600 && box.y + box.height <= 844, `the reply box sits at the bottom (${box.y}+${box.height})`);
    assert.ok(box.height >= 20, `and is a line tall, though the page was drawn while it was hidden (${box.height})`);
    assert.equal(await phone.locator("#prompt").evaluate((t) => getComputedStyle(t).fontSize), "16px", "under 16px, iOS zooms in on a tap");
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scrolling");
    await phone.click('[data-tab="details"]');
    assert.ok(await phone.locator("#pane-details #info").isVisible());
    await shot("5-phone");
    await phone.locator("#head .back").click();
    await phone.waitForSelector("#nav .session");
    assert.equal(await phone.evaluate(() => document.body.dataset.view), "list");
    await phone.close();
  });

  it("fits a tablet: two columns, the details in their own tab", async () => {
    const tablet = await another({ viewport: { width: 820, height: 1180 }, hasTouch: true });
    await tablet.click('.session[data-key="claude:chatty"]');
    assert.ok(await tablet.locator("#nav").isVisible());
    assert.equal(await tablet.locator("aside#side").isVisible(), false);
    await tablet.click('[data-tab="details"]');
    assert.match(await tablet.locator("#pane-details").innerText(), /claude --resume chatty/);
    assert.equal(await tablet.evaluate(() => document.documentElement.scrollWidth), 820);
    await tablet.close();
  });

  it("puts no text on white in the dark", async () => {
    const dark = await another({ viewport: { width: 1400, height: 1000 }, colorScheme: "dark" });
    await dark.click('.session[data-key="claude:chatty"]');
    await dark.waitForSelector("#chat .msg.me");
    const backgrounds = await dark.evaluate(() =>
      ["body", "#chat .bubble", "#chat .md", "#info .sec", ".composer", "#nav", "#head"].map((sel) => [sel, getComputedStyle(document.querySelector(sel)!).backgroundColor]),
    );
    for (const [sel, bg] of backgrounds) assert.ok(!/rgb\(25[0-5], 25[0-5], 25[0-5]\)/.test(bg!), `${sel} is ${bg}`);
    await dark.close();
  });

  it("shows many sessions at once: Deck, as columns you can answer from", async () => {
    await page.click('#layouts [data-layout="deck"]');
    await page.waitForSelector('#layout-root .deck-cols .card[data-card="claude:chatty"] .card-body .msg');
    const keys = await page.locator("#layout-root .card").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));
    assert.ok(keys.includes("claude:asker") && keys.includes("claude:chatty"), keys.join(" "));
    assert.ok(!keys.includes("claude:builder") && !keys.includes("claude:old"), "not those put off or idle");
    assert.equal(keys[0], "claude:asker", "the most urgent first");
    assert.match(await page.locator('.card[data-card="claude:chatty"] .card-body').innerText(), /answer 44/);
    assert.equal(await page.locator(".app").isVisible(), false);
    const card = page.locator('.card[data-card="claude:chatty"]');
    await card.locator(".card-input").fill("hello from the deck");
    await card.locator(".card-input").press("Enter");
    assert.equal(await card.locator(".card-input").inputValue(), "hello from the deck\n", "Enter alone is a new line");
    await card.locator(".card-input").press("Control+Enter");
    await until(() => herdrCalls().includes("agent prompt w1:p3 hello from the deck"));
    assert.equal(await card.locator(".card-input").inputValue(), "", "sent, and cleared");
    await shot("6-deck");
  });

  it("shows every session as a tile, with the choices of a question one tap away", async () => {
    await page.click('#layouts [data-layout="grid"]');
    const asker = page.locator('#layout-root .grid-tiles .card[data-card="claude:asker"]');
    await asker.locator('.card-ask [data-card-choose="1"]').waitFor();
    assert.match(await asker.locator(".card-ask").innerText(), /Which default sort\?[\s\S]*Newest/);
    const before = herdrCalls().length;
    await asker.locator('.card-ask [data-card-choose="1"]').click();
    await until(() => herdrCalls().slice(before).includes("agent send-keys w1:p1 down"));
    // This herdr's screen never shows the pointer move: the card says so, and nothing is picked.
    await asker.locator(".card-note.error").waitFor();
    assert.match(await asker.locator(".card-note").innerText(), /nothing was picked/);
    assert.ok(!herdrCalls().slice(before).includes("agent send-keys w1:p1 enter"));
    await asker.locator("[data-card-open]").click();
    await page.waitForSelector('.session[data-key="claude:asker"][aria-current="true"]');
    assert.equal(await page.locator('#layouts [data-layout="focus"]').getAttribute("aria-pressed"), "true", "a card's title opens it in Focus");
  });

  it("takes layouts of your own from ~/.config/agent-deck/layouts", async () => {
    await page.click('#layouts [data-layout="asks"]');
    await page.waitForSelector("#layout-root .grid-tiles .card");
    const keys = await page.locator("#layout-root .card").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card).sort());
    assert.deepEqual(keys, ["claude:asker", "claude:planner"]);
    const popout = await page.evaluate(() => "documentPictureInPicture" in window);
    assert.equal(await page.locator("#layouts [data-popout]").count(), popout ? 1 : 0, "Pop out where the browser can");
    await page.click('#layouts [data-layout="focus"]');
  });

  it("says why a session in another terminal has no reply box, and moves it into herdr", async () => {
    const id = "0a7e5c1d-0000-4000-8000-00000000000a";
    // Claude Code in a terminal tab outside herdr: a process named so, in no herdr pane.
    const elsewhere = inTerminal("exec -a claude-standin sleep 120");
    kids.push(elsewhere.process);
    transcript(id, [{ type: "ai-title", aiTitle: "Elsewhere" }]);
    await until(() => !!elsewhere.pid());
    running(id, elsewhere.pid()!, { status: "idle" });
    await page.click(`.session[data-key="claude:${id}"]`, { timeout: 10_000 });
    await page.waitForSelector("#dock .outside");
    assert.match(await page.locator("#dock .outside").innerText(), /No replies from here: the page types into sessions through herdr/);
    assert.equal(await page.locator("#dock #prompt").count(), 0, "no reply box that could not send");
    await shot("outside");
    page.once("dialog", (d) => void d.accept());
    await page.click('#dock [data-act="move"]');
    await until(() => herdrCalls().some((l) => l === `agent start ${l.split(" ")[2]} --kind claude --pane w9:p1 --timeout 60000 -- --resume ${id}`));
    await until(() => elsewhere.signal() === 15);
    assert.ok(herdrCalls().findIndex((l) => l.startsWith("workspace create")) < herdrCalls().findIndex((l) => l.includes(`--resume ${id}`)));
  });

  it("logged no errors", () => {
    assert.deepEqual(errors, []);
  });
});

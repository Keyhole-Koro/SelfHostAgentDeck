import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { basename, join } from "node:path";
import { inTerminal } from "./terminal.ts";
import { afterEach, beforeEach, describe, it } from "node:test";
import { summarize } from "../src/prs.ts";
import { browser, decrypt, pushService } from "./push-browser.ts";
import { tempDir } from "./tmp.ts";

// Run inside herdr or not, the processes these tests start must not inherit a real herdr pane.
delete process.env["HERDR_PANE_ID"];
delete process.env["HERDR_SOCKET_PATH"];

/** The page's API, served by `agent-deck view` over a made-up home and repository. */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const PAST = "2026-01-01T00:00:00Z";
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let child: ChildProcess | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

beforeEach(() => {
  home = tempDir("adv-srv-home-");
  repo = realpathSync(tempDir("adv-srv-repo-"));
  env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DECK_STATE_DIR: "" };
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "", "", "", "", "", "", "", "", "const z = 26;", ""].join("\n"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  child?.kill();
  child = undefined;
});

function running(id: string, pid: number, record: object = {}): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: repo, name: `name-${id}`, status: "idle", statusUpdatedAt: Date.now(), ...record }));
}

function transcript(id: string, rows: object[]): void {
  const dir = join(home, ".claude", "projects", "-repo");
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd: repo, timestamp: new Date().toISOString() };
  writeFileSync(join(dir, `${id}.jsonl`), [{ ...base, type: "user", message: { content: `prompt of ${id}` } }, ...rows.map((r) => ({ ...base, ...r }))].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const edit = (file: string, old_string: string, new_string: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `e-${Math.random()}`, name: "Edit", input: { file_path: join(repo, file), old_string, new_string } }] } });

async function serve(extraEnv: NodeJS.ProcessEnv = {}): Promise<{ origin?: string; token?: string; get: (path: string) => Promise<any>; post: (path: string, body: object) => Promise<any>; send?: (path: string, init: RequestInit) => Promise<Response> }> {
  child = spawn(process.execPath, [CLI, "view", "--port", "0"], { cwd: repo, env: { ...env, ...extraEnv } });
  const url = await new Promise<string>((resolve, reject) => {
    child!.stdout!.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0]));
    child!.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const { origin, hash } = new URL(url);
  const token = new URLSearchParams(hash.slice(1)).get("t")!;
  const headers = { "x-token": token, "content-type": "application/json" };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(origin + path, { ...init, headers });
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${(body as { error?: string }).error}`);
    return body;
  };
  return {
    origin,
    token,
    get: (path) => call(path),
    post: (path, body) => call(path, { method: "POST", body: JSON.stringify(body) }),
    send: (path, init) => fetch(origin + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } }),
  };
}

/** A GET with the headers given, Host included, which fetch cannot set. */
function raw(origin: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function eventually<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("api: sessions sharing a file", () => {
  it("marks both running sessions that changed the same file", async () => {
    writeFileSync(join(repo, "shared.ts"), ["const a = 1;", "const fromA = true;", "", "", "", "", "", "", "", "", "const z = 26;", "const fromB = true;", ""].join("\n"));
    transcript("sa", [edit("shared.ts", "const a = 1;", "const a = 1;\nconst fromA = true;")]);
    transcript("sb", [edit("shared.ts", "const z = 26;", "const z = 26;\nconst fromB = true;")]);
    running("sa", process.pid);
    running("sb", process.ppid);
    const api = await serve();
    const inbox = await api.get("/api/inbox");
    const by = Object.fromEntries(inbox.items.map((i: { key: string }) => [i.key, i]));
    assert.deepEqual(by["claude:sa"].conflicts, [{ path: "shared.ts", with: ["claude:sb"] }]);
    assert.deepEqual(by["claude:sb"].conflicts, [{ path: "shared.ts", with: ["claude:sa"] }]);
  });
});

describe("api: a session's conversation and files", () => {
  it("reads a listed session's conversation, page by page, and nobody else's", async () => {
    const rows: object[] = [];
    for (let i = 0; i < 40; i++) rows.push({ type: "user", message: { content: `q${i}` } }, { type: "assistant", message: { content: [{ type: "text", text: `a${i}` }] } });
    transcript("sa", rows);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    const latest = await api.get("/api/chat?key=claude:sa");
    assert.equal(latest.messages.at(-1).text, "a39");
    assert.ok(latest.before > 0, "there is more before");
    const earlier = await api.get(`/api/chat?key=claude:sa&before=${latest.before}`);
    assert.ok(Number(earlier.messages.at(-1).id) < Number(latest.messages[0].id), "the page before ends where this one starts");
    assert.deepEqual((await api.get(`/api/chat?key=claude:sa&after=${latest.end}`)).messages, []);
    await assert.rejects(api.get("/api/chat?key=claude:nobody"), /404/);
  });

  it("opens files in the session's repository only", async () => {
    writeFileSync(join(repo, "notes.md"), "# Notes\n");
    writeFileSync(join(repo, ".env"), "TOKEN=1");
    transcript("sa", []);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    const dir = await api.get("/api/files?key=claude:sa");
    const names = dir.entries.map((e: { name: string }) => e.name);
    assert.ok(names.includes("notes.md") && !names.includes(".env") && !names.includes(".git"), names.join(" "));
    assert.equal((await api.get("/api/files?key=claude:sa&path=notes.md")).kind, "markdown");
    await assert.rejects(api.get("/api/files?key=claude:sa&path=.env"), /403/);
    await assert.rejects(api.get("/api/files?key=claude:sa&path=../"), /403/);
    await assert.rejects(api.get("/api/files?key=claude:nobody&path=notes.md"), /404/);
  });
});

describe("api: shell commands", () => {
  /** Runs a command through the page's API: the lines it streams back, parsed. */
  const run = async (api: Awaited<ReturnType<typeof serve>>, key: string, command: string, signal?: AbortSignal) => {
    const res = await api.send!("/api/command", { method: "POST", body: JSON.stringify({ key, command }), ...(signal && { signal }) });
    if (!res.ok) return { status: res.status, error: ((await res.json()) as { error: string }).error, lines: [] as any[] };
    const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { status: res.status, lines, out: lines.map((l) => l.o ?? "").join(""), done: lines.at(-1) };
  };

  it("runs a command in the session's folder and streams what it prints, both streams, without colors", async () => {
    transcript("sa", []);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    const r = await run(api, "claude:sa", "pwd; echo out; echo err >&2; printf '\\033[31mred\\033[0m\\n'; exit 3");
    assert.equal(r.status, 200);
    assert.equal(r.out, `${repo}\nout\nerr\nred\n`);
    assert.equal(r.done.done, true);
    assert.equal(r.done.code, 3);
    assert.equal(r.lines[0].cwd, repo);
    assert.match((await run(api, "claude:sa", "read x; echo got:$x")).out!, /^got:$/m, "nothing to read: an end of input at once");
  });

  it("runs only in listed sessions' folders, and checks what it is given", async () => {
    transcript("sa", []);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    assert.equal((await run(api, "claude:nobody", "echo hi")).status, 404);
    assert.equal((await run(api, "claude:sa", "   ")).status, 400);
    assert.equal((await run(api, "claude:sa", "x".repeat(5000))).status, 400);
  });

  it("stops the command, and what it started, when the page stops waiting", async () => {
    transcript("sa", []);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    const mark = join(repo, "still-running");
    const stop = new AbortController();
    const res = await api.send!("/api/command", { method: "POST", body: JSON.stringify({ key: "claude:sa", command: `(sleep 1.5; touch ${mark}) & sleep 30` }), signal: stop.signal });
    const reader = res.body!.getReader();
    await reader.read(); // started
    stop.abort();
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(existsSync(mark), false, "the whole group was stopped");
  });
});

describe("api: an app with notifications", () => {
  it("serves the manifest, the worker and the icons without the token", async () => {
    const api = await serve();
    const manifest = await api.send!("/manifest.webmanifest", { headers: { "x-token": "" } });
    assert.equal(manifest.status, 200);
    assert.equal(((await manifest.json()) as { name: string }).name, "Agent Deck");
    assert.match(await (await api.send!("/sw.js", { headers: { "x-token": "" } })).text(), /showNotification/);
    const icon = Buffer.from(await (await api.send!("/icon-192.png", { headers: { "x-token": "" } })).arrayBuffer());
    assert.equal(icon.subarray(1, 4).toString(), "PNG");
    assert.equal(icon.readUInt32BE(16), 192);
  });

  it("pushes to the browsers that asked, encrypted for them, when a session starts waiting", async () => {
    const service = await pushService();
    transcript("sa", []);
    running("sa", process.pid, { status: "busy" });
    const api = await serve({ AGENT_DECK_WATCH_MS: "200", AGENT_DECK_PUSH_INSECURE: "1" });
    const b = browser();
    await api.post("/api/push/subscribe", { subscription: { endpoint: `${service.url}/push/1`, keys: b.keys } });
    assert.equal((await api.get("/api/push")).endpoints.length, 1);
    await new Promise((r) => setTimeout(r, 1500)); // the first look: the baseline
    running("sa", process.pid, { status: "waiting", waitingFor: "approve Bash: npm test" });
    const msg = await eventually(async () => service.got[0]);
    const m = JSON.parse(decrypt(msg.body, b.ua, b.auth));
    assert.equal(m.title, "name-sa asks you");
    assert.equal(m.body, "approve Bash: npm test");
    assert.match(m.url, /^\/#t=[0-9a-f]{32}&s=claude%3Asa$/, "the local page opens with its token, on the session");
    assert.equal(msg.headers["urgency"], "high");
    await api.post("/api/push/unsubscribe", { endpoint: `${service.url}/push/1` });
    assert.equal((await api.get("/api/push")).endpoints.length, 0);
    service.close();
  });
});

describe("api: files sent to a session", () => {
  it("saves a file in the session's repository, out of git's sight", async () => {
    transcript("sa", []);
    running("sa", process.pid);
    const api = await serve();
    await api.get("/api/inbox");
    const res = await api.send!("/api/upload?key=claude:sa", { method: "POST", body: "hello", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("メモ.txt") } });
    assert.equal(res.status, 200);
    const up = (await res.json()) as { path: string; rel: string };
    assert.match(up.rel, /^\.agent-deck\/uploads\/\d{8}-\d{6}-メモ\.txt$/);
    assert.equal(readFileSync(up.path, "utf8"), "hello");
    assert.equal(git(repo, "status", "--porcelain"), "");
    const big = await api.send!("/api/upload?key=claude:sa", { method: "POST", body: Buffer.alloc(26 * 1024 * 1024), headers: { "content-type": "application/octet-stream", "x-file-name": "big.bin" } });
    assert.equal(big.status, 413);
    assert.equal((await api.send!("/api/upload?key=claude:nobody", { method: "POST", body: "x", headers: { "x-file-name": "a" } })).status, 404);
  });
});

describe("api: pull requests", () => {
  it("adds each pull request's state and CI, looked up with gh in the background", async () => {
    const gh = join(home, "gh");
    const rollup = [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", state: "PENDING" },
    ];
    writeFileSync(gh, `#!/bin/sh\necho '${JSON.stringify({ number: 7, title: "Fix login", state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", url: "https://github.com/o/r/pull/7", statusCheckRollup: rollup })}'\n`);
    chmodSync(gh, 0o755);
    transcript("sa", [{ type: "pr-link", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prRepository: "o/r" }]);
    running("sa", process.pid);
    const api = await serve({ AGENT_DECK_GH: gh });
    const status = await eventually(async () => (await api.get("/api/inbox")).prStatus["https://github.com/o/r/pull/7"]);
    assert.equal(status.ci, "failing");
    assert.deepEqual(status.checks, { passed: 1, failed: 1, pending: 1 });
    assert.equal(status.review, "REVIEW_REQUIRED");
    assert.equal(status.title, "Fix login");
  });

  it("sums up checks: failing beats pending beats passing", () => {
    const s = (rollup: object[]) => summarize({ statusCheckRollup: rollup }, "u").ci;
    assert.equal(s([]), "none");
    assert.equal(s([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "passing");
    assert.equal(s([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
    assert.equal(s([{ state: "ERROR" }, { status: "QUEUED" }]), "failing");
  });
});

describe("api: later and done", () => {
  it("holds a session and releases it", async () => {
    running("sa", process.pid, { status: "waiting", waitingFor: "input needed" });
    const api = await serve();
    await api.get("/api/inbox");
    const { hold } = await api.post("/api/hold", { key: "claude:sa", kind: "later", until: "2h" });
    assert.equal(hold.kind, "later");
    assert.ok(hold.until > Date.now() + 36e5);
    assert.equal((await api.get("/api/inbox")).items[0].hold.kind, "later");
    assert.deepEqual(await api.post("/api/release", { key: "claude:sa" }), { released: true });
    assert.equal((await api.get("/api/inbox")).items[0].hold, undefined);
    await assert.rejects(api.post("/api/hold", { key: "claude:nope", kind: "done" }), /no longer listed/);
  });
});

describe("api: cleanup", () => {
  it("lists idle sessions and the worktrees that can go, with the commands", async () => {
    const wt = (name: string) => join(realpathSync(tempDir("adv-wt-")), name);
    const merged = wt("merged");
    const dirty = wt("dirty");
    const busy = wt("busy");
    git(repo, "worktree", "add", "-q", "-b", "done-branch", merged);
    git(repo, "worktree", "add", "-q", "-b", "dirty-branch", dirty);
    git(repo, "worktree", "add", "-q", "-b", "busy-branch", busy);
    writeFileSync(join(dirty, "wip.txt"), "wip\n");
    running("idle", process.pid, { status: "idle", statusUpdatedAt: Date.now() - 3 * 864e5 });
    running("worker", process.ppid, { status: "busy", cwd: busy });
    const api = await serve();
    await api.get("/api/inbox");
    const c = await api.get("/api/cleanup");
    assert.deepEqual(c.sessions.map((s: { key: string; close: string }) => [s.key, s.close]), [["claude:idle", `kill ${process.pid}`]]);
    const by = Object.fromEntries(c.worktrees.map((w: { path: string }) => [w.path, w]));
    assert.equal(by[merged].removable, true);
    assert.deepEqual(by[merged].commands, [`git -C ${repo} worktree remove ${merged}`, `git -C ${repo} branch -d done-branch`]);
    assert.equal(by[dirty].removable, false);
    assert.equal(by[dirty].dirty, true);
    assert.equal(by[busy].removable, false);
    assert.deepEqual(by[busy].sessions, ["claude:worker"]);
  });
});

describe("api: herdr", () => {
  const codexId = "01a1e377-0000-7000-8000-0000000000c1";
  let sleeper: ChildProcess | undefined;
  let holder: ChildProcess | undefined;
  afterEach(() => {
    sleeper?.kill();
    if (holder?.pid) process.kill(-holder.pid, "SIGTERM");
    sleeper = holder = undefined;
  });

  /** A fake herdr: logs each call with the socket it was pointed at, and answers like herdr does. */
  function fakeHerdr(): { bin: string; log: string; socket: string } {
    const log = join(home, "herdr.log");
    const socket = join(home, "herdr.sock");
    const agents = [
      { pane_id: "w1:p9", agent_status: "idle", agent: "claude", terminal_id: "t9", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
      { pane_id: "w1:p4", agent_status: "blocked", agent: "codex", agent_session: { agent: "codex", kind: "id", source: "hook", value: codexId }, terminal_id: "t4", workspace_id: "w1", tab_id: "w1:t1", focused: false, revision: 1 },
    ];
    const bin = join(home, "herdr");
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$HERDR_SOCKET_PATH $*" >> "${log}"
case "$1 $2" in
  "agent list") printf '%s\n' '${JSON.stringify({ id: "cli:agent:list", result: { type: "agent_list", agents } })}' ;;
  "agent read") printf '%s\n' '${JSON.stringify({ id: "cli:agent:read", result: { type: "pane_read", read: { text: "Allow this command?\n> 1. Yes\n  2. No" } } })}' ;;
  "workspace create") printf '%s\n' '{"id":"cli","result":{"type":"workspace_created","root_pane":{"pane_id":"w2:p1"},"tab":{},"workspace":{}}}' ;;
  *) printf '%s\n' '{"id":"cli","result":{"type":"agent_info"}}' ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    return { bin, log, socket };
  }

  async function setUp(extra: string[] = []): Promise<{ api: Awaited<ReturnType<typeof serve>>; log: string; socket: string }> {
    const { bin, log, socket } = fakeHerdr();
    // The Claude session's process runs in herdr pane w1:p9.
    sleeper = spawn("sleep", ["30"], { env: { ...process.env, HERDR_PANE_ID: "w1:p9", HERDR_SOCKET_PATH: socket } });
    running("sa", sleeper.pid!, { status: "idle" });
    // A Codex thread, working as far as its rollout says.
    const dir = join(home, ".codex", "sessions", "2026", "11", "19");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-x-${codexId}.jsonl`), [{ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: codexId, cwd: repo } }, { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_started" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const locks = join(home, ".codex", "thread-writer-locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${codexId}.lock`), "");
    holder = spawn("flock", [join(locks, `${codexId}.lock`), "sleep", "30"], { stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 200));
    child = spawn(process.execPath, [CLI, "view", "--port", "0", ...extra], { cwd: repo, env: { ...env, AGENT_DECK_HERDR: bin } });
    const url = await new Promise<string>((resolve) => child!.stdout!.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0])));
    const { origin, hash } = new URL(url);
    const headers = { "x-token": new URLSearchParams(hash.slice(1)).get("t")!, "content-type": "application/json" };
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(origin + path, { ...init, headers });
      const body = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${(body as { error?: string }).error}`);
      return body;
    };
    return { api: { get: (p) => call(p), post: (p, b) => call(p, { method: "POST", body: JSON.stringify(b) }) }, log, socket };
  }

  it("shows each session's pane and state, and Codex approvals herdr sees", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const { api } = await setUp();
    const inbox = await eventually(async () => {
      const r = await api.get("/api/inbox");
      const by = Object.fromEntries(r.items.map((i: { key: string }) => [i.key, i]));
      return by["claude:sa"]?.herdr?.status === "idle" && by[`codex:${codexId}`]?.herdr ? by : undefined;
    });
    assert.deepEqual(inbox["claude:sa"].herdr, { pane: "w1:p9", status: "idle" });
    assert.deepEqual(inbox[`codex:${codexId}`].herdr, { pane: "w1:p4", status: "blocked" });
    assert.equal(inbox[`codex:${codexId}`].state, "needs-answer");
  });

  it("focuses, prompts, sends allowed keys and reads the screen, in the session's own herdr", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const { api, log, socket } = await setUp();
    await eventually(async () => ((await api.get("/api/inbox")).items.some((i: { key: string; herdr?: object }) => i.key === `codex:${codexId}` && i.herdr) ? true : undefined));
    await api.post("/api/herdr/focus", { key: "claude:sa" });
    await api.post("/api/herdr/prompt", { key: "claude:sa", text: "Ship it" });
    await api.post("/api/herdr/keys", { key: `codex:${codexId}`, keys: ["1", "enter"] });
    await assert.rejects(api.post("/api/herdr/keys", { key: "claude:sa", keys: ["ctrl+d"] }), /Keys not allowed: ctrl\+d/);
    await assert.rejects(api.post("/api/start", { dir: "/etc", agent: "claude", prompt: "x" }), /404 Not a folder of a listed session/);
    await assert.rejects(api.post("/api/herdr/prompt", { key: "claude:sa", text: "  " }), /Write a prompt/);
    const shown = await api.get(`/api/herdr/screen?key=${encodeURIComponent(`codex:${codexId}`)}`);
    assert.match(shown.prompt.sig, /^[0-9a-f]{16}$/);
    delete shown.prompt.sig;
    assert.deepEqual(shown, {
      text: "Allow this command?\n> 1. Yes\n  2. No",
      prompt: { question: "Allow this command?", choices: [{ key: "1", label: "Yes", selected: true }, { key: "2", label: "No" }] },
    });
    const calls = readFileSync(log, "utf8").split("\n").filter((l) => !l.includes("agent list") && l);
    assert.deepEqual(calls, [`${socket} agent focus w1:p9`, `${socket} agent prompt w1:p9 Ship it`, `${socket} agent send-keys w1:p4 1 enter`, `${socket} agent read w1:p4 --source visible`]);
  });

  it("picks a choice by moving the pointer to it, and presses Enter only once the screen shows it there", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const { api, log, socket } = await setUp();
    // A herdr whose dialog (no numbers, as in auto mode) follows the arrow keys, unless told to stick.
    const at = join(home, "pointer");
    const stuck = join(home, "stuck");
    const cmd = join(home, "command");
    writeFileSync(at, "0");
    writeFileSync(cmd, "rm -rf build");
    writeFileSync(
      join(home, "herdr"),
      `#!/bin/sh
echo "$HERDR_SOCKET_PATH $*" >> "${log}"
case "$1 $2" in
  "agent list") printf '%s\n' '${JSON.stringify({ result: { type: "agent_list", agents: [{ pane_id: "w1:p9", agent_status: "blocked", agent: "claude", workspace_id: "w1" }] } })}' ;;
  "agent read") if [ "$(cat "${at}")" = 0 ]; then y="❯ Yes"; n="  No"; else y="  Yes"; n="❯ No"; fi
    printf '   %s\\n\\n Do you want to proceed?\\n %s\\n %s\\n\\n Esc to cancel\\n' "$(cat "${cmd}")" "$y" "$n" ;; # as herdr 0.8 prints it: the screen, not JSON
  "agent send-keys") [ -f "${stuck}" ] || case "$4" in down) echo 1 > "${at}" ;; up) echo 0 > "${at}" ;; esac
    printf '%s\n' '{"result":{"type":"ok"}}' ;;
  *) printf '%s\n' '{"result":{"type":"ok"}}' ;;
esac
`,
    );
    await eventually(async () => ((await api.get("/api/inbox")).items.some((i: { key: string; herdr?: object }) => i.key === "claude:sa" && i.herdr) ? true : undefined));
    const keys = () => readFileSync(log, "utf8").split("\n").filter((l) => l.includes("send-keys"));

    const sig = async () => (await api.get("/api/herdr/screen?key=claude%3Asa")).prompt.sig as string;
    const first = await sig();
    await assert.rejects(api.post("/api/herdr/choose", { key: "claude:sa", index: 1, label: "Yes, and don't ask again", sig: first }), /409 Its screen shows another question now/);
    await assert.rejects(api.post("/api/herdr/choose", { key: "claude:sa", index: 1, label: "No" }), /400 Reload the page/);
    writeFileSync(cmd, "rm -rf src");
    await assert.rejects(api.post("/api/herdr/choose", { key: "claude:sa", index: 0, label: "Yes", sig: first }), /409 Its screen shows another question now/, "the same choices for another command");
    assert.deepEqual(keys(), [], "nothing pressed for a dialog that is not on the screen");

    writeFileSync(cmd, "rm -rf build");
    assert.deepEqual((await api.post("/api/herdr/choose", { key: "claude:sa", index: 1, label: "No", sig: first })).result, { label: "No" });
    assert.deepEqual(keys(), [`${socket} agent send-keys w1:p9 down`, `${socket} agent send-keys w1:p9 enter`]);
    await assert.rejects(api.post("/api/herdr/choose", { key: "claude:sa", index: 1, label: "No", sig: first }), /409 That was just answered/, "a second tap");

    writeFileSync(at, "0");
    writeFileSync(cmd, "rm -rf dist");
    writeFileSync(stuck, "");
    await assert.rejects(api.post("/api/herdr/choose", { key: "claude:sa", index: 1, label: "No", sig: await sig() }), /409 The pointer did not get to “No”, so nothing was picked/);
    assert.deepEqual(keys().slice(2), [`${socket} agent send-keys w1:p9 down`], "no Enter when the pointer is not on it");
  });

  it("moves a session waiting in another terminal into herdr, to go on with the same conversation", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const { api, log, socket } = await setUp();
    // Claude Code in a terminal outside herdr (a process named so, with no herdr pane), and one at work.
    const id = "5e55a0e1-0000-4000-8000-000000000001";
    // The one waiting runs in a terminal of its own, as in Ptyxis; the stand-in prints its pid and, at
    // the end, the signal that closed it.
    const term = inTerminal("exec -a claude-standin sleep 30");
    const busy = spawn("bash", ["-c", "exec -a claude-standin sleep 30"], { stdio: "ignore" });
    try {
      const pid = await eventually(async () => term.pid());
      running(id, pid, { status: "idle", name: "Rate-limit the API" });
      running("5e55a0e1-0000-4000-8000-000000000002", busy.pid!, { status: "busy" });
      const listed = await eventually(async () => {
        const by = Object.fromEntries((await api.get("/api/inbox")).items.map((i: { key: string }) => [i.key, i]));
        return by[`claude:${id}`] && by["claude:sa"]?.herdr ? by : undefined;
      });
      assert.equal(listed[`claude:${id}`].herdr, undefined);
      await assert.rejects(api.post("/api/move", { key: "claude:sa" }), /409 It already runs in herdr/);
      await assert.rejects(api.post("/api/move", { key: "claude:5e55a0e1-0000-4000-8000-000000000002" }), /409 It can move once it waits for you/);
      assert.ok(busy.exitCode === null && !busy.signalCode, "a session at work is left alone");
      running("5e55a0e1-0000-4000-8000-000000000003", busy.pid!, { status: "idle", kind: "bg" });
      await assert.rejects(api.post("/api/move", { key: "claude:5e55a0e1-0000-4000-8000-000000000003" }), /409 It runs as a Claude Code background session/);

      const r = await api.post("/api/move", { key: `claude:${id}` });
      assert.equal(r.key, `claude:${id}`, "the same session, resumed");
      assert.equal(r.pane, "w2:p1");
      assert.equal(await eventually(async () => term.signal()), 15, "closed where it ran, with SIGTERM");
      const calls = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("workspace") || l.includes("agent start"));
      assert.deepEqual(calls.slice(0, 2), [`${socket} workspace list`, `${socket} workspace create --cwd ${repo} --label ${basename(repo)} --no-focus`], "a tab is opened before anything is closed");
      assert.match(calls[2]!, new RegExp(`^${socket} agent start \\S+ --kind claude --pane w2:p1 --timeout 60000 -- --resume ${id}$`));
    } finally {
      term.process.kill();
      busy.kill();
    }
  });

  it("leaves herdr alone with --no-herdr", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
    const { api, log } = await setUp(["--no-herdr"]);
    const r = await api.get("/api/inbox");
    assert.ok(r.items.every((i: { herdr?: object }) => !i.herdr));
    await assert.rejects(api.post("/api/herdr/focus", { key: "claude:sa" }), /does not run in a herdr pane/);
    await assert.rejects(api.post("/api/start", { dir: repo, agent: "claude", prompt: "x" }), /herdr is off/);
    assert.equal(existsSync(log), false, "herdr was never run");
  });
});

describe("herdr: its replies", () => {
  it("takes the screen as herdr prints it, and its errors from stderr", async () => {
    const { herdr, screen } = await import("../src/herdr.ts");
    const fake = join(home, "herdr-replies");
    writeFileSync(fake, `#!/bin/sh
case "$3" in
  w1:p1) printf '{ not json\\n❯ Yes\\n' ;;
  w1:p2) printf '%s\\n' '{"result":{"read":{"text":"older herdr"}}}' ;;
  *) echo '{"error":{"code":"agent_not_found","message":"agent target $3 not found"}}' >&2; exit 1 ;;
esac
`);
    chmodSync(fake, 0o755);
    const was = process.env["AGENT_DECK_HERDR"];
    process.env["AGENT_DECK_HERDR"] = fake;
    try {
      assert.equal(await screen({ pane: "w1:p1", socket: "s", status: "idle" }), "{ not json\n❯ Yes\n");
      assert.equal(await screen({ pane: "w1:p2", socket: "s", status: "idle" }), "older herdr");
      await assert.rejects(screen({ pane: "w1:p9", socket: "s", status: "idle" }), (e: Error & { code?: string }) => e.code === "agent_not_found");
      await assert.rejects(herdr("s", ["agent", "prompt", "w1:p9", "hi"]), (e: Error & { code?: string }) => e.code === "agent_not_found");
    } finally {
      if (was === undefined) delete process.env["AGENT_DECK_HERDR"];
      else process.env["AGENT_DECK_HERDR"] = was;
    }
  });
});

describe("herdr: matching panes", () => {
  it("finds a Codex thread's pane by its folder and its terminal title when herdr has no id for it", async () => {
    const { matchPanes } = await import("../src/herdr.ts");
    const item = (key: string, name: string, cwd: string) => ({ key, agent: "codex" as const, id: key.split(":")[1]!, name, cwd, state: "working" as const, since: 0, resume: "" });
    const panes = [
      { pane: "w1:p1", socket: "s", status: "blocked", agent: "codex", cwd: "/w/app", title: "Fix the login | app" },
      { pane: "w1:p2", socket: "s", status: "idle", agent: "codex", cwd: "/w/app", title: "Write docs | app" },
      { pane: "w1:p3", socket: "s", status: "idle", agent: "codex", cwd: "/w/other", title: "Fix the login | other" },
    ];
    const m = matchPanes([item("codex:a", "Fix the login", "/w/app"), item("codex:b", "Unrelated", "/w/app")], panes);
    assert.equal(m.get("codex:a")?.pane, "w1:p1");
    assert.equal(m.get("codex:b"), undefined, "no guess without a matching title");
  });

  it("does not trust a pane from the environment when herdr says it shows another session", async () => {
    const { matchPanes } = await import("../src/herdr.ts");
    // A pane's Claude Code parked its own session (fe) to show a background one (bg), which was
    // started from that pane and so carries its id in its environment too.
    const terminal = { herdrPane: "w1:p3", herdrSocket: "s" };
    const item = (id: string) => ({ key: `claude:${id}`, agent: "claude" as const, id, name: id, cwd: "/w", state: "your-turn" as const, since: 0, resume: "", terminal });
    const panes = [{ pane: "w1:p3", socket: "s", status: "idle", agent: "claude", session: "bg" }];
    const m = matchPanes([item("fe"), item("bg")], panes);
    assert.equal(m.get("claude:bg")?.pane, "w1:p3");
    assert.equal(m.get("claude:fe"), undefined, "typing to fe would reach bg");
    assert.equal(matchPanes([item("fe")], [])?.get("claude:fe")?.status, "unknown", "a pane herdr does not list is still taken at its word");
  });
});

describe("api: the local token", () => {
  it("stays the same across restarts, so a bookmarked URL keeps working", async () => {
    const start = async () => {
      const c = spawn(process.execPath, [CLI, "inbox", "--view", "--port", "0", "--no-herdr"], { cwd: home, env });
      const url = await new Promise<string>((resolve) => c.stdout!.on("data", (d: Buffer) => /http:\S+/.test(String(d)) && resolve(/http:\S+/.exec(String(d))![0])));
      c.kill();
      return new URL(url).hash;
    };
    assert.equal(await start(), await start());
  });

  it("answers its own host names only, and the API only with the very token", async () => {
    const api = await serve();
    const origin = api.origin!;
    const token = api.token!;
    const port = new URL(origin).port;
    // Another site can point a name of its own at 127.0.0.1 (DNS rebinding): its page then reaches
    // this port, with that name as the Host. Refused, token or not, the page and its assets too.
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
      for (const path of ["/", "/manifest.webmanifest", "/api/inbox"]) {
        const res = await raw(origin, path, { host, "x-token": token });
        assert.deepEqual([res.status, res.body], [403, "Forbidden host"], host + path);
      }
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, "localhost"]) assert.equal((await raw(origin, "/api/inbox", { host, "x-token": token })).status, 200, host);
    // No token, an empty one, one a character off, one too short or too long: refused.
    const off = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    for (const wrong of [undefined, "", off, token.slice(0, -1), token + "0"]) {
      const res = await raw(origin, "/api/inbox", { host: `localhost:${port}`, ...(wrong !== undefined && { "x-token": wrong }) });
      assert.equal(res.status, 403, `token ${JSON.stringify(wrong)}`);
      assert.match(res.body, /access token/);
    }
    // The page and what makes it an app need none: the page takes the token from its URL.
    const page = await raw(origin, "/", { host: `localhost:${port}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Agent Deck<\/title>/);
    assert.equal((await raw(origin, "/manifest.webmanifest", { host: `127.0.0.1:${port}` })).status, 200);
  });
});

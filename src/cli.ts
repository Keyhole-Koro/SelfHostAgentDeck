#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { FileAttribution, HunkOwner } from "./attribute.ts";
import { applyAdd, findSession, load, parseSince, planAdd, type Loaded } from "./core.ts";
import { repoRoot } from "./git.ts";
import { serve } from "./server.ts";
import { runHook } from "./hook.ts";
import { holdCommand, loadInbox, printCleanup, printInbox, publishInbox, publisher, watchInbox } from "./inbox-cli.ts";
import { agentInstalled, installHooks, installSkills, installStatusLine, uninstallHooks, uninstallSkills, uninstallStatusLine } from "./install.ts";
import { remoteCommand } from "./remote-cli.ts";
import { statusLineFor } from "./statusline.ts";
import { bold, cyan, dim, green, red, when, yellow } from "./term.ts";
import type { Session, Transcripts } from "./types.ts";

const HELP = `agent-diff — which Claude Code or Codex session made each uncommitted change

  agent-diff                 Uncommitted changes grouped by the session that made them
  agent-diff --by-file       The same, one line per file
  agent-diff show <session>  The hunks a session made, as a diff
  agent-diff add <session>   Stage exactly that session's changes (whole files and single hunks)
  agent-diff view            Browse it all in a local web page (127.0.0.1; --port to pick one)
  agent-diff inbox           Running sessions, in every repository, that wait on you
                             (--view: the same as a web page that refreshes itself;
                             --watch: report each session that starts waiting, --notify: on the
                             desktop too; --publish: put a private snapshot online with the
                             SelfHostArtifacts \`artifact\` CLI, to check from your phone)
  agent-diff later <session> Take a session off the list for a while (--until 2h, tomorrow, 9:00)
  agent-diff done <session>  Take a session off the list until it does something new
  agent-diff unhold <session>  Put it back
  agent-diff remote pair     A one-time link (and QR code) to add a phone that opens the page at
                             the --remote origin and signs in with a passkey
  agent-diff remote devices | revoke <id> | log   The devices added, removing one, what they did
  agent-diff cleanup         Idle sessions and worktrees nobody uses, with the commands to close
                             or remove them (nothing is removed for you)
  agent-diff statusline      One line for Claude Code's status line: the other sessions that wait
  agent-diff install         Record every write as it happens (hooks for Claude Code and Codex),
                             and teach the agents to commit only their own changes (a skill);
                             --statusline also shows the waiting sessions in Claude Code's status line
  agent-diff uninstall       Remove all of it

Options
  -C <dir>         Run in another repository
  --since <time>   Changes since then: 2h, 1d, today or a date (commits since then included)
  --base <ref>     Changes since a commit or branch, e.g. --base main
  --days <n>       How far back to read transcripts (default 30; files committed earlier are
                   only matched against sessions after their last commit anyway)
  --dry-run        With add: show what would be staged
  --stale <time>   With inbox: idle longer than this counts as left alone (default 1d)
  --all            With inbox: list the sessions left alone one by one
  --interval <s>   With inbox --watch: seconds between looks (default 5)
  --no-herdr       With view: leave herdr alone (no pane states, no focusing or sending)
  --remote <url>   With view: also serve the page to devices signed in with a passkey at this
                   public origin (https://…), on --remote-port (default 47301) for a tunnel
  --json           Machine-readable output

  --self           With show/add: the Claude Code or Codex session running the command

<session> is an id prefix (e.g. 0be1c91d), optionally prefixed with claude: or codex:.
Reads ~/.claude/projects and ~/.codex/sessions (or $CLAUDE_CONFIG_DIR, $CODEX_HOME).`;

function label(s: Session | undefined, key: string): string {
  if (!s) return key;
  const agent = s.agent === "claude" ? "Claude" : "Codex ";
  const title = s.title.length > 70 ? s.title.slice(0, 69) + "…" : s.title;
  return `${bold(agent)} ${cyan(s.id.slice(0, 8))}  ${dim(`${when(s.firstAt)}–${when(s.lastAt)}`)}  ${title}`;
}

function statusMark(status: string): string {
  const s = status === "??" ? "A" : status[0] ?? "M";
  return s === "D" ? red(s) : s === "A" ? green(s) : yellow(s);
}

function hunkCount(n: number): string {
  return `${n} hunk${n === 1 ? "" : "s"}`;
}

/** Default view: each session with the files it changed. */
function printBySession(transcripts: Transcripts, attributions: FileAttribution[]): void {
  const bySession = new Map<string, { file: FileAttribution; owned: HunkOwner[] }[]>();
  const unknown: { file: FileAttribution; owned: HunkOwner[] }[] = [];
  for (const a of attributions) {
    const groups = new Map<string, HunkOwner[]>();
    for (const h of a.hunks) {
      const k = h.owner ?? "";
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const [k, owned] of groups) (k ? (bySession.get(k) ?? bySession.set(k, []).get(k)!) : unknown).push({ file: a, owned });
  }
  const order = [...bySession.keys()].sort((a, b) => (transcripts.sessions.get(b)?.lastAt ?? 0) - (transcripts.sessions.get(a)?.lastAt ?? 0));
  for (const key of order) {
    console.log(label(transcripts.sessions.get(key), key));
    for (const { file, owned } of bySession.get(key)!) {
      const total = file.hunks.length;
      const share = owned.length === total ? "" : dim(` (${owned.length} of ${total} hunks; rest by others)`);
      const guess = owned.every((h) => h.confidence === "maybe") ? yellow(" ?") : "";
      console.log(`    ${statusMark(file.file.status)} ${file.file.rel}${guess}${share}`);
    }
    console.log("");
  }
  if (unknown.length) {
    console.log(bold("Not found in any transcript") + dim("  (edited by hand, by a tool, or by a session older than --days)"));
    for (const { file, owned } of unknown) {
      const hint = file.shell.length ? dim(`  shell commands in ${file.shell.map((k) => k.split(":")[1]!.slice(0, 8)).join(", ")} mention it`) : "";
      console.log(`    ${statusMark(file.file.status)} ${file.file.rel}${owned.length < file.hunks.length ? dim(` (${hunkCount(owned.length)})`) : ""}${hint}`);
    }
    console.log("");
  }
  if (!order.length && !unknown.length) console.log("No uncommitted changes.");
  else console.log(dim("? = only a guess (the session touched the file, but no lines matched)"));
}

function printByFile(transcripts: Transcripts, attributions: FileAttribution[]): void {
  const width = Math.min(60, Math.max(...attributions.map((a) => a.file.rel.length)));
  for (const a of attributions) {
    const owners = [...new Set(a.hunks.map((h) => h.owner ?? "?"))].map((k) => {
      if (k === "?") return red("unknown");
      const s = transcripts.sessions.get(k);
      return `${s?.agent === "codex" ? "Codex" : "Claude"} ${cyan(k.split(":")[1]!.slice(0, 8))}`;
    });
    console.log(`${statusMark(a.file.status)} ${a.file.rel.padEnd(width)}  ${owners.join(", ")}`);
  }
}

function show(transcripts: Transcripts, attributions: FileAttribution[], key: string): void {
  console.log(label(transcripts.sessions.get(key), key) + "\n");
  for (const a of attributions) {
    const owned = a.hunks.filter((h) => h.owner === key);
    if (!owned.length) continue;
    console.log(bold(`${a.file.rel}`) + dim(`  ${owned.length} of ${hunkCount(a.hunks.length)}`));
    for (const h of owned) {
      console.log(cyan(h.hunk.header) + (h.confidence === "maybe" ? yellow("  (guess)") : ""));
      for (const l of h.hunk.lines.slice(0, 200)) console.log(l.startsWith("+") ? green(l) : l.startsWith("-") ? red(l) : l);
      if (h.hunk.lines.length > 200) console.log(dim(`… ${h.hunk.lines.length - 200} more lines`));
    }
    console.log("");
  }
}

function add(loaded: Loaded, key: string, dryRun: boolean): void {
  const plan = planAdd(loaded, key);
  for (const rel of plan.whole) console.log(`${green("+")} ${rel}`);
  for (const p of plan.partial) console.log(`${green("+")} ${p.rel} ${dim(`(${hunkCount(p.hunks)} of its changes)`)}`);
  for (const s of plan.skipped) console.log(`${dim("-")} ${s}`);
  if (dryRun) {
    console.log(dim("\n(dry run: nothing staged)"));
    return;
  }
  applyAdd(loaded.root, plan);
  console.log(dim(`\nStaged. Check with: git diff --cached --stat`));
}

function installCommand(command: "install" | "uninstall", only: string | undefined, statusLine: boolean): void {
  if (command === "install" && statusLine) {
    const r = installStatusLine();
    if (r.skipped) console.log(`- Claude Code: your status line already runs ${r.skipped}; left as it is. Add \`agent-diff statusline\` to it yourself.`);
    else console.log(`${r.changed ? "✓" : "-"} Claude Code: ${r.changed ? "status line set in" : "status line already set in"} ${r.file}`);
  }
  if (command === "uninstall") {
    const r = uninstallStatusLine();
    if (r.changed) console.log(`✓ Claude Code: status line removed from ${r.file}`);
  }
  const agents = (only ? [only] : ["claude", "codex"]).filter((a): a is "claude" | "codex" => a === "claude" || a === "codex");
  if (only && agents.length === 0) throw new Error(`--agent is claude or codex, not "${only}"`);
  for (const agent of agents) {
    if (command === "install" && !only && !agentInstalled(agent)) continue;
    const r = command === "install" ? installHooks(agent) : uninstallHooks(agent);
    const name = agent === "claude" ? "Claude Code" : "Codex";
    const what = !r.changed ? "nothing to change in" : command === "install" ? "hooks added to" : "hooks removed from";
    console.log(`${r.changed ? "✓" : "-"} ${name}: ${what} ${r.file}`);
    if (command === "install") {
      const sk = installSkills(agent);
      if (sk.installed.length) console.log(`✓ ${name}: skill ${sk.installed.join(", ")} in ${sk.dir}`);
      for (const skipped of sk.skipped) console.log(`- ${name}: ${skipped} in ${sk.dir} is someone else's; left as it is`);
    } else {
      const removed = uninstallSkills(agent);
      if (removed.length) console.log(`✓ ${name}: skill ${removed.join(", ")} removed`);
    }
    if (agent === "codex" && command === "install" && r.changed) {
      console.log(dim("  In Codex, run /hooks once and trust the agent-diff hook; until then it records nothing."));
    }
  }
}

/** The session running this command, when an agent runs it: both agents export their id. */
function selfSession(): string {
  const claude = process.env["CLAUDE_CODE_SESSION_ID"];
  if (claude) return `claude:${claude}`;
  const codex = process.env["CODEX_THREAD_ID"] || process.env["CODEX_SESSION_ID"];
  if (codex) return `codex:${codex}`;
  throw new Error("--self works inside a Claude Code or Codex session (no CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID here).");
}

function main(): void {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      C: { type: "string", short: "C" },
      days: { type: "string" },
      base: { type: "string" },
      since: { type: "string" },
      "by-file": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      agent: { type: "string" },
      port: { type: "string" },
      self: { type: "boolean" },
      stale: { type: "string" },
      all: { type: "boolean" },
      view: { type: "boolean" },
      watch: { type: "boolean" },
      notify: { type: "boolean" },
      interval: { type: "string" },
      until: { type: "string" },
      statusline: { type: "boolean" },
      herdr: { type: "boolean", default: true },
      remote: { type: "string" },
      "remote-port": { type: "string" },
      origin: { type: "string" },
      publish: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (o.help) {
    console.log(HELP);
    return;
  }
  const [command, given] = positionals;
  const arg = given ?? (o.self ? selfSession() : undefined);
  if (command === "install" || command === "uninstall") return void installCommand(command, o.agent, !!o.statusline);
  const days = o.days ? Number(o.days) : 30;
  const staleAfter = o.stale ? Date.now() - parseSince(o.stale) : undefined;
  if (command === "later" || command === "done" || command === "unhold") return void holdCommand(command, given, o.until);
  if (command === "remote") return void remoteCommand(given, positionals[2], o.origin);
  if (command === "cleanup") return void printCleanup(staleAfter);
  if (command === "inbox" && o.watch) {
    void watchInbox({ staleAfter, interval: (o.interval ? Number(o.interval) : 5) * 1000, notify: !!o.notify, ...(o.publish && { onChange: publisher() }) });
    return;
  }
  if (command === "inbox" && o.publish) {
    void publishInbox(loadInbox(staleAfter)).then(
      (url) => console.log(`Published: ${url}`),
      (e: Error) => {
        console.error(e.message);
        process.exitCode = 1;
      },
    );
    return;
  }
  if (command === "inbox" && !o.view) {
    const inbox = loadInbox(staleAfter);
    if (o.json) console.log(JSON.stringify(inbox, null, 2));
    else printInbox(inbox, !!o.all);
    return;
  }
  if (command === "view" || command === "inbox") {
    // The inbox spans every repository, so the page also works outside one (inbox only).
    let root: string | undefined;
    try {
      root = repoRoot(o.C ?? process.cwd());
    } catch (e) {
      if (command === "view") throw e;
    }
    const remote = o.remote ? { origin: o.remote, port: o["remote-port"] ? Number(o["remote-port"]) : 47301 } : undefined;
    void serve({ root, days, staleAfter, port: o.port ? Number(o.port) : 0, herdr: o.herdr, ...(remote && { remote }) }).then(
      (served) => {
        const query = o.since ? `&since=${encodeURIComponent(o.since)}` : o.base ? `&base=${encodeURIComponent(o.base)}` : "";
        console.log(`Agent Diff${root ? ` for ${root}` : ""}\n\n  ${served.url}${query}\n\nOpen it in a browser. Ctrl-C to stop.`);
        if (served.remote) {
          console.log(`\nRemote: ${served.remote.origin} (point the tunnel at http://127.0.0.1:${served.remote.port}).`);
          console.log(`Add a device with: agent-diff remote pair`);
        }
      },
      (e: Error) => {
        console.error(e.message);
        process.exitCode = 1;
      },
    );
    return;
  }
  const root = repoRoot(o.C ?? process.cwd());
  const loaded = load(root, { days, base: o.base, since: o.since ? parseSince(o.since) : undefined });
  const { transcripts, attributions } = loaded;

  if (o.json) {
    const sessions = Object.fromEntries([...transcripts.sessions].filter(([k]) => attributions.some((a) => a.hunks.some((h) => h.owner === k || h.others.includes(k)))));
    console.log(
      JSON.stringify(
        {
          root,
          files: attributions.map((a) => ({
            path: a.file.rel,
            status: a.file.status,
            hunks: a.hunks.map((h) => ({ header: h.hunk.header, owner: h.owner ?? null, confidence: h.confidence ?? null, matched: h.matched, others: h.others })),
            shell: a.shell,
          })),
          sessions,
        },
        null,
        2,
      ),
    );
    return;
  }

  switch (command) {
    case undefined:
    case "status":
      if (o["by-file"]) printByFile(transcripts, attributions);
      else printBySession(transcripts, attributions);
      return;
    case "show":
      if (!arg) throw new Error("Usage: agent-diff show <session|--self>");
      show(transcripts, attributions, findSession(transcripts, arg));
      return;
    case "add":
      if (!arg) throw new Error("Usage: agent-diff add <session|--self>");
      add(loaded, findSession(transcripts, arg), !!o["dry-run"]);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run agent-diff --help.`);
  }
}

/**
 * `agent-diff hook --agent <claude|codex>`, run by the agents around every tool call. It reads the
 * call from stdin, records it, and stays silent and successful whatever happens.
 */
async function hook(): Promise<void> {
  const i = process.argv.indexOf("--agent");
  const agent = process.argv[i + 1] === "codex" ? "codex" : "claude";
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  try {
    const out = runHook(agent, stdin);
    if (out) process.stdout.write(out + "\n");
  } catch {
    // never block or fail a tool call
  }
}

if (process.argv[2] === "hook") {
  await hook();
} else if (process.argv[2] === "statusline") {
  let stdin = "";
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
  try {
    const line = statusLineFor(stdin);
    if (line) console.log(line);
  } catch {
    // a status line must never break the prompt
  }
} else {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

import { setTimeout as sleep } from "node:timers/promises";
import { cleanup } from "./cleanup.ts";
import { repoInfo } from "./git.ts";
import { applyHolds, hold, parseUntil, release, type HoldKind } from "./holds.ts";
import { readInbox, type Inbox, type InboxItem } from "./inbox.ts";
import { desktopNotify, label, newlyWaiting } from "./notify.ts";
import { prStatuses, refreshPr } from "./prs.ts";
import { publishSnapshot } from "./publish.ts";
import { ago, bold, cyan, dim, oneLine, pad, red, yellow } from "./term.ts";

/** `agent-diff inbox` and the commands around it, in the terminal. */

export function loadInbox(staleAfter?: number): Inbox {
  const inbox = readInbox({ staleAfter });
  applyHolds(inbox);
  return inbox;
}

function where(item: InboxItem): string {
  return (item.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
}

/** Short facts about a session: task progress, background commands, pull requests, context. */
export function badges(i: InboxItem): string[] {
  const out: string[] = [];
  if (i.tasks?.length) out.push(`${i.tasks.filter((t) => t.status === "completed").length}/${i.tasks.length} tasks`);
  if (i.background?.length) out.push(`${i.background.length} in background`);
  if (i.prs?.length) out.push(i.prs.map((p) => `#${p.number}`).join(" "));
  const c = i.context;
  if (c?.tokens !== undefined && (c.window ? c.tokens > 0.8 * c.window : c.lastCompactTokens ? c.tokens > 0.9 * c.lastCompactTokens : false)) out.push("context nearly full");
  return out;
}

function row(i: InboxItem, now: number): string {
  const agent = i.agent === "claude" ? "Claude" : "Codex ";
  const extra = badges(i);
  return `  ${bold(agent)} ${cyan(pad(label(i, 32), 32))} ${dim(pad(where(i), 14))} ${ago(i.since, now).padStart(4)}${extra.length ? dim(`  ${extra.join(" · ")}`) : ""}`;
}

export function printInbox(inbox: Inbox, all: boolean): void {
  const now = inbox.generatedAt;
  const active = inbox.items.filter((i) => !i.hold);
  const of = (state: InboxItem["state"]) => active.filter((i) => i.state === state);
  const width = Math.max(40, (process.stdout.columns || 120) - 12);
  const answer = of("needs-answer");
  const turn = of("your-turn");
  if (answer.length) {
    console.log(bold(red(`Needs an answer (${answer.length})`)));
    for (const i of answer) {
      console.log(row(i, now));
      console.log(`        ${yellow(oneLine(i.reason ?? "input needed", width - 8))}`);
      for (const q of i.questions ?? []) console.log(`        ${oneLine(q.question, width - 8)}${q.options.length ? dim(`  [${q.options.join(" / ")}]`) : ""}`);
      console.log(dim(`        ${i.resume}`));
    }
    console.log("");
  }
  if (turn.length) {
    console.log(bold(`Your turn (${turn.length})`));
    for (const i of turn) {
      console.log(`${row(i, now)}${i.asks ? yellow("  asks") : ""}${i.reason ? yellow(`  ${i.reason}`) : ""}`);
      const line = i.awaySummary ?? i.lastMessage;
      if (line) console.log(`        ${oneLine(line, width - 8)}`);
      console.log(dim(`        ${i.resume}`));
    }
    console.log("");
  }
  if (!answer.length && !turn.length) console.log("Nothing waits on you.\n");
  const working = of("working");
  if (working.length) console.log(dim(`Working (${working.length}): ${working.map((i) => label(i, 30) + (i.reason ? ` (${i.reason})` : "")).join(", ")}`));
  const held = inbox.items.filter((i) => i.hold);
  if (held.length) {
    const what = (i: InboxItem) => (i.hold?.kind === "later" && i.hold.until ? `later, until ${new Date(i.hold.until).toLocaleString()}` : i.hold?.kind);
    console.log(dim(`On hold (${held.length}): ${held.map((i) => `${label(i, 30)} (${what(i)})`).join(", ")}`));
  }
  const stale = of("stale");
  const hours = Math.round(inbox.staleAfter / 36e5);
  const over = hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  if (stale.length && all) {
    console.log(bold(`\nIdle for over ${over} (${stale.length})`));
    for (const i of stale) {
      console.log(`${row(i, now)}${i.asks ? yellow("  asks") : ""}`);
      if (i.lastMessage) console.log(dim(`        ${oneLine(i.lastMessage, width - 8)}`));
    }
  } else if (stale.length) {
    const asking = stale.filter((i) => i.asks).length;
    console.log(dim(`Idle for over ${over} (${stale.length}${asking ? `, ${asking} ending with a question` : ""}): ${stale.map((i) => label(i, 30)).join(", ")}  (--all to list)`));
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** `agent-diff cleanup`: idle sessions and worktrees nobody uses, with the commands to close or remove them. */
export function printCleanup(staleAfter?: number): void {
  const inbox = loadInbox(staleAfter);
  const projects = new Set<string>();
  for (const i of inbox.items) {
    try {
      if (i.cwd) projects.add(repoInfo(i.cwd).project);
    } catch {
      // not in a repository
    }
  }
  try {
    projects.add(repoInfo(process.cwd()).project);
  } catch {
    // run outside a repository
  }
  const c = cleanup(inbox, projects);
  const total = c.sessions.reduce((n, s) => n + (s.memory ?? 0), 0);
  console.log(bold(`Idle sessions (${c.sessions.length}${total ? `, ${mb(total)} in all` : ""})`));
  if (!c.sessions.length) console.log(dim("  none"));
  for (const s of c.sessions) {
    console.log(`  ${pad(label(s, 36), 36)} ${dim(pad((s.cwd ?? "").split("/").pop() ?? "", 14))} idle ${ago(s.idleSince).padStart(4)}${s.memory ? dim(`  ${mb(s.memory)}`) : ""}`);
    console.log(dim(`      ${s.close ? `close: ${s.close}   ` : ""}resume later: ${s.resume}`));
  }
  const removable = c.worktrees.filter((w) => w.removable);
  const kept = c.worktrees.filter((w) => !w.removable);
  console.log(bold(`\nWorktrees that can go (${removable.length})`));
  if (!removable.length) console.log(dim("  none"));
  for (const w of removable) {
    const why = w.prunable ? "its folder is gone" : w.merged ? "merged" : "its remote branch was deleted";
    console.log(`  ${w.path}${w.branch ? dim(` (${w.branch})`) : ""}  ${dim(why)}`);
    for (const cmd of w.commands) console.log(`      ${cmd}`);
  }
  if (kept.length) {
    console.log(dim(`\nKept (${kept.length}): ${kept.map((w) => `${w.path.split("/").pop()} (${w.sessions.length ? "in use" : w.dirty ? "uncommitted changes" : w.locked ? "locked" : "not merged"})`).join(", ")}`));
  }
  console.log(dim("\nNothing was closed or removed; run the commands you want."));
}

/** The inbox item a session argument names: an id prefix, optionally after "claude:" or "codex:". */
export function findItem(inbox: Inbox, arg: string): InboxItem {
  const [agent, prefix] = arg.includes(":") ? (arg.split(":", 2) as [string, string]) : [undefined, arg];
  const hits = inbox.items.filter((i) => (!agent || i.agent === agent) && (i.id.startsWith(prefix) || i.jobId === prefix));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new Error(`No running session matches "${arg}". agent-diff inbox --all lists them.`);
  throw new Error(`"${arg}" matches ${hits.length} sessions: ${hits.map((h) => h.id.slice(0, 12)).join(", ")}. Give more of the id.`);
}

export function holdCommand(kind: HoldKind | "unhold", arg: string | undefined, until: string | undefined): void {
  if (!arg) throw new Error(`Usage: agent-diff ${kind} <session>${kind === "later" ? " [--until 2h|tomorrow|9:00]" : ""}`);
  const item = findItem(loadInbox(), arg);
  if (kind === "unhold") {
    console.log(release(item.key) ? `${label(item)} waits again.` : `${label(item)} was not on hold.`);
    return;
  }
  const end = kind === "later" ? parseUntil(until ?? "1h") : undefined;
  hold(item, kind, end);
  console.log(kind === "later" ? `${label(item)}: later, until ${new Date(end!).toLocaleString()} (or until it does something new).` : `${label(item)}: done, until it does something new.`);
}

/** Publishes a snapshot of the inbox (pull request states looked up first); returns its URL. */
export async function publishInbox(inbox: Inbox): Promise<string> {
  const urls = inbox.items.filter((i) => i.state !== "stale" && !i.hold).flatMap((i) => (i.prs ?? []).map((p) => p.url));
  await Promise.all(urls.map((u) => refreshPr(u)));
  return (await publishSnapshot(inbox, { prStatus: prStatuses(urls) })).url;
}

/** Publishes on every change, but at most once per `gap` ms: changes in between go out together. */
export function publisher(gap = 30_000): (inbox: Inbox) => void {
  let lastAt = 0;
  let pending: Inbox | undefined;
  let timer: NodeJS.Timeout | undefined;
  const run = async (inbox: Inbox) => {
    lastAt = Date.now();
    try {
      console.log(dim(`${new Date().toLocaleTimeString()}  published ${await publishInbox(inbox)}`));
    } catch (e) {
      console.error(`publish failed: ${(e as Error).message}`);
    }
  };
  return (inbox) => {
    const wait = lastAt + gap - Date.now();
    if (wait <= 0) return void run(inbox);
    pending = inbox;
    timer ??= setTimeout(() => {
      timer = undefined;
      const p = pending;
      pending = undefined;
      if (p) void run(p);
    }, wait);
  };
}

/** Watches the inbox and reports sessions that start waiting on you; with `notify`, on the desktop too. */
export async function watchInbox(opts: { staleAfter?: number; interval: number; notify: boolean; onChange?: (inbox: Inbox) => Promise<void> | void }): Promise<void> {
  let prev: Inbox | undefined;
  for (;;) {
    const inbox = loadInbox(opts.staleAfter);
    const alerts = newlyWaiting(prev, inbox);
    if (!prev) {
      const waiting = inbox.items.filter((i) => !i.hold && (i.state === "needs-answer" || i.state === "your-turn")).length;
      console.log(dim(`${new Date().toLocaleTimeString()}  watching ${inbox.items.length} sessions; ${waiting} wait on you now`));
    }
    for (const a of alerts) {
      console.log(`${new Date().toLocaleTimeString()}  ${bold(a.title)}  ${dim(a.body)}`);
      if (opts.notify) desktopNotify(a);
    }
    if (opts.onChange && (!prev || alerts.length || changed(prev, inbox))) await opts.onChange(inbox);
    prev = inbox;
    await sleep(opts.interval);
  }
}

/** Whether anything shown changed: states, holds or what sessions wait for. */
function changed(a: Inbox, b: Inbox): boolean {
  const sig = (x: Inbox) => JSON.stringify(x.items.map((i) => [i.key, i.state, i.since, i.reason, i.hold?.kind]));
  return sig(a) !== sig(b);
}

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "./holds.ts";
import type { Inbox, InboxState } from "./inbox.ts";
import type { PrStatus } from "./prs.ts";

/**
 * What happened while you were not looking, across every session: one looked at the inbox
 * against the look before, kept in a log the page shows as a timeline (and push notifications
 * come from). Only changes count: the first look after the page starts sets the baseline.
 */

export type ActivityKind = "started" | "ended" | "needs-answer" | "your-turn" | "pr" | "ci-failed" | "ci-passed" | "page";

export interface ActivityEvent {
  at: number;
  /** The session ("claude:<id>"). */
  key: string;
  /** Its title or name then. */
  name: string;
  /** Its folder's name. */
  project?: string;
  kind: ActivityKind;
  text?: string;
  url?: string;
  /** Put off with Later or Done when it happened. */
  held?: true;
}

interface Seen {
  state: InboxState;
  since: number;
  prs: Set<string>;
  pages: Set<string>;
}

export interface Snapshot {
  sessions: Map<string, Seen & { name: string; project: string }>;
  /** Each pull request's CI as last seen. */
  ci: Map<string, string>;
}

const lastLine = (t: string | undefined) => (t ?? "").trim().split("\n").filter((l) => l.trim()).pop();
const ciOf = (s: PrStatus | undefined) => (s && s.state === "OPEN" ? s.ci : s ? s.state.toLowerCase() : undefined);

export function snapshot(inbox: Inbox, prStatus: Record<string, PrStatus>): Snapshot {
  const sessions: Snapshot["sessions"] = new Map();
  const ci = new Map<string, string>();
  for (const i of inbox.items) {
    sessions.set(i.key, { state: i.state, since: i.since, name: i.title || i.name, project: basename(i.cwd ?? ""), prs: new Set((i.prs ?? []).map((p) => p.url)), pages: new Set((i.pages ?? []).map((p) => p.url)) });
    for (const p of i.prs ?? []) {
      const c = ciOf(prStatus[p.url]);
      if (c) ci.set(p.url, c);
    }
  }
  return { sessions, ci };
}

/** The changes from one look to the next. */
export function changes(prev: Snapshot | undefined, inbox: Inbox, prStatus: Record<string, PrStatus>, now = Date.now()): ActivityEvent[] {
  if (!prev) return [];
  const out: ActivityEvent[] = [];
  for (const i of inbox.items) {
    const base = { at: now, key: i.key, name: i.title || i.name, ...(i.cwd && { project: basename(i.cwd) }), ...(i.hold && { held: true as const }) };
    const was = prev.sessions.get(i.key);
    if (!was) out.push({ ...base, kind: "started", ...(i.lastPrompt && { text: i.lastPrompt }) });
    const moved = !was || was.state !== i.state || (i.state === "needs-answer" && was.since !== i.since);
    if (moved && i.state === "needs-answer") out.push({ ...base, kind: "needs-answer", text: i.questions?.[0]?.question || i.reason || "input needed" });
    if (moved && i.state === "your-turn" && was) out.push({ ...base, kind: "your-turn", ...(lastLine(i.awaySummary || i.lastMessage) && { text: lastLine(i.awaySummary || i.lastMessage) }) });
    for (const p of i.prs ?? []) {
      if (was && !was.prs.has(p.url)) out.push({ ...base, kind: "pr", text: `#${p.number}`, url: p.url });
      const before = prev.ci.get(p.url);
      const after = ciOf(prStatus[p.url]);
      // Only a change seen happen: the first status looked up after the start is not news.
      if (before && after && before !== after && (after === "failing" || (after === "passing" && before !== "passing"))) {
        out.push({ ...base, kind: after === "failing" ? "ci-failed" : "ci-passed", text: `#${p.number}${prStatus[p.url]?.title ? ` ${prStatus[p.url]!.title}` : ""}`, url: p.url });
      }
    }
    for (const p of i.pages ?? []) if (was && !was.pages.has(p.url)) out.push({ ...base, kind: "page", ...(p.title && { text: p.title }), url: p.url });
  }
  const now_ = new Set(inbox.items.map((i) => i.key));
  for (const [key, s] of prev.sessions) if (!now_.has(key)) out.push({ at: now, key, name: s.name, ...(s.project && { project: s.project }), kind: "ended" });
  return out;
}

const file = () => join(stateDir(), "activity.jsonl");
const KEEP = 2000;

export function appendActivity(events: ActivityEvent[]): void {
  if (!events.length) return;
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  appendFileSync(file(), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  try {
    if (statSync(file()).size > 2 * 1024 * 1024) writeFileSync(file(), readFileSync(file(), "utf8").trim().split("\n").slice(-KEEP).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // trimmed next time
  }
}

/** The latest events, newest first. */
export function readActivity(limit = 200): ActivityEvent[] {
  let text = "";
  try {
    text = readFileSync(file(), "utf8");
  } catch {
    return [];
  }
  const out: ActivityEvent[] = [];
  for (const line of text.split("\n").slice(-limit - 1)) {
    try {
      if (line) out.push(JSON.parse(line) as ActivityEvent);
    } catch {
      // a torn line
    }
  }
  return out.slice(-limit).reverse();
}

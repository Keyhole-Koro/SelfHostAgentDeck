import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoInfo } from "./git.ts";
import { stateDir } from "./holds.ts";
import type { Inbox, InboxItem } from "./inbox.ts";
import { label } from "./notify.ts";
import type { PrStatus } from "./prs.ts";
import { env } from "./env.ts";

/**
 * A snapshot of the inbox as a small static page, published with SelfHostArtifacts' `artifact`
 * CLI to your own deployment, so you can check from your phone what waits on you. The page is
 * private (only you and the viewers you allow can open it), reloads itself every minute, and
 * publishing again updates the same URL.
 */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 6e4));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 60 * 48 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

const STATE = { "needs-answer": "Needs an answer", "your-turn": "Your turn", working: "Working", stale: "Idle" } as const;
const ORDER = { "needs-answer": 0, "your-turn": 1, working: 2, stale: 3 } as const;

function projectOf(cwd: string | undefined, cache: Map<string, string>): string {
  if (!cwd) return "(no folder)";
  if (!cache.has(cwd)) {
    let p = cwd;
    try {
      p = repoInfo(cwd).project;
    } catch {
      // not a repository: the folder itself
    }
    cache.set(cwd, p);
  }
  return cache.get(cwd)!.split("/").filter(Boolean).pop() ?? cwd;
}

function prLine(i: InboxItem, statuses: Record<string, PrStatus>): string {
  return (i.prs ?? [])
    .map((p) => {
      const s = statuses[p.url];
      const what = !s ? "" : s.state !== "OPEN" ? s.state.toLowerCase() : s.ci === "none" ? "open" : `CI ${s.ci}`;
      return `<a href="${esc(p.url)}">#${esc(p.number)}</a>${what ? ` <span class="pr ${esc(s?.ci)}">${esc(what)}</span>` : ""}`;
    })
    .join(" ");
}

function card(i: InboxItem, now: number, statuses: Record<string, PrStatus>): string {
  const done = i.tasks?.filter((t) => t.status === "completed").length ?? 0;
  const facts = [
    i.agent === "codex" ? "Codex" : "Claude",
    ago(i.since, now),
    i.tasks?.length ? `${done}/${i.tasks.length} tasks` : "",
    i.background?.length ? `${i.background.length} in background` : "",
  ].filter(Boolean);
  let html = `<article class="${i.state}"><div class="top"><span class="pill ${i.state}">${STATE[i.state]}</span><h3>${esc(label(i, 60))}</h3></div>`;
  html += `<div class="facts">${facts.map(esc).join(" · ")}${i.prs?.length ? ` · ${prLine(i, statuses)}` : ""}</div>`;
  if (i.state === "needs-answer") {
    html += `<p class="reason">${esc(i.reason ?? "input needed")}</p>`;
    for (const q of i.questions ?? []) html += `<p class="q">${esc(q.question)}${q.options.length ? `<br><span class="opts">${q.options.map(esc).join(" · ")}</span>` : ""}</p>`;
  } else if (i.reason) html += `<p class="muted">${esc(i.reason)}</p>`;
  const text = i.awaySummary ?? i.lastMessage;
  if (text && i.state !== "working") html += `<p class="reply">${esc(text.length > 600 ? "…" + text.slice(-600) : text)}</p>`;
  if (i.lastPrompt && i.state !== "stale") html += `<p class="muted">You asked: ${esc(i.lastPrompt.length > 160 ? i.lastPrompt.slice(0, 159) + "…" : i.lastPrompt)}</p>`;
  html += `<code>${esc(i.resume)}</code></article>`;
  return html;
}

export function snapshotHtml(inbox: Inbox, opts: { prStatus?: Record<string, PrStatus>; now?: number } = {}): string {
  const now = opts.now ?? inbox.generatedAt;
  const statuses = opts.prStatus ?? {};
  const cache = new Map<string, string>();
  const active = inbox.items.filter((i) => !i.hold);
  const groups = new Map<string, InboxItem[]>();
  for (const i of active) {
    const p = projectOf(i.cwd, cache);
    (groups.get(p) ?? groups.set(p, []).get(p)!).push(i);
  }
  const best = (list: InboxItem[]) => Math.min(...list.map((i) => ORDER[i.state]));
  const recent = (list: InboxItem[]) => Math.max(...list.map((i) => i.since));
  const projects = [...groups].sort(([, a], [, b]) => best(a) - best(b) || recent(b) - recent(a));
  const count = (s: InboxItem["state"]) => active.filter((i) => i.state === s).length;
  let body = "";
  for (const [name, list] of projects) {
    list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.since - a.since);
    const live = list.filter((i) => i.state !== "stale");
    const stale = list.filter((i) => i.state === "stale");
    body += `<section><h2>${esc(name)}</h2>${live.map((i) => card(i, now, statuses)).join("")}`;
    if (stale.length) body += `<details><summary>${stale.length} idle</summary>${stale.map((i) => card(i, now, statuses)).join("")}</details>`;
    body += `</section>`;
  }
  const held = inbox.items.filter((i) => i.hold);
  if (held.length) body += `<p class="muted">On hold: ${held.map((i) => esc(label(i, 40))).join(", ")}</p>`;
  if (!active.length) body += `<p class="muted">No sessions are running.</p>`;
  const summary = [count("needs-answer") && `${count("needs-answer")} need an answer`, count("your-turn") && `${count("your-turn")} your turn`, count("working") && `${count("working")} working`].filter(Boolean).join(" · ") || "Nothing waits on you";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="60">
<title>Agent inbox</title>
<style>
:root { --bg: #fbfaf8; --panel: #fff; --text: #1f1d1a; --muted: #6f6a62; --line: #e6e2db; --accent: #3b5bdb; --accent-soft: #edf1ff; --urgent: #b42318; --urgent-soft: #fdeceb; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1918; --panel: #222120; --text: #ebe8e3; --muted: #9c968c; --line: #35332f; --accent: #8ea6ff; --accent-soft: #283152; --urgent: #ff9b8f; --urgent-soft: #3d2220; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 760px; margin-inline: auto; }
header h1 { margin: 0; font-size: 18px; } header p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 24px 0 8px; }
article { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; overflow-wrap: anywhere; }
article.needs-answer { border-color: var(--urgent); box-shadow: inset 3px 0 0 var(--urgent); }
.top { display: flex; gap: 8px; align-items: baseline; } h3 { margin: 0; font-size: 15px; }
.pill { flex: none; font-size: 11px; font-weight: 600; border-radius: 9px; padding: 0 7px; background: var(--line); color: var(--muted); }
.pill.needs-answer { background: var(--urgent-soft); color: var(--urgent); } .pill.your-turn { background: var(--accent-soft); color: var(--accent); }
.facts, .muted { color: var(--muted); font-size: 13px; } p { margin: 8px 0 0; }
.reason { color: var(--urgent); font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.opts { color: var(--muted); font-size: 13px; }
.reply { white-space: pre-wrap; font-size: 14px; border-left: 2px solid var(--line); padding-left: 10px; }
code { display: block; margin-top: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
a { color: var(--accent); } .pr.failing { color: var(--urgent); }
details summary { color: var(--muted); font-size: 13px; cursor: pointer; margin: 4px 0 8px; }
</style>
</head>
<body>
<header><h1>Agent inbox</h1><p>${esc(summary)} · as of ${esc(new Date(now).toLocaleString())}</p></header>
${body}
</body>
</html>
`;
}

function artifact(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(env("ARTIFACT") || "artifact", args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

/** Writes the snapshot and publishes it; the same file always goes to the same URL. */
export async function publishSnapshot(inbox: Inbox, opts: { prStatus?: Record<string, PrStatus> } = {}): Promise<{ url: string; created: boolean; file: string }> {
  const dir = join(stateDir(), "snapshot");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent-inbox.html");
  writeFileSync(file, snapshotHtml(inbox, opts));
  const out = await artifact(["publish", file, "--title", "Agent inbox", "--description", "The coding-agent sessions waiting on you, from agent-deck", "--json"]);
  let r: { url?: string; created?: boolean } = {};
  try {
    r = JSON.parse(out) as typeof r;
  } catch {
    r = { url: /https?:\/\/\S+/.exec(out)?.[0] };
  }
  if (!r.url) throw new Error(`artifact publish printed no URL: ${out.trim().slice(0, 200)}`);
  return { url: r.url, created: r.created === true, file };
}

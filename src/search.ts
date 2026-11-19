import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { textMessages } from "./conversation.ts";
import { claudeHome, codexHome } from "./inbox.ts";
import type { Agent } from "./types.ts";
import { sessionKey } from "./types.ts";

/**
 * Searching what you and the agents said, across every session of the last weeks: running or
 * long closed. The transcripts are mostly tool output and images (gigabytes); their text is a few
 * megabytes, kept in memory and read on from where each file was last read, so a search after the
 * first one is quick.
 */

export interface SearchHit {
  /** The message's id in the conversation (its line's byte offset), to scroll to it. */
  id: string;
  at?: number;
  role: "user" | "assistant";
  /** The text around the match. */
  snippet: string;
}

export interface SearchResult {
  key: string;
  agent: Agent;
  id: string;
  title?: string;
  cwd?: string;
  /** When it last said something. */
  at?: number;
  resume: string;
  hits: SearchHit[];
}

interface Indexed {
  agent: Agent;
  id: string;
  size: number;
  end: number;
  title?: string;
  cwd?: string;
  messages: { id: string; at?: number; role: "user" | "assistant"; text: string; lower: string }[];
}

const DAYS = 30;
const MAX_RESULTS = 40;
const HITS_EACH = 3;
const index = new Map<string, Indexed>();

/** Transcripts written to in the last DAYS days. */
function transcripts(now: number): { file: string; agent: Agent; id: string }[] {
  const since = now - DAYS * 864e5;
  const out: { file: string; agent: Agent; id: string }[] = [];
  const recent = (f: string) => {
    try {
      return statSync(f).mtimeMs >= since;
    } catch {
      return false;
    }
  };
  const projects = join(claudeHome(), "projects");
  for (const dir of safeList(projects)) {
    for (const f of safeList(join(projects, dir))) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(projects, dir, f);
      if (recent(file)) out.push({ file, agent: "claude", id: f.slice(0, -".jsonl".length) });
    }
  }
  // ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl
  const walk = (dir: string, depth: number) => {
    for (const f of safeList(dir)) {
      const p = join(dir, f);
      if (depth < 3) walk(p, depth + 1);
      else if (f.startsWith("rollout-") && f.endsWith(".jsonl") && recent(p)) out.push({ file: p, agent: "codex", id: f.slice(-".jsonl".length - 36, -".jsonl".length) });
    }
  };
  walk(join(codexHome(), "sessions"), 0);
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

let reading: Promise<void> | undefined;

/** Reads the transcripts ahead of the first search (which would wait for it otherwise). */
export const warmSearch = (): Promise<void> => refresh(Date.now());

/** Reads what each transcript added since the last look; one look at a time. */
function refresh(now: number): Promise<void> {
  reading ??= read(now).finally(() => (reading = undefined));
  return reading;
}

async function read(now: number): Promise<void> {
  const live = new Set<string>();
  for (const t of transcripts(now)) {
    // The first look reads gigabytes: let the server answer other requests in between.
    await new Promise((r) => setImmediate(r));
    live.add(t.file);
    let size: number;
    try {
      size = statSync(t.file).size;
    } catch {
      continue;
    }
    let e = index.get(t.file);
    if (e && e.size === size) continue;
    if (!e || size < e.end) {
      e = { agent: t.agent, id: t.id, size: 0, end: 0, messages: [] };
      index.set(t.file, e);
    }
    try {
      const scan = textMessages(t.file, t.agent, e.end);
      e.end = scan.end;
      e.size = size;
      if (scan.title) e.title = scan.title;
      if (scan.cwd && !e.cwd) e.cwd = scan.cwd;
      for (const m of scan.messages) e.messages.push({ id: m.id, ...(m.at && { at: m.at }), role: m.role as "user" | "assistant", text: m.text!, lower: m.text!.toLowerCase() });
    } catch {
      // gone meanwhile
    }
  }
  for (const f of index.keys()) if (!live.has(f)) index.delete(f);
}

/** The text around the first word's match, on one line. */
function snippet(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 70);
  const to = Math.min(text.length, at + length + 110);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

/** Sessions whose messages hold every word of the query (any case), the latest first. */
export async function search(query: string, now = Date.now()): Promise<SearchResult[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  await refresh(now);
  const results: SearchResult[] = [];
  for (const e of index.values()) {
    const hits: SearchHit[] = [];
    let last: number | undefined;
    for (let n = e.messages.length - 1; n >= 0; n--) {
      const m = e.messages[n]!;
      if (!words.every((w) => m.lower.includes(w))) continue;
      last ??= m.at;
      if (hits.length < HITS_EACH) hits.push({ id: m.id, ...(m.at && { at: m.at }), role: m.role, snippet: snippet(m.text, m.lower.indexOf(words[0]!), words[0]!.length) });
    }
    if (!hits.length) continue;
    const firstPrompt = e.messages.find((m) => m.role === "user")?.text;
    const title = e.title || (firstPrompt ? firstPrompt.replace(/\s+/g, " ").slice(0, 80) : undefined);
    const resume = e.agent === "codex" ? `codex resume ${e.id}` : `claude --resume ${e.id}`;
    results.push({
      key: sessionKey(e.agent, e.id),
      agent: e.agent,
      id: e.id,
      ...(title && { title }),
      ...(e.cwd && { cwd: e.cwd }),
      ...(last && { at: last }),
      resume: e.cwd ? `cd ${shellQuote(e.cwd)} && ${resume}` : resume,
      hits,
    });
  }
  return results.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_RESULTS);
}

const shellQuote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runningSessions } from "./inbox.ts";
import type { Agent } from "./types.ts";

/**
 * The hook recorder. Claude Code and Codex run `agent-deck hook --agent <a>` before and after
 * every tool call that can write files, with the call described as JSON on stdin.
 *
 * Before the call it stores the current content of the files the call may touch as git blobs
 * (`git hash-object -w`); after the call it stores them again and appends one record to
 * .git/agent-diff/log.jsonl: which session changed which file from which blob to which blob. (The
 * folder keeps the name the tool had before, so records written before the rename still count.)
 * Diffing those blobs later gives exactly what the call changed — shell commands included.
 *
 * Before Claude Code edits a file that another running session has uncommitted changes in, it
 * tells the agent so (once per new change of the other session), through the hook's
 * additionalContext. Otherwise it prints nothing.
 *
 * It must never get in the agent's way: it never blocks a call, ignores every error and exits 0.
 */

export interface HookRecord {
  v: 1;
  agent: Agent;
  session: string;
  transcript?: string;
  tool: string;
  call: string; // tool_use_id
  at: number; // ms, when the call finished
  changes: { path: string; before: string | null; after: string | null }[]; // path relative to the repo; null = file absent
  command?: string;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
}

/** Tools whose writes are confined to the file they name; anything else may write anywhere. */
const SINGLE_FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

export function recordDir(root: string): string {
  // The common dir, so every worktree of a repository shares one log.
  const common = git(root, ["rev-parse", "--git-common-dir"]).trim();
  return join(isAbsolute(common) ? common : join(root, common), "agent-diff");
}

/** The repository root and its record dir in one git call (the hook runs on every tool call). */
function locate(cwd: string): { root: string; dir: string } {
  const [root, common] = git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]).trim().split("\n") as [string, string];
  return { root, dir: join(isAbsolute(common) ? common : join(cwd, common), "agent-diff") };
}

/** Paths (relative to root) of files that differ from HEAD, untracked ones included. */
function dirtyPaths(root: string): string[] {
  const out: string[] = [];
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

/** Blob ids of the files' current contents (written to the object store), null if absent. */
function snapshot(root: string, paths: string[]): Record<string, string | null> {
  const present = paths.filter((p) => existsSync(join(root, p)));
  const ids = present.length ? git(root, ["hash-object", "-w", "--stdin-paths", "--no-filters"], present.join("\n") + "\n").trim().split("\n") : [];
  const snap: Record<string, string | null> = {};
  for (const p of paths) snap[p] = null;
  present.forEach((p, i) => (snap[p] = ids[i] ?? null));
  return snap;
}

/** The blob of `path` in HEAD, or null. */
function headBlob(root: string, path: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `HEAD:${path}`]).trim() || null;
  } catch {
    return null;
  }
}

function targetFile(input: HookInput, root: string, cwd: string): string | undefined {
  const raw = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
  if (typeof raw !== "string") return undefined;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}

/** When the file was last committed (ms), or 0. */
function committedAt(root: string, path: string): number {
  try {
    return Number(git(root, ["log", "-1", "--format=%ct", "--", path]).trim()) * 1000 || 0;
  } catch {
    return 0;
  }
}

/**
 * The note for a Claude session about to edit `rel` while other running sessions have uncommitted
 * changes in it, as the hook's JSON output; undefined when there is nothing (new) to say.
 */
function sharedFileWarning(root: string, dir: string, rel: string, me: string, current: string | null): string | undefined {
  if (current === headBlob(root, rel)) return undefined; // nothing uncommitted in it
  const since = committedAt(root, rel);
  const others = new Map<string, number>(); // session → its latest change of the file
  for (const r of readHookRecords(root, since, 2 * 1024 * 1024)) {
    if (r.session === me || !r.changes.some((c) => c.path === rel)) continue;
    const key = `${r.agent}:${r.session}`;
    others.set(key, Math.max(others.get(key) ?? 0, r.at));
  }
  if (!others.size) return undefined;
  const live = runningSessions();
  const active = [...others].filter(([k]) => live.has(k));
  if (!active.length) return undefined;
  const latest = Math.max(...active.map(([, at]) => at));
  const warnedFile = join(dir, "warned.json");
  let warned: Record<string, number> = {};
  try {
    warned = JSON.parse(readFileSync(warnedFile, "utf8")) as Record<string, number>;
  } catch {
    // first warning
  }
  const key = `${me}|${rel}`;
  if ((warned[key] ?? 0) >= latest) return undefined; // already told about these changes
  warned[key] = latest;
  writeFileSync(warnedFile, JSON.stringify(warned));
  const who = active.map(([k]) => `${live.get(k)} (${k.startsWith("codex:") ? "Codex" : "Claude"} ${k.split(":")[1]!.slice(0, 8)})`).join(", ");
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `agent-deck: ${rel} also has uncommitted changes from another running session: ${who}. Keep their edits intact, and when committing, stage only your own changes (agent-deck add --self).`,
    },
  });
}

/** Records the call; returns what the hook should print (only a note for Claude Code, if any). */
export function runHook(agent: Agent, stdin: string): string | undefined {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return;
  }
  const cwd = input.cwd ?? process.cwd();
  const event = input.hook_event_name;
  if (!input.session_id || !input.tool_name || (event !== "PreToolUse" && event !== "PostToolUse")) return;
  let root: string;
  let dir: string;
  try {
    ({ root, dir } = locate(cwd));
  } catch {
    return; // not in a git repository
  }
  const call = input.tool_use_id ?? `${input.session_id}-${input.tool_name}`;
  const pendingFile = join(dir, "pending", `${call.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const single = SINGLE_FILE_TOOLS.has(input.tool_name) ? targetFile(input, root, cwd) : undefined;

  if (event === "PreToolUse") {
    const paths = single ? [single] : dirtyPaths(root);
    const snap = snapshot(root, paths);
    mkdirSync(join(dir, "pending"), { recursive: true });
    writeFileSync(pendingFile, JSON.stringify(snap));
    if (single && agent === "claude") {
      try {
        return sharedFileWarning(root, dir, single, input.session_id, snap[single] ?? null);
      } catch {
        return undefined;
      }
    }
    return;
  }

  // PostToolUse: compare with the snapshot taken before the call.
  let before: Record<string, string | null> = {};
  try {
    before = JSON.parse(readFileSync(pendingFile, "utf8")) as Record<string, string | null>;
    rmSync(pendingFile, { force: true });
  } catch {
    // No "before" (the hook was installed mid-call): fall back to HEAD below.
  }
  const paths = single ? [single] : [...new Set([...Object.keys(before), ...dirtyPaths(root)])];
  const after = snapshot(root, paths);
  const changes: HookRecord["changes"] = [];
  for (const p of paths) {
    const b = p in before ? before[p]! : headBlob(root, p);
    const a = after[p] ?? null;
    if (b !== a) changes.push({ path: p, before: b, after: a });
  }
  if (changes.length === 0) return;

  const record: HookRecord = {
    v: 1,
    agent,
    session: input.session_id,
    transcript: input.transcript_path ?? undefined,
    tool: input.tool_name,
    call,
    at: Date.now(),
    changes,
  };
  const command = input.tool_input?.["command"];
  if (typeof command === "string") record.command = command.slice(0, 4000);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "log.jsonl"), JSON.stringify(record) + "\n");
}

/** The hook's records since a time; with `tailBytes`, only from the end of the log (for speed). */
export function readHookRecords(root: string, sinceMs = 0, tailBytes?: number): HookRecord[] {
  let text: string;
  try {
    const file = join(recordDir(root), "log.jsonl");
    if (tailBytes) {
      const size = statSync(file).size;
      const fd = openSync(file, "r");
      try {
        const len = Math.min(size, tailBytes);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        text = buf.toString("utf8");
        if (len < size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      } finally {
        closeSync(fd);
      }
    } else text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: HookRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HookRecord;
      if (r.v === 1 && r.at >= sinceMs) out.push(r);
    } catch {
      // a torn line from a crash; skip it
    }
  }
  return out;
}

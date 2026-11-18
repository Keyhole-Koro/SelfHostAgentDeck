import { execFileSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { readHookRecords } from "./hook.ts";
import { editedFiles, type InboxItem } from "./inbox.ts";

/**
 * Files that two or more open sessions changed in the same working tree and that are still
 * uncommitted. Their edits interleave there: one session's `git add` or `git checkout` takes the
 * other's work with it, and each sees the other's half-done changes as its own.
 *
 * Cheap enough to run on every look at the inbox: it uses what the inbox already read (the files
 * each session wrote with its edit tools), the hook's records (shell edits too), and `git status`;
 * not the full attribution, which reads every transcript of the last month.
 */

export interface Conflict {
  /** Path relative to the working tree. */
  path: string;
  /** The other sessions with changes in the file. */
  with: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

const dirtyCache = new Map<string, { at: number; paths: Set<string> }>();

/** Paths (relative to the root) that differ from HEAD, untracked ones included (cached a few seconds). */
function dirty(root: string): Set<string> {
  const hit = dirtyCache.get(root);
  if (hit && Date.now() - hit.at < 8000) return hit.paths;
  const out = new Set<string>();
  dirtyCache.set(root, { at: Date.now(), paths: out });
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    out.add(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

function committedAt(root: string, path: string): number {
  try {
    return Number(git(root, ["log", "-1", "--format=%ct", "--", path]).trim()) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** For each listed session, the uncommitted files it shares with another listed session. */
export function findConflicts(items: InboxItem[], repoOf: (i: InboxItem) => string | null): Record<string, Conflict[]> {
  const byRepo = new Map<string, InboxItem[]>();
  for (const i of items) {
    const repo = repoOf(i);
    if (repo) (byRepo.get(repo) ?? byRepo.set(repo, []).get(repo)!).push(i);
  }
  const out: Record<string, Conflict[]> = {};
  for (const [repo, list] of byRepo) {
    if (list.length < 2) continue;
    let changed: Set<string>;
    try {
      changed = dirty(repo);
    } catch {
      continue;
    }
    if (!changed.size) continue;
    const keys = new Set(list.map((i) => i.key));
    const touched = new Map<string, Map<string, number>>(); // path → session → its latest write
    const note = (path: string, key: string, at: number) => {
      if (!changed.has(path)) return;
      const who = touched.get(path) ?? touched.set(path, new Map()).get(path)!;
      who.set(key, Math.max(who.get(key) ?? 0, at));
    };
    for (const i of list) {
      for (const [abs, at] of editedFiles(i)) {
        const rel = relative(repo, abs);
        if (!rel.startsWith("..") && !isAbsolute(rel)) note(rel, i.key, at);
      }
    }
    for (const r of readHookRecords(repo, 0, 2 * 1024 * 1024)) {
      const key = `${r.agent}:${r.session}`;
      if (keys.has(key)) for (const c of r.changes) note(c.path, key, r.at);
    }
    for (const [path, who] of touched) {
      if (who.size < 2) continue;
      const since = committedAt(repo, path);
      const after = [...who].filter(([, at]) => at > since).map(([k]) => k); // changes not yet committed
      if (after.length < 2) continue;
      for (const k of after) (out[k] ??= []).push({ path, with: after.filter((o) => o !== k) });
    }
  }
  return out;
}

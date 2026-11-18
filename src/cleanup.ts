import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import type { Inbox, InboxItem } from "./inbox.ts";

/**
 * What can be tidied up: sessions left idle (with the memory their process holds) and worktrees
 * nobody works in any more. Nothing is closed or deleted here; each entry says the command that
 * would do it, for you to run.
 */

export interface IdleSession {
  key: string;
  agent: InboxItem["agent"];
  name: string;
  title?: string;
  cwd?: string;
  idleSince: number;
  memory?: number;
  /** How to close it (empty when it can only be closed where it runs). */
  close: string;
  /** How to come back to it later. */
  resume: string;
}

export interface Worktree {
  path: string;
  /** The repository's main checkout. */
  project: string;
  branch?: string;
  /** Uncommitted changes in it. */
  dirty: boolean;
  /** Its branch is in the default branch. */
  merged: boolean;
  /** Its branch's upstream was deleted (usually: the pull request was merged and the branch removed). */
  gone: boolean;
  /** The directory no longer exists. */
  prunable: boolean;
  locked: boolean;
  /** Listed sessions working in it. */
  sessions: string[];
  removable: boolean;
  commands: string[];
}

export interface Cleanup {
  sessions: IdleSession[];
  worktrees: Worktree[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

const quote = (s: string) => (/^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function closeCommand(i: InboxItem): string {
  if (i.jobId) return `claude stop ${i.jobId}`;
  if (i.agent === "claude" && i.pid) return `kill ${i.pid}`;
  return ""; // a Codex thread closes in its own window
}

export function idleSessions(inbox: Inbox): IdleSession[] {
  return inbox.items
    .filter((i) => i.state === "stale")
    .sort((a, b) => a.since - b.since)
    .map((i) => {
      const s: IdleSession = { key: i.key, agent: i.agent, name: i.name, idleSince: i.since, close: closeCommand(i), resume: i.resume };
      if (i.title) s.title = i.title;
      if (i.cwd) s.cwd = i.cwd;
      if (i.memory) s.memory = i.memory;
      return s;
    });
}

function defaultBranch(project: string): string | undefined {
  try {
    return git(project, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    for (const b of ["main", "master"]) if (gitOk(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
    return undefined;
  }
}

/** The linked worktrees of a repository (its main checkout left out), and whether each can go. */
export function worktrees(project: string, items: { key: string; cwd?: string | undefined }[] = []): Worktree[] {
  let text: string;
  try {
    text = git(project, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const base = defaultBranch(project);
  const blocks = text.trim().split(/\n\n+/).slice(1); // the first is the main checkout
  const out: Worktree[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const field = (k: string) => lines.find((l) => l === k || l.startsWith(k + " "))?.slice(k.length + 1);
    const path = field("worktree");
    if (!path) continue;
    const branch = field("branch")?.replace(/^refs\/heads\//, "");
    const prunable = lines.some((l) => l.startsWith("prunable")) || !existsSync(path);
    const locked = lines.some((l) => l.startsWith("locked"));
    const dirty = !prunable && (() => {
      try {
        return git(path, ["status", "--porcelain"]).trim() !== "";
      } catch {
        return false;
      }
    })();
    const merged = !!branch && !!base && gitOk(project, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]);
    let gone = false;
    if (branch) {
      try {
        gone = git(project, ["for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`]).includes("[gone]");
      } catch {
        // no upstream
      }
    }
    const sessions = items.filter((i) => i.cwd && (i.cwd === path || i.cwd.startsWith(path + sep))).map((i) => i.key);
    const removable = !sessions.length && !locked && (prunable || (!dirty && (merged || gone)));
    const commands: string[] = [];
    if (prunable) commands.push(`git -C ${quote(project)} worktree prune`);
    else if (removable) {
      commands.push(`git -C ${quote(project)} worktree remove ${quote(path)}`);
      // A squash-merged branch is not "merged" to git, so deleting it needs -D.
      if (branch) commands.push(`git -C ${quote(project)} branch ${merged ? "-d" : "-D"} ${quote(branch)}`);
    }
    const w: Worktree = { path, project, dirty, merged, gone, prunable, locked, sessions, removable, commands };
    if (branch) w.branch = branch;
    out.push(w);
  }
  return out;
}

export function cleanup(inbox: Inbox, projects: Iterable<string>): Cleanup {
  const items = inbox.items.map((i) => ({ key: i.key, cwd: i.cwd }));
  return { sessions: idleSessions(inbox), worktrees: [...new Set(projects)].flatMap((p) => worktrees(p, items)) };
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * Files sent from the page (a photo from the phone, a log, a spec) for a session to read. They go
 * into `.agent-deck/uploads/` in the session's repository, so the agent reads them without leaving
 * its folder (no permission prompt for a path elsewhere); the folder's own `.gitignore` keeps git
 * from ever seeing them.
 */

export const MAX_UPLOAD = 25 * 1024 * 1024;

export interface Upload {
  /** Absolute path, for the prompt. */
  path: string;
  /** Path inside the repository. */
  rel: string;
  size: number;
}

/** A file name safe to write: no folders, no odd characters, not too long. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).normalize("NFC");
  const clean = base.replace(/[^\p{L}\p{N}._ ()-]+/gu, "_").replace(/^\.+/, "").trim();
  return (clean || "file").slice(-100);
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export function saveUpload(root: string, name: string, data: Buffer, now = new Date()): Upload {
  const deck = join(root, ".agent-deck");
  const dir = join(deck, "uploads");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(deck, ".gitignore"))) writeFileSync(join(deck, ".gitignore"), "# Files sent to agent sessions from Agent Deck; never committed.\n*\n");
  let path = join(dir, `${stamp(now)}-${safeName(name)}`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stamp(now)}-${n}-${safeName(name)}`);
  writeFileSync(path, data, { flag: "wx" });
  return { path, rel: relative(root, path), size: data.length };
}

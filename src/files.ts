import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Read-only access to a session's files, for the page: inside the session's repository (its
 * folder when it is not in one), never above it, never git's own files, and never files that
 * commonly hold secrets. A signed-in device can already ask the agent to print any file; this
 * spares the round trip and stays narrow.
 */

/** A request the page should not have made, with the HTTP status that says so. */
export class FileError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface DirEntry {
  name: string;
  dir: boolean;
  size?: number;
}

export interface DirView {
  kind: "dir";
  /** The folder files are confined to. */
  root: string;
  /** Path inside the root ("" for the root itself). */
  rel: string;
  entries: DirEntry[];
  /** Entries left out of a long listing. */
  more: number;
}

export interface FileView {
  kind: "text" | "markdown" | "image" | "binary";
  root: string;
  rel: string;
  size: number;
  mtime: number;
  text?: string;
  /** Only the start of a long file is sent. */
  truncated?: boolean;
  /** Images: the media type to fetch it as. */
  type?: string;
}

const MAX_TEXT = 512 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_ENTRIES = 1000;

const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

/** Names of files that commonly hold secrets: never listed or shown. */
export function secret(name: string): boolean {
  const n = name.toLowerCase();
  if (/^\.env(rc)?(\..+)?$/.test(n)) return !/^\.env(rc)?\.(example|sample|template|dist|defaults)$/.test(n);
  return (
    /^\.dev\.vars(\..+)?$/.test(n) ||
    /\.(pem|key|p8|p12|pfx|ppk|jks|keystore|tfvars|tfvars\.json|tfstate|tfstate\.backup)$/.test(n) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) ||
    /^\.?(npmrc|pypirc|netrc|pgpass|htpasswd)$/.test(n) ||
    /^(\.git-credentials|\.terraformrc|terraform\.rc)$/.test(n) ||
    /^\.?credentials(\..+)?$/.test(n) ||
    /^service-account.*\.json$/.test(n) ||
    /^(client_secret.*|application_default_credentials|.*firebase-adminsdk.*)\.json$/.test(n) ||
    /^secrets?\.(json|ya?ml|toml)$/.test(n)
  );
}

/**
 * The folder a session's files are confined to: its repository, else its own folder. None for a
 * session in the home folder (or above it), which would open all of it.
 */
export function filesRoot(cwd: string | undefined, repo: string | null | undefined): string | undefined {
  const dir = repo || cwd;
  if (!dir) return undefined;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return undefined;
  }
  const home = realpathSync(homedir());
  if (real === sep || real === home || home.startsWith(real + sep)) return undefined;
  return real;
}

/** A path from the page (absolute, ~/…, or relative to the session's folder) inside the root. */
function locate(root: string, cwd: string, path: string): { real: string; rel: string } {
  const p = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const tries = isAbsolute(p) ? [p] : [resolve(cwd, p || "."), resolve(root, p || ".")];
  // "src/a.ts:42" names a line of src/a.ts.
  const at = /^(.*?):\d+(?::\d+)?$/.exec(p)?.[1];
  if (at) tries.push(...(isAbsolute(at) ? [at] : [resolve(cwd, at), resolve(root, at)]));
  const found = tries.find((t) => existsSync(t));
  if (!found) throw new FileError("No such file or folder.", 404);
  const real = realpathSync(found);
  if (real !== root && !real.startsWith(root + sep)) throw new FileError("Only files in the session's repository can be opened.", 403);
  const rel = relative(root, real);
  const parts = rel ? rel.split(sep) : [];
  if (parts.includes(".git")) throw new FileError("Not shown: git's own files.", 403);
  if (parts.some(secret)) throw new FileError("Not shown: it may hold secrets.", 403);
  return { real, rel };
}

/** A folder's entries, or a file's contents. */
export function look(root: string, cwd: string, path: string): DirView | FileView {
  const { real, rel } = locate(root, cwd, path);
  const st = statSync(real);
  if (st.isDirectory()) {
    const entries: DirEntry[] = [];
    for (const d of readdirSync(real, { withFileTypes: true })) {
      if (d.name === ".git" || secret(d.name)) continue;
      let dir = d.isDirectory();
      let size: number | undefined;
      if (!dir) {
        try {
          const s = statSync(join(real, d.name)); // follows links
          dir = s.isDirectory();
          if (!dir) size = s.size;
        } catch {
          continue; // a broken link
        }
      }
      entries.push({ name: d.name, dir, ...(size !== undefined && { size }) });
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { kind: "dir", root, rel, entries: entries.slice(0, MAX_ENTRIES), more: Math.max(0, entries.length - MAX_ENTRIES) };
  }
  if (!st.isFile()) throw new FileError("Not a regular file.", 400);
  const ext = extname(real).toLowerCase();
  const base = { root, rel, size: st.size, mtime: st.mtimeMs };
  if (IMAGES[ext]) return { kind: "image", ...base, type: IMAGES[ext] };
  const n = Math.min(st.size, MAX_TEXT);
  const buf = Buffer.alloc(n);
  const fd = openSync(real, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", ...base };
  return { kind: MARKDOWN.has(ext) ? "markdown" : "text", ...base, text: buf.toString("utf8"), ...(st.size > MAX_TEXT && { truncated: true }) };
}

/** An image's bytes, to show it. */
export function image(root: string, cwd: string, path: string): { type: string; data: Buffer } {
  const { real } = locate(root, cwd, path);
  const type = IMAGES[extname(real).toLowerCase()];
  if (!type) throw new FileError("Only images are sent as they are.", 400);
  if (statSync(real).size > MAX_IMAGE) throw new FileError("Too large to show.", 413);
  return { type, data: readFileSync(real) };
}

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { cleanup } from "./cleanup.ts";
import { findConflicts } from "./conflicts.ts";
import { parseSince } from "./core.ts";
import { repoInfo } from "./git.ts";
import { focus, herdrAgents, matchPanes, prompt, screen, sendKeys, type HerdrAgent } from "./herdr.ts";
import { applyHolds, hold, parseUntil, release } from "./holds.ts";
import { readInbox, type Inbox } from "./inbox.ts";
import { prStatuses } from "./prs.ts";
import type { ViewRequest } from "./view-worker.ts";

/**
 * `agent-diff view`: a local web page over the same data as the CLI: the running sessions, and
 * the changes each one made in its repository. It listens on 127.0.0.1 only,
 * and every API call needs the random token from the printed URL, so other sites open in the
 * browser cannot read the diffs or stage anything.
 */

export interface ServeOptions {
  /** The repository whose changes are shown; without one the page shows only the inbox. */
  root: string | undefined;
  port: number;
  days: number;
  staleAfter?: number;
  /** Use herdr, when sessions run in it (default true). */
  herdr?: boolean;
}

const PAGE = join(import.meta.dirname, "viewer.html");

interface Place {
  /** The working tree's root; null outside a repository. */
  repo: string | null;
  /** What the page groups sessions by: the repository's main checkout, or the folder itself. */
  project: string;
}

/** cwd → where it is, looked up again after a minute. */
const places = new Map<string, Place & { at: number }>();

function placeOf(cwd: string | undefined): Place {
  if (!cwd) return { repo: null, project: "" };
  const hit = places.get(cwd);
  if (hit && Date.now() - hit.at < 6e4) return { repo: hit.repo, project: hit.project };
  let place: Place = { repo: null, project: cwd };
  try {
    const info = repoInfo(cwd);
    place = { repo: info.root, project: info.project };
  } catch {
    // not a repository (or gone)
  }
  places.set(cwd, { ...place, at: Date.now() });
  return place;
}

type Ask = ViewRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

/** The attribution worker, started on first use; calls resolve with its answer. */
function attributionWorker(): (req: Ask) => Promise<unknown> {
  const here = import.meta.url;
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const start = () => {
    worker = new Worker(new URL(`./view-worker${here.endsWith(".ts") ? ".ts" : ".js"}`, here));
    worker.unref();
    worker.on("message", (m: { id: number; ok?: unknown; error?: string }) => {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(m.error));
      else w?.resolve(m.ok);
    });
    worker.on("error", (e) => {
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      worker = undefined; // start a new one next time
    });
  };
  return (req) => {
    if (!worker) start();
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ ...req, id });
    });
  };
}

function rangeOf(url: URL): { base?: string; since?: number } {
  const base = url.searchParams.get("base") || undefined;
  const since = url.searchParams.get("since");
  return { base, since: since ? parseSince(since) : undefined };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function serve(opts: ServeOptions): Promise<string> {
  const token = randomBytes(16).toString("hex");
  const attribution = attributionWorker();
  // Read the month of transcripts now, so the first look at a session's changes is quick.
  void attribution({ op: "warm", days: opts.days }).catch(() => {});
  // Repositories the page may read and stage in: the one it was started in, and those of the
  // sessions it has listed. Never an arbitrary path from the request.
  const known = new Set<string>(opts.root ? [opts.root] : []);
  /** The inbox as last served, and the herdr pane of each session, so actions refer to what the page showed. */
  let last: Inbox | undefined;
  let panes = new Map<string, HerdrAgent>();
  const currentInbox = (): Inbox => {
    const inbox = readInbox({ staleAfter: opts.staleAfter });
    if (opts.herdr !== false) {
      const sockets = inbox.items.flatMap((i) => (i.terminal ? [i.terminal.herdrSocket] : []));
      panes = matchPanes(inbox.items, herdrAgents(sockets));
      for (const i of inbox.items) {
        const pane = panes.get(i.key);
        if (!pane) continue;
        (i as typeof i & { herdr?: object }).herdr = { pane: pane.pane, status: pane.status };
        // Codex does not log its approval prompts; herdr sees them on the screen.
        if (i.agent === "codex" && pane.status === "blocked" && i.state !== "needs-answer") {
          i.state = "needs-answer";
          i.reason = "waiting on you (approval or question, seen by herdr)";
        }
      }
    }
    applyHolds(inbox);
    last = inbox;
    return inbox;
  };
  const paneOf = (key: unknown): HerdrAgent => {
    const pane = panes.get(String(key));
    if (!pane) throw new Error("That session does not run in a herdr pane.");
    return pane;
  };
  const repoParam = (url: URL): string => {
    const repo = url.searchParams.get("repo") || opts.root;
    if (!repo) throw new Error("No repository given.");
    if (!known.has(repo)) throw new Error("Not a repository of a listed session.");
    return repo;
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // A page on another site can point a DNS name at 127.0.0.1; only accept our own host names.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "text/plain", "Forbidden host");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE, "utf8"));
      }
      if (req.headers["x-token"] !== token) return json(res, 403, { error: "Open the URL agent-diff view printed (it carries the access token)." });

      if (req.method === "GET" && url.pathname === "/api/inbox") {
        const inbox = currentInbox();
        const conflicts = findConflicts(inbox.items, (i) => placeOf(i.cwd).repo);
        const placed = inbox.items.map((i) => ({ ...i, ...placeOf(i.cwd) }));
        for (const i of placed) if (i.repo) known.add(i.repo);
        const items = placed.map((i) => (conflicts[i.key] ? { ...i, conflicts: conflicts[i.key] } : i));
        const prStatus = prStatuses(items.filter((i) => i.state !== "stale").flatMap((i) => (i.prs ?? []).map((p) => p.url)));
        const home = opts.root ?? null;
        return json(res, 200, { ...inbox, items, prStatus, home, homeProject: home ? placeOf(home).project : null });
      }
      if (req.method === "GET" && url.pathname === "/api/cleanup") {
        const inbox = last ?? currentInbox();
        const projects = new Set<string>();
        for (const i of inbox.items) {
          const p = placeOf(i.cwd);
          if (p.repo) projects.add(p.project);
        }
        if (opts.root) projects.add(placeOf(opts.root).project);
        return json(res, 200, cleanup(inbox, projects));
      }
      if (req.method === "POST" && (url.pathname === "/api/hold" || url.pathname === "/api/release")) {
        const b = await body(req);
        const inbox = last ?? currentInbox();
        const item = inbox.items.find((i) => i.key === b["key"]);
        if (!item) return json(res, 404, { error: "That session is no longer listed." });
        if (url.pathname === "/api/release") return json(res, 200, { released: release(item.key) });
        const kind = b["kind"] === "later" ? "later" : "done";
        const until = kind === "later" ? (typeof b["until"] === "number" ? b["until"] : parseUntil(String(b["until"] ?? "1h"))) : undefined;
        return json(res, 200, { hold: hold(item, kind, until) });
      }
      if (url.pathname.startsWith("/api/herdr/")) {
        const action = url.pathname.slice("/api/herdr/".length);
        if (req.method === "GET" && action === "screen") return json(res, 200, { text: await screen(paneOf(url.searchParams.get("key"))) });
        if (req.method !== "POST") return json(res, 404, { error: "Not found" });
        const b = await body(req);
        const pane = paneOf(b["key"]);
        if (action === "focus") return json(res, 200, { ok: true, result: await focus(pane) });
        if (action === "prompt") {
          const text = String(b["text"] ?? "").trim();
          if (!text || text.length > 20_000) throw new Error("Write a prompt (up to 20,000 characters).");
          return json(res, 200, { ok: true, result: await prompt(pane, text) });
        }
        if (action === "keys") return json(res, 200, { ok: true, result: await sendKeys(pane, Array.isArray(b["keys"]) ? b["keys"].map(String) : []) });
        return json(res, 404, { error: "Not found" });
      }
      if (req.method === "GET" && url.pathname === "/api/view") {
        // Started outside a repository and no session picked: there are no changes to show.
        if (!opts.root && !url.searchParams.get("repo")) return json(res, 200, { root: null });
        return json(res, 200, await attribution({ op: "view", root: repoParam(url), days: opts.days, ...rangeOf(url) }));
      }
      if (req.method === "POST" && url.pathname === "/api/stage") {
        const repo = repoParam(url);
        const b = await body(req);
        return json(res, 200, await attribution({ op: "stage", root: repo, days: opts.days, ...rangeOf(url), session: String(b["session"] ?? ""), apply: b["apply"] === true }));
      }
      return json(res, 404, { error: "Not found" });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve(`http://127.0.0.1:${port}/#t=${token}`);
    });
  });
}

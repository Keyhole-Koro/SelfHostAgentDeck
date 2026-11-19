import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { renderSVG } from "uqr";
import { appendActivity, changes, readActivity, snapshot, type ActivityEvent, type Snapshot } from "./activity.ts";
import { ciFailure } from "./ci.ts";
import { cleanup } from "./cleanup.ts";
import { findConflicts } from "./conflicts.ts";
import { readChat } from "./conversation.ts";
import { parseSince } from "./core.ts";
import { FileError, filesRoot, image, look } from "./files.ts";
import { repoInfo } from "./git.ts";
import { focus, herdrAgents, matchPanes, prompt, screen, sendKeys, type HerdrAgent } from "./herdr.ts";
import { applyHolds, hold, parseUntil, release, stateDir } from "./holds.ts";
import { readInbox, transcriptOf, type Inbox, type InboxItem } from "./inbox.ts";
import { prStatuses } from "./prs.ts";
import { parsePrompt } from "./prompts.ts";
import { MAX_UPLOAD, saveUpload } from "./uploads.ts";
import {
  audit,
  authenticationOptions,
  cookie,
  cookieNames,
  confirmed,
  confirmedCookie,
  confirmOptions,
  createPairing,
  listPasskeys,
  loginPage,
  newSession,
  pairPage,
  passkeyLabel,
  readAudit,
  readCookie,
  registrationOptions,
  remoteConfig,
  removePasskey,
  saveOrigin,
  sessionPasskey,
  verifyAuthentication,
  verifyConfirm,
  verifyRegistration,
  PASSKEY_HELPERS,
  type Passkey,
  type RemoteConfig,
} from "./remote.ts";
import type { ViewRequest } from "./view-worker.ts";

/**
 * `agent-diff view`: a web page over the same data as the CLI: the running sessions, and the
 * changes each one made in its repository.
 *
 * Locally it listens on 127.0.0.1, and every API call needs the random token from the printed
 * URL, so other sites open in the browser cannot read the diffs or act on sessions.
 *
 * With `remote`, a second listener (also on 127.0.0.1, for a Cloudflare Tunnel) serves the same
 * page at a public origin to devices signed in with a passkey (see remote.ts). Everything they
 * change is logged.
 */

export interface ServeOptions {
  /** The repository whose changes are shown; without one the page shows only the inbox. */
  root: string | undefined;
  port: number;
  days: number;
  staleAfter?: number;
  /** Use herdr, when sessions run in it (default true). */
  herdr?: boolean;
  /** Serve signed-in devices at this public origin, on a second local port for the tunnel. */
  remote?: { origin: string; port: number };
}

export interface Served {
  /** The local page, with its token. */
  url: string;
  /** The tunnel's local port and the public origin, when remote access is on. */
  remote?: { origin: string; port: number };
}

const PAGE = join(import.meta.dirname, "viewer.html");
/** The page's Markdown renderer, inlined into its script (one nonce, one request). */
const MARKDOWN = join(import.meta.dirname, "markdown.js");

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

/** How long the attribution worker may sit unused before it stops. */
const WORKER_IDLE_MS = 10 * 60_000;

/**
 * The attribution worker, started on first use; calls resolve with its answer. It keeps every
 * transcript it has parsed (about a GB over a month), which a page left running all day should
 * not hold for nothing: after `idleMs` without a call it stops, and the next call starts a fresh
 * one, slow again for that first look.
 */
export function attributionWorker(idleMs = WORKER_IDLE_MS): ((req: Ask) => Promise<unknown>) & { running(): boolean } {
  const here = import.meta.url;
  let worker: Worker | undefined;
  let idle: NodeJS.Timeout | undefined;
  let next = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const stopIfIdle = () => {
    if (!worker || waiting.size > 0) return;
    const w = worker;
    worker = undefined; // first, so its exit below is not taken for a crash
    void w.terminate();
  };
  const start = (): Worker => {
    const w = new Worker(new URL(`./view-worker${here.endsWith(".ts") ? ".ts" : ".js"}`, here));
    w.unref();
    w.on("message", (m: { id: number; ok?: unknown; error?: string }) => {
      const p = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else p?.resolve(m.ok);
      if (waiting.size === 0) {
        clearTimeout(idle);
        idle = setTimeout(stopIfIdle, idleMs).unref();
      }
    });
    // A crash fails what it was doing; the next call starts a new one.
    const lost = (e: Error) => {
      if (worker !== w) return;
      worker = undefined;
      for (const p of waiting.values()) p.reject(e);
      waiting.clear();
    };
    w.on("error", lost);
    w.on("exit", (code) => lost(new Error(`The attribution worker exited (${code}).`)));
    return w;
  };
  const ask = (req: Ask): Promise<unknown> => {
    clearTimeout(idle);
    worker ??= start();
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ ...req, id });
    });
  };
  return Object.assign(ask, { running: () => worker !== undefined });
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

/** An HTML page whose only script is the one carrying `nonce`, and which no other site may frame. */
function html(res: ServerResponse, body: string, nonce: string): void {
  res.setHeader(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  send(res, 200, "text/html; charset=utf-8", body);
}

/** The page, with its script allowed by the nonce and the mode it runs in. */
function viewerPage(nonce: string, mode: "local" | "remote"): string {
  return readFileSync(PAGE, "utf8")
    .replace("<head>", `<head>\n<meta name="agent-diff-mode" content="${mode}">`)
    .replace("<script>", `<script nonce="${nonce}">`)
    .replace("/*@markdown*/", () => readFileSync(MARKDOWN, "utf8"))
    .replace("/*@passkey*/", () => PASSKEY_HELPERS);
}

/** A request's bytes, up to `max`. */
async function rawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new FileError(`Too large: up to ${Math.round(max / 1024 / 1024)} MB.`, 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error("Request too large.");
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * The local page's token, kept across restarts (readable by you only) so that a bookmarked URL
 * keeps working when the page runs as a service.
 */
function localToken(): string {
  const file = join(stateDir(), "token");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch {
    // first start
  }
  const t = randomBytes(16).toString("hex");
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

export async function serve(opts: ServeOptions): Promise<Served> {
  const token = localToken();
  const attribution = attributionWorker();
  // Read the month of transcripts now, so the first look at a session's changes is quick. If
  // nobody looks for a while, the worker lets them go.
  void attribution({ op: "warm", days: opts.days }).catch(() => {});
  const cfg: RemoteConfig | undefined = opts.remote ? remoteConfig(opts.remote.origin) : undefined;
  if (cfg) saveOrigin(cfg.origin);
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
  /**
   * Watches the sessions while the page is closed too: every change goes into the activity log
   * (and to the phones that asked to be told).
   */
  let seen: Snapshot | undefined;
  const watch = () => {
    try {
      const inbox = currentInbox();
      const prStatus = prStatuses(inbox.items.filter((i) => i.state !== "stale").flatMap((i) => (i.prs ?? []).map((p) => p.url)));
      const events = changes(seen, inbox, prStatus);
      seen = snapshot(inbox, prStatus);
      if (events.length) {
        appendActivity(events);
        onEvents(events);
      }
    } catch {
      // try again next time
    }
  };
  const onEvents = (_events: ActivityEvent[]) => {};
  setInterval(watch, Number(process.env["AGENT_DIFF_WATCH_MS"]) || 15_000).unref();
  setTimeout(watch, 1000).unref();

  /** A session the page listed: only those can be read. */
  const listed = (key: unknown): InboxItem => {
    const item = (last ?? currentInbox()).items.find((i) => i.key === key);
    if (!item) throw new FileError("That session is no longer listed.", 404);
    return item;
  };
  /** Folders of the listed sessions (their repositories, or the folders themselves): where sessions may start and files may go. */
  const projectRoots = (): Set<string> => {
    const out = new Set<string>(opts.root ? [opts.root] : []);
    for (const i of (last ?? currentInbox()).items) {
      const p = placeOf(i.cwd);
      if (p.repo) out.add(p.repo);
      if (p.project) out.add(p.project);
    }
    return out;
  };
  const offset = (url: URL, name: string): number | undefined => {
    const v = url.searchParams.get(name);
    return v && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const repoParam = (url: URL): string => {
    const repo = url.searchParams.get("repo") || opts.root;
    if (!repo) throw new Error("No repository given.");
    if (!known.has(repo)) throw new Error("Not a repository of a listed session.");
    return repo;
  };

  /**
   * The API, for the local page and for signed-in devices (`device` set: remote, and logged). A
   * device acts (prompts, keys, staging, starting, uploading) only within a few minutes of a
   * passkey check: a stolen cookie alone can look, not act.
   */
  const api = async (req: IncomingMessage, res: ServerResponse, url: URL, device?: Passkey, fresh = false): Promise<void> => {
    const log = (action: string, target?: string, detail?: string) => {
      if (device) audit({ device: device.label, action, ...(target && { target }), ...(detail && { detail }) });
    };
    const acting = req.method === "POST" && /^\/api\/(herdr\/(prompt|keys)|stage|start|upload)$/.test(url.pathname);
    if (device && acting && !fresh) return json(res, 403, { error: "Confirm it is you with this device's passkey.", confirm: true });
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
    if (req.method === "GET" && url.pathname === "/api/activity") return json(res, 200, { events: readActivity(300) });
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
      if (url.pathname === "/api/release") {
        log("release", item.key);
        return json(res, 200, { released: release(item.key) });
      }
      const kind = b["kind"] === "later" ? "later" : "done";
      const until = kind === "later" ? (typeof b["until"] === "number" ? b["until"] : parseUntil(String(b["until"] ?? "1h"))) : undefined;
      log(kind, item.key);
      return json(res, 200, { hold: hold(item, kind, until) });
    }
    if (url.pathname.startsWith("/api/herdr/")) {
      const action = url.pathname.slice("/api/herdr/".length);
      if (req.method === "GET" && action === "screen") {
        const text = await screen(paneOf(url.searchParams.get("key")));
        return json(res, 200, { text, prompt: parsePrompt(text) ?? null });
      }
      if (req.method !== "POST") return json(res, 404, { error: "Not found" });
      const b = await body(req);
      const pane = paneOf(b["key"]);
      if (action === "focus") {
        log("focus", String(b["key"]));
        return json(res, 200, { ok: true, result: await focus(pane) });
      }
      if (action === "prompt") {
        const text = String(b["text"] ?? "").trim();
        if (!text || text.length > 20_000) throw new Error("Write a prompt (up to 20,000 characters).");
        log("prompt", String(b["key"]), text);
        return json(res, 200, { ok: true, result: await prompt(pane, text) });
      }
      if (action === "keys") {
        const keys = Array.isArray(b["keys"]) ? b["keys"].map(String) : [];
        const result = await sendKeys(pane, keys);
        log("keys", String(b["key"]), keys.join(" "));
        return json(res, 200, { ok: true, result });
      }
      return json(res, 404, { error: "Not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/chat") {
      const item = listed(url.searchParams.get("key"));
      const file = transcriptOf(item);
      // A session that has not said anything yet has no transcript yet.
      if (!file) return json(res, 200, { messages: [], end: 0 });
      return json(res, 200, readChat(file, item.agent, { before: offset(url, "before"), after: offset(url, "after"), ...(item.cwd && { cwd: item.cwd }) }));
    }
    if (req.method === "GET" && (url.pathname === "/api/files" || url.pathname === "/api/files/image")) {
      const item = listed(url.searchParams.get("key"));
      const root = filesRoot(item.cwd, placeOf(item.cwd).repo);
      if (!root) return json(res, 403, { error: "Files are not shown for a session that runs in your home folder." });
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname === "/api/files") return json(res, 200, look(root, item.cwd ?? root, path));
      const img = image(root, item.cwd ?? root, path);
      res.writeHead(200, { "content-type": img.type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(img.data);
    }
    if (req.method === "GET" && url.pathname === "/api/ci") {
      const item = listed(url.searchParams.get("key"));
      const pr = url.searchParams.get("url") ?? "";
      if (!(item.prs ?? []).some((p) => p.url === pr)) throw new FileError("Not a pull request of this session.", 404);
      return json(res, 200, await ciFailure(pr));
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const project = url.searchParams.get("project");
      let root: string | undefined;
      if (project) {
        if (!projectRoots().has(project)) throw new FileError("Not a folder of a listed session.", 404);
        root = filesRoot(project, placeOf(project).repo);
      } else {
        const item = listed(url.searchParams.get("key"));
        root = filesRoot(item.cwd, placeOf(item.cwd).repo);
      }
      if (!root) return json(res, 403, { error: "Files are not sent to a session that runs in your home folder." });
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
      const up = saveUpload(root, name, await rawBody(req, MAX_UPLOAD));
      log("sent a file", up.rel);
      return json(res, 200, up);
    }
    if (req.method === "GET" && url.pathname === "/api/view") {
      // Started outside a repository and no session picked: there are no changes to show.
      if (!opts.root && !url.searchParams.get("repo")) return json(res, 200, { root: null });
      return json(res, 200, await attribution({ op: "view", root: repoParam(url), days: opts.days, ...rangeOf(url) }));
    }
    if (req.method === "POST" && url.pathname === "/api/stage") {
      const repo = repoParam(url);
      const b = await body(req);
      const apply = b["apply"] === true;
      if (apply) log("stage", String(b["session"] ?? ""), repo);
      return json(res, 200, await attribution({ op: "stage", root: repo, days: opts.days, ...rangeOf(url), session: String(b["session"] ?? ""), apply }));
    }
    if (req.method === "GET" && url.pathname === "/api/remote") {
      const devices = listPasskeys().map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt, current: device?.id === id }));
      return json(res, 200, { origin: cfg?.origin ?? null, devices, log: readAudit(40), remote: !!device });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/pair") {
      // Devices are added from this computer only: a device that is signed in cannot add others.
      if (device) return json(res, 403, { error: "Pair new devices from your computer." });
      if (!cfg) return json(res, 400, { error: "Remote access is off: start agent-diff view with --remote <origin>." });
      const pairing = createPairing(cfg.origin);
      return json(res, 200, { ...pairing, svg: renderSVG(pairing.url, { border: 2 }) });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/revoke") {
      const b = await body(req);
      const gone = removePasskey(String(b["id"] ?? ""));
      if (!gone) return json(res, 404, { error: "No such device." });
      log("remove device", gone.label);
      return json(res, 200, { removed: gone.label });
    }
    return json(res, 404, { error: "Not found" });
  };

  const local = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // A page on another site can point a DNS name at 127.0.0.1; only accept our own host names.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "text/plain", "Forbidden host");
      if (req.method === "GET" && url.pathname === "/") {
        const nonce = randomBytes(16).toString("base64");
        return html(res, viewerPage(nonce, "local"), nonce);
      }
      if (req.headers["x-token"] !== token) return json(res, 403, { error: "Open the URL agent-diff view printed (it carries the access token)." });
      return await api(req, res, url);
    } catch (e) {
      return json(res, e instanceof FileError ? e.status : 400, { error: (e as Error).message });
    }
  });
  const port = await listen(local, opts.port);
  const served: Served = { url: `http://127.0.0.1:${port}/#t=${token}` };
  if (!cfg || !opts.remote) return served;

  const names = cookieNames(cfg);
  const remote = createServer(async (req, res) => {
    try {
      // Only requests for the public origin, which the tunnel forwards with their Host intact.
      if (req.headers.host !== cfg.host) return send(res, 403, "text/plain", "Forbidden host");
      const url = new URL(req.url ?? "/", cfg.origin);
      const nonce = randomBytes(16).toString("base64");
      const device = sessionPasskey(readCookie(req.headers.cookie, names.session));
      // Requests that change something must come from our own page: same origin and our header,
      // which a form or another site's script cannot send without CORS (never granted here).
      const fromPage = req.headers["x-agent-diff"] === "1" && (req.method === "GET" || req.headers.origin === cfg.origin);

      if (req.method === "GET" && url.pathname === "/login") return html(res, loginPage(nonce), nonce);
      const pair = /^\/pair\/([A-Za-z0-9_-]{20,})$/.exec(url.pathname);
      if (req.method === "GET" && pair) return html(res, pairPage(nonce, pair[1]!, passkeyLabel(req.headers["user-agent"])), nonce);
      if (url.pathname.startsWith("/auth/")) {
        if (req.method !== "POST" || !fromPage) return json(res, 403, { error: "Not from this page." });
        const ceremony = readCookie(req.headers.cookie, names.ceremony);
        const b = await body(req);
        const signIn = (p: Passkey, action: string) => {
          const s = newSession(p);
          res.setHeader("set-cookie", [cookie(cfg, names.session, s.value, s.maxAge), cookie(cfg, names.ceremony, "", 0), confirmedCookie(cfg, p)]);
          audit({ device: p.label, action });
          return json(res, 200, { ok: true });
        };
        switch (url.pathname) {
          case "/auth/login/options": {
            const o = await authenticationOptions(cfg);
            res.setHeader("set-cookie", cookie(cfg, names.ceremony, o.ceremony, 300));
            return json(res, 200, o.options);
          }
          case "/auth/login/verify":
            return signIn(await verifyAuthentication(cfg, ceremony, b["response"] as never), "signed in");
          case "/auth/register/options": {
            const o = await registrationOptions(cfg, String(b["pairing"] ?? ""), String(b["label"] ?? "") || passkeyLabel(req.headers["user-agent"]));
            res.setHeader("set-cookie", cookie(cfg, names.ceremony, o.ceremony, 300));
            return json(res, 200, o.options);
          }
          case "/auth/register/verify":
            return signIn(await verifyRegistration(cfg, ceremony, b["response"] as never), "paired this device");
          case "/auth/confirm/options": {
            if (!device) return json(res, 401, { error: "Sign in again.", login: "/login" });
            const o = await confirmOptions(cfg, device);
            res.setHeader("set-cookie", cookie(cfg, names.ceremony, o.ceremony, 300));
            return json(res, 200, o.options);
          }
          case "/auth/confirm/verify": {
            if (!device) return json(res, 401, { error: "Sign in again.", login: "/login" });
            await verifyConfirm(cfg, ceremony, b["response"] as never, device);
            res.setHeader("set-cookie", [cookie(cfg, names.ceremony, "", 0), confirmedCookie(cfg, device)]);
            return json(res, 200, { ok: true });
          }
          case "/auth/logout":
            res.setHeader("set-cookie", [cookie(cfg, names.session, "", 0), cookie(cfg, names.fresh, "", 0)]);
            if (device) audit({ device: device.label, action: "signed out" });
            return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      }
      if (req.method === "GET" && url.pathname === "/") {
        if (!device) {
          res.writeHead(302, { location: "/login", "cache-control": "no-store" });
          return void res.end();
        }
        return html(res, viewerPage(nonce, "remote"), nonce);
      }
      if (url.pathname.startsWith("/api/")) {
        if (!device) return json(res, 401, { error: "Sign in again.", login: "/login" });
        if (!fromPage) return json(res, 403, { error: "Not from this page." });
        return await api(req, res, url, device, confirmed(readCookie(req.headers.cookie, names.fresh), device));
      }
      return json(res, 404, { error: "Not found" });
    } catch (e) {
      return json(res, e instanceof FileError ? e.status : 400, { error: (e as Error).message });
    }
  });
  served.remote = { origin: cfg.origin, port: await listen(remote, opts.remote.port) };
  return served;
}

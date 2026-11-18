import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { stateDir } from "./holds.ts";

/**
 * Remote access: the page from a phone, through a Cloudflare Tunnel to a public origin such as
 * https://agents.example.com, signed in with a passkey.
 *
 * - A device is added through a single-use pairing link (10 minutes) made on this computer, by
 *   `agent-diff remote pair` or the page opened locally: whoever holds this computer adds devices.
 * - Signing in is a passkey for the public origin; the session is a signed cookie naming the
 *   passkey, so removing a passkey ends its sessions.
 * - Everything a remote device changes (prompts, keys, holds, staging) is logged.
 *
 * State lives in $XDG_STATE_HOME/agent-diff/remote/, readable by you only: the signing secret,
 * the passkeys (public keys), pending pairings (hashed) and the log. Modelled on SelfHostArtifacts'
 * passkey sign-in.
 */

export interface RemoteConfig {
  /** The public origin, e.g. https://agents.example.com. */
  origin: string;
  /** The WebAuthn relying party: the origin's host name. */
  rpId: string;
  /** Host header requests through the tunnel carry. */
  host: string;
}

export function remoteConfig(origin: string): RemoteConfig {
  const u = new URL(origin);
  if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error(`--remote needs an https origin (got ${origin}); http only works for localhost.`);
  return { origin: u.origin, rpId: u.hostname, host: u.host };
}

const SESSION_DAYS = 30;
const CEREMONY_SECONDS = 5 * 60;
const PAIRING_MINUTES = 10;

const dir = () => join(stateDir(), "remote");

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Writes a state file atomically, readable by you only. */
function writeJson(name: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const file = join(dir(), name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

/** The key cookies are signed with, made on first use. */
function secret(): Buffer {
  const file = join(dir(), "secret");
  if (!existsSync(file)) {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  }
  chmodSync(file, 0o600);
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

/** A value signed with the secret: base64url(json).base64url(hmac). */
export function sign<T extends { exp: number }>(value: T): string {
  const body = b64url(Buffer.from(JSON.stringify(value)));
  return `${body}.${b64url(createHmac("sha256", secret()).update(body).digest())}`;
}

/** The value of a signed token, if its signature holds and it has not expired. */
export function verify<T extends { exp: number }>(token: string | undefined): T | undefined {
  if (!token) return undefined;
  const [body, mac] = token.split(".");
  if (!body || !mac) return undefined;
  const want = createHmac("sha256", secret()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    return value.exp > Date.now() / 1000 ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- passkeys

export interface Passkey {
  id: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  /** A name for the device, e.g. "iPhone · Safari". */
  label: string;
  createdAt: number;
  lastUsedAt?: number;
}

export const listPasskeys = () => readJson<Passkey[]>("passkeys.json", []);

function savePasskeys(list: Passkey[]): void {
  writeJson("passkeys.json", list);
}

export function removePasskey(id: string): Passkey | undefined {
  const list = listPasskeys();
  const gone = list.find((p) => p.id === id);
  if (gone) savePasskeys(list.filter((p) => p.id !== id));
  return gone;
}

/** The single owner every passkey belongs to (its WebAuthn user handle). */
function ownerId(): Uint8Array<ArrayBuffer> {
  const user = readJson<{ id?: string }>("owner.json", {});
  if (user.id) return new Uint8Array(Buffer.from(user.id, "base64url"));
  const id = randomBytes(16);
  writeJson("owner.json", { id: b64url(id) });
  return new Uint8Array(id);
}

// ---------------------------------------------------------------- pairing links

interface Pairing {
  hash: string;
  expiresAt: number;
}

/** A single-use link that lets one more device register a passkey. Only this computer makes them. */
export function createPairing(origin: string, now = Date.now()): { url: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const live = readJson<Pairing[]>("pairings.json", []).filter((p) => p.expiresAt > now);
  const expiresAt = now + PAIRING_MINUTES * 60_000;
  writeJson("pairings.json", [...live, { hash: sha256(token), expiresAt }]);
  return { url: `${origin}/pair/${token}`, expiresAt };
}

export function pairingValid(token: string, now = Date.now()): boolean {
  return readJson<Pairing[]>("pairings.json", []).some((p) => p.hash === sha256(token) && p.expiresAt > now);
}

/** Consumes a pairing: true once, for a valid token. */
function usePairing(token: string, now = Date.now()): boolean {
  const all = readJson<Pairing[]>("pairings.json", []);
  const ok = all.some((p) => p.hash === sha256(token) && p.expiresAt > now);
  writeJson(
    "pairings.json",
    all.filter((p) => p.hash !== sha256(token) && p.expiresAt > now),
  );
  return ok;
}

// ---------------------------------------------------------------- the log

export interface RemoteEvent {
  at: number;
  device: string;
  action: string;
  target?: string;
  detail?: string;
}

/** Records what a remote device did. */
export function audit(event: Omit<RemoteEvent, "at">): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const e: RemoteEvent = { at: Date.now(), ...event };
  if (e.detail && e.detail.length > 500) e.detail = e.detail.slice(0, 499) + "…";
  appendFileSync(join(dir(), "log.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 });
}

export function readAudit(limit = 50): RemoteEvent[] {
  let text = "";
  try {
    text = readFileSync(join(dir(), "log.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: RemoteEvent[] = [];
  for (const line of text.split("\n")) {
    try {
      if (line) out.push(JSON.parse(line) as RemoteEvent);
    } catch {
      // a torn line
    }
  }
  return out.slice(-limit).reverse();
}

/** The origin the remote page was last started with, for `agent-diff remote pair`. */
export function savedOrigin(): string | undefined {
  return readJson<{ origin?: string }>("config.json", {}).origin;
}

export function saveOrigin(origin: string): void {
  writeJson("config.json", { origin });
}

// ---------------------------------------------------------------- ceremonies and sessions

export type Ceremony =
  | { kind: "login"; challenge: string; exp: number }
  | { kind: "register"; challenge: string; pairing: string; label: string; exp: number };

export const cookieNames = (cfg: RemoteConfig) => {
  // The __Host- prefix needs Secure, which http://localhost (tests) cannot have.
  const prefix = cfg.origin.startsWith("https:") ? "__Host-" : "";
  return { session: `${prefix}agent_diff_session`, ceremony: `${prefix}agent_diff_webauthn` };
};

export function cookie(cfg: RemoteConfig, name: string, value: string, maxAge: number): string {
  return [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict", ...(cfg.origin.startsWith("https:") ? ["Secure"] : [])].join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function registrationOptions(cfg: RemoteConfig, pairing: string, label: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; ceremony: string }> {
  if (!pairingValid(pairing)) throw new Error("This pairing link has expired or was used. Make a new one on your computer.");
  const options = await generateRegistrationOptions({
    rpName: "Agent Diff",
    rpID: cfg.rpId,
    userName: "owner",
    userDisplayName: "Agent Diff owner",
    userID: ownerId(),
    attestationType: "none",
    excludeCredentials: listPasskeys().map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] | undefined })),
    // Discoverable, so signing in needs no user name.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const ceremony = sign({ kind: "register", challenge: options.challenge, pairing, label: label.slice(0, 60) || "Device", exp: Math.floor(Date.now() / 1000) + CEREMONY_SECONDS });
  return { options, ceremony };
}

/** Registers the passkey, using up the pairing link. */
export async function verifyRegistration(cfg: RemoteConfig, ceremonyToken: string | undefined, response: RegistrationResponseJSON): Promise<Passkey> {
  const c = verify<Ceremony>(ceremonyToken);
  if (!c || c.kind !== "register") throw new Error("The passkey request expired. Try again.");
  const result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true });
  if (!result.verified) throw new Error("The passkey could not be verified.");
  // Only now use the link up, and only once: of two registrations racing, one gets it.
  if (!usePairing(c.pairing)) throw new Error("This pairing link has expired or was used. Make a new one on your computer.");
  const { credential } = result.registrationInfo;
  const passkey: Passkey = { id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter, label: c.label, createdAt: Date.now() };
  if (credential.transports) passkey.transports = credential.transports;
  savePasskeys([...listPasskeys().filter((p) => p.id !== passkey.id), passkey]);
  return passkey;
}

export async function authenticationOptions(cfg: RemoteConfig): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; ceremony: string }> {
  const options = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: "required" });
  return { options, ceremony: sign({ kind: "login", challenge: options.challenge, exp: Math.floor(Date.now() / 1000) + CEREMONY_SECONDS }) };
}

export async function verifyAuthentication(cfg: RemoteConfig, ceremonyToken: string | undefined, response: AuthenticationResponseJSON): Promise<Passkey> {
  const c = verify<Ceremony>(ceremonyToken);
  if (!c || c.kind !== "login") throw new Error("The sign-in request expired. Try again.");
  const list = listPasskeys();
  const passkey = list.find((p) => p.id === response.id);
  if (!passkey) throw new Error("This passkey is not registered here (it may have been removed). Pair the device again.");
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpId,
    credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports as AuthenticatorTransport[] | undefined },
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error("The passkey could not be verified.");
  passkey.counter = result.authenticationInfo.newCounter;
  passkey.lastUsedAt = Date.now();
  savePasskeys(list);
  return passkey;
}

export function newSession(passkey: Passkey): { value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 86400;
  return { value: sign({ pk: passkey.id, exp: Math.floor(Date.now() / 1000) + maxAge }), maxAge };
}

/** The passkey a session cookie stands for, if it is valid and the passkey still registered. */
export function sessionPasskey(token: string | undefined): Passkey | undefined {
  const s = verify<{ pk: string; exp: number }>(token);
  return s ? listPasskeys().find((p) => p.id === s.pk) : undefined;
}

/** A readable default name for a new passkey, from the browser's user agent. */
export function passkeyLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}

// ---------------------------------------------------------------- pages

/** Browser code for passkeys (from SelfHostArtifacts): JSON options in, credential JSON out. */
const PASSKEY_JS = `
const b64 = {
  toBytes(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
  from(buf) {
    let s = "";
    for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  },
};
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-agent-diff": "1" }, credentials: "same-origin", body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong. Try again.");
  return json;
}
const creation = (o) => ({ ...o, challenge: b64.toBytes(o.challenge), user: { ...o.user, id: b64.toBytes(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64.toBytes(c.id) })) });
const request = (o) => ({ ...o, challenge: b64.toBytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64.toBytes(c.id) })) });
function registration(cred) {
  const r = cred.response;
  return { id: cred.id, rawId: b64.from(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64.from(r.clientDataJSON), attestationObject: b64.from(r.attestationObject), transports: r.getTransports ? r.getTransports() : undefined } };
}
function authentication(cred) {
  const r = cred.response;
  return { id: cred.id, rawId: b64.from(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64.from(r.clientDataJSON), authenticatorData: b64.from(r.authenticatorData), signature: b64.from(r.signature), userHandle: r.userHandle ? b64.from(r.userHandle) : undefined } };
}
document.querySelectorAll("[data-passkey]").forEach((button) => button.addEventListener("click", async () => {
  const error = document.getElementById("error");
  error.textContent = "";
  button.disabled = true;
  try {
    if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
    if (button.dataset.passkey === "login") {
      const opts = await post("/auth/login/options");
      await post("/auth/login/verify", { response: authentication(await navigator.credentials.get({ publicKey: request(opts) })) });
    } else {
      const label = document.getElementById("label").value.trim();
      const opts = await post("/auth/register/options", { pairing: button.dataset.pairing, label });
      await post("/auth/register/verify", { response: registration(await navigator.credentials.create({ publicKey: creation(opts) })) });
    }
    location.assign("/");
  } catch (e) {
    const n = e && e.name;
    error.textContent = n === "NotAllowedError" || n === "AbortError" ? "Cancelled, or no passkey for this site on this device." : n === "InvalidStateError" ? "This device already has a passkey here: sign in instead." : e.message;
    button.disabled = false;
  }
}));
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(nonce: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root { --bg: #fbfaf8; --panel: #fff; --text: #1f1d1a; --muted: #6f6a62; --line: #e6e2db; --accent: #3b5bdb; --urgent: #b42318; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1918; --panel: #222120; --text: #ebe8e3; --muted: #9c968c; --line: #35332f; --accent: #8ea6ff; --urgent: #ff9b8f; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
main { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { margin: 0 0 6px; font-size: 20px; } p { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
input { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 14px; }
button { width: 100%; font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 12px; background: var(--accent); color: var(--bg); cursor: pointer; }
button:disabled { opacity: .6; }
#error { color: var(--urgent); font-size: 14px; margin: 12px 0 0; min-height: 1em; }
</style>
</head>
<body><main>${body}</main><script nonce="${nonce}">${PASSKEY_JS}</script></body>
</html>`;
}

export function loginPage(nonce: string): string {
  return page(
    nonce,
    "Sign in · Agent Diff",
    `<h1>Agent Diff</h1><p>Sign in with this device's passkey. No passkey yet? Make a pairing link on your computer with <b>agent-diff remote pair</b> and open it here.</p><button data-passkey="login">Sign in with a passkey</button><p id="error" role="alert"></p>`,
  );
}

export function pairPage(nonce: string, token: string, label: string): string {
  if (!pairingValid(token)) {
    return page(nonce, "Pairing link · Agent Diff", `<h1>This link has expired</h1><p>Pairing links work once, for ${PAIRING_MINUTES} minutes. Make a new one on your computer with <b>agent-diff remote pair</b>.</p><p id="error"></p>`);
  }
  return page(
    nonce,
    "Add this device · Agent Diff",
    `<h1>Add this device</h1><p>This device gets a passkey for Agent Diff. With it you can see your coding-agent sessions and answer them from here.</p><label for="label">Name for this device</label><input id="label" value="${esc(label)}" maxlength="60"><button data-passkey="register" data-pairing="${esc(token)}">Create a passkey</button><p id="error" role="alert"></p>`,
  );
}

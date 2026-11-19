import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign as signData, type JsonWebKey, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./holds.ts";
import { env } from "./env.ts";

/**
 * Web Push, to tell a phone (a home-screen web app on iOS) or a browser that a session waits,
 * with the page closed. Standard and self-contained: the payload is encrypted for the browser
 * alone (RFC 8291, aes128gcm), and this server identifies itself with its own key (VAPID, RFC
 * 8292). The push service (Apple's, Google's, Mozilla's) relays bytes it cannot read.
 */

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Subscriber extends PushSubscription {
  /** The passkey of the device that asked, or "local" for this computer's page. */
  device: string;
  label: string;
  createdAt: number;
}

export interface PushMessage {
  title: string;
  body?: string;
  /** Notifications with the same tag replace each other (one per session). */
  tag?: string;
  /** Where a tap opens. */
  url?: string;
  /** The session to open. */
  key?: string;
  /** Buttons on the notification (where the browser shows them): a choice of the dialog, by index. */
  actions?: { action: string; title: string }[];
  /** For those: which dialog it is, and the label of each choice, to answer it on the page. */
  choose?: { sig: string; labels: Record<string, string> };
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const dir = () => join(stateDir(), "push");
const read = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(join(dir(), name), "utf8")) as T;
  } catch {
    return fallback;
  }
};
const write = (name: string, value: unknown) => {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir(), name), JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
};

// ---------------------------------------------------------------- this server's key (VAPID)

interface Vapid {
  privateKey: KeyObject;
  /** The uncompressed P-256 point browsers take as applicationServerKey (base64url). */
  publicKey: string;
}

let vapidCache: Vapid | undefined;

export function vapid(): Vapid {
  if (vapidCache) return vapidCache;
  let jwk = read<JsonWebKey | undefined>("vapid.json", undefined);
  if (!jwk?.d) {
    jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    write("vapid.json", jwk);
  }
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]));
  return (vapidCache = { privateKey, publicKey });
}

/** The Authorization header for one push service: a short-lived JWT signed with our key. */
export function vapidAuthorization(endpoint: string, subject: string, now = Date.now()): string {
  const { privateKey, publicKey } = vapid();
  const part = (v: object) => b64url(Buffer.from(JSON.stringify(v)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = signData("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${publicKey}`;
}

// ---------------------------------------------------------------- the payload (RFC 8291)

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** Encrypts a payload for one browser: only the holder of its p256dh key can read it. */
export function encrypt(payload: Buffer, sub: PushSubscription, salt = randomBytes(16), asPrivate?: Buffer): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, "base64url");
  const authSecret = Buffer.from(sub.keys.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  // A fresh key per message; a given one only for the RFC's test vector.
  const asPublic = asPrivate ? (ecdh.setPrivateKey(asPrivate), ecdh.getPublicKey()) : ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ---------------------------------------------------------------- subscribers

export const subscribers = (): Subscriber[] => read<Subscriber[]>("subscriptions.json", []);

/** Push services are https; a subscription naming anything else is refused (no requests elsewhere). */
function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "https:") return true;
    return env("PUSH_INSECURE") === "1" && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

export function subscribe(sub: PushSubscription, device: string, label: string): Subscriber {
  if (!validEndpoint(sub?.endpoint) || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string") throw new Error("Not a push subscription.");
  if (Buffer.from(sub.keys.p256dh, "base64url").length !== 65 || Buffer.from(sub.keys.auth, "base64url").length !== 16) throw new Error("Not a push subscription.");
  const s: Subscriber = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device, label: label.slice(0, 60), createdAt: Date.now() };
  write("subscriptions.json", [...subscribers().filter((x) => x.endpoint !== s.endpoint), s]);
  return s;
}

export function unsubscribe(match: (s: Subscriber) => boolean): number {
  const all = subscribers();
  const kept = all.filter((s) => !match(s));
  if (kept.length !== all.length) write("subscriptions.json", kept);
  return all.length - kept.length;
}

/** Sends one message to one subscriber; drops it when the push service says it is gone. */
export async function send(sub: Subscriber, message: PushMessage, opts: { subject: string; urgency?: "high" | "normal" | "low"; ttl?: number }): Promise<number> {
  const body = encrypt(Buffer.from(JSON.stringify(message)), sub);
  const topic = message.tag ? createHash("sha256").update(message.tag).digest("base64url").slice(0, 32) : undefined;
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuthorization(sub.endpoint, opts.subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(opts.ttl ?? 86_400),
      urgency: opts.urgency ?? "normal",
      ...(topic && { topic }),
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 410) unsubscribe((s) => s.endpoint === sub.endpoint);
  return res.status;
}

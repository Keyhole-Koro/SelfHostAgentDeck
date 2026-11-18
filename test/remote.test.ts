import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * Remote access as a phone would use it, against a real `agent-diff view --remote`: pairing,
 * registering a passkey, signing in, and every door it must keep shut. The passkey is a software
 * authenticator whose responses go through the real WebAuthn verification.
 */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

// ---------------------------------------------------------------- a software authenticator

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const head = (major: number, n: number): number[] => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
function cbor(v: Cbor): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return [...head(3, utf8(v).length), ...utf8(v)];
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return [...head(5, entries.length), ...entries.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}
const concat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(d)));
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat([0x30, body.length], body);
}

async function softPasskey() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64(credentialId);
  let counter = 0;
  let userHandle = "";
  const cose = new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))]]);
  const count = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  return {
    id,
    async register(o: any, origin: string) {
      userHandle = o.user.id;
      const clientData = utf8(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(o.rp.id)), [0x45], count(counter), new Uint8Array(16), [0, credentialId.length], credentialId, cbor(cose));
      const attestationObject = new Uint8Array(cbor({ fmt: "none", attStmt: {}, authData }));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ["internal"] } };
    },
    async authenticate(o: any, origin: string) {
      counter++;
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(o.rpId)), [0x05], count(counter));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new Uint8Array(concat(authData, await sha256(clientData)))));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(der(sig)), userHandle } };
    },
  };
}

// ---------------------------------------------------------------- the server and an http client

let home: string;
let state: string;
let env: NodeJS.ProcessEnv;
let server: ChildProcess;
let port = 0;
let origin = "";

function cli(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf8" });
}

interface Res {
  status: number;
  body: string;
  json: any;
  cookies: string[];
  headers: Record<string, string | string[] | undefined>;
}

/** A request as the tunnel forwards it: to 127.0.0.1, with the public Host. */
function call(method: string, path: string, opts: { body?: object; cookie?: string; headers?: Record<string, string>; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: opts.host ?? `localhost:${port}`, ...(data && { "content-type": "application/json" }), ...(opts.cookie && { cookie: opts.cookie }), ...opts.headers } },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += String(d)));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: text, json, cookies: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!), headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Headers our page sends on its requests. */
const page = () => ({ origin, "x-agent-diff": "1" });
const jar = (cookies: string[]) => cookies.filter((c) => !c.endsWith("=")).join("; ");

async function pairDevice(passkey: Awaited<ReturnType<typeof softPasskey>>, label = "Test phone"): Promise<string> {
  const url = /http:\S+\/pair\/\S+/.exec(cli("remote", "pair"))![0];
  const token = url.split("/pair/")[1]!;
  const options = await call("POST", "/auth/register/options", { body: { pairing: token, label }, headers: page() });
  assert.equal(options.status, 200, options.body);
  const verified = await call("POST", "/auth/register/verify", { body: { response: await passkey.register(options.json, origin) }, cookie: jar(options.cookies), headers: page() });
  assert.equal(verified.status, 200, verified.body);
  return jar(verified.cookies);
}

async function signIn(passkey: Awaited<ReturnType<typeof softPasskey>>): Promise<Res> {
  const options = await call("POST", "/auth/login/options", { headers: page() });
  return call("POST", "/auth/login/verify", { body: { response: await passkey.authenticate(options.json, origin) }, cookie: jar(options.cookies), headers: page() });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "adv-remote-"));
  state = join(home, "state");
  env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DIFF_STATE_DIR: state };
  const sessions = join(home, ".claude", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", cwd: home, name: "builder", status: "idle", statusUpdatedAt: Date.now() }));
  port = 47_000 + Math.floor(Math.random() * 2000);
  origin = `http://localhost:${port}`;
  server = spawn(process.execPath, [CLI, "inbox", "--view", "--port", "0", "--no-herdr", "--remote", origin, "--remote-port", String(port)], { cwd: home, env });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on("data", (d: Buffer) => String(d).includes("Remote:") && resolve());
    server.on("exit", (code) => reject(new Error(`view exited ${code}`)));
  });
});

after(() => server?.kill());

describe("remote: pairing and signing in", () => {
  let passkey: Awaited<ReturnType<typeof softPasskey>>;
  let session = "";
  beforeEach(async () => {
    passkey ??= await softPasskey();
  });

  it("sends a device without a session to the sign-in page", async () => {
    const r = await call("GET", "/");
    assert.equal(r.status, 302);
    assert.equal(r.headers["location"], "/login");
    const login = await call("GET", "/login");
    assert.match(login.body, /Sign in with a passkey/);
    assert.match(String(login.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });

  it("adds a device through a one-time pairing link", async () => {
    session = await pairDevice(passkey);
    assert.match(session, /^agent_diff_session=/);
    const inbox = await call("GET", "/api/inbox", { cookie: session, headers: page() });
    assert.equal(inbox.status, 200);
    assert.deepEqual(inbox.json.items.map((i: { key: string }) => i.key), ["claude:s1"]);
    const viewer = await call("GET", "/", { cookie: session });
    assert.match(viewer.body, /<meta name="agent-diff-mode" content="remote">/);
    assert.match(viewer.body, /<script nonce="[^"]+">/);
    assert.match(cli("remote", "devices"), /Test phone/);
    assert.equal(statSync(join(state, "remote", "passkeys.json")).mode & 0o777, 0o600, "readable by you only");
  });

  it("signs in again with the passkey", async () => {
    const r = await signIn(passkey);
    assert.equal(r.status, 200, r.body);
    const fresh = jar(r.cookies);
    assert.equal((await call("GET", "/api/inbox", { cookie: fresh, headers: page() })).status, 200);
  });

  it("logs what a device does, and stops its sessions when it is removed", async () => {
    const held = await call("POST", "/api/hold", { body: { key: "claude:s1", kind: "done" }, cookie: session, headers: page() });
    assert.equal(held.status, 200, held.body);
    assert.match(cli("remote", "log"), /Test phone\s+done claude:s1/);
    assert.match(cli("remote", "revoke", passkey.id.slice(0, 6)), /Removed Test phone/);
    assert.equal((await call("GET", "/api/inbox", { cookie: session, headers: page() })).status, 401);
    const again = await signIn(passkey);
    assert.equal(again.status, 400);
    assert.match(again.json.error, /not registered here/);
  });
});

describe("remote: closed doors", () => {
  it("does not reuse a pairing link, nor accept an expired one", async () => {
    const first = await softPasskey();
    const url = /http:\S+\/pair\/\S+/.exec(cli("remote", "pair"))![0];
    const token = url.split("/pair/")[1]!;
    const o1 = await call("POST", "/auth/register/options", { body: { pairing: token }, headers: page() });
    const ok = await call("POST", "/auth/register/verify", { body: { response: await first.register(o1.json, origin) }, cookie: jar(o1.cookies), headers: page() });
    assert.equal(ok.status, 200);
    const reuse = await call("POST", "/auth/register/options", { body: { pairing: token }, headers: page() });
    assert.equal(reuse.status, 400);
    assert.match((await call("GET", `/pair/${token}`)).body, /This link has expired/);

    const late = /http:\S+\/pair\/\S+/.exec(cli("remote", "pair"))![0].split("/pair/")[1]!;
    const file = join(state, "remote", "pairings.json");
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map((p: object) => ({ ...p, expiresAt: Date.now() - 1 }))));
    assert.equal((await call("POST", "/auth/register/options", { body: { pairing: late }, headers: page() })).status, 400);
  });

  it("rejects other hosts, other origins, requests without our header, and passkeys it does not know", async () => {
    const passkey = await softPasskey();
    const session = await pairDevice(passkey, "Second phone");
    assert.equal((await call("GET", "/login", { host: "evil.example" })).status, 403);
    assert.equal((await call("GET", "/api/inbox", { cookie: session })).status, 403, "no x-agent-diff header");
    assert.equal((await call("POST", "/api/hold", { body: { key: "claude:s1", kind: "done" }, cookie: session, headers: { origin: "https://evil.example", "x-agent-diff": "1" } })).status, 403);
    assert.equal((await call("POST", "/auth/login/options", { headers: { origin: "https://evil.example", "x-agent-diff": "1" } })).status, 403);
    assert.equal((await call("GET", "/api/inbox", { cookie: session.replace(/.$/, (c) => (c === "A" ? "B" : "A")), headers: page() })).status, 401, "a tampered cookie");
    const stranger = await softPasskey();
    const options = await call("POST", "/auth/login/options", { headers: page() });
    const r = await call("POST", "/auth/login/verify", { body: { response: await stranger.authenticate(options.json, origin) }, cookie: jar(options.cookies), headers: page() });
    assert.equal(r.status, 400);
  });

  it("adds devices only from this computer, not from a signed-in device", async () => {
    const session = await pairDevice(await softPasskey(), "Third phone");
    const r = await call("POST", "/api/remote/pair", { body: {}, cookie: session, headers: page() });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /from your computer/);
  });
});

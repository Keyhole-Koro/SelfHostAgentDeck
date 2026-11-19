import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env["AGENT_DIFF_STATE_DIR"] = mkdtempSync(join(tmpdir(), "adv-push-"));
process.env["AGENT_DIFF_PUSH_INSECURE"] = "1";
const { encrypt, send, subscribe, subscribers, vapid, vapidAuthorization } = await import("../src/push.ts");

const b = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** What a browser does with a push: the receiving side of RFC 8291. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  d.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  return { ua, auth, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

describe("web push", () => {
  it("encrypts exactly as RFC 8291's example", () => {
    const body = encrypt(
      b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      { endpoint: "https://push.example.net/x", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } },
      b("DGv6ra1nlYgDCS1FRnbzlw"),
      b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    );
    assert.equal(
      body.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("signs a VAPID token a push service can check against our public key", () => {
    const [scheme, rest] = vapidAuthorization("https://web.push.apple.com/abc", "https://agents.example.com", 1_700_000_000_000).split(" ", 2);
    assert.equal(scheme, "vapid");
    const t = /t=([^,]+)/.exec(rest! + vapidAuthorization("https://web.push.apple.com/abc", "https://agents.example.com", 1_700_000_000_000))![1]!;
    const k = /k=(\S+)$/.exec(vapidAuthorization("https://web.push.apple.com/abc", "https://agents.example.com"))![1]!;
    assert.equal(k, vapid().publicKey);
    const [h, c, sig] = t.split(".");
    assert.deepEqual(JSON.parse(b(h!).toString()), { typ: "JWT", alg: "ES256" });
    assert.deepEqual(JSON.parse(b(c!).toString()), { aud: "https://web.push.apple.com", exp: 1_700_000_000 + 12 * 3600, sub: "https://agents.example.com" });
    const pub = b(k);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    assert.equal(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, b(sig!)), true);
  });

  it("refuses subscriptions that are not a push service's", () => {
    const { keys } = browser();
    assert.throws(() => subscribe({ endpoint: "http://10.0.0.1/admin", keys }, "local", "x"), /Not a push subscription/);
    assert.throws(() => subscribe({ endpoint: "file:///etc/passwd", keys }, "local", "x"), /Not a push subscription/);
    assert.throws(() => subscribe({ endpoint: "https://push.example.net/x", keys: { p256dh: "AAAA", auth: keys.auth } }, "local", "x"), /Not a push subscription/);
  });

  it("delivers what only the browser can read, and forgets a subscription the service says is gone", async () => {
    const got: { headers: IncomingMessage["headers"]; body: Buffer }[] = [];
    let status = 201;
    const service = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      got.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status).end();
    });
    await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
    const port = (service.address() as { port: number }).port;
    const { ua, auth, keys } = browser();
    const sub = subscribe({ endpoint: `http://127.0.0.1:${port}/push/1`, keys }, "local", "This computer");
    assert.equal(await send(sub, { title: "builder asks you", body: "Which one?", tag: "claude:s1", url: "/#s=claude:s1" }, { subject: "mailto:me@example.com", urgency: "high" }), 201);
    const h = got[0]!.headers;
    assert.equal(h["content-encoding"], "aes128gcm");
    assert.equal(h["urgency"], "high");
    assert.equal(h["ttl"], "86400");
    assert.match(String(h["authorization"]), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.ok(String(h["topic"]).length <= 32);
    assert.deepEqual(JSON.parse(decrypt(got[0]!.body, ua, auth)), { title: "builder asks you", body: "Which one?", tag: "claude:s1", url: "/#s=claude:s1" });
    status = 410;
    assert.equal(await send(sub, { title: "again" }, { subject: "mailto:me@example.com" }), 410);
    assert.deepEqual(subscribers(), [], "gone from the list");
    service.close();
  });
});

import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { tempDir } from "./tmp.ts";

process.env["AGENT_DECK_STATE_DIR"] = tempDir("adv-push-");
process.env["AGENT_DECK_PUSH_INSECURE"] = "1";
const { encrypt, send, subscribe, subscribers, vapid, vapidAuthorization } = await import("../src/push.ts");
const { browser, decrypt, pushService } = await import("./push-browser.ts");

const b = (s: string) => Buffer.from(s, "base64url");

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
    const service = await pushService();
    const got = service.got;
    const port = Number(new URL(service.url).port);
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
    service.status.code = 410;
    assert.equal(await send(sub, { title: "again" }, { subject: "mailto:me@example.com" }), 410);
    assert.deepEqual(subscribers(), [], "gone from the list");
    service.close();
  });
});

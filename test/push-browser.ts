import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";

/** Test helpers: a browser's side of Web Push (its keys, decrypting), and a push service that records. */

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  return { ua, auth, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

/** RFC 8291's receiving side. */
export function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
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

export async function pushService(): Promise<{ url: string; got: { path: string; headers: IncomingHttpHeaders; body: Buffer }[]; status: { code: number }; close: () => void }> {
  const got: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const status = { code: 201 };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(status.code).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, got, status, close: () => server.close() };
}

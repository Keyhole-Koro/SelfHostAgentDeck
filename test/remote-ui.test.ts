import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Run inside herdr or not, the processes these tests start must not inherit a real herdr pane.
delete process.env["HERDR_PANE_ID"];
delete process.env["HERDR_SOCKET_PATH"];

/**
 * Remote access in a real browser: Chromium with a virtual authenticator (DevTools' WebAuthn
 * domain) pairs through the link, makes a passkey, uses the page, signs out and back in. Skipped
 * when Chromium cannot start.
 */

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
/** The page's own helper, called from page.evaluate. */
declare const post: (path: string, body: object) => Promise<unknown>;

let chromium: typeof import("playwright").chromium | undefined;
try {
  ({ chromium } = await import("playwright"));
  await (await chromium.launch()).close();
} catch {
  chromium = undefined;
}

describe("remote page", { skip: !chromium && "no browser" }, () => {
  const home = mkdtempSync(join(tmpdir(), "adv-rui-"));
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", XDG_STATE_HOME: "", AGENT_DECK_STATE_DIR: join(home, "state") };
  const port = 49_000 + Math.floor(Math.random() * 900);
  const origin = `http://localhost:${port}`;
  let server: ChildProcess;
  let localUrl = "";
  let browser: import("playwright").Browser;
  let page: import("playwright").Page;
  const errors: string[] = [];

  before(async () => {
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", cwd: home, name: "builder", status: "waiting", waitingFor: "input needed", statusUpdatedAt: Date.now() }));
    server = spawn(process.execPath, [CLI, "inbox", "--view", "--port", "0", "--no-herdr", "--remote", origin, "--remote-port", String(port)], { cwd: home, env });
    localUrl = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (d: Buffer) => {
        out += String(d);
        if (out.includes("Remote:")) resolve(/http:\/\/127\.0\.0\.1\S+/.exec(out)![0]);
      });
      server.on("exit", (code) => reject(new Error(`view exited ${code}`)));
    });
    browser = await chromium!.launch();
    page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // a phone
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  });

  after(async () => {
    await browser?.close();
    server?.kill();
  });

  it("pairs through the link and lands on the sessions", async () => {
    const link = /http:\S+\/pair\/\S+/.exec(execFileSync(process.execPath, [CLI, "remote", "pair"], { cwd: home, env, encoding: "utf8" }))![0];
    await page.goto(link);
    await page.fill("#label", "Test phone");
    await page.click('[data-passkey="register"]');
    await page.waitForURL(`${origin}/`);
    await page.waitForSelector('.session[data-key="claude:s1"]');
    assert.match(await page.locator("#summary").innerText(), /1 needs an answer/);
  });

  it("lists this device under Remote, and signs out and back in with the passkey", async () => {
    await page.click("#more > summary");
    await page.click("#remote");
    await page.waitForSelector("text=(this one)");
    assert.match(await page.locator("#special").innerText(), /Test phone \(this one\)/);
    await page.click('[data-remote="logout"]');
    await page.waitForURL(`${origin}/login`);
    await page.click('[data-passkey="login"]');
    await page.waitForURL(`${origin}/`);
    await page.waitForSelector('.session[data-key="claude:s1"]');
  });

  it("asks for the passkey before acting from the phone, then sends", async () => {
    const all = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(all.filter((c) => c.name !== "agent_deck_confirmed"));
    const sent = page.evaluate(() => post("/api/herdr/prompt", { key: "claude:s1", text: "hi" }).then(() => "sent", (e: Error) => e.message));
    await page.waitForSelector("#confirm[open]");
    await page.click("#confirm-go");
    assert.match(await sent, /herdr pane/, "past the check, it fails on herdr (off here) instead");
    assert.equal(await page.locator("#confirm[open]").count(), 0);
  });

  it("shows a QR code to add a phone, on this computer's page only", async () => {
    const local = await browser.newPage();
    await local.goto(localUrl);
    await local.click("#more > summary");
    await local.click("#remote");
    await local.click('[data-remote="pair"]');
    await local.waitForSelector(".pair svg");
    assert.match(await local.locator(".pair").innerText(), new RegExp(`${origin}/pair/`));
    await local.close();
    assert.equal(await page.locator('[data-remote="pair"]').count(), 0, "a signed-in device cannot add others");
  });

  it("logged no errors", () => {
    assert.deepEqual(errors, []);
  });
});

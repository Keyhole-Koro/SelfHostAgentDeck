import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// The home folder decides which roots are refused: keep it a made-up one.
const home = realpathSync(mkdtempSync(join(tmpdir(), "adv-files-home-")));
process.env.HOME = home;
const { FileError, filesRoot, image, look, secret } = await import("../src/files.ts");

const repo = join(home, "code", "app");
const outside = join(home, "elsewhere");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(repo, ".git", "config"), "[core]");
writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "README.md"), "# App\n");
writeFileSync(join(repo, ".env"), "TOKEN=abc");
writeFileSync(join(repo, ".env.example"), "TOKEN=");
writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
writeFileSync(join(repo, "data.bin"), Buffer.from([1, 2, 0, 3]));
writeFileSync(join(repo, "big.log"), "x".repeat(600 * 1024));
writeFileSync(join(outside, "notes.txt"), "private");
symlinkSync(outside, join(repo, "link-out"));
symlinkSync(join(repo, "src"), join(repo, "link-in"));

const fails = (fn: () => unknown, status: number, message: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof FileError && e.status === status && message.test(e.message));

describe("files a session's page may open", () => {
  it("confines a session to its repository, and refuses a session in the home folder", () => {
    assert.equal(filesRoot(join(repo, "src"), repo), repo);
    assert.equal(filesRoot(outside, null), outside, "its own folder outside a repository");
    assert.equal(filesRoot(home, null), undefined);
    assert.equal(filesRoot("/", null), undefined);
    assert.equal(filesRoot(join(home, "gone"), null), undefined);
  });

  it("lists a folder: folders first, without git's files or secrets", () => {
    const v = look(repo, repo, "");
    assert.equal(v.kind, "dir");
    if (v.kind !== "dir") return;
    assert.deepEqual(
      v.entries.map((e) => `${e.name}${e.dir ? "/" : ""}`),
      ["link-in/", "link-out/", "src/", ".env.example", "big.log", "data.bin", "logo.png", "README.md"],
    );
    assert.equal(v.entries.find((e) => e.name === "README.md")?.size, 6);
  });

  it("reads text, Markdown, images and binaries for what they are", () => {
    const a = look(repo, join(repo, "src"), "a.ts");
    assert.deepEqual([a.kind, a.rel, (a as { text?: string }).text], ["text", "src/a.ts", "export const a = 1;\n"]);
    assert.equal(look(repo, repo, "README.md").kind, "markdown");
    assert.deepEqual([look(repo, repo, "logo.png").kind, (look(repo, repo, "logo.png") as { type?: string }).type], ["image", "image/png"]);
    assert.equal(look(repo, repo, "data.bin").kind, "binary");
    const big = look(repo, repo, "big.log") as { text: string; truncated?: boolean };
    assert.equal(big.text.length, 512 * 1024);
    assert.equal(big.truncated, true);
    assert.equal(image(repo, repo, "logo.png").type, "image/png");
    fails(() => image(repo, repo, "README.md"), 400, /Only images/);
  });

  it("finds a path given from the session's folder, from the root, or with a line number", () => {
    assert.equal(look(repo, join(repo, "src"), "README.md").rel, "README.md");
    assert.equal(look(repo, repo, "src/a.ts:12").rel, "src/a.ts");
    assert.equal(look(repo, repo, `${repo}/src/a.ts:1:4`).rel, "src/a.ts");
    assert.equal(look(repo, repo, "link-in/a.ts").rel, "src/a.ts", "a link that stays inside");
  });

  it("refuses paths out of the repository, git's files and secrets", () => {
    fails(() => look(repo, repo, "../../elsewhere/notes.txt"), 403, /repository/);
    fails(() => look(repo, repo, join(outside, "notes.txt")), 403, /repository/);
    fails(() => look(repo, repo, "link-out/notes.txt"), 403, /repository/);
    fails(() => look(repo, repo, ".git/config"), 403, /git/);
    fails(() => look(repo, repo, ".env"), 403, /secrets/);
    fails(() => look(repo, repo, "nope.ts"), 404, /No such/);
    assert.equal(look(repo, repo, ".env.example").kind, "text");
  });

  it("knows the usual secret files", () => {
    for (const n of [".env", ".env.production", ".dev.vars", "server.pem", "tls.key", "id_ed25519", "id_rsa.pub", ".npmrc", "credentials.json", ".credentials.json", "service-account-prod.json", "secrets.yaml", "prod.tfvars", "terraform.tfstate"]) assert.equal(secret(n), true, n);
    for (const n of [".envrc", ".envrc.local", ".git-credentials", "AuthKey_ABC123DEFG.p8", "deploy.ppk", "prod.tfvars.json", ".terraformrc", "terraform.rc", "client_secret.json", "client_secret_123-abc.apps.googleusercontent.com.json", "client_secrets.json", "application_default_credentials.json", "my-app-firebase-adminsdk-ab12c-0123456789.json"]) assert.equal(secret(n), true, n);
    for (const n of [".env.example", "env.ts", "keyboard.ts", "credential.ts", "secret-santa.md", "README.md"]) assert.equal(secret(n), false, n);
    for (const n of [".envrc.example", "envrc.md", "git-credential.ts", "main.tf", "variables.tf", ".terraform.lock.hcl", "client.json", "firebase.json", ".firebaserc", "default_credentials.md"]) assert.equal(secret(n), false, n);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

/**
 * The attribution worker holds every transcript it has parsed, so a page left running all day
 * lets it go when nobody looks. The worker reads transcripts under HOME: keep it in an empty one.
 */

process.env.HOME = mkdtempSync(join(tmpdir(), "adv-worker-"));
process.env.CLAUDE_CONFIG_DIR = "";
process.env.CODEX_HOME = "";
const { attributionWorker } = await import("../src/server.ts");

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

it("stops the attribution worker when it sits idle, and starts a new one for the next call", async () => {
  const ask = attributionWorker(100);
  assert.equal(ask.running(), false, "not started before the first call");
  await ask({ op: "warm", days: 30 });
  assert.equal(ask.running(), true);
  await until(() => !ask.running());
  assert.equal(ask.running(), false, "stopped after sitting idle");
  await ask({ op: "warm", days: 30 });
  assert.equal(ask.running(), true, "a new worker answered");
});

it("keeps the worker while calls keep coming", async () => {
  const ask = attributionWorker(300);
  for (let i = 0; i < 5; i++) {
    await ask({ op: "warm", days: 30 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ask.running(), true, `still running after call ${i + 1}`);
  }
});

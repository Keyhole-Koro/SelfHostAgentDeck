import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test helper: folders in the system's temporary one that go away when the test file's process ends. */

const made: string[] = [];

process.on("exit", () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A process a test started may still be writing there: leave it rather than fail the tests.
    }
  }
});

/** As mkdtempSync(join(tmpdir(), prefix)), and removed at exit: /tmp is often memory, and every run adds to it. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

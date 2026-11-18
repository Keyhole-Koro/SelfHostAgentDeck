import { statSync } from "node:fs";
import type { Transcripts } from "./types.ts";

/**
 * Transcripts are large (GBs over a month) and mostly unchanged between looks. Each file is parsed
 * once per size and modification time and its result kept, so a long-running viewer only re-reads
 * the transcripts that changed. Parsing a file on its own and merging afterwards gives the same
 * sessions as parsing them all into one place: the earliest start, the latest activity, the first
 * title.
 */

interface Parsed {
  size: number;
  mtimeMs: number;
  t: Transcripts;
}

const caches = new Map<string, Map<string, Parsed>>();

export function readCached(kind: string, files: string[], parse: (file: string, into: Transcripts) => void, into: Transcripts): void {
  let cache = caches.get(kind);
  if (!cache) caches.set(kind, (cache = new Map()));
  for (const file of files) {
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(file));
    } catch {
      continue;
    }
    let hit = cache.get(file);
    if (!hit || hit.size !== size || hit.mtimeMs !== mtimeMs) {
      const t: Transcripts = { sessions: new Map(), events: [], shells: [] };
      parse(file, t);
      hit = { size, mtimeMs, t };
      cache.set(file, hit);
    }
    for (const [key, s] of hit.t.sessions) {
      const cur = into.sessions.get(key);
      if (!cur) into.sessions.set(key, { ...s });
      else {
        cur.firstAt = Math.min(cur.firstAt, s.firstAt);
        cur.lastAt = Math.max(cur.lastAt, s.lastAt);
        cur.title ||= s.title;
      }
    }
    for (const e of hit.t.events) into.events.push(e);
    for (const s of hit.t.shells) into.shells.push(s);
  }
}

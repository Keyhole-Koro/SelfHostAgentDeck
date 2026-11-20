import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "./holds.ts";

/**
 * Your other computers' Agent Deck pages, to switch to from this one. The computers do not talk
 * to each other: each runs its own Agent Deck, and the page only links to the others, so you
 * sign in to each with its own passkey. Kept on this computer, so every device sees the same list.
 */

export type Machine = { name: string; url: string };

const file = () => join(stateDir(), "machines.json");
const MAX = 20;

type Saved = { self?: string; others: Machine[] };

function read(): Saved {
  try {
    const saved = JSON.parse(readFileSync(file(), "utf8")) as Partial<Saved>;
    const others = Array.isArray(saved.others) ? saved.others.flatMap((m) => (cleanMachine(m) ? [cleanMachine(m)!] : [])) : [];
    return { ...(typeof saved.self === "string" && saved.self.trim() && { self: saved.self.trim().slice(0, 40) }), others };
  } catch {
    return { others: [] };
  }
}

/** This computer's name: the one you gave it, or its host name. */
export function thisMachine(): string {
  return read().self || process.env["AGENT_DECK_MACHINE_NAME"] || hostname().split(".")[0] || "This computer";
}

export function readMachines(): Machine[] {
  return read().others;
}

/** A name and a web address (http or https), or nothing. */
export function cleanMachine(m: unknown): Machine | undefined {
  if (!m || typeof m !== "object") return undefined;
  const name = String((m as Machine).name ?? "").trim().slice(0, 40);
  let url: URL;
  try {
    url = new URL(String((m as Machine).url ?? "").trim());
  } catch {
    return undefined;
  }
  if (!name || url.username || url.password) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // A page's address, without a token or a session in it: those are this browser's, not the list's.
  url.hash = "";
  return { name, url: url.toString() };
}

export function saveMachines(list: unknown, self?: unknown): Machine[] {
  if (!Array.isArray(list)) throw new Error("A list of computers, please.");
  if (list.length > MAX) throw new Error(`At most ${MAX} computers.`);
  const clean = list.map((m) => {
    const c = cleanMachine(m);
    if (!c) throw new Error("Each computer needs a name and a web address (https://…).");
    return c;
  });
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  const name = typeof self === "string" ? self.trim().slice(0, 40) : read().self;
  writeFileSync(tmp, JSON.stringify({ ...(name && { self: name }), others: clean }, null, 2) + "\n");
  renameSync(tmp, file());
  return clean;
}

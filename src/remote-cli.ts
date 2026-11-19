import { renderUnicodeCompact } from "uqr";
import { createPairing, listPasskeys, readAudit, removePasskey, savedOrigin } from "./remote.ts";
import { bold, dim, when } from "./term.ts";

/** `agent-deck remote …`: pair a phone, list and remove devices, read what they did. */

export function remoteCommand(sub: string | undefined, arg: string | undefined, origin: string | undefined): void {
  switch (sub) {
    case "pair": {
      const o = origin ?? savedOrigin();
      if (!o) throw new Error("No public origin yet: start agent-deck view --remote https://agents.example.com once, or pass --origin.");
      const { url, expiresAt } = createPairing(o);
      console.log(`Open this on the device to add, within 10 minutes (it works once):\n\n  ${url}\n`);
      console.log(renderUnicodeCompact(url, { border: 1 }));
      console.log(dim(`\nExpires ${new Date(expiresAt).toLocaleTimeString()}. The device then makes a passkey for ${new URL(o).host}.`));
      return;
    }
    case "devices": {
      const list = listPasskeys();
      if (!list.length) return void console.log("No devices yet. Add one with: agent-deck remote pair");
      for (const p of list) console.log(`  ${bold(p.label)}  ${dim(p.id.slice(0, 10))}  added ${when(p.createdAt)}${p.lastUsedAt ? `, last used ${when(p.lastUsedAt)}` : ""}`);
      return;
    }
    case "revoke": {
      if (!arg) throw new Error("Usage: agent-deck remote revoke <device id prefix>");
      const hits = listPasskeys().filter((p) => p.id.startsWith(arg));
      if (hits.length !== 1) throw new Error(hits.length ? `"${arg}" matches ${hits.length} devices; give more of the id.` : `No device matches "${arg}". agent-deck remote devices lists them.`);
      removePasskey(hits[0]!.id);
      return void console.log(`Removed ${hits[0]!.label}; its sessions end now.`);
    }
    case "log": {
      const events = readAudit(100);
      if (!events.length) return void console.log("Nothing done remotely yet.");
      for (const e of events.reverse()) console.log(`${dim(when(e.at))}  ${bold(e.device)}  ${e.action}${e.target ? ` ${e.target}` : ""}${e.detail ? dim(`  ${e.detail.replace(/\s+/g, " ").slice(0, 100)}`) : ""}`);
      return;
    }
    default:
      throw new Error("Usage: agent-deck remote pair | devices | revoke <id> | log");
  }
}

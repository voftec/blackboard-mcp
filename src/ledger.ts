import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LEDGER_FILE = process.env.BLACKBOARD_LEDGER_FILE ?? join(homedir(), ".blackboard-mcp", "checks.json");

/** What the agent has already reported to the user, so "new" can mean "new since you last asked". */
export interface Ledger {
  lastBriefingAt?: string;
  /** contentId / message id / announcement id -> first time it was reported. */
  seen: Record<string, string>;
}

export function loadLedger(): Ledger {
  if (!existsSync(LEDGER_FILE)) return { seen: {} };
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Partial<Ledger>;
    return { lastBriefingAt: parsed.lastBriefingAt, seen: parsed.seen ?? {} };
  } catch {
    return { seen: {} };
  }
}

export function saveLedger(ledger: Ledger): void {
  mkdirSync(dirname(LEDGER_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

/** Marks ids as reported; returns the ones that had never been reported before. */
export function noteSeen(ledger: Ledger, ids: string[], at: string): string[] {
  const fresh = ids.filter((id) => !ledger.seen[id]);
  for (const id of fresh) ledger.seen[id] = at;
  return fresh;
}

export const ledgerFile = LEDGER_FILE;

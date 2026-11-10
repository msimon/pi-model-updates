// ~/.pi/agent/model-updates.json: the extension's own file. Holds the daily
// check stamp and its result (so the footer status survives /reload without a
// rescan), the ignore list, and `extraPaths` you edit by hand.

import { readFile, rename, writeFile } from "node:fs/promises";
import type { IgnoreEntry, Summary } from "./findings.ts";
import type { GitMode } from "./git.ts";

export interface State {
  /** Extra files or folders to scan as editable, `~` allowed. Edited by hand. */
  extraPaths?: string[];
  ignored?: IgnoreEntry[];
  /** After applying: commit and push edited files in git repos (default), only commit, or leave them. Edited by hand. */
  git?: GitMode;
  /** Local date (YYYY-MM-DD) of the last check; the startup check runs once per day. */
  lastCheckDay?: string;
  lastCheckAt?: string;
  summary?: Summary;
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toState(raw: unknown): State {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const s: State = {};
  if (Array.isArray(r.extraPaths)) s.extraPaths = r.extraPaths.filter((p): p is string => typeof p === "string");
  if (Array.isArray(r.ignored)) {
    s.ignored = r.ignored.filter(
      (i): i is IgnoreEntry => !!i && typeof i === "object" && typeof (i as IgnoreEntry).key === "string" && typeof (i as IgnoreEntry).target === "string",
    );
  }
  if (r.git === "push" || r.git === "commit" || r.git === "off") s.git = r.git;
  if (typeof r.lastCheckDay === "string") s.lastCheckDay = r.lastCheckDay;
  if (typeof r.lastCheckAt === "string") s.lastCheckAt = r.lastCheckAt;
  const sum = r.summary as Partial<Summary> | undefined;
  if (sum && typeof sum.updates === "number" && typeof sum.missing === "number") s.summary = { updates: sum.updates, missing: sum.missing };
  return s;
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export async function loadState(path: string): Promise<State> {
  return toState(await readRaw(path));
}

/** Merge `patch` into the file, keeping keys it does not own and their order. */
export async function saveState(path: string, patch: Partial<State>): Promise<void> {
  const current = await readRaw(path);
  const next = { ...current, ...patch };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

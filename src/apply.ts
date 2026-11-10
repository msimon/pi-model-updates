// Turn chosen findings into edits, render them as a diff, and write them.
//
// Edits are exact replacements at the offsets the scan recorded. A file is
// only written when its content still hashes to what was scanned, so nothing
// changed in between is ever clobbered. The edit and diff helpers are pure.

import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import type { Finding } from "./findings.ts";
import { lineStarts, sha256 } from "./scan.ts";

export interface TextEdit {
  offset: number;
  length: number;
  replacement: string;
}

/** Apply non-overlapping edits. Throws on overlap. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  let out = text;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.offset + e.length > limit) throw new Error(`overlapping edits at offset ${e.offset}`);
    out = out.slice(0, e.offset) + e.replacement + out.slice(e.offset + e.length);
    limit = e.offset;
  }
  return out;
}

const INLINE_WS = /[ \t]/;

/**
 * Remove a JSON array string element whose content starts at `offset` (inside
 * the quotes), keeping the surrounding layout: a one-per-line element takes its
 * whole line with it, an inline one takes its comma and following space, the
 * last element takes the comma before it.
 */
export function removeArrayElementEdit(text: string, offset: number, length: number): TextEdit {
  let s = offset - 1; // opening quote
  let e = offset + length + 1; // after closing quote
  if (text[s] !== '"' || text[e - 1] !== '"') throw new Error("not a quoted JSON string");
  let j = e;
  while (j < text.length && /\s/.test(text[j]!)) j++;
  if (text[j] === ",") {
    let k = j + 1;
    while (k < text.length && INLINE_WS.test(text[k]!)) k++;
    let ls = s;
    while (ls > 0 && INLINE_WS.test(text[ls - 1]!)) ls--;
    if ((ls === 0 || text[ls - 1] === "\n") && (text[k] === "\n" || (text[k] === "\r" && text[k + 1] === "\n"))) {
      s = ls;
      e = text[k] === "\r" ? k + 2 : k + 1;
    } else {
      e = k;
    }
  } else {
    let p = s - 1;
    while (p >= 0 && /\s/.test(text[p]!)) p--;
    if (text[p] === ",") s = p;
    else if (text[p] === "[") {
      s = p + 1;
      e = j;
    }
  }
  return { offset: s, length: e - s, replacement: "" };
}

/** Edits for one file's findings. Throws if a finding's text is no longer at its offset. */
export function editsFor(text: string, findings: readonly Finding[]): TextEdit[] {
  return findings.map((f) => {
    const { offset, text: old } = f.pin;
    if (text.slice(offset, offset + old.length) !== old) {
      throw new Error(`${f.pin.where}: "${old}" is no longer at line ${f.pin.line}`);
    }
    if (f.newText === undefined) throw new Error(`${f.pin.where}: no replacement chosen`);
    if (f.remove) return removeArrayElementEdit(text, offset, old.length);
    return { offset, length: old.length, replacement: f.newText };
  });
}

/** `-`/`+` hunks for the lines the edits touch, labelled `path:line`. */
export function renderDiff(label: string, text: string, edits: readonly TextEdit[]): string {
  const starts = lineStarts(text);
  const lineIdx = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const spans = [...edits]
    .sort((a, b) => a.offset - b.offset)
    .map((e) => ({ e, first: lineIdx(e.offset), last: lineIdx(Math.max(e.offset, e.offset + e.length - 1)) }));
  const groups: Array<{ first: number; last: number; edits: TextEdit[] }> = [];
  for (const s of spans) {
    const g = groups[groups.length - 1];
    if (g && s.first <= g.last + 1) {
      g.last = Math.max(g.last, s.last);
      g.edits.push(s.e);
    } else {
      groups.push({ first: s.first, last: s.last, edits: [s.e] });
    }
  }
  const out = [`--- ${label}`];
  for (const g of groups) {
    const from = starts[g.first]!;
    const to = starts[g.last + 1] ?? text.length;
    const oldBlock = text.slice(from, to);
    const newBlock = applyTextEdits(
      oldBlock,
      g.edits.map((e) => ({ ...e, offset: e.offset - from })),
    );
    const lines = (b: string) => (b === "" ? [] : b.replace(/\r?\n$/, "").split(/\r?\n/));
    out.push(`@@ line ${g.first + 1}`);
    for (const l of lines(oldBlock)) out.push(`- ${l}`);
    for (const l of lines(newBlock)) out.push(`+ ${l}`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------ file writes

/**
 * Hold `<path>.lock` while running `fn`, the same lock directory pi's settings
 * manager takes (proper-lockfile), so a concurrent pi write cannot interleave.
 * A lock older than 10 s is stale and taken over, as proper-lockfile does.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 10_000) {
          await rmdir(lock);
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (attempt >= 50) throw new Error(`${path} is locked by another process`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

export interface FilePlan {
  file: string;
  label: string;
  findings: Finding[];
  edits: TextEdit[];
  hash: string;
  diff: string;
}

/** Group file-edit findings by file and check each file is unchanged since the scan. */
export async function planFileEdits(findings: readonly Finding[], label: (file: string) => string): Promise<{ plans: FilePlan[]; errors: string[] }> {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.pin.file) ?? [];
    list.push(f);
    byFile.set(f.pin.file, list);
  }
  const plans: FilePlan[] = [];
  const errors: string[] = [];
  for (const [file, fs] of byFile) {
    try {
      const text = await readFile(file, "utf8");
      const hash = sha256(text);
      if (fs.some((f) => f.pin.fileHash !== hash)) throw new Error("changed since the scan; run /models-update again");
      const edits = editsFor(text, fs);
      plans.push({ file, label: label(file), findings: fs, edits, hash, diff: renderDiff(label(file), text, edits) });
    } catch (err) {
      errors.push(`${label(file)}: ${(err as Error).message}`);
    }
  }
  return { plans, errors };
}

/** Write one planned file in place (mode and inode kept), re-checking its hash under the lock. */
export async function writeFilePlan(plan: FilePlan): Promise<void> {
  await withFileLock(plan.file, async () => {
    const text = await readFile(plan.file, "utf8");
    if (sha256(text) !== plan.hash) throw new Error("changed since the scan; run /models-update again");
    await writeFile(plan.file, applyTextEdits(text, plan.edits), "utf8");
  });
}

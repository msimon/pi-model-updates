// Turn scanned pins plus the model catalog into the list /models-update shows.
// Pure and unit-tested.

import { formatModelRef, suggest, type CatalogModel } from "./families.ts";
import type { Pin } from "./scan.ts";

export interface IgnoreEntry {
  key: string;
  /** Target that was ignored; "" for a missing pin with no suggestion. A different target shows again. */
  target: string;
}

export type FindingStatus = "update" | "missing" | "ambiguous";

export interface Finding {
  pin: Pin;
  status: FindingStatus;
  /** The pinned id is not in the catalog. */
  missing: boolean;
  provider?: string;
  /** Providers to choose from when `ambiguous`. */
  candidates: string[];
  /** Suggested (or hand-picked) model id. */
  target?: string;
  /** Replacement text for `pin.text`. */
  newText?: string;
  /** `enabledModels`: the replacement is already listed, so the entry is removed instead. */
  remove: boolean;
  ignored: boolean;
}

/** Replacement text in the same form as the pin: `provider/` prefix and `:thinking` suffix kept. */
export function newTextFor(pin: Pin, provider: string | undefined, targetId: string): string {
  return formatModelRef({ ...(provider ? { provider } : {}), modelId: targetId, ...(pin.ref.suffix ? { suffix: pin.ref.suffix } : {}) }, pin.qualified);
}

function listKey(text: string): string {
  return text.split(":")[0]!;
}

export function buildFindings(pins: readonly Pin[], catalog: readonly CatalogModel[], ignored: readonly IgnoreEntry[] = []): Finding[] {
  const findings: Finding[] = [];
  // enabledModels entries per file, including replacements planned so far
  const listed = new Map<string, Set<string>>();
  for (const p of pins) {
    if (!p.listEntry) continue;
    const set = listed.get(p.file) ?? new Set<string>();
    set.add(listKey(p.text));
    listed.set(p.file, set);
  }

  for (const pin of pins) {
    const s = suggest(pin.ref, catalog, pin.providerHint);
    let status: FindingStatus;
    if (s.status === "current") continue;
    if (s.status === "unknown") {
      if (!pin.strict) continue;
      status = "missing";
    } else {
      status = s.status;
    }
    const f: Finding = {
      pin,
      status,
      missing: s.missing,
      candidates: s.candidates,
      remove: false,
      ignored: false,
    };
    if (s.provider) f.provider = s.provider;
    if (s.target) {
      f.target = s.target;
      f.newText = newTextFor(pin, s.provider, s.target);
      if (pin.listEntry) {
        const set = listed.get(pin.file)!;
        if (set.has(listKey(f.newText))) f.remove = true;
        else set.add(listKey(f.newText));
      }
    }
    f.ignored = ignored.some((i) => i.key === pin.key && i.target === (f.target ?? ""));
    findings.push(f);
  }
  return findings;
}

/**
 * Apply a hand-picked target. For an `enabledModels` entry, re-check against
 * what the list will contain afterwards (every other entry in the file, with
 * the replacements already planned), so a pick never creates a duplicate.
 */
export function setManualTarget(findings: Finding[], f: Finding, model: CatalogModel, pins: readonly Pin[]): void {
  f.target = model.id;
  f.provider = model.provider;
  f.newText = newTextFor(f.pin, model.provider, model.id);
  f.remove = false;
  if (!f.pin.listEntry) return;
  const byPin = new Map(findings.map((o) => [o.pin, o]));
  const after = new Set<string>();
  for (const p of pins) {
    if (p === f.pin || !p.listEntry || p.file !== f.pin.file) continue;
    const o = byPin.get(p);
    if (o?.remove) continue;
    after.add(listKey(o?.newText ?? p.text));
  }
  if (after.has(listKey(f.newText))) f.remove = true;
}

export interface Summary {
  updates: number;
  missing: number;
}

/** Counts behind the footer status. Ignored and read-only findings do not count. */
export function summarize(findings: readonly Finding[]): Summary {
  let updates = 0;
  let missing = 0;
  for (const f of findings) {
    if (f.ignored || !f.pin.editable) continue;
    if (f.status === "update") updates++;
    else missing++;
  }
  return { updates, missing };
}

export function statusText(s: Summary): string | undefined {
  const parts: string[] = [];
  if (s.updates) parts.push(`${s.updates} update${s.updates === 1 ? "" : "s"}`);
  if (s.missing) parts.push(`${s.missing} missing`);
  return parts.length ? `models: ${parts.join(" · ")}` : undefined;
}

export function noticeText(s: Summary): string | undefined {
  const parts: string[] = [];
  if (s.updates) parts.push(`${s.updates} pinned model${s.updates === 1 ? " can" : "s can"} move to a newer model`);
  if (s.missing) parts.push(`${s.missing} ${s.missing === 1 ? "is" : "are"} missing from the catalog`);
  return parts.length ? `Model pins: ${parts.join(", ")}. Run /models-update.` : undefined;
}

/** One-line description of a finding for the picker. */
export function describe(f: Finding): string {
  const old = f.pin.text;
  let arrow: string;
  if (f.remove && f.newText) arrow = `${old} → remove (${f.newText} already listed)`;
  else if (f.newText) arrow = `${old} → ${f.newText}`;
  else if (f.status === "ambiguous") arrow = `${old} (provider unclear: ${f.candidates.join(", ")}) → pick…`;
  else arrow = `${old} (not in catalog) → pick…`;
  const flags = [f.missing && f.newText ? "not in catalog" : "", f.ignored ? "ignored" : "", f.pin.editable ? "" : "read-only package"].filter(Boolean);
  return `${arrow} · ${f.pin.where}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

/** `owner/repo` of a managed git package checkout (`…/git/<host>/<owner>/<repo>/…`). */
export function packageName(file: string): string {
  const m = /[\\/]git[\\/][^\\/]+[\\/]([^\\/]+[\\/][^\\/]+)[\\/]/.exec(file);
  return m ? m[1]!.replace(/\\/g, "/") : file;
}

/** Read-only package findings, one group per package, for a single summary row each. */
export function groupReadOnly(findings: readonly Finding[]): Array<{ name: string; findings: Finding[] }> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.pin.editable) continue;
    const name = packageName(f.pin.file);
    groups.set(name, [...(groups.get(name) ?? []), f]);
  }
  return [...groups].map(([name, fs]) => ({ name, findings: fs }));
}

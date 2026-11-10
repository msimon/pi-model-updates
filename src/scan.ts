// Find every place the setup pins a model. Reads only.
//
// The text scanners (`scanSettings`, `scanCron`, `scanJsonConfig`, `scanAgent`,
// `scanSource`, `scanDoc`) are pure and unit-tested; `collectPins` walks the
// file system and feeds them.

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { parseModelId, parseModelRef, type ModelRef } from "./families.ts";

export type PinKind = "settings" | "cron" | "config" | "agent" | "source" | "doc" | "package";

export interface Pin {
  /** Stable identity used by the ignore list. */
  key: string;
  kind: PinKind;
  file: string;
  /** 1-based line of `text`. */
  line: number;
  /** Character offset of `text` in the file. */
  offset: number;
  /** Exact text that a replacement swaps out (without quotes). */
  text: string;
  ref: ModelRef;
  /** The text itself carries `provider/`. */
  qualified: boolean;
  /** Provider read from a nearby `provider: "..."` when the id is bare. */
  providerHint?: string;
  /** Human label: `settings.json enabledModels`, `cron job x`, `~/path:12`. */
  where: string;
  jobId?: string;
  /** An `enabledModels` entry: dropped instead of duplicated when its replacement is already listed. */
  listEntry?: boolean;
  /** Definite config pin: flag it as missing even when the id shape is unknown. */
  strict: boolean;
  /** False for managed package checkouts: shown, never edited. */
  editable: boolean;
  /** sha256 of the file content the pin was found in. */
  fileHash: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type JsonRecord = Record<string, unknown>;

function parseOrThrow(text: string): JsonRecord | JsonRecord[] | null {
  try {
    return JSON.parse(text) as JsonRecord | JsonRecord[] | null;
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
}

/** Parse a JSON object (settings.json); anything else becomes `{}`. Throws a readable error on bad JSON. */
export function parseJsonObject(text: string): JsonRecord {
  const v = parseOrThrow(text);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Parse a JSON array of objects (jobs.json); anything else becomes `[]`. Throws a readable error on bad JSON. */
export function parseJsonArray(text: string): JsonRecord[] {
  const v = parseOrThrow(text);
  return Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x : {})) : [];
}

// ------------------------------------------------------------ text helpers

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface JsonString {
  path: Array<string | number>;
  value: string;
  /** Offset of the first character inside the quotes. */
  offset: number;
}

/**
 * Every string value in a JSON document with its path and position. Strings
 * containing escapes are skipped (model ids never have any), so `value` is
 * always exactly the raw text at `offset`. Throws on malformed JSON.
 */
export function jsonStrings(text: string): JsonString[] {
  const out: JsonString[] = [];
  let i = 0;
  const ws = () => {
    while (i < text.length && /[\s\uFEFF]/.test(text[i]!)) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(`${msg} at offset ${i}`);
  };
  const str = (): { value: string; start: number; escaped: boolean } => {
    if (text[i] !== '"') fail("expected string");
    const start = ++i;
    let escaped = false;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        escaped = true;
        i++;
      }
      i++;
    }
    if (i >= text.length) fail("unterminated string");
    const raw = text.slice(start, i++);
    // Escaped strings are skipped by the caller, so their decoded value is never needed.
    return { value: raw, start, escaped };
  };
  const value = (path: Array<string | number>): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        if (text[i++] !== ":") fail("expected ':'");
        value([...path, k.value]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        fail("expected ',' or '}'");
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        value([...path, n]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        fail("expected ',' or ']'");
      }
    } else if (c === '"') {
      const s = str();
      if (!s.escaped) out.push({ path, value: s.value, offset: s.start });
    } else {
      const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
      if (!m) fail("unexpected token");
      i += m![0].length;
    }
  };
  value([]);
  ws();
  if (i < text.length) fail("trailing content");
  return out;
}

interface PinInput {
  file: string;
  text: string;
  label: string;
  hash?: string;
}

function makePin(
  input: PinInput,
  starts: number[],
  p: Omit<Pin, "file" | "line" | "fileHash" | "qualified" | "ref" | "where"> & { ref: ModelRef; where?: string },
): Pin {
  const line = lineOf(starts, p.offset);
  return {
    ...p,
    file: input.file,
    line,
    fileHash: input.hash ?? sha256(input.text),
    qualified: p.text.split(":")[0]!.includes("/"),
    where: p.where ?? `${input.label}:${line}`,
  };
}

// ------------------------------------------------------------ scanners

/** `defaultProvider`/`defaultModel` and `enabledModels[]` in settings.json. */
export function scanSettings(input: PinInput): Pin[] {
  const doc = parseJsonObject(input.text);
  const defaultProvider = typeof doc.defaultProvider === "string" ? doc.defaultProvider : undefined;
  const starts = lineStarts(input.text);
  const pins: Pin[] = [];
  for (const s of jsonStrings(input.text)) {
    const [k, n] = s.path;
    if (s.path.length === 1 && k === "defaultModel") {
      const ref = parseModelRef(s.value);
      if (!ref) continue;
      if (!ref.provider && defaultProvider) ref.provider = defaultProvider;
      pins.push(
        makePin(input, starts, {
          key: `settings|${input.file}|defaultModel|${s.value}`,
          kind: "settings",
          offset: s.offset,
          text: s.value,
          ref,
          where: `${input.label} defaultModel`,
          strict: true,
          editable: true,
        }),
      );
    } else if (s.path.length === 2 && k === "enabledModels" && typeof n === "number") {
      const ref = parseModelRef(s.value);
      if (!ref) continue; // globs and other patterns
      pins.push(
        makePin(input, starts, {
          key: `settings|${input.file}|enabledModels|${s.value}`,
          kind: "settings",
          offset: s.offset,
          text: s.value,
          ref,
          where: `${input.label} enabledModels`,
          listEntry: true,
          strict: true,
          editable: true,
        }),
      );
    }
  }
  return pins;
}

/** Per-job `model` in pi-cron-jobs' jobs.json (an array of jobs). */
export function scanCron(input: PinInput): Pin[] {
  const jobs = parseJsonArray(input.text);
  const starts = lineStarts(input.text);
  const pins: Pin[] = [];
  for (const s of jsonStrings(input.text)) {
    const [n, k] = s.path;
    if (s.path.length !== 2 || typeof n !== "number" || k !== "model") continue;
    const ref = parseModelRef(s.value);
    const id = jobs[n]?.id;
    if (!ref || typeof id !== "string") continue;
    pins.push(
      makePin(input, starts, {
        key: `cron|${input.file}|${id}|${s.value}`,
        kind: "cron",
        offset: s.offset,
        text: s.value,
        ref,
        where: `cron job ${id}`,
        jobId: id,
        strict: true,
        editable: true,
      }),
    );
  }
  return pins;
}

/** Any string under a key ending in `model` in a JSON config (subagents.json). */
export function scanJsonConfig(input: PinInput): Pin[] {
  const starts = lineStarts(input.text);
  const pins: Pin[] = [];
  for (const s of jsonStrings(input.text)) {
    const k = s.path[s.path.length - 1];
    if (typeof k !== "string" || !/model$/i.test(k)) continue;
    const ref = parseModelRef(s.value);
    if (!ref || !parseModelId(ref.modelId)) continue;
    pins.push(
      makePin(input, starts, {
        key: `config|${input.file}|${s.path.join(".")}|${s.value}`,
        kind: "config",
        offset: s.offset,
        text: s.value,
        ref,
        where: `${input.label} ${s.path.join(".")}`,
        strict: false,
        editable: true,
      }),
    );
  }
  return pins;
}

/** `model:` in the front matter of an agent definition. Fuzzy names (`haiku`) are not pins. */
export function scanAgent(input: PinInput): Pin[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(input.text);
  if (!fm) return [];
  const starts = lineStarts(input.text);
  const base = fm.index + fm[0].indexOf(fm[1]!);
  const re = /^model:[ \t]*(["']?)([^"'\s#]+)\1[ \t]*(?:#.*)?$/gm;
  const pins: Pin[] = [];
  for (const m of fm[1]!.matchAll(re)) {
    const value = m[2]!;
    const ref = parseModelRef(value);
    if (!ref || !parseModelId(ref.modelId)) continue;
    const offset = base + m.index + m[0].indexOf(value, "model:".length);
    pins.push(
      makePin(input, starts, {
        key: `agent|${input.file}|${value}`,
        kind: "agent",
        offset,
        text: value,
        ref,
        strict: false,
        editable: true,
      }),
    );
  }
  return pins;
}

const LITERAL_RE = /(["'`])([A-Za-z0-9._:/-]{5,100})\1/g;
const PROVIDER_RE = /\bprovider["']?\s*[:=]\s*["'`]([\w.-]+)["'`]/g;

/**
 * Character ranges of `//` and `/* *\/` comments in JS/TS source. A small
 * lexer that steps over strings, template literals and regex literals so a
 * quote inside a regex or a `//` inside a string is not misread.
 */
export function commentRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  let prev = ""; // last significant character outside comments and strings
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out.push([i, stop]);
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push([i, stop]);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i++;
      prev = c;
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      // regex literal
      i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const r = text[i]!;
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      prev = "/";
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

function inRanges(ranges: ReadonlyArray<[number, number]>, offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid]!;
    if (offset < s) hi = mid - 1;
    else if (offset >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Quoted string literals that are model ids, in code or JSON. Literals inside comments are skipped. */
export function scanSource(input: PinInput, kind: "source" | "package" = "source"): Pin[] {
  const starts = lineStarts(input.text);
  const comments = input.file.endsWith(".json") ? [] : commentRanges(input.text);
  const pins: Pin[] = [];
  for (const m of input.text.matchAll(LITERAL_RE)) {
    const value = m[2]!;
    const ref = parseModelRef(value);
    if (!ref || !parseModelId(ref.modelId)) continue;
    const offset = m.index + 1;
    if (inRanges(comments, offset)) continue;
    const line = lineOf(starts, offset);
    const lineText = input.text.slice(starts[line - 1], starts[line] ?? input.text.length);
    const hints = [...lineText.matchAll(PROVIDER_RE)].map((h) => h[1]!);
    const pin = makePin(input, starts, {
      key: `${kind}|${input.file}|${value}`,
      kind,
      offset,
      text: value,
      ref,
      strict: false,
      editable: kind === "source",
    });
    if (!ref.provider && hints.length === 1) pin.providerHint = hints[0]!;
    pins.push(pin);
  }
  return pins;
}

const DOC_RE = /(?<![\w./-])((?:[a-z][a-z0-9-]*\/)?(?:claude-[a-z]+-\d[\w-]*|gpt-\d[\w.-]*))/g;

/** Model ids mentioned in prose (skills, READMEs), e.g. `--model claude-haiku-4-5`. */
export function scanDoc(input: PinInput): Pin[] {
  const starts = lineStarts(input.text);
  const pins: Pin[] = [];
  for (const m of input.text.matchAll(DOC_RE)) {
    const value = m[1]!.replace(/[.-]+$/, "");
    const ref = parseModelRef(value);
    if (!ref || !parseModelId(ref.modelId)) continue;
    pins.push(
      makePin(input, starts, {
        key: `doc|${input.file}|${value}`,
        kind: "doc",
        offset: m.index,
        text: value,
        ref,
        strict: false,
        editable: true,
      }),
    );
  }
  return pins;
}

// ------------------------------------------------------------ file system

export interface CollectOptions {
  agentDir: string;
  home: string;
  cronJobsFile: string;
  /** This package's root; never scanned (its tests are full of model ids). */
  ownRoot: string;
  /** Extra files or folders to scan as editable (code, JSON or Markdown). */
  extraPaths: string[];
}

export interface CollectResult {
  pins: Pin[];
  errors: string[];
  filesScanned: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  ".venv",
  "venv",
  "sessions",
]);
const CODE_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);
const SKIP_FILE_RE = /(\.test\.|\.spec\.|\.d\.ts$|^package-lock\.json$|^bun\.lock|\.map$)/;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 5_000;
const MAX_DEPTH = 8;

export function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function isRemoteSource(source: string): boolean {
  return /^(npm:|git:|git\+|https?:|ssh:|git@)/.test(source);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

type RootMode = "code" | "code+docs" | "docs" | "package";

async function walk(root: string, visit: (file: string) => Promise<void>, budget: { files: number }): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch {
    return;
  }
  if (info.isFile()) {
    await visit(root);
    return;
  }
  const rec = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || budget.files >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.files >= MAX_FILES) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await rec(p, depth + 1);
      } else if (e.isFile() || e.isSymbolicLink()) {
        await visit(p);
      }
    }
  };
  await rec(root, 0);
}

/** Local extension and package paths declared in settings.json. */
export function localSourcesFromSettings(doc: Record<string, unknown>, agentDir: string): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(doc.extensions) ? doc.extensions : []) {
    if (typeof e !== "string" || isRemoteSource(e) || e.startsWith("builtin:")) continue;
    const p = isAbsolute(e) ? e : resolve(agentDir, e);
    out.push(/\.[cm]?[jt]s$/.test(p) ? dirname(p) : p);
  }
  for (const pkg of Array.isArray(doc.packages) ? doc.packages : []) {
    const source = typeof pkg === "string" ? pkg : typeof pkg === "object" && pkg && "source" in pkg ? (pkg as { source: unknown }).source : undefined;
    if (typeof source !== "string" || isRemoteSource(source)) continue;
    out.push(isAbsolute(source) ? source : resolve(agentDir, source));
  }
  return out;
}

export async function collectPins(o: CollectOptions): Promise<CollectResult> {
  const pins: Pin[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const budget = { files: 0 };
  let ownRoot = o.ownRoot;
  try {
    ownRoot = await realpath(o.ownRoot);
  } catch {
    // keep as given
  }
  const label = (p: string) => tildePath(p, o.home);

  const claim = async (file: string): Promise<string | undefined> => {
    let real = file;
    try {
      real = await realpath(file);
    } catch {
      return undefined;
    }
    if (seen.has(real) || real === ownRoot || real.startsWith(ownRoot + sep)) return undefined;
    seen.add(real);
    return real;
  };

  const scanFile = async (file: string, scan: (input: PinInput) => Pin[]): Promise<void> => {
    try {
      const text = await readText(file);
      if (text === undefined) return;
      budget.files++;
      pins.push(...scan({ file, text, label: label(file) }));
    } catch (err) {
      errors.push(`${label(file)}: ${(err as Error).message}`);
    }
  };

  // 1. settings.json
  const settingsFile = join(o.agentDir, "settings.json");
  let settingsDoc: Record<string, unknown> = {};
  if (await claim(settingsFile)) {
    await scanFile(settingsFile, (input) => {
      settingsDoc = parseJsonObject(input.text);
      return scanSettings({ ...input, label: "settings.json" });
    });
  }

  // 2. pi-cron-jobs
  if (await claim(o.cronJobsFile)) await scanFile(o.cronJobsFile, scanCron);

  // 3. subagents.json
  const subagents = join(o.agentDir, "subagents.json");
  if (await claim(subagents)) await scanFile(subagents, (input) => scanJsonConfig({ ...input, label: "subagents.json" }));

  // 4. agent definitions
  const agentsDir = join(o.agentDir, "agents");
  await walk(
    agentsDir,
    async (file) => {
      if (extname(file) === ".md" && (await claim(file))) await scanFile(file, scanAgent);
    },
    budget,
  );

  // 5. code and docs
  const roots: Array<{ path: string; mode: RootMode }> = [
    { path: join(o.agentDir, "extensions"), mode: "code" },
    ...localSourcesFromSettings(settingsDoc, o.agentDir).map((path) => ({ path, mode: "code+docs" as const })),
    ...o.extraPaths.map((p) => ({ path: resolve(expandHome(p, o.home)), mode: "code+docs" as const })),
    { path: join(o.home, ".agents", "skills"), mode: "docs" },
    { path: join(o.agentDir, "git"), mode: "package" },
  ];
  for (const root of roots) {
    await walk(
      root.path,
      async (file) => {
        const name = basename(file);
        if (SKIP_FILE_RE.test(name)) return;
        const ext = extname(file);
        const isCode = CODE_EXT.has(ext) && root.mode !== "docs";
        const isDoc = ext === ".md" && root.mode !== "code" && root.mode !== "package";
        if (!isCode && !isDoc) return;
        try {
          if ((await stat(file)).size > MAX_FILE_BYTES) return;
        } catch {
          return;
        }
        if (!(await claim(file))) return;
        if (isDoc) await scanFile(file, scanDoc);
        else await scanFile(file, (input) => scanSource(input, root.mode === "package" ? "package" : "source"));
      },
      budget,
    );
  }

  return { pins, errors, filesScanned: budget.files };
}

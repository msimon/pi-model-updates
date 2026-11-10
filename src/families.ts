// Model-id parsing and "is there a newer model in this family?" logic.
//
// Pure: everything here works on plain strings and a catalog array, so it is
// unit-tested without pi. Two id shapes are understood:
//
//   Anthropic  claude-<family>-<major>[-<minor>][-<YYYYMMDD>]   claude-opus-5-5, claude-haiku-4-5-20251001
//   OpenAI     gpt-<major>[.<minor>]-<family>[-<word>...]        gpt-6.1-sol, gpt-5.4-mini, gpt-6-sol-mini
//
// Anything else is "unknown" and never gets a suggestion. A family never
// crosses vendors, providers or family names (`mini` and `sol-mini` are
// different families from `sol`).

export interface CatalogModel {
  provider: string;
  id: string;
}

export interface ModelShape {
  vendor: "anthropic" | "openai";
  family: string;
  version: number[];
  /** Dated snapshot alias (claude-haiku-4-5-20251001); never suggested as a target. */
  dated: boolean;
}

/** A model reference as written in config: `[provider/]id[:thinking]`. */
export interface ModelRef {
  provider?: string;
  modelId: string;
  /** Thinking-level suffix including the colon, e.g. `:high`. */
  suffix?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const ANTHROPIC_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/;
const OPENAI_RE = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+(?:-[a-z]+)*)$/;

export function parseModelId(id: string): ModelShape | undefined {
  const a = ANTHROPIC_RE.exec(id);
  if (a) {
    return {
      vendor: "anthropic",
      family: a[1]!,
      version: [Number(a[2]), a[3] === undefined ? 0 : Number(a[3])],
      dated: a[4] !== undefined,
    };
  }
  const o = OPENAI_RE.exec(id);
  if (o) {
    return {
      vendor: "openai",
      family: o[3]!,
      version: [Number(o[1]), o[2] === undefined ? 0 : Number(o[2])],
      dated: false,
    };
  }
  return undefined;
}

/** Parse `[provider/]id[:thinking]`. Returns undefined for globs and malformed refs. */
export function parseModelRef(text: string): ModelRef | undefined {
  if (!text || /[*?[\]{}\s]/.test(text)) return undefined;
  let rest = text;
  let suffix: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const level = rest.slice(colon + 1);
    if (!THINKING_LEVELS.has(level)) return undefined;
    suffix = rest.slice(colon);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/");
  if (parts.length > 2 || parts.some((p) => p === "")) return undefined;
  const ref: ModelRef = parts.length === 2 ? { provider: parts[0]!, modelId: parts[1]! } : { modelId: parts[0]! };
  if (suffix !== undefined) ref.suffix = suffix;
  return ref;
}

export function formatModelRef(ref: ModelRef, withProvider: boolean): string {
  const base = withProvider && ref.provider ? `${ref.provider}/${ref.modelId}` : ref.modelId;
  return base + (ref.suffix ?? "");
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sameFamily(a: ModelShape, b: ModelShape): boolean {
  return a.vendor === b.vendor && a.family === b.family;
}

/** Newest undated catalog model of the same provider and family, if any. */
export function newestInFamily(
  provider: string,
  shape: ModelShape,
  catalog: readonly CatalogModel[],
): (CatalogModel & { shape: ModelShape }) | undefined {
  let best: (CatalogModel & { shape: ModelShape }) | undefined;
  for (const m of catalog) {
    if (m.provider !== provider) continue;
    const s = parseModelId(m.id);
    if (!s || s.dated || !sameFamily(s, shape)) continue;
    if (!best || compareVersions(s.version, best.shape.version) > 0 || (compareVersions(s.version, best.shape.version) === 0 && m.id < best.id)) {
      best = { ...m, shape: s };
    }
  }
  return best;
}

export interface ProviderResolution {
  provider?: string;
  /** Providers that could own the id when it is ambiguous (more than one). */
  candidates: string[];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/**
 * Work out the provider of a bare model id: an exact catalog match, else the
 * providers carrying the same family, else the providers carrying any model of
 * the same vendor shape. Exactly one candidate resolves; several are ambiguous.
 */
export function resolveProvider(modelId: string, catalog: readonly CatalogModel[], hint?: string): ProviderResolution {
  if (hint) return { provider: hint, candidates: [hint] };
  const steps: Array<(m: CatalogModel) => boolean> = [(m) => m.id === modelId];
  const shape = parseModelId(modelId);
  if (shape) {
    steps.push((m) => {
      const s = parseModelId(m.id);
      return !!s && sameFamily(s, shape);
    });
    steps.push((m) => parseModelId(m.id)?.vendor === shape.vendor);
  }
  for (const step of steps) {
    const providers = uniq(catalog.filter(step).map((m) => m.provider));
    if (providers.length === 1) return { provider: providers[0]!, candidates: providers };
    if (providers.length > 1) return { candidates: providers };
  }
  return { candidates: [] };
}

export type SuggestionStatus = "current" | "update" | "missing" | "ambiguous" | "unknown";

export interface Suggestion {
  status: SuggestionStatus;
  provider?: string;
  candidates: string[];
  /** The pinned id is not in the catalog (for its provider). */
  missing: boolean;
  /** Newer model id in the same provider and family. */
  target?: string;
  shape?: ModelShape;
}

/**
 * Suggest an update for one pinned model.
 *
 * - `update`: a newer model of the same provider and family exists (the pin may also be missing).
 * - `current`: the pin is in the catalog and nothing newer exists.
 * - `missing`: the pin is not in the catalog and nothing newer exists.
 * - `ambiguous`: no provider given and several providers could own it.
 * - `unknown`: the id shape is not understood and it is not in the catalog.
 */
export function suggest(ref: ModelRef, catalog: readonly CatalogModel[], providerHint?: string): Suggestion {
  const shape = parseModelId(ref.modelId);
  const res = ref.provider ? { provider: ref.provider, candidates: [ref.provider] } : resolveProvider(ref.modelId, catalog, providerHint);
  const provider = res.provider;
  const inCatalog = catalog.some((m) => m.id === ref.modelId && (!provider || m.provider === provider));
  const base = { candidates: res.candidates, missing: !inCatalog };
  const withShape = shape ? { shape } : {};
  if (!shape) {
    return { ...base, ...withShape, ...(provider ? { provider } : {}), status: inCatalog ? "current" : "unknown" };
  }
  if (!provider) {
    if (res.candidates.length > 1) return { ...base, ...withShape, status: "ambiguous" };
    return { ...base, ...withShape, status: inCatalog ? "current" : "missing" };
  }
  const newest = newestInFamily(provider, shape, catalog);
  if (newest && compareVersions(newest.shape.version, shape.version) > 0) {
    return { ...base, ...withShape, provider, status: "update", target: newest.id };
  }
  return { ...base, ...withShape, provider, status: inCatalog ? "current" : "missing" };
}

/** Undated catalog models a missing pin can be replaced with by hand, newest first per family. */
export function replacementChoices(provider: string | undefined, catalog: readonly CatalogModel[]): CatalogModel[] {
  return catalog
    .filter((m) => (!provider || m.provider === provider) && !parseModelId(m.id)?.dated)
    .slice()
    .sort((a, b) => {
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
      const sa = parseModelId(a.id);
      const sb = parseModelId(b.id);
      if (sa && sb && sa.family === sb.family) return compareVersions(sb.version, sa.version);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

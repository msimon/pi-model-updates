import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  formatModelRef,
  parseModelId,
  parseModelRef,
  replacementChoices,
  resolveProvider,
  suggest,
  type CatalogModel,
} from "./families.ts";

// The catalog as of 2026-11-10 (`pi --list-models`).
const CATALOG: CatalogModel[] = [
  ...[
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-5-5",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
  ].map((id) => ({ provider: "anthropic", id })),
  ...[
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
  ].map((id) => ({ provider: "openai-codex", id })),
];

test("parseModelId: anthropic ids, with and without minor, dated aliases", () => {
  assert.deepEqual(parseModelId("claude-opus-5-5"), { vendor: "anthropic", family: "opus", version: [5, 5], dated: false });
  assert.deepEqual(parseModelId("claude-opus-5"), { vendor: "anthropic", family: "opus", version: [5, 0], dated: false });
  assert.deepEqual(parseModelId("claude-haiku-4-5-20251001"), { vendor: "anthropic", family: "haiku", version: [4, 5], dated: true });
  assert.deepEqual(parseModelId("claude-opus-4-20250514"), { vendor: "anthropic", family: "opus", version: [4, 0], dated: true });
  assert.equal(parseModelId("claude-fable-5-2")?.family, "fable");
});

test("parseModelId: openai ids, families and minis", () => {
  assert.deepEqual(parseModelId("gpt-6.1-sol"), { vendor: "openai", family: "sol", version: [6, 1], dated: false });
  assert.deepEqual(parseModelId("gpt-6-astra"), { vendor: "openai", family: "astra", version: [6, 0], dated: false });
  assert.deepEqual(parseModelId("gpt-5.4-mini"), { vendor: "openai", family: "mini", version: [5, 4], dated: false });
  assert.equal(parseModelId("gpt-6-sol-mini")?.family, "sol-mini");
});

test("parseModelId: unknown shapes", () => {
  for (const id of ["claude-3-5-sonnet", "gpt-6", "gpt-4o-mini", "haiku", "o3", "claude-opus", "gpt-6-sol-2026-01-01", "llama-3.1-8b", ""]) {
    assert.equal(parseModelId(id), undefined, id);
  }
});

test("compareVersions is numeric, not lexical", () => {
  assert.ok(compareVersions([5, 6], [6, 0]) < 0);
  assert.ok(compareVersions([6, 1], [6, 0]) > 0);
  assert.ok(compareVersions([4, 10], [4, 9]) > 0);
  assert.equal(compareVersions([5], [5, 0]), 0);
});

test("parseModelRef: provider prefix, thinking suffix, globs rejected", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-opus-5-5"), { provider: "anthropic", modelId: "claude-opus-5-5" });
  assert.deepEqual(parseModelRef("claude-opus-5-5"), { modelId: "claude-opus-5-5" });
  assert.deepEqual(parseModelRef("anthropic/claude-opus-5:high"), { provider: "anthropic", modelId: "claude-opus-5", suffix: ":high" });
  assert.equal(parseModelRef("anthropic/*"), undefined);
  assert.equal(parseModelRef("a/b/c"), undefined);
  assert.equal(parseModelRef("x:notalevel"), undefined);
  assert.equal(parseModelRef("/claude-opus-5"), undefined);
});

test("formatModelRef keeps the form it was written in", () => {
  const ref = { provider: "anthropic", modelId: "claude-opus-5-5", suffix: ":high" };
  assert.equal(formatModelRef(ref, true), "anthropic/claude-opus-5-5:high");
  assert.equal(formatModelRef(ref, false), "claude-opus-5-5:high");
});

test("suggest: older pin in the same family updates to the newest", () => {
  const s = suggest({ provider: "anthropic", modelId: "claude-haiku-4-5" }, CATALOG);
  assert.equal(s.status, "update");
  assert.equal(s.target, "claude-haiku-5-5");
  assert.equal(s.missing, false);
});

test("suggest: newest pins are current", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
    assert.equal(suggest({ provider: "anthropic", modelId: id }, CATALOG).status, "current", id);
  }
  for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-terra"]) {
    assert.equal(suggest({ provider: "openai-codex", modelId: id }, CATALOG).status, "current", id);
  }
});

test("suggest: codex versions compare numerically across 5.6, 6, 6.1", () => {
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-5.6-sol" }, CATALOG).target, "gpt-6.1-sol");
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-6-sol" }, CATALOG).target, "gpt-6.1-sol");
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-5.6-luna" }, CATALOG).target, "gpt-6-luna");
});

test("suggest: never crosses families or providers", () => {
  // no newer astra, even though gpt-6.1-sol exists
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-6-astra" }, CATALOG).target, undefined);
  // fable is its own family, opus 5.5 is not a target
  assert.equal(suggest({ provider: "anthropic", modelId: "claude-fable-5" }, CATALOG).target, "claude-fable-5-2");
  // same id under another provider gets nothing from anthropic's catalog
  const other = suggest({ provider: "bedrock", modelId: "claude-haiku-4-5" }, CATALOG);
  assert.equal(other.target, undefined);
  assert.equal(other.status, "missing");
});

test("suggest: dated aliases are never targets but are updated as their base version", () => {
  const s = suggest({ provider: "anthropic", modelId: "claude-haiku-4-5-20251001" }, CATALOG);
  assert.equal(s.target, "claude-haiku-5-5");
  const only = [{ provider: "anthropic", id: "claude-haiku-4-5" }, { provider: "anthropic", id: "claude-haiku-4-5-20251001" }];
  assert.equal(suggest({ provider: "anthropic", modelId: "claude-haiku-4-5" }, only).status, "current");
});

test("suggest: unknown shapes never get a suggestion", () => {
  const s = suggest({ provider: "anthropic", modelId: "claude-3-5-sonnet" }, CATALOG);
  assert.equal(s.status, "unknown");
  assert.equal(s.target, undefined);
  const known = suggest({ provider: "x", modelId: "weird" }, [{ provider: "x", id: "weird" }]);
  assert.equal(known.status, "current");
});

test("suggest: pinned model missing from the catalog is flagged", () => {
  const mini = suggest({ provider: "openai-codex", modelId: "gpt-5.4-mini" }, CATALOG);
  assert.equal(mini.status, "missing");
  assert.equal(mini.missing, true);
  assert.equal(mini.target, undefined);
  // missing but a newer family member exists: update, still flagged missing
  const gone = suggest({ provider: "anthropic", modelId: "claude-opus-4-1" }, CATALOG);
  assert.equal(gone.status, "update");
  assert.equal(gone.target, "claude-opus-5-5");
  assert.equal(gone.missing, true);
});

test("suggest: missing mini updates only to a newer mini", () => {
  const cat = [...CATALOG, { provider: "openai-codex", id: "gpt-6-mini" }];
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-5.4-mini" }, cat).target, "gpt-6-mini");
  assert.equal(suggest({ provider: "openai-codex", modelId: "gpt-5.6-sol" }, cat).target, "gpt-6.1-sol");
});

test("resolveProvider: bare ids", () => {
  assert.equal(resolveProvider("claude-haiku-4-5", CATALOG).provider, "anthropic");
  assert.equal(resolveProvider("claude-opus-4-1", CATALOG).provider, "anthropic"); // via family
  assert.equal(resolveProvider("gpt-5.4-mini", CATALOG).provider, "openai-codex"); // via vendor
  assert.equal(resolveProvider("gpt-5.4-mini", CATALOG, "openai").provider, "openai"); // hint wins
  assert.deepEqual(resolveProvider("mistral-large", CATALOG), { candidates: [] });
  const two = [...CATALOG, { provider: "openai", id: "gpt-6.1-sol" }];
  assert.equal(resolveProvider("gpt-6-sol", two).provider, "openai-codex"); // exact id in one provider
  assert.deepEqual(resolveProvider("gpt-6.1-sol", two), { candidates: ["openai", "openai-codex"] });
  assert.deepEqual(resolveProvider("gpt-5.5-sol", two), { candidates: ["openai", "openai-codex"] }); // via family
  assert.equal(suggest({ modelId: "gpt-5.5-sol" }, two).status, "ambiguous");
});

test("suggest: bare cron-style id infers its provider", () => {
  const s = suggest({ modelId: "claude-haiku-4-5" }, CATALOG);
  assert.equal(s.provider, "anthropic");
  assert.equal(s.target, "claude-haiku-5-5");
});

test("replacementChoices: one provider, no dated aliases, newest first", () => {
  const ids = replacementChoices("anthropic", CATALOG).map((m) => m.id);
  assert.ok(!ids.some((id) => /\d{8}$/.test(id)));
  assert.ok(ids.indexOf("claude-opus-5-5") < ids.indexOf("claude-opus-4-5"));
  assert.ok(replacementChoices("openai-codex", CATALOG).every((m) => m.provider === "openai-codex"));
  assert.equal(replacementChoices(undefined, CATALOG).length, CATALOG.length - 3);
});

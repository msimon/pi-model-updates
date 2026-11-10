import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogModel } from "./families.ts";
import { buildFindings, describe, groupReadOnly, noticeText, packageName, setManualTarget, statusText, summarize } from "./findings.ts";
import { scanCron, scanSettings, scanSource, type Pin } from "./scan.ts";

const CATALOG: CatalogModel[] = [
  ...["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5"].map((id) => ({ provider: "anthropic", id })),
  ...["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"].map((id) => ({ provider: "openai-codex", id })),
];

const settings = (models: string[], defaultModel = "claude-opus-5-5") =>
  scanSettings({
    file: "/s.json",
    label: "settings.json",
    text: JSON.stringify({ defaultProvider: "anthropic", defaultModel, enabledModels: models }, null, 2),
  });

test("current pins produce no findings", () => {
  const pins = settings(["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"]);
  assert.deepEqual(buildFindings(pins, CATALOG), []);
});

test("cron haiku 4.5 and auto-title gpt-5.4-mini (today's setup)", () => {
  const cron = scanCron({ file: "/j.json", label: "jobs", text: JSON.stringify([{ id: "personal-admin-drive-backup", model: "claude-haiku-4-5" }]) });
  const src = scanSource({
    file: "/auto-title.ts",
    label: "~/auto-title.ts",
    text: '{ provider: "anthropic", modelId: "claude-haiku-5-5" },\n{ provider: "openai-codex", modelId: "gpt-5.4-mini" },',
  });
  const f = buildFindings([...cron, ...src], CATALOG);
  assert.equal(f.length, 2);
  assert.equal(f[0]!.status, "update");
  assert.equal(f[0]!.newText, "claude-haiku-5-5"); // stays bare
  assert.equal(f[1]!.status, "missing");
  assert.equal(f[1]!.provider, "openai-codex");
  assert.equal(f[1]!.newText, undefined);
  assert.equal(describe(f[0]!), "claude-haiku-4-5 → claude-haiku-5-5 · cron job personal-admin-drive-backup");
  assert.equal(describe(f[1]!), "gpt-5.4-mini (not in catalog) → pick… · ~/auto-title.ts:2");
  assert.deepEqual(summarize(f), { updates: 1, missing: 1 });
  assert.equal(statusText(summarize(f)), "models: 1 update · 1 missing");
  assert.equal(noticeText(summarize(f)), "Model pins: 1 pinned model can move to a newer model, 1 is missing from the catalog. Run /models-update.");
  assert.equal(statusText({ updates: 0, missing: 0 }), undefined);
});

test("enabledModels keep provider prefix and thinking suffix", () => {
  const f = buildFindings(settings(["anthropic/claude-haiku-4-5:high"]), CATALOG);
  assert.equal(f[0]!.newText, "anthropic/claude-haiku-5-5:high");
  assert.equal(f[0]!.remove, false);
});

test("enabledModels: replacement already listed becomes a removal", () => {
  const f = buildFindings(settings(["anthropic/claude-opus-5", "anthropic/claude-opus-5-5"]), CATALOG);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.remove, true);
  assert.match(describe(f[0]!), /→ remove \(anthropic\/claude-opus-5-5 already listed\)/);
});

test("enabledModels: two old entries updating to the same model, the second is removed", () => {
  const f = buildFindings(settings(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001"]), CATALOG);
  assert.deepEqual(f.map((x) => [x.newText, x.remove]), [
    ["anthropic/claude-haiku-5-5", false],
    ["anthropic/claude-haiku-5-5", true],
  ]);
});

test("defaultModel with unknown shape missing from the catalog is flagged (strict)", () => {
  const f = buildFindings(settings([], "my-custom-model"), CATALOG);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.status, "missing");
});

test("ignored suggestions stay ignored until the target changes", () => {
  const cron = scanCron({ file: "/j.json", label: "jobs", text: JSON.stringify([{ id: "x", model: "claude-haiku-4-5" }]) });
  const key = cron[0]!.key;
  const f1 = buildFindings(cron, CATALOG, [{ key, target: "claude-haiku-5-5" }]);
  assert.equal(f1[0]!.ignored, true);
  assert.deepEqual(summarize(f1), { updates: 0, missing: 0 });
  const f2 = buildFindings(cron, [...CATALOG, { provider: "anthropic", id: "claude-haiku-6" }], [{ key, target: "claude-haiku-5-5" }]);
  assert.equal(f2[0]!.ignored, false);
  assert.equal(f2[0]!.target, "claude-haiku-6");
});

test("read-only package pins are listed but not counted", () => {
  assert.equal(packageName("/u/.pi/agent/git/github.com/msimon/pi-subagents/src/x.ts"), "msimon/pi-subagents");
  const grouped = groupReadOnly(
    buildFindings(
      scanSource({ file: "/u/.pi/agent/git/github.com/o/r/src/d.ts", label: "d.ts", text: 'a = "claude-haiku-4-5"; b = "claude-opus-5";' }, "package"),
      CATALOG,
    ),
  );
  assert.deepEqual(grouped.map((g) => [g.name, g.findings.length]), [["o/r", 2]]);
  const pins: Pin[] = scanSource({ file: "/git/d.ts", label: "d.ts", text: 'model: "anthropic/claude-haiku-4-5",' }, "package");
  const f = buildFindings(pins, CATALOG);
  assert.equal(f.length, 1);
  assert.deepEqual(summarize(f), { updates: 0, missing: 0 });
  assert.match(describe(f[0]!), /\[read-only package\]$/);
});

test("setManualTarget: keeps the pin's form and re-checks duplicates", () => {
  const src = scanSource({ file: "/a.ts", label: "a.ts", text: '{ provider: "openai-codex", modelId: "gpt-5.4-mini" }' });
  const f = buildFindings(src, CATALOG);
  setManualTarget(f, f[0]!, { provider: "openai-codex", id: "gpt-6-sol" }, src);
  assert.equal(f[0]!.newText, "gpt-6-sol");

  const pins = settings(["anthropic/claude-gone-1", "anthropic/claude-opus-5-5"]);
  const list = buildFindings(pins, CATALOG);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, "missing");
  setManualTarget(list, list[0]!, { provider: "anthropic", id: "claude-opus-5-5" }, pins);
  assert.equal(list[0]!.remove, true); // already listed as a current pin
  setManualTarget(list, list[0]!, { provider: "anthropic", id: "claude-sonnet-5-5" }, pins);
  assert.equal(list[0]!.remove, false);
  assert.equal(list[0]!.newText, "anthropic/claude-sonnet-5-5");
});

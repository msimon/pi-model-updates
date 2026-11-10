import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyTextEdits, editsFor, planFileEdits, removeArrayElementEdit, renderDiff, withFileLock, writeFilePlan } from "./apply.ts";
import type { CatalogModel } from "./families.ts";
import { buildFindings } from "./findings.ts";
import { scanSettings, scanSource } from "./scan.ts";

const CATALOG: CatalogModel[] = ["claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5", "claude-opus-5-5"].map((id) => ({ provider: "anthropic", id }));

// Hand-formatted on purpose: odd spacing must survive.
const SETTINGS = `{
  "theme":   "dark",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5",
  "enabledModels": [
    "anthropic/claude-opus-5",
    "anthropic/claude-haiku-4-5:high",
    "anthropic/claude-opus-5-5"
  ],
  "packages": ["npm:x"]
}
`;

const index = (text: string, needle: string) => text.indexOf(needle);

test("applyTextEdits applies in any order and rejects overlaps", () => {
  assert.equal(
    applyTextEdits("abc def ghi", [
      { offset: 0, length: 3, replacement: "A" },
      { offset: 8, length: 3, replacement: "G" },
    ]),
    "A def G",
  );
  assert.throws(() =>
    applyTextEdits("abcdef", [
      { offset: 0, length: 4, replacement: "" },
      { offset: 2, length: 2, replacement: "" },
    ]),
  );
});

test("removeArrayElementEdit: one per line, middle, last, inline, only", () => {
  const multi = '[\n  "a",\n  "b",\n  "c"\n]';
  const rm1 = (t: string, v: string) => applyTextEdits(t, [removeArrayElementEdit(t, index(t, `"${v}"`) + 1, v.length)]);
  assert.equal(rm1(multi, "a"), '[\n  "b",\n  "c"\n]');
  assert.equal(rm1(multi, "b"), '[\n  "a",\n  "c"\n]');
  assert.equal(rm1(multi, "c"), '[\n  "a",\n  "b"\n]');
  assert.equal(rm1('["a", "b", "c"]', "b"), '["a", "c"]');
  assert.equal(rm1('["a", "b", "c"]', "c"), '["a", "b"]');
  assert.equal(rm1('["a"]', "a"), "[]");
  assert.equal(rm1('[\r\n  "a",\r\n  "b"\r\n]', "a"), '[\r\n  "b"\r\n]');
});

test("settings.json edits keep every other byte", () => {
  const pins = scanSettings({ file: "/s.json", label: "settings.json", text: SETTINGS });
  const f = buildFindings(pins, CATALOG);
  // defaultModel opus-5 → opus-5-5, enabled opus-5 → removed (5-5 listed), haiku → haiku-5-5:high
  assert.deepEqual(f.map((x) => [x.pin.text, x.newText, x.remove]), [
    ["claude-opus-5", "claude-opus-5-5", false],
    ["anthropic/claude-opus-5", "anthropic/claude-opus-5-5", true],
    ["anthropic/claude-haiku-4-5:high", "anthropic/claude-haiku-5-5:high", false],
  ]);
  const out = applyTextEdits(SETTINGS, editsFor(SETTINGS, f));
  assert.equal(
    out,
    `{
  "theme":   "dark",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "enabledModels": [
    "anthropic/claude-haiku-5-5:high",
    "anthropic/claude-opus-5-5"
  ],
  "packages": ["npm:x"]
}
`,
  );
  assert.doesNotThrow(() => JSON.parse(out));
});

test("editsFor refuses when the text moved", () => {
  const pins = scanSource({ file: "/a.ts", label: "a.ts", text: 'x = "claude-haiku-4-5";' });
  const f = buildFindings(pins, CATALOG);
  assert.throws(() => editsFor('xy = "claude-haiku-4-5";', f), /no longer at line 1/);
});

test("renderDiff: changed and removed lines with line numbers", () => {
  const pins = scanSettings({ file: "/s.json", label: "settings.json", text: SETTINGS });
  const diff = renderDiff("~/.pi/agent/settings.json", SETTINGS, editsFor(SETTINGS, buildFindings(pins, CATALOG)));
  assert.equal(
    diff,
    [
      "--- ~/.pi/agent/settings.json",
      "@@ line 4",
      '-   "defaultModel": "claude-opus-5",',
      '+   "defaultModel": "claude-opus-5-5",',
      "@@ line 6",
      '-     "anthropic/claude-opus-5",',
      '-     "anthropic/claude-haiku-4-5:high",',
      '+     "anthropic/claude-haiku-5-5:high",',
    ].join("\n"),
  );
});

test("planFileEdits + writeFilePlan: writes in place, refuses a file changed since the scan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pmu-apply-"));
  try {
    const file = join(dir, "auto-title.ts");
    const src = 'const M = [{ provider: "anthropic", modelId: "claude-haiku-4-5" }];\n';
    await writeFile(file, src, { mode: 0o640 });
    const f = buildFindings(scanSource({ file, label: "auto-title.ts", text: src }), CATALOG);
    const { plans, errors } = await planFileEdits(f, (p) => p);
    assert.deepEqual(errors, []);
    assert.match(plans[0]!.diff, /\+ const M = \[\{ provider: "anthropic", modelId: "claude-haiku-5-5" \}\];/);
    await writeFilePlan(plans[0]!);
    assert.equal(await readFile(file, "utf8"), src.replace("claude-haiku-4-5", "claude-haiku-5-5"));
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    // second run: the scan hash no longer matches
    const again = await planFileEdits(f, (p) => p);
    assert.equal(again.plans.length, 0);
    assert.match(again.errors[0]!, /changed since the scan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withFileLock: waits for a held lock, takes over a stale one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pmu-lock-"));
  try {
    const file = join(dir, "settings.json");
    await mkdir(`${file}.lock`);
    let ran = false;
    const p = withFileLock(file, async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ran, false);
    await rm(`${file}.lock`, { recursive: true });
    await p;
    assert.equal(ran, true);
    await assert.rejects(stat(`${file}.lock`)); // released

    // stale: mtime 20 s ago
    await mkdir(`${file}.lock`);
    const old = new Date(Date.now() - 20_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(`${file}.lock`, old, old);
    assert.equal(await withFileLock(file, async () => 42), 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

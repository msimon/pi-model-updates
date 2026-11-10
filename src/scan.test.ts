import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectPins,
  commentRanges,
  jsonStrings,
  localSourcesFromSettings,
  scanAgent,
  scanCron,
  scanDoc,
  scanJsonConfig,
  scanSettings,
  scanSource,
  tildePath,
} from "./scan.ts";

const SETTINGS = `{
  "theme": "dark",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "enabledModels": [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-haiku-4-5:high",
    "anthropic/*",
    "openai-codex/gpt-6.1-sol"
  ]
}
`;

const input = (text: string, file = "/x/file", label = "file") => ({ file, text, label });

test("jsonStrings: paths and exact offsets", () => {
  const strs = jsonStrings(SETTINGS);
  const dm = strs.find((s) => s.path.join(".") === "defaultModel")!;
  assert.equal(SETTINGS.slice(dm.offset, dm.offset + dm.value.length), "claude-opus-5-5");
  assert.deepEqual(
    strs.filter((s) => s.path[0] === "enabledModels").map((s) => s.path[1]),
    [0, 1, 2, 3],
  );
  assert.throws(() => jsonStrings("{"));
  // escaped strings are skipped, the rest still found
  assert.deepEqual(jsonStrings(`{"a":"x\\"y","b":"z"}`).map((s) => s.value), ["z"]);
});

test("scanSettings: defaultModel takes defaultProvider; enabledModels keep form; globs skipped", () => {
  const pins = scanSettings(input(SETTINGS, "/s.json", "settings.json"));
  assert.deepEqual(
    pins.map((p) => [p.where, p.text, p.ref.provider, p.qualified, p.line]),
    [
      ["settings.json defaultModel", "claude-opus-5-5", "anthropic", false, 4],
      ["settings.json enabledModels", "anthropic/claude-opus-5-5", "anthropic", true, 6],
      ["settings.json enabledModels", "anthropic/claude-haiku-4-5:high", "anthropic", true, 7],
      ["settings.json enabledModels", "openai-codex/gpt-6.1-sol", "openai-codex", true, 9],
    ],
  );
  assert.ok(pins.every((p) => p.strict && p.editable));
  assert.equal(pins[2]!.ref.suffix, ":high");
  for (const p of pins) assert.equal(SETTINGS.slice(p.offset, p.offset + p.text.length), p.text);
});

test("scanCron: one pin per job model, bare ids kept bare", () => {
  const jobs = JSON.stringify(
    [
      { id: "a", model: "claude-sonnet-5-5", prompt: "uses claude-haiku-4-5" },
      { id: "personal-admin-drive-backup", model: "claude-haiku-4-5" },
      { id: "c", model: null },
    ],
    null,
    2,
  );
  const pins = scanCron(input(jobs));
  assert.deepEqual(
    pins.map((p) => [p.jobId, p.text, p.qualified, p.where]),
    [
      ["a", "claude-sonnet-5-5", false, "cron job a"],
      ["personal-admin-drive-backup", "claude-haiku-4-5", false, "cron job personal-admin-drive-backup"],
    ],
  );
});

test("scanJsonConfig: keys ending in model", () => {
  const pins = scanJsonConfig(input(`{"rememberAgents":true,"agents":{"Explore":{"model":"anthropic/claude-haiku-4-5"}},"note":"claude-opus-5"}`, "/s", "subagents.json"));
  assert.deepEqual(pins.map((p) => [p.text, p.where]), [["anthropic/claude-haiku-4-5", "subagents.json agents.Explore.model"]]);
});

test("scanAgent: front matter model, fuzzy names ignored", () => {
  const md = "---\nname: Explore\nmodel: anthropic/claude-haiku-4-5\n---\nmodel: claude-opus-4-5 in the body is not a pin\n";
  const pins = scanAgent(input(md));
  assert.equal(pins.length, 1);
  assert.equal(pins[0]!.text, "anthropic/claude-haiku-4-5");
  assert.equal(pins[0]!.line, 3);
  assert.equal(md.slice(pins[0]!.offset, pins[0]!.offset + pins[0]!.text.length), pins[0]!.text);
  assert.equal(scanAgent(input("---\nmodel: haiku\n---\n")).length, 0);
  assert.equal(scanAgent(input('---\nmodel: "claude-sonnet-5"\n---\n'))[0]!.text, "claude-sonnet-5");
});

test("scanSource: string literals, provider hint from the same line", () => {
  const src = [
    "const MODEL_CANDIDATES = [",
    '\t{ provider: "anthropic", modelId: "claude-haiku-5-5" },',
    '\t{ provider: "openai-codex", modelId: "gpt-5.4-mini" },',
    "];",
    "const other = 'anthropic/claude-opus-4-8';",
    'const notModel = "gpt-4o"; const path = "src/claude-opus-5.ts";',
  ].join("\n");
  const pins = scanSource(input(src));
  assert.deepEqual(
    pins.map((p) => [p.text, p.line, p.providerHint, p.editable]),
    [
      ["claude-haiku-5-5", 2, "anthropic", true],
      ["gpt-5.4-mini", 3, "openai-codex", true],
      ["anthropic/claude-opus-4-8", 5, undefined, true],
    ],
  );
  assert.ok(scanSource(input(src), "package").every((p) => !p.editable && p.kind === "package"));
});

test("scanSource: literals in comments are skipped, strings and regexes do not confuse the lexer", () => {
  const src = [
    '// e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5"',
    "/**\n * enabledModels = ['anthropic/claude-opus-4-6']\n */",
    '/* "claude-opus-4-5" */ const a = "claude-opus-4-6";',
    'const url = "http://x"; const b = "claude-sonnet-4-6";',
    "const re = /[\"']/; const c = 'gpt-5.6-sol'; // 'gpt-5.6-luna'",
    "const d = x / 2; const e = 'claude-haiku-4-5';",
  ].join("\n");
  const texts = scanSource(input(src, "/x/a.ts")).map((p) => p.text);
  assert.deepEqual(texts, ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.6-sol", "claude-haiku-4-5"]);
  // JSON has no comments: "//" inside a value must not hide what follows
  assert.equal(scanSource(input('{"u": "http://a", "m": "claude-opus-4-6"}', "/x/a.json")).length, 1);
  assert.deepEqual(commentRanges("a // b\nc"), [[2, 6]]);
});

test("scanDoc: prose mentions with trailing punctuation", () => {
  const md = "Runs headless pi, `claude-haiku-4-5`, daily. Use --model gpt-6-sol.\nNot: claude-3-5-sonnet or my-claude-opus-5.";
  const pins = scanDoc(input(md));
  assert.deepEqual(pins.map((p) => [p.text, p.line]), [["claude-haiku-4-5", 1], ["gpt-6-sol", 1]]);
  for (const p of pins) assert.equal(md.slice(p.offset, p.offset + p.text.length), p.text);
});

test("localSourcesFromSettings: local paths only, files become their folder", () => {
  const doc = {
    extensions: ["/a/pkg/extension/index.ts", "builtin:foo", "/b/dir"],
    packages: ["npm:pi-footer", "git:git@github.com:x/y@main", "../../code/pkg", { source: "/c/pkg" }],
  };
  assert.deepEqual(localSourcesFromSettings(doc, "/home/u/.pi/agent"), ["/a/pkg/extension", "/b/dir", "/home/u/code/pkg", "/c/pkg"]);
});

test("tildePath", () => {
  assert.equal(tildePath("/home/u/.agents/x.md", "/home/u"), "~/.agents/x.md");
  assert.equal(tildePath("/home/user2/x", "/home/u"), "/home/user2/x");
});

test("collectPins: walks the setup, skips tests, node_modules and its own package", async () => {
  const home = await mkdtemp(join(tmpdir(), "pmu-"));
  try {
    const agent = join(home, ".pi", "agent");
    const own = join(home, "code", "pi-model-updates");
    const local = join(home, "code", "local-pkg");
    const w = async (p: string, text: string) => {
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, text);
    };
    await w(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-5", packages: ["../../code/local-pkg", "../../code/pi-model-updates"] }, null, 2));
    await w(join(home, ".pi", "cron-jobs", "jobs.json"), JSON.stringify([{ id: "j", model: "claude-haiku-4-5" }]));
    await w(join(agent, "agents", "a.md"), "---\nmodel: claude-sonnet-4-6\n---\n");
    await w(join(agent, "extensions", "t.ts"), 'const m = "claude-haiku-4-5";');
    await w(join(agent, "extensions", "t.test.ts"), 'const m = "claude-opus-4-1";');
    await w(join(agent, "extensions", "node_modules", "x", "i.js"), 'const m = "claude-opus-4-1";');
    await w(join(local, "src", "i.ts"), 'const m = "gpt-5.6-sol";');
    await w(join(local, "README.md"), "uses gpt-5.6-luna");
    await w(join(own, "src", "families.ts"), 'const m = "claude-opus-4-1";');
    await w(join(home, ".agents", "skills", "s", "SKILL.md"), "runs on `claude-haiku-4-5`");
    await w(join(agent, "git", "github.com", "o", "r", "src", "d.ts"), 'model: "anthropic/claude-haiku-4-5",');
    await w(join(agent, "git", "github.com", "o", "r", "README.md"), "claude-opus-4-1");
    const extra = join(home, "starter", "auto-title.ts");
    await w(extra, 'const m = "gpt-5.4-mini";');

    const r = await collectPins({ agentDir: agent, home, cronJobsFile: join(home, ".pi", "cron-jobs", "jobs.json"), ownRoot: own, extraPaths: ["~/starter"] });
    assert.deepEqual(r.errors, []);
    const got = r.pins.map((p) => `${p.kind}:${p.text}:${p.where.replace(/:\d+$/, "")}`).sort();
    assert.deepEqual(got, [
      "agent:claude-sonnet-4-6:~/.pi/agent/agents/a.md",
      "cron:claude-haiku-4-5:cron job j",
      "doc:claude-haiku-4-5:~/.agents/skills/s/SKILL.md",
      "doc:gpt-5.6-luna:~/code/local-pkg/README.md",
      "package:anthropic/claude-haiku-4-5:~/.pi/agent/git/github.com/o/r/src/d.ts",
      "settings:claude-opus-5:settings.json defaultModel",
      "source:claude-haiku-4-5:~/.pi/agent/extensions/t.ts",
      "source:gpt-5.4-mini:~/starter/auto-title.ts",
      "source:gpt-5.6-sol:~/code/local-pkg/src/i.ts",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

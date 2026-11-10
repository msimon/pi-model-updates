import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeGitUrl } from "./findings.ts";
import { commitAndPush, commitMessage, isClean, originSlug, repoOf, runGit } from "./git.ts";

const ENV_OK = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

async function git(cwd: string, ...args: string[]) {
  const r = await runGit([...ENV_OK, ...args], cwd);
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare remote plus two clones: `a` (the one we edit) and `b` (someone else pushing). */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pmu-git-"));
  const remote = join(root, "remote.git");
  await runGit(["init", "-q", "--bare", "-b", "main", remote], root);
  const a = join(root, "a");
  await runGit(["clone", "-q", remote, a], root);
  await git(a, "checkout", "-q", "-b", "main");
  await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-4-5";\n');
  await writeFile(join(a, "other.ts"), "x\n");
  await git(a, "add", ".");
  await git(a, "commit", "-q", "-m", "init");
  await git(a, "push", "-q", "-u", "origin", "main");
  const b = join(root, "b");
  await runGit(["clone", "-q", remote, b], root);
  return { root, remote, a, b };
}

// Commits in tests need an identity; run with one in the environment.
const withIdentity = (cwd: string) => (args: string[]) => runGit([...ENV_OK, ...args], cwd);
const runner = (args: string[], cwd: string) => withIdentity(cwd)(args);

test("commitMessage: one pair in the subject, every file in the body", () => {
  const msg = commitMessage(
    [
      { file: "/r/a.ts", change: "claude-haiku-4-5 → claude-haiku-5-5" },
      { file: "/r/b.md", change: "claude-haiku-4-5 → claude-haiku-5-5" },
    ],
    (f) => f.replace("/r/", ""),
  );
  assert.match(msg, /^Update pinned model: claude-haiku-4-5 → claude-haiku-5-5\n\n- a\.ts: .*\n- b\.md: /);
  assert.match(commitMessage([{ file: "x", change: "a → b" }, { file: "y", change: "c → d" }], (f) => f), /^Update pinned models\n/);
});

test("commitAndPush: commits only the edited file and pushes", async () => {
  const { root, a, b } = await setup();
  try {
    assert.equal(await repoOf(join(a, "ext.ts")), await git(a, "rev-parse", "--show-toplevel"));
    assert.equal(await originSlug(a, (u) => (u.endsWith("remote.git") ? "local/x/remote" : normalizeGitUrl(u))), "local/x/remote");
    await writeFile(join(a, "other.ts"), "unrelated change\n"); // must not be committed
    assert.equal(await isClean(a, join(a, "ext.ts")), true);
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-5-5";\n');
    const r = await commitAndPush(a, [join(a, "ext.ts")], "Update pinned model", "push", runner);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.pushed, true);
    assert.match(r.detail, /pushed to origin\/main/);
    assert.equal(await git(a, "status", "--porcelain"), "M other.ts");
    await git(b, "pull", "-q");
    assert.equal(await readFile(join(b, "ext.ts"), "utf8"), 'const m = "claude-haiku-5-5";\n');
    assert.equal(await readFile(join(b, "other.ts"), "utf8"), "x\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commitAndPush: behind the remote, rebases and pushes", async () => {
  const { root, a, b } = await setup();
  try {
    await writeFile(join(b, "other.ts"), "from b\n");
    await git(b, "commit", "-q", "-am", "b");
    await git(b, "push", "-q");
    await git(a, "fetch", "-q");
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-5-5";\n');
    const r = await commitAndPush(a, [join(a, "ext.ts")], "Update pinned model", "push", runner);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /rebased onto origin\/main/);
    await git(b, "pull", "-q");
    assert.equal(await readFile(join(b, "ext.ts"), "utf8"), 'const m = "claude-haiku-5-5";\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commitAndPush: a conflicting remote change aborts the rebase and keeps the commit local", async () => {
  const { root, a, b } = await setup();
  try {
    await writeFile(join(b, "ext.ts"), 'const m = "claude-opus-5-5";\n');
    await git(b, "commit", "-q", "-am", "b");
    await git(b, "push", "-q");
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-5-5";\n');
    const r = await commitAndPush(a, [join(a, "ext.ts")], "Update pinned model", "push", runner);
    assert.equal(r.ok, false);
    assert.equal(r.committed, true);
    assert.equal(r.pushed, false);
    assert.match(r.detail, /stays local/);
    assert.equal(await git(a, "status", "--porcelain"), ""); // no rebase left in progress
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commitAndPush: commit mode does not push; no upstream is reported; off does nothing", async () => {
  const { root, a } = await setup();
  try {
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-5-5";\n');
    const c = await commitAndPush(a, [join(a, "ext.ts")], "m", "commit", runner);
    assert.deepEqual([c.committed, c.pushed], [true, false]);
    assert.match(await git(a, "status", "-sb"), /ahead 1/);

    // an earlier unpushed commit is never pushed along
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-6";\n');
    const ahead = await commitAndPush(a, [join(a, "ext.ts")], "m", "push", runner);
    assert.deepEqual([ahead.committed, ahead.pushed], [true, false]);
    assert.match(ahead.detail, /1 earlier local commit would go with it/);

    await git(a, "checkout", "-q", "-b", "local-only");
    await writeFile(join(a, "ext.ts"), 'const m = "claude-haiku-7";\n');
    const n = await commitAndPush(a, [join(a, "ext.ts")], "m", "push", runner);
    assert.deepEqual([n.committed, n.pushed], [true, false]);
    assert.match(n.detail, /no upstream/);

    await writeFile(join(a, "ext.ts"), "x\n");
    const off = await commitAndPush(a, [join(a, "ext.ts")], "m", "off", runner);
    assert.equal(off.committed, false);
    assert.equal(await isClean(a, join(a, "ext.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

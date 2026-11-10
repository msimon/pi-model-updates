// Commit and push the files /models-update edited inside git repositories.
//
// Only files that had no other uncommitted changes before the edit are
// committed (with `git commit -- <files>`, so nothing else staged rides along).
// A rejected push gets one `pull --rebase --autostash` and a second push; a
// rebase that does not apply cleanly is aborted and the commit stays local.

import { execFile } from "node:child_process";
import { dirname } from "node:path";

export type GitMode = "push" | "commit" | "off";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<RunResult>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Top-level directory of the repository holding `file`, if any. */
export async function repoOf(file: string, git: GitRunner = runGit): Promise<string | undefined> {
  const r = await git(["rev-parse", "--show-toplevel"], dirname(file));
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** True when `file` has no uncommitted changes (staged or not). */
export async function isClean(repo: string, file: string, git: GitRunner = runGit): Promise<boolean> {
  const r = await git(["status", "--porcelain", "--", file], repo);
  return r.code === 0 && r.stdout.trim() === "";
}

export interface RepoChange {
  file: string;
  /** e.g. `claude-haiku-4-5 → claude-haiku-5-5` */
  change: string;
}

export function commitMessage(changes: readonly RepoChange[], relative: (file: string) => string): string {
  const pairs = [...new Set(changes.map((c) => c.change))];
  const subject = pairs.length === 1 ? `Update pinned model: ${pairs[0]}` : "Update pinned models";
  const body = changes.map((c) => `- ${relative(c.file)}: ${c.change}`).join("\n");
  return `${subject}\n\n${body}\n\nApplied by /models-update (pi-model-updates).`;
}

function firstLine(r: RunResult): string {
  return (r.stderr || r.stdout).trim().split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
}

export interface CommitResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  detail: string;
}

/** Commit `files` (paths inside `repo`) and, in `push` mode, push the current branch. */
export async function commitAndPush(repo: string, files: readonly string[], message: string, mode: GitMode, git: GitRunner = runGit): Promise<CommitResult> {
  if (mode === "off" || files.length === 0) return { ok: true, committed: false, pushed: false, detail: "not committed" };
  // Before committing: the upstream, and whether unrelated local commits are waiting to be pushed
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo);
  const target = upstream.code === 0 ? upstream.stdout.trim() : undefined;
  const ahead = target ? Number((await git(["rev-list", "--count", "@{u}..HEAD"], repo)).stdout.trim()) || 0 : 0;

  const add = await git(["add", "--", ...files], repo);
  if (add.code !== 0) return { ok: false, committed: false, pushed: false, detail: `git add failed: ${firstLine(add)}` };
  const commit = await git(["commit", "-q", "-m", message, "--", ...files], repo);
  if (commit.code !== 0) return { ok: false, committed: false, pushed: false, detail: `git commit failed: ${firstLine(commit)}` };
  const sha = (await git(["rev-parse", "--short", "HEAD"], repo)).stdout.trim();
  if (mode === "commit") return { ok: true, committed: true, pushed: false, detail: `committed ${sha}` };
  if (!target) return { ok: false, committed: true, pushed: false, detail: `committed ${sha}; not pushed: the branch has no upstream` };
  if (ahead > 0) {
    return { ok: false, committed: true, pushed: false, detail: `committed ${sha}; not pushed: ${ahead} earlier local commit${ahead === 1 ? "" : "s"} would go with it` };
  }

  let push = await git(["push", "-q"], repo);
  if (push.code !== 0) {
    const pull = await git(["pull", "-q", "--rebase", "--autostash"], repo);
    if (pull.code !== 0) {
      await git(["rebase", "--abort"], repo);
      return { ok: false, committed: true, pushed: false, detail: `committed ${sha}; push rejected and pull --rebase failed (${firstLine(pull)}), so the commit stays local` };
    }
    push = await git(["push", "-q"], repo);
    if (push.code !== 0) return { ok: false, committed: true, pushed: false, detail: `committed; push failed after rebase: ${firstLine(push)}` };
    const rebased = (await git(["rev-parse", "--short", "HEAD"], repo)).stdout.trim();
    return { ok: true, committed: true, pushed: true, detail: `committed ${rebased} (rebased onto ${target}) and pushed` };
  }
  return { ok: true, committed: true, pushed: true, detail: `committed ${sha} and pushed to ${target}` };
}

/** `host/owner/repo` of the repo's origin, via the given normaliser. */
export async function originSlug(repo: string, normalize: (url: string) => string | undefined, git: GitRunner = runGit): Promise<string | undefined> {
  const r = await git(["remote", "get-url", "origin"], repo);
  return r.code === 0 ? normalize(r.stdout.trim()) : undefined;
}

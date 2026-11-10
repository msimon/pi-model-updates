// @msimon/pi-model-updates — notice when a newer model in the same family is
// available and update every place the setup pins a model, with approval.
//
// Startup: once per day, a few seconds after session_start and without
// blocking it, scan the pins against the model catalog, cache the counts in
// ~/.pi/agent/model-updates.json, set the `model-updates` footer status and
// show a one-line notice when something needs attention. Other sessions that
// day only restore the cached status. Startup never edits a pin.
//
// /models-update [refresh]: list every pin that can move or is missing, pick
// which to apply, review the diff, then write: settings.json and other files
// by exact replacement at the scanned offset, cron jobs via
// `pi-cron-jobs set <id> --model <id>`.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** `file` relative to `repo`; git reports the repo by its real path (e.g. /private/tmp on macOS). */
function inRepo(repo: string, file: string): string {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    // keep as given
  }
  return relative(repo, real);
}
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planFileEdits, writeFilePlan, type FilePlan } from "./apply.ts";
import { replacementChoices, type CatalogModel } from "./families.ts";
import { buildFindings, describe, groupReadOnly, normalizeGitUrl, noticeText, packageRepo, setManualTarget, statusText, summarize, type Finding, type IgnoreEntry } from "./findings.ts";
import { commitAndPush, commitMessage, isClean, originSlug, repoOf, type GitMode } from "./git.ts";
import { collectPins, tildePath, type CollectResult } from "./scan.ts";
import { loadState, localDay, saveState, type State } from "./state.ts";

const STATUS_KEY = "model-updates";
const STARTUP_DELAY_MS = 3_000;
const OWN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const statePath = () => join(getAgentDir(), "model-updates.json");
const cronJobsFile = () => process.env.PI_CRON_JOBS_DIR ? join(process.env.PI_CRON_JOBS_DIR, "jobs.json") : join(homedir(), ".pi", "cron-jobs", "jobs.json");
const label = (p: string) => tildePath(p, homedir());

/**
 * The models you can use: those of providers with configured auth, the same
 * list as `pi --list-models`. The full registry also carries every built-in
 * provider (bedrock, gateways...), which would make bare ids ambiguous; it is
 * only used when nothing has auth.
 */
function catalogOf(ctx: ExtensionContext): CatalogModel[] {
  const available = ctx.modelRegistry.getAvailable();
  const models = available.length ? available : ctx.modelRegistry.getAll();
  return models.map((m) => ({ provider: m.provider, id: m.id }));
}

async function scan(state: State): Promise<CollectResult> {
  return collectPins({
    agentDir: getAgentDir(),
    home: homedir(),
    cronJobsFile: cronJobsFile(),
    ownRoot: OWN_ROOT,
    extraPaths: state.extraPaths ?? [],
  });
}

/** Drop ignore entries whose pin no longer exists. */
function liveIgnores(ignored: readonly IgnoreEntry[], r: CollectResult): IgnoreEntry[] {
  const keys = new Set(r.pins.map((p) => p.key));
  return ignored.filter((i) => keys.has(i.key));
}

/** `host/owner/repo` of every extraPaths entry's git origin: packages you already scan as editable. */
async function coveredRepos(extraPaths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of extraPaths) {
    const dir = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    const repo = await originSlug(dir, normalizeGitUrl);
    if (repo) out.add(repo);
  }
  return out;
}

interface RepoPlan {
  repo: string;
  /** Edited files with no other uncommitted changes: committed and pushed. */
  files: string[];
  /** Edited files that already had other changes: edited but left uncommitted. */
  dirty: string[];
}

/** Which planned files live in a git repository, and which of them can be committed on their own. */
async function planRepos(plans: readonly FilePlan[]): Promise<RepoPlan[]> {
  const byRepo = new Map<string, RepoPlan>();
  for (const p of plans) {
    const repo = await repoOf(p.file);
    if (!repo) continue;
    const rp = byRepo.get(repo) ?? { repo, files: [], dirty: [] };
    ((await isClean(repo, p.file)) ? rp.files : rp.dirty).push(p.file);
    byRepo.set(repo, rp);
  }
  return [...byRepo.values()];
}

export default function modelUpdates(pi: ExtensionAPI) {
  let alive = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
    if (!alive) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // session replaced meanwhile
    }
  };

  async function recordCheck(r: CollectResult, findings: Finding[], state: State): Promise<void> {
    const now = new Date();
    await saveState(statePath(), {
      lastCheckDay: localDay(now),
      lastCheckAt: now.toISOString(),
      summary: summarize(findings),
      ignored: liveIgnores(state.ignored ?? [], r),
    });
  }

  async function dailyCheck(ctx: ExtensionContext): Promise<void> {
    const state = await loadState(statePath());
    if (state.summary) setStatus(ctx, statusText(state.summary));
    if (state.lastCheckDay === localDay(new Date())) return;
    const catalog = catalogOf(ctx);
    if (catalog.length === 0) return; // registry not ready; try next session
    const r = await scan(state);
    const findings = buildFindings(r.pins, catalog, state.ignored ?? []);
    await recordCheck(r, findings, state);
    const summary = summarize(findings);
    setStatus(ctx, statusText(summary));
    const notice = noticeText(summary);
    if (notice && alive) ctx.ui.notify(notice, "info");
  }

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    if (!ctx.hasUI) return;
    timer = setTimeout(() => {
      timer = undefined;
      dailyCheck(ctx).catch(() => undefined);
    }, STARTUP_DELAY_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    alive = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  });

  pi.registerCommand("models-update", {
    description: "Update pinned models (settings, cron jobs, extensions, skills) to the newest in their family",
    getArgumentCompletions: (prefix) => ("refresh".startsWith(prefix) ? [{ value: "refresh", label: "refresh", description: "Download the latest model list first" }] : null),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      try {
        await runCommand(args, ctx);
      } catch (err) {
        ctx.ui.notify(`models-update: ${(err as Error).message}`, "error");
      }
    },
  });

  async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (/\brefresh\b/.test(args)) {
      ctx.ui.notify("Refreshing the model list…", "info");
      await ctx.modelRegistry.refresh();
      const error = ctx.modelRegistry.getError();
      if (error) ctx.ui.notify(`Model list refresh: ${error}`, "warning");
    }
    const catalog = catalogOf(ctx);
    if (catalog.length === 0) {
      ctx.ui.notify("The model catalog is empty; nothing to compare against.", "warning");
      return;
    }
    let state = await loadState(statePath());
    const r = await scan(state);
    const findings = buildFindings(r.pins, catalog, state.ignored ?? []);
    await recordCheck(r, findings, state);
    state = await loadState(statePath());
    setStatus(ctx, statusText(summarize(findings)));
    const scanErrors = r.errors.length ? `\nCould not read:\n${r.errors.map((e) => `  ${e}`).join("\n")}` : "";

    if (findings.length === 0) {
      ctx.ui.notify(`All ${r.pins.length} pinned models are current (${r.filesScanned} files checked).${scanErrors}`, "info");
      return;
    }

    const editable = findings.filter((f) => f.pin.editable);
    const readOnly = groupReadOnly(findings, await coveredRepos(state.extraPaths ?? []));
    const selected = new Set(editable.filter((f) => !f.ignored && f.newText !== undefined));

    for (;;) {
      const rows = editable.map((f, i) => `${selected.has(f) ? "[x]" : "[ ]"} ${i + 1}. ${describe(f)}`);
      const pkgRows = readOnly.map(
        (g) => `    ${g.name} (managed git package, read-only): ${g.findings.length} pin${g.findings.length === 1 ? "" : "s"} could update`,
      );
      const apply = `Apply ${selected.size} selected`;
      const ignore = "Ignore selected (until a newer model appears)";
      const cancel = "Cancel";
      const choice = await ctx.ui.select(`Model pins (${r.pins.length} found): toggle rows, then apply`, [...rows, ...pkgRows, apply, ignore, cancel]);
      if (choice === undefined || choice === cancel) return;

      const pkg = readOnly[pkgRows.indexOf(choice)];
      if (pkg) {
        ctx.ui.notify(
          [
            `${pkg.name} is installed as a managed checkout, so it is not edited here. Change it in its own repository (add that to "extraPaths" in ~/.pi/agent/model-updates.json to edit it from here), push, then run pi update.`,
            ...pkg.findings.map((f) => `  ${describe(f)}`),
          ].join("\n"),
          "info",
        );
        continue;
      }
      if (choice === undefined || choice === cancel) return;

      if (choice === apply) {
        if (selected.size === 0) {
          ctx.ui.notify("Nothing selected.", "info");
          continue;
        }
        const done = await applySelected(ctx, findings.filter((f) => selected.has(f)), state);
        if (done) return;
        continue;
      }

      if (choice === ignore) {
        if (selected.size === 0) {
          ctx.ui.notify("Nothing selected.", "info");
          continue;
        }
        const ignored = [...(state.ignored ?? [])];
        for (const f of selected) {
          if (!ignored.some((i) => i.key === f.pin.key && i.target === (f.target ?? ""))) ignored.push({ key: f.pin.key, target: f.target ?? "" });
          f.ignored = true;
        }
        selected.clear();
        state.ignored = ignored;
        await saveState(statePath(), { ignored, summary: summarize(findings) });
        setStatus(ctx, statusText(summarize(findings)));
        continue;
      }

      const f = editable[rows.indexOf(choice)];
      if (!f) continue;
      if (selected.has(f)) {
        selected.delete(f);
        continue;
      }
      if (f.newText === undefined) {
        const picked = await pickReplacement(ctx, f, catalog);
        if (!picked) continue;
        setManualTarget(findings, f, picked, r.pins);
      }
      selected.add(f);
    }
  }

  async function pickReplacement(ctx: ExtensionCommandContext, f: Finding, catalog: CatalogModel[]): Promise<CatalogModel | undefined> {
    // defaultModel must stay with defaultProvider; otherwise prefer the resolved provider
    const choices = replacementChoices(f.provider, catalog);
    const list = choices.length ? choices : replacementChoices(undefined, catalog);
    const labels = list.map((m) => `${m.provider}/${m.id}`);
    const choice = await ctx.ui.select(`Replace ${f.pin.text} (${f.pin.where}) with`, labels);
    return choice === undefined ? undefined : list[labels.indexOf(choice)];
  }

  /** Returns true when the command is finished (applied or nothing left to do). */
  async function applySelected(ctx: ExtensionCommandContext, chosen: Finding[], state: State): Promise<boolean> {
    const gitMode: GitMode = state.git ?? "push";
    const cron = chosen.filter((f) => f.pin.kind === "cron");
    const files = chosen.filter((f) => f.pin.kind !== "cron");
    const { plans, errors } = await planFileEdits(files, label);
    const repoPlans = gitMode === "off" ? [] : await planRepos(plans);
    const cronCmds = cron.map((f) => ({ f, args: ["set", f.pin.jobId!, "--model", f.newText!] }));
    const verb = gitMode === "push" ? "commit and push" : "commit";
    const gitLines = repoPlans.flatMap((rp) => [
      ...(rp.files.length ? [`$ git ${verb} in ${label(rp.repo)}: ${rp.files.map((f) => inRepo(rp.repo, f)).join(", ")}`] : []),
      ...rp.dirty.map((f) => `  ${label(f)} already has other uncommitted changes: edited but not committed`),
    ]);
    const preview = [
      ...plans.map((p) => p.diff),
      ...(cronCmds.length ? [cronCmds.map((c) => `$ pi-cron-jobs ${c.args.join(" ")}`).join("\n")] : []),
      ...(gitLines.length ? [gitLines.join("\n")] : []),
      ...(errors.length ? [`Skipped:\n${errors.map((e) => `  ${e}`).join("\n")}`] : []),
    ].join("\n\n");
    const count = plans.reduce((n, p) => n + p.findings.length, 0) + cronCmds.length;
    if (count === 0) {
      ctx.ui.notify(`Nothing can be applied.\n${preview}`, "warning");
      return false;
    }
    const ok = await ctx.ui.confirm(`Apply ${count} change${count === 1 ? "" : "s"}?`, preview);
    if (!ok) return false;

    const results: string[] = [];
    const written = new Map<string, FilePlan>();
    let settingsChanged = false;
    const changeOf = (f: Finding) => (f.newText && !f.remove ? `${f.pin.text} → ${f.newText}` : `removed ${f.pin.text}`);
    for (const plan of plans) {
      try {
        await writeFilePlan(plan);
        written.set(plan.file, plan);
        if (plan.findings.some((f) => f.pin.kind === "settings")) settingsChanged = true;
        results.push(`✓ ${plan.label} (${plan.findings.map(changeOf).join(", ")})`);
      } catch (err) {
        results.push(`✗ ${plan.label}: ${(err as Error).message}`);
      }
    }
    for (const c of cronCmds) {
      const res = await pi.exec("pi-cron-jobs", c.args, { timeout: 30_000 });
      if (res.code === 0) results.push(`✓ cron job ${c.f.pin.jobId}: ${c.f.pin.text} → ${c.f.newText}`);
      else results.push(`✗ cron job ${c.f.pin.jobId}: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}. Run: pi-cron-jobs ${c.args.join(" ")}`);
    }
    for (const e of errors) results.push(`✗ ${e}`);

    // Commit (and push) each repository's edited files on their own
    const leftDirty: string[] = [];
    const pushedRepos: string[] = [];
    for (const rp of repoPlans) {
      const files = rp.files.filter((f) => written.has(f));
      leftDirty.push(...rp.dirty.filter((f) => written.has(f)).map(label));
      if (!files.length) continue;
      const changes = files.flatMap((f) => written.get(f)!.findings.map((x) => ({ file: f, change: changeOf(x) })));
      const res = await commitAndPush(rp.repo, files, commitMessage(changes, (f) => inRepo(rp.repo, f)), gitMode);
      results.push(`${res.ok ? "✓" : "✗"} git ${label(rp.repo)}: ${res.detail}`);
      if (res.pushed) pushedRepos.push(rp.repo);
    }

    // A pushed repo that is the source of an installed git package needs `pi update`
    const installed = new Set(chosen.map((f) => packageRepo(f.pin.file)).filter(Boolean));
    for (const p of (await scan(state)).pins) {
      const repo = packageRepo(p.file);
      if (repo) installed.add(repo);
    }
    const needUpdate: string[] = [];
    for (const repo of pushedRepos) {
      const slug = await originSlug(repo, normalizeGitUrl);
      if (slug && installed.has(slug)) needUpdate.push(slug.split("/").slice(1).join("/"));
    }

    // Refresh the cached counts and footer status
    const r = await scan(state);
    const fresh = await loadState(statePath());
    await recordCheck(r, buildFindings(r.pins, catalogOf(ctx), fresh.ignored ?? []), fresh);
    const after = await loadState(statePath());
    setStatus(ctx, after.summary ? statusText(after.summary) : undefined);

    const lines = [...results];
    if (leftDirty.length) lines.push(`Not committed (they already had other changes): ${leftDirty.join(", ")}`);
    if (needUpdate.length) lines.push(`Run pi update to install the pushed ${needUpdate.join(", ")} package${needUpdate.length === 1 ? "" : "s"}.`);
    lines.push(
      settingsChanged
        ? "Run /reload now so pi picks up settings.json (and so a model chosen earlier with /model is not written back over it)."
        : "Run /reload to pick up the changes.",
    );
    ctx.ui.notify(lines.join("\n"), results.some((l) => l.startsWith("✗")) ? "warning" : "info");
    return true;
  }
}

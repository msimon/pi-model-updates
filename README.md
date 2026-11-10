# pi-model-updates

A [pi](https://pi.dev) extension that notices when a newer model in the same family is available and, with your approval, updates every place your setup pins a model.

## What it does

- **Once a day**, a few seconds after a session starts (never blocking startup), it scans your model pins against the models you can use (the same list as `pi --list-models`). If something can move or is missing, it sets the `model-updates` footer status, e.g. `models: 1 update · 1 missing`, and shows a one-line notice. Later sessions that day restore the status from the cached result without rescanning. Startup never edits a pin.
- **`/models-update`** lists every pin that can move (`old → new · where`), plus pins missing from the catalog. Toggle rows, then:
  - **Apply**: shows the diff for every file, the `pi-cron-jobs` commands and the git commits, asks to confirm, applies, commits and pushes, and tells you to `/reload` (and `pi update` when a pushed repo is the source of an installed git package).
  - **Ignore**: hides a suggestion until an even newer model appears.
  - A missing pin with no newer model in its family (e.g. `gpt-5.4-mini`) gets a picker to choose its replacement by hand.
- **`/models-update refresh`** downloads the latest model list first.

## What counts as newer

| Shape | Examples | Family |
|---|---|---|
| `claude-<family>-<major>[-<minor>][-<YYYYMMDD>]` | `claude-opus-5-5`, `claude-fable-5`, `claude-haiku-4-5-20251001` | `opus`, `fable`, `haiku` |
| `gpt-<major>[.<minor>]-<family>` | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.4-mini` | `sol`, `astra`, `mini` |

A newer model has the same provider and family and a higher version, compared as numbers (5.6 < 6 < 6.1). Dated snapshots are never suggested. A pinned dated snapshot is compared as its base version. Ids of any other shape never get a suggestion, and families never cross (`mini` never becomes `sol`). Ids written without a provider (cron jobs, plain strings) take their provider from the catalog. When several providers could own one, it is flagged as ambiguous.

## Where it looks

| Kind | Where | How it is changed |
|---|---|---|
| settings | `~/.pi/agent/settings.json`: `defaultModel` (with `defaultProvider`) and `enabledModels` | The value is replaced in place under pi's settings lock, so formatting and key order stay as they are. An `enabledModels` entry whose replacement is already listed is removed. |
| cron | `~/.pi/cron-jobs/jobs.json`: each job's `model` | `pi-cron-jobs set <jobId> --model <id>` |
| config | `~/.pi/agent/subagents.json`: keys ending in `model` | exact replacement |
| agent | `model:` front matter in `~/.pi/agent/agents/*.md` | exact replacement |
| source | quoted model ids in `~/.pi/agent/extensions/`, in local paths listed under `extensions` and `packages` in settings.json, and in `extraPaths` (ids inside comments are skipped) | exact replacement |
| doc | model ids in the text of `~/.agents/skills/**/*.md`, plus Markdown in local packages and `extraPaths` | exact replacement |
| package | git package checkouts under `~/.pi/agent/git/` | shown as one read-only row per package, never edited |

Tests, `node_modules`, `dist` and this package's own files are not scanned. A file is only written if it is unchanged since the scan.

## Git

Edited files inside a git repository are committed, one commit per repository, and pushed to the branch's upstream. Only the edited files go into the commit (`git commit -- <files>`), so other work in the repository is never included. A file that already had uncommitted changes before the edit is edited but left uncommitted, and the result says so. When the push is rejected because the remote moved on, it runs `git pull --rebase --autostash` once and pushes again. If that rebase does not apply cleanly, it is aborted and the commit stays local. It also does not push when the branch already had unpushed commits of its own, or has no upstream. Set `"git": "commit"` (commit only) or `"git": "off"` in `model-updates.json` to change this.

## Configuration

`~/.pi/agent/model-updates.json` belongs to the extension. You can edit `extraPaths` and `git`; the extension maintains the other keys.

```json
{
  "extraPaths": ["~/code/pi-starter", "~/code/forks/pi-subagents/src"],
  "git": "push",
  "ignored": [],
  "lastCheckDay": "2026-11-10",
  "summary": { "updates": 1, "missing": 1 }
}
```

The footer status uses the key `model-updates`. With [pi-footer](https://www.npmjs.com/package/pi-footer), add a `Pi Extension Status` widget for that key.

## Install

```bash
pi install git:github.com/msimon/pi-model-updates
```

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT

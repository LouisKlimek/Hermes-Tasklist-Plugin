# Hermes TaskList — ClickUp‑style List View for the Hermes Agent Kanban Board

> A drop‑in dashboard plugin for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** that adds a fast, groupable **list view** on top of the built‑in multi‑agent Kanban board — inline editing, ClickUp‑style task detail popups, and live updates. No fork, no build step.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Hermes Agent](https://img.shields.io/badge/Hermes%20Agent-dashboard%20plugin-7c3aed.svg)](https://github.com/NousResearch/hermes-agent)
[![Build](https://img.shields.io/badge/build-none%20required-success.svg)](#development)

The stock Hermes Agent dashboard ships a Kanban board for its multi‑agent task system. It's great for dragging cards across columns, but it's *only* a board. **Hermes TaskList** gives you the other half of the picture: a dense, sortable, filterable **task list** that you can **group by status, assignee, priority, tenant, or project** — the way you'd work in ClickUp, Linear, or Asana — backed by the exact same task database. Switch between the board and the list whenever the view fits the job.

It's a pure dashboard UI plugin: it reads and writes the same `~/.hermes/kanban.db` through Hermes' existing `/api/plugins/kanban/*` REST API, so it stays perfectly in sync with the Kanban tab, the `hermes kanban` CLI, and the agent workers.

---

## Features

- **Grouped list view** — group tasks by **Status**, **Assignee**, **Priority**, **Tenant**, **Project**, or nothing. Collapsible groups with task counts and a "done" rollup.
- **Sort & filter** — sort within each group by priority, created date, or title (asc/desc); full‑text search across title / id / body; filter by tenant and assignee; toggle archived tasks.
- **Inline editing** — change a task's **status**, **priority**, and **assignee** right from the row, without opening anything. Edits route through the same validated state machine the board uses.
- **ClickUp‑style task detail popup** — click any task to open a modal with the full picture: editable title, status/priority/assignee, the full body, the latest run summary, workspace and timing metadata, parent/child links (clickable), comment threads, and run history.
- **Live updates** — the list polls the board's append‑only event log and refreshes only when something actually changed; pauses automatically when the browser tab is hidden.
- **Multi‑board aware** — a board switcher appears automatically when you have more than one Kanban board.
- **Zero dependencies, zero build** — a single pre‑built IIFE bundle that uses the Hermes Plugin SDK. Drop the folder in and refresh.

## Screenshots

> Add your own screenshots here once installed (recommended for the GitHub repo).

| List view with grouping | Task detail popup |
| --- | --- |
| `docs/screenshot-list.png` | `docs/screenshot-modal.png` |

## Requirements

- A working **Hermes Agent** install with the **web dashboard** enabled (`hermes dashboard`).
- The bundled **Kanban** plugin enabled (this plugin reuses its API). If `hermes kanban init` has run and the Kanban tab shows up, you're good.
- A modern browser. No Node.js, npm, or build toolchain required to install.

Built and tested against Hermes Agent `main` (≈ v0.14.x). The plugin only relies on the documented, stable Plugin SDK (`window.__HERMES_PLUGIN_SDK__`) and the public kanban REST surface.

## Installation

Hermes discovers dashboard plugins by scanning for `<plugin>/dashboard/manifest.json`. Install into your user plugins directory:

```bash
# Option A — clone straight into the plugins directory
git clone https://github.com/<your-user>/hermes-tasklist.git ~/.hermes/plugins/tasklist

# Option B — download a release tarball and extract
tar -xzf tasklist-plugin.tar.gz -C ~/.hermes/plugins/
```

The final layout must be:

```
~/.hermes/plugins/tasklist/
└── dashboard/
    ├── manifest.json
    └── dist/
        └── index.js
```

Then pick the new tab up **without** restarting the whole agent:

```bash
# force a rescan of dashboard plugins (needs the dashboard's session token)
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

…or simply **restart `hermes dashboard`** (it rescans on start). Finally, hard‑refresh the browser (Ctrl+Shift+R). A **List** tab appears in the navigation.

> Dashboard plugins do **not** need a `plugins.enabled` entry in `config.yaml` — that gate only applies to lifecycle/tool plugins. Dashboard plugins are discovered purely via their `dashboard/manifest.json`.

## Usage

- Open the **List** tab.
- Use the toolbar to pick how tasks are **grouped** and **sorted**, search, and filter by tenant/assignee.
- Edit a task's **status**, **priority**, or **assignee** directly in its row.
- **Click a task** to open the detail popup — edit the title (Enter or click‑away to save), update fields, read the body, comments, links, and run history. Close with the ✕, a click on the backdrop, or `Esc`.

## How it works

Hermes TaskList is a thin client over the existing kanban backend — it adds **no** server‑side logic:

```
┌────────────────────────────┐
│  List tab (React, this UI)  │  group / sort / filter / edit
└──────────────┬─────────────┘
               │  SDK.fetchJSON  (GET /board, /tasks/:id, /assignees, /boards)
               │                 (PATCH /tasks/:id  → status / priority / assignee / title)
               ▼
┌────────────────────────────┐
│  Kanban plugin FastAPI API  │  /api/plugins/kanban/*   (unchanged, bundled)
└──────────────┬─────────────┘
               ▼
        ~/.hermes/kanban.db   (shared with the board, CLI, and workers)
```

Because every write goes through the same `PATCH /tasks/:id` endpoint the board's drag‑and‑drop uses, status transitions are validated by Hermes' state machine — invalid moves surface a clear message instead of corrupting state.

## Configuration

Everything lives in `dashboard/manifest.json`:

```json
{
  "name": "tasklist",
  "label": "List",
  "icon": "FileText",
  "tab": { "path": "/list", "position": "after:skills" },
  "entry": "dist/index.js"
}
```

- **`label`** — the tab name in the nav.
- **`icon`** — any [Lucide](https://lucide.dev) icon name supported by the dashboard.
- **`tab.position`** — `after:skills` is the safe default. Some Hermes builds also resolve `after:kanban` to place it next to the board; if your build doesn't, the tab falls back to the end of the nav.

## Troubleshooting

**The List tab doesn't appear.**

1. **Check the path & structure.** `~/.hermes/plugins/tasklist/dashboard/manifest.json` and `.../dashboard/dist/index.js` must both exist, with no extra nesting (not `tasklist/tasklist/...`).
2. **Rescan or restart.** Plugin discovery is cached per dashboard process — a browser refresh alone is not enough. Hit `/api/dashboard/plugins/rescan` or restart `hermes dashboard`.
3. **Right user / home.** The dashboard scans the plugins directory of the user (and `HERMES_HOME`) it runs under. If it runs as a service under a different user, install into *that* user's `~/.hermes/plugins/`. Some installs scan the in‑repo plugins directory instead (e.g. `~/.hermes/hermes-agent/plugins/`); if the user dir doesn't work, try there.
4. **Inspect from the browser.** Open DevTools → Console and run
   `window.__HERMES_PLUGIN_SDK__.fetchJSON('/api/dashboard/plugins').then(console.log)`
   to see whether `tasklist` was discovered. Then check the Network tab for `dashboard-plugins/tasklist/dist/index.js` (a 404 means a path/`entry` mismatch).

**The tab loads but editing does nothing.** Status/priority/assignee edits use `SDK.fetchJSON(path, init)` with a `PATCH` request. If your Hermes build's `fetchJSON` doesn't forward the request options, edits won't persist (reads still work). Open an issue with your `hermes --version` and we'll adapt the bundle.

## Development

There is **no build step** — `dashboard/dist/index.js` is a plain IIFE that consumes globals from the Hermes Plugin SDK (`React`, `hooks`, `components`, `utils`, `fetchJSON`). To customize:

1. Edit `dashboard/dist/index.js` directly.
2. Rescan/restart the dashboard and hard‑refresh.

If you prefer a JSX + bundler workflow (esbuild / Vite / Rollup), build to a single IIFE file with React marked **external** (it comes from `SDK.React`) and emit it as `dashboard/dist/index.js`. See Hermes' [Extending the Dashboard](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/extending-the-dashboard.md) guide and the official [hermes-example-plugins](https://github.com/NousResearch/hermes-example-plugins) for the contract.

## Limitations & notes

- **Read/write parity, not new fields.** TaskList exposes what the kanban API exposes. It doesn't add custom fields, due dates, or saved views (yet).
- **`running` is not directly settable.** The backend reserves that transition for the dispatcher/claim path, so it's intentionally omitted from the status picker.
- **Polling, not WebSocket.** For drop‑in robustness the list polls the cheap board endpoint and diffs the event id rather than holding the authenticated WebSocket. It's light and pauses on hidden tabs.

## Roadmap

- Inline comment composing (`POST /tasks/:id/comments`)
- Create / link subtasks from the popup
- Saved views (persisted group/sort/filter presets)
- Optional WebSocket live stream instead of polling

Contributions welcome — see below.

## Contributing

Issues and pull requests are welcome. Please include your Hermes Agent version (`hermes --version`) and, for UI issues, a screenshot plus any relevant browser console output.

## License

[MIT](LICENSE) — same license as Hermes Agent and the official example plugins. You'll want to add a `LICENSE` file with your name and the current year before publishing.

## Related & acknowledgements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research — the agent framework and the bundled Kanban board this plugin builds on.
- [Extending the Dashboard](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/extending-the-dashboard.md) — the Plugin SDK reference.
- [hermes-example-plugins](https://github.com/NousResearch/hermes-example-plugins) — reference implementations of dashboard plugins.

---

<sub>Keywords: Hermes Agent dashboard plugin · multi‑agent kanban board · ClickUp‑style list view · agent task management UI · Nous Research Hermes · kanban list view plugin · self‑hosted AI agent orchestration.</sub>

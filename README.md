# Hermes TaskList — ClickUp‑style List View for the Hermes Agent Kanban Board

> A drop‑in dashboard plugin for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** that adds a fast, groupable **list view** on top of the built‑in multi‑agent Kanban board — inline editing, ClickUp‑style task detail popups, and live updates. No fork, no build step.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Hermes Agent](https://img.shields.io/badge/Hermes%20Agent-dashboard%20plugin-7c3aed.svg)](https://github.com/NousResearch/hermes-agent)
[![Build](https://img.shields.io/badge/build-none%20required-success.svg)](#development)

The stock Hermes Agent dashboard ships a Kanban board for its multi‑agent task system. It's great for dragging cards across columns, but it's *only* a board. **Hermes TaskList** gives you the other half of the picture: a dense, sortable, filterable **task list** that you can **group by status, assignee, priority, tenant, or project** — the way you'd work in ClickUp, Linear, or Asana — backed by the exact same task database. Switch between the board and the list whenever the view fits the job.

It's a pure dashboard UI plugin: it reads and writes the same `~/.hermes/kanban.db` through Hermes' existing `/api/plugins/kanban/*` REST API, so it stays perfectly in sync with the Kanban tab, the `hermes kanban` CLI, and the agent workers.

---

## Features

- **Grouped list view** — group tasks by **Status**, **Assignee**, **Priority**, **Tenant**, **Project**, **custom List**, or nothing. Collapsible groups with task counts and a "done" rollup.
- **Custom lists + drag & drop** — create your own named lists and **drag tasks between them** to organize work into buckets that don't exist in the kanban model (e.g. "This sprint", "Waiting on client", "Icebox"). Lists are persistent and per‑board, stored by a tiny companion backend. You can also set a task's list from the detail popup.
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

### Easiest — install from the dashboard (no terminal)

Open the **Plugins** tab in the dashboard sidebar → **Install from GitHub / Git URL**, paste the repo and click **Install**:

```
https://github.com/LouisKlimek/Hermes-Tasklist-Plugin
```

(the shorthand `LouisKlimek/Hermes-Tasklist-Plugin` works too). Then click the **↻ rescan** icon next to the *Plugins* heading — or restart `hermes dashboard` — and hard‑refresh the browser (Ctrl+Shift+R). The **List** tab appears in the sidebar.

- Leave **Enable after install** off — dashboard plugins are discovered via their `dashboard/manifest.json` and don't need a `plugins.enabled` entry (that gate only applies to lifecycle/tool plugins).
- The repo root *is* the plugin (its `dashboard/manifest.json` sits at the top level), so the bare URL is enough. If you ever nest the plugin in a subfolder, append the path: `owner/repo#path/to/plugin`.

### Manual — clone or extract

```bash
# clone straight into the plugins directory
git clone https://github.com/LouisKlimek/Hermes-Tasklist-Plugin ~/.hermes/plugins/tasklist

# …or extract a release tarball
tar -xzf tasklist-plugin.tar.gz -C ~/.hermes/plugins/
```

Either way, the final layout must be:

```
~/.hermes/plugins/tasklist/
└── dashboard/
    ├── manifest.json
    ├── plugin_api.py        # custom-lists backend (mounted at /api/plugins/tasklist/)
    └── dist/
        └── index.js
```

Then rescan (the **↻** in the Plugins tab, or `curl http://127.0.0.1:9119/api/dashboard/plugins/rescan` with the dashboard's session token) **or** restart `hermes dashboard` (it rescans on start), and hard‑refresh the browser.

> Plugin discovery is cached per dashboard process, so a browser refresh alone isn't enough — rescan or restart once after installing.

## Usage

- Open the **List** tab.
- Use the toolbar to pick how tasks are **grouped** and **sorted**, search, and filter by tenant/assignee.
- Edit a task's **status**, **priority**, or **assignee** directly in its row.
- **Click a task** to open the detail popup — edit the title (Enter or click‑away to save), update fields, read the body, comments, links, and run history. Close with the ✕, a click on the backdrop, or `Esc`.

### Custom lists

Switch **Group → List** to organize tasks into your own named buckets:

- Type a name and hit **+ Add list** to create one (empty lists are kept).
- **Drag a task** from one list onto another to move it; drop onto **No list** to remove it. You can also change a task's list from the **List** field in the detail popup.
- Click a list's name to **rename** it; the ✕ on a list header **deletes** the list (tasks stay, they just leave that list).
- Lists are saved per board and persist across reloads and browsers.

## How it works

Hermes TaskList is a thin client over the existing kanban backend, plus a tiny companion backend for the custom‑lists feature:

```
┌────────────────────────────┐
│  List tab (React, this UI)  │  group / sort / filter / edit / drag&drop
└───────┬──────────────┬──────┘
        │              │  SDK.fetchJSON
        │              ▼
        │     ┌──────────────────────────┐   custom lists + membership
        │     │ tasklist FastAPI (this)   │   /api/plugins/tasklist/*
        │     └────────────┬─────────────┘
        │                  ▼   $HERMES_HOME/tasklist/lists.db   (overlay, human-only)
        │  GET /board, /tasks/:id, /assignees, /boards
        │  PATCH /tasks/:id  (status / priority / assignee / title)
        ▼
┌────────────────────────────┐
│  Kanban plugin FastAPI API  │  /api/plugins/kanban/*   (unchanged, bundled)
└──────────────┬─────────────┘
               ▼
        ~/.hermes/kanban.db   (shared with the board, CLI, and workers)
```

Task edits go through the kanban API's validated `PATCH /tasks/:id` (so invalid status transitions surface a clear message instead of corrupting state). **Custom lists** live in a separate `lists.db` owned by this plugin and are a *human organizational overlay* — agents, workers and the `hermes kanban` CLI don't see them. Membership is keyed by kanban task id and scoped per board.

## Configuration

Everything lives in `dashboard/manifest.json`:

```json
{
  "name": "tasklist",
  "label": "List",
  "icon": "FileText",
  "tab": { "path": "/list", "position": "after:skills" },
  "entry": "dist/index.js",
  "api": "plugin_api.py"
}
```

- **`label`** — the tab name in the nav.
- **`icon`** — any [Lucide](https://lucide.dev) icon name supported by the dashboard.
- **`tab.position`** — `after:skills` is the safe default. Some Hermes builds also resolve `after:kanban` to place it next to the board; if your build doesn't, the tab falls back to the end of the nav.
- **`api`** — the custom‑lists backend (`plugin_api.py`). The dashboard mounts it at `/api/plugins/tasklist/` and it writes `$HERMES_HOME/tasklist/lists.db`. Remove this line if you don't want the lists feature; the rest of the view keeps working.

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

- **Custom lists are a human overlay.** They live in this plugin's own `lists.db`, not in `kanban.db`, so agents, workers and the CLI don't see them. They're for organizing your own view.
- **Read/write parity for task fields.** TaskList exposes what the kanban API exposes for tasks (no custom due dates etc.). The list buckets are the one thing it adds on top.
- **`running` is not directly settable.** The backend reserves that transition for the dispatcher/claim path, so it's intentionally omitted from the status picker.
- **Polling, not WebSocket.** For drop‑in robustness the list polls the cheap board endpoint and diffs the event id rather than holding the authenticated WebSocket. It's light and pauses on hidden tabs.

## Roadmap

- Reorder lists by dragging their headers
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

# Hermes TaskList — ClickUp‑style List View for the Hermes Agent Kanban Board

> A drop‑in dashboard plugin for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** that adds a fast, groupable **list view** on top of the built‑in multi‑agent Kanban board — inline editing, ClickUp‑style task detail popups, and live updates. No fork, no build step.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Hermes Agent](https://img.shields.io/badge/Hermes%20Agent-dashboard%20plugin-7c3aed.svg)](https://github.com/NousResearch/hermes-agent)
[![Build](https://img.shields.io/badge/build-none%20required-success.svg)](#development)

![Hermes TaskList — grouped list view of the Kanban board](docs/screenshot-list.png)

The stock Hermes Agent dashboard ships a Kanban board for its multi‑agent task system. It's great for dragging cards across columns, but it's *only* a board. **Hermes TaskList** gives you the other half of the picture: a dense, sortable, filterable **task list** that you can **group by status, assignee, priority, tenant, or project** — the way you'd work in ClickUp, Linear, or Asana — backed by the exact same task database. Switch between the board and the list whenever the view fits the job.

It's a pure dashboard UI plugin: it reads and writes the same `~/.hermes/kanban.db` through Hermes' existing `/api/plugins/kanban/*` REST API, so it stays perfectly in sync with the Kanban tab, the `hermes kanban` CLI, and the agent workers.

---

## Features

- **Grouped list view** — inside any list, group tasks by **Status** (default, the kanban columns), **Assignee**, **Priority**, or nothing. Collapsible sections with task counts.
- **Subtask nesting** — parent tasks (those with kanban parent/child links) get a disclosure arrow; expand to see their child tasks nested underneath, at any depth. Children nest under their parent instead of cluttering the top level.
- **Boards → lists with drag & drop** — a ClickUp‑style left sidebar where every native Kanban **board** is a folder. Create named **lists** inside a board, click one to open it, **drag a task onto a list** (or use the per‑task List dropdown) to move it, and add tasks straight into a list with **+ Add task**. Lists are persistent and per‑board, stored by a tiny companion backend.
- **Sort & filter** — sort within each group by priority, created date, or title (asc/desc); full‑text search across title / id / body; filter by tenant and assignee; toggle archived tasks.
- **Inline editing** — change a task's **status**, **priority**, and **assignee** right from the row, without opening anything. Edits route through the same validated state machine the board uses.
- **Full task detail popup** — click any task to open a modal with the same capabilities as the native kanban drawer: editable title, status/priority/assignee/list, workspace and created‑by, an **editable description**, **dependencies** (add/remove parents & children), result, **attachments** (upload / download / delete), **comments** (read and post), the events log, the worker log (on demand), and run history.
- **Live updates** — the list polls the board's append‑only event log and refreshes only when something actually changed; pauses automatically when the browser tab is hidden.
- **Multi‑board aware** — a board switcher appears automatically when you have more than one Kanban board.
- **Zero dependencies, zero build** — a single pre‑built IIFE bundle that uses the Hermes Plugin SDK. Drop the folder in and refresh.

## Screenshots

The **List** tab — native Kanban boards as folders in the sidebar, lists inside them, tasks grouped by status with inline status/priority/assignee/list editing and per‑list subtask counts:

![List view grouped by status](docs/screenshot-list.png)

The **task detail popup** — a near‑full‑screen, two‑pane view with the editable fields, description, dependencies, result and attachments on the left, and an **Activity** pane (events, run history, comments) on the right:

![Task detail popup](docs/screenshot-modal.png)

## Requirements

- A working **Hermes Agent** install with the **web dashboard** enabled (`hermes dashboard`).
- The bundled **Kanban** plugin enabled (this plugin reuses its API). If `hermes kanban init` has run and the Kanban tab shows up, you're good.
- A modern browser. No Node.js, npm, or build toolchain required to install.

Built and tested against Hermes Agent `main` (≈ v0.14.x). The plugin only relies on the documented, stable Plugin SDK (`window.__HERMES_PLUGIN_SDK__`) and the public kanban REST surface.

## Installation

### Easiest — install from the dashboard (no terminal)

Open the **Plugins** tab in the dashboard sidebar → **Install from GitHub / Git URL**, paste the repo and click **Install**:

![Plugins tab — Install from GitHub / Git URL](docs/screenshot-install.png)

```
https://github.com/LouisKlimek/Hermes-Tasklist-Plugin
```

(the shorthand `LouisKlimek/Hermes-Tasklist-Plugin` works too). Then **restart `hermes dashboard`** and hard‑refresh the browser (Ctrl+Shift+R). The **List** tab appears in the sidebar.

> A rescan is **not** enough: this plugin ships a backend (`plugin_api.py`), and plugin API routes are mounted only when the dashboard process starts. You must restart `hermes dashboard` after installing or updating.

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

Then **restart `hermes dashboard`** and hard‑refresh the browser.

> Plugin discovery is cached per dashboard process and, more importantly, the plugin's backend API routes only mount at startup — so a browser refresh or a rescan alone won't work. Restart the dashboard after installing or updating this plugin.

## Usage

- Open the **List** tab.
- Use the toolbar to pick how tasks are **grouped** and **sorted**, search, and filter by tenant/assignee.
- Edit a task's **status**, **priority**, or **assignee** directly in its row.
- **Click a task** to open the detail popup — it mirrors the native kanban drawer: edit the title (Enter or click‑away to save) and status/priority/assignee/list, edit the **description**, add/remove **parent & child dependencies**, upload/download/delete **attachments**, **post comments**, and read the events log, worker log, and run history. Close with the ✕, a click on the backdrop, or `Esc`.

### Boards & lists (the left sidebar)

The List tab has a left sidebar, like ClickUp — with your native Kanban **boards** as the top level:

- Each board is a collapsible folder. New boards are created the normal way in the **Kanban** tab; this sidebar simply lists them.
- Open a board and click its **+** to create a **list** inside it. Click a list to open it — the main area shows that list's tasks grouped by **status** (To Do, Done, … as collapsible sections). Empty status sections are hidden; **To Do** is always shown so you can quickly add tasks. Each board also has **All tasks** and **No list**.
- **Move a task into a list** two ways: drag the task row onto a list in the sidebar, or use the **List** dropdown on the task row (and in the detail popup). Drag a task onto **No list** to remove it. (Lists belong to a board, so tasks move between lists within the same board.)
- Inside an open list, each status section has a **+ Add task** row that creates a new task on that board in that list and status.
- **Subtasks**: a task that has kanban child links shows a ▸ arrow — click it to expand its children inline (the parent's `N/M` pill shows how many are done). Children appear nested under their parent rather than as separate rows.
- Click a list's name to **rename** it; the **✕** deletes it (the tasks stay on the board, they just leave the list).

## How it works

Hermes TaskList is a thin client over the existing kanban backend, plus a tiny companion backend for the custom‑lists feature:

```
┌────────────────────────────┐
│  List tab (React, this UI)  │  group / sort / filter / edit / drag&drop
└───────┬──────────────┬──────┘
        │              │  SDK.fetchJSON
        │              ▼
        │     ┌──────────────────────────┐   per-board lists + membership
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

Task edits go through the kanban API's validated `PATCH /tasks/:id` (so invalid status transitions surface a clear message instead of corrupting state). **Lists** live in a separate `lists.db` owned by this plugin and are a *human organizational overlay* — agents, workers and the `hermes kanban` CLI don't see them. Membership is keyed by kanban task id and scoped per board. For **subtask nesting**, the plugin reads the kanban board's `task_links` table read-only (best-effort; if it can't, the list just renders flat).

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
2. **Restart the dashboard.** The plugin's backend API routes (`/api/plugins/tasklist/*`) mount only when `hermes dashboard` starts — a browser refresh or a `/api/dashboard/plugins/rescan` won't load them. Fully restart the dashboard process after installing or updating. (A rescan only refreshes the frontend tab list, not Python routes.)
3. **Right user / home.** The dashboard scans the plugins directory of the user (and `HERMES_HOME`) it runs under. If it runs as a service under a different user, install into *that* user's `~/.hermes/plugins/`. Some installs scan the in‑repo plugins directory instead (e.g. `~/.hermes/hermes-agent/plugins/`); if the user dir doesn't work, try there.
4. **Inspect from the browser.** Open DevTools → Console and run
   `window.__HERMES_PLUGIN_SDK__.fetchJSON('/api/dashboard/plugins').then(console.log)`
   to see whether `tasklist` was discovered. Then check the Network tab for `dashboard-plugins/tasklist/dist/index.js` (a 404 means a path/`entry` mismatch).

**The tab loads but editing does nothing.** Status/priority/assignee edits use `SDK.fetchJSON(path, init)` with a `PATCH` request. If your Hermes build's `fetchJSON` doesn't forward the request options, edits won't persist (reads still work). Open an issue with your `hermes --version` and we'll adapt the bundle.

## Development

There is **no build step** — `dashboard/dist/index.js` is a plain IIFE that consumes globals from the Hermes Plugin SDK (`React`, `hooks`, `components`, `utils`, `fetchJSON`). To customize:

1. Edit `dashboard/dist/index.js` directly.
2. For frontend (`index.js`) changes, a rescan + hard‑refresh is enough. For backend (`plugin_api.py`) changes, **restart `hermes dashboard`** (API routes only mount at startup).

If you prefer a JSX + bundler workflow (esbuild / Vite / Rollup), build to a single IIFE file with React marked **external** (it comes from `SDK.React`) and emit it as `dashboard/dist/index.js`. See Hermes' [Extending the Dashboard](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/extending-the-dashboard.md) guide and the official [hermes-example-plugins](https://github.com/NousResearch/hermes-example-plugins) for the contract.

## Limitations & notes

- **Lists are a human overlay.** They live in this plugin's own `lists.db`, scoped per board, not in `kanban.db`, so agents, workers and the CLI don't see them. They're for organizing your own view. Boards themselves are the native Kanban boards.
- **Read/write parity for task fields.** TaskList exposes what the kanban API exposes for tasks (no custom due dates etc.). The list buckets are the one thing it adds on top.
- **`running` is not directly settable.** The backend reserves that transition for the dispatcher/claim path, so it's intentionally omitted from the status picker.
- **Polling, not WebSocket.** For drop‑in robustness the list polls the cheap board endpoint and diffs the event id rather than holding the authenticated WebSocket. It's light and pauses on hidden tabs.

## Roadmap

- Reorder lists by dragging their headers
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

"""TaskList auto-sort — a Hermes plugin hook that files kanban tasks into lists.

This is the *agent-free* half of the TaskList plugin. The dashboard half
(``dashboard/``) shows the List view; this half makes new tasks land in the
right list **by themselves**, so the user only installs + enables one plugin
and categorization just happens.

How it works
------------
It registers two kanban lifecycle hooks:

* ``kanban_task_claimed``   — fires when a worker starts a task (earliest signal;
                              there is no ``created`` hook in Hermes).
* ``kanban_task_completed`` — cheap backstop for anything the first hook missed.

On either event, for a task that isn't already in a list, it:

1. reads the task's title/body (read-only, straight from kanban.db),
2. **if the task has a parent already filed in a list, the child adopts the
   parent's list directly — no model call.** This is deterministic and is the
   reliable path for subtasks created automatically by AI via the API, which
   would otherwise default to "No list". After a task is filed, any of its own
   still-unsorted children adopt that list too, so a child claimed *before* its
   parent was sorted is fixed up as soon as the parent lands.
3. otherwise reads the board's existing lists from the TaskList DB,
4. asks the user's *active* model — via host-owned ``ctx.llm`` (no provider
   keys live in this plugin) — for the single best-fitting existing list, or a
   short new list name if none fits,
5. writes the membership (creating the list if needed) into the very same
   ``$HERMES_HOME/tasklist/lists.db`` the dashboard reads.

Everything is best-effort: any failure (no ``ctx.llm`` in this context, model
error, db hiccup) is swallowed so a misbehaving observer can never break a
board state transition. If ``ctx.llm`` isn't wired in your Hermes build's
worker-hook context, this simply no-ops — the dashboard + manual lists keep
working unchanged.

Install
-------
Drop the whole ``tasklist/`` directory into ``~/.hermes/plugins/`` (it carries
both the dashboard plugin and this hook), then::

    hermes plugins enable tasklist

Cost note
---------
One small structured model call per first-seen task. On a high-throughput board
that adds up; pin a cheap model for this plugin in ``config.yaml`` under
``plugins.entries.tasklist.llm.allowed_models`` if you care about spend.

The lists.db schema below is kept identical to ``dashboard/plugin_api.py``.
If you change it there, mirror it here.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# lists.db  (MUST match dashboard/plugin_api.py)
# --------------------------------------------------------------------------- #
def _hermes_home() -> Path:
    h = os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _db_path() -> Path:
    d = _hermes_home() / "tasklist"
    d.mkdir(parents=True, exist_ok=True)
    return d / "lists.db"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(_db_path()), check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(
        "CREATE TABLE IF NOT EXISTS lists ("
        "  id TEXT PRIMARY KEY,"
        "  board TEXT NOT NULL DEFAULT 'default',"
        "  name TEXT NOT NULL,"
        "  color TEXT,"
        "  position INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS membership ("
        "  board TEXT NOT NULL DEFAULT 'default',"
        "  task_id TEXT NOT NULL,"
        "  list_id TEXT NOT NULL,"
        "  updated_at INTEGER NOT NULL,"
        "  PRIMARY KEY (board, task_id))"
    )
    return c


def _board_key(b: Optional[str]) -> str:
    return (b or "default").strip() or "default"


def _existing_lists(c: sqlite3.Connection, board: str) -> list[dict]:
    rows = c.execute(
        "SELECT id, name FROM lists WHERE board=? ORDER BY position, name", (board,)
    ).fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


def _already_in_list(c: sqlite3.Connection, board: str, task_id: str) -> bool:
    return c.execute(
        "SELECT 1 FROM membership WHERE board=? AND task_id=?", (board, task_id)
    ).fetchone() is not None


def _find_list_by_name(c: sqlite3.Connection, board: str, name: str) -> Optional[dict]:
    row = c.execute(
        "SELECT id, name FROM lists WHERE board=? AND lower(name)=lower(?)",
        (board, (name or "").strip()),
    ).fetchone()
    return {"id": row["id"], "name": row["name"]} if row else None


def _create_list(c: sqlite3.Connection, board: str, name: str) -> dict:
    pos = c.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lists WHERE board=?", (board,)
    ).fetchone()["p"]
    lid = uuid.uuid4().hex[:12]
    now = int(time.time())
    c.execute(
        "INSERT INTO lists (id, board, name, color, position, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (lid, board, name.strip(), None, pos, now),
    )
    c.commit()
    return {"id": lid, "name": name.strip()}


def _set_membership(c: sqlite3.Connection, board: str, task_id: str, list_id: str) -> None:
    now = int(time.time())
    c.execute(
        "INSERT INTO membership (board, task_id, list_id, updated_at) "
        "VALUES (?,?,?,?) "
        "ON CONFLICT(board, task_id) DO UPDATE SET "
        "  list_id=excluded.list_id, updated_at=excluded.updated_at",
        (board, task_id, list_id, now),
    )
    c.commit()


# --------------------------------------------------------------------------- #
# read the task from kanban.db (read-only, best-effort)
# --------------------------------------------------------------------------- #
def _kanban_db_path(board: str) -> Optional[Path]:
    try:
        from hermes_cli import kanban_db as _kdb  # type: ignore
        return Path(_kdb.kanban_db_path(board if board != "default" else None))
    except Exception:
        pass
    # heuristic fallback mirroring plugin_api.py
    root = _hermes_home()
    if board and board != "default":
        return root / "kanban" / "boards" / board / "kanban.db"
    return root / "kanban.db"


def _parent_ids(board: str, task_id: str) -> list[str]:
    """Return this task's parent ids from kanban.db's ``task_links`` (read-only).

    Order is stable/deterministic (insertion order) so multi-parent tasks always
    resolve to the same parent, keeping auto-placement reproducible.
    """
    path = _kanban_db_path(board)
    if not path or not path.exists():
        return []
    try:
        kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = kc.execute(
                "SELECT parent_id FROM task_links WHERE child_id=? ORDER BY rowid",
                (task_id,),
            ).fetchall()
        finally:
            kc.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("tasklist autosort: cannot read parents of %s: %s", task_id, exc)
        return []
    return [r[0] for r in rows if r and r[0]]


def _list_of_task(c: sqlite3.Connection, board: str, task_id: str) -> Optional[str]:
    """Return the list_id a task currently belongs to on this board, or None."""
    row = c.execute(
        "SELECT list_id FROM membership WHERE board=? AND task_id=?", (board, task_id)
    ).fetchone()
    return row["list_id"] if row else None


def _inherit_parent_list(c: sqlite3.Connection, board: str, task_id: str) -> Optional[str]:
    """If this task has a parent that is already filed in a list, return that
    parent's ``list_id`` so the child can adopt it. Deterministic, no model call.

    Walks each parent in stable order and returns the first parent that already
    has a list membership. This is what makes AI/API-created subtasks land in the
    same list as their parent instead of defaulting to "No list".
    """
    for pid in _parent_ids(board, task_id):
        lid = _list_of_task(c, board, pid)
        if lid:
            return lid
    return None


def _child_ids(board: str, task_id: str) -> list[str]:
    """Return this task's direct child ids from ``task_links`` (read-only)."""
    path = _kanban_db_path(board)
    if not path or not path.exists():
        return []
    try:
        kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = kc.execute(
                "SELECT child_id FROM task_links WHERE parent_id=? ORDER BY rowid",
                (task_id,),
            ).fetchall()
        finally:
            kc.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("tasklist autosort: cannot read children of %s: %s", task_id, exc)
        return []
    return [r[0] for r in rows if r and r[0]]


def _propagate_to_children(
    c: sqlite3.Connection, board: str, task_id: str, list_id: str, _depth: int = 0
) -> None:
    """Push ``list_id`` onto any UNSORTED descendants of ``task_id``.

    Covers the ordering case where a child was seen/claimed before its parent
    was filed: once the parent lands in a list, its still-unsorted children (and
    their children) adopt the same list. Bounded recursion depth guards against
    pathological / cyclic link data.
    """
    if _depth > 25:
        return
    for cid in _child_ids(board, task_id):
        if _already_in_list(c, board, cid):
            continue  # respect manual / earlier placement on the child
        _set_membership(c, board, cid, list_id)
        logger.info(
            "tasklist autosort: %s inherited list %s from ancestor %s",
            cid, list_id, task_id,
        )
        _propagate_to_children(c, board, cid, list_id, _depth + 1)


def _read_task(board: str, task_id: str) -> Optional[dict]:
    path = _kanban_db_path(board)
    if not path or not path.exists():
        return None
    try:
        kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        kc.row_factory = sqlite3.Row
        try:
            row = kc.execute(
                "SELECT title, body, assignee, tenant FROM tasks WHERE id=?", (task_id,)
            ).fetchone()
        finally:
            kc.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("tasklist autosort: cannot read task %s: %s", task_id, exc)
        return None
    if not row:
        return None
    return {
        "title": row["title"] or "",
        "body": row["body"] or "",
        "assignee": (row["assignee"] if "assignee" in row.keys() else "") or "",
        "tenant": (row["tenant"] if "tenant" in row.keys() else "") or "",
    }


# --------------------------------------------------------------------------- #
# classification via host-owned LLM (no keys in this plugin)
# --------------------------------------------------------------------------- #
_SCHEMA = {
    "type": "object",
    "properties": {
        "list_name": {"type": "string", "description": "exact existing list name, or a new short one"},
        "create_new": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["list_name", "create_new"],
    "additionalProperties": True,
}

_INSTRUCTIONS = (
    "You file kanban tasks into named lists for a human's board overview. "
    "Choose the single best-fitting EXISTING list by its exact name. "
    "Only if no existing list reasonably fits, set create_new=true and propose a "
    "short, broad, REUSABLE list name in Title Case (1-3 words) that future tasks "
    "could also share. Never invent near-duplicates of an existing list. "
    "Strongly prefer reusing an existing list."
)


def _classify(ctx: Any, task: dict, lists: list[dict]) -> Optional[dict]:
    llm = getattr(ctx, "llm", None)
    if llm is None or not hasattr(llm, "complete_structured"):
        logger.debug("tasklist autosort: ctx.llm unavailable in this context; skipping")
        return None
    names = ", ".join(sorted(l["name"] for l in lists)) or "(none yet)"
    body = (task.get("body") or "")[:2000]
    text = (
        f"Existing lists: {names}\n\n"
        f"Task title: {task.get('title', '')}\n"
        f"Task details: {body}\n"
        f"Assignee: {task.get('assignee', '')}  Tenant: {task.get('tenant', '')}"
    )
    try:
        res = llm.complete_structured(
            instructions=_INSTRUCTIONS,
            input=[{"type": "text", "text": text}],
            json_schema=_SCHEMA,
            schema_name="tasklist.assign",
            purpose="tasklist.autosort",
            temperature=0.0,
            max_tokens=200,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("tasklist autosort: model call failed: %s", exc)
        return None
    parsed = getattr(res, "parsed", None)
    if not isinstance(parsed, dict):
        return None
    name = str(parsed.get("list_name") or "").strip()
    if not name:
        return None
    return {"name": name, "create_new": bool(parsed.get("create_new"))}


# --------------------------------------------------------------------------- #
# the actual sort
# --------------------------------------------------------------------------- #
def _autosort(ctx: Any, task_id: str, board: Optional[str]) -> None:
    if not task_id:
        return
    board = _board_key(board)
    try:
        c = _conn()
    except Exception as exc:  # noqa: BLE001
        logger.debug("tasklist autosort: db open failed: %s", exc)
        return
    try:
        existing = _list_of_task(c, board, task_id)
        if existing:
            # Already placed (manual / earlier hook). Respect it, but still push
            # this list down to any unsorted children — this is what repairs a
            # child that was claimed BEFORE its parent got a list.
            _propagate_to_children(c, board, task_id, existing)
            return
        # 1) Deterministic parent inheritance — a task created with a parent
        #    adopts the parent's list (no model call). This is the reliable path
        #    for AI/API-created subtasks that would otherwise land in "No list".
        inherited = _inherit_parent_list(c, board, task_id)
        if inherited:
            _set_membership(c, board, task_id, inherited)
            logger.info(
                "tasklist autosort: %s inherited parent list %s", task_id, inherited
            )
            _propagate_to_children(c, board, task_id, inherited)
            return
        # 2) No usable parent list — fall back to LLM classification.
        task = _read_task(board, task_id)
        if not task or not (task.get("title") or task.get("body")):
            return
        lists = _existing_lists(c, board)
        choice = _classify(ctx, task, lists)
        if not choice:
            return
        target = _find_list_by_name(c, board, choice["name"])
        if target is None:
            # create it (model picked a name not present — that's the intent,
            # whether or not it flagged create_new)
            target = _create_list(c, board, choice["name"])
            logger.info("tasklist autosort: created list %r on board %r", target["name"], board)
        _set_membership(c, board, task_id, target["id"])
        logger.info("tasklist autosort: %s -> %r", task_id, target["name"])
        # Once a parent is filed, its still-unsorted children adopt the list too,
        # covering the case where a child was claimed before its parent.
        _propagate_to_children(c, board, task_id, target["id"])
    except Exception as exc:  # noqa: BLE001 — never break the board transition
        logger.warning("tasklist autosort failed for %s: %s", task_id, exc)
    finally:
        try:
            c.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# plugin entry point
# --------------------------------------------------------------------------- #
def register(ctx: Any) -> None:
    def on_claimed(*, task_id=None, board=None, **kw):
        _autosort(ctx, task_id, board)

    def on_completed(*, task_id=None, board=None, **kw):
        _autosort(ctx, task_id, board)  # backstop; no-ops if already placed

    ctx.register_hook("kanban_task_claimed", on_claimed)
    ctx.register_hook("kanban_task_completed", on_completed)
    logger.debug("tasklist autosort: hooks registered")

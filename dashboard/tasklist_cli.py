#!/usr/bin/env python3
"""tasklist_cli.py — agent-facing helper for the Hermes TaskList plugin.

Lets the task-creating AI (e.g. the Hermes orchestrator) sort kanban tasks
into the plugin's named LISTS — and create a fitting list when none exists —
WITHOUT going through the session-token-gated HTTP API. It writes directly to
the very same database the plugin/dashboard reads:

    $HERMES_HOME/tasklist/lists.db   (default: ~/.hermes/tasklist/lists.db)

so changes show up in the List view on the dashboard's next poll (~4 s).

The schema here is kept byte-for-byte identical to ``plugin_api.py``. If you
ever change the schema there, mirror it here.

Typical agent flow
------------------
1. See what lists already exist on the board (so you reuse, not duplicate):

       python3 tasklist_cli.py lists --board opportunity-discovery

2. Put a freshly-created task into the best-fitting list, creating it only if
   nothing fits:

       python3 tasklist_cli.py assign --board opportunity-discovery \
           --task t_b1c00dbf --list "Backend" --create

All commands print a single JSON object to stdout and exit 0 on success,
non-zero (with {"error": ...}) on failure — easy to parse from a tool wrapper.

Notes
-----
* ``--board`` is the board SLUG as the dashboard uses it (e.g. the normalized
  name "opportunity-discovery"); the default board is "default". Membership is
  keyed by this string, so it must match what the dashboard sends.
* Run this with the SAME environment (HERMES_HOME) as ``hermes dashboard`` so
  both resolve the identical database file.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path


# --------------------------------------------------------------------------- #
# storage  (MUST match plugin_api.py)
# --------------------------------------------------------------------------- #
def _hermes_home(override: str | None = None) -> Path:
    h = override or os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _db_path(home_override: str | None = None) -> Path:
    d = _hermes_home(home_override) / "tasklist"
    d.mkdir(parents=True, exist_ok=True)
    return d / "lists.db"


def _conn(home_override: str | None = None) -> sqlite3.Connection:
    c = sqlite3.connect(str(_db_path(home_override)), check_same_thread=False)
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


def _board(b: str | None) -> str:
    return (b or "default").strip() or "default"


# --------------------------------------------------------------------------- #
# operations
# --------------------------------------------------------------------------- #
def _list_row_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "color": r["color"],
        "position": r["position"],
        "created_at": r["created_at"],
    }


def _all_lists(c: sqlite3.Connection, board: str) -> list[dict]:
    rows = c.execute(
        "SELECT id, name, color, position, created_at FROM lists "
        "WHERE board=? ORDER BY position, name",
        (board,),
    ).fetchall()
    return [_list_row_to_dict(r) for r in rows]


def _find_list(c: sqlite3.Connection, board: str, needle: str) -> dict | None:
    """Resolve a list by exact id first, then by case-insensitive name."""
    needle = (needle or "").strip()
    if not needle:
        return None
    row = c.execute(
        "SELECT id, name, color, position, created_at FROM lists "
        "WHERE board=? AND id=?",
        (board, needle),
    ).fetchone()
    if row:
        return _list_row_to_dict(row)
    row = c.execute(
        "SELECT id, name, color, position, created_at FROM lists "
        "WHERE board=? AND lower(name)=lower(?)",
        (board, needle),
    ).fetchone()
    return _list_row_to_dict(row) if row else None


def _create_list(c: sqlite3.Connection, board: str, name: str, color: str | None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("list name required")
    pos = c.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lists WHERE board=?",
        (board,),
    ).fetchone()["p"]
    lid = uuid.uuid4().hex[:12]
    now = int(time.time())
    c.execute(
        "INSERT INTO lists (id, board, name, color, position, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (lid, board, name, color, pos, now),
    )
    c.commit()
    return {"id": lid, "name": name, "color": color, "position": pos, "created_at": now}


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


def _clear_membership(c: sqlite3.Connection, board: str, task_id: str) -> int:
    cur = c.execute(
        "DELETE FROM membership WHERE board=? AND task_id=?", (board, task_id)
    )
    c.commit()
    return cur.rowcount


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #
def cmd_lists(args) -> dict:
    board = _board(args.board)
    c = _conn(args.home)
    try:
        return {"board": board, "lists": _all_lists(c, board)}
    finally:
        c.close()


def cmd_create_list(args) -> dict:
    board = _board(args.board)
    c = _conn(args.home)
    try:
        existing = _find_list(c, board, args.name)
        if existing:
            return {"board": board, "list": existing, "created": False}
        lst = _create_list(c, board, args.name, args.color)
        return {"board": board, "list": lst, "created": True}
    finally:
        c.close()


def cmd_assign(args) -> dict:
    board = _board(args.board)
    if not (args.task or "").strip():
        raise ValueError("--task required")
    c = _conn(args.home)
    try:
        lst = _find_list(c, board, args.list)
        created = False
        if lst is None:
            if not args.create:
                raise ValueError(
                    f"list {args.list!r} not found on board {board!r}; "
                    f"pass --create to make it"
                )
            lst = _create_list(c, board, args.list, args.color)
            created = True
        _set_membership(c, board, args.task.strip(), lst["id"])
        return {
            "board": board,
            "task_id": args.task.strip(),
            "list": {"id": lst["id"], "name": lst["name"]},
            "created_list": created,
            "ok": True,
        }
    finally:
        c.close()


def cmd_unassign(args) -> dict:
    board = _board(args.board)
    if not (args.task or "").strip():
        raise ValueError("--task required")
    c = _conn(args.home)
    try:
        n = _clear_membership(c, board, args.task.strip())
        return {"board": board, "task_id": args.task.strip(), "removed": n, "ok": True}
    finally:
        c.close()


# --------------------------------------------------------------------------- #
# entrypoint
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tasklist_cli.py",
        description="Assign Hermes kanban tasks to TaskList lists (and create lists).",
    )
    p.add_argument("--home", default=None,
                   help="override HERMES_HOME (defaults to env or ~/.hermes)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("lists", help="print existing lists for a board (JSON)")
    s.add_argument("--board", default="default", help="board slug (default: default)")
    s.set_defaults(fn=cmd_lists)

    s = sub.add_parser("create-list", help="create a list (idempotent by name)")
    s.add_argument("--board", default="default")
    s.add_argument("--name", required=True)
    s.add_argument("--color", default=None, help="hex like #6366f1")
    s.set_defaults(fn=cmd_create_list)

    s = sub.add_parser("assign", help="put a task into a list (optionally creating it)")
    s.add_argument("--board", default="default")
    s.add_argument("--task", required=True, help="kanban task id, e.g. t_b1c00dbf")
    s.add_argument("--list", required=True, help="list name or id to assign to")
    s.add_argument("--create", action="store_true",
                   help="create the list if it does not already exist")
    s.add_argument("--color", default=None, help="color for a newly created list")
    s.set_defaults(fn=cmd_assign)

    s = sub.add_parser("unassign", help="remove a task from any list")
    s.add_argument("--board", default="default")
    s.add_argument("--task", required=True)
    s.set_defaults(fn=cmd_unassign)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        out = args.fn(args)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001  (single JSON error contract for callers)
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

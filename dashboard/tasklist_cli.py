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


def _readonly_conn(home_override: str | None = None) -> sqlite3.Connection:
    """Open an existing TaskList database without creating files or WAL state."""
    path = _hermes_home(home_override) / "tasklist" / "lists.db"
    if not path.is_file():
        raise ValueError(f"TaskList database not found: {path}")
    c = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


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


def _kanban_db_path(board: str, home_override: str | None = None) -> Path:
    """Locate a board DB without ever opening it for write access."""
    explicit = os.environ.get("HERMES_KANBAN_DB")
    if explicit:
        return Path(explicit)
    if home_override:
        root = Path(home_override)
    else:
        root = Path(os.environ.get("HERMES_KANBAN_HOME") or _hermes_home())
    return root / "kanban.db" if board == "default" else root / "kanban" / "boards" / board / "kanban.db"


def _read_kanban_tasks_and_links(path: Path) -> tuple[list[tuple[str, str]], dict[str, list[str]]]:
    if not path.exists():
        raise ValueError(f"kanban database not found: {path}")
    try:
        kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            tasks = [(str(row[0]), str(row[1] or "")) for row in kc.execute(
                "SELECT id, title FROM tasks ORDER BY id"
            )]
            parents: dict[str, list[str]] = {}
            for parent_id, child_id in kc.execute("SELECT parent_id, child_id FROM task_links ORDER BY rowid"):
                if parent_id and child_id:
                    parents.setdefault(str(child_id), []).append(str(parent_id))
            return tasks, parents
        finally:
            kc.close()
    except sqlite3.Error as exc:
        raise ValueError(f"cannot read kanban database: {exc}") from exc


def _assigned_ancestor_evidence(
    task_id: str, parents: dict[str, list[str]], membership: dict[str, str],
) -> tuple[str | None, list[str], bool]:
    """Return one unambiguous assigned ancestor list, otherwise ambiguity.

    Every reachable parent is considered. More than one assigned list is an
    explicit conflict; the caller must leave the task untouched. This differs
    from live inheritance, whose documented tie-breaker is link insertion
    order, because historical writes must be conservative.
    """
    stack = list(parents.get(task_id, ()))
    seen: set[str] = set()
    evidence: dict[str, list[str]] = {}
    while stack:
        ancestor = stack.pop(0)
        if ancestor in seen:
            continue
        seen.add(ancestor)
        list_id = membership.get(ancestor)
        if list_id:
            evidence.setdefault(list_id, []).append(ancestor)
        stack.extend(parents.get(ancestor, ()))
    if len(evidence) == 1:
        list_id, ids = next(iter(evidence.items()))
        return list_id, sorted(ids), False
    return None, sorted({item for ids in evidence.values() for item in ids}), bool(evidence)


def _canonical_title_list(title: str, lists: list[dict]) -> tuple[str | None, list[str]]:
    """Recognize only an exact, unique TaskList canonical title suffix."""
    matches = [lst for lst in lists if title.endswith(f" [{lst['name']}]")]
    if len(matches) == 1:
        return matches[0]["id"], [f"[{matches[0]['name']}]"]
    return None, []


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


def cmd_reconcile(args) -> dict:
    """Safely propose or apply deterministic No-list historical backfill."""
    board = _board(args.board)
    tasks, parents = _read_kanban_tasks_and_links(_kanban_db_path(board, args.home))
    c = _conn(args.home) if args.apply else _readonly_conn(args.home)
    try:
        lists = _all_lists(c, board)
        lists_by_id = {lst["id"]: lst for lst in lists}
        membership = {
            str(row["task_id"]): str(row["list_id"])
            for row in c.execute("SELECT task_id, list_id FROM membership WHERE board=?", (board,))
        }
        candidates: list[dict] = []
        proposal_list_ids: dict[str, str] = {}
        skipped_ambiguous = 0
        skipped_no_evidence = 0
        scanned_no_list = 0
        for task_id, title in tasks:
            if task_id in membership:
                continue  # never overwrite any existing/manual membership
            scanned_no_list += 1
            ancestor_id, ancestor_evidence, ancestor_ambiguous = _assigned_ancestor_evidence(
                task_id, parents, membership,
            )
            context_id, context_evidence = _canonical_title_list(title, lists)
            proposal_id: str | None = None
            rule = ""
            evidence: list[str] = []
            if ancestor_ambiguous:
                skipped_ambiguous += 1
                continue
            if ancestor_id and context_id and ancestor_id != context_id:
                skipped_ambiguous += 1
                continue
            if ancestor_id:
                proposal_id, rule, evidence = ancestor_id, "assigned-ancestor", ancestor_evidence
            elif context_id:
                proposal_id, rule, evidence = context_id, "canonical-title-context", context_evidence
            else:
                skipped_no_evidence += 1
                continue
            target = lists_by_id.get(proposal_id)
            if target is None:  # stale membership/list deletion: never infer a replacement
                skipped_no_evidence += 1
                continue
            proposal_list_ids[task_id] = target["id"]
            candidates.append({
                "task_id": task_id,
                "list": target["name"],
                "rule": rule,
                "evidence": evidence,
            })
        changes_made = 0
        if args.apply:
            for candidate in candidates:
                if _already_assigned := c.execute(
                    "SELECT 1 FROM membership WHERE board=? AND task_id=?", (board, candidate["task_id"])
                ).fetchone():
                    continue
                _set_membership(c, board, candidate["task_id"], proposal_list_ids[candidate["task_id"]])
                changes_made += 1
        return {
            "board": board,
            "dry_run": not args.apply,
            "scanned_no_list": scanned_no_list,
            "candidate_count": len(candidates),
            "candidates": candidates,
            "skipped_ambiguous": skipped_ambiguous,
            "skipped_no_evidence": skipped_no_evidence,
            "changes_made": changes_made,
        }
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

    s = sub.add_parser(
        "reconcile",
        help="audit historical No-list tasks; dry-run by default, --apply writes only unambiguous proposals",
    )
    s.add_argument("--board", default="default")
    s.add_argument("--apply", action="store_true", help="apply the reported deterministic candidates")
    s.set_defaults(fn=cmd_reconcile)

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

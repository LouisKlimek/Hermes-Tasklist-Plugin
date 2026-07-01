"""TaskList dashboard plugin — backend for per-board custom lists.

The native Hermes Kanban BOARDS are the top level. Within a board, this plugin
lets you create named LISTS and assign tasks to them (membership). Everything
is a human organizational overlay stored in its OWN SQLite DB, independent of
kanban.db — agents, workers and the ``hermes kanban`` CLI don't see it. All
rows are scoped by board slug, so each board has its own set of lists.

The dashboard imports this module and mounts ``router`` at
``/api/plugins/tasklist/``. DB: ``$HERMES_HOME/tasklist/lists.db``.
"""

from __future__ import annotations

import os
import time
import uuid
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

# Best-effort: reuse Hermes' own kanban path resolution so the subtask-links
# read finds the right kanban.db for ANY board (honours HERMES_KANBAN_HOME,
# profiles and named-board directories). Falls back to a heuristic if the
# module layout ever changes.
try:  # pragma: no cover - depends on host install
    from hermes_cli import kanban_db as _kdb
except Exception:  # pragma: no cover
    _kdb = None

router = APIRouter()


# --------------------------------------------------------------------------- #
# storage
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
    c.execute(
        "CREATE TABLE IF NOT EXISTS path_cache ("
        "  cand TEXT PRIMARY KEY,"          # the path string as written in text
        "  state TEXT NOT NULL,"            # 'valid' | 'invalid'
        "  resolved TEXT,"                  # real relative path when resolved
        "  updated_at INTEGER NOT NULL)"
    )
    return c


def _board(b: Optional[str]) -> str:
    return b or "default"


def _kanban_db_path(slug: Optional[str]) -> Optional[Path]:
    """Locate the kanban.db for a board.

    Prefers Hermes' own ``kanban_db.kanban_db_path`` (exact, install-aware);
    falls back to the documented on-disk layout if that import isn't present.
    """
    if _kdb is not None:
        try:
            return Path(_kdb.kanban_db_path(slug))
        except Exception:
            pass
    home = _hermes_home()
    if slug and slug != "default":
        p = home / "kanban" / "boards" / slug / "kanban.db"
        if p.exists():
            return p
    return home / "kanban.db"


# --------------------------------------------------------------------------- #
# request models
# --------------------------------------------------------------------------- #
class ListCreate(BaseModel):
    name: str
    color: Optional[str] = None


class ListPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None


class MembershipBody(BaseModel):
    task_id: str
    list_id: Optional[str] = None  # None / "" => remove from any list


# --------------------------------------------------------------------------- #
# routes  (mounted at /api/plugins/tasklist/)
# --------------------------------------------------------------------------- #
@router.get("/lists")
def get_lists(board: Optional[str] = Query(None)):
    """Return the board's lists plus the task_id -> list_id map."""
    b = _board(board)
    c = _conn()
    try:
        lists = [
            dict(r)
            for r in c.execute(
                "SELECT id, name, color, position, created_at FROM lists "
                "WHERE board=? ORDER BY position, created_at",
                (b,),
            )
        ]
        membership = {
            r["task_id"]: r["list_id"]
            for r in c.execute(
                "SELECT task_id, list_id FROM membership WHERE board=?", (b,)
            )
        }
        return {"lists": lists, "membership": membership}
    finally:
        c.close()


@router.get("/links")
def get_links(board: Optional[str] = Query(None)):
    """Parent/child task links for the board, read straight from kanban.db.

    Lets the list view nest subtasks under their parent. Best-effort and
    read-only: any failure (db missing, schema change) returns empty maps and
    the UI just shows a flat list.
    """
    slug = _board(board)
    path = _kanban_db_path(slug)
    children: dict = {}
    parents: dict = {}
    try:
        if path.exists():
            kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                for row in kc.execute("SELECT parent_id, child_id FROM task_links"):
                    pid, cid = row[0], row[1]
                    children.setdefault(pid, []).append(cid)
                    parents.setdefault(cid, []).append(pid)
            finally:
                kc.close()
    except Exception:
        pass
    return {"children": children, "parents": parents}


@router.post("/lists")
def create_list(body: ListCreate, board: Optional[str] = Query(None)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    b = _board(board)
    c = _conn()
    try:
        pos = c.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lists WHERE board=?",
            (b,),
        ).fetchone()["p"]
        lid = uuid.uuid4().hex[:12]
        now = int(time.time())
        c.execute(
            "INSERT INTO lists (id, board, name, color, position, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (lid, b, name, body.color, pos, now),
        )
        c.commit()
        return {"list": {"id": lid, "name": name, "color": body.color, "position": pos, "created_at": now}}
    finally:
        c.close()


@router.patch("/lists/{list_id}")
def patch_list(list_id: str, body: ListPatch, board: Optional[str] = Query(None)):
    b = _board(board)
    c = _conn()
    try:
        sets, vals = [], []
        if body.name is not None:
            nm = body.name.strip()
            if not nm:
                raise HTTPException(status_code=400, detail="name cannot be empty")
            sets.append("name=?"); vals.append(nm)
        if body.color is not None:
            sets.append("color=?"); vals.append(body.color)
        if body.position is not None:
            sets.append("position=?"); vals.append(int(body.position))
        if not sets:
            return {"ok": True}
        vals.extend([list_id, b])
        cur = c.execute(f"UPDATE lists SET {', '.join(sets)} WHERE id=? AND board=?", vals)
        c.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="list not found")
        return {"ok": True}
    finally:
        c.close()


@router.delete("/lists/{list_id}")
def delete_list(list_id: str, board: Optional[str] = Query(None)):
    """Delete a list and detach every task that was in it."""
    b = _board(board)
    c = _conn()
    try:
        c.execute("DELETE FROM membership WHERE board=? AND list_id=?", (b, list_id))
        cur = c.execute("DELETE FROM lists WHERE id=? AND board=?", (list_id, b))
        c.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="list not found")
        return {"ok": True}
    finally:
        c.close()


@router.put("/membership")
def set_membership(body: MembershipBody, board: Optional[str] = Query(None)):
    """Move a task into a list (list_id) or remove it from any list (null)."""
    if not body.task_id:
        raise HTTPException(status_code=400, detail="task_id required")
    b = _board(board)
    c = _conn()
    try:
        now = int(time.time())
        if body.list_id:
            exists = c.execute(
                "SELECT 1 FROM lists WHERE id=? AND board=?", (body.list_id, b)
            ).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="list not found")
            c.execute(
                "INSERT INTO membership (board, task_id, list_id, updated_at) "
                "VALUES (?,?,?,?) "
                "ON CONFLICT(board, task_id) DO UPDATE SET "
                "  list_id=excluded.list_id, updated_at=excluded.updated_at",
                (b, body.task_id, body.list_id, now),
            )
        else:
            c.execute(
                "DELETE FROM membership WHERE board=? AND task_id=?", (b, body.task_id)
            )
        c.commit()
        return {"ok": True}
    finally:
        c.close()


# --------------------------------------------------------------------------- #
# path-resolution cache  (mounted at /api/plugins/tasklist/pathcache)
#
# Persists the file-viewer's "does this slash-path point at a real file/folder,
# and if so what's its resolved path" decisions server-side, so an expensive
# tree search runs at most once across ALL browsers/reloads instead of on every
# page load. Entirely self-contained: this plugin never reads another plugin's
# store, and works whether or not the File Explorer plugin is installed.
# --------------------------------------------------------------------------- #
_PC_TTL_VALID = 7 * 24 * 3600     # keep positive resolutions for 7 days
_PC_TTL_INVALID = 3600            # re-check "not found" after 1 hour
_PC_MAX_ROWS = 5000               # prune oldest beyond this


class PathCachePut(BaseModel):
    cand: str
    state: str                    # 'valid' | 'invalid'
    resolved: Optional[str] = None


@router.get("/pathcache")
def get_path_cache():
    """Return all still-fresh cache entries as {cand: {state, resolved}}."""
    now = int(time.time())
    c = _conn()
    try:
        # drop expired rows (best-effort housekeeping)
        c.execute(
            "DELETE FROM path_cache WHERE (state='valid' AND updated_at < ?) "
            "OR (state<>'valid' AND updated_at < ?)",
            (now - _PC_TTL_VALID, now - _PC_TTL_INVALID),
        )
        c.commit()
        rows = c.execute("SELECT cand, state, resolved FROM path_cache").fetchall()
        entries = {r["cand"]: {"state": r["state"], "resolved": r["resolved"]} for r in rows}
        return {"entries": entries}
    finally:
        c.close()


@router.put("/pathcache")
def put_path_cache(body: PathCachePut):
    """Upsert one decision. state must be 'valid' or 'invalid'."""
    if not body.cand or body.state not in ("valid", "invalid"):
        raise HTTPException(status_code=400, detail="cand + state('valid'|'invalid') required")
    now = int(time.time())
    c = _conn()
    try:
        c.execute(
            "INSERT INTO path_cache (cand, state, resolved, updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(cand) DO UPDATE SET state=excluded.state, "
            "  resolved=excluded.resolved, updated_at=excluded.updated_at",
            (body.cand, body.state, body.resolved, now),
        )
        # prune oldest beyond the cap
        n = c.execute("SELECT COUNT(*) AS n FROM path_cache").fetchone()["n"]
        if n > _PC_MAX_ROWS:
            c.execute(
                "DELETE FROM path_cache WHERE cand IN ("
                "  SELECT cand FROM path_cache ORDER BY updated_at ASC LIMIT ?)",
                (n - _PC_MAX_ROWS,),
            )
        c.commit()
        return {"ok": True}
    finally:
        c.close()


@router.delete("/pathcache")
def clear_path_cache():
    """Clear the whole cache (e.g. to force a re-check after creating files)."""
    c = _conn()
    try:
        n = c.execute("SELECT COUNT(*) AS n FROM path_cache").fetchone()["n"]
        c.execute("DELETE FROM path_cache")
        c.commit()
        return {"ok": True, "cleared": n}
    finally:
        c.close()

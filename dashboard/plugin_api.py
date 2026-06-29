"""TaskList dashboard plugin — backend for ClickUp-style groups & lists.

Stores user-defined GROUPS (top-level, like ClickUp Spaces/Folders), LISTS
(inside a group or ungrouped), and per-task LIST MEMBERSHIP in its OWN SQLite
database, independent of kanban.db. This is a human organizational overlay:
agents, workers and the ``hermes kanban`` CLI don't see it. Everything is
scoped by board slug so it mirrors the kanban board switcher.

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
        "CREATE TABLE IF NOT EXISTS groups ("
        "  id TEXT PRIMARY KEY,"
        "  board TEXT NOT NULL DEFAULT 'default',"
        "  name TEXT NOT NULL,"
        "  position INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS lists ("
        "  id TEXT PRIMARY KEY,"
        "  board TEXT NOT NULL DEFAULT 'default',"
        "  group_id TEXT,"
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
    # migrate older installs that predate group_id
    cols = [r[1] for r in c.execute("PRAGMA table_info(lists)")]
    if "group_id" not in cols:
        c.execute("ALTER TABLE lists ADD COLUMN group_id TEXT")
    return c


def _board(b: Optional[str]) -> str:
    return b or "default"


# --------------------------------------------------------------------------- #
# request models
# --------------------------------------------------------------------------- #
class GroupCreate(BaseModel):
    name: str


class GroupPatch(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None


class ListCreate(BaseModel):
    name: str
    group_id: Optional[str] = None
    color: Optional[str] = None


class ListPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None
    group_id: Optional[str] = None  # "" or null => ungrouped


class MembershipBody(BaseModel):
    task_id: str
    list_id: Optional[str] = None  # None / "" => remove from any list


# --------------------------------------------------------------------------- #
# tree (groups + lists + membership)
# --------------------------------------------------------------------------- #
@router.get("/lists")
def get_tree(board: Optional[str] = Query(None)):
    """Return all groups, all lists, and the task_id -> list_id map."""
    b = _board(board)
    c = _conn()
    try:
        groups = [
            dict(r)
            for r in c.execute(
                "SELECT id, name, position, created_at FROM groups "
                "WHERE board=? ORDER BY position, created_at",
                (b,),
            )
        ]
        lists = [
            dict(r)
            for r in c.execute(
                "SELECT id, group_id, name, color, position, created_at FROM lists "
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
        return {"groups": groups, "lists": lists, "membership": membership}
    finally:
        c.close()


# --------------------------------------------------------------------------- #
# groups
# --------------------------------------------------------------------------- #
@router.post("/groups")
def create_group(body: GroupCreate, board: Optional[str] = Query(None)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    b = _board(board)
    c = _conn()
    try:
        pos = c.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM groups WHERE board=?",
            (b,),
        ).fetchone()["p"]
        gid = uuid.uuid4().hex[:12]
        now = int(time.time())
        c.execute(
            "INSERT INTO groups (id, board, name, position, created_at) VALUES (?,?,?,?,?)",
            (gid, b, name, pos, now),
        )
        c.commit()
        return {"group": {"id": gid, "name": name, "position": pos, "created_at": now}}
    finally:
        c.close()


@router.patch("/groups/{group_id}")
def patch_group(group_id: str, body: GroupPatch, board: Optional[str] = Query(None)):
    b = _board(board)
    c = _conn()
    try:
        sets, vals = [], []
        if body.name is not None:
            nm = body.name.strip()
            if not nm:
                raise HTTPException(status_code=400, detail="name cannot be empty")
            sets.append("name=?"); vals.append(nm)
        if body.position is not None:
            sets.append("position=?"); vals.append(int(body.position))
        if not sets:
            return {"ok": True}
        vals.extend([group_id, b])
        cur = c.execute(f"UPDATE groups SET {', '.join(sets)} WHERE id=? AND board=?", vals)
        c.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="group not found")
        return {"ok": True}
    finally:
        c.close()


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, board: Optional[str] = Query(None)):
    """Delete a group; its lists survive and become ungrouped (group_id=NULL)."""
    b = _board(board)
    c = _conn()
    try:
        c.execute(
            "UPDATE lists SET group_id=NULL WHERE board=? AND group_id=?", (b, group_id)
        )
        cur = c.execute("DELETE FROM groups WHERE id=? AND board=?", (group_id, b))
        c.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="group not found")
        return {"ok": True}
    finally:
        c.close()


# --------------------------------------------------------------------------- #
# lists
# --------------------------------------------------------------------------- #
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
        gid = body.group_id or None
        c.execute(
            "INSERT INTO lists (id, board, group_id, name, color, position, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (lid, b, gid, name, body.color, pos, now),
        )
        c.commit()
        return {"list": {"id": lid, "group_id": gid, "name": name, "color": body.color, "position": pos, "created_at": now}}
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
        if body.group_id is not None:
            sets.append("group_id=?"); vals.append(body.group_id or None)
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


# --------------------------------------------------------------------------- #
# membership
# --------------------------------------------------------------------------- #
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

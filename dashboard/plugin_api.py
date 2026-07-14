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
import re
import time
import uuid
import sqlite3
from pathlib import Path
from typing import List, Optional

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
        "CREATE TABLE IF NOT EXISTS title_provenance ("
        "  board TEXT NOT NULL DEFAULT 'default',"
        "  task_id TEXT NOT NULL,"
        "  list_id TEXT,"
        "  generated_suffix TEXT NOT NULL,"
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


class TitleProvenanceBody(BaseModel):
    task_id: str
    list_id: Optional[str] = None
    generated_suffix: Optional[str] = None


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
        title_provenance = {
            r["task_id"]: {"list_id": r["list_id"], "generated_suffix": r["generated_suffix"]}
            for r in c.execute(
                "SELECT task_id, list_id, generated_suffix FROM title_provenance WHERE board=?", (b,)
            )
        }
        return {"lists": lists, "membership": membership, "title_provenance": title_provenance}
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
    """Delete a list, restoring titles and clearing its TaskList metadata."""
    b = _board(board)
    c = _conn()
    attached = False
    try:
        c.execute("BEGIN IMMEDIATE")
        affected = list(c.execute(
            "SELECT p.task_id, p.generated_suffix FROM membership AS m "
            "JOIN title_provenance AS p ON p.board=m.board AND p.task_id=m.task_id "
            "AND p.list_id=m.list_id "
            "WHERE m.board=? AND m.list_id=?",
            (b, list_id),
        ))
        if affected:
            path = _kanban_db_path(b)
            if path is None or not path.exists():
                raise HTTPException(status_code=500, detail="kanban database unavailable")
            c.execute("ATTACH DATABASE ? AS kanban", (str(path),))
            attached = True
            columns = {r["name"] for r in c.execute("PRAGMA kanban.table_info(tasks)")}
            if not {"id", "title"}.issubset(columns):
                raise HTTPException(status_code=500, detail="kanban tasks schema unavailable")
            for task in affected:
                suffix = task["generated_suffix"]
                c.execute(
                    "UPDATE kanban.tasks SET title=substr(title, 1, length(title)-length(?)) "
                    "WHERE id=? AND substr(title, -length(?))=?",
                    (suffix, task["task_id"], suffix, suffix),
                )
        c.execute(
            "DELETE FROM title_provenance WHERE board=? AND list_id=? AND task_id IN "
            "(SELECT task_id FROM membership WHERE board=? AND list_id=?)",
            (b, list_id, b, list_id),
        )
        c.execute("DELETE FROM membership WHERE board=? AND list_id=?", (b, list_id))
        cur = c.execute("DELETE FROM lists WHERE id=? AND board=?", (list_id, b))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="list not found")
        c.commit()
        return {"ok": True}
    except Exception:
        c.rollback()
        raise
    finally:
        if attached:
            try:
                c.execute("DETACH DATABASE kanban")
            except sqlite3.Error:
                pass
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


@router.put("/title-provenance")
def set_title_provenance(body: TitleProvenanceBody, board: Optional[str] = Query(None)):
    """Record the exact TaskList-generated suffix for a task, or clear it."""
    if not body.task_id:
        raise HTTPException(status_code=400, detail="task_id required")
    b = _board(board)
    c = _conn()
    try:
        suffix = body.generated_suffix or ""
        if suffix:
            c.execute(
                "INSERT INTO title_provenance (board, task_id, list_id, generated_suffix, updated_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(board, task_id) DO UPDATE SET "
                "list_id=excluded.list_id, generated_suffix=excluded.generated_suffix, updated_at=excluded.updated_at",
                (b, body.task_id, body.list_id or None, suffix, int(time.time())),
            )
        else:
            c.execute("DELETE FROM title_provenance WHERE board=? AND task_id=?", (b, body.task_id))
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


# --------------------------------------------------------------------------- #
# server-side path WARMING  (mounted at /api/plugins/tasklist/warm + /pathresolve)
#
# The browser used to pre-resolve file/folder paths mentioned in tickets by
# walking the /api/files HTTP tree — many requests per candidate. That work is
# moved here: this process runs inside the Hermes container and can read the
# real files root (/opt/data) straight off disk. We build an in-memory index of
# every file/dir once (cheap, cached), read ticket text directly from kanban.db,
# extract path candidates, resolve them against the index, and fill path_cache.
# The browser then just pokes /warm occasionally and reads the cache — no tree
# walking in the client at all.
# --------------------------------------------------------------------------- #
_URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>()\[\]]+")
_FILE_RE = re.compile(r"(?:[\w.\-]+/)+[\w.\-]+\.[A-Za-z0-9]{1,8}")
_DIR_RE = re.compile(r"(?:[\w.\-]+/){2,}[\w.\-]+(?![\w.\-]*\.[A-Za-z0-9])")
_TEXT_COLS = {"body", "result", "summary", "content", "text", "description", "notes", "output", "details", "message"}
_INDEX_TTL = 300          # rebuild the file index at most every 5 minutes
_INDEX_MAX = 300000       # safety cap on indexed entries
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".mypy_cache", ".pytest_cache"}
_index_cache: dict = {"root": None, "t": 0.0, "idx": None}


def _files_root() -> Optional[str]:
    """Locate the Hermes files root that /api/files serves (default /opt/data)."""
    for k in ("HERMES_FILES_ROOT", "HERMES_DATA_ROOT", "HERMES_FILES_DIR"):
        v = os.environ.get(k)
        if v and os.path.isdir(v):
            return v
    if os.path.isdir("/opt/data"):
        return "/opt/data"
    return None


def _build_index(root: str) -> dict:
    files_by: dict = {}
    dirs_by: dict = {}
    fileset: set = set()
    dirset: set = set()
    count = 0
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if not d.startswith(".") and d not in _SKIP_DIRS]
        rel_dir = os.path.relpath(dp, root)
        if rel_dir == ".":
            rel_dir = ""
        if rel_dir:
            dirset.add(rel_dir)
            dirs_by.setdefault(os.path.basename(rel_dir), []).append(rel_dir)
        for f in fns:
            if f.startswith("."):
                continue
            rp = (rel_dir + "/" + f) if rel_dir else f
            fileset.add(rp)
            files_by.setdefault(f, []).append(rp)
            count += 1
            if count > _INDEX_MAX:
                break
        if count > _INDEX_MAX:
            break
    return {"files": files_by, "dirs": dirs_by, "fileset": fileset, "dirset": dirset}


def _get_index(root: str) -> dict:
    now = time.time()
    if (_index_cache["idx"] is not None and _index_cache["root"] == root
            and (now - _index_cache["t"]) < _INDEX_TTL):
        return _index_cache["idx"]
    idx = _build_index(root)
    _index_cache.update({"root": root, "t": now, "idx": idx})
    return idx


def _resolve(cand: str, is_file: bool, idx: dict) -> Optional[str]:
    """Return the real relative path a candidate points at, or None if not found.

    Mirrors the browser heuristic: exact match, then a path-suffix match, then a
    basename+immediate-parent match, then a unique-basename match.
    """
    cand = (cand or "").strip().strip("/")
    if not cand:
        return None
    fullset = idx["fileset"] if is_file else idx["dirset"]
    buckets = idx["files"] if is_file else idx["dirs"]
    if cand in fullset:
        return cand
    base = cand.rsplit("/", 1)[-1]
    lst = buckets.get(base)
    if not lst:
        return None
    suf = [p for p in lst if p == cand or p.endswith("/" + cand)]
    if suf:
        return min(suf, key=len)
    if "/" in cand:
        parent_seg = cand.rsplit("/", 2)[-2]
        pm = [p for p in lst if parent_seg and (("/" + parent_seg + "/") in ("/" + p + "/"))]
        if len(pm) == 1:
            return pm[0]
        if pm:
            return min(pm, key=len)
    if len(lst) == 1:
        return lst[0]
    return None


def _extract(text: str):
    if not text:
        return set(), set()
    s = _URL_RE.sub(" ", str(text))
    files = set(_FILE_RE.findall(s))
    dirs = set()
    for m in _DIR_RE.finditer(s):
        d = m.group(0).rstrip(".,;:!?").rstrip("/")
        if not d or d in files:
            continue
        base = d.rsplit("/", 1)[-1]
        if re.search(r"\.[A-Za-z0-9]{1,8}$", base):   # ends like a file -> not a folder
            continue
        dirs.add(d)
    return files, dirs


def _read_kanban_texts(slug: Optional[str], cap_chars: int = 4_000_000) -> List[str]:
    """Best-effort read of all path-bearing text columns across kanban.db."""
    path = _kanban_db_path(slug)
    out: List[str] = []
    total = 0
    try:
        if not path or not path.exists():
            return out
        kc = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            tables = [r[0] for r in kc.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")]
            for tbl in tables:
                try:
                    cols = [r[1] for r in kc.execute(f'PRAGMA table_info("{tbl}")')]
                except Exception:
                    continue
                sel = [c for c in cols if c.lower() in _TEXT_COLS]
                if not sel:
                    continue
                collist = ",".join('"' + c + '"' for c in sel)
                try:
                    for row in kc.execute(f'SELECT {collist} FROM "{tbl}"'):
                        for v in row:
                            if isinstance(v, str) and v:
                                out.append(v)
                                total += len(v)
                                if total > cap_chars:
                                    return out
                except Exception:
                    continue
        finally:
            kc.close()
    except Exception:
        pass
    return out


def _pc_upsert(c, cand: str, resolved: Optional[str], now: int) -> None:
    c.execute(
        "INSERT INTO path_cache (cand, state, resolved, updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(cand) DO UPDATE SET state=excluded.state, "
        "  resolved=excluded.resolved, updated_at=excluded.updated_at",
        (cand, "valid" if resolved else "invalid", resolved, now),
    )


@router.post("/warm")
def warm_paths(board: Optional[str] = Query(None)):
    """Resolve every file/folder path mentioned in this board's tickets, server-side.

    Reads ticket text from kanban.db, resolves candidates against an in-memory
    index of the files root, and fills path_cache. No /api/files calls at all.
    """
    root = _files_root()
    if not root:
        return {"ok": False, "reason": "no files root", "candidates": 0, "resolved": 0}
    idx = _get_index(root)
    slug = _board(board)
    files: set = set()
    dirs: set = set()
    for t in _read_kanban_texts(slug):
        f, d = _extract(t)
        files |= f
        dirs |= d
    now = int(time.time())
    resolved = 0
    c = _conn()
    try:
        for cand in files:
            r = _resolve(cand, True, idx)
            _pc_upsert(c, cand, r, now)
            resolved += 1 if r else 0
        for cand in dirs:
            r = _resolve(cand, False, idx)
            _pc_upsert(c, cand, r, now)
            resolved += 1 if r else 0
        n = c.execute("SELECT COUNT(*) AS n FROM path_cache").fetchone()["n"]
        if n > _PC_MAX_ROWS:
            c.execute(
                "DELETE FROM path_cache WHERE cand IN ("
                "  SELECT cand FROM path_cache ORDER BY updated_at ASC LIMIT ?)",
                (n - _PC_MAX_ROWS,),
            )
        c.commit()
        return {
            "ok": True,
            "root": root,
            "candidates": len(files) + len(dirs),
            "resolved": resolved,
            "files": len(files),
            "dirs": len(dirs),
            "indexed": len(idx["fileset"]) + len(idx["dirset"]),
        }
    finally:
        c.close()


class ResolveItem(BaseModel):
    cand: str
    is_file: bool = True


class ResolveBody(BaseModel):
    items: List[ResolveItem] = []


@router.post("/pathresolve")
def path_resolve(body: ResolveBody):
    """Resolve a handful of candidates on demand (server-side, no /api/files).

    Returns {"ok": bool, "entries": {cand: {state, resolved}}}. When the files
    root can't be found the browser should fall back to its own tree search.
    """
    root = _files_root()
    if not root:
        return {"ok": False, "root": None, "entries": {}}
    idx = _get_index(root)
    now = int(time.time())
    out: dict = {}
    c = _conn()
    try:
        for it in (body.items or [])[:300]:
            if not it.cand:
                continue
            r = _resolve(it.cand, bool(it.is_file), idx)
            _pc_upsert(c, it.cand, r, now)
            out[it.cand] = {"state": "valid" if r else "invalid", "resolved": r}
        c.commit()
        return {"ok": True, "root": root, "entries": out}
    finally:
        c.close()

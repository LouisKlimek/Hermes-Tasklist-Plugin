"""Regression coverage for list deletion title reconciliation."""

import os
import sqlite3
import sys
import tempfile
import types
from pathlib import Path

try:
    import fastapi  # noqa: F401
    import pydantic  # noqa: F401
except ModuleNotFoundError:
    class _Router:
        def __getattr__(self, _name):
            return lambda *_args, **_kwargs: lambda func: func

    class _HTTPException(Exception):
        def __init__(self, status_code, detail=None):
            self.status_code = status_code
            self.detail = detail

    class _BaseModel:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    fastapi_stub = types.ModuleType("fastapi")
    setattr(fastapi_stub, "APIRouter", _Router)
    setattr(fastapi_stub, "HTTPException", _HTTPException)
    setattr(fastapi_stub, "Query", lambda default=None: default)
    pydantic_stub = types.ModuleType("pydantic")
    setattr(pydantic_stub, "BaseModel", _BaseModel)
    sys.modules["fastapi"] = fastapi_stub
    sys.modules["pydantic"] = pydantic_stub

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import plugin_api as api


def seed(home: Path, schema: str) -> tuple[Path, str]:
    kanban = home / "kanban.db"
    with sqlite3.connect(kanban) as c:
        c.execute(schema)
        c.execute("INSERT INTO tasks (id, title) VALUES (?, ?)", ("task-1", "Draft brief [Research]"))
    api._kanban_db_path = lambda _board: kanban
    created = api.create_list(api.ListCreate(name="Research"), board="board-a")
    list_id = created["list"]["id"]
    api.set_membership(api.MembershipBody(task_id="task-1", list_id=list_id), board="board-a")
    api.set_title_provenance(
        api.TitleProvenanceBody(task_id="task-1", list_id=list_id, generated_suffix=" [Research]"),
        board="board-a",
    )
    return kanban, list_id


def state(home: Path, list_id: str) -> tuple[int, int, int]:
    with sqlite3.connect(home / "tasklist" / "lists.db") as c:
        return tuple(c.execute(query, ("board-a", list_id)).fetchone()[0] for query in (
            "SELECT COUNT(*) FROM lists WHERE board=? AND id=?",
            "SELECT COUNT(*) FROM membership WHERE board=? AND list_id=?",
            "SELECT COUNT(*) FROM title_provenance WHERE board=? AND list_id=?",
        ))


def test_deletion_restores_title_and_clears_metadata() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        os.environ["HERMES_HOME"] = str(home)
        kanban, list_id = seed(home, "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        assert api.delete_list(list_id, board="board-a") == {"ok": True}
        with sqlite3.connect(kanban) as c:
            assert c.execute("SELECT title FROM tasks WHERE id='task-1'").fetchone()[0] == "Draft brief"
        assert state(home, list_id) == (0, 0, 0)


def test_deletion_rolls_back_when_legacy_kanban_schema_cannot_reconcile() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        os.environ["HERMES_HOME"] = str(home)
        kanban, list_id = seed(home, "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        with sqlite3.connect(kanban) as c:
            c.execute("DROP TABLE tasks")
        try:
            api.delete_list(list_id, board="board-a")
        except api.HTTPException as error:
            assert error.status_code == 500
        else:
            raise AssertionError("unreconcilable kanban schema must reject deletion")
        assert state(home, list_id) == (1, 1, 1)


def main() -> None:
    original_home = os.environ.get("HERMES_HOME")
    original_path = api._kanban_db_path
    try:
        test_deletion_restores_title_and_clears_metadata()
        test_deletion_rolls_back_when_legacy_kanban_schema_cannot_reconcile()
    finally:
        api._kanban_db_path = original_path
        if original_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = original_home
    print("delete list reconciliation: 2 assertions passed")


if __name__ == "__main__":
    main()

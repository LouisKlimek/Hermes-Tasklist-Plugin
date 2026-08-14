"""Contract tests for the optional sequenced-task predecessor picker."""

import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_PATH = ROOT / "dashboard" / "plugin_api.py"
UI_PATH = ROOT / "dashboard" / "dist" / "index.js"


def load_api():
    if "fastapi" not in sys.modules:
        class Router:
            def get(self, *_args, **_kwargs): return lambda fn: fn
            def post(self, *_args, **_kwargs): return lambda fn: fn
            def patch(self, *_args, **_kwargs): return lambda fn: fn
            def delete(self, *_args, **_kwargs): return lambda fn: fn
            def put(self, *_args, **_kwargs): return lambda fn: fn
        fastapi = types.ModuleType("fastapi")
        setattr(fastapi, "APIRouter", Router)
        setattr(fastapi, "HTTPException", Exception)
        setattr(fastapi, "Query", lambda value=None: value)
        sys.modules["fastapi"] = fastapi
    if "pydantic" not in sys.modules:
        pydantic = types.ModuleType("pydantic")
        setattr(pydantic, "BaseModel", object)
        sys.modules["pydantic"] = pydantic
    spec = importlib.util.spec_from_file_location("tasklist_sequence_test", API_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_board(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, created_at INTEGER)")
        conn.executemany(
            "INSERT INTO tasks VALUES (?,?,?,?)",
            [
                ("t_old_merge", "Old merge", "Type: GitHub Auto Merge\n", 10),
                ("t_non_merge", "Not selectable", "Type: Engineering Implementation\n", 99),
                ("t_new_merge", "New merge", "Type: GitHub Auto Merge\n", 20),
            ],
        )


def test_watcher_absent_hides_control_without_loading_candidates():
    api = load_api()
    with tempfile.TemporaryDirectory() as td:
        home = Path(td)
        setattr(api, "_hermes_home", lambda: home)
        assert api.sequence_predecessors("board-a") == {"enabled": False, "candidates": []}


def test_watcher_present_returns_only_newest_merge_cards():
    api = load_api()
    with tempfile.TemporaryDirectory() as td:
        home = Path(td)
        setattr(api, "_hermes_home", lambda: home)
        setattr(api, "_kdb", None)
        (home / "cron").mkdir()
        (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{"name": "kanban-global-sequence-release-watcher"}]}))
        create_board(home / "kanban" / "boards" / "board-a" / "kanban.db")
        result = api.sequence_predecessors("board-a")
        assert result["enabled"] is True
        assert [item["id"] for item in result["candidates"]] == ["t_new_merge", "t_old_merge"]


def test_dialog_uses_searchable_control_and_exact_optional_description_prefix():
    ui = UI_PATH.read_text()
    assert 'TLAPI + "/sequence-predecessors"' in ui
    assert "if (!r || !r.enabled)" in ui
    assert 'cfield("Predecessor GitHub Auto Merge"' in ui
    assert "predecessor_candidates ?" in ui and "search: true" in ui
    assert 'title: "Choose predecessor GitHub Auto Merge task"' in ui
    assert '"Predecessor GitHub Auto Merge: " + d.predecessor_id + "\\n\\n" + d.body' in ui
    assert "{ body: createBody }" in ui


if __name__ == "__main__":
    test_watcher_absent_hides_control_without_loading_candidates()
    test_watcher_present_returns_only_newest_merge_cards()
    test_dialog_uses_searchable_control_and_exact_optional_description_prefix()
    print("sequence predecessor contract: 10 assertions passed")

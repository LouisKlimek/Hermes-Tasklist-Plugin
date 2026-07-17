"""Deterministic TaskList inheritance and conservative historical reconciliation."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "dashboard" / "tasklist_cli.py"


def seed_kanban(home: Path, tasks: list[tuple[str, str]], links: list[tuple[str, str]]) -> None:
    kanban = home / "kanban" / "boards" / "board-a" / "kanban.db"
    kanban.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(kanban) as c:
        c.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT DEFAULT '')")
        c.execute("CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL)")
        c.executemany("INSERT INTO tasks (id, title) VALUES (?, ?)", tasks)
        c.executemany("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)", links)


def cli(home: Path, *args: str) -> dict:
    env = {**os.environ, "HERMES_HOME": str(home)}
    env.pop("HERMES_KANBAN_DB", None)
    env.pop("HERMES_KANBAN_HOME", None)
    result = subprocess.run(
        [sys.executable, str(CLI), "--home", str(home), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def membership(home: Path, board: str = "board-a") -> dict[str, str]:
    with sqlite3.connect(home / "tasklist" / "lists.db") as c:
        return dict(c.execute("SELECT task_id, list_id FROM membership WHERE board=?", (board,)))


def test_reconcile_dry_run_apply_and_idempotence() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        seed_kanban(home, [("parent", "Parent"), ("child", "Child")], [("parent", "child")])
        list_id = cli(home, "create-list", "--board", "board-a", "--name", "Research")["list"]["id"]
        cli(home, "assign", "--board", "board-a", "--task", "parent", "--list", list_id)
        db = home / "tasklist" / "lists.db"
        before_bytes = db.read_bytes()
        before_files = {path.name for path in db.parent.glob("lists.db*")}

        dry = cli(home, "reconcile", "--board", "board-a")
        assert dry["dry_run"] is True
        assert dry["scanned_no_list"] == 1
        assert dry["candidate_count"] == 1
        assert dry["changes_made"] == 0
        assert dry["candidates"] == [{
            "task_id": "child", "list": "Research", "rule": "assigned-ancestor", "evidence": ["parent"],
        }]
        assert db.read_bytes() == before_bytes
        assert {path.name for path in db.parent.glob("lists.db*")} == before_files
        assert membership(home) == {"parent": list_id}

        applied = cli(home, "reconcile", "--board", "board-a", "--apply")
        assert applied["dry_run"] is False
        assert applied["changes_made"] == 1
        assert membership(home) == {"parent": list_id, "child": list_id}

        repeated = cli(home, "reconcile", "--board", "board-a", "--apply")
        assert repeated["candidate_count"] == 0
        assert repeated["changes_made"] == 0


def test_reconcile_handles_nested_children_and_preserves_manual_membership() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        seed_kanban(
            home,
            [("root", "Root"), ("middle", "Middle"), ("leaf", "Leaf")],
            [("root", "middle"), ("middle", "leaf")],
        )
        research = cli(home, "create-list", "--board", "board-a", "--name", "Research")["list"]["id"]
        manual = cli(home, "create-list", "--board", "board-a", "--name", "Manual")["list"]["id"]
        cli(home, "assign", "--board", "board-a", "--task", "root", "--list", research)
        cli(home, "assign", "--board", "board-a", "--task", "leaf", "--list", manual)

        result = cli(home, "reconcile", "--board", "board-a", "--apply")
        assert result["candidate_count"] == 1
        assert result["changes_made"] == 1
        assert membership(home) == {"root": research, "middle": research, "leaf": manual}


def test_reconcile_skips_conflicting_multi_parent_and_uses_unique_canonical_context() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        seed_kanban(
            home,
            [("a", "A"), ("b", "B"), ("conflict", "Conflict"), ("context", "Historic brief [Research]")],
            [("a", "conflict"), ("b", "conflict")],
        )
        research = cli(home, "create-list", "--board", "board-a", "--name", "Research")["list"]["id"]
        delivery = cli(home, "create-list", "--board", "board-a", "--name", "Delivery")["list"]["id"]
        cli(home, "assign", "--board", "board-a", "--task", "a", "--list", research)
        cli(home, "assign", "--board", "board-a", "--task", "b", "--list", delivery)

        result = cli(home, "reconcile", "--board", "board-a", "--apply")
        assert result["changes_made"] == 1
        assert result["skipped_ambiguous"] == 1
        assert result["candidates"] == [{
            "task_id": "context", "list": "Research", "rule": "canonical-title-context", "evidence": ["[Research]"],
        }]
        assert membership(home) == {"a": research, "b": delivery, "context": research}


def main() -> None:
    test_reconcile_dry_run_apply_and_idempotence()
    test_reconcile_handles_nested_children_and_preserves_manual_membership()
    test_reconcile_skips_conflicting_multi_parent_and_uses_unique_canonical_context()
    print("tasklist reconciliation: 3 scenarios passed")


if __name__ == "__main__":
    main()

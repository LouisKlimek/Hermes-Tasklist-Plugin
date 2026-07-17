"""Lifecycle regression tests for deterministic TaskList child inheritance."""

from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location("tasklist_lifecycle_test", ROOT / "__init__.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoLlm:
    pass


class Context:
    llm = NoLlm()

    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


def seed_kanban(home: Path, links: list[tuple[str, str]]) -> Path:
    path = home / "kanban.db"
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, tenant TEXT)")
        c.execute("CREATE TABLE task_links (parent_id TEXT, child_id TEXT)")
        task_ids = sorted({task for pair in links for task in pair})
        c.executemany("INSERT INTO tasks VALUES (?, ?, '', '', '')", [(task, task) for task in task_ids])
        c.executemany("INSERT INTO task_links VALUES (?, ?)", links)
    return path


def task_membership(plugin, board: str) -> dict[str, str]:
    c = plugin._conn()
    try:
        return {row["task_id"]: row["list_id"] for row in c.execute(
            "SELECT task_id, list_id FROM membership WHERE board=?", (board,)
        )}
    finally:
        c.close()


def test_post_create_hook_inherits_immediately_and_respects_manual_membership() -> None:
    plugin = load_plugin()
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        os.environ["HERMES_HOME"] = str(home)
        kanban = seed_kanban(home, [("parent", "child"), ("child", "grandchild")])
        plugin._kanban_db_path = lambda _board: kanban
        c = plugin._conn()
        try:
            parent_list = plugin._create_list(c, "board-a", "Research")
            manual_list = plugin._create_list(c, "board-a", "Manual")
            plugin._set_membership(c, "board-a", "parent", parent_list["id"])
            plugin._set_membership(c, "board-a", "grandchild", manual_list["id"])
        finally:
            c.close()

        ctx = Context()
        plugin.register(ctx)
        assert "post_tool_call" in ctx.hooks
        ctx.hooks["post_tool_call"](
            tool_name="kanban_create",
            args={"board": "board-a"},
            result='{"task_id":"child"}',
        )
        assert task_membership(plugin, "board-a") == {
            "parent": parent_list["id"],
            "child": parent_list["id"],
            "grandchild": manual_list["id"],
        }


def test_claim_recovery_handles_child_observed_before_parent_and_multi_parent_order() -> None:
    plugin = load_plugin()
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        os.environ["HERMES_HOME"] = str(home)
        kanban = seed_kanban(home, [("first", "child"), ("second", "child")])
        plugin._kanban_db_path = lambda _board: kanban
        c = plugin._conn()
        try:
            first_list = plugin._create_list(c, "board-a", "First")
            second_list = plugin._create_list(c, "board-a", "Second")
            plugin._set_membership(c, "board-a", "first", first_list["id"])
            plugin._set_membership(c, "board-a", "second", second_list["id"])
            plugin._place_task(Context(), c, "child", "board-a")
        finally:
            c.close()
        assert task_membership(plugin, "board-a")["child"] == first_list["id"]


def main() -> None:
    test_post_create_hook_inherits_immediately_and_respects_manual_membership()
    test_claim_recovery_handles_child_observed_before_parent_and_multi_parent_order()
    print("tasklist lifecycle inheritance: 2 scenarios passed")


if __name__ == "__main__":
    main()

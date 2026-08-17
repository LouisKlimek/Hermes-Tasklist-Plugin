"""Regression contract for Graph blocked-state styling."""

from pathlib import Path


UI_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "dist" / "index.js"


def test_waiting_todo_is_not_rendered_as_blocked():
    ui = UI_PATH.read_text()
    assert 'var isBlocked = t.status === "blocked";' in ui
    assert 'var isBlocked = depBlk || t.status === "blocked";' not in ui
    assert 'var waiting = depBlk ? "  \\u00b7  waiting on a parent" : "";' in ui
    assert 'depBlk ? h("tspan", { fill: BLOCK_COL, fontWeight: 600 }, "  \\u00b7  waiting on a parent") : null' in ui


def test_only_actual_blocked_status_receives_blocked_outline():
    ui = UI_PATH.read_text()
    assert 'isBlocked ? h("rect", { className: "tl-blocked"' in ui
    assert 'var isBlocked = t.status === "blocked";' in ui


if __name__ == "__main__":
    test_waiting_todo_is_not_rendered_as_blocked()
    test_only_actual_blocked_status_receives_blocked_outline()
    print("graph blocked style contract: 6 assertions passed")

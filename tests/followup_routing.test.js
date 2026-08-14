"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const selection = source.match(/function deepestOpenFollowupTarget\([\s\S]*?\n    }\n    function descendantProgress/);
assert(selection, "follow-up target selection helper must be present");
assert(source.includes("routeToDeepestOpen: true"), "follow-up dialog must enable deepest-open routing by default");
assert(source.includes('type: "checkbox"'), "follow-up dialog must expose a routing checkbox");
assert(source.includes("var target = followup.routeToDeepestOpen !== false ? deepestOpenFollowupTarget(src) : src;"), "disabled routing must preserve the selected task");
assert(source.includes("{ parent_id: target.id, child_id: newId }"), "follow-up link must use the selected target");

assert(selection[0].includes("seen[root.id] = 1"), "selection must not revisit the root in a cycle");
assert(selection[0].includes("candidate.status !== \"done\" && entry.depth > bestDepth"), "only deeper open descendants may replace the target");
assert(selection[0].includes("for (var i = kids.length - 1; i >= 0; i--)"), "existing child order must define deterministic ties");

let tree = {};
function childrenOf(task) { return (tree[task.id] || []).slice(); }
function select(root) {
  if (!root) return root;
  let best = root;
  let bestDepth = 0;
  const seen = { [root.id]: true };
  const stack = [];
  function pushChildren(parent, depth) {
    const kids = childrenOf(parent);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ task: kids[i], depth });
  }
  pushChildren(root, 1);
  while (stack.length) {
    const entry = stack.pop();
    const candidate = entry.task;
    if (!candidate || seen[candidate.id]) continue;
    seen[candidate.id] = true;
    if (candidate.status !== "done" && entry.depth > bestDepth) { best = candidate; bestDepth = entry.depth; }
    pushChildren(candidate, entry.depth + 1);
  }
  return best;
}
const task = (id, status) => ({ id, status });

const root = task("root", "done");
const a = task("a", "todo");
const b = task("b", "todo");
const a1 = task("a1", "todo");
const b1 = task("b1", "todo");
tree = { root: [a, b], a: [a1], b: [b1] };
assert.strictEqual(select(root), a1, "the first child in existing stable order wins a same-depth tie");

const doneDeep = task("done-deep", "done");
tree = { root: [a], a: [doneDeep] };
assert.strictEqual(select(root), a, "the deepest open candidate wins even when a deeper descendant is done");

tree = { root: [doneDeep] };
assert.strictEqual(select(root), root, "no open descendants falls back to the selected task");

tree = {};
assert.strictEqual(select(root), root, "a task without children falls back to itself");

tree = { root: [a], a: [root] };
assert.strictEqual(select(root), a, "cyclic child data terminates and chooses a safe open target");

console.log("follow-up routing contract: 13 assertions passed");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
assert(source.includes("function descendantProgress(t)"), "task rows must calculate descendant progress");
assert(source.includes("var prog = descendantProgress(t);"), "task badges must use descendant progress");
assert(source.includes("if (seen[c]) continue;"), "descendant traversal must deduplicate shared descendants");

function descendantProgress(rootId, children, tasks) {
  const ids = [];
  const seen = {};
  const stack = (children[rootId] || []).slice();
  while (stack.length) {
    const id = stack.pop();
    if (seen[id]) continue;
    seen[id] = true;
    ids.push(id);
    for (const childId of children[id] || []) stack.push(childId);
  }
  let done = 0;
  let total = 0;
  for (const id of ids) {
    if (!tasks[id]) continue;
    total++;
    if (tasks[id].status === "done") done++;
  }
  return total ? { done, total } : null;
}

const children = {
  root: ["child-a", "child-b"],
  "child-a": ["grandchild"],
  "child-b": ["grandchild"],
};
const tasks = {
  "child-a": { status: "done" },
  "child-b": { status: "running" },
  grandchild: { status: "todo" },
};

assert.deepStrictEqual(
  descendantProgress("root", children, tasks),
  { done: 1, total: 3 },
  "all direct and indirect descendants are counted once"
);
assert.strictEqual(descendantProgress("grandchild", children, tasks), null, "tasks without descendants retain no progress badge");

console.log("recursive task progress contract: 6 assertions passed");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const selection = source.match(/function deepestOpenFollowupTarget\([\s\S]*?\n    }\n    function descendantProgress/);
assert(selection, "follow-up target selection helper must be present");
assert(source.includes("routeToDeepestOpen: true"), "follow-up dialog must enable deepest routing by default");
assert(source.includes('"Route to the deepest subtask"'), "follow-up dialog must use the requested checkbox label");
assert(!source.includes('"Route to the deepest open subtask"'), "old checkbox label must be removed");
assert(source.includes("var target = followup.routeToDeepestOpen !== false ? deepestOpenFollowupTarget(src) : src;"), "disabled routing must preserve the selected task");
assert(source.includes("{ parent_id: target.id, child_id: newId }"), "follow-up link must use the selected target");
assert(selection[0].includes("candidate.status !== \"done\""), "deepest open descendants must be preferred");
assert(selection[0].includes("createdAt(candidate) > createdAt(best)"), "creation time must break candidate ties");

let tree = {};
function childrenOf(task) { return (tree[task.id] || []).slice(); }
const helperSource = selection[0].replace(/\n    function descendantProgress[\s\S]*/, "");
const select = Function("childrenOf", `${helperSource}\nreturn deepestOpenFollowupTarget;`)(childrenOf);
const task = (id, status, created_at) => ({ id, status, created_at });

const root = task("root", "done", 0);
const left = task("left", "todo", 1);
const right = task("right", "todo", 2);
const oldOpen = task("old-open", "todo", 10);
const newOpen = task("new-open", "todo", 20);
tree = { root: [left, right], left: [oldOpen], right: [newOpen] };
assert.strictEqual(select(root), newOpen, "newest open task wins among equally deep branches");

const newerDone = task("newer-done", "done", 30);
tree = { root: [left, right], left: [oldOpen], right: [newerDone] };
assert.strictEqual(select(root), oldOpen, "open deepest task wins over newer done deepest task");

const olderDone = task("older-done", "done", 40);
const newestDone = task("newest-done", "done", 50);
tree = { root: [left, right], left: [olderDone], right: [newestDone] };
assert.strictEqual(select(root), newestDone, "newest deepest task wins when every deepest task is done");

const shallowNewest = task("shallow-newest", "todo", 100);
const deepParent = task("deep-parent", "todo", 3);
const deepestOld = task("deepest-old", "todo", 4);
tree = { root: [shallowNewest, deepParent], "deep-parent": [deepestOld] };
assert.strictEqual(select(root), deepestOld, "maximum depth takes precedence over creation time");

tree = {};
assert.strictEqual(select(root), root, "a task without descendants falls back to itself");

tree = { root: [left], left: [root] };
assert.strictEqual(select(root), left, "cyclic child data terminates and selects the valid descendant");

tree = { root: [null, { status: "todo" }] };
assert.strictEqual(select(root), root, "malformed child data falls back safely to the selected task");

console.log("follow-up routing contract: 15 assertions passed");

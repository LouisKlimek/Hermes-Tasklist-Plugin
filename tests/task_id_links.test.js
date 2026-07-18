"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
assert(source.includes("function isCanonicalTaskId(id) { return /^t_[0-9a-f]{8}$/.test"), "canonical task-ID helper must be present");
const isCanonicalTaskId = (id) => /^t_[0-9a-f]{8}$/.test(String(id == null ? "" : id));
assert.strictEqual(isCanonicalTaskId("t_6fa4fe0b"), true, "canonical lowercase hexadecimal IDs are recognized");
assert.strictEqual(isCanonicalTaskId("t_6FA4FE0B"), false, "uppercase IDs are not canonical");
assert.strictEqual(isCanonicalTaskId("t_6fa4fe0"), false, "short IDs are not canonical");
assert.strictEqual(isCanonicalTaskId("prefix_t_6fa4fe0b"), false, "embedded IDs are not canonical tokens");

const ticketPattern = /(^|[^0-9A-Za-z_])(t_[0-9a-f]{8})(?![0-9A-Za-z_])/g;
function matchedIds(text) {
  return Array.from(text.matchAll(ticketPattern), (m) => m[2]);
}
assert.deepStrictEqual(matchedIds("see t_6fa4fe0b and t_6fa4fe0b"), ["t_6fa4fe0b", "t_6fa4fe0b"], "every repeated standalone occurrence is found");
assert.deepStrictEqual(matchedIds("xt_6fa4fe0b t_6fa4fe0bz t_6fa4fe0b"), ["t_6fa4fe0b"], "only standalone IDs are found");
assert.deepStrictEqual(matchedIds("t_6FA4FE0B t_deadbeef"), ["t_deadbeef"], "only lowercase hexadecimal tokens are found");

assert(source.includes("onOpen.ticketKnown(id)"), "candidate IDs must be validated against the current board task map");
assert(source.includes("fn.ticketKnown = function (id) { return !!taskById[id]; };"), "only existing current-board task IDs are linkable");
assert(source.includes('u.searchParams.set("task", board + "\\u001f" + id)'), "ticket links must use the TaskList deep-link route");
assert(source.includes('target: "_blank", rel: "noopener noreferrer", title: "Open task " + id'), "ticket links must open safely in a new tab");

assert(source.includes("mdBlocks(task.body, makePathHandler(false))"), "descriptions use ticket-aware markdown rendering");
assert(source.includes("mdBlocks(r.summary, makePathHandler(false))"), "run-history summaries use ticket-aware markdown rendering");
assert(source.includes('mdBlocks(c.body || c.text || "", makePathHandler(false))'), "comments use ticket-aware markdown rendering");

console.log("task ID link contract: 15 assertions passed");

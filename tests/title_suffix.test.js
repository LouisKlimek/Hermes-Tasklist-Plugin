"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const helpers = source.match(/function suffixForList\([\s\S]*?\n  }\n  function displayListTitle\([\s\S]*?\n  }/);
assert(helpers, "title suffix helpers must be present in the dashboard bundle");
assert(source.includes("canonicalTaskTitle(title, listId)"), "inline list creation must persist the canonical title");
assert(source.includes("canonicalTaskTitle(title, d.list_id)"), "new-task modal list creation must persist the canonical title");
eval(`${helpers[0]}\n;globalThis.__titleHelpers = { canonicalListTitle, displayListTitle };`);

const { canonicalListTitle, displayListTitle } = globalThis.__titleHelpers;

const list = "Research & Design [Q3]";
const canonical = canonicalListTitle("Draft brief [customer note]", list);
assert.strictEqual(canonical, "Draft brief [customer note] [Research & Design [Q3]]");
assert.strictEqual(canonicalListTitle(canonical, list), canonical, "retry must not duplicate suffix");
assert.strictEqual(displayListTitle(canonical, list), "Draft brief [customer note]", "TaskList display hides only its list suffix");
assert.strictEqual(displayListTitle("Draft brief [customer note]", list), "Draft brief [customer note]", "user bracket text is preserved");
assert.strictEqual(canonicalListTitle("Outside task [customer note]", ""), "Outside task [customer note]", "non-list creation stays unchanged");
assert.strictEqual(displayListTitle("Outside task [Research & Design [Q3]]", ""), "Outside task [Research & Design [Q3]]", "without matching list context no text is stripped");

console.log("title suffix contract: 6 assertions passed");

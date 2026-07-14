"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const helpers = source.match(/function suffixForList\([\s\S]*?\n  }\n  function displayListTitle\([\s\S]*?\n  }/);
assert(helpers, "title suffix helpers must be present in the dashboard bundle");
assert(source.includes("title_provenance"), "list responses must include explicit title provenance");
assert(source.includes("setTitleProvenance(id, listId)"), "inline list creation must persist title provenance");
assert(source.includes("setTitleProvenance(id, d.list_id)"), "new-task modal creation must persist title provenance");
const deleteList = source.match(/function deleteList\([\s\S]*?\n    function moveToList/);
assert(deleteList, "list deletion mutation function must be present");
assert(deleteList[0].includes("load(true); loadTreeFor(slug);"), "successful list deletion reloads restored task titles before clearing TaskList metadata");
const moveToList = source.match(/function moveToList\([\s\S]*?\n    function addTask/);
const addTask = source.match(/function addTask\([\s\S]*?\n    }\n\n    function createListReturning/);
const submitCreate = source.match(/function submitCreate\([\s\S]*?\n    }\n\n    \/\/ ---- \"Create follow-up/);
assert(moveToList && addTask && submitCreate, "list placement mutation functions must be present");
assert(moveToList[0].indexOf('"/membership"') < moveToList[0].indexOf('"list move"'), "moves must save membership before changing the title");
assert(addTask[0].indexOf('"/membership"') < addTask[0].indexOf('setTitleProvenance(id, listId)'), "quick creation must save membership before provenance");
assert(submitCreate[0].indexOf('"/membership"') < submitCreate[0].indexOf('setTitleProvenance(id, d.list_id)'), "modal creation must save membership before provenance");
assert(/if \(d\.list_id\) chain = chain\.then\(function \(\) \{ return send\("PUT", TLAPI \+ "\/membership"[\s\S]*?\}\);\n        chain = chain\.then\(function \(\) \{ var canonical = canonicalTaskTitle\(title, d\.list_id\);[\s\S]*?setTitleProvenance\(id, d\.list_id\)/.test(submitCreate[0]), "a failed modal membership request must stop title/provenance updates before the title/provenance chain runs");
eval(`${helpers[0]}\n;globalThis.__titleHelpers = { canonicalListTitle, displayListTitle };`);

const { canonicalListTitle, displayListTitle } = globalThis.__titleHelpers;
const list = "Research & Design [Q3]";
const provenance = { list_id: "list-a", generated_suffix: " [Research & Design [Q3]]" };
const canonical = canonicalListTitle("Draft brief [customer note]", list, null);
assert.strictEqual(canonical, "Draft brief [customer note] [Research & Design [Q3]]");
assert.strictEqual(canonicalListTitle(canonical, list, provenance), canonical, "retry removes only the recorded suffix");
assert.strictEqual(displayListTitle(canonical, provenance), "Draft brief [customer note]", "TaskList hides its recorded suffix");
assert.strictEqual(displayListTitle("Draft brief [customer note] [Research & Design [Q3]]", null), "Draft brief [customer note] [Research & Design [Q3]]", "manual matching suffix stays visible");

const renamed = canonicalListTitle(canonical, "Planning", provenance);
assert.strictEqual(renamed, "Draft brief [customer note] [Planning]", "rename replaces only the original generated suffix");
const renamedProvenance = { list_id: "list-a", generated_suffix: " [Planning]" };
assert.strictEqual(canonicalListTitle("Draft brief [customer note] revised", "Planning", renamedProvenance), "Draft brief [customer note] revised [Planning]", "later title edit keeps only the current generated suffix");

const moved = canonicalListTitle(renamed, "Shipping", renamedProvenance);
assert.strictEqual(moved, "Draft brief [customer note] [Shipping]", "move replaces generated suffix without retaining obsolete text");
assert.strictEqual(displayListTitle(moved, { list_id: "list-b", generated_suffix: " [Shipping]" }), "Draft brief [customer note]", "moved task display has no obsolete suffix");
assert(source.includes("titleDraftRef.current === titleDraftSourceRef.current"), "delayed list data refreshes an untouched draft only");
assert(source.includes("[modalId, taskById, activeMembership, activeLists, activeTitleProvenance]"), "draft refresh reacts to delayed membership/list data");

console.log("title suffix provenance contract: 16 assertions passed");

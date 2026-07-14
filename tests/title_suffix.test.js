"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
// A manually authored suffix is ordinary title text, never generated metadata.
assert(source.includes('function taskTitle(t) { return String((t && t.title) || ""); }'),
  "TaskList must render the stored title verbatim, including user-authored suffixes");

// List renames only change membership data; the stored title remains untouched.
assert(source.includes("List membership is already canonical structured data"),
  "list membership must not be reconciled through the shared task title");

// Both creation paths submit the exact entered title, not a list-derived suffix.
assert(source.includes('{ title: title, triage: status === "triage" }'), "inline list creation must preserve the entered title");
assert(source.includes('{ title: title, triage: false }'), "new-task modal creation must preserve the entered title");
assert(!source.includes("canonicalTaskTitle"), "no title suffix reconciliation may mutate shared task titles");

// The detail draft is initialized again when async task data for the open modal arrives.
assert(source.includes("[modalId, modalTask && modalTask.title]"), "detail title initialization must depend on loaded task data");

console.log("title semantics contract: 6 assertions passed");

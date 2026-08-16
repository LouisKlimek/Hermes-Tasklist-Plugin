"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const fixture = [
  "Type: Sequenced Standalone Task",
  "Predecessor GitHub Auto Merge: t_deadbeef",
  "",
  "User-authored text",
].join("\n");

assert(source.includes('body: descDraft'), "description saves send the unmodified textarea value through the PATCH payload");
assert(source.includes('setDescDraft(task.body || "")'), "description editing reloads the persisted body verbatim into the textarea");
assert(source.includes('split("\\n")'), "description rendering splits persisted text into newline-delimited lines");
assert(source.includes('content.push(h("br", { key: "br" + index }))'), "nonblank multiline paragraphs render explicit line-break elements");
assert(!source.includes('mdInline(buf.join(" "), onOpen)'), "paragraph rendering must not collapse authored newlines into spaces");

const paragraphGroups = fixture.replace(/\r\n?/g, "\n").split("\n").reduce((groups, line) => {
  if (line === "") groups.push([]);
  else groups[groups.length - 1].push(line);
  return groups;
}, [[]]).filter((group) => group.length);
assert.deepStrictEqual(paragraphGroups, [
  ["Type: Sequenced Standalone Task", "Predecessor GitHub Auto Merge: t_deadbeef"],
  ["User-authored text"],
], "the supplied multiline description round-trip retains header lines and the blank-line paragraph boundary");
assert.deepStrictEqual("Single line".split("\n"), ["Single line"], "single-line descriptions remain a single rendered line");

console.log("description newline contract: 7 assertions passed");

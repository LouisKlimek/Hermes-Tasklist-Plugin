"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const helpers = source.match(/function followupRootTask\([\s\S]*?\n    }\n    function followupRootRepository\([\s\S]*?\n    }\n    function submitFollowup/);
assert(helpers, "follow-up root repository helpers must be present");

function resolver(tasks, parents) {
  const taskById = Object.fromEntries(tasks.map((task) => [task.id, task]));
  const edges = { parents };
  return Function("taskById", "edges", `${helpers[0].replace(/\n    function submitFollowup[\s\S]*/, "")}\nreturn followupRootRepository;`)(taskById, edges);
}

const root = { id: "root", body: "Repository: LouisKlimek/event-radar" };
const intermediate = { id: "intermediate", body: "Repository: wrong-owner/wrong-repo" };
const selected = { id: "selected", body: "Repository: also-wrong/also-wrong" };
let repository = resolver([root, intermediate, selected], {
  selected: ["intermediate"],
  intermediate: ["root"],
});
assert.strictEqual(repository(selected), "LouisKlimek/event-radar", "the topmost root repository must override nearer parent values");

const rootWithoutRepository = { id: "root-without-repository", body: "Type: Engineering Implementation" };
const child = { id: "child", body: "Repository: intermediate/repository" };
repository = resolver([rootWithoutRepository, child], { child: ["root-without-repository"] });
assert.strictEqual(repository(child), "", "a root without a valid repository must not fabricate an inherited value");

const invalidRoot = { id: "invalid-root", body: "Repository: not a repository" };
repository = resolver([invalidRoot, child], { child: ["invalid-root"] });
assert.strictEqual(repository(child), "", "invalid root repository headers must be ignored");

assert(source.includes('if (repository) { bodyLines.push("", "Repository: " + repository); }'), "only a resolved root repository may be added to the follow-up body");
assert(source.includes('"Original Task:",\n        src.id\n      ];\n      if (repository)'), "the inherited repository must follow the original task header");

console.log("follow-up repository inheritance contract: 5 assertions passed");

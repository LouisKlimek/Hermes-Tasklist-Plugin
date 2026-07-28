"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const helpers = source.match(/function isGithubPipelineStage\([\s\S]*?\n  function cell\(/);
assert(helpers, "GitHub-stage classification and graph-projection helpers must be present");
eval(`${helpers[0].replace(/\n  function cell\($/, "")}\n;globalThis.__graphHelpers = { isGithubPipelineStage, projectGithubStageEdges };`);

const { isGithubPipelineStage, projectGithubStageEdges } = globalThis.__graphHelpers;

assert.strictEqual(isGithubPipelineStage({ title: "Review PR #42: graph filter", assignee: "someone-else" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "ordinary title", body: "Type: Pull Request Review\nCurrent Head SHA: abc" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "GitHub Auto Merge PR #42" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "ordinary title", body: "Type: GitHub Auto Merge" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "GitHub reporting", assignee: "github-manager" }), false, "assignee alone must not hide unrelated cards");

const chain = projectGithubStageEdges(
  ["engineering", "followup"],
  { engineering: [], review: ["engineering"], merge: ["review"], followup: ["merge"] },
  { review: 1, merge: 1 }
);
assert.deepStrictEqual(chain.par, { engineering: [], followup: ["engineering"] }, "two hidden stages are bypassed transitively");
assert.deepStrictEqual(chain.chi, { engineering: ["followup"], followup: [] });

const multipleParents = projectGithubStageEdges(
  ["left", "right", "child"],
  { left: [], right: [], review: ["left", "right"], merge: ["review"], child: ["left", "merge"] },
  { review: 1, merge: 1 }
);
assert.deepStrictEqual(multipleParents.par.child.sort(), ["left", "right"], "all nearest visible ancestors are projected and duplicate edges are removed");
assert.deepStrictEqual(multipleParents.chi.left, ["child"]);
assert.deepStrictEqual(multipleParents.chi.right, ["child"]);

const cycleGuard = projectGithubStageEdges(["visible"], { visible: ["hidden"], hidden: ["visible"] }, { hidden: 1 });
assert.deepStrictEqual(cycleGuard.par, { visible: [] }, "projection never creates a self-cycle");

assert(source.includes("dependencyParents: dependencyParents"), "graph model keeps underlying dependencies for truthful waiting state");
assert(source.includes("hidden GitHub stage"), "visible children explain when a hidden GitHub stage is still blocking them");
assert(source.includes("LS_HIDE_GITHUB_STAGES"), "GitHub-stage switch uses a dedicated localStorage key");

console.log("GitHub-stage graph projection: 15 assertions passed");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const submit = source.match(/function submitFollowup\([\s\S]*?\n    }\n\n\n    \/\/ ---- detail-popup/);
const modal = source.match(/function followupModal\([\s\S]*?\n    }\n\n    function listDeleteModal/);

assert(submit, "feedback submission implementation must be present");
assert(modal, "feedback popup implementation must be present");

assert(source.includes('files: [], uploadError: ""'), "new feedback must initialize an empty attachment selection");
assert(modal[0].includes('type: "file", multiple: true'), "feedback popup must provide an accessible multi-file control");
assert(modal[0].includes('"aria-label": "Add feedback attachments"'), "file selection needs an accessible label");
assert(modal[0].includes('"aria-label": "Remove attachment " + file.name'), "selected attachments must be removable");
assert(modal[0].includes('file.name + (file.size != null'), "selected attachments must expose safe filename and size metadata");
assert(modal[0].includes('role: "alert"'), "attachment failures must be announced to users");

assert(submit[0].includes('var files = (followup.files || []).slice()'), "no-attachment feedback must preserve the existing submission path");
assert(submit[0].includes('new FormData()'), "attachments must use multipart form data");
assert(submit[0].includes('KAPI + "/tasks/" + encodeURIComponent(newId) + "/attachments" + bq()'), "uploads must use the proven host attachment route");
assert(submit[0].includes('authFetch('), "uploads must retain the host authenticated request path");
assert(submit[0].includes('if (!r.ok) throw new Error("Upload rejected'), "host validation rejections must stop submission");
assert(submit[0].includes('send("DELETE", tp + encodeURIComponent(newId) + bq(), null)'), "failed uploads must clean up their created feedback task");
assert(!submit[0].includes('cleanup.catch(function () { return null; })'), "a failed cleanup must not be silently treated as successful");
assert(submit[0].includes('automatic cleanup also failed'), "cleanup failures must report a distinct user-safe error");
assert(submit[0].includes('reference " + newId'), "cleanup failures must expose the partial feedback reference for recovery");
assert(!submit[0].includes('localStorage.setItem'), "feedback attachments must not use plugin-local storage");

console.log("feedback attachment contract: 17 assertions passed");

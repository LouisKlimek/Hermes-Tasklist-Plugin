/**
 * Task List — ClickUp-style list view for the Hermes Kanban board.
 *
 * No build step. Plain IIFE using the Hermes Plugin SDK globals.
 * Tasks come from /api/plugins/kanban/* ; custom Lists come from the companion
 * backend /api/plugins/tasklist/* (this plugin's plugin_api.py).
 *
 * Hierarchy (matches Hermes' native model):
 *   - Top level  = native Kanban BOARDS (created in the Kanban tab).
 *   - Inside a board = your own named LISTS (created here).
 *   - Inside a list  = its tasks grouped by STATUS.
 *
 * Sidebar: every board is a collapsible folder; create lists inside it, click a
 * list to open it, drag a task row onto a list (or use the per-task List
 * dropdown) to move it. Empty status sections are hidden; To Do is always shown
 * so you can add tasks.
 */
(function () {
  "use strict";


  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;
  var Fragment = React.Fragment;
  var hooks = SDK.hooks;
  var useState = hooks.useState, useEffect = hooks.useEffect, useMemo = hooks.useMemo, useCallback = hooks.useCallback, useRef = hooks.useRef;

  var KAPI = "/api/plugins/kanban";
  var TLAPI = "/api/plugins/tasklist";
  var LS_BOARD = "tasklist.board", LS_SCOPE = "tasklist.scope", LS_GROUPBY = "tasklist.groupBy", LS_VIEW = "tasklist.view";
  var POLL_MS = 4000;

  var STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
  // Fallback dot colors mirror the Kanban plugin's style.css (.hermes-kanban-dot-*)
  // so they're right even if that stylesheet fails to load; at runtime we read the
  // real colors from those classes (see KANBAN_COLORS below) so future CSS edits win.
  var STATUS = {
    triage: { label: "Triage", dot: "#b47dd6" }, todo: { label: "To Do", dot: "#9ca3af" },
    scheduled: { label: "Scheduled", dot: "#9ca3af" }, ready: { label: "Ready", dot: "#d4b348" },
    running: { label: "Running", dot: "#3fb97d" }, blocked: { label: "Blocked", dot: "#d14a4a" },
    review: { label: "Review", dot: "#9ca3af" }, done: { label: "Done", dot: "#4a8cd1" }, archived: { label: "Archived", dot: "#6b7280" }
  };
  var SETTABLE = ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"];
  var LIST_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#fb923c", "#818cf8", "#2dd4bf"];
  var COLW = { status: 112, priority: 96, assignee: 132, list: 124, age: 46 };

  var STATUS_PALETTE = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#fb923c", "#818cf8", "#2dd4bf", "#94a3b8"];
  function prettyStatus(s) { return String(s || "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }
  function statusColor(s) { var h = 0; s = String(s || ""); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return STATUS_PALETTE[h % STATUS_PALETTE.length]; }
  // Live colors read from the Kanban stylesheet's dot classes; overrides fallbacks.
  var KANBAN_COLORS = {};
  function statusMeta(s) { var base = STATUS[s] || { label: (s ? prettyStatus(s) : "?"), dot: (s ? statusColor(s) : "#71717a") }; return { label: base.label, dot: KANBAN_COLORS[s] || base.dot }; }
  // Ensure the Kanban plugin's stylesheet is present so its .hermes-kanban-dot-* rules apply.
  function ensureKanbanStyles(cb) {
    try {
      if (typeof document === "undefined") { cb && cb(); return; }
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) { if ((links[i].getAttribute("href") || "").indexOf("/dashboard-plugins/kanban/dist/style.css") !== -1) { cb && cb(); return; } }
      var base = (typeof window !== "undefined" && window.__HERMES_BASE_PATH__) || "";
      var link = document.createElement("link"); link.rel = "stylesheet"; link.href = base + "/dashboard-plugins/kanban/dist/style.css"; link.setAttribute("data-tl-kanban-css", "1");
      link.onload = function () { cb && cb(); }; link.onerror = function () { cb && cb(); };
      document.head.appendChild(link);
    } catch (e) { cb && cb(); }
  }
  // Read each status colour straight from the live .hermes-kanban-dot-<status> class.
  function readKanbanColors() {
    var out = {};
    try {
      if (typeof document === "undefined" || !window.getComputedStyle) return out;
      var host = document.createElement("div"); host.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none";
      document.body.appendChild(host);
      STATUS_ORDER.forEach(function (s) { var sp = document.createElement("span"); sp.className = "hermes-kanban-dot hermes-kanban-dot-" + s; host.appendChild(sp); var c = window.getComputedStyle(sp).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") out[s] = c; });
      document.body.removeChild(host);
    } catch (e) {}
    return out;
  }
  function priorityBucket(p) { p = p == null ? 0 : p; if (p >= 3) return { label: "Urgent", color: "#f87171" }; if (p === 2) return { label: "High", color: "#fb923c" }; if (p === 1) return { label: "Normal", color: "#38bdf8" }; return { label: "Low", color: "#71717a" }; }
  function ago(e, now) { if (e == null) return ""; var d = Math.max(0, (now || Math.floor(Date.now() / 1000)) - e); if (d < 60) return d + "s"; if (d < 3600) return Math.floor(d / 60) + "m"; if (d < 86400) return Math.floor(d / 3600) + "h"; if (d < 2592000) return Math.floor(d / 86400) + "d"; return Math.floor(d / 2592000) + "mo"; }
  function whenFull(e) { if (e == null) return ""; try { return new Date(e * 1000).toLocaleString(); } catch (x) { return String(e); } }
  function asgName(x) { return typeof x === "string" ? x : (x && (x.name || x.assignee)) || ""; }
  function hsize(n) { if (n == null) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
  function fmtPayload(p) { if (p == null || p === "") return ""; var str; try { str = typeof p === "string" ? p : JSON.stringify(p); } catch (e) { str = String(p); } return str; }
  function fmtBytes(n) { n = n || 0; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
  function filesDownloadHref(p) { var base = (typeof window !== "undefined" && window.__HERMES_BASE_PATH__) || ""; var tok = (typeof window !== "undefined" && window.__HERMES_SESSION_TOKEN__) || ""; var clean = String(p).replace(/^\/+/, ""); return base + "/api/files/download?path=" + encodeURIComponent(clean) + (tok ? "&token=" + encodeURIComponent(tok) : ""); }
  function isFilePath(p) { return /\.[A-Za-z0-9]{1,8}$/.test(String(p).split("/").pop()); }

  // ── persistent path-resolution cache (survives page reloads) ──
  var FX_LSKEY = "hermesPathCacheV1";
  function fxLoadCache() {
    try {
      var raw = window.localStorage.getItem(FX_LSKEY); if (!raw) return {};
      var o = JSON.parse(raw) || {}, now = Date.now(), out = {};
      Object.keys(o).forEach(function (k) { var v = o[k]; if (!v) return; var ttl = v.state === "valid" ? 604800000 : 3600000; if (now - (v.t || 0) < ttl) out[k] = { state: v.state, resolved: v.resolved }; });
      return out;
    } catch (e) { return {}; }
  }
  function fxSaveCache(cand, rec) {
    try {
      var raw = window.localStorage.getItem(FX_LSKEY); var o = raw ? (JSON.parse(raw) || {}) : {};
      o[cand] = { state: rec.state, resolved: rec.resolved, t: Date.now() };
      var keys = Object.keys(o); if (keys.length > 3000) { keys.sort(function (a, b) { return (o[a].t || 0) - (o[b].t || 0); }); keys.slice(0, keys.length - 3000).forEach(function (k) { delete o[k]; }); }
      window.localStorage.setItem(FX_LSKEY, JSON.stringify(o));
    } catch (e) {}
  }

  // Pull path candidates (files, and folders when wanted) out of a blob of text,
  // using the same shapes the renderer linkifies. URLs are stripped first so
  // "https://…/a/b.md" fragments aren't mistaken for local paths.
  function extractCandidates(text, wantFolders) {
    var s = String(text == null ? "" : text).replace(/(?:https?:\/\/|www\.)[^\s<>()\[\]]+/g, " ");
    var files = {}, folders = {}, m;
    var fre = /(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8}/g;
    while ((m = fre.exec(s))) files[m[0]] = 1;
    if (wantFolders) {
      var dre = /(?:[\w.\-]+\/){2,}[\w.\-]+(?![\w.\-]*\.[A-Za-z0-9])/g;
      while ((m = dre.exec(s))) { var pp = m[0].replace(/[.,;:!?]+$/, "").replace(/\/+$/, ""); if (pp) folders[pp] = 1; }
    }
    return { files: Object.keys(files), folders: Object.keys(folders) };
  }

  // Background-warmer ledger: which task ids were pre-scanned and when (per browser).
  var WARM_LSKEY = "hermesTlWarmLedgerV1";
  function warmLoad() { try { var raw = window.localStorage.getItem(WARM_LSKEY); var o = raw ? (JSON.parse(raw) || {}) : {}; return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
  function warmSave(o) { try { var keys = Object.keys(o); if (keys.length > 4000) { keys.sort(function (a, b) { return (o[a].t || 0) - (o[b].t || 0); }); keys.slice(0, keys.length - 4000).forEach(function (k) { delete o[k]; }); } window.localStorage.setItem(WARM_LSKEY, JSON.stringify(o)); } catch (e) {} }
  function linkifyPaths(text, onOpen) {
    if (text == null || text === "") return text;
    var s = String(text);
    var re = /((?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8})/g;
    var out = [], last = 0, m, i = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out.push(s.slice(last, m.index));
      var path = m[1];
      out.push(h("a", { key: "fp" + (i++), href: filesDownloadHref(path), target: "_blank", rel: "noopener noreferrer", title: "Open " + path, onClick: (function (pp) { return function (e) { e.stopPropagation(); if (onOpen) { e.preventDefault(); onOpen(pp); } }; })(path), style: { color: accent, textDecoration: "underline", wordBreak: "break-all", cursor: "pointer" } }, path));
      last = m.index + m[0].length;
    }
    if (!out.length) return s;
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  function mdCodeStyle() { return { fontFamily: "var(--font-courier, monospace)", fontSize: "0.9em", background: "rgba(128,128,128,.18)", border: "1px solid rgba(128,128,128,.28)", borderRadius: 4, padding: "0.5px 5px", color: "inherit" }; }
  function mdInline(s, onOpen) {
    var out = [], rest = String(s == null ? "" : s), key = 0;
    function pstate(cand, isFile) { if (!onOpen || !onOpen.known) return "valid"; var st = onOpen.known(cand); if (st === undefined) { if (onOpen.ensure) onOpen.ensure(cand, isFile); return "pending"; } return st; }
    function panchor(cand, label, style, kk) { return h("a", { key: kk, href: (onOpen.hrefFor ? onOpen.hrefFor(cand) : filesDownloadHref(cand)), target: "_blank", rel: "noopener noreferrer", title: "Open " + cand, onClick: function (e) { e.preventDefault(); e.stopPropagation(); onOpen(cand); }, style: style }, label); }
    var pats = [
      { re: /`([^`]+)`/, mk: function (m) { var inner = m[1]; var pp = inner.trim(); if (onOpen && /^(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8}$/.test(pp) && pstate(pp, true) === "valid") return panchor(pp, inner, Object.assign({}, mdCodeStyle(), { color: accent, textDecoration: "underline", cursor: "pointer", wordBreak: "break-all" }), "cl" + (key++)); return h("code", { key: "c" + (key++), style: mdCodeStyle() }, inner); } },
      { re: /((?:https?:\/\/|www\.)[^\s<>()\[\]]+)/, mk: function (m) { var raw = m[1].replace(/[.,;:!?]+$/, ""); var href = /^www\./i.test(raw) ? ("https://" + raw) : raw; return h("a", { key: "u" + (key++), href: href, target: "_blank", rel: "noopener noreferrer", onClick: function (e) { e.stopPropagation(); }, style: { color: accent, textDecoration: "underline", wordBreak: "break-all" } }, raw); } },
      { re: /\*\*([^*]+)\*\*/, mk: function (m) { return h("strong", { key: "b" + (key++) }, mdInline(m[1], onOpen)); } },
      { re: /__([^_]+)__/, mk: function (m) { return h("strong", { key: "b" + (key++) }, mdInline(m[1], onOpen)); } },
      { re: /\*([^*]+)\*/, mk: function (m) { return h("em", { key: "i" + (key++) }, mdInline(m[1], onOpen)); } },
      { re: /~~([^~]+)~~/, mk: function (m) { return h("del", { key: "s" + (key++) }, mdInline(m[1], onOpen)); } },
      { re: /\[([^\]]+)\]\(([^)\s]+)\)/, mk: function (m) { return h("a", { key: "l" + (key++), href: m[2], target: "_blank", rel: "noopener noreferrer", onClick: function (e) { e.stopPropagation(); }, style: { color: accent, textDecoration: "underline" } }, m[1]); } }
    ];
    if (onOpen) pats.push({ re: /((?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8})/, mk: function (m) { var pp = m[1]; if (pstate(pp, true) === "valid") return panchor(pp, pp, { color: accent, textDecoration: "underline", wordBreak: "break-all", cursor: "pointer" }, "fp" + (key++)); return pp; } });
    if (onOpen && onOpen.folders) pats.push({ re: /((?:[\w.\-]+\/){2,}[\w.\-]+)(?![\w.\-]*\.[A-Za-z0-9])/, mk: function (m) { var raw = m[1]; var pp = raw.replace(/[.,;:!?]+$/, "").replace(/\/+$/, ""); var tail = raw.slice(pp.length); if (pstate(pp, false) === "valid") return h(React.Fragment, { key: "df" + (key++) }, panchor(pp, pp, { color: accent, textDecoration: "underline", wordBreak: "break-all", cursor: "pointer" }, "dp" + (key++)), tail); return raw; } });
    var guard = 0;
    while (rest && guard++ < 5000) {
      var best = null;
      for (var p = 0; p < pats.length; p++) { pats[p].re.lastIndex = 0; var m = pats[p].re.exec(rest); if (m && (best === null || m.index < best.m.index)) best = { p: pats[p], m: m }; }
      if (!best) { out.push(rest); break; }
      if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
      out.push(best.p.mk(best.m));
      rest = rest.slice(best.m.index + best.m[0].length);
    }
    return out;
  }
  function mdHeadingStyle(lvl) { var sizes = [21, 17.5, 15.5, 14, 13, 12.5]; return { margin: lvl <= 2 ? "18px 0 8px" : "14px 0 6px", fontSize: sizes[lvl - 1] || 13, fontWeight: 700, lineHeight: 1.3, borderBottom: lvl <= 2 ? "1px solid rgba(128,128,128,.28)" : "none", paddingBottom: lvl <= 2 ? 5 : 0 }; }
  function mdCells(l) { var t = l.trim().replace(/^\|/, "").replace(/\|$/, ""); return t.split("|").map(function (c) { return c.trim(); }); }
  function mdList(lines, k, onOpen) {
    var indents = lines.map(function (l) { return /^(\s*)/.exec(l)[1].length; });
    var minI = Math.min.apply(null, indents);
    var ordered = new RegExp("^\\s{" + minI + "}\\d+\\.\\s+").test(lines[0]);
    var items = [], cur = null;
    lines.forEach(function (l) {
      var indent = /^(\s*)/.exec(l)[1].length;
      var m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
      if (indent <= minI && m) { if (cur) items.push(cur); cur = { text: m[1], children: [] }; }
      else if (cur) cur.children.push(l);
    });
    if (cur) items.push(cur);
    return h(ordered ? "ol" : "ul", { key: "L" + k, style: { margin: "0 0 10px", paddingLeft: 22, lineHeight: 1.6 } }, items.map(function (it, idx) {
      var kids = it.children.length ? mdBlocks(it.children.map(function (c) { return c.replace(new RegExp("^\\s{0," + (minI + 2) + "}"), ""); }).join("\n"), onOpen) : null;
      return h("li", { key: idx, style: { marginBottom: 3 } }, mdInline(it.text, onOpen), kids);
    }));
  }
  function mdBlocks(md, onOpen) {
    var lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    var blocks = [], i = 0, key = 0;
    function para(buf) { if (buf.length) blocks.push(h("p", { key: "p" + (key++), style: { margin: "0 0 10px", lineHeight: 1.65 } }, mdInline(buf.join(" "), onOpen))); }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*```/.test(line);
      if (fence) { var code = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; } i++; blocks.push(h("pre", { key: "pre" + (key++), style: { margin: "0 0 12px", background: "rgba(128,128,128,.14)", border: "1px solid rgba(128,128,128,.28)", borderRadius: 8, padding: "10px 12px", overflow: "auto" } }, h("code", { style: { fontFamily: "var(--font-courier, monospace)", fontSize: 12, whiteSpace: "pre", color: "inherit" } }, code.join("\n")))); continue; }
      var hd = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hd) { var lvl = hd[1].length; blocks.push(h("h" + Math.min(lvl, 6), { key: "h" + (key++), style: mdHeadingStyle(lvl) }, mdInline(hd[2].replace(/\s+#+\s*$/, ""), onOpen))); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(h("hr", { key: "hr" + (key++), style: { border: "none", borderTop: "1px solid rgba(128,128,128,.28)", margin: "14px 0" } })); i++; continue; }
      if (/^\s*>\s?/.test(line)) { var qb = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^\s*>\s?/, "")); i++; } blocks.push(h("blockquote", { key: "bq" + (key++), style: { margin: "0 0 10px", padding: "2px 12px", borderLeft: "3px solid rgba(128,128,128,.4)", color: "var(--muted-fg, inherit)", opacity: .85 } }, mdBlocks(qb.join("\n"), onOpen))); continue; }
      if (/\|/.test(line) && i + 1 < lines.length && /\|/.test(lines[i + 1]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var header = line; i += 2; var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") { rows.push(lines[i]); i++; }
        var head = mdCells(header);
        blocks.push(h("div", { key: "tw" + (key++), style: { overflow: "auto", margin: "0 0 12px" } }, h("table", { style: { borderCollapse: "collapse", fontSize: 12.5, width: "100%" } },
          h("thead", null, h("tr", null, head.map(function (c, ci) { return h("th", { key: ci, style: { border: "1px solid rgba(128,128,128,.28)", padding: "6px 9px", textAlign: "left", background: "rgba(128,128,128,.12)" } }, mdInline(c, onOpen)); }))),
          h("tbody", null, rows.map(function (r, ri) { var cs = mdCells(r); return h("tr", { key: ri }, cs.map(function (c, ci) { return h("td", { key: ci, style: { border: "1px solid rgba(128,128,128,.28)", padding: "6px 9px", verticalAlign: "top" } }, mdInline(c, onOpen)); })); }))))); continue;
      }
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) { var ll = []; while (i < lines.length && (/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) || (/^\s+\S/.test(lines[i]) && ll.length))) { ll.push(lines[i]); i++; } blocks.push(mdList(ll, key++, onOpen)); continue; }
      if (/^\s*$/.test(line)) { i++; continue; }
      var buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      para(buf);
    }
    return blocks;
  }

  function Caret(open, sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" } }, h("polyline", { points: "9 6 15 12 9 18" })); }
  function Dot(c, s) { return h("span", { style: { display: "inline-block", width: (s || 8) + "px", height: (s || 8) + "px", borderRadius: "50%", background: c, flex: "0 0 auto" } }); }
  function Grip() { return h("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", style: { flex: "0 0 auto", opacity: .5 } }, h("circle", { cx: 9, cy: 6, r: 1.6 }), h("circle", { cx: 15, cy: 6, r: 1.6 }), h("circle", { cx: 9, cy: 12, r: 1.6 }), h("circle", { cx: 15, cy: 12, r: 1.6 }), h("circle", { cx: 9, cy: 18, r: 1.6 }), h("circle", { cx: 15, cy: 18, r: 1.6 })); }
  function SubtaskIcon(sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flex: "0 0 auto" } }, h("path", { d: "M7 4v10a3 3 0 0 0 3 3h4" }), h("rect", { x: 14, y: 14, width: 6, height: 6, rx: 1.5 })); }
  function BoardIcon() { return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flex: "0 0 auto", opacity: .8 } }, h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }), h("line", { x1: 9, y1: 3, x2: 9, y2: 21 }), h("line", { x1: 15, y1: 3, x2: 15, y2: 21 })); }
  function CommentIcon() { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" })); }
  function XIcon(sz) { sz = sz || 16; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })); }
  function TrashIcon(sz) { sz = sz || 16; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("polyline", { points: "3 6 5 6 21 6" }), h("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }), h("line", { x1: 10, y1: 11, x2: 10, y2: 17 }), h("line", { x1: 14, y1: 11, x2: 14, y2: 17 })); }
  function ArchiveIcon(sz) { sz = sz || 16; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("rect", { x: 3, y: 4, width: 18, height: 4, rx: 1 }), h("path", { d: "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" }), h("line", { x1: 10, y1: 12, x2: 14, y2: 12 })); }
  function PlusIcon(sz) { sz = sz || 14; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }, h("line", { x1: 12, y1: 5, x2: 12, y2: 19 }), h("line", { x1: 5, y1: 12, x2: 19, y2: 12 })); }
  function PencilIcon(sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M12 20h9" }), h("path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" })); }

  function getJSON(p) { return SDK.fetchJSON(p); }
  function send(method, p, body) { return SDK.fetchJSON(p, { method: method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }); }
  // Server-side path-resolution cache (this plugin's own backend, /api/plugins/tasklist/pathcache).
  function pcRemoteGet() { return getJSON(TLAPI + "/pathcache"); }
  function pcRemotePut(cand, rec) { return send("PUT", TLAPI + "/pathcache", { cand: cand, state: rec.state, resolved: rec.resolved || null }); }
  // Best-effort read of the *File Explorer* plugin's cache, if it's installed. Purely additive:
  // we never write to it, so the two plugins stay independent but share resolved paths when both exist.
  function pcRemoteGetOther() { return getJSON("/api/plugins/fileexplorer/pathcache"); }
  // Raw authenticated fetch for multipart upload + binary download, where
  // fetchJSON's JSON assumptions don't fit. Mirrors the dashboard's own auth:
  // loopback injects window.__HERMES_SESSION_TOKEN__ (sent as a header); the
  // gated/OAuth mode authenticates via a same-origin session cookie. Also
  // honours a reverse-proxy base path.
  function authFetch(p, opts) {
    opts = opts || {};
    var base = window.__HERMES_BASE_PATH__ || "";
    var headers = Object.assign({}, opts.headers || {});
    var tok = window.__HERMES_SESSION_TOKEN__;
    if (tok) headers["X-Hermes-Session-Token"] = tok;
    opts.headers = headers; opts.credentials = "same-origin";
    return fetch(base + p, opts);
  }

  var muted = "var(--muted-foreground, #9ca3af)";
  var borderC = "var(--border, #2a2a2a)";
  var cardBg = "var(--card, var(--background, #111))";
  var bgMuted = "var(--muted, rgba(255,255,255,.03))";
  var accent = "var(--primary, #6366f1)";

  (function injectStyle() {
    try {
      if (typeof document === "undefined" || document.getElementById("tl-style")) return;
      var st = document.createElement("style"); st.id = "tl-style";
      st.textContent = ".tl-editable{border:1px solid transparent;border-radius:8px;transition:background .12s,border-color .12s;cursor:text}"
        + ".tl-editable:hover{background:var(--muted,rgba(255,255,255,.05));border-color:var(--border,#2a2a2a)}"
        + ".tl-penhint{opacity:0;transition:opacity .12s}"
        + ".tl-editable:hover .tl-penhint{opacity:1}"
        + "@keyframes tl-node-in{from{opacity:0;transform:translateY(10px) scale(.94)}to{opacity:1;transform:none}}"
        + "@keyframes tl-edge-draw{to{stroke-dashoffset:0}}"
        + "@keyframes tl-flow{to{stroke-dashoffset:-28}}"
        + "@keyframes tl-pulse{0%,100%{opacity:.45}50%{opacity:1}}"
        + "@keyframes tl-fade-in{from{opacity:0}to{opacity:1}}"
        + ".tl-gnode{transform-box:fill-box;transform-origin:center;transition:transform .16s cubic-bezier(.2,.7,.3,1)}"
        + ".tl-gnode:hover{transform:translateY(-3px) scale(1.035)}"
        + ".tl-gnode>rect,.tl-gnode>circle,.tl-gnode>text{transition:stroke .2s ease,fill .2s ease,opacity .2s ease,stroke-width .2s ease}"
        + ".tl-gnode.in{animation:tl-node-in .44s cubic-bezier(.2,.7,.3,1) both}"
        + ".tl-gedge{transition:stroke .2s ease,opacity .2s ease,stroke-width .2s ease}"
        + ".tl-gedge.in{animation:tl-edge-draw .55s ease both}"
        + ".tl-gedge.flow{animation:tl-flow .8s linear infinite}"
        + ".tl-pulse{animation:tl-pulse 2.1s ease-in-out infinite}"
        + ".tl-stage{animation:tl-fade-in .5s ease both}"
        + "@media (prefers-reduced-motion: reduce){.tl-gnode.in,.tl-gedge.in,.tl-gedge.flow,.tl-pulse,.tl-stage{animation:none!important}.tl-gnode{transition:none}}";
      document.head.appendChild(st);
    } catch (e) {}
  })();

  function editSelect(value, onChange, options, title, opts) {
    opts = opts || {};
    return h("span", { onClick: function (e) { e.stopPropagation(); }, style: opts.full ? { display: "block" } : null },
      h("select", { value: value, title: title || "", "aria-label": title || "", onChange: function (e) { onChange(e.target.value); }, className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: opts.pill ? 999 : 6, padding: opts.lg ? "8px 11px" : (opts.pill ? "2px 7px" : "4px 8px"), fontSize: opts.lg ? 13 : (opts.small ? 11 : 12), cursor: "pointer", width: opts.full ? "100%" : undefined, maxWidth: opts.maxWidth || "none" } },
        options.map(function (o) { return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label); })));
  }
  // Portal: render the modal into document.body so it escapes the dashboard's
  // plugin container (which is its own stacking context — otherwise the app
  // sidebar can paint over a position:fixed overlay no matter its z-index).
  var _RDOM = (typeof window !== "undefined" && (window.ReactDOM || (SDK && SDK.ReactDOM) || (SDK && SDK.reactDOM))) || null;
  var _createPortal = (_RDOM && _RDOM.createPortal) || (React && React.createPortal) || null;
  // Find the element React mounted into (its root container) by walking up from
  // a node inside our tree. React 18 tags that element with a __reactContainer$
  // expando and delegates all events there — so a portal node must live INSIDE
  // it for onClick/onChange to keep firing. Appending high in that container
  // (with a big z-index) also lifts us above the app sidebar's stacking context.
  function findReactRootContainer(node) {
    var n = node;
    while (n && n.nodeType === 1) {
      for (var k in n) { if (k.indexOf("__reactContainer$") === 0) return n; }
      n = n.parentNode;
    }
    return null;
  }

  function Portal(props) {
    var holderRef = useRef(null);
    var peRef = useRef(null);
    var closeRef = useRef(null); closeRef.current = props.onClose;
    if (!peRef.current && typeof document !== "undefined") { var el = document.createElement("div"); el.setAttribute("data-tasklist-portal", ""); peRef.current = el; }
    useEffect(function () {
      var pe = peRef.current; if (!pe || typeof document === "undefined") return;
      var holder = holderRef.current;
      var root = (holder && findReactRootContainer(holder)) || document.body;
      if (pe.parentNode !== root) root.appendChild(pe);
      // belt-and-braces close (works even if we had to fall back to <body>,
      // where React's delegated handlers wouldn't fire)
      function onNativeClick(e) { var tgt = e.target; if (tgt && tgt.closest && tgt.closest("[data-tl-close]")) { if (closeRef.current) closeRef.current(); return; } if (tgt && tgt.hasAttribute && tgt.hasAttribute("data-tl-backdrop")) { if (closeRef.current) closeRef.current(); } }
      pe.addEventListener("click", onNativeClick);
      if (!_createPortal && holder) {
        if (!holder.__tlPatched) { var orig = holder.removeChild.bind(holder); holder.removeChild = function (c) { return (c && c.parentNode === holder) ? orig(c) : c; }; holder.__tlPatched = true; }
        while (holder.firstChild) pe.appendChild(holder.firstChild);
      }
      return function () {
        try { pe.removeEventListener("click", onNativeClick); } catch (e) {}
        try { if (!_createPortal && holder) { while (pe.firstChild) holder.appendChild(pe.firstChild); } } catch (e) {}
        try { if (pe.parentNode) pe.parentNode.removeChild(pe); } catch (e) {}
      };
    }, []);
    if (_createPortal && peRef.current) return h(Fragment, null, h("div", { ref: holderRef, style: { display: "none" } }), _createPortal(props.children, peRef.current));
    return h("div", { ref: holderRef, style: { display: "contents" } }, props.children);
  }

  function DotSelect(props) {
    var value = props.value, options = props.options || [], onChange = props.onChange, opts = props.opts || {};
    var st = useState(false); var open = st[0], setOpen = st[1];
    var ps = useState(null); var pos = ps[0], setPos = ps[1];
    var qs = useState(""); var query = qs[0], setQuery = qs[1];
    var ref = useRef(null); var btnRef = useRef(null);
    useEffect(function () { if (open) setQuery(""); }, [open]);
    useEffect(function () {
      if (!open) return;
      function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
      function onKey(e) { if (e.key === "Escape") setOpen(false); }
      function onScroll(e) { if (e && e.target && ref.current && ref.current.contains && ref.current.contains(e.target)) return; setOpen(false); }
      document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true); window.addEventListener("resize", onScroll);
      return function () { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); };
    }, [open]);
    function toggle() {
      if (open) { setOpen(false); return; }
      var r = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
      if (r) { var up = (window.innerHeight - r.bottom) < (opts.search ? 340 : 260); setPos({ left: r.left, width: r.width, top: up ? null : Math.round(r.bottom + 4), bottom: up ? Math.round(window.innerHeight - r.top + 4) : null }); }
      setOpen(true);
    }
    var cur = null; for (var i = 0; i < options.length; i++) { if (String(options[i].value) === String(value)) { cur = options[i]; break; } }
    var anyDot = false; for (var j = 0; j < options.length; j++) { if (options[j].dot) { anyDot = true; break; } }
    var ql = query.trim().toLowerCase();
    var filtered = (opts.search && ql) ? options.filter(function (o) { return String(o.label).toLowerCase().indexOf(ql) !== -1 || String(o.value).toLowerCase().indexOf(ql) !== -1; }) : options;
    function optRow(o) {
      var sel = String(o.value) === String(value);
      return h("div", { key: o.value, onClick: function () { onChange(o.value); setOpen(false); }, style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, whiteSpace: "nowrap", background: sel ? accent + "22" : "transparent" }, onMouseEnter: function (e) { if (!sel) e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { if (!sel) e.currentTarget.style.background = "transparent"; } },
        o.dot ? Dot(o.dot, 9) : (anyDot ? h("span", { style: { width: 9, flex: "0 0 auto" } }) : null),
        h("span", null, o.label));
    }
    var qTrim = query.trim();
    var exactMatch = options.some(function (o) { return String(o.label).toLowerCase() === qTrim.toLowerCase(); });
    var createRow = (opts.onCreate && qTrim && !exactMatch) ? h("div", { onClick: function () { var r = opts.onCreate(qTrim); if (r && r.then) { r.then(function (v) { if (v != null) onChange(v); }); } setOpen(false); }, style: { display: "flex", alignItems: "center", gap: 7, padding: "8px 9px", margin: "2px 0 0", borderTop: "1px solid " + borderC, borderRadius: 6, cursor: "pointer", fontSize: 12.5, color: accent, fontWeight: 600 }, onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; } }, h("span", { style: { fontSize: 15, lineHeight: 1 } }, "+"), h("span", null, "Create \u201c" + qTrim + "\u201d")) : null;
    var menu = (open && pos) ? h("div", { style: { position: "fixed", left: pos.left, top: pos.top == null ? undefined : pos.top, bottom: pos.bottom == null ? undefined : pos.bottom, minWidth: Math.max(pos.width, opts.search ? 230 : 150), maxWidth: 380, maxHeight: 320, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--background, #111)", border: "1px solid " + borderC, borderRadius: 8, boxShadow: "0 12px 34px rgba(0,0,0,.55)", zIndex: 2000 } },
      opts.search ? h("div", { style: { padding: 6, borderBottom: "1px solid " + borderC, flex: "0 0 auto" } },
        h("input", { autoFocus: true, value: query, placeholder: opts.onCreate ? "Search or type to create\u2026" : "Search\u2026", onChange: function (e) { setQuery(e.target.value); }, onKeyDown: function (e) { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } if (e.key === "Enter" && createRow) { e.preventDefault(); var r = opts.onCreate(qTrim); if (r && r.then) { r.then(function (v) { if (v != null) onChange(v); }); } setOpen(false); } }, className: "font-courier", style: { width: "100%", boxSizing: "border-box", background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 6, padding: "6px 8px", fontSize: 12.5 } })) : null,
      h("div", { style: { overflow: "auto", padding: 4, flex: "1 1 auto" } },
        filtered.length ? filtered.map(optRow) : (createRow ? null : h("div", { style: { padding: "8px 9px", fontSize: 12, color: muted } }, "No matches")),
        createRow)) : null;
    return h("span", { ref: ref, onClick: function (e) { e.stopPropagation(); }, style: { position: "relative", display: opts.full ? "block" : "inline-block", minWidth: 0, maxWidth: "100%", width: opts.full ? "100%" : undefined } },
      h("button", { ref: btnRef, type: "button", onClick: toggle, className: "font-courier", style: { display: "flex", alignItems: "center", gap: 7, width: opts.full ? "100%" : undefined, maxWidth: opts.maxWidth || undefined, background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: opts.pill ? 999 : 8, padding: opts.lg ? "8px 11px" : (opts.pill ? "3px 9px" : "5px 9px"), fontSize: opts.lg ? 13 : (opts.small ? 11 : 12), cursor: "pointer", textAlign: "left", overflow: "hidden" } },
        cur && cur.dot ? Dot(cur.dot, 9) : null,
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, cur ? cur.label : String(value || "")),
        h("span", { style: { display: "inline-flex", color: muted, flex: "0 0 auto" } }, Caret(false, 10))),
      menu);
  }

  function statusOptions(t) { var o = SETTABLE.map(function (st) { return { value: st, label: statusMeta(st).label }; }); if (SETTABLE.indexOf(t.status) === -1) o.unshift({ value: t.status, label: statusMeta(t.status).label }); return o; }
  function prioOptions(t) { var b = [{ value: "3", label: "Urgent" }, { value: "2", label: "High" }, { value: "1", label: "Normal" }, { value: "0", label: "Low" }]; var c = t.priority == null ? 0 : t.priority; if ([0, 1, 2, 3].indexOf(c) === -1) b.unshift({ value: String(c), label: "P" + c }); return b; }

  function cell(w, content, right) { return h("div", { style: { width: w + "px", flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: right ? "flex-end" : "flex-start", overflow: "hidden" } }, content); }
  function colHeaderLbl(txt) { return h("span", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: muted, whiteSpace: "nowrap" } }, txt); }
  function columnHeader() {
    return h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderTop: "1px solid " + borderC } },
      h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 10 } },
        h("span", { style: { width: 12, flex: "0 0 auto" } }), h("span", { style: { width: 11, flex: "0 0 auto" } }), h("span", { style: { width: 8, flex: "0 0 auto" } }), colHeaderLbl("Name")),
      h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 } },
        cell(COLW.status, colHeaderLbl("Status")), cell(COLW.priority, colHeaderLbl("Priority")), cell(COLW.assignee, colHeaderLbl("Assignee")), cell(COLW.list, colHeaderLbl("List")), cell(COLW.age, colHeaderLbl("Age"), true)));
  }

  // =========================================================================
  function TaskListPage() {
    var rd = function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
    var rdj = function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };

    var s;
    s = useState([]); var boards = s[0], setBoards = s[1];
    s = useState(rd(LS_BOARD, "")); var board = s[0], setBoard = s[1];
    s = useState(null); var data = s[0], setData = s[1];
    s = useState(true); var loading = s[0], setLoading = s[1];
    s = useState(null); var error = s[0], setError = s[1];
    s = useState([]); var asgOpts = s[0], setAsgOpts = s[1];

    s = useState({}); var byBoard = s[0], setByBoard = s[1];     // slug -> {lists, membership}
    s = useState({}); var collapsedBoards = s[0], setCollapsedBoards = s[1];
    s = useState(rdj(LS_SCOPE, { type: "all" })); var scope = s[0], setScope = s[1];
    s = useState(null); var adding = s[0], setAdding = s[1];     // {board} -> add-list input open
    s = useState(""); var addName = s[0], setAddName = s[1];
    s = useState(null); var editing = s[0], setEditing = s[1];   // {id, board}
    s = useState(""); var editName = s[0], setEditName = s[1];
    s = useState(null); var dragId = s[0], setDragId = s[1];
    s = useState(null); var dropList = s[0], setDropList = s[1];

    s = useState(rd(LS_GROUPBY, "status")); var groupBy = s[0], setGroupBy = s[1];
    s = useState("created"); var sortBy = s[0], setSortBy = s[1];
    s = useState("desc"); var sortDir = s[0], setSortDir = s[1];
    s = useState(rd(LS_VIEW, "list")); var view = s[0], setView = s[1];   // "list" | "graph"
    s = useState(1); var graphZoom = s[0], setGraphZoom = s[1];
    s = useState(null); var graphHover = s[0], setGraphHover = s[1];
    s = useState(false); var graphAnim = s[0], setGraphAnim = s[1];   // brief entrance-animation window
    s = useState(0); var colorV = s[0], setColorV = s[1];   // bumps when live Kanban colors are read
    useEffect(function () {
      var cancelled = false;
      function apply() { if (cancelled) return; var c = readKanbanColors(); var changed = false; Object.keys(c).forEach(function (k) { if (KANBAN_COLORS[k] !== c[k]) { KANBAN_COLORS[k] = c[k]; changed = true; } }); if (changed) setColorV(function (v) { return v + 1; }); }
      ensureKanbanStyles(function () { apply(); setTimeout(apply, 250); setTimeout(apply, 900); });
      return function () { cancelled = true; };
    }, []);
    useEffect(function () { if (view !== "graph") { setGraphAnim(false); return; } setGraphAnim(true); var to = setTimeout(function () { setGraphAnim(false); }, 1500); return function () { clearTimeout(to); }; }, [view]);
    // SVG <text> can't use the theme's --foreground directly: in this theme it's an
    // HSL *triplet* ("210 40% 98%"), which is an invalid color for `fill`, and
    // `currentColor` doesn't inherit a usable color at the SVG. So read the variable
    // at runtime from an in-tree probe and build a valid CSS color from it.
    s = useState("#e5e7eb"); var fgColor = s[0], setFgColor = s[1];
    var fgProbeRef = useRef(null);
    useEffect(function () {
      if (view !== "graph") return;
      try {
        var el = fgProbeRef.current; if (!el || typeof window === "undefined" || !window.getComputedStyle) return;
        var cs = window.getComputedStyle(el);
        function rv(n) { return (cs.getPropertyValue(n) || "").trim(); }
        var f = rv("--foreground") || rv("--card-foreground") || rv("--popover-foreground");
        var col = "";
        if (f) {
          if (/^(#|rgb|hsl|[a-zA-Z]+$)/.test(f)) col = f;                              // already a color
          else if (f.indexOf("%") !== -1) col = "hsl(" + f + ")";                      // HSL triplet "H S% L%"
          else if (/^[\d.]+\s+[\d.]+\s+[\d.]+$/.test(f)) col = "rgb(" + f.replace(/\s+/g, ",") + ")"; // RGB triplet
        }
        if (col && col !== fgColor) setFgColor(col);
      } catch (e) {}
    }, [view, graphModel]);
    s = useState({ x: 0, y: 0 }); var graphPan = s[0], setGraphPan = s[1];
    s = useState(false); var panning = s[0], setPanning = s[1];
    var zoomRef = useRef(1); zoomRef.current = graphZoom;
    var panRef = useRef({ x: 0, y: 0 }); panRef.current = graphPan;
    var panningRef = useRef(false);
    var viewportRef = useRef(null);
    var suppressClickRef = useRef(false);
    s = useState(""); var search = s[0], setSearch = s[1];
    s = useState(""); var fAssignee = s[0], setFAssignee = s[1];
    s = useState(false); var showArchived = s[0], setShowArchived = s[1];

    s = useState({}); var collapsedSec = s[0], setCollapsedSec = s[1];
    s = useState(null); var addTaskSec = s[0], setAddTaskSec = s[1];
    s = useState(""); var addTaskTitle = s[0], setAddTaskTitle = s[1];
    s = useState(null); var modalId = s[0], setModalId = s[1];
    s = useState("details"); var modalTab = s[0], setModalTab = s[1];
    s = useState(null); var confirmDel = s[0], setConfirmDel = s[1];
    s = useState(null); var confirmDelList = s[0], setConfirmDelList = s[1];
    s = useState(null); var filePreview = s[0], setFilePreview = s[1];
    s = useState(false); var previewRaw = s[0], setPreviewRaw = s[1];
    s = useState([]); var filePreviewStack = s[0], setFilePreviewStack = s[1];
    s = useState(false); var explorerInstalled = s[0], setExplorerInstalled = s[1];
    s = useState("/file-explorer"); var explorerTab = s[0], setExplorerTab = s[1];
    s = useState(false); var creating = s[0], setCreating = s[1];   // draft "new task" modal (nothing persisted until Create)
    s = useState(null); var draft = s[0], setDraft = s[1];
    s = useState(false); var savingNew = s[0], setSavingNew = s[1];
    s = useState(false); var confirmClose = s[0], setConfirmClose = s[1];
    var draftInit = useRef(null);
    useEffect(function () { setModalTab("details"); setConfirmDel(null); }, [modalId]);
    s = useState({}); var detail = s[0], setDetail = s[1];
    s = useState(null); var notice = s[0], setNotice = s[1];
    s = useState(""); var titleDraft = s[0], setTitleDraft = s[1];
    s = useState({ children: {}, parents: {} }); var edges = s[0], setEdges = s[1];
    s = useState({}); var expandedTasks = s[0], setExpandedTasks = s[1];
    s = useState(false); var descEdit = s[0], setDescEdit = s[1];
    s = useState(""); var descDraft = s[0], setDescDraft = s[1];
    s = useState(""); var commentDraft = s[0], setCommentDraft = s[1];
    s = useState({}); var workerLog = s[0], setWorkerLog = s[1];
    s = useState(""); var addParentSel = s[0], setAddParentSel = s[1];
    s = useState(""); var addChildSel = s[0], setAddChildSel = s[1];
    s = useState(false); var isNarrow = s[0], setIsNarrow = s[1];
    s = useState(false); var isCompact = s[0], setIsCompact = s[1];
    s = useState(true); var sidebarOpen = s[0], setSidebarOpen = s[1];

    useEffect(function () {
      if (typeof window === "undefined" || !window.matchMedia) return;
      var mq = window.matchMedia("(max-width: 820px)");      // mobile: modal fullscreen + sidebar stacking
      var mc = window.matchMedia("(max-width: 1080px)");     // compact: task rows become cards (title gets full width)
      function on() { setIsNarrow(mq.matches); setSidebarOpen(!mq.matches); setIsCompact(mc.matches); }
      on();
      if (mq.addEventListener) { mq.addEventListener("change", on); mc.addEventListener("change", on); }
      else if (mq.addListener) { mq.addListener(on); mc.addListener(on); }
      return function () {
        if (mq.removeEventListener) { mq.removeEventListener("change", on); mc.removeEventListener("change", on); }
        else if (mq.removeListener) { mq.removeListener(on); mc.removeListener(on); }
      };
    }, []);

    var lastEvent = useRef(-1);
    var boardRef = useRef(board); boardRef.current = board;
    var filePreviewRef = useRef(null); filePreviewRef.current = filePreview;
    var filePreviewStackRef = useRef([]); filePreviewStackRef.current = filePreviewStack;
    var explorerRef = useRef(false); explorerRef.current = explorerInstalled;
    var explorerTabRef = useRef("/file-explorer"); explorerTabRef.current = explorerTab;
    var resolveCacheRef = useRef({});
    var folderCacheRef = useRef({});
    var pathValidRef = useRef(null); if (pathValidRef.current === null) pathValidRef.current = {};
    var cacheReadyRef = useRef(false);   // true once the server cache (or LS fallback) has been loaded
    var backendRef = useRef(true);       // false if the backend cache endpoint is unreachable -> LS fallback
    useEffect(function () {
      function merge(r) { var e = (r && r.entries) || {}; Object.keys(e).forEach(function (k) { if (!(k in pathValidRef.current)) pathValidRef.current[k] = { state: e[k].state, resolved: e[k].resolved }; }); }
      var other = pcRemoteGetOther().catch(function () { return null; });   // File Explorer's cache, if present
      pcRemoteGet().then(function (r) { backendRef.current = true; merge(r); })
        .catch(function () { backendRef.current = false; var ls = fxLoadCache(); Object.keys(ls).forEach(function (k) { if (!(k in pathValidRef.current)) pathValidRef.current[k] = ls[k]; }); })
        .then(function () { return other; })
        .then(function (r) { if (r) merge(r); cacheReadyRef.current = true; setPathV(function (v) { return v + 1; }); });
    }, []);

    // ── background path pre-warmer ──
    // While the List page is open, occasionally scan a few tickets' text and
    // resolve their paths into the cache silently (no re-render), so opening a
    // ticket later shows links instantly. Gentle by design: small batches, spread
    // out, paused when the tab is hidden or a ticket modal is open, and each ticket
    // is remembered (localStorage ledger) so the same ones aren't re-scanned until
    // stale. Nothing here blocks or changes what the user sees.
    var tasksRef = useRef([]);
    var modalIdRef = useRef(null); modalIdRef.current = modalId;
    var warmLedgerRef = useRef(null); if (warmLedgerRef.current === null) warmLedgerRef.current = warmLoad();
    var warmTimerRef = useRef(null);
    useEffect(function () {
      var WARM_BATCH = 5, WARM_TTL = 21600000, SHORT = 15000, LONG = 300000, GAP = 350, MAXC = 40, INIT = 3500;
      var stopped = false;
      function runWarm() {
        warmTimerRef.current = null;
        if (stopped) return;
        var hidden = (typeof document !== "undefined" && document.hidden);
        if (hidden || !cacheReadyRef.current || modalIdRef.current) { warmTimerRef.current = setTimeout(runWarm, hidden ? LONG : SHORT); return; }
        var now = Date.now(), ledger = warmLedgerRef.current || (warmLedgerRef.current = {});
        var list = (tasksRef.current || []).filter(function (t) { if (!t || !t.id) return false; var e = ledger[t.id]; return !e || (now - (e.t || 0)) > WARM_TTL; });
        if (!list.length) { warmTimerRef.current = setTimeout(runWarm, LONG); return; }
        list.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }); // newest first (most likely to be opened)
        var batch = list.slice(0, WARM_BATCH), more = list.length > batch.length;
        var handler = makePathHandler(false), wantFolders = !!handler.folders, i = 0;
        function step() {
          if (stopped) return;
          if (i >= batch.length) { warmSave(warmLedgerRef.current); warmTimerRef.current = setTimeout(runWarm, more ? SHORT : LONG); return; }
          var t = batch[i++];
          getJSON(KAPI + "/tasks/" + encodeURIComponent(t.id) + (boardRef.current ? ("?board=" + encodeURIComponent(boardRef.current)) : "")).then(function (d) {
            var tk = (d && d.task) || t, texts = [];
            if (tk.body) texts.push(tk.body);
            if (tk.result) texts.push(tk.result);
            ((d && d.runs) || []).forEach(function (r) { if (r && r.summary) texts.push(r.summary); });
            ((d && d.comments) || []).forEach(function (c) { if (c && c.body) texts.push(c.body); });
            texts.forEach(function (tx) { var ex = extractCandidates(tx, wantFolders); ex.files.slice(0, MAXC).forEach(function (f) { handler.ensure(f, true, true); }); ex.folders.slice(0, MAXC).forEach(function (fd) { handler.ensure(fd, false, true); }); });
          }).catch(function () { }).then(function () { warmLedgerRef.current[t.id] = { t: Date.now() }; if (!stopped) setTimeout(step, GAP); });
        }
        step();
      }
      warmTimerRef.current = setTimeout(runWarm, INIT);
      function onVis() { if (typeof document !== "undefined" && !document.hidden && !warmTimerRef.current && !stopped) warmTimerRef.current = setTimeout(runWarm, 1200); }
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
      return function () { stopped = true; if (warmTimerRef.current) { clearTimeout(warmTimerRef.current); warmTimerRef.current = null; } if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
    }, []);
    var searchChainRef = useRef(Promise.resolve());
    s = useState(0); var pathV = s[0], setPathV = s[1];
    var dragRef = useRef(null);

    useEffect(function () { try { localStorage.setItem(LS_GROUPBY, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { localStorage.setItem(LS_VIEW, view); } catch (e) {} }, [view]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);
    useEffect(function () { try { localStorage.setItem(LS_SCOPE, JSON.stringify(scope)); } catch (e) {} }, [scope]);

    var bq = useCallback(function (extra) { var q = board ? ("?board=" + encodeURIComponent(board)) : ""; return extra ? (q ? q + "&" + extra : "?" + extra) : q; }, [board]);
    function tlq(slug) { return "?board=" + encodeURIComponent(slug || "default"); }

    useEffect(function () { getJSON(KAPI + "/boards").then(function (r) { setBoards((r && r.boards) || []); if (!boardRef.current && r && r.current) setBoard(r.current); }).catch(function () {}); }, []);

    // Deep link: /list?task=<board>\x1F<taskId>  -> select board + open the ticket popup
    useEffect(function () {
      if (typeof window === "undefined" || !window.location) return;
      try {
        var raw = new URLSearchParams(window.location.search).get("task");
        if (!raw) return;
        var sep = raw.indexOf("\u001f"); if (sep === -1) sep = raw.indexOf("\u241f"); // tolerate visible ␟ too
        var bd = sep !== -1 ? raw.slice(0, sep) : "";
        var tid = sep !== -1 ? raw.slice(sep + 1) : raw;
        if (bd) { setBoard(bd); setCollapsedBoards(function (n) { var x = Object.assign({}, n); x[bd] = false; return x; }); }
        if (tid) setModalId(tid);
      } catch (e) {}
    }, []);

    // Keep the URL in sync so an open ticket is shareable / reload-safe
    useEffect(function () {
      if (typeof window === "undefined" || !window.history || !window.history.replaceState) return;
      try {
        var url = new URL(window.location.href);
        if (modalId && board) url.searchParams.set("task", board + "\u001f" + modalId);
        else url.searchParams.delete("task");
        window.history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
      } catch (e) {}
    }, [modalId, board]);

    var loadAssignees = useCallback(function () { getJSON(KAPI + "/assignees" + bq()).then(function (r) { setAsgOpts(((r && r.assignees) || []).map(asgName).filter(Boolean)); }).catch(function () {}); }, [bq]);
    useEffect(function () { loadAssignees(); }, [loadAssignees]);

    var loadTreeFor = useCallback(function (slug) {
      if (!slug) return;
      getJSON(TLAPI + "/lists" + tlq(slug)).then(function (r) { setByBoard(function (m) { var n = Object.assign({}, m); n[slug] = { lists: (r && r.lists) || [], membership: (r && r.membership) || {} }; return n; }); })
        .catch(function () { setByBoard(function (m) { var n = Object.assign({}, m); n[slug] = { lists: [], membership: {} }; return n; }); });
    }, []);
    // load lists for every board so the whole tree + counts render
    useEffect(function () { boards.forEach(function (b) { loadTreeFor(b.slug); }); }, [boards, loadTreeFor]);

    var load = useCallback(function (silent) {
      if (!silent) setLoading(true);
      getJSON(KAPI + "/board" + bq("include_archived=" + (showArchived ? "true" : "false"))).then(function (r) { lastEvent.current = r.latest_event_id; setData(r); setError(null); setLoading(false); })
        .catch(function (e) { setError((e && e.message) || "Failed to load board"); setLoading(false); });
    }, [bq, showArchived]);
    useEffect(function () { if (board) load(false); }, [load, board]);

    var loadEdges = useCallback(function () {
      if (!boardRef.current) return;
      getJSON(TLAPI + "/links" + tlq(boardRef.current)).then(function (r) { setEdges({ children: (r && r.children) || {}, parents: (r && r.parents) || {} }); }).catch(function () { setEdges({ children: {}, parents: {} }); });
    }, []);
    useEffect(function () { if (board) loadEdges(); }, [board, data, loadEdges]);

    useEffect(function () {
      var t = setInterval(function () {
        if (document.hidden || !boardRef.current) return;
        var q = "?board=" + encodeURIComponent(boardRef.current) + "&include_archived=" + (showArchived ? "true" : "false");
        getJSON(KAPI + "/board" + q).then(function (r) { if (r.latest_event_id !== lastEvent.current) { lastEvent.current = r.latest_event_id; setData(r); } }).catch(function () {});
      }, POLL_MS);
      return function () { clearInterval(t); };
    }, [showArchived]);

    var tasks = useMemo(function () { if (!data || !data.columns) return []; var o = []; data.columns.forEach(function (c) { (c.tasks || []).forEach(function (t) { o.push(t); }); }); return o; }, [data]);
    tasksRef.current = tasks;
    var boardCols = useMemo(function () { var a = []; if (data && data.columns) data.columns.forEach(function (c) { if (c && c.name) a.push(c.name); }); return a; }, [data]);
    var liveStatusOrder = useMemo(function () { var order = [], seen = {}; function add(s) { if (s && !seen[s]) { seen[s] = 1; order.push(s); } } boardCols.forEach(add); tasks.forEach(function (t) { add(t.status); }); if (!order.length) STATUS_ORDER.forEach(add); return order; }, [boardCols, tasks]);
    var settableStatuses = useMemo(function () { var base = boardCols.length ? boardCols.slice() : SETTABLE.slice(); return base.filter(function (s) { return s !== "archived"; }); }, [boardCols]);
    function statusOptionsFor(t) { var base = settableStatuses.slice(); if (t && t.status && base.indexOf(t.status) === -1) base.unshift(t.status); return base.map(function (st) { return { value: st, label: statusMeta(st).label, dot: statusMeta(st).dot }; }); }
    var taskById = useMemo(function () { var m = {}; tasks.forEach(function (t) { m[t.id] = t; }); return m; }, [tasks]);

    function treeFor(slug) { return byBoard[slug] || { lists: [], membership: {} }; }
    var activeLists = (treeFor(board).lists) || [];
    var activeMembership = (treeFor(board).membership) || {};
    var liveListIds = useMemo(function () { var m = {}; activeLists.forEach(function (l) { m[l.id] = 1; }); return m; }, [activeLists]);

    var assignees = (data && data.assignees) || [];
    var assigneeChoices = (asgOpts && asgOpts.length) ? asgOpts : assignees;
    var now = (data && data.now) || Math.floor(Date.now() / 1000);

    function boardTotal(slug) { var b = boards.filter(function (x) { return x.slug === slug; })[0]; return b && b.total != null ? b.total : null; }
    function listCount(slug, listId) { var mem = treeFor(slug).membership; var n = 0; for (var k in mem) if (mem[k] === listId) n++; return n; }
    function assignedCount(slug) { return Object.keys(treeFor(slug).membership).length; }

    // ---- detail -------------------------------------------------------------
    var loadDetail = useCallback(function (id, force) {
      if (!id || (!force && detail[id])) return;
      getJSON(KAPI + "/tasks/" + encodeURIComponent(id) + bq()).then(function (d) { setDetail(function (m) { var n = Object.assign({}, m); n[id] = d; return n; }); })
        .catch(function () { setDetail(function (m) { var n = Object.assign({}, m); n[id] = { _error: true }; return n; }); });
    }, [bq, detail]);
    useEffect(function () { if (modalId) { loadDetail(modalId, true); loadWorkerLog(modalId); } }, [modalId]); // eslint-disable-line
    useEffect(function () {
      if (!modalId) return; var t = taskById[modalId]; setTitleDraft(t ? (t.title || "") : ""); setDescEdit(false); setCommentDraft(""); setAddParentSel(""); setAddChildSel("");
      function onKey(e) { if (e.key === "Escape") { if (filePreviewRef.current) { if (filePreviewStackRef.current && filePreviewStackRef.current.length) backFilePreview(); else closeFilePreview(); } else setModalId(null); } }
      window.addEventListener("keydown", onKey); return function () { window.removeEventListener("keydown", onKey); };
    }, [modalId]); // eslint-disable-line

    // ---- task edits ---------------------------------------------------------
    var applyEdit = useCallback(function (t, body, label) {
      setNotice(null);
      return send("PATCH", KAPI + "/tasks/" + encodeURIComponent(t.id) + bq(), body).then(function () { loadDetail(t.id, true); load(true); if (body.assignee !== undefined) loadAssignees(); })
        .catch(function (e) { setNotice("Could not update \u201c" + (t.title || t.id) + "\u201d" + (label ? " (" + label + ")" : "") + ": " + ((e && e.message) || "not allowed") + "."); load(true); });
    }, [bq, load, loadDetail, loadAssignees]);
    function setStatus(t, v) { if (v !== t.status) applyEdit(t, { status: v }, "status"); }
    function setPriority(t, v) { var n = parseInt(v, 10); if (n !== (t.priority == null ? 0 : t.priority)) applyEdit(t, { priority: n }, "priority"); }
    function setAssignee(t, v) { if ((v || "") !== (t.assignee || "")) applyEdit(t, { assignee: v }, "assignee"); }
    function saveTitle(t) { var v = titleDraft.trim(); if (!v || v === (t.title || "")) return; applyEdit(t, { title: v }, "title"); }

    // ---- list / membership mutations ----------------------------------------
    function activate(slug, sc) { setBoard(slug); setScope(sc); setCollapsedBoards(function (n) { var x = Object.assign({}, n); x[slug] = false; return x; }); if (isNarrow) setSidebarOpen(false); }
    function setListColor(l, slug, color) { send("PATCH", TLAPI + "/lists/" + encodeURIComponent(l.id) + tlq(slug), { color: color }).then(function () { loadTreeFor(slug); }).catch(function () { loadTreeFor(slug); }); }
    function createList(name, slug) { name = (name || "").trim(); if (!name) return; var color = LIST_COLORS[Math.floor(Math.random() * LIST_COLORS.length)]; send("POST", TLAPI + "/lists" + tlq(slug), { name: name, color: color }).then(function (r) { setAdding(null); setAddName(""); loadTreeFor(slug); if (r && r.list) activate(slug, { type: "list", id: r.list.id }); }).catch(function (e) { setNotice("Could not create list: " + ((e && e.message) || "error")); }); }
    function renameNode() { if (!editing) return; var nm = editName.trim(); var cur = editing; setEditing(null); if (!nm) return; send("PATCH", TLAPI + "/lists/" + encodeURIComponent(cur.id) + tlq(cur.board), { name: nm }).then(function () { loadTreeFor(cur.board); }).catch(function () { loadTreeFor(cur.board); }); }
    function deleteList(l, slug) { setConfirmDelList(null); send("DELETE", TLAPI + "/lists/" + encodeURIComponent(l.id) + tlq(slug), null).then(function () { if (scope.type === "list" && scope.id === l.id) setScope({ type: "all" }); loadTreeFor(slug); }).catch(function () { loadTreeFor(slug); }); }
    function moveToList(taskId, listId) { if (!taskId) return; var ids = [taskId].concat(descendantsOf(taskId)); setNotice(null); var chain = Promise.resolve(); ids.forEach(function (tid) { chain = chain.then(function () { return send("PUT", TLAPI + "/membership" + tlq(board), { task_id: tid, list_id: listId || null }); }); }); chain.then(function () { loadTreeFor(board); }).catch(function (e) { setNotice("Could not move task: " + ((e && e.message) || "error")); loadTreeFor(board); }); }
    function addTask(listId, status, title) {
      title = (title || "").trim(); if (!title) return; setNotice(null);
      send("POST", KAPI + "/tasks" + bq(), { title: title, triage: status === "triage" }).then(function (r) {
        var id = r && r.task && r.task.id; var p = Promise.resolve();
        if (id && listId) p = send("PUT", TLAPI + "/membership" + tlq(board), { task_id: id, list_id: listId });
        if (id && status && status !== "triage" && settableStatuses.indexOf(status) !== -1) p = p.then(function () { return send("PATCH", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), { status: status }); });
        return p;
      }).then(function () { setAddTaskTitle(""); load(true); loadTreeFor(board); }).catch(function (e) { setNotice("Could not add task: " + ((e && e.message) || "error")); load(true); loadTreeFor(board); });
    }

    function createListReturning(name, slug) {
      name = (name || "").trim(); if (!name) return Promise.resolve(null);
      var color = LIST_COLORS[Math.floor(Math.random() * LIST_COLORS.length)];
      return send("POST", TLAPI + "/lists" + tlq(slug), { name: name, color: color }).then(function (r) { loadTreeFor(slug); return (r && r.list && r.list.id) || null; });
    }
    function openCreate() {
      setNotice(null);
      var init = { title: "", status: (settableStatuses.indexOf("todo") !== -1 ? "todo" : (settableStatuses[0] || "todo")), priority: "1", assignee: "", list_id: (scope && scope.type === "list") ? scope.id : "", body: "", files: [] };
      draftInit.current = JSON.stringify(init);
      setDraft(init); setConfirmClose(false); setCreating(true);
    }
    function closeCreate() { setCreating(false); setDraft(null); setSavingNew(false); setConfirmClose(false); }
    function requestClose() {
      if (savingNew) return;
      var dirty = !!(draft && draftInit.current && JSON.stringify(draft) !== draftInit.current);
      if (dirty) setConfirmClose(true); else closeCreate();
    }
    function submitCreate() {
      if (!draft || savingNew) return;
      var title = (draft.title || "").trim();
      if (!title) { setNotice("Please enter a title for the task."); return; }
      setSavingNew(true); setNotice(null);
      var d = draft;
      var tp = KAPI + "/tasks/";
      send("POST", KAPI + "/tasks" + bq(), { title: title, triage: false }).then(function (r) {
        var id = (r && ((r.task && r.task.id) || r.id || r.task_id || r.taskId)) || null;
        if (!id) return; // task created but id not in response shape -> still close+reload below
        var chain = Promise.resolve();
        if (d.status && d.status !== "triage" && settableStatuses.indexOf(d.status) !== -1) chain = chain.then(function () { return send("PATCH", tp + encodeURIComponent(id) + bq(), { status: d.status }); }).catch(function () {});
        var pr = parseInt(d.priority, 10); if (!isNaN(pr)) chain = chain.then(function () { return send("PATCH", tp + encodeURIComponent(id) + bq(), { priority: pr }); }).catch(function () {});
        if (d.assignee) chain = chain.then(function () { return send("PATCH", tp + encodeURIComponent(id) + bq(), { assignee: d.assignee }); }).catch(function () {});
        if (d.body && d.body.trim()) chain = chain.then(function () { return send("PATCH", tp + encodeURIComponent(id) + bq(), { body: d.body }); }).catch(function () {});
        if (d.list_id) chain = chain.then(function () { return send("PUT", TLAPI + "/membership" + tlq(board), { task_id: id, list_id: d.list_id }); }).catch(function () {});
        if (d.files && d.files.length) { d.files.forEach(function (f) { chain = chain.then(function () { var fd = new FormData(); fd.append("file", f); return authFetch(KAPI + "/tasks/" + encodeURIComponent(id) + "/attachments" + bq(), { method: "POST", body: fd }); }).catch(function () {}); }); }
        return chain;
      }).then(function () {
        closeCreate(); load(true); loadTreeFor(board); loadAssignees();
      }).catch(function (e) { setSavingNew(false); setNotice("Could not create task: " + ((e && e.message) || "error")); });
    }

    // ---- detail-popup mutations (parity with the native kanban drawer) ------
    function reloadTask(id) { loadDetail(id, true); load(true); }
    function parseRead(dispPath, r) {
      var du = r && r.data_url; var mime = (r && r.mime_type) || ""; var text = null;
      var isText = /^text\//.test(mime) || /(json|markdown|xml|yaml|x-yaml|javascript|typescript|csv|x-sh|x-python|toml)/i.test(mime) || /\.(md|markdown|txt|log|json|ya?ml|csv|tsv|py|js|jsx|ts|tsx|sh|bash|zsh|toml|ini|cfg|conf|env|html?|css|scss|sql|go|rs|rb|java|c|cpp|h|xml)$/i.test((r && r.name) || dispPath);
      if (du && isText) { var b64 = String(du).split(",")[1] || ""; try { text = decodeURIComponent(escape(atob(b64))); } catch (e) { try { text = atob(b64); } catch (_) { text = null; } } }
      return { name: r && r.name, mime: mime, size: r && r.size, dataUrl: du, text: text };
    }
    function filesGet(pq) { var tok = (typeof window !== "undefined" && window.__HERMES_SESSION_TOKEN__) || ""; var opts = tok ? { headers: { "Authorization": "Bearer " + tok } } : {}; return authFetch(pq, opts).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
    function readFile(p) { return filesGet("/api/files/read?path=" + encodeURIComponent(p)); }
    function listDir(rel) { return filesGet("/api/files" + (rel ? ("?path=" + encodeURIComponent(rel)) : "")).catch(function () { return null; }); }
    // Agents often write paths relative to their working dir (prefix missing).
    // Walk the managed file tree and find the file whose path ends with the given relative path.
    function resolveFilePath(relRaw) {
      var rel = String(relRaw).replace(/^\/+/, "");
      if (rel in resolveCacheRef.current) return Promise.resolve(resolveCacheRef.current[rel]);
      var segs = rel.split("/");
      var base = segs[segs.length - 1];
      var firstDir = segs.length > 1 ? segs[0] : null;          // first directory segment of the target
      var restAfterFirst = segs.slice(1).join("/");             // rel without its first segment
      var relDirSet = {}; segs.slice(0, -1).forEach(function (s) { relDirSet[s] = 1; }); // target's directory segments
      var SKIP = { "node_modules": 1, ".git": 1, "__pycache__": 1, "site-packages": 1, ".venv": 1, "venv": 1, ".cache": 1, ".npm": 1, ".mypy_cache": 1, "dist": 1, ".next": 1, "build": 1 };
      var rootPath = null, listings = 0, MAX = 600, MAX_DEPTH = 14;
      var lastDir = segs.length >= 2 ? segs[segs.length - 2] : null;
      var pq = [], nq = [], seen = { "": 1 }; nq.push({ d: "", depth: 0 });
      var basenameHits = [], directTried = {};
      function relOf(e) { if (rootPath && e.path && e.path.indexOf(rootPath) === 0) return e.path.slice(rootPath.length).replace(/^\/+/, ""); return e.name; }
      function enqueue(d, depth) { if (seen[d]) return; seen[d] = 1; var nm = d.split("/").pop(); (relDirSet[nm] ? pq : nq).push({ d: d, depth: depth }); }
      function tryDirect(candidate) { if (directTried[candidate]) return Promise.resolve(null); directTried[candidate] = 1; return readFile(candidate).then(function () { return candidate; }).catch(function () { return null; }); }
      function loop() {
        if ((!pq.length && !nq.length) || listings >= MAX) return Promise.resolve(null);
        var wave = [];
        while ((pq.length || nq.length) && wave.length < 24 && listings < MAX) { wave.push(pq.length ? pq.shift() : nq.shift()); listings++; }
        return Promise.all(wave.map(function (item) {
          return listDir(item.d).then(function (r) {
            if (!r) return null;
            if (rootPath == null && r.root) rootPath = r.root;
            var found = null, cands = [];
            (r.entries || []).forEach(function (e) {
              var rr = relOf(e);
              if (e.is_directory) {
                if (firstDir && e.name === firstDir) cands.push(restAfterFirst ? (rr + "/" + restAfterFirst) : rr); // spotted the target's first dir -> read full candidate directly
                if (item.depth < MAX_DEPTH && !SKIP[e.name]) enqueue(rr, item.depth + 1);
              } else if (e.name === base) {
                if (rr === rel || (rr.length > rel.length && rr.slice(-(rel.length + 1)) === "/" + rel)) found = rr;                          // full relative-path suffix match
                else if (lastDir) { var tail = lastDir + "/" + base; if (rr === tail || (rr.length > tail.length && rr.slice(-(tail.length + 1)) === "/" + tail)) found = rr; else basenameHits.push(rr); } // strong: parent-dir + name match
                else basenameHits.push(rr);
              }
            });
            if (found) return found;
            if (cands.length) return Promise.all(cands.map(tryDirect)).then(function (rs) { return rs.filter(Boolean)[0] || null; });
            return null;
          });
        })).then(function (results) { var hit = results.filter(Boolean)[0]; return hit ? hit : loop(); });
      }
      return loop().then(function (hit) {
        var pick = hit;
        if (!pick && basenameHits.length) {
          if (basenameHits.length === 1) pick = basenameHits[0];
          else { var lastDir = segs.slice(-2)[0]; var better = basenameHits.filter(function (p) { return lastDir && p.indexOf("/" + lastDir + "/") !== -1; }); if (better.length === 1) pick = better[0]; }
        }
        resolveCacheRef.current[rel] = pick || false;
        return pick || false;
      });
    }
    function loadFilePreview(path) {
      var clean = String(path).replace(/^\/+/, "");
      setPreviewRaw(false);
      setFilePreview({ path: path, loading: true });
      readFile(clean).then(function (r) {
        setFilePreview(Object.assign({ path: clean, loading: false }, parseRead(clean, r)));
      }).catch(function () {
        setFilePreview({ path: path, loading: true, searching: true });
        resolveFilePath(clean).then(function (resolved) {
          if (resolved && resolved !== clean) {
            readFile(resolved).then(function (r) {
              setFilePreview(Object.assign({ path: resolved, orig: path, loading: false }, parseRead(resolved, r)));
            }).catch(function (e) { setFilePreview({ path: path, loading: false, err: (e && e.message) || "not found" }); });
          } else { setFilePreview({ path: path, loading: false, err: "not found", searchedNoMatch: true }); }
        }).catch(function () { setFilePreview({ path: path, loading: false, err: "not found" }); });
      });
    }
    function openFilePreview(path) { setFilePreviewStack([]); loadFilePreview(path); }
    function navFilePreview(path) { var cur = filePreviewRef.current; if (cur) setFilePreviewStack(function (st) { return st.concat([cur]); }); loadFilePreview(path); }
    function backFilePreview() { var st = filePreviewStackRef.current || []; if (!st.length) { setFilePreview(null); return; } var prev = st[st.length - 1]; setFilePreviewStack(st.slice(0, -1)); setPreviewRaw(false); setFilePreview(prev); }
    function closeFilePreview() { setFilePreview(null); setFilePreviewStack([]); }
    useEffect(function () {
      getJSON("/api/dashboard/plugins").then(function (list) {
        if (!Array.isArray(list)) return;
        var ex = list.filter(function (p) { return p && (p.name === "fileexplorer" || p.label === "Better Hermes File Explorer"); })[0];
        if (ex) { setExplorerInstalled(true); if (ex.tab && ex.tab.path) setExplorerTab(ex.tab.path); }
      }).catch(function () {});
    }, []); // eslint-disable-line
    function explorerHref(p) { var base = (typeof window !== "undefined" && window.__HERMES_BASE_PATH__) || ""; var clean = String(p).replace(/^\/+/, ""); return base + (explorerTabRef.current || "/file-explorer") + (isFilePath(clean) ? "?file=" : "?path=") + encodeURIComponent(clean); }
    function resolveFolderPath(relRaw) {
      var rel = String(relRaw).replace(/^\/+/, "");
      if (rel in folderCacheRef.current) return Promise.resolve(folderCacheRef.current[rel]);
      var segs = rel.split("/"); var firstDir = segs[0]; var restAfterFirst = segs.slice(1).join("/");
      var relDirSet = {}; segs.forEach(function (x) { relDirSet[x] = 1; });
      var SK = { "node_modules": 1, ".git": 1, "__pycache__": 1, "site-packages": 1, ".venv": 1, "venv": 1, ".cache": 1, ".npm": 1, ".mypy_cache": 1, "dist": 1, ".next": 1, "build": 1 };
      var rootPath = null, listings = 0, MAX = 600, MAX_DEPTH = 14;
      var pq = [], nq = [], seen = { "": 1 }; nq.push({ d: "", depth: 0 });
      var directTried = {};
      function relOf(e) { if (rootPath && e.path && e.path.indexOf(rootPath) === 0) return e.path.slice(rootPath.length).replace(/^\/+/, ""); return e.name; }
      function enqueue(d, depth) { if (seen[d]) return; seen[d] = 1; var nm = d.split("/").pop(); (relDirSet[nm] ? pq : nq).push({ d: d, depth: depth }); }
      function tryDirect(c) { if (directTried[c]) return Promise.resolve(null); directTried[c] = 1; return listDir(c).then(function () { return c; }).catch(function () { return null; }); }
      function loop() {
        if ((!pq.length && !nq.length) || listings >= MAX) return Promise.resolve(null);
        var wave = []; while ((pq.length || nq.length) && wave.length < 24 && listings < MAX) { wave.push(pq.length ? pq.shift() : nq.shift()); listings++; }
        return Promise.all(wave.map(function (item) {
          return listDir(item.d).catch(function () { return null; }).then(function (r) {
            if (!r) return null; if (rootPath == null && r.root) rootPath = r.root;
            var found = null, cands = [];
            (r.entries || []).forEach(function (e) {
              if (!e.is_directory) return; var rr = relOf(e);
              if (rr === rel || (rr.length > rel.length && rr.slice(-(rel.length + 1)) === "/" + rel)) found = rr;
              if (firstDir && e.name === firstDir) cands.push(restAfterFirst ? (rr + "/" + restAfterFirst) : rr);
              if (item.depth < MAX_DEPTH && !SK[e.name]) enqueue(rr, item.depth + 1);
            });
            if (found) return found;
            if (cands.length) return Promise.all(cands.map(tryDirect)).then(function (rs) { return rs.filter(Boolean)[0] || null; });
            return null;
          });
        })).then(function (results) { var hit = results.filter(Boolean)[0]; return hit ? hit : loop(); });
      }
      return loop().then(function (hit) { folderCacheRef.current[rel] = hit || false; return hit || false; });
    }
    function serialSearch(fn) { var pr = searchChainRef.current.then(fn, fn); searchChainRef.current = pr.catch(function () {}); return pr; }
    function validatePath(cand, isFile) {
      var clean = String(cand).replace(/^\/+/, "");
      function search() { return serialSearch(function () { return resolveFilePath(clean); }).then(function (res) { return res ? { valid: true, resolved: res } : { valid: false }; }); }
      function searchDir() { return serialSearch(function () { return resolveFolderPath(clean); }).then(function (res) { return res ? { valid: true, resolved: res } : { valid: false }; }); }
      if (isFile) {
        var parts = clean.split("/"); var b = parts.pop(); var parent = parts.join("/");
        return listDir(parent).then(function (r) {
          if (r && r.entries) { if (r.entries.some(function (e) { return !e.is_directory && e.name === b; })) return { valid: true, resolved: clean }; return search(); }
          return readFile(clean).then(function () { return { valid: true, resolved: clean }; }).catch(search); // parent listing unavailable -> direct read, then search
        });
      }
      var fparts = clean.split("/"); var fb = fparts.pop(); var fparent = fparts.join("/");
      return listDir(fparent).then(function (r) {
        if (r && r.entries) { if (r.entries.some(function (e) { return e.is_directory && e.name === fb; })) return { valid: true, resolved: clean }; return searchDir(); }
        return searchDir();
      });
    }
    function makePathHandler(navMode) {
      var installed = explorerRef.current;
      var fn = function (p) { var t = fn.resolvedOf(p); if (installed) { try { window.open(explorerHref(t), "_blank", "noopener"); } catch (e) { window.location.href = explorerHref(t); } } else if (isFilePath(t)) { if (navMode) navFilePreview(t); else openFilePreview(t); } };
      fn.folders = installed;
      fn.known = function (cand) { var e = pathValidRef.current[cand]; return e ? e.state : undefined; };
      fn.ensure = function (cand, isF, silent) { if (!cacheReadyRef.current) return; if (pathValidRef.current[cand]) return; pathValidRef.current[cand] = { state: "pending" }; validatePath(cand, isF).then(function (res) { var rec = res.valid ? { state: "valid", resolved: res.resolved } : { state: "invalid" }; pathValidRef.current[cand] = rec; if (backendRef.current) pcRemotePut(cand, rec).catch(function () { }); else fxSaveCache(cand, rec); if (!silent) setPathV(function (v) { return v + 1; }); }).catch(function () { var rec = { state: "invalid" }; pathValidRef.current[cand] = rec; if (backendRef.current) pcRemotePut(cand, rec).catch(function () { }); else fxSaveCache(cand, rec); if (!silent) setPathV(function (v) { return v + 1; }); }); };
      fn.resolvedOf = function (cand) { var e = pathValidRef.current[cand]; return (e && e.resolved) || cand; };
      fn.hrefFor = function (p) { var t = fn.resolvedOf(p); return installed ? explorerHref(t) : (isFilePath(t) ? filesDownloadHref(t) : "#"); };
      return fn;
    }
    function archiveTask(id, toStatus) {
      if (!id) return;
      setNotice(null);
      send("PATCH", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), { status: toStatus })
        .then(function () { setModalId(null); load(true); loadTreeFor(board); })
        .catch(function (e) { setNotice((toStatus === "archived" ? "Could not archive: " : "Could not unarchive: ") + ((e && e.message) || "error")); });
    }
    function deleteTask(id) {
      if (!id) return;
      setNotice(null);
      send("DELETE", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), null)
        .then(function () { return send("PUT", TLAPI + "/membership" + tlq(board), { task_id: id, list_id: null }).catch(function () {}); })
        .then(function () { setConfirmDel(null); setModalId(null); load(true); loadTreeFor(board); })
        .catch(function (e) { setConfirmDel(null); setNotice("Delete failed: " + ((e && e.message) || "error")); });
    }
    function addComment(id) { var b = commentDraft.trim(); if (!b) return; setNotice(null); send("POST", KAPI + "/tasks/" + encodeURIComponent(id) + "/comments" + bq(), { body: b }).then(function () { setCommentDraft(""); reloadTask(id); }).catch(function (e) { setNotice("Could not add comment: " + ((e && e.message) || "error")); }); }
    function saveDesc(id) { setNotice(null); send("PATCH", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), { body: descDraft }).then(function () { setDescEdit(false); reloadTask(id); }).catch(function (e) { setNotice("Could not save description: " + ((e && e.message) || "error")); }); }
    function addLink(parent, child) { setNotice(null); send("POST", KAPI + "/links" + bq(), { parent_id: parent, child_id: child }).then(function () { setAddParentSel(""); setAddChildSel(""); loadDetail(child, true); loadDetail(parent, true); load(true); loadEdges(); }).catch(function (e) { setNotice("Could not link tasks: " + ((e && e.message) || "error")); }); }
    function removeLink(parent, child) { setNotice(null); var q = bq(); q += (q ? "&" : "?") + "parent_id=" + encodeURIComponent(parent) + "&child_id=" + encodeURIComponent(child); send("DELETE", KAPI + "/links" + q, null).then(function () { loadDetail(parent, true); loadDetail(child, true); load(true); loadEdges(); }).catch(function () { loadDetail(modalId, true); loadEdges(); }); }
    function uploadAttachment(id, file) { if (!file) return; var fd = new FormData(); fd.append("file", file); setNotice(null); authFetch(KAPI + "/tasks/" + encodeURIComponent(id) + "/attachments" + bq(), { method: "POST", body: fd }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function () { reloadTask(id); }).catch(function (e) { setNotice("Upload failed: " + ((e && e.message) || "error")); }); }
    function downloadAttachment(a) { setNotice(null); authFetch(KAPI + "/attachments/" + encodeURIComponent(a.id) + bq()).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); }).then(function (b) { var u = URL.createObjectURL(b); var el = document.createElement("a"); el.href = u; el.download = a.filename || String(a.id); document.body.appendChild(el); el.click(); el.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1500); }).catch(function (e) { setNotice("Download failed: " + ((e && e.message) || "error")); }); }
    function deleteAttachment(attId, id) { setNotice(null); send("DELETE", KAPI + "/attachments/" + encodeURIComponent(attId) + bq(), null).then(function () { reloadTask(id); }).catch(function () { reloadTask(id); }); }
    function loadWorkerLog(id) { setWorkerLog(function (m) { var n = Object.assign({}, m); n[id] = { loading: true }; return n; }); getJSON(KAPI + "/tasks/" + encodeURIComponent(id) + "/log" + bq()).then(function (r) { setWorkerLog(function (m) { var n = Object.assign({}, m); n[id] = { content: (r && r.content) || "", loaded: true }; return n; }); }).catch(function () { setWorkerLog(function (m) { var n = Object.assign({}, m); n[id] = { content: "", loaded: true, error: true }; return n; }); }); }

    // ---- scope --------------------------------------------------------------
    function inScope(t) { var lid = activeMembership[t.id]; var inAny = lid && liveListIds[lid]; if (scope.type === "unassigned") return !inAny; if (scope.type === "list") return lid === scope.id; return true; }
    var scopeTitle = useMemo(function () {
      if (scope.type === "unassigned") return "No list";
      if (scope.type === "list") { var l = activeLists.filter(function (x) { return x.id === scope.id; })[0]; return l ? l.name : "List"; }
      return "All tasks";
    }, [scope, activeLists]);

    var scopeTasks = useMemo(function () {
      var q = search.trim().toLowerCase();
      return tasks.filter(function (t) {
        if (!inScope(t)) return false;
        if (fAssignee && (t.assignee || "") !== fAssignee) return false;
        if (q) { var hay = ((t.title || "") + " " + (t.id || "") + " " + (t.body || "")).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
        return true;
      });
    }, [tasks, scope, activeMembership, liveListIds, search, fAssignee]);

    // ---- subtask nesting helpers --------------------------------------------
    function hasKids(t) { var c = edges.children[t.id]; if (c) { for (var i = 0; i < c.length; i++) if (taskById[c[i]]) return true; } if (t.link_counts && t.link_counts.children > 0) return true; if (t.progress && t.progress.total > 0) return true; return false; }
    function childCount(t) { var n = (t.link_counts && typeof t.link_counts.children === "number") ? t.link_counts.children : 0; var e = edges.children[t.id]; if (e && e.length > n) n = e.length; return n; }
    function kidBadge(t) { var n = childCount(t); if (!n) return null; return h("span", { title: n + (n === 1 ? " subtask" : " subtasks"), style: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: muted, flex: "0 0 auto" } }, SubtaskIcon(12), n); }
    function childrenOf(t) { var c = edges.children[t.id] || []; var out = []; c.forEach(function (cid) { var ct = taskById[cid]; if (ct) out.push(ct); }); out.sort(function (a, b) { var ap = a.priority == null ? 0 : a.priority, bp = b.priority == null ? 0 : b.priority; if (ap !== bp) return bp - ap; return (a.created_at || 0) - (b.created_at || 0); }); return out; }
    // belt-and-braces: if the global links read missed this parent, fetch its
    // child ids from the kanban task detail and merge them into edges
    function ensureChildEdges(tid) {
      if (edges.children[tid] && edges.children[tid].length) return;
      getJSON(KAPI + "/tasks/" + encodeURIComponent(tid) + bq()).then(function (dd) {
        var kids = (dd && dd.links && dd.links.children) || [];
        if (!kids.length) return;
        setEdges(function (e) {
          var ch = Object.assign({}, e.children); var pa = Object.assign({}, e.parents);
          ch[tid] = kids.slice();
          kids.forEach(function (cid) { var arr = (pa[cid] || []).slice(); if (arr.indexOf(tid) === -1) arr.push(tid); pa[cid] = arr; });
          return { children: ch, parents: pa };
        });
      }).catch(function () {});
    }
    function descendantsOf(rootId) { var out = []; var seen = {}; var stack = (edges.children[rootId] || []).slice(); while (stack.length) { var c = stack.pop(); if (seen[c]) continue; seen[c] = 1; out.push(c); var g = edges.children[c] || []; for (var i = 0; i < g.length; i++) stack.push(g[i]); } return out; }

    // ---- sections -----------------------------------------------------------
    var sections = useMemo(function () {
      var dir = sortDir === "asc" ? 1 : -1;
      function cmp(a, b) { var av, bv; if (sortBy === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); } else if (sortBy === "created") { av = a.created_at || 0; bv = b.created_at || 0; } else { av = a.priority == null ? 0 : a.priority; bv = b.priority == null ? 0 : b.priority; } if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0; }
      // hide tasks that are a child of another task currently in view (they
      // nest under that parent instead of appearing at top level)
      var idset = {}; scopeTasks.forEach(function (t) { idset[t.id] = 1; });
      var top = scopeTasks.filter(function (t) { var ps = edges.parents[t.id]; if (!ps) return true; for (var i = 0; i < ps.length; i++) if (idset[ps[i]]) return false; return true; });
      if (groupBy === "status") {
        var cols = liveStatusOrder.filter(function (c) { return c !== "archived" || showArchived; });
        var byCol = {}; top.forEach(function (t) { (byCol[t.status] || (byCol[t.status] = [])).push(t); });
        var out = [];
        cols.forEach(function (c) { var items = (byCol[c] || []).slice().sort(cmp); if (items.length || c === "todo") { var m = statusMeta(c); out.push({ key: c, label: m.label, dot: m.dot, items: items, status: c }); } });
        return out;
      }
      function keyOf(t) { if (groupBy === "assignee") return t.assignee || "\u0000Unassigned"; if (groupBy === "priority") return "p:" + (t.priority == null ? 0 : t.priority); return "\u0000All"; }
      var map = {}; top.forEach(function (t) { var k = keyOf(t); (map[k] || (map[k] = [])).push(t); });
      var keys = Object.keys(map);
      if (groupBy === "priority") keys.sort(function (a, b) { return parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10); });
      else keys.sort(function (a, b) { var ae = a.charCodeAt(0) === 0, be = b.charCodeAt(0) === 0; if (ae !== be) return ae ? 1 : -1; return a.localeCompare(b); });
      return keys.map(function (k) { var label, dot; if (groupBy === "priority") { var pb = priorityBucket(parseInt(k.slice(2), 10)); label = pb.label + " (P" + k.slice(2) + ")"; dot = pb.color; } else if (k.charCodeAt(0) === 0) { label = k.slice(1); dot = "#52525b"; } else { label = k; dot = "#64748b"; } return { key: k, label: label, dot: dot, items: map[k].slice().sort(cmp), status: null }; });
    }, [scopeTasks, groupBy, sortBy, sortDir, showArchived, edges]);

    // ======================== SIDEBAR =======================================
    function addInput(placeholder, onSubmit) {
      return h("input", { autoFocus: true, value: addName, placeholder: placeholder, onChange: function (e) { setAddName(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") onSubmit(addName); if (e.key === "Escape") { setAdding(null); setAddName(""); } }, onBlur: function () { if (addName.trim()) onSubmit(addName); else { setAdding(null); setAddName(""); } }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "4px 7px", fontSize: 12.5 } });
    }
    function entryRow(o) {
      var isOver = o.dropKey && dropList === o.dropKey;
      var p = {
        onClick: o.onClick,
        style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", paddingLeft: (o.indent || 8) + "px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, background: o.active ? accent + "26" : (isOver ? accent + "33" : "transparent"), outline: isOver ? "1px dashed " + accent : "none" },
        onMouseEnter: function (e) { if (!o.active) e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { if (!o.active) e.currentTarget.style.background = isOver ? accent + "33" : "transparent"; }
      };
      if (o.dropKey) {
        p.onDragOver = function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (x) {} if (dropList !== o.dropKey) setDropList(o.dropKey); };
        p.onDragLeave = function (e) { if (e.currentTarget === e.target) setDropList(null); };
        p.onDrop = function (e) { e.preventDefault(); var id = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || dragRef.current; setDropList(null); setDragId(null); if (o.onDrop) o.onDrop(id); };
      }
      return h("div", p,
        o.dot != null ? Dot(o.dot, 9) : null,
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: o.active ? 600 : 400 } }, o.label),
        (o.count != null ? h("span", { style: { fontSize: 11, color: muted } }, o.count) : null),
        o.trailing || null
      );
    }
    function listEntry(l, slug) {
      if (editing && editing.id === l.id) {
        return h("div", { key: l.id, style: { padding: "4px 8px 7px 30px", display: "flex", flexDirection: "column", gap: 7 } },
          h("input", { autoFocus: true, value: editName, onChange: function (e) { setEditName(e.target.value); }, onBlur: renameNode, onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }, className: "font-courier", style: { width: "100%", boxSizing: "border-box", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "3px 6px", fontSize: 12.5 } }),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } },
            LIST_COLORS.map(function (c) {
              var on = String(l.color || "").toLowerCase() === c.toLowerCase();
              return h("span", { key: c, title: c, onMouseDown: function (e) { e.preventDefault(); }, onClick: function (e) { e.stopPropagation(); setListColor(l, slug, c); }, style: { width: 16, height: 16, borderRadius: "50%", background: c, cursor: "pointer", flex: "0 0 auto", boxShadow: on ? ("0 0 0 2px var(--background, #111), 0 0 0 4px " + c) : "none", border: on ? "none" : "1px solid rgba(255,255,255,.25)" } });
            })));
      }
      var btnStyle = { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex", flex: "0 0 auto" };
      var trailing = h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto" } },
        h("button", { onClick: function (e) { e.stopPropagation(); setEditing({ id: l.id, board: slug }); setEditName(l.name); }, title: "Rename list", style: btnStyle }, PencilIcon(12)),
        h("button", { onClick: function (e) { e.stopPropagation(); setConfirmDelList({ l: l, slug: slug }); }, title: "Delete list", style: btnStyle }, XIcon(13))
      );
      return h("div", { key: l.id },
        entryRow({
          label: l.name, dot: l.color || "#64748b", active: board === slug && scope.type === "list" && scope.id === l.id, count: listCount(slug, l.id), indent: 30,
          onClick: function () { if (editing) { return; } activate(slug, { type: "list", id: l.id }); },
          dropKey: slug === board ? l.id : null, onDrop: function (id) { moveToList(id, l.id); },
          trailing: trailing
        }));
    }
    function boardBlock(b) {
      var slug = b.slug;
      var open = collapsedBoards[slug] === undefined ? (slug === board) : !collapsedBoards[slug];
      var tree = treeFor(slug);
      var total = boardTotal(slug);
      var header = h("div", {
        onClick: function () { activate(slug, { type: "all" }); },
        style: { display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, fontWeight: 600, background: board === slug ? accent + "18" : "transparent" },
        onMouseEnter: function (e) { if (board !== slug) e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { if (board !== slug) e.currentTarget.style.background = "transparent"; }
      },
        h("span", { onClick: function (e) { e.stopPropagation(); setCollapsedBoards(function (n) { var x = Object.assign({}, n); x[slug] = open; return x; }); }, style: { display: "inline-flex", color: muted, cursor: "pointer" } }, Caret(open, 12)),
        h("span", { style: { display: "inline-flex", color: muted } }, BoardIcon()),
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.label || b.name || slug),
        h("span", { style: { fontSize: 11, color: muted, fontWeight: 400 } }, total != null ? total : ""),
        h("button", { onClick: function (e) { e.stopPropagation(); activate(slug, scope); setAdding({ board: slug }); setAddName(""); }, title: "Add list to this board", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex" } }, PlusIcon(13))
      );
      var children = open ? h("div", { style: { marginBottom: 2 } },
        entryRow({ label: "All tasks", dot: null, active: board === slug && scope.type === "all", count: total, indent: 26, onClick: function () { activate(slug, { type: "all" }); } }),
        entryRow({ label: "No list", dot: "#52525b", active: board === slug && scope.type === "unassigned", count: total != null ? Math.max(0, total - assignedCount(slug)) : null, indent: 26, onClick: function () { activate(slug, { type: "unassigned" }); }, dropKey: slug === board ? "__none" : null, onDrop: function (id) { moveToList(id, null); } }),
        tree.lists.map(function (l) { return listEntry(l, slug); }),
        adding && adding.board === slug ? h("div", { style: { padding: "2px 8px 2px 30px" } }, addInput("List name\u2026", function (v) { createList(v, slug); })) : null
      ) : null;
      return h("div", { key: slug, style: { marginBottom: 2 } }, header, children);
    }
    var sidebar = h("div", { style: isNarrow
        ? { width: "100%", flex: "none", borderBottom: "1px solid " + borderC, paddingBottom: 8, marginBottom: 12, alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 2, maxHeight: "42vh", overflow: "auto" }
        : { width: 240, flex: "0 0 240px", borderRight: "1px solid " + borderC, paddingRight: 10, marginRight: 14, alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 2, maxHeight: "calc(100vh - 120px)", overflow: "auto", position: "sticky", top: 0 } },
      h("div", { style: { padding: "2px 8px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 700 } }, "Boards"),
      boards.length ? boards.map(function (b) { return boardBlock(b); }) : h("div", { style: { padding: "8px", fontSize: 11.5, color: muted } }, "No boards found."),
      h("div", { style: { padding: "8px 8px 0", fontSize: 11, color: muted, lineHeight: 1.5 } }, "New boards are created in the ", h("b", null, "Kanban"), " tab. Open a board and click ", h("b", null, "+"), " to add a list, then drag tasks onto it or use the List dropdown.")
    );

    // ======================== MAIN ==========================================
    function plainSelect(value, onChange, options, aria) { return h(DotSelect, { value: value, options: options, onChange: onChange, opts: {} }); }
    var toolbar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 } },
      h("span", { style: { fontSize: 11, color: muted } }, "Group"),
      plainSelect(groupBy, setGroupBy, [{ value: "status", label: "Status" }, { value: "assignee", label: "Assignee" }, { value: "priority", label: "Priority" }, { value: "none", label: "None" }], "Group by"),
      h("span", { style: { fontSize: 11, color: muted } }, "Sort"),
      plainSelect(sortBy, setSortBy, [{ value: "priority", label: "Priority" }, { value: "created", label: "Created" }, { value: "title", label: "Title" }], "Sort by"),
      h("button", { onClick: function () { setSortDir(sortDir === "asc" ? "desc" : "asc"); }, title: "Sort direction", className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 9px", fontSize: 12, cursor: "pointer" } }, sortDir === "asc" ? "\u2191" : "\u2193"),
      h("input", { value: search, placeholder: "Search\u2026", onChange: function (e) { setSearch(e.target.value); }, className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, minWidth: 140, flex: "1 1 140px" } }),
      assigneeChoices.length ? plainSelect(fAssignee, setFAssignee, [{ value: "", label: "All assignees" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Filter assignee") : null,
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted, cursor: "pointer" } }, h("input", { type: "checkbox", checked: showArchived, onChange: function (e) { setShowArchived(e.target.checked); } }), "Archived")
    );

    function badge(text, color) { return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, lineHeight: 1, padding: "3px 7px", borderRadius: 999, border: "1px solid " + borderC, whiteSpace: "nowrap" } }, color ? Dot(color, 7) : null, text); }
    var listOpts = [{ value: "", label: "No list" }].concat(activeLists.map(function (x) { return { value: x.id, label: x.name }; }));

    function taskRow(t, depth) {
      depth = depth || 0;
      var pri = priorityBucket(t.priority); var prog = t.progress;
      var kids = hasKids(t);
      var expanded = !!expandedTasks[t.id];
      var disc = kids
        ? h("span", { onClick: function (e) { e.stopPropagation(); var willOpen = !expandedTasks[t.id]; setExpandedTasks(function (n) { var x = Object.assign({}, n); x[t.id] = !x[t.id]; return x; }); if (willOpen) ensureChildEdges(t.id); }, title: expanded ? "Collapse subtasks" : "Expand subtasks", style: { display: "inline-flex", alignItems: "center", justifyContent: "center", color: muted, cursor: "pointer", flex: "0 0 auto", boxSizing: "content-box", padding: 9, margin: -9 } }, Caret(expanded, 12))
        : h("span", { style: { display: "inline-block", width: 12, flex: "0 0 auto" } });
      if (isCompact) {
        return h("div", {
          key: t.id, onClick: function () { setModalId(t.id); },
          style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px", paddingLeft: (14 + depth * 16) + "px", borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 13 }
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
            disc,
            Dot(pri.color, 8),
            h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 } }, t.title || "(untitled)"),
            kidBadge(t),
            prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
            (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null)
          ),
          h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, paddingLeft: 20 } },
            h(DotSelect, { value: t.status, options: statusOptionsFor(t), onChange: function (v) { setStatus(t, v); }, opts: { small: true, pill: true } }),
            h(DotSelect, { value: String(t.priority == null ? 0 : t.priority), options: prioOptions(t).map(function (o) { var n = parseInt(o.value, 10); return { value: o.value, label: o.label, dot: priorityBucket(isNaN(n) ? 0 : n).color }; }), onChange: function (v) { setPriority(t, v); }, opts: { small: true, pill: true } }),
            h(DotSelect, { value: t.assignee || "", options: [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), onChange: function (v) { setAssignee(t, v); }, opts: { small: true, pill: true, maxWidth: "150px" } }),
            h(DotSelect, { value: activeMembership[t.id] && liveListIds[activeMembership[t.id]] ? activeMembership[t.id] : "", options: listOpts, onChange: function (v) { moveToList(t.id, v || null); }, opts: { small: true, pill: true, maxWidth: "140px" } }),
            h("span", { style: { fontSize: 11, color: muted, marginLeft: "auto" } }, ago(t.created_at, now))
          )
        );
      }
      return h("div", {
        key: t.id, draggable: true, onClick: function () { setModalId(t.id); },
        onDragStart: function (e) { dragRef.current = t.id; setDragId(t.id); try { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} },
        onDragEnd: function () { dragRef.current = null; setDragId(null); setDropList(null); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", paddingLeft: (14 + depth * 22) + "px", borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 13, opacity: dragId === t.id ? .4 : 1 },
        onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
      },
        h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 10 } },
          disc,
          h("span", { title: "Drag to move into a list", style: { display: "inline-flex", color: muted, cursor: "grab" } }, Grip()),
          Dot(pri.color, 8),
          h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title || "(untitled)"),
          kidBadge(t),
          prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
          (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null)
        ),
        h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 } },
          cell(COLW.status, h(DotSelect, { value: t.status, options: statusOptionsFor(t), onChange: function (v) { setStatus(t, v); }, opts: { full: true, small: true, pill: true } })),
          cell(COLW.priority, h(DotSelect, { value: String(t.priority == null ? 0 : t.priority), options: prioOptions(t).map(function (o) { var n = parseInt(o.value, 10); return { value: o.value, label: o.label, dot: priorityBucket(isNaN(n) ? 0 : n).color }; }), onChange: function (v) { setPriority(t, v); }, opts: { full: true, small: true, pill: true } })),
          cell(COLW.assignee, h(DotSelect, { value: t.assignee || "", options: [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), onChange: function (v) { setAssignee(t, v); }, opts: { full: true, small: true, pill: true } })),
          cell(COLW.list, h(DotSelect, { value: activeMembership[t.id] && liveListIds[activeMembership[t.id]] ? activeMembership[t.id] : "", options: listOpts, onChange: function (v) { moveToList(t.id, v || null); }, opts: { full: true, small: true, pill: true } })),
          cell(COLW.age, h("span", { style: { fontSize: 11, color: muted } }, ago(t.created_at, now)), true)
        )
      );
    }

    function taskTree(t, depth, visited) {
      var row = taskRow(t, depth);
      if (visited[t.id] || !expandedTasks[t.id]) return row;
      var kids = childrenOf(t);
      if (!kids.length) return row;
      var v = Object.assign({}, visited); v[t.id] = 1;
      return h(Fragment, { key: t.id + "_w" }, row, kids.map(function (ch) { return taskTree(ch, depth + 1, v); }));
    }

    function addTaskRow(sec) {
      var addInto = scope.type === "list" ? scope.id : ((scope.type === "all" || scope.type === "unassigned") ? null : undefined);
      var canAdd = addInto !== undefined && sec.status && (sec.status === "triage" || settableStatuses.indexOf(sec.status) !== -1);
      if (!canAdd) return null;
      var open = addTaskSec === sec.key;
      if (open) {
        return h("div", { style: { display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid " + borderC } },
          h("input", { autoFocus: true, value: addTaskTitle, placeholder: "Task title\u2026", onChange: function (e) { setAddTaskTitle(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") { addTask(addInto, sec.status, addTaskTitle); } if (e.key === "Escape") { setAddTaskSec(null); setAddTaskTitle(""); } }, onBlur: function () { if (addTaskTitle.trim()) addTask(addInto, sec.status, addTaskTitle); setAddTaskSec(null); }, className: "font-courier", style: { flex: "1 1 auto", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "4px 8px", fontSize: 13 } }));
      }
      return h("div", { onClick: function () { setAddTaskSec(sec.key); setAddTaskTitle(""); }, style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 12.5, color: muted }, onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; } }, PlusIcon(13), "Add task");
    }

    function sectionBlock(sec) {
      var isCollapsed = !!collapsedSec[sec.key];
      var doneCount = sec.items.filter(function (t) { return t.status === "done"; }).length;
      return h("div", { key: sec.key, style: { border: "1px solid " + borderC, borderRadius: 8, overflow: "hidden", marginBottom: 10 } },
        h("div", { onClick: function () { setCollapsedSec(function (c) { var n = Object.assign({}, c); n[sec.key] = !n[sec.key]; return n; }); }, style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", background: bgMuted, userSelect: "none" } },
          h("span", { style: { color: muted, display: "inline-flex" } }, Caret(!isCollapsed)),
          Dot(sec.dot, 9),
          h("span", { style: { fontWeight: 600, fontSize: 13, textTransform: groupBy === "status" ? "uppercase" : "none", letterSpacing: groupBy === "status" ? ".03em" : 0 } }, sec.label),
          h("span", { style: { fontSize: 11, color: muted } }, sec.items.length + (doneCount && groupBy !== "status" ? "  \u00b7  " + doneCount + " done" : ""))
        ),
        isCollapsed ? null : (isCompact
          ? h("div", null, sec.items.map(function (t) { return taskTree(t, 0, {}); }), addTaskRow(sec))
          : h("div", { style: { overflowX: "visible" } }, h("div", { style: { minWidth: "auto" } }, columnHeader(), sec.items.map(function (t) { return taskTree(t, 0, {}); }), addTaskRow(sec))))
      );
    }

    // ---- detail modal -------------------------------------------------------
    function modal() {
      if (!modalId) return null;
      var t = taskById[modalId]; if (!t) return null;
      var id = t.id;
      var d = detail[modalId]; var task = (d && d.task) || t; var pri = priorityBucket(t.priority);
      var muteSpan = function (txt) { return h("span", { style: { fontSize: 13, color: muted, fontStyle: "italic" } }, txt); };
      function field(lbl, ctrl) { return h("div", { style: { display: "flex", flexDirection: "column", gap: 7, minWidth: 0 } }, h("span", { style: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 600 } }, lbl), ctrl); }
      function readField(lbl, val) { return field(lbl, h("span", { style: { fontSize: 13, lineHeight: 1.3 } }, val || "\u2014")); }
      function secLabel(txt, right) { return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 } }, h("span", { style: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 700 } }, txt), right || null); }
      function section(label, right, body, opts) { opts = opts || {}; return h("div", { style: { padding: (opts.first ? "0" : "24px") + " 0 0", marginTop: opts.first ? 0 : 24, borderTop: opts.first ? "none" : "1px solid " + borderC } }, secLabel(label, right), body); }
      function linkChip(lid, onRemove) {
        var ct = taskById[lid]; var clickable = !!ct;
        return h("span", { key: lid, style: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, padding: "5px 7px 5px 12px", borderRadius: 999, border: "1px solid " + borderC, background: bgMuted } },
          ct && ct.status ? Dot(statusMeta(ct.status).dot, 7) : null,
          h("span", { onClick: function () { if (clickable) setModalId(lid); }, title: clickable ? (ct.title || lid) : lid, style: { cursor: clickable ? "pointer" : "default", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: clickable ? "inherit" : "var(--font-courier, monospace)" } }, ct ? (ct.title || lid) : lid),
          h("button", { onClick: function (e) { e.stopPropagation(); onRemove(); }, title: "Unlink", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex" } }, XIcon(13)));
      }

      // ---- quick fields (status / priority / assignee / list + read-only) ----
      var fields = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "22px 32px", paddingBottom: 26, borderBottom: "1px solid " + borderC } },
        field("Status", h(DotSelect, { value: t.status, options: statusOptionsFor(t), onChange: function (v) { setStatus(t, v); }, opts: { full: true, lg: true } })),
        field("Priority", h(DotSelect, { value: String(t.priority == null ? 0 : t.priority), options: prioOptions(t).map(function (o) { var n = parseInt(o.value, 10); return { value: o.value, label: o.label, dot: priorityBucket(isNaN(n) ? 0 : n).color }; }), onChange: function (v) { setPriority(t, v); }, opts: { full: true, lg: true } })),
        field("Assignee", h(DotSelect, { value: t.assignee || "", options: [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), onChange: function (v) { setAssignee(t, v); }, opts: { full: true, lg: true } })),
        field("List", h(DotSelect, { value: activeMembership[t.id] && liveListIds[activeMembership[t.id]] ? activeMembership[t.id] : "", options: listOpts, onChange: function (v) { moveToList(t.id, v || null); }, opts: { full: true, lg: true } })),
        readField("Workspace", task.workspace_path ? (task.workspace_kind + " \u00b7 " + task.workspace_path) : task.workspace_kind),
        readField("Created by", task.created_by),
        task.tenant ? readField("Tenant", task.tenant) : null
      );

      var L = [];
      if (!d) L.push(h("div", { key: "ld", style: { fontSize: 12.5, color: muted, paddingTop: 18 } }, "Loading details\u2026"));
      if (d && d._error) L.push(h("div", { key: "er", style: { fontSize: 12.5, color: "#f87171", paddingTop: 18 } }, "Failed to load full details (editing still works)."));

      // ---- Description (click anywhere to edit, ClickUp-style) ---------------
      var descBody = descEdit
        ? h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
            h("textarea", { autoFocus: true, value: descDraft, onChange: function (e) { setDescDraft(e.target.value); }, className: "font-courier", style: { width: "100%", minHeight: 150, resize: "vertical", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 8, padding: "12px 14px", fontSize: 13.5, lineHeight: 1.6, boxSizing: "border-box" } }),
            h("div", { style: { display: "flex", gap: 10 } },
              h("button", { onClick: function () { saveDesc(id); }, style: { background: accent, color: "#fff", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 12.5, cursor: "pointer" } }, "Save"),
              h("button", { onClick: function () { setDescEdit(false); }, style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 7, padding: "7px 16px", fontSize: 12.5, cursor: "pointer" } }, "Cancel")))
        : h("div", { className: "tl-editable", onClick: function () { setDescDraft(task.body || ""); setDescEdit(true); }, title: "Click to edit", style: { position: "relative", padding: "12px 14px", minHeight: 46 } },
            task.body
              ? h("div", { style: { fontSize: 13.5, lineHeight: 1.65, wordBreak: "break-word" } }, mdBlocks(task.body, makePathHandler(false)))
              : h("span", { style: { fontSize: 13.5, color: muted, fontStyle: "italic" } }, "Add a description\u2026"),
            h("span", { className: "tl-penhint", style: { position: "absolute", top: 9, right: 11, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: muted, pointerEvents: "none" } }, PencilIcon(12), "Edit"));
      L.push(h("div", { key: "desc" }, section("Description", null, descBody, { first: true })));

      // ---- Dependencies ------------------------------------------------------
      var links = (d && d.links) || { parents: [], children: [] };
      var parents = links.parents || []; var children = links.children || [];
      var existing = parents.concat(children);
      function otherOpts(placeholder) { return [{ value: "", label: placeholder }].concat(tasks.filter(function (x) { return x.id !== id && existing.indexOf(x.id) === -1; }).map(function (x) { return { value: x.id, label: (x.title || x.id) + "  \u00b7  " + String(x.id).slice(0, 10) }; })); }
      var depBody = h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 } },
          h("span", { style: { fontSize: 12.5, color: muted, minWidth: 70 } }, "Parents"),
          parents.length ? parents.map(function (p) { return linkChip(p, function () { removeLink(p, id); }); }) : muteSpan("none"),
          d ? h(DotSelect, { value: "", options: otherOpts("\u2014 add parent \u2014"), onChange: function (v) { if (v) addLink(v, id); }, opts: { maxWidth: "240px", search: true } }) : null),
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 } },
          h("span", { style: { fontSize: 12.5, color: muted, minWidth: 70 } }, "Children"),
          children.length ? children.map(function (c) { return linkChip(c, function () { removeLink(id, c); }); }) : muteSpan("none"),
          d ? h(DotSelect, { value: "", options: otherOpts("\u2014 add child \u2014"), onChange: function (v) { if (v) addLink(id, v); }, opts: { maxWidth: "240px", search: true } }) : null));
      L.push(h("div", { key: "deps" }, section("Dependencies", null, depBody)));

      // ---- Result ------------------------------------------------------------
      if (task.result) L.push(h("div", { key: "res" }, section("Result", null, h("div", { style: { fontSize: 13, lineHeight: 1.6, wordBreak: "break-word" } }, mdBlocks(task.result, makePathHandler(false))))));

      // ---- Attachments -------------------------------------------------------
      var atts = (d && d.attachments) || [];
      var uploadBtn = h("label", { style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 7, padding: "6px 13px", fontSize: 12, cursor: "pointer" } }, "Upload file",
        h("input", { type: "file", style: { display: "none" }, onChange: function (e) { var f = e.target.files && e.target.files[0]; uploadAttachment(id, f); e.target.value = ""; } }));
      var attBody = atts.length
        ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, atts.map(function (a, i) {
            return h("div", { key: a.id || i, style: { display: "flex", alignItems: "center", gap: 12, fontSize: 13 } },
              h("button", { onClick: function () { downloadAttachment(a); }, title: "Download", style: { background: "transparent", border: "none", color: accent, cursor: "pointer", padding: 0, font: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" } }, a.filename || a.id),
              h("span", { style: { color: muted, fontSize: 11.5 } }, hsize(a.size)),
              a.uploaded_by ? h("span", { style: { color: muted, fontSize: 11.5 } }, "\u00b7 " + a.uploaded_by) : null,
              h("button", { onClick: function () { deleteAttachment(a.id, id); }, title: "Delete attachment", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex", marginLeft: "auto" } }, XIcon(14)));
          }))
        : muteSpan("\u2014 no attachments \u2014");
      L.push(h("div", { key: "att" }, section("Attachments (" + atts.length + ")", uploadBtn, attBody)));

      // ---- Worker log --------------------------------------------------------
      var wl = workerLog[id];
      var wlRight = h("button", { onClick: function () { loadWorkerLog(id); }, style: { background: "transparent", border: "none", color: accent, cursor: "pointer", fontSize: 12 } }, wl ? "refresh" : "load");
      var wlBody = wl
        ? (wl.loading ? muteSpan("Loading\u2026") : (wl.content ? h("pre", { style: { margin: 0, maxHeight: 260, overflow: "auto", background: bgMuted, border: "1px solid " + borderC, borderRadius: 8, padding: "12px 14px", fontSize: 11.5, fontFamily: "var(--font-courier, monospace)", whiteSpace: "pre-wrap" } }, wl.content) : muteSpan(wl.error ? "\u2014 could not load worker log \u2014" : "\u2014 no worker log yet \u2014")))
        : muteSpan("Click \u201cload\u201d to fetch the worker log.");
      L.push(h("div", { key: "wl" }, section("Worker log", wlRight, wlBody)));

      // ---- Activity pane: events + run history + comments --------------------
      var R = [];
      var events = (d && d.events) || [];
      if (events.length) {
        var evBody = h("div", { style: { display: "flex", flexDirection: "column", gap: 9 } }, events.map(function (e, i) {
          var pl = fmtPayload(e.payload);
          return h("div", { key: e.id || i, style: { display: "flex", flexDirection: "column", gap: 2 } },
            h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
              h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, e.kind || "?"),
              h("span", { style: { color: muted, fontSize: 11 } }, ago(e.created_at, now) + " ago")),
            pl ? h("span", { style: { fontFamily: "var(--font-courier, monospace)", fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: pl }, pl) : null);
        }));
        R.push(h("div", { key: "ev" }, section("Events (" + events.length + ")", null, evBody, { first: R.length === 0 })));
      }
      var runs = (d && d.runs) || [];
      if (runs.length) {
        var runBody = h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } }, runs.map(function (r, i) {
          var oc = r.outcome || r.status || "?";
          var ocColor = oc === "completed" ? "#34d399" : (oc === "failed" || r.error ? "#f87171" : muted);
          var dur = ""; if (r.started_at && r.ended_at) { var sec = Math.max(0, r.ended_at - r.started_at); dur = sec < 60 ? sec + "s" : (sec < 3600 ? Math.floor(sec / 60) + "m" : Math.floor(sec / 3600) + "h"); }
          return h("div", { key: r.id || i, style: { fontSize: 13, borderLeft: "2px solid " + borderC, paddingLeft: 14 } },
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
              h("span", { style: { color: ocColor, fontFamily: "var(--font-courier, monospace)", fontSize: 12.5 } }, oc),
              r.profile ? h("span", { style: { color: muted } }, "@" + r.profile) : null,
              dur ? h("span", { style: { color: muted, fontSize: 11 } }, dur) : null,
              h("span", { style: { color: muted, fontSize: 11, marginLeft: "auto" } }, ago(r.ended_at || r.started_at, now) + " ago")),
            r.summary ? h("div", { style: { marginTop: 4, lineHeight: 1.5 } }, mdBlocks(r.summary, makePathHandler(false))) : null,
            r.error ? h("div", { style: { marginTop: 4, color: "#f87171", fontSize: 12.5 } }, r.error) : null);
        }));
        R.push(h("div", { key: "runs" }, section("Run history (" + runs.length + ")", null, runBody, { first: R.length === 0 })));
      }
      var comments = (d && d.comments) || [];
      var commentList = comments.length
        ? h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } }, comments.map(function (c, i) {
            return h("div", { key: c.id || i, style: { display: "flex", gap: 10 } },
              h("div", { style: { width: 26, height: 26, borderRadius: "50%", background: bgMuted, border: "1px solid " + borderC, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flex: "0 0 auto", textTransform: "uppercase" } }, (c.author || c.created_by || "?").slice(0, 2)),
              h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", marginBottom: 3 } }, h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, c.author || c.created_by || "?"), h("span", { style: { color: muted, fontSize: 11 } }, ago(c.created_at, now) + " ago")),
                h("div", { style: { fontSize: 13, lineHeight: 1.55, wordBreak: "break-word" } }, mdBlocks(c.body || c.text || "", makePathHandler(false)))));
          }))
        : muteSpan("\u2014 no comments \u2014");
      R.push(h("div", { key: "cm" }, section("Comments (" + comments.length + ")", null, commentList, { first: R.length === 0 })));

      var composer = h("div", { style: { borderTop: "1px solid " + borderC, padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 } },
        h("textarea", { value: commentDraft, placeholder: "Add a comment\u2026 (Enter to submit, Shift+Enter for newline)", rows: 2, onChange: function (e) { setCommentDraft(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addComment(id); } }, className: "font-courier", style: { width: "100%", resize: "vertical", background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.5, boxSizing: "border-box" } }),
        h("div", { style: { display: "flex", justifyContent: "flex-end" } }, h("button", { onClick: function () { addComment(id); }, style: { background: accent, color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 12.5, cursor: "pointer" } }, "Comment")));

      var detailsScroll = h("div", { style: { flex: "1 1 auto", minWidth: 0, overflow: "auto", padding: isNarrow ? "16px 16px 22px" : "24px 30px 30px" } }, fields, h("div", { style: { paddingTop: isNarrow ? 18 : 24 } }, L));
      var activityScroll = h("div", { style: { flex: "1 1 auto", overflow: "auto", padding: isNarrow ? "16px 16px 8px" : "20px 20px 10px" } }, R);

      var leftPane = detailsScroll;
      var rightPane = h("div", { style: { flex: "0 0 380px", borderLeft: "1px solid " + borderC, display: "flex", flexDirection: "column", overflow: "hidden", background: bgMuted } },
        h("div", { style: { padding: "18px 20px", borderBottom: "1px solid " + borderC, fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 700 } }, "Activity"),
        activityScroll, composer);

      function tabBtn(key, label) {
        var on = modalTab === key;
        return h("button", { onClick: function () { setModalTab(key); }, style: { flex: "1 1 0", background: "transparent", color: on ? "inherit" : muted, border: "none", borderBottom: "2px solid " + (on ? accent : "transparent"), padding: "12px 8px", fontSize: 13, fontWeight: on ? 700 : 500, cursor: "pointer" } }, label);
      }

      var body = isNarrow
        ? h("div", { style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" } },
            h("div", { style: { display: "flex", borderBottom: "1px solid " + borderC, flex: "0 0 auto" } }, tabBtn("details", "Details"), tabBtn("activity", "Activity" + (comments.length ? " (" + comments.length + ")" : ""))),
            modalTab === "activity"
              ? h("div", { style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 0, background: bgMuted } }, activityScroll, composer)
              : detailsScroll)
        : h("div", { style: { flex: "1 1 auto", display: "flex", flexDirection: "row", minHeight: 0, overflow: "hidden" } }, leftPane, rightPane);

      var panel = h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: isNarrow ? "100vw" : "min(1180px, 96vw)", height: isNarrow ? "100vh" : "94vh", overflow: "hidden", background: cardBg, border: isNarrow ? "none" : "1px solid " + borderC, borderRadius: isNarrow ? 0 : 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", display: "flex", flexDirection: "column" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 14, padding: isNarrow ? "14px 16px" : "20px 28px", borderBottom: "1px solid " + borderC, flex: "0 0 auto" } },
          h("div", { style: { paddingTop: isNarrow ? 6 : 8 } }, Dot(pri.color, 12)),
          h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
            h("input", { value: titleDraft, onChange: function (e) { setTitleDraft(e.target.value); }, onBlur: function () { saveTitle(t); }, onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid transparent", borderRadius: 7, padding: "5px 8px", fontSize: isNarrow ? 17 : 21, fontWeight: 700 }, onFocus: function (e) { e.target.style.border = "1px solid " + borderC; }, title: "Edit title (Enter to save)" }),
            h("div", { style: { fontSize: 11.5, color: muted, fontFamily: "var(--font-courier, monospace)", padding: "3px 8px" } }, t.id)),
          h("button", { onClick: function () { archiveTask(t.id, t.status === "archived" ? "todo" : "archived"); }, title: t.status === "archived" ? "Unarchive task" : "Archive task", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 9, padding: isNarrow ? 8 : "8px 12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, flex: "0 0 auto" } }, ArchiveIcon(16), isNarrow ? null : (t.status === "archived" ? "Unarchive" : "Archive")),
          h("button", { onClick: function () { setConfirmDel(t.id); }, title: "Delete task", style: { background: "transparent", color: "#f87171", border: "1px solid " + borderC, borderRadius: 9, padding: isNarrow ? 8 : "8px 12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, flex: "0 0 auto" } }, TrashIcon(16), isNarrow ? null : "Delete"),
          h("button", { onClick: function () { setModalId(null); }, "data-tl-close": "1", title: "Close (Esc)", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 9, padding: 8, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon(20))),
        body);
      return h(Fragment, null,
        h(Portal, { onClose: function () { setModalId(null); } }, h("div", { onClick: function () { setModalId(null); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: isNarrow ? "0" : "3vh 2vw" } }, panel)),
        confirmDel ? h(Portal, { onClose: function () { setConfirmDel(null); } },
          h("div", { onClick: function () { setConfirmDel(null); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483600, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" } },
            h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: "min(420px, 96vw)", background: cardBg, border: "1px solid " + borderC, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", padding: "22px 24px" } },
              h("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 10 } }, "Delete task?"),
              h("div", { style: { fontSize: 13, lineHeight: 1.55, color: muted, marginBottom: 20 } }, "This permanently deletes the task along with its comments, links, attachments and history. This can\u2019t be undone."),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 10 } },
                h("button", { onClick: function () { setConfirmDel(null); }, "data-tl-close": "1", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" } }, "Cancel"),
                h("button", { onClick: function () { deleteTask(confirmDel); }, style: { background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 } }, TrashIcon(15), "Delete"))))) : null);
    }

    // ---- page ---------------------------------------------------------------
    var activeBoardLabel = (function () { var b = boards.filter(function (x) { return x.slug === board; })[0]; return b ? (b.label || b.name || b.slug) : board; })();
    // ---- dependency graph (DAG) view ---------------------------------------
    var graphModel = useMemo(function () {
      if (view !== "graph") return null;
      var list = scopeTasks.filter(function (t) { return showArchived || t.status !== "archived"; });
      var idset = {}; list.forEach(function (t) { idset[t.id] = 1; });
      var par = {}, chi = {}; list.forEach(function (t) { par[t.id] = []; chi[t.id] = []; });
      list.forEach(function (t) { (edges.parents[t.id] || []).forEach(function (pid) { if (idset[pid] && par[t.id].indexOf(pid) === -1) { par[t.id].push(pid); chi[pid].push(t.id); } }); });
      var level = {}, TEMP = {};
      function lvl(id) { if (level[id] !== undefined) return level[id]; if (TEMP[id]) return 0; TEMP[id] = 1; var m = -1; par[id].forEach(function (p) { var l = lvl(p); if (l > m) m = l; }); TEMP[id] = 0; level[id] = m + 1; return level[id]; }
      list.forEach(function (t) { lvl(t.id); });
      var byLevel = {}, maxLevel = 0; list.forEach(function (t) { var L = level[t.id]; (byLevel[L] = byLevel[L] || []).push(t.id); if (L > maxLevel) L = maxLevel; if (level[t.id] > maxLevel) maxLevel = level[t.id]; });
      function tcreated(id) { return (taskById[id] && taskById[id].created_at) || 0; }
      Object.keys(byLevel).forEach(function (L) { byLevel[L].sort(function (a, b) { return tcreated(a) - tcreated(b); }); });
      function idxMap() { var idx = {}; Object.keys(byLevel).forEach(function (L) { byLevel[L].forEach(function (id, i) { idx[id] = i; }); }); return idx; }
      function bary(neigh, idx) { if (!neigh || !neigh.length) return 1e9; var s = 0, c = 0; neigh.forEach(function (n) { if (idx[n] !== undefined) { s += idx[n]; c++; } }); return c ? s / c : 1e9; }
      for (var pass = 0; pass < 4; pass++) {
        var idx = idxMap();
        for (var L = 1; L <= maxLevel; L++) { var a1 = byLevel[L]; if (a1 && a1.length) a1.sort(function (a, b) { var d = bary(par[a], idx) - bary(par[b], idx); return d !== 0 ? d : tcreated(a) - tcreated(b); }); idx = idxMap(); }
        for (var L2 = maxLevel - 1; L2 >= 0; L2--) { var a2 = byLevel[L2]; if (a2 && a2.length) a2.sort(function (a, b) { var d = bary(chi[a], idx) - bary(chi[b], idx); return d !== 0 ? d : tcreated(a) - tcreated(b); }); idx = idxMap(); }
      }
      var NODE_W = 212, NODE_H = 58, HGAP = 88, VGAP = 22, PADX = 26, PADT = 46, PADB = 26;
      var maxRows = 0; for (var L3 = 0; L3 <= maxLevel; L3++) { var ar = byLevel[L3] || []; if (ar.length > maxRows) maxRows = ar.length; }
      var totalH = maxRows * (NODE_H + VGAP) - VGAP; if (totalH < 0) totalH = 0;
      var pos = {}, ord = {}, oc = 0;
      for (var L4 = 0; L4 <= maxLevel; L4++) { var arr = byLevel[L4] || []; var colH = arr.length * (NODE_H + VGAP) - VGAP; var offY = PADT + (totalH - colH) / 2; arr.forEach(function (id, i) { pos[id] = { x: PADX + L4 * (NODE_W + HGAP), y: offY + i * (NODE_H + VGAP) }; ord[id] = oc++; }); }
      var W = PADX * 2 + (maxLevel + 1) * (NODE_W + HGAP) - HGAP; if (W < PADX * 2 + NODE_W) W = PADX * 2 + NODE_W;
      var H = PADT + PADB + totalH; if (H < PADT + PADB + NODE_H) H = PADT + PADB + NODE_H;
      var elist = []; list.forEach(function (t) { chi[t.id].forEach(function (cid) { elist.push({ from: t.id, to: cid }); }); });
      return { ids: list.map(function (t) { return t.id; }), par: par, chi: chi, level: level, pos: pos, ord: ord, edges: elist, W: W, H: H, NODE_W: NODE_W, NODE_H: NODE_H, maxLevel: maxLevel, PADT: PADT };
    }, [view, scopeTasks, edges, showArchived, taskById]);

    // SVG is memoised so pan/zoom (which only transform the wrapper) never re-render the nodes.
    var graphSvg = useMemo(function () {
      var gm = graphModel;
      if (!gm || !gm.ids.length) return null;
      var par = gm.par, chi = gm.chi, pos = gm.pos;
      function reach(start, adj) { var out = {}, st = (adj[start] || []).slice(); while (st.length) { var x = st.pop(); if (out[x]) continue; out[x] = 1; (adj[x] || []).forEach(function (n) { st.push(n); }); } return out; }
      var hi = null;
      if (graphHover && pos[graphHover]) { var anc = reach(graphHover, par), des = reach(graphHover, chi); hi = {}; hi[graphHover] = 1; Object.keys(anc).forEach(function (k) { hi[k] = 1; }); Object.keys(des).forEach(function (k) { hi[k] = 1; }); }
      function nodeState(id) { var t = taskById[id]; if (!t) return "ready"; if (t.status === "done") return "done"; var ps = par[id]; if (!ps || !ps.length) return "ready"; for (var i = 0; i < ps.length; i++) { var pt = taskById[ps[i]]; if (!pt || pt.status !== "done") return "blocked"; } return "ready"; }
      var stateText = { done: muted, ready: accent, blocked: "#e06666" };
      var stateLabel = { done: "Done", ready: "Ready", blocked: "Blocked" };
      var NODE_W = gm.NODE_W, NODE_H = gm.NODE_H, fg = fgColor || "#e5e7eb";
      var maxChars = Math.max(6, Math.floor((NODE_W - 52) / 6.7));
      var edgeEls = gm.edges.map(function (e, i) {
        var a = pos[e.from], b = pos[e.to]; if (!a || !b) return null;
        var x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, dx = Math.max(34, (x2 - x1) / 2);
        var on = hi ? (hi[e.from] && hi[e.to]) : true;
        var col = on ? (hi ? accent : "var(--muted-foreground, #9ca3af)") : "var(--muted-foreground, #9ca3af)";
        var cls = "tl-gedge" + (graphAnim ? " in" : ((!graphAnim && hi && on) ? " flow" : ""));
        var style = {};
        if (graphAnim) { var len = Math.hypot(x2 - x1, y2 - y1) + Math.abs(y2 - y1) * 0.4 + 30; style.strokeDasharray = len; style.strokeDashoffset = len; style.animationDelay = (gm.ord[e.to] * 22 + 150) + "ms"; }
        else if (hi && on) { style.strokeDasharray = "6 8"; }
        return h("path", { key: "e" + i, className: cls, d: "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2, fill: "none", stroke: col, strokeWidth: hi && on ? 2 : 1.3, opacity: hi ? (on ? 0.95 : 0.12) : 0.5, markerEnd: hi && on ? "url(#tl-arrow-hi)" : "url(#tl-arrow)", style: style });
      });
      var stageEls = []; for (var L = 0; L <= gm.maxLevel; L++) { var cx = 26 + L * (NODE_W + 88) + NODE_W / 2; stageEls.push(h("text", { key: "st" + L, className: graphAnim ? "tl-stage" : null, x: cx, y: 20, textAnchor: "middle", fill: "currentColor", opacity: 0.6, fontSize: 11, fontWeight: 600, style: graphAnim ? { letterSpacing: ".04em", animationDelay: (L * 55) + "ms" } : { letterSpacing: ".04em" } }, "Stage " + (L + 1))); }
      var nodeEls = gm.ids.map(function (id) {
        var t = taskById[id]; if (!t) return null; var p = pos[id]; var st = nodeState(id);
        var dim = hi && !hi[id]; var hov = graphHover === id;
        var dm = statusMeta(t.status); var title = String(t.title || "Untitled"); if (title.length > maxChars) title = title.slice(0, maxChars - 1) + "\u2026";
        var np = (par[id] || []).length, nc = (chi[id] || []).length;
        var rest = (np ? "  \u00b7  " + np + " parent" + (np === 1 ? "" : "s") : "") + (nc ? "  \u00b7  " + nc + " child" + (nc === 1 ? "" : "ren") : "");
        var innerStyle = { cursor: "pointer" }; if (graphAnim) innerStyle.animationDelay = (gm.ord[id] * 22) + "ms";
        return h("g", { key: id, transform: "translate(" + p.x + "," + p.y + ")" },
          h("g", { className: "tl-gnode" + (graphAnim ? " in" : ""), style: innerStyle, opacity: dim ? 0.32 : 1, onClick: function () { if (suppressClickRef.current) return; setModalId(id); }, onMouseEnter: function () { if (panningRef.current) return; setGraphHover(id); }, onMouseLeave: function () { if (panningRef.current) return; setGraphHover(null); } },
            h("rect", { width: NODE_W, height: NODE_H, rx: 11, ry: 11, fill: cardBg, stroke: hov ? accent : borderC, strokeWidth: hov ? 2.2 : 1.3 }),
            h("circle", { className: (st === "ready" && !dim) ? "tl-pulse" : null, cx: 21, cy: NODE_H / 2, r: 5, fill: dm.dot }),
            h("text", { x: 36, y: NODE_H / 2 - 4, fill: fg, fontSize: 13, fontWeight: 600 }, title),
            h("text", { x: 36, y: NODE_H / 2 + 14, fontSize: 10.5 },
              h("tspan", { fill: stateText[st], fontWeight: 600 }, stateLabel[st]),
              rest ? h("tspan", { fill: "currentColor", opacity: 0.55 }, rest) : null)));
      });
      return h("svg", { width: gm.W, height: gm.H, viewBox: "0 0 " + gm.W + " " + gm.H, style: { display: "block" } },
        h("defs", null,
          h("marker", { id: "tl-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, h("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--muted-foreground, #9ca3af)" })),
          h("marker", { id: "tl-arrow-hi", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7.5, markerHeight: 7.5, orient: "auto-start-reverse" }, h("path", { d: "M0,0 L10,5 L0,10 z", fill: accent }))),
        h("g", null, edgeEls), h("g", null, stageEls), h("g", null, nodeEls));
    }, [graphModel, graphHover, graphAnim, colorV, fgColor]);

    function graphZoomAt(mx, my, factor) { var z = zoomRef.current, p = panRef.current, nz = Math.min(2.5, Math.max(0.35, z * factor)); if (nz === z) return; var rf = nz / z; setGraphPan({ x: mx - (mx - p.x) * rf, y: my - (my - p.y) * rf }); setGraphZoom(nz); }
    function graphZoomButton(factor) { var el = viewportRef.current; if (!el) { setGraphZoom(function (z) { return Math.min(2.5, Math.max(0.35, z * factor)); }); return; } var r = el.getBoundingClientRect(); graphZoomAt(r.width / 2, r.height / 2, factor); }
    function onGraphDown(e) {
      if (e.button !== 0) return;
      var p = panRef.current, d = { sx: e.clientX, sy: e.clientY, px: p.x, py: p.y, moved: false };
      panningRef.current = true; setPanning(true);
      function move(ev) { var dx = ev.clientX - d.sx, dy = ev.clientY - d.sy; if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true; setGraphPan({ x: d.px + dx, y: d.py + dy }); }
      function up() { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); panningRef.current = false; setPanning(false); if (d.moved) { suppressClickRef.current = true; setTimeout(function () { suppressClickRef.current = false; }, 60); } }
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    }
    useEffect(function () {
      if (view !== "graph") return; var el = viewportRef.current; if (!el) return;
      function onWheel(e) { e.preventDefault(); var r = el.getBoundingClientRect(); graphZoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp((-e.deltaY) * 0.0015)); }
      el.addEventListener("wheel", onWheel, { passive: false });
      return function () { el.removeEventListener("wheel", onWheel); };
    }, [view, graphModel]);

    function graphView() {
      if (!graphModel || !graphModel.ids.length) return h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "40px 24px", textAlign: "center" } }, loading ? "Loading\u2026" : "No tasks to graph in this scope.");
      function zBtn(lbl, fn, title) { return h("button", { onClick: fn, title: title, style: { background: bgMuted, color: "inherit", border: "1px solid " + borderC, borderRadius: 7, width: 30, height: 28, fontSize: 15, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" } }, lbl); }
      function legendDot(c, lbl) { return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: muted } }, h("span", { style: { width: 9, height: 9, borderRadius: 3, background: "transparent", border: "2px solid " + c } }), lbl); }
      var controls = h("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } }, zBtn("\u2212", function () { graphZoomButton(1 / 1.2); }, "Zoom out"), h("span", { style: { fontSize: 11.5, color: muted, minWidth: 38, textAlign: "center" } }, Math.round(graphZoom * 100) + "%"), zBtn("+", function () { graphZoomButton(1.2); }, "Zoom in"), zBtn("\u21ba", function () { setGraphZoom(1); setGraphPan({ x: 0, y: 0 }); }, "Reset view")),
        h("div", { style: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" } }, legendDot(accent, "Ready"), legendDot("#e06666", "Blocked (waiting on a parent)"), legendDot(muted, "Done")),
        h("span", { style: { fontSize: 11.5, color: muted } }, "Scroll / pinch to zoom \u00b7 drag to pan \u00b7 click a task to open \u00b7 hover to trace its chain"));
      return h("div", null, controls,
        h("span", { ref: fgProbeRef, "aria-hidden": "true", style: { position: "absolute", width: 0, height: 0, overflow: "hidden", opacity: 0, pointerEvents: "none" } }, "\u200b"),
        h("div", { ref: viewportRef, onMouseDown: onGraphDown, style: { position: "relative", overflow: "hidden", border: "1px solid " + borderC, borderRadius: 10, background: bgMuted, height: "calc(100vh - 250px)", cursor: panning ? "grabbing" : "grab", touchAction: "none", userSelect: "none" } },
          h("div", { style: { position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: "translate(" + graphPan.x + "px," + graphPan.y + "px) scale(" + graphZoom + ")", willChange: "transform" } }, graphSvg)));
    }

    var main = h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } },
          isNarrow ? h("button", { onClick: function () { setSidebarOpen(!sidebarOpen); }, title: "Show/hide boards", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer", flex: "0 0 auto" } }, "\u2630 Boards") : null,
          h("h1", { style: { fontSize: isNarrow ? 16 : 18, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scopeTitle, activeBoardLabel ? h("span", { style: { fontSize: 12, fontWeight: 400, color: muted, marginLeft: 8 } }, "in " + activeBoardLabel) : null)),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" } },
          h("div", { style: { display: "inline-flex", border: "1px solid " + borderC, borderRadius: 8, overflow: "hidden" } },
            ["list", "graph"].map(function (v) { var on = view === v; return h("button", { key: v, onClick: function () { setView(v); }, title: v === "graph" ? "Dependency graph" : "List view", style: { background: on ? accent : "transparent", color: on ? "#fff" : "inherit", border: "none", padding: "6px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" } }, v === "list" ? "List" : "Graph"); })),
          h("span", { style: { fontSize: 12, color: muted } }, loading ? "Loading\u2026" : (scopeTasks.length + " task" + (scopeTasks.length === 1 ? "" : "s"))),
          h("button", { onClick: openCreate, title: "Create a new task", style: { display: "inline-flex", alignItems: "center", gap: 6, background: accent, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", flex: "0 0 auto" } }, h("span", { style: { fontSize: 15, lineHeight: 1, marginTop: -1 } }, "+"), "New task"))
      ),
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      view === "graph"
        ? graphView()
        : h(React.Fragment, null,
          toolbar,
          (!error && !loading && !sections.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, scope.type === "list" ? "This list is empty. Drag tasks onto it, use the List dropdown on a task, or add one below." : "No tasks here.") : null,
          sections.map(function (sec) { return sectionBlock(sec); }))
    );

    useEffect(function () {
      if (!creating) return;
      function onKey(e) { if (e.key === "Escape") { if (confirmClose) setConfirmClose(false); else requestClose(); } }
      document.addEventListener("keydown", onKey);
      return function () { document.removeEventListener("keydown", onKey); };
    }, [creating, confirmClose, draft, savingNew]);

    function createModal() {
      if (!creating || !draft) return null;
      function upd(patch) { setDraft(Object.assign({}, draft, patch)); }
      function cfield(lbl, ctrl) { return h("div", { style: { display: "flex", flexDirection: "column", gap: 7, minWidth: 0 } }, h("span", { style: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 600 } }, lbl), ctrl); }
      var statusOpts2 = settableStatuses.map(function (st) { return { value: st, label: statusMeta(st).label, dot: statusMeta(st).dot }; });
      var prioOpts2 = [{ value: "3", label: "Urgent" }, { value: "2", label: "High" }, { value: "1", label: "Normal" }, { value: "0", label: "Low" }].map(function (o) { var n = parseInt(o.value, 10); return { value: o.value, label: o.label, dot: priorityBucket(n).color }; });
      var asgOpts2 = [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; }));
      var canSave = !!(draft.title || "").trim() && !savingNew;

      var header = h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: isNarrow ? "14px 16px" : "18px 26px", borderBottom: "1px solid " + borderC, flex: "0 0 auto" } },
        h("span", { style: { width: 9, height: 9, borderRadius: "50%", background: accent, flex: "0 0 auto" } }),
        h("span", { style: { fontSize: isNarrow ? 16 : 18, fontWeight: 700, flex: "1 1 auto" } }, "New task"),
        h("button", { onClick: requestClose, "data-tl-close": "1", title: "Close (Esc)", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 9, padding: 8, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon(20)));

      var body = h("div", { style: { flex: "1 1 auto", minWidth: 0, overflow: "auto", padding: isNarrow ? "16px" : "24px 30px" } },
        cfield("Title", h("input", { autoFocus: true, value: draft.title, onChange: function (e) { upd({ title: e.target.value }); }, onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); submitCreate(); } }, placeholder: "What needs to be done?", className: "font-courier", style: { width: "100%", boxSizing: "border-box", background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "10px 12px", fontSize: 15, fontWeight: 600 } })),
        h("div", { style: { height: 22 } }),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "22px 32px" } },
          cfield("Status", h(DotSelect, { value: draft.status, options: statusOpts2, onChange: function (v) { upd({ status: v }); }, opts: { full: true, lg: true } })),
          cfield("Priority", h(DotSelect, { value: draft.priority, options: prioOpts2, onChange: function (v) { upd({ priority: v }); }, opts: { full: true, lg: true } })),
          cfield("Assignee", h(DotSelect, { value: draft.assignee, options: asgOpts2, onChange: function (v) { upd({ assignee: v }); }, opts: { full: true, lg: true, search: true } })),
          cfield("List", h(DotSelect, { value: draft.list_id, options: listOpts, onChange: function (v) { upd({ list_id: v }); }, opts: { full: true, lg: true, search: true, onCreate: function (name) { return createListReturning(name, board); } } }))),
        h("div", { style: { height: 22 } }),
        cfield("Description", h("textarea", { value: draft.body, onChange: function (e) { upd({ body: e.target.value }); }, placeholder: "Add a description\u2026", className: "font-courier", style: { width: "100%", boxSizing: "border-box", minHeight: 130, resize: "vertical", background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "12px 14px", fontSize: 13.5, lineHeight: 1.6 } })),
        h("div", { style: { height: 22 } }),
        cfield("Attachments", h("div", null,
          h("label", { style: { display: "inline-flex", alignItems: "center", gap: 7, background: "transparent", color: "inherit", border: "1px dashed " + borderC, borderRadius: 8, padding: "9px 14px", fontSize: 12.5, cursor: "pointer" } },
            PlusIcon(13), "Add files",
            h("input", { type: "file", multiple: true, onChange: function (e) { var fs = Array.prototype.slice.call(e.target.files || []); if (fs.length) upd({ files: (draft.files || []).concat(fs) }); e.target.value = ""; }, style: { display: "none" } })),
          (draft.files && draft.files.length) ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 10 } }, draft.files.map(function (f, i) {
            return h("div", { key: i + ":" + f.name, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, background: bgMuted, borderRadius: 6, padding: "6px 10px" } },
              h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.name),
              h("span", { style: { flex: "0 0 auto", color: muted, fontSize: 11 } }, fmtBytes(f.size)),
              h("button", { onClick: function () { upd({ files: draft.files.filter(function (_, j) { return j !== i; }) }); }, title: "Remove", style: { flex: "0 0 auto", background: "transparent", color: muted, border: "none", cursor: "pointer", display: "inline-flex", padding: 2 } }, XIcon(14)));
          })) : null)));

      var footer = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: isNarrow ? "12px 16px" : "16px 26px", borderTop: "1px solid " + borderC, flex: "0 0 auto" } },
        h("span", { style: { fontSize: 11.5, color: muted, marginRight: "auto" } }, "Nothing is saved until you create it."),
        h("button", { onClick: requestClose, style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 8, padding: "9px 18px", fontSize: 13, cursor: "pointer" } }, "Cancel"),
        h("button", { onClick: submitCreate, disabled: !canSave, style: { background: canSave ? accent : bgMuted, color: canSave ? "#fff" : muted, border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: canSave ? "pointer" : "not-allowed" } }, savingNew ? "Creating\u2026" : "Create task"));

      var panel = h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: isNarrow ? "100vw" : "min(680px, 96vw)", height: isNarrow ? "100vh" : "auto", maxHeight: isNarrow ? "100vh" : "92vh", overflow: "hidden", background: cardBg, border: isNarrow ? "none" : "1px solid " + borderC, borderRadius: isNarrow ? 0 : 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", display: "flex", flexDirection: "column" } }, header, body, footer);

      var hasTitle = !!(draft.title || "").trim();
      return h(Fragment, null,
        h(Portal, { onClose: requestClose }, h("div", { onClick: requestClose, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: isNarrow ? "0" : "3vh 2vw" } }, panel)),
        confirmClose ? h(Portal, { onClose: function () { setConfirmClose(false); } },
          h("div", { onClick: function () { setConfirmClose(false); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483600, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" } },
            h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: "min(440px, 96vw)", background: cardBg, border: "1px solid " + borderC, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", padding: "22px 24px" } },
              h("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 10 } }, "Discard this task?"),
              h("div", { style: { fontSize: 13, lineHeight: 1.55, color: muted, marginBottom: 20 } }, hasTitle ? "You have unsaved details. Save this task, or discard it and close?" : "You have unsaved details. Discarding will close without creating the task. Add a title to save it."),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" } },
                h("button", { onClick: function () { setConfirmClose(false); }, "data-tl-close": "1", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" } }, "Keep editing"),
                h("button", { onClick: closeCreate, style: { background: "transparent", color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" } }, "Discard"),
                h("button", { onClick: function () { setConfirmClose(false); submitCreate(); }, disabled: !hasTitle, title: hasTitle ? "" : "Add a title first", style: { background: hasTitle ? accent : bgMuted, color: hasTitle ? "#fff" : muted, border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: hasTitle ? "pointer" : "not-allowed" } }, "Save task")))) ) : null);
    }

    function listDeleteModal() {
      if (!confirmDelList) return null;
      var l = confirmDelList.l, slug = confirmDelList.slug;
      return h(Portal, { onClose: function () { setConfirmDelList(null); } },
        h("div", { onClick: function () { setConfirmDelList(null); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483600, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" } },
          h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: "min(440px, 96vw)", background: cardBg, border: "1px solid " + borderC, borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", padding: "22px 24px" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 9, marginBottom: 10 } },
              h("span", { style: { width: 10, height: 10, borderRadius: "50%", background: l.color || muted, flex: "0 0 auto" } }),
              h("div", { style: { fontSize: 16, fontWeight: 700 } }, "Delete list?")),
            h("div", { style: { fontSize: 13, lineHeight: 1.55, color: muted, marginBottom: 20 } }, "\u201c" + l.name + "\u201d will be removed. The tasks stay on the board \u2014 they just leave this list."),
            h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 10 } },
              h("button", { onClick: function () { setConfirmDelList(null); }, "data-tl-close": "1", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" } }, "Cancel"),
              h("button", { onClick: function () { deleteList(l, slug); }, style: { background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 } }, TrashIcon(15), "Delete list")))));
    }

    function filePreviewModal() {
      if (!filePreview) return null;
      var fp = filePreview;
      var isMd = /markdown/i.test(fp.mime || "") || /\.(md|markdown)$/i.test(fp.name || fp.path || "");
      var isImg = /^image\//i.test(fp.mime || "") || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(fp.name || fp.path || "");
      var body = fp.loading ? h("div", { style: { color: muted, fontSize: 13 } }, fp.searching ? "File not at that path \u2014 searching the file tree\u2026" : "Loading\u2026")
        : fp.err ? h("div", { style: { color: "#f87171", fontSize: 13, lineHeight: 1.6 } }, "Could not open file: " + fp.err + (fp.searchedNoMatch ? " (no match found by searching either)" : "") + ". You can still try the Download button.")
        : (isImg && fp.dataUrl) ? h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10 } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", borderRadius: 10, padding: 14, background: "repeating-conic-gradient(rgba(128,128,128,.14) 0% 25%, transparent 0% 50%) 50% / 20px 20px" } },
              h("img", { src: fp.dataUrl, alt: fp.name || fp.path, style: { maxWidth: "100%", maxHeight: "70vh", height: "auto", objectFit: "contain", borderRadius: 6, boxShadow: "0 4px 18px rgba(0,0,0,.35)" } })),
            h("div", { style: { fontSize: 11, color: muted } }, (fp.mime || "image") + (fp.size ? " \u00b7 " + fmtBytes(fp.size) : "")))
        : (fp.text != null) ? ((isMd && !previewRaw)
            ? h("div", { style: { fontSize: 13.5, lineHeight: 1.65, wordBreak: "break-word" } }, mdBlocks(fp.text, makePathHandler(true)))
            : h("pre", { style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-courier, monospace)", fontSize: 12.5, lineHeight: 1.65 } }, fp.text))
        : h("div", { style: { color: muted, fontSize: 13, lineHeight: 1.6 } }, "No inline preview for this file type (" + (fp.mime || "unknown") + "). Use the Download button to open it.");
      var mdToggle = (isMd && fp.text != null) ? h("button", { onClick: function () { setPreviewRaw(!previewRaw); }, title: previewRaw ? "Show rendered markdown" : "Show raw text", style: { flex: "0 0 auto", background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 8, padding: "7px 12px", fontSize: 12.5, cursor: "pointer" } }, previewRaw ? "Rendered" : "Raw") : null;
      return h(Portal, { onClose: function () { closeFilePreview(); } },
        h("div", { onClick: function () { closeFilePreview(); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483300, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: isNarrow ? "0" : "3vh 2vw" } },
          h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: isNarrow ? "100vw" : "min(900px, 96vw)", height: isNarrow ? "100vh" : "86vh", background: cardBg, border: isNarrow ? "none" : "1px solid " + borderC, borderRadius: isNarrow ? 0 : 14, boxShadow: "0 24px 70px rgba(0,0,0,.6)", display: "flex", flexDirection: "column", overflow: "hidden" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderBottom: "1px solid " + borderC, flex: "0 0 auto" } },
              filePreviewStack.length ? h("button", { onClick: function () { backFilePreview(); }, title: "Back to previous file (Esc)", style: { flex: "0 0 auto", background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 8, padding: "7px 10px", fontSize: 12.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 } }, h("span", { style: { fontSize: 14, lineHeight: 1 } }, "\u2190"), "Back") : null,
              h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                h("div", { style: { fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, fp.name || fp.path),
                h("div", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: fp.path }, fp.path),
                fp.orig ? h("div", { style: { fontSize: 10.5, color: muted, marginTop: 1 } }, "auto-resolved from \u201c" + fp.orig + "\u201d") : null),
              mdToggle,
              h("a", { href: filesDownloadHref(fp.path), target: "_blank", rel: "noopener noreferrer", style: { flex: "0 0 auto", textDecoration: "none", background: "transparent", color: accent, border: "1px solid " + borderC, borderRadius: 8, padding: "7px 13px", fontSize: 12.5 } }, "Download"),
              h("button", { onClick: function () { closeFilePreview(); }, "data-tl-close": "1", title: "Close (Esc)", style: { flex: "0 0 auto", background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 9, padding: 8, cursor: "pointer", display: "inline-flex" } }, XIcon(20))),
            h("div", { style: { flex: "1 1 auto", overflow: "auto", padding: isNarrow ? "14px 16px" : "18px 22px" } }, body))));
    }

    return h("div", { style: { display: "flex", flexDirection: isNarrow ? "column" : "row", alignItems: isNarrow ? "stretch" : "flex-start", fontFamily: "inherit" } }, (isNarrow && !sidebarOpen) ? null : sidebar, main, modal(), createModal(), listDeleteModal(), filePreviewModal());
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

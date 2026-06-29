/**
 * Task List — ClickUp-style list view for the Hermes Kanban board.
 *
 * No build step. Plain IIFE using the Hermes Plugin SDK globals.
 * Reuses /api/plugins/kanban/* (the same backend the board uses).
 *
 *   - Group by Status / Assignee / Priority / Tenant / Project / None
 *   - Sort within group by Priority / Created / Title (asc/desc)
 *   - Search, filter by tenant & assignee, show archived
 *   - Inline edit per row: Status, Priority, Assignee (PATCH /tasks/:id)
 *   - Click a row -> detail modal with all info (body, summary, links,
 *     comments, runs, meta) and editable title + status/priority/assignee
 *   - Board switcher + live polling on latest_event_id
 *
 * Drop into <hermes plugins dir>/tasklist/ and rescan/restart the dashboard.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;
  var Fragment = React.Fragment;
  var hooks = SDK.hooks;
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useMemo = hooks.useMemo;
  var useCallback = hooks.useCallback;
  var useRef = hooks.useRef;

  var API = "/api/plugins/kanban";
  var LS_BOARD = "tasklist.board";
  var LS_GROUP = "tasklist.groupBy";
  var POLL_MS = 4000;

  var STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
  var STATUS = {
    triage:    { label: "Triage",    dot: "#a1a1aa" },
    todo:      { label: "To Do",     dot: "#94a3b8" },
    scheduled: { label: "Scheduled", dot: "#818cf8" },
    ready:     { label: "Ready",     dot: "#38bdf8" },
    running:   { label: "Running",   dot: "#fbbf24" },
    blocked:   { label: "Blocked",   dot: "#f87171" },
    review:    { label: "Review",    dot: "#c084fc" },
    done:      { label: "Done",      dot: "#34d399" },
    archived:  { label: "Archived",  dot: "#52525b" }
  };
  // statuses a human may set directly. 'running' is rejected by the backend
  // (must go through the dispatcher); 'archived' is a delete/archive op.
  var SETTABLE = ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"];

  function statusMeta(s) { return STATUS[s] || { label: s || "?", dot: "#71717a" }; }

  function priorityBucket(p) {
    p = p == null ? 0 : p;
    if (p >= 3) return { label: "Urgent", color: "#f87171" };
    if (p === 2) return { label: "High", color: "#fb923c" };
    if (p === 1) return { label: "Normal", color: "#38bdf8" };
    return { label: "Low", color: "#71717a" };
  }

  function ago(epochSec, nowSec) {
    if (epochSec == null) return "";
    var d = Math.max(0, (nowSec || Math.floor(Date.now() / 1000)) - epochSec);
    if (d < 60) return d + "s";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    if (d < 2592000) return Math.floor(d / 86400) + "d";
    return Math.floor(d / 2592000) + "mo";
  }
  function whenFull(epochSec) {
    if (epochSec == null) return "";
    try { return new Date(epochSec * 1000).toLocaleString(); } catch (e) { return String(epochSec); }
  }

  function Caret(open) {
    return h("svg", {
      width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round",
      style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" }
    }, h("polyline", { points: "9 6 15 12 9 18" }));
  }
  function Dot(color, size) {
    return h("span", { style: { display: "inline-block", width: (size || 8) + "px", height: (size || 8) + "px", borderRadius: "50%", background: color, flex: "0 0 auto" } });
  }
  function CommentIcon() {
    return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }));
  }
  function XIcon() {
    return h("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 }));
  }

  function getJSON(path) { return SDK.fetchJSON(path); }
  function patchTask(id, body, board) {
    var q = board ? ("?board=" + encodeURIComponent(board)) : "";
    return SDK.fetchJSON(API + "/tasks/" + encodeURIComponent(id) + q, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  function asgName(x) { return typeof x === "string" ? x : (x && (x.name || x.assignee)) || ""; }

  // shared theme tokens
  var muted = "var(--muted-foreground, #9ca3af)";
  var borderC = "var(--border, #2a2a2a)";
  var cardBg = "var(--card, var(--background, #111))";
  var bgMuted = "var(--muted, rgba(255,255,255,.03))";

  // a styled native <select> that doesn't bubble its click to the row
  function editSelect(value, onChange, options, title, opts) {
    opts = opts || {};
    return h("span", { onClick: function (e) { e.stopPropagation(); } },
      h("select", {
        value: value, title: title || "", "aria-label": title || "",
        onChange: function (e) { onChange(e.target.value); },
        className: "font-courier",
        style: {
          background: "transparent", color: "inherit",
          border: "1px solid " + borderC, borderRadius: opts.pill ? 999 : 4,
          padding: opts.pill ? "2px 7px" : "4px 8px", fontSize: opts.small ? 11 : 12, cursor: "pointer",
          maxWidth: opts.maxWidth || "none"
        }
      }, options.map(function (o) {
        return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label);
      })));
  }

  function statusOptions(t) {
    var opts = SETTABLE.map(function (st) { return { value: st, label: statusMeta(st).label }; });
    if (SETTABLE.indexOf(t.status) === -1) opts.unshift({ value: t.status, label: statusMeta(t.status).label });
    return opts;
  }
  function prioOptions(t) {
    var base = [{ value: "3", label: "Urgent" }, { value: "2", label: "High" }, { value: "1", label: "Normal" }, { value: "0", label: "Low" }];
    var cur = t.priority == null ? 0 : t.priority;
    if ([0, 1, 2, 3].indexOf(cur) === -1) base.unshift({ value: String(cur), label: "P" + cur });
    return base;
  }

  // =========================================================================
  function TaskListPage() {
    var bInit = (function () { try { return localStorage.getItem(LS_BOARD) || ""; } catch (e) { return ""; } })();
    var gInit = (function () { try { return localStorage.getItem(LS_GROUP) || "status"; } catch (e) { return "status"; } })();

    var s;
    s = useState([]); var boards = s[0], setBoards = s[1];
    s = useState(bInit); var board = s[0], setBoard = s[1];
    s = useState(null); var data = s[0], setData = s[1];
    s = useState(true); var loading = s[0], setLoading = s[1];
    s = useState(null); var error = s[0], setError = s[1];
    s = useState([]); var asgOpts = s[0], setAsgOpts = s[1];

    s = useState(gInit); var groupBy = s[0], setGroupBy = s[1];
    s = useState("priority"); var sortBy = s[0], setSortBy = s[1];
    s = useState("desc"); var sortDir = s[0], setSortDir = s[1];
    s = useState(""); var search = s[0], setSearch = s[1];
    s = useState(""); var fTenant = s[0], setFTenant = s[1];
    s = useState(""); var fAssignee = s[0], setFAssignee = s[1];
    s = useState(false); var showArchived = s[0], setShowArchived = s[1];

    s = useState({}); var collapsed = s[0], setCollapsed = s[1];
    s = useState(null); var modalId = s[0], setModalId = s[1];
    s = useState({}); var detail = s[0], setDetail = s[1];
    s = useState(null); var notice = s[0], setNotice = s[1];
    s = useState(""); var titleDraft = s[0], setTitleDraft = s[1];

    var lastEvent = useRef(-1);
    var boardRef = useRef(board); boardRef.current = board;

    useEffect(function () { try { localStorage.setItem(LS_GROUP, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);

    // board list + assignee roster (once)
    useEffect(function () {
      getJSON(API + "/boards").then(function (r) {
        setBoards((r && r.boards) || []);
        if (!boardRef.current && r && r.current) setBoard(r.current);
      }).catch(function () {});
    }, []);
    var loadAssignees = useCallback(function () {
      var q = board ? ("?board=" + encodeURIComponent(board)) : "";
      getJSON(API + "/assignees" + q).then(function (r) {
        var arr = (r && r.assignees) || [];
        setAsgOpts(arr.map(asgName).filter(Boolean));
      }).catch(function () {});
    }, [board]);
    useEffect(function () { loadAssignees(); }, [loadAssignees]);

    var load = useCallback(function (silent) {
      if (!silent) setLoading(true);
      var q = "?include_archived=" + (showArchived ? "true" : "false");
      if (board) q += "&board=" + encodeURIComponent(board);
      getJSON(API + "/board" + q).then(function (r) {
        lastEvent.current = r.latest_event_id;
        setData(r); setError(null); setLoading(false);
      }).catch(function (e) { setError((e && e.message) || "Failed to load board"); setLoading(false); });
    }, [board, showArchived]);
    useEffect(function () { load(false); }, [load]);

    // live polling — refetch only when the event log advanced
    useEffect(function () {
      var t = setInterval(function () {
        if (document.hidden) return;
        var q = "?include_archived=" + (showArchived ? "true" : "false");
        if (boardRef.current) q += "&board=" + encodeURIComponent(boardRef.current);
        getJSON(API + "/board" + q).then(function (r) {
          if (r.latest_event_id !== lastEvent.current) { lastEvent.current = r.latest_event_id; setData(r); }
        }).catch(function () {});
      }, POLL_MS);
      return function () { clearInterval(t); };
    }, [showArchived]);

    var tasks = useMemo(function () {
      if (!data || !data.columns) return [];
      var out = []; data.columns.forEach(function (c) { (c.tasks || []).forEach(function (t) { out.push(t); }); });
      return out;
    }, [data]);
    var taskById = useMemo(function () { var m = {}; tasks.forEach(function (t) { m[t.id] = t; }); return m; }, [tasks]);

    var tenants = (data && data.tenants) || [];
    var assignees = (data && data.assignees) || [];
    var assigneeChoices = (asgOpts && asgOpts.length) ? asgOpts : assignees;
    var now = (data && data.now) || Math.floor(Date.now() / 1000);

    // ---- detail loading -----------------------------------------------------
    var loadDetail = useCallback(function (id, force) {
      if (!id) return;
      if (!force && detail[id]) return;
      var q = board ? ("?board=" + encodeURIComponent(board)) : "";
      getJSON(API + "/tasks/" + encodeURIComponent(id) + q).then(function (d) {
        setDetail(function (m) { var n = Object.assign({}, m); n[id] = d; return n; });
      }).catch(function () {
        setDetail(function (m) { var n = Object.assign({}, m); n[id] = { _error: true }; return n; });
      });
    }, [board, detail]);

    useEffect(function () { if (modalId) loadDetail(modalId, false); }, [modalId]); // eslint-disable-line

    // modal: seed title draft + Escape to close
    useEffect(function () {
      if (!modalId) return;
      var t = taskById[modalId];
      setTitleDraft(t ? (t.title || "") : "");
      function onKey(e) { if (e.key === "Escape") setModalId(null); }
      window.addEventListener("keydown", onKey);
      return function () { window.removeEventListener("keydown", onKey); };
    }, [modalId]); // eslint-disable-line

    // ---- edits --------------------------------------------------------------
    var applyEdit = useCallback(function (t, body, label) {
      setNotice(null);
      return patchTask(t.id, body, board).then(function () {
        loadDetail(t.id, true);
        load(true);
        if (body.assignee !== undefined) loadAssignees();
      }).catch(function (e) {
        setNotice("Could not update \u201c" + (t.title || t.id) + "\u201d" + (label ? " (" + label + ")" : "") + ": " + ((e && e.message) || "not allowed") + ". Reloading.");
        load(true);
      });
    }, [board, load, loadDetail, loadAssignees]);

    function setStatus(t, v) { if (v !== t.status) applyEdit(t, { status: v }, "status"); }
    function setPriority(t, v) { var n = parseInt(v, 10); if (n !== (t.priority == null ? 0 : t.priority)) applyEdit(t, { priority: n }, "priority"); }
    function setAssignee(t, v) { if ((v || "") !== (t.assignee || "")) applyEdit(t, { assignee: v }, "assignee"); }
    function saveTitle(t) {
      var v = titleDraft.trim();
      if (!v || v === (t.title || "")) return;
      applyEdit(t, { title: v }, "title");
    }

    // ---- filtering / grouping ----------------------------------------------
    var filtered = useMemo(function () {
      var q = search.trim().toLowerCase();
      return tasks.filter(function (t) {
        if (fTenant && (t.tenant || "") !== fTenant) return false;
        if (fAssignee && (t.assignee || "") !== fAssignee) return false;
        if (q) { var hay = ((t.title || "") + " " + (t.id || "") + " " + (t.body || "")).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
        return true;
      });
    }, [tasks, search, fTenant, fAssignee]);

    var groups = useMemo(function () {
      function keyOf(t) {
        switch (groupBy) {
          case "assignee": return t.assignee || "\u0000Unassigned";
          case "tenant":   return t.tenant || "\u0000No tenant";
          case "project":  return t.project_id || "\u0000No project";
          case "priority": return "p:" + (t.priority == null ? 0 : t.priority);
          case "none":     return "\u0000All tasks";
          default:         return t.status || "todo";
        }
      }
      var map = {};
      filtered.forEach(function (t) { var k = keyOf(t); (map[k] || (map[k] = [])).push(t); });
      var dir = sortDir === "asc" ? 1 : -1;
      Object.keys(map).forEach(function (k) {
        map[k].sort(function (a, b) {
          var av, bv;
          if (sortBy === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); }
          else if (sortBy === "created") { av = a.created_at || 0; bv = b.created_at || 0; }
          else { av = a.priority == null ? 0 : a.priority; bv = b.priority == null ? 0 : b.priority; }
          if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
        });
      });
      var keys = Object.keys(map);
      if (groupBy === "status") keys.sort(function (a, b) { return STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b); });
      else if (groupBy === "priority") keys.sort(function (a, b) { return parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10); });
      else keys.sort(function (a, b) { var ae = a.charCodeAt(0) === 0, be = b.charCodeAt(0) === 0; if (ae !== be) return ae ? 1 : -1; return a.localeCompare(b); });
      return keys.map(function (k) { return { key: k, items: map[k] }; });
    }, [filtered, groupBy, sortBy, sortDir]);

    function groupHeader(k) {
      if (groupBy === "status") { var m = statusMeta(k); return { label: m.label, dot: m.dot }; }
      if (groupBy === "priority") { var b = priorityBucket(parseInt(k.slice(2), 10)); return { label: b.label + " (P" + k.slice(2) + ")", dot: b.color }; }
      if (k.charCodeAt(0) === 0) return { label: k.slice(1), dot: "#52525b" };
      return { label: k, dot: "#64748b" };
    }
    function toggleGroup(k) { setCollapsed(function (c) { var n = Object.assign({}, c); n[k] = !n[k]; return n; }); }

    function badge(text, color) {
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, lineHeight: 1, padding: "3px 7px", borderRadius: 999, border: "1px solid " + borderC, whiteSpace: "nowrap" } },
        color ? Dot(color, 7) : null, text);
    }

    // ---- toolbar ------------------------------------------------------------
    function plainSelect(value, onChange, options, aria) {
      return h("select", {
        value: value, "aria-label": aria, onChange: function (e) { onChange(e.target.value); }, className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" }
      }, options.map(function (o) { return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label); }));
    }
    var toolbar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 } },
      boards && boards.length > 1 ? plainSelect(board, setBoard, boards.map(function (b) { return { value: b.slug, label: (b.label || b.name || b.slug) + " (" + (b.total != null ? b.total : "?") + ")" }; }), "Board") : null,
      h("span", { style: { fontSize: 11, color: muted } }, "Group"),
      plainSelect(groupBy, setGroupBy, [{ value: "status", label: "Status" }, { value: "assignee", label: "Assignee" }, { value: "priority", label: "Priority" }, { value: "tenant", label: "Tenant" }, { value: "project", label: "Project" }, { value: "none", label: "None" }], "Group by"),
      h("span", { style: { fontSize: 11, color: muted } }, "Sort"),
      plainSelect(sortBy, setSortBy, [{ value: "priority", label: "Priority" }, { value: "created", label: "Created" }, { value: "title", label: "Title" }], "Sort by"),
      h("button", { onClick: function () { setSortDir(sortDir === "asc" ? "desc" : "asc"); }, title: "Toggle sort direction", className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 9px", fontSize: 12, cursor: "pointer" } }, sortDir === "asc" ? "\u2191 Asc" : "\u2193 Desc"),
      h("input", { value: search, placeholder: "Search title / id / body\u2026", onChange: function (e) { setSearch(e.target.value); }, className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, minWidth: 180, flex: "1 1 180px" } }),
      tenants.length ? plainSelect(fTenant, setFTenant, [{ value: "", label: "All tenants" }].concat(tenants.map(function (x) { return { value: x, label: x }; })), "Filter tenant") : null,
      assigneeChoices.length ? plainSelect(fAssignee, setFAssignee, [{ value: "", label: "All assignees" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Filter assignee") : null,
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: showArchived, onChange: function (e) { setShowArchived(e.target.checked); } }), "Archived")
    );

    // ---- row ----------------------------------------------------------------
    function taskRow(t) {
      var pri = priorityBucket(t.priority);
      var prog = t.progress;
      return h("div", {
        key: t.id, onClick: function () { setModalId(t.id); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 13 },
        onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; },
        onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
      },
        Dot(pri.color, 8),
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title || "(untitled)"),
        prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
        (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null),
        editSelect(t.status, function (v) { setStatus(t, v); }, statusOptions(t), "Status", { pill: true, small: true }),
        editSelect(String(t.priority == null ? 0 : t.priority), function (v) { setPriority(t, v); }, prioOptions(t), "Priority", { pill: true, small: true }),
        editSelect(t.assignee || "", function (v) { setAssignee(t, v); }, [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Assignee", { pill: true, small: true, maxWidth: "140px" }),
        (t.tenant ? h("span", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)" } }, t.tenant) : null),
        h("span", { style: { fontSize: 11, color: muted, width: 34, textAlign: "right", flex: "0 0 auto" } }, ago(t.created_at, now))
      );
    }

    function groupBlock(g) {
      var head = groupHeader(g.key);
      var isCollapsed = !!collapsed[g.key];
      var doneCount = g.items.filter(function (t) { return t.status === "done"; }).length;
      return h("div", { key: g.key, style: { border: "1px solid " + borderC, borderRadius: 8, overflow: "hidden", marginBottom: 10 } },
        h("div", { onClick: function () { toggleGroup(g.key); },
          style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", background: bgMuted, userSelect: "none" } },
          h("span", { style: { color: muted, display: "inline-flex" } }, Caret(!isCollapsed)),
          Dot(head.dot, 9),
          h("span", { style: { fontWeight: 600, fontSize: 13 } }, head.label),
          h("span", { style: { fontSize: 11, color: muted } }, g.items.length + (doneCount ? "  \u00b7  " + doneCount + " done" : ""))
        ),
        isCollapsed ? null : h("div", null, g.items.map(function (t) { return taskRow(t); }))
      );
    }

    // ---- detail modal -------------------------------------------------------
    function modal() {
      if (!modalId) return null;
      var t = taskById[modalId];
      if (!t) return null;
      var d = detail[modalId];
      var task = (d && d.task) || t;
      var pri = priorityBucket(t.priority);

      function field(labelTxt, control) {
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 120 } },
          h("span", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: muted } }, labelTxt), control);
      }

      var editRow = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 16, padding: "14px 0", borderBottom: "1px solid " + borderC } },
        field("Status", editSelect(t.status, function (v) { setStatus(t, v); }, statusOptions(t), "Status", {})),
        field("Priority", editSelect(String(t.priority == null ? 0 : t.priority), function (v) { setPriority(t, v); }, prioOptions(t), "Priority", {})),
        field("Assignee", editSelect(t.assignee || "", function (v) { setAssignee(t, v); }, [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Assignee", {})),
        t.tenant ? field("Tenant", h("span", { style: { fontSize: 12, fontFamily: "var(--font-courier, monospace)" } }, t.tenant)) : null,
        t.project_id ? field("Project", h("span", { style: { fontSize: 12, fontFamily: "var(--font-courier, monospace)" } }, t.project_id)) : null
      );

      var rows = [];
      if (task.body) rows.push(h("div", { key: "body", style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55 } }, task.body));
      else if (!d) rows.push(h("div", { key: "ld", style: { fontSize: 12, color: muted } }, "Loading details\u2026"));
      if (d && d._error) rows.push(h("div", { key: "er", style: { fontSize: 12, color: "#f87171" } }, "Failed to load full details (status/priority/assignee editing still works)."));

      if (task.latest_summary) rows.push(h("div", { key: "sum", style: { fontSize: 12.5, color: muted, borderLeft: "2px solid " + borderC, paddingLeft: 12 } },
        h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, marginBottom: 3 } }, "Latest run summary"), task.latest_summary));

      var meta = [];
      if (task.workspace_path) meta.push("workspace: " + task.workspace_kind + " \u00b7 " + task.workspace_path);
      else if (task.workspace_kind) meta.push("workspace: " + task.workspace_kind);
      if (task.created_by) meta.push("by " + task.created_by);
      if (task.model_override) meta.push("model: " + task.model_override);
      meta.push("created " + whenFull(task.created_at));
      if (task.started_at) meta.push("started " + whenFull(task.started_at));
      if (task.completed_at) meta.push("done " + whenFull(task.completed_at));
      rows.push(h("div", { key: "meta", style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)" } }, meta.join("   \u00b7   ")));

      var links = d && d.links;
      if (links && (((links.parents || []).length) || ((links.children || []).length))) {
        function linkList(title, arr) {
          if (!arr || !arr.length) return null;
          return h("div", { style: { fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
            h("span", { style: { color: muted } }, title),
            arr.map(function (x, i) {
              var lid = x.id || x.child_id || x.parent_id;
              var lt = x.title || lid || "?";
              return h("span", { key: i, onClick: function () { if (lid && taskById[lid]) setModalId(lid); }, style: { cursor: lid && taskById[lid] ? "pointer" : "default", textDecoration: lid && taskById[lid] ? "underline dotted" : "none" } },
                x.status ? Dot(statusMeta(x.status).dot, 7) : null, " ", lt);
            }));
        }
        rows.push(h("div", { key: "links", style: { display: "flex", flexDirection: "column", gap: 6 } }, linkList("Parents", links.parents), linkList("Children", links.children)));
      }

      var comments = (d && d.comments) || [];
      if (comments.length) rows.push(h("div", { key: "cm", style: { display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Comments (" + comments.length + ")"),
        comments.map(function (c, i) { return h("div", { key: i, style: { fontSize: 12.5, borderLeft: "2px solid " + borderC, paddingLeft: 12 } },
          h("span", { style: { color: muted, marginRight: 6 } }, (c.author || c.created_by || "?") + ":"), c.body || c.text || ""); })));

      var runs = (d && d.runs) || [];
      if (runs.length) rows.push(h("div", { key: "runs", style: { display: "flex", flexDirection: "column", gap: 4 } },
        h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Runs (" + runs.length + ")"),
        runs.slice(0, 8).map(function (r, i) { return h("div", { key: i, style: { fontSize: 11.5, color: muted, fontFamily: "var(--font-courier, monospace)" } },
          (r.outcome || r.state || "?") + (r.profile ? " \u00b7 " + r.profile : "") + (r.started_at ? " \u00b7 " + whenFull(r.started_at) : "")); })));

      var panel = h("div", {
        onClick: function (e) { e.stopPropagation(); },
        style: {
          width: "min(760px, 94vw)", maxHeight: "88vh", overflow: "auto", background: cardBg,
          border: "1px solid " + borderC, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.55)",
          display: "flex", flexDirection: "column"
        }
      },
        // header
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px", borderBottom: "1px solid " + borderC, position: "sticky", top: 0, background: cardBg, zIndex: 1 } },
          Dot(pri.color, 10),
          h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
            h("input", {
              value: titleDraft, onChange: function (e) { setTitleDraft(e.target.value); },
              onBlur: function () { saveTitle(t); },
              onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
              className: "font-courier",
              style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid transparent", borderRadius: 6, padding: "4px 6px", fontSize: 16, fontWeight: 700 },
              onFocus: function (e) { e.target.style.border = "1px solid " + borderC; },
              title: "Edit title (Enter to save)"
            }),
            h("div", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)", padding: "2px 6px" } }, t.id)
          ),
          h("button", { onClick: function () { setModalId(null); }, title: "Close (Esc)",
            style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 8, padding: 6, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon())
        ),
        h("div", { style: { padding: "0 18px 18px" } }, editRow, h("div", { style: { display: "flex", flexDirection: "column", gap: 14, paddingTop: 14 } }, rows))
      );

      return h("div", {
        onClick: function () { setModalId(null); },
        style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 12px" }
      }, panel);
    }

    // ---- page ---------------------------------------------------------------
    var total = filtered.length;
    return h("div", { className: "flex flex-col gap-2", style: { fontFamily: "inherit" } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        h("h1", { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, "List"),
        h("span", { style: { fontSize: 12, color: muted } }, loading ? "Loading\u2026" : (total + " task" + (total === 1 ? "" : "s") + (tasks.length !== total ? " of " + tasks.length : "")))
      ),
      toolbar,
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      (!error && !loading && !groups.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, "No tasks match.") : null,
      groups.map(function (g) { return groupBlock(g); }),
      modal()
    );
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

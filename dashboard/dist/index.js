/**
 * Task List — ClickUp-style list view for the Hermes Kanban board.
 *
 * No build step. Plain IIFE using the Hermes Plugin SDK globals.
 * Tasks come from /api/plugins/kanban/* ; custom Groups + Lists come from the
 * companion backend /api/plugins/tasklist/* (this plugin's plugin_api.py).
 *
 * Layout (like ClickUp):
 *   - Left sidebar: create GROUPS and, inside them, LISTS. Click a list to open
 *     it. "All tasks" and "No list" are always available. Drag a task row onto
 *     a list in the sidebar to move it there.
 *   - Main: the selected list's tasks grouped by STATUS (todo/done/… as
 *     collapsible sections), with inline status/priority/assignee/list editing,
 *     a "+ Add task" row per status, and a task detail popup.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks;
  var useState = hooks.useState, useEffect = hooks.useEffect, useMemo = hooks.useMemo, useCallback = hooks.useCallback, useRef = hooks.useRef;

  var KAPI = "/api/plugins/kanban";
  var TLAPI = "/api/plugins/tasklist";
  var LS_BOARD = "tasklist.board", LS_SCOPE = "tasklist.scope", LS_GROUPBY = "tasklist.groupBy";
  var POLL_MS = 4000;

  var STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
  var STATUS = {
    triage: { label: "Triage", dot: "#a1a1aa" }, todo: { label: "To Do", dot: "#94a3b8" },
    scheduled: { label: "Scheduled", dot: "#818cf8" }, ready: { label: "Ready", dot: "#38bdf8" },
    running: { label: "Running", dot: "#fbbf24" }, blocked: { label: "Blocked", dot: "#f87171" },
    review: { label: "Review", dot: "#c084fc" }, done: { label: "Done", dot: "#34d399" }, archived: { label: "Archived", dot: "#52525b" }
  };
  var SETTABLE = ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"];
  var LIST_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#fb923c", "#818cf8", "#2dd4bf"];

  function statusMeta(s) { return STATUS[s] || { label: s || "?", dot: "#71717a" }; }
  function priorityBucket(p) { p = p == null ? 0 : p; if (p >= 3) return { label: "Urgent", color: "#f87171" }; if (p === 2) return { label: "High", color: "#fb923c" }; if (p === 1) return { label: "Normal", color: "#38bdf8" }; return { label: "Low", color: "#71717a" }; }
  function ago(e, now) { if (e == null) return ""; var d = Math.max(0, (now || Math.floor(Date.now() / 1000)) - e); if (d < 60) return d + "s"; if (d < 3600) return Math.floor(d / 60) + "m"; if (d < 86400) return Math.floor(d / 3600) + "h"; if (d < 2592000) return Math.floor(d / 86400) + "d"; return Math.floor(d / 2592000) + "mo"; }
  function whenFull(e) { if (e == null) return ""; try { return new Date(e * 1000).toLocaleString(); } catch (x) { return String(e); } }
  function asgName(x) { return typeof x === "string" ? x : (x && (x.name || x.assignee)) || ""; }

  function Caret(open, sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" } }, h("polyline", { points: "9 6 15 12 9 18" })); }
  function Dot(c, s) { return h("span", { style: { display: "inline-block", width: (s || 8) + "px", height: (s || 8) + "px", borderRadius: "50%", background: c, flex: "0 0 auto" } }); }
  function Grip() { return h("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", style: { flex: "0 0 auto", opacity: .5 } }, h("circle", { cx: 9, cy: 6, r: 1.6 }), h("circle", { cx: 15, cy: 6, r: 1.6 }), h("circle", { cx: 9, cy: 12, r: 1.6 }), h("circle", { cx: 15, cy: 12, r: 1.6 }), h("circle", { cx: 9, cy: 18, r: 1.6 }), h("circle", { cx: 15, cy: 18, r: 1.6 })); }
  function CommentIcon() { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" })); }
  function XIcon(sz) { sz = sz || 16; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })); }
  function PlusIcon(sz) { sz = sz || 14; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }, h("line", { x1: 12, y1: 5, x2: 12, y2: 19 }), h("line", { x1: 5, y1: 12, x2: 19, y2: 12 })); }

  function getJSON(p) { return SDK.fetchJSON(p); }
  function send(method, p, body) { return SDK.fetchJSON(p, { method: method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }); }

  var muted = "var(--muted-foreground, #9ca3af)";
  var borderC = "var(--border, #2a2a2a)";
  var cardBg = "var(--card, var(--background, #111))";
  var bgMuted = "var(--muted, rgba(255,255,255,.03))";
  var accent = "var(--primary, #6366f1)";

  function editSelect(value, onChange, options, title, opts) {
    opts = opts || {};
    return h("span", { onClick: function (e) { e.stopPropagation(); } },
      h("select", { value: value, title: title || "", "aria-label": title || "", onChange: function (e) { onChange(e.target.value); }, className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: opts.pill ? 999 : 4, padding: opts.pill ? "2px 7px" : "4px 8px", fontSize: opts.small ? 11 : 12, cursor: "pointer", maxWidth: opts.maxWidth || "none" } },
        options.map(function (o) { return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label); })));
  }
  function statusOptions(t) { var o = SETTABLE.map(function (st) { return { value: st, label: statusMeta(st).label }; }); if (SETTABLE.indexOf(t.status) === -1) o.unshift({ value: t.status, label: statusMeta(t.status).label }); return o; }
  function prioOptions(t) { var b = [{ value: "3", label: "Urgent" }, { value: "2", label: "High" }, { value: "1", label: "Normal" }, { value: "0", label: "Low" }]; var c = t.priority == null ? 0 : t.priority; if ([0, 1, 2, 3].indexOf(c) === -1) b.unshift({ value: String(c), label: "P" + c }); return b; }

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

    s = useState([]); var groups = s[0], setGroups = s[1];
    s = useState([]); var lists = s[0], setLists = s[1];
    s = useState({}); var membership = s[0], setMembership = s[1];

    s = useState(rdj(LS_SCOPE, { type: "all" })); var scope = s[0], setScope = s[1];
    s = useState({}); var collapsedGroups = s[0], setCollapsedGroups = s[1];
    s = useState(null); var adding = s[0], setAdding = s[1];          // {kind:'group'|'list', groupId}
    s = useState(""); var addName = s[0], setAddName = s[1];
    s = useState(null); var editing = s[0], setEditing = s[1];        // {kind:'group'|'list', id}
    s = useState(""); var editName = s[0], setEditName = s[1];
    s = useState(null); var dragId = s[0], setDragId = s[1];
    s = useState(null); var dropList = s[0], setDropList = s[1];      // sidebar list id (or "__none") being hovered

    s = useState(rd(LS_GROUPBY, "status")); var groupBy = s[0], setGroupBy = s[1];
    s = useState("priority"); var sortBy = s[0], setSortBy = s[1];
    s = useState("desc"); var sortDir = s[0], setSortDir = s[1];
    s = useState(""); var search = s[0], setSearch = s[1];
    s = useState(""); var fAssignee = s[0], setFAssignee = s[1];
    s = useState(false); var showArchived = s[0], setShowArchived = s[1];

    s = useState({}); var collapsedSec = s[0], setCollapsedSec = s[1];
    s = useState(null); var addTaskSec = s[0], setAddTaskSec = s[1];  // status section with open add input
    s = useState(""); var addTaskTitle = s[0], setAddTaskTitle = s[1];
    s = useState(null); var modalId = s[0], setModalId = s[1];
    s = useState({}); var detail = s[0], setDetail = s[1];
    s = useState(null); var notice = s[0], setNotice = s[1];
    s = useState(""); var titleDraft = s[0], setTitleDraft = s[1];

    var lastEvent = useRef(-1);
    var boardRef = useRef(board); boardRef.current = board;
    var dragRef = useRef(null);

    useEffect(function () { try { localStorage.setItem(LS_GROUPBY, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);
    useEffect(function () { try { localStorage.setItem(LS_SCOPE, JSON.stringify(scope)); } catch (e) {} }, [scope]);

    var bq = useCallback(function (extra) { var q = board ? ("?board=" + encodeURIComponent(board)) : ""; return extra ? (q ? q + "&" + extra : "?" + extra) : q; }, [board]);

    useEffect(function () { getJSON(KAPI + "/boards").then(function (r) { setBoards((r && r.boards) || []); if (!boardRef.current && r && r.current) setBoard(r.current); }).catch(function () {}); }, []);
    var loadAssignees = useCallback(function () { getJSON(KAPI + "/assignees" + bq()).then(function (r) { setAsgOpts(((r && r.assignees) || []).map(asgName).filter(Boolean)); }).catch(function () {}); }, [bq]);
    useEffect(function () { loadAssignees(); }, [loadAssignees]);

    var loadTree = useCallback(function () {
      getJSON(TLAPI + "/lists" + bq()).then(function (r) { setGroups((r && r.groups) || []); setLists((r && r.lists) || []); setMembership((r && r.membership) || {}); })
        .catch(function () { setGroups([]); setLists([]); setMembership({}); });
    }, [bq]);
    useEffect(function () { loadTree(); }, [loadTree]);

    var load = useCallback(function (silent) {
      if (!silent) setLoading(true);
      getJSON(KAPI + "/board" + bq("include_archived=" + (showArchived ? "true" : "false"))).then(function (r) { lastEvent.current = r.latest_event_id; setData(r); setError(null); setLoading(false); })
        .catch(function (e) { setError((e && e.message) || "Failed to load board"); setLoading(false); });
    }, [bq, showArchived]);
    useEffect(function () { load(false); }, [load]);

    useEffect(function () {
      var t = setInterval(function () {
        if (document.hidden) return;
        var q = boardRef.current ? ("?board=" + encodeURIComponent(boardRef.current) + "&") : "?";
        getJSON(KAPI + "/board" + q + "include_archived=" + (showArchived ? "true" : "false")).then(function (r) { if (r.latest_event_id !== lastEvent.current) { lastEvent.current = r.latest_event_id; setData(r); } }).catch(function () {});
      }, POLL_MS);
      return function () { clearInterval(t); };
    }, [showArchived]);

    var tasks = useMemo(function () { if (!data || !data.columns) return []; var o = []; data.columns.forEach(function (c) { (c.tasks || []).forEach(function (t) { o.push(t); }); }); return o; }, [data]);
    var taskById = useMemo(function () { var m = {}; tasks.forEach(function (t) { m[t.id] = t; }); return m; }, [tasks]);
    var liveListIds = useMemo(function () { var m = {}; lists.forEach(function (l) { m[l.id] = 1; }); return m; }, [lists]);
    var listsByGroup = useMemo(function () { var m = { "": [] }; groups.forEach(function (g) { m[g.id] = []; }); lists.forEach(function (l) { var k = l.group_id || ""; (m[k] || (m[k] = [])).push(l); }); return m; }, [groups, lists]);
    var memCounts = useMemo(function () { var m = {}; var un = 0; tasks.forEach(function (t) { var lid = membership[t.id]; if (lid && liveListIds[lid]) m[lid] = (m[lid] || 0) + 1; else un++; }); return { byList: m, unassigned: un }; }, [tasks, membership, liveListIds]);

    var assignees = (data && data.assignees) || [];
    var assigneeChoices = (asgOpts && asgOpts.length) ? asgOpts : assignees;
    var now = (data && data.now) || Math.floor(Date.now() / 1000);

    // ---- detail -------------------------------------------------------------
    var loadDetail = useCallback(function (id, force) {
      if (!id || (!force && detail[id])) return;
      getJSON(KAPI + "/tasks/" + encodeURIComponent(id) + bq()).then(function (d) { setDetail(function (m) { var n = Object.assign({}, m); n[id] = d; return n; }); })
        .catch(function () { setDetail(function (m) { var n = Object.assign({}, m); n[id] = { _error: true }; return n; }); });
    }, [bq, detail]);
    useEffect(function () { if (modalId) loadDetail(modalId, false); }, [modalId]); // eslint-disable-line
    useEffect(function () {
      if (!modalId) return; var t = taskById[modalId]; setTitleDraft(t ? (t.title || "") : "");
      function onKey(e) { if (e.key === "Escape") setModalId(null); }
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

    // ---- group / list / membership mutations --------------------------------
    function createGroup(name) { name = (name || "").trim(); if (!name) return; send("POST", TLAPI + "/groups" + bq(), { name: name }).then(function () { setAdding(null); setAddName(""); loadTree(); }).catch(function (e) { setNotice("Could not create group: " + ((e && e.message) || "error")); }); }
    function createList(name, groupId) { name = (name || "").trim(); if (!name) return; var color = LIST_COLORS[lists.length % LIST_COLORS.length]; send("POST", TLAPI + "/lists" + bq(), { name: name, group_id: groupId || null, color: color }).then(function (r) { setAdding(null); setAddName(""); loadTree(); if (r && r.list) setScope({ type: "list", id: r.list.id }); }).catch(function (e) { setNotice("Could not create list: " + ((e && e.message) || "error")); }); }
    function renameNode() { if (!editing) return; var nm = editName.trim(); var cur = editing; setEditing(null); if (!nm) return; var url = (cur.kind === "group" ? "/groups/" : "/lists/") + encodeURIComponent(cur.id); send("PATCH", TLAPI + url + bq(), { name: nm }).then(loadTree).catch(loadTree); }
    function deleteGroup(g) { if (!window.confirm("Delete group \u201c" + g.name + "\u201d? Its lists are kept (moved out of the group).")) return; send("DELETE", TLAPI + "/groups/" + encodeURIComponent(g.id) + bq()).then(loadTree).catch(loadTree); }
    function deleteList(l) { if (!window.confirm("Delete list \u201c" + l.name + "\u201d? Tasks stay on the board, they just leave this list.")) return; send("DELETE", TLAPI + "/lists/" + encodeURIComponent(l.id) + bq()).then(function () { if (scope.type === "list" && scope.id === l.id) setScope({ type: "all" }); loadTree(); }).catch(loadTree); }
    function moveToList(taskId, listId) { if (!taskId) return; send("PUT", TLAPI + "/membership" + bq(), { task_id: taskId, list_id: listId || null }).then(loadTree).catch(function (e) { setNotice("Could not move task: " + ((e && e.message) || "error")); loadTree(); }); }
    function addTask(listId, status, title) {
      title = (title || "").trim(); if (!title) return;
      setNotice(null);
      send("POST", KAPI + "/tasks" + bq(), { title: title, triage: status === "triage" }).then(function (r) {
        var id = r && r.task && r.task.id;
        var p = Promise.resolve();
        if (id && listId) p = send("PUT", TLAPI + "/membership" + bq(), { task_id: id, list_id: listId });
        if (id && status && status !== "triage" && SETTABLE.indexOf(status) !== -1) p = p.then(function () { return send("PATCH", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), { status: status }); });
        return p;
      }).then(function () { setAddTaskTitle(""); load(true); loadTree(); }).catch(function (e) { setNotice("Could not add task: " + ((e && e.message) || "error")); load(true); loadTree(); });
    }

    // ---- scope --------------------------------------------------------------
    var scopeListIds = useMemo(function () {
      if (scope.type === "list") return { single: scope.id, set: null };
      if (scope.type === "group") { var st = {}; (listsByGroup[scope.id] || []).forEach(function (l) { st[l.id] = 1; }); return { single: null, set: st }; }
      return { single: null, set: null };
    }, [scope, listsByGroup]);
    function inScope(t) {
      var lid = membership[t.id]; var inAny = lid && liveListIds[lid];
      if (scope.type === "all") return true;
      if (scope.type === "unassigned") return !inAny;
      if (scope.type === "list") return lid === scope.id;
      if (scope.type === "group") return inAny && scopeListIds.set[lid];
      return true;
    }
    var scopeTitle = useMemo(function () {
      if (scope.type === "all") return "All tasks";
      if (scope.type === "unassigned") return "No list";
      if (scope.type === "group") { var g = groups.filter(function (x) { return x.id === scope.id; })[0]; return g ? g.name : "Group"; }
      var l = lists.filter(function (x) { return x.id === scope.id; })[0]; return l ? l.name : "List";
    }, [scope, groups, lists]);

    var scopeTasks = useMemo(function () {
      var q = search.trim().toLowerCase();
      return tasks.filter(function (t) {
        if (!inScope(t)) return false;
        if (fAssignee && (t.assignee || "") !== fAssignee) return false;
        if (q) { var hay = ((t.title || "") + " " + (t.id || "") + " " + (t.body || "")).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
        return true;
      });
    }, [tasks, scope, membership, liveListIds, search, fAssignee, scopeListIds]);

    // ---- sections (status / assignee / priority / none) ---------------------
    var sections = useMemo(function () {
      var dir = sortDir === "asc" ? 1 : -1;
      function cmp(a, b) { var av, bv; if (sortBy === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); } else if (sortBy === "created") { av = a.created_at || 0; bv = b.created_at || 0; } else { av = a.priority == null ? 0 : a.priority; bv = b.priority == null ? 0 : b.priority; } if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0; }
      var singleList = scope.type === "list";

      if (groupBy === "status") {
        var cols = STATUS_ORDER.filter(function (c) { return c !== "archived" || showArchived; });
        var byCol = {}; scopeTasks.forEach(function (t) { (byCol[t.status] || (byCol[t.status] = [])).push(t); });
        var out = [];
        cols.forEach(function (c) {
          var items = (byCol[c] || []).slice().sort(cmp);
          if (singleList || items.length) { var m = statusMeta(c); out.push({ key: c, label: m.label, dot: m.dot, items: items, status: c }); }
        });
        return out;
      }
      function keyOf(t) { if (groupBy === "assignee") return t.assignee || "\u0000Unassigned"; if (groupBy === "priority") return "p:" + (t.priority == null ? 0 : t.priority); return "\u0000All"; }
      var map = {}; scopeTasks.forEach(function (t) { var k = keyOf(t); (map[k] || (map[k] = [])).push(t); });
      var keys = Object.keys(map);
      if (groupBy === "priority") keys.sort(function (a, b) { return parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10); });
      else keys.sort(function (a, b) { var ae = a.charCodeAt(0) === 0, be = b.charCodeAt(0) === 0; if (ae !== be) return ae ? 1 : -1; return a.localeCompare(b); });
      return keys.map(function (k) {
        var label, dot;
        if (groupBy === "priority") { var pb = priorityBucket(parseInt(k.slice(2), 10)); label = pb.label + " (P" + k.slice(2) + ")"; dot = pb.color; }
        else if (k.charCodeAt(0) === 0) { label = k.slice(1); dot = "#52525b"; }
        else { label = k; dot = "#64748b"; }
        return { key: k, label: label, dot: dot, items: map[k].slice().sort(cmp), status: null };
      });
    }, [scopeTasks, groupBy, sortBy, sortDir, scope, showArchived]);

    // ======================== SIDEBAR =======================================
    function addInput(placeholder, onSubmit) {
      return h("input", { autoFocus: true, value: addName, placeholder: placeholder, onChange: function (e) { setAddName(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") onSubmit(addName); if (e.key === "Escape") { setAdding(null); setAddName(""); } }, onBlur: function () { if (addName.trim()) onSubmit(addName); else { setAdding(null); setAddName(""); } }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "4px 7px", fontSize: 12.5 } });
    }
    function entryRow(opts) {
      // opts: {label, dot, active, count, indent, onClick, onDrop, dropKey, trailing}
      var isOver = opts.dropKey && dropList === opts.dropKey;
      var p = {
        onClick: opts.onClick,
        style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", paddingLeft: (opts.indent || 8) + "px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, background: opts.active ? accent + "26" : (isOver ? accent + "33" : "transparent"), color: opts.active ? "inherit" : "inherit", outline: isOver ? "1px dashed " + accent : "none" },
        onMouseEnter: function (e) { if (!opts.active) e.currentTarget.style.background = bgMuted; },
        onMouseLeave: function (e) { if (!opts.active) e.currentTarget.style.background = isOver ? accent + "33" : "transparent"; }
      };
      if (opts.dropKey) {
        p.onDragOver = function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (x) {} if (dropList !== opts.dropKey) setDropList(opts.dropKey); };
        p.onDragLeave = function (e) { if (e.currentTarget === e.target) setDropList(null); };
        p.onDrop = function (e) { e.preventDefault(); var id = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || dragRef.current; setDropList(null); setDragId(null); if (opts.onDrop) opts.onDrop(id); };
      }
      return h("div", p,
        opts.dot != null ? Dot(opts.dot, 9) : null,
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: opts.active ? 600 : 400 } }, opts.label),
        (opts.count != null ? h("span", { style: { fontSize: 11, color: muted } }, opts.count) : null),
        opts.trailing || null
      );
    }
    function listEntry(l) {
      if (editing && editing.kind === "list" && editing.id === l.id) {
        return h("div", { key: l.id, style: { padding: "2px 8px 2px 22px" } }, h("input", { autoFocus: true, value: editName, onChange: function (e) { setEditName(e.target.value); }, onBlur: renameNode, onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "3px 6px", fontSize: 12.5 } }));
      }
      var del = h("button", { onClick: function (e) { e.stopPropagation(); deleteList(l); }, title: "Delete list", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex", flex: "0 0 auto" } }, XIcon(13));
      return h("div", { key: l.id },
        entryRow({
          label: l.name, dot: l.color || "#64748b", active: scope.type === "list" && scope.id === l.id, count: memCounts.byList[l.id] || 0, indent: 22,
          onClick: function () { if (editing) return; setScope({ type: "list", id: l.id }); }, dropKey: l.id, onDrop: function (id) { moveToList(id, l.id); },
          trailing: del
        }));
    }
    function groupBlock(g) {
      var open = !collapsedGroups[g.id];
      var glists = listsByGroup[g.id] || [];
      var count = glists.reduce(function (n, l) { return n + (memCounts.byList[l.id] || 0); }, 0);
      var header;
      if (editing && editing.kind === "group" && editing.id === g.id) {
        header = h("div", { style: { padding: "2px 8px" } }, h("input", { autoFocus: true, value: editName, onChange: function (e) { setEditName(e.target.value); }, onBlur: renameNode, onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "3px 6px", fontSize: 12.5, fontWeight: 600 } }));
      } else {
        header = h("div", { onClick: function () { setCollapsedGroups(function (c) { var n = Object.assign({}, c); n[g.id] = !n[g.id]; return n; }); }, style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", color: muted, userSelect: "none" }, onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; } },
          h("span", { style: { display: "inline-flex" } }, Caret(open, 11)),
          h("span", { onClick: function (e) { e.stopPropagation(); setEditing({ kind: "group", id: g.id }); setEditName(g.name); }, title: "Rename group", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 } }, g.name),
          h("span", { style: { fontSize: 11 } }, count),
          h("button", { onClick: function (e) { e.stopPropagation(); setAdding({ kind: "list", groupId: g.id }); setAddName(""); }, title: "Add list to group", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex" } }, PlusIcon(13)),
          h("button", { onClick: function (e) { e.stopPropagation(); deleteGroup(g); }, title: "Delete group", style: { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex" } }, XIcon(13))
        );
      }
      return h("div", { key: g.id },
        header,
        open ? h("div", null,
          glists.map(function (l) { return listEntry(l); }),
          adding && adding.kind === "list" && adding.groupId === g.id ? h("div", { style: { padding: "2px 8px 2px 22px" } }, addInput("List name\u2026", function (v) { createList(v, g.id); })) : null
        ) : null
      );
    }
    var ungrouped = listsByGroup[""] || [];
    var sidebar = h("div", { style: { width: 232, flex: "0 0 232px", borderRight: "1px solid " + borderC, paddingRight: 10, marginRight: 14, alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 2, maxHeight: "calc(100vh - 120px)", overflow: "auto", position: "sticky", top: 0 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 8px 6px" } },
        h("span", { style: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: muted, fontWeight: 700, flex: "1 1 auto" } }, "Lists"),
        h("button", { onClick: function () { setAdding({ kind: "group" }); setAddName(""); }, title: "New group", className: "font-courier", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 4, padding: "2px 6px", fontSize: 11, cursor: "pointer" } }, "+ Group"),
        h("button", { onClick: function () { setAdding({ kind: "list", groupId: null }); setAddName(""); }, title: "New list", className: "font-courier", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 4, padding: "2px 6px", fontSize: 11, cursor: "pointer" } }, "+ List")
      ),
      entryRow({ label: "All tasks", dot: null, active: scope.type === "all", count: tasks.length, onClick: function () { setScope({ type: "all" }); } }),
      entryRow({ label: "No list", dot: "#52525b", active: scope.type === "unassigned", count: memCounts.unassigned, onClick: function () { setScope({ type: "unassigned" }); }, dropKey: "__none", onDrop: function (id) { moveToList(id, null); } }),
      adding && adding.kind === "group" ? h("div", { style: { padding: "2px 8px" } }, addInput("Group name\u2026", function (v) { createGroup(v); })) : null,
      ungrouped.length || (adding && adding.kind === "list" && !adding.groupId) ? h("div", { style: { marginTop: 4 } }, ungrouped.map(function (l) { return listEntry(l); }), adding && adding.kind === "list" && !adding.groupId ? h("div", { style: { padding: "2px 8px 2px 22px" } }, addInput("List name\u2026", function (v) { createList(v, null); })) : null) : null,
      groups.length ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 2 } }, groups.map(function (g) { return groupBlock(g); })) : null,
      (!groups.length && !ungrouped.length) ? h("div", { style: { padding: "10px 8px", fontSize: 11.5, color: muted, lineHeight: 1.5 } }, "No lists yet. Click ", h("b", null, "+ List"), " (or ", h("b", null, "+ Group"), ") above, then drag tasks onto a list \u2014 or use the List dropdown on a task.") : null
    );

    // ======================== MAIN ==========================================
    function plainSelect(value, onChange, options, aria) { return h("select", { value: value, "aria-label": aria, onChange: function (e) { onChange(e.target.value); }, className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" } }, options.map(function (o) { return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label); })); }
    var toolbar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 } },
      boards && boards.length > 1 ? plainSelect(board, setBoard, boards.map(function (b) { return { value: b.slug, label: (b.label || b.name || b.slug) + " (" + (b.total != null ? b.total : "?") + ")" }; }), "Board") : null,
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
    var listOpts = [{ value: "", label: "No list" }].concat(lists.map(function (x) { return { value: x.id, label: x.name }; }));

    function taskRow(t) {
      var pri = priorityBucket(t.priority);
      var prog = t.progress;
      return h("div", {
        key: t.id, draggable: true,
        onClick: function () { setModalId(t.id); },
        onDragStart: function (e) { dragRef.current = t.id; setDragId(t.id); try { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} },
        onDragEnd: function () { dragRef.current = null; setDragId(null); setDropList(null); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "1px solid " + borderC, cursor: "grab", fontSize: 13, opacity: dragId === t.id ? .4 : 1 },
        onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
      },
        h("span", { style: { display: "inline-flex", color: muted } }, Grip()),
        Dot(pri.color, 8),
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title || "(untitled)"),
        prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
        (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null),
        editSelect(t.status, function (v) { setStatus(t, v); }, statusOptions(t), "Status", { pill: true, small: true }),
        editSelect(String(t.priority == null ? 0 : t.priority), function (v) { setPriority(t, v); }, prioOptions(t), "Priority", { pill: true, small: true }),
        editSelect(t.assignee || "", function (v) { setAssignee(t, v); }, [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Assignee", { pill: true, small: true, maxWidth: "130px" }),
        editSelect(membership[t.id] && liveListIds[membership[t.id]] ? membership[t.id] : "", function (v) { moveToList(t.id, v || null); }, listOpts, "List", { pill: true, small: true, maxWidth: "120px" }),
        h("span", { style: { fontSize: 11, color: muted, width: 30, textAlign: "right", flex: "0 0 auto" } }, ago(t.created_at, now))
      );
    }

    function addTaskRow(sec) {
      var canAdd = scope.type === "list" && sec.status && (sec.status === "triage" || SETTABLE.indexOf(sec.status) !== -1);
      if (!canAdd) return null;
      var open = addTaskSec === sec.key;
      if (open) {
        return h("div", { style: { display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid " + borderC } },
          h("input", { autoFocus: true, value: addTaskTitle, placeholder: "Task title\u2026", onChange: function (e) { setAddTaskTitle(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") { addTask(scope.id, sec.status, addTaskTitle); } if (e.key === "Escape") { setAddTaskSec(null); setAddTaskTitle(""); } }, onBlur: function () { if (addTaskTitle.trim()) addTask(scope.id, sec.status, addTaskTitle); setAddTaskSec(null); }, className: "font-courier", style: { flex: "1 1 auto", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "4px 8px", fontSize: 13 } }));
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
        isCollapsed ? null : h("div", null, sec.items.map(function (t) { return taskRow(t); }), addTaskRow(sec))
      );
    }

    // ---- detail modal -------------------------------------------------------
    function modal() {
      if (!modalId) return null;
      var t = taskById[modalId]; if (!t) return null;
      var d = detail[modalId]; var task = (d && d.task) || t; var pri = priorityBucket(t.priority);
      function field(lbl, ctrl) { return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 120 } }, h("span", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: muted } }, lbl), ctrl); }
      var editRow = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 16, padding: "14px 0", borderBottom: "1px solid " + borderC } },
        field("Status", editSelect(t.status, function (v) { setStatus(t, v); }, statusOptions(t), "Status", {})),
        field("Priority", editSelect(String(t.priority == null ? 0 : t.priority), function (v) { setPriority(t, v); }, prioOptions(t), "Priority", {})),
        field("Assignee", editSelect(t.assignee || "", function (v) { setAssignee(t, v); }, [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Assignee", {})),
        field("List", editSelect(membership[t.id] && liveListIds[membership[t.id]] ? membership[t.id] : "", function (v) { moveToList(t.id, v || null); }, listOpts, "List", {})),
        t.tenant ? field("Tenant", h("span", { style: { fontSize: 12, fontFamily: "var(--font-courier, monospace)" } }, t.tenant)) : null
      );
      var rows = [];
      if (task.body) rows.push(h("div", { key: "body", style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55 } }, task.body));
      else if (!d) rows.push(h("div", { key: "ld", style: { fontSize: 12, color: muted } }, "Loading details\u2026"));
      if (d && d._error) rows.push(h("div", { key: "er", style: { fontSize: 12, color: "#f87171" } }, "Failed to load full details (editing still works)."));
      if (task.latest_summary) rows.push(h("div", { key: "sum", style: { fontSize: 12.5, color: muted, borderLeft: "2px solid " + borderC, paddingLeft: 12 } }, h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, marginBottom: 3 } }, "Latest run summary"), task.latest_summary));
      var meta = [];
      if (task.workspace_path) meta.push("workspace: " + task.workspace_kind + " \u00b7 " + task.workspace_path); else if (task.workspace_kind) meta.push("workspace: " + task.workspace_kind);
      if (task.created_by) meta.push("by " + task.created_by);
      meta.push("created " + whenFull(task.created_at)); if (task.started_at) meta.push("started " + whenFull(task.started_at)); if (task.completed_at) meta.push("done " + whenFull(task.completed_at));
      rows.push(h("div", { key: "meta", style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)" } }, meta.join("   \u00b7   ")));
      var links = d && d.links;
      if (links && (((links.parents || []).length) || ((links.children || []).length))) {
        function ll(title, arr) { if (!arr || !arr.length) return null; return h("div", { style: { fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, h("span", { style: { color: muted } }, title), arr.map(function (x, i) { var lid = x.id || x.child_id || x.parent_id; var lt = x.title || lid || "?"; return h("span", { key: i, onClick: function () { if (lid && taskById[lid]) setModalId(lid); }, style: { cursor: lid && taskById[lid] ? "pointer" : "default", textDecoration: lid && taskById[lid] ? "underline dotted" : "none" } }, x.status ? Dot(statusMeta(x.status).dot, 7) : null, " ", lt); })); }
        rows.push(h("div", { key: "links", style: { display: "flex", flexDirection: "column", gap: 6 } }, ll("Parents", links.parents), ll("Children", links.children)));
      }
      var comments = (d && d.comments) || [];
      if (comments.length) rows.push(h("div", { key: "cm", style: { display: "flex", flexDirection: "column", gap: 6 } }, h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Comments (" + comments.length + ")"), comments.map(function (c, i) { return h("div", { key: i, style: { fontSize: 12.5, borderLeft: "2px solid " + borderC, paddingLeft: 12 } }, h("span", { style: { color: muted, marginRight: 6 } }, (c.author || c.created_by || "?") + ":"), c.body || c.text || ""); })));
      var panel = h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: "min(760px, 94vw)", maxHeight: "88vh", overflow: "auto", background: cardBg, border: "1px solid " + borderC, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.55)", display: "flex", flexDirection: "column" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px", borderBottom: "1px solid " + borderC, position: "sticky", top: 0, background: cardBg, zIndex: 1 } },
          Dot(pri.color, 10),
          h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
            h("input", { value: titleDraft, onChange: function (e) { setTitleDraft(e.target.value); }, onBlur: function () { saveTitle(t); }, onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid transparent", borderRadius: 6, padding: "4px 6px", fontSize: 16, fontWeight: 700 }, onFocus: function (e) { e.target.style.border = "1px solid " + borderC; }, title: "Edit title (Enter to save)" }),
            h("div", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)", padding: "2px 6px" } }, t.id)),
          h("button", { onClick: function () { setModalId(null); }, title: "Close (Esc)", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 8, padding: 6, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon(18))),
        h("div", { style: { padding: "0 18px 18px" } }, editRow, h("div", { style: { display: "flex", flexDirection: "column", gap: 14, paddingTop: 14 } }, rows)));
      return h("div", { onClick: function () { setModalId(null); }, style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 12px" } }, panel);
    }

    // ---- page ---------------------------------------------------------------
    var main = h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 } },
        h("h1", { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, scopeTitle),
        h("span", { style: { fontSize: 12, color: muted } }, loading ? "Loading\u2026" : (scopeTasks.length + " task" + (scopeTasks.length === 1 ? "" : "s")))
      ),
      toolbar,
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      (!error && !loading && !sections.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, scope.type === "list" ? "This list is empty. Drag tasks onto it in the sidebar, use the List dropdown on a task, or add one below." : "No tasks here.") : null,
      sections.map(function (sec) { return sectionBlock(sec); })
    );

    return h("div", { style: { display: "flex", alignItems: "flex-start", fontFamily: "inherit" } }, sidebar, main, modal());
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

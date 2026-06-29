/**
 * Task List — ClickUp-style list view for the Hermes Kanban board.
 *
 * No build step. Plain IIFE using the Hermes Plugin SDK globals.
 * Reuses /api/plugins/kanban/* for tasks, and a small companion backend at
 * /api/plugins/tasklist/* for user-defined "lists" (named buckets + drag&drop).
 *
 *   - Group by Status / Assignee / Priority / Tenant / Project / List / None
 *   - Custom Lists: create named lists and drag tasks between them (persistent,
 *     board-scoped; stored by the tasklist backend, not in kanban.db)
 *   - Sort, search, filter; inline edit Status / Priority / Assignee
 *   - Click a task -> detail modal (body, summary, links, comments, runs) with
 *     editable title + status/priority/assignee + list membership
 *   - Board switcher + live polling on latest_event_id
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks;
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useMemo = hooks.useMemo;
  var useCallback = hooks.useCallback;
  var useRef = hooks.useRef;

  var KAPI = "/api/plugins/kanban";
  var TLAPI = "/api/plugins/tasklist";
  var LS_BOARD = "tasklist.board";
  var LS_GROUP = "tasklist.groupBy";
  var POLL_MS = 4000;

  var STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
  var STATUS = {
    triage: { label: "Triage", dot: "#a1a1aa" }, todo: { label: "To Do", dot: "#94a3b8" },
    scheduled: { label: "Scheduled", dot: "#818cf8" }, ready: { label: "Ready", dot: "#38bdf8" },
    running: { label: "Running", dot: "#fbbf24" }, blocked: { label: "Blocked", dot: "#f87171" },
    review: { label: "Review", dot: "#c084fc" }, done: { label: "Done", dot: "#34d399" },
    archived: { label: "Archived", dot: "#52525b" }
  };
  var SETTABLE = ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"];
  var LIST_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#fb923c", "#818cf8", "#2dd4bf"];

  function statusMeta(s) { return STATUS[s] || { label: s || "?", dot: "#71717a" }; }
  function priorityBucket(p) { p = p == null ? 0 : p; if (p >= 3) return { label: "Urgent", color: "#f87171" }; if (p === 2) return { label: "High", color: "#fb923c" }; if (p === 1) return { label: "Normal", color: "#38bdf8" }; return { label: "Low", color: "#71717a" }; }
  function ago(e, now) { if (e == null) return ""; var d = Math.max(0, (now || Math.floor(Date.now() / 1000)) - e); if (d < 60) return d + "s"; if (d < 3600) return Math.floor(d / 60) + "m"; if (d < 86400) return Math.floor(d / 3600) + "h"; if (d < 2592000) return Math.floor(d / 86400) + "d"; return Math.floor(d / 2592000) + "mo"; }
  function whenFull(e) { if (e == null) return ""; try { return new Date(e * 1000).toLocaleString(); } catch (x) { return String(e); } }
  function asgName(x) { return typeof x === "string" ? x : (x && (x.name || x.assignee)) || ""; }

  function Caret(open) { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" } }, h("polyline", { points: "9 6 15 12 9 18" })); }
  function Dot(c, s) { return h("span", { style: { display: "inline-block", width: (s || 8) + "px", height: (s || 8) + "px", borderRadius: "50%", background: c, flex: "0 0 auto" } }); }
  function Grip() { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "currentColor", style: { flex: "0 0 auto", opacity: .55 } }, h("circle", { cx: 9, cy: 6, r: 1.6 }), h("circle", { cx: 15, cy: 6, r: 1.6 }), h("circle", { cx: 9, cy: 12, r: 1.6 }), h("circle", { cx: 15, cy: 12, r: 1.6 }), h("circle", { cx: 9, cy: 18, r: 1.6 }), h("circle", { cx: 15, cy: 18, r: 1.6 })); }
  function CommentIcon() { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" })); }
  function XIcon(sz) { sz = sz || 18; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })); }

  function getJSON(p) { return SDK.fetchJSON(p); }
  function send(method, p, body) { return SDK.fetchJSON(p, { method: method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }); }

  var muted = "var(--muted-foreground, #9ca3af)";
  var borderC = "var(--border, #2a2a2a)";
  var cardBg = "var(--card, var(--background, #111))";
  var bgMuted = "var(--muted, rgba(255,255,255,.03))";

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
    var bInit = (function () { try { return localStorage.getItem(LS_BOARD) || ""; } catch (e) { return ""; } })();
    var gInit = (function () { try { return localStorage.getItem(LS_GROUP) || "status"; } catch (e) { return "status"; } })();

    var s;
    s = useState([]); var boards = s[0], setBoards = s[1];
    s = useState(bInit); var board = s[0], setBoard = s[1];
    s = useState(null); var data = s[0], setData = s[1];
    s = useState(true); var loading = s[0], setLoading = s[1];
    s = useState(null); var error = s[0], setError = s[1];
    s = useState([]); var asgOpts = s[0], setAsgOpts = s[1];

    s = useState([]); var lists = s[0], setLists = s[1];
    s = useState({}); var membership = s[0], setMembership = s[1];
    s = useState(""); var newList = s[0], setNewList = s[1];
    s = useState(null); var editingList = s[0], setEditingList = s[1];
    s = useState(""); var editListName = s[0], setEditListName = s[1];
    s = useState(null); var dragId = s[0], setDragId = s[1];
    s = useState(null); var dragOver = s[0], setDragOver = s[1];

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
    var dragRef = useRef(null);

    useEffect(function () { try { localStorage.setItem(LS_GROUP, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);

    var bq = useCallback(function (extra) { var q = board ? ("?board=" + encodeURIComponent(board)) : ""; return extra ? (q ? q + "&" + extra : "?" + extra) : q; }, [board]);

    useEffect(function () { getJSON(KAPI + "/boards").then(function (r) { setBoards((r && r.boards) || []); if (!boardRef.current && r && r.current) setBoard(r.current); }).catch(function () {}); }, []);

    var loadAssignees = useCallback(function () { getJSON(KAPI + "/assignees" + bq()).then(function (r) { setAsgOpts(((r && r.assignees) || []).map(asgName).filter(Boolean)); }).catch(function () {}); }, [bq]);
    useEffect(function () { loadAssignees(); }, [loadAssignees]);

    var loadLists = useCallback(function () {
      getJSON(TLAPI + "/lists" + bq()).then(function (r) { setLists((r && r.lists) || []); setMembership((r && r.membership) || {}); })
        .catch(function () { setLists([]); setMembership({}); });
    }, [bq]);
    useEffect(function () { loadLists(); }, [loadLists]);

    var load = useCallback(function (silent) {
      if (!silent) setLoading(true);
      getJSON(KAPI + "/board" + bq("include_archived=" + (showArchived ? "true" : "false"))).then(function (r) {
        lastEvent.current = r.latest_event_id; setData(r); setError(null); setLoading(false);
      }).catch(function (e) { setError((e && e.message) || "Failed to load board"); setLoading(false); });
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
    var listById = useMemo(function () { var m = {}; lists.forEach(function (l) { m[l.id] = l; }); return m; }, [lists]);

    var tenants = (data && data.tenants) || [];
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
      return send("PATCH", KAPI + "/tasks/" + encodeURIComponent(t.id) + bq(), body).then(function () {
        loadDetail(t.id, true); load(true); if (body.assignee !== undefined) loadAssignees();
      }).catch(function (e) { setNotice("Could not update \u201c" + (t.title || t.id) + "\u201d" + (label ? " (" + label + ")" : "") + ": " + ((e && e.message) || "not allowed") + ". Reloading."); load(true); });
    }, [bq, load, loadDetail, loadAssignees]);
    function setStatus(t, v) { if (v !== t.status) applyEdit(t, { status: v }, "status"); }
    function setPriority(t, v) { var n = parseInt(v, 10); if (n !== (t.priority == null ? 0 : t.priority)) applyEdit(t, { priority: n }, "priority"); }
    function setAssignee(t, v) { if ((v || "") !== (t.assignee || "")) applyEdit(t, { assignee: v }, "assignee"); }
    function saveTitle(t) { var v = titleDraft.trim(); if (!v || v === (t.title || "")) return; applyEdit(t, { title: v }, "title"); }

    // ---- list mutations -----------------------------------------------------
    function createList() {
      var nm = newList.trim(); if (!nm) return;
      var color = LIST_COLORS[lists.length % LIST_COLORS.length];
      setNotice(null);
      send("POST", TLAPI + "/lists" + bq(), { name: nm, color: color }).then(function () { setNewList(""); loadLists(); })
        .catch(function (e) { setNotice("Could not create list: " + ((e && e.message) || "error")); });
    }
    function renameList(l) { var nm = editListName.trim(); setEditingList(null); if (!nm || nm === l.name) return; send("PATCH", TLAPI + "/lists/" + encodeURIComponent(l.id) + bq(), { name: nm }).then(loadLists).catch(function () { loadLists(); }); }
    function deleteList(l) { send("DELETE", TLAPI + "/lists/" + encodeURIComponent(l.id) + bq()).then(loadLists).catch(function () { loadLists(); }); }
    function moveToList(taskId, listId) { send("PUT", TLAPI + "/membership" + bq(), { task_id: taskId, list_id: listId || null }).then(loadLists).catch(function (e) { setNotice("Could not move task: " + ((e && e.message) || "error")); loadLists(); }); }

    var dndOn = groupBy === "list";

    // ---- filter / group -----------------------------------------------------
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
      var dir = sortDir === "asc" ? 1 : -1;
      function cmp(a, b) {
        var av, bv;
        if (sortBy === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); }
        else if (sortBy === "created") { av = a.created_at || 0; bv = b.created_at || 0; }
        else { av = a.priority == null ? 0 : a.priority; bv = b.priority == null ? 0 : b.priority; }
        if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
      }
      function sortItems(arr) { arr.sort(cmp); return arr; }

      if (groupBy === "list") {
        var byList = {};
        filtered.forEach(function (t) { var lid = membership[t.id]; (byList[lid] || (byList[lid] = [])).push(t); });
        var gs = lists.slice().sort(function (a, b) { return (a.position - b.position) || (a.created_at - b.created_at); }).map(function (l) {
          return { key: "L:" + l.id, list: l, items: sortItems((byList[l.id] || []).slice()) };
        });
        var live = {}; lists.forEach(function (l) { live[l.id] = 1; });
        var un = filtered.filter(function (t) { var lid = membership[t.id]; return !lid || !live[lid]; });
        gs.push({ key: "__unassigned", list: null, items: sortItems(un.slice()) });
        return gs;
      }

      function keyOf(t) {
        switch (groupBy) {
          case "assignee": return t.assignee || "\u0000Unassigned";
          case "tenant": return t.tenant || "\u0000No tenant";
          case "project": return t.project_id || "\u0000No project";
          case "priority": return "p:" + (t.priority == null ? 0 : t.priority);
          case "none": return "\u0000All tasks";
          default: return t.status || "todo";
        }
      }
      var map = {};
      filtered.forEach(function (t) { var k = keyOf(t); (map[k] || (map[k] = [])).push(t); });
      Object.keys(map).forEach(function (k) { sortItems(map[k]); });
      var keys = Object.keys(map);
      if (groupBy === "status") keys.sort(function (a, b) { return STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b); });
      else if (groupBy === "priority") keys.sort(function (a, b) { return parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10); });
      else keys.sort(function (a, b) { var ae = a.charCodeAt(0) === 0, be = b.charCodeAt(0) === 0; if (ae !== be) return ae ? 1 : -1; return a.localeCompare(b); });
      return keys.map(function (k) { return { key: k, items: map[k] }; });
    }, [filtered, groupBy, sortBy, sortDir, lists, membership]);

    function nonListHeader(k) {
      if (groupBy === "status") { var m = statusMeta(k); return { label: m.label, dot: m.dot }; }
      if (groupBy === "priority") { var b = priorityBucket(parseInt(k.slice(2), 10)); return { label: b.label + " (P" + k.slice(2) + ")", dot: b.color }; }
      if (k.charCodeAt(0) === 0) return { label: k.slice(1), dot: "#52525b" };
      return { label: k, dot: "#64748b" };
    }
    function toggleGroup(k) { setCollapsed(function (c) { var n = Object.assign({}, c); n[k] = !n[k]; return n; }); }
    function badge(text, color) { return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, lineHeight: 1, padding: "3px 7px", borderRadius: 999, border: "1px solid " + borderC, whiteSpace: "nowrap" } }, color ? Dot(color, 7) : null, text); }

    // ---- toolbar ------------------------------------------------------------
    function plainSelect(value, onChange, options, aria) {
      return h("select", { value: value, "aria-label": aria, onChange: function (e) { onChange(e.target.value); }, className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" } },
        options.map(function (o) { return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label); }));
    }
    var toolbar = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 } },
      boards && boards.length > 1 ? plainSelect(board, setBoard, boards.map(function (b) { return { value: b.slug, label: (b.label || b.name || b.slug) + " (" + (b.total != null ? b.total : "?") + ")" }; }), "Board") : null,
      h("span", { style: { fontSize: 11, color: muted } }, "Group"),
      plainSelect(groupBy, setGroupBy, [{ value: "status", label: "Status" }, { value: "list", label: "List" }, { value: "assignee", label: "Assignee" }, { value: "priority", label: "Priority" }, { value: "tenant", label: "Tenant" }, { value: "project", label: "Project" }, { value: "none", label: "None" }], "Group by"),
      h("span", { style: { fontSize: 11, color: muted } }, "Sort"),
      plainSelect(sortBy, setSortBy, [{ value: "priority", label: "Priority" }, { value: "created", label: "Created" }, { value: "title", label: "Title" }], "Sort by"),
      h("button", { onClick: function () { setSortDir(sortDir === "asc" ? "desc" : "asc"); }, title: "Toggle sort direction", className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 9px", fontSize: 12, cursor: "pointer" } }, sortDir === "asc" ? "\u2191 Asc" : "\u2193 Desc"),
      h("input", { value: search, placeholder: "Search title / id / body\u2026", onChange: function (e) { setSearch(e.target.value); }, className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, minWidth: 160, flex: "1 1 160px" } }),
      tenants.length ? plainSelect(fTenant, setFTenant, [{ value: "", label: "All tenants" }].concat(tenants.map(function (x) { return { value: x, label: x }; })), "Filter tenant") : null,
      assigneeChoices.length ? plainSelect(fAssignee, setFAssignee, [{ value: "", label: "All assignees" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Filter assignee") : null,
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted, cursor: "pointer" } }, h("input", { type: "checkbox", checked: showArchived, onChange: function (e) { setShowArchived(e.target.checked); } }), "Archived")
    );

    var newListBar = dndOn ? h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12 } },
      h("input", { value: newList, placeholder: "New list name\u2026", onChange: function (e) { setNewList(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") createList(); }, className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "5px 9px", fontSize: 12, minWidth: 200 } }),
      h("button", { onClick: createList, className: "font-courier", style: { background: "var(--primary, #6366f1)", color: "var(--primary-foreground, #fff)", border: "1px solid " + borderC, borderRadius: 4, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 } }, "+ Add list"),
      h("span", { style: { fontSize: 11, color: muted } }, "Drag tasks between lists to organize them")
    ) : null;

    // ---- row ----------------------------------------------------------------
    function taskRow(t) {
      var pri = priorityBucket(t.priority);
      var prog = t.progress;
      var rowProps = {
        key: t.id, onClick: function () { setModalId(t.id); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "1px solid " + borderC, cursor: dndOn ? "grab" : "pointer", fontSize: 13, opacity: dragId === t.id ? .4 : 1 },
        onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; },
        onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
      };
      if (dndOn) {
        rowProps.draggable = true;
        rowProps.onDragStart = function (e) { dragRef.current = t.id; setDragId(t.id); try { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} };
        rowProps.onDragEnd = function () { dragRef.current = null; setDragId(null); setDragOver(null); };
      }
      return h("div", rowProps,
        dndOn ? h("span", { style: { display: "inline-flex", color: muted } }, Grip()) : null,
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

    // ---- group block --------------------------------------------------------
    function groupBlock(g) {
      var isCollapsed = !!collapsed[g.key];
      var doneCount = g.items.filter(function (t) { return t.status === "done"; }).length;
      var isListMode = groupBy === "list";
      var l = g.list;
      var head = isListMode ? { label: l ? l.name : "No list", dot: l ? (l.color || "#64748b") : "#52525b" } : nonListHeader(g.key);
      var isOver = dndOn && dragOver === g.key;

      var headerInner;
      if (isListMode && l && editingList === l.id) {
        headerInner = h("input", { autoFocus: true, value: editListName, onClick: function (e) { e.stopPropagation(); }, onChange: function (e) { setEditListName(e.target.value); }, onBlur: function () { renameList(l); }, onKeyDown: function (e) { if (e.key === "Enter") { e.target.blur(); } if (e.key === "Escape") { setEditingList(null); } }, className: "font-courier", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "2px 6px", fontSize: 13, fontWeight: 600 } });
      } else {
        headerInner = h("span", { style: { fontWeight: 600, fontSize: 13, cursor: isListMode && l ? "text" : "inherit" }, onClick: isListMode && l ? function (e) { e.stopPropagation(); setEditingList(l.id); setEditListName(l.name); } : undefined, title: isListMode && l ? "Click to rename" : undefined }, head.label);
      }

      var header = h("div", {
        onClick: function () { toggleGroup(g.key); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", background: isOver ? "var(--primary, #6366f1)22" : bgMuted, userSelect: "none" }
      },
        h("span", { style: { color: muted, display: "inline-flex" } }, Caret(!isCollapsed)),
        Dot(head.dot, 9),
        headerInner,
        h("span", { style: { fontSize: 11, color: muted } }, g.items.length + (doneCount ? "  \u00b7  " + doneCount + " done" : "")),
        (isListMode && l) ? h("button", { onClick: function (e) { e.stopPropagation(); if (window.confirm("Delete list \u201c" + l.name + "\u201d? Tasks stay, they just leave this list.")) deleteList(l); }, title: "Delete list", style: { marginLeft: "auto", background: "transparent", color: muted, border: "none", cursor: "pointer", display: "inline-flex", padding: 2 } }, XIcon(14)) : null
      );

      var bodyProps = { style: { minHeight: dndOn ? 8 : 0, outline: isOver ? "2px dashed var(--primary, #6366f1)" : "none", outlineOffset: -2 } };
      if (dndOn) {
        bodyProps.onDragOver = function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (x) {} if (dragOver !== g.key) setDragOver(g.key); };
        bodyProps.onDragLeave = function (e) { if (e.currentTarget === e.target) setDragOver(null); };
        bodyProps.onDrop = function (e) {
          e.preventDefault();
          var id = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || dragRef.current;
          setDragOver(null); setDragId(null);
          if (!id) return;
          var targetList = l ? l.id : null;
          if ((membership[id] || null) !== (targetList || null)) moveToList(id, targetList);
        };
      }

      return h("div", { key: g.key, style: { border: "1px solid " + (isOver ? "var(--primary, #6366f1)" : borderC), borderRadius: 8, overflow: "hidden", marginBottom: 10 } },
        header,
        isCollapsed ? null : h("div", bodyProps,
          g.items.length ? g.items.map(function (t) { return taskRow(t); }) : (dndOn ? h("div", { style: { padding: "14px", fontSize: 12, color: muted, textAlign: "center" } }, "Drop tasks here") : null))
      );
    }

    // ---- detail modal -------------------------------------------------------
    function modal() {
      if (!modalId) return null;
      var t = taskById[modalId]; if (!t) return null;
      var d = detail[modalId];
      var task = (d && d.task) || t;
      var pri = priorityBucket(t.priority);
      function field(lbl, ctrl) { return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 120 } }, h("span", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: muted } }, lbl), ctrl); }

      var editRow = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 16, padding: "14px 0", borderBottom: "1px solid " + borderC } },
        field("Status", editSelect(t.status, function (v) { setStatus(t, v); }, statusOptions(t), "Status", {})),
        field("Priority", editSelect(String(t.priority == null ? 0 : t.priority), function (v) { setPriority(t, v); }, prioOptions(t), "Priority", {})),
        field("Assignee", editSelect(t.assignee || "", function (v) { setAssignee(t, v); }, [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), "Assignee", {})),
        lists.length ? field("List", editSelect(membership[t.id] || "", function (v) { moveToList(t.id, v || null); }, [{ value: "", label: "No list" }].concat(lists.map(function (x) { return { value: x.id, label: x.name }; })), "List", {})) : null,
        t.tenant ? field("Tenant", h("span", { style: { fontSize: 12, fontFamily: "var(--font-courier, monospace)" } }, t.tenant)) : null,
        t.project_id ? field("Project", h("span", { style: { fontSize: 12, fontFamily: "var(--font-courier, monospace)" } }, t.project_id)) : null
      );

      var rows = [];
      if (task.body) rows.push(h("div", { key: "body", style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55 } }, task.body));
      else if (!d) rows.push(h("div", { key: "ld", style: { fontSize: 12, color: muted } }, "Loading details\u2026"));
      if (d && d._error) rows.push(h("div", { key: "er", style: { fontSize: 12, color: "#f87171" } }, "Failed to load full details (editing still works)."));
      if (task.latest_summary) rows.push(h("div", { key: "sum", style: { fontSize: 12.5, color: muted, borderLeft: "2px solid " + borderC, paddingLeft: 12 } }, h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, marginBottom: 3 } }, "Latest run summary"), task.latest_summary));

      var meta = [];
      if (task.workspace_path) meta.push("workspace: " + task.workspace_kind + " \u00b7 " + task.workspace_path); else if (task.workspace_kind) meta.push("workspace: " + task.workspace_kind);
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
          return h("div", { style: { fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, h("span", { style: { color: muted } }, title),
            arr.map(function (x, i) { var lid = x.id || x.child_id || x.parent_id; var lt = x.title || lid || "?"; return h("span", { key: i, onClick: function () { if (lid && taskById[lid]) setModalId(lid); }, style: { cursor: lid && taskById[lid] ? "pointer" : "default", textDecoration: lid && taskById[lid] ? "underline dotted" : "none" } }, x.status ? Dot(statusMeta(x.status).dot, 7) : null, " ", lt); }));
        }
        rows.push(h("div", { key: "links", style: { display: "flex", flexDirection: "column", gap: 6 } }, linkList("Parents", links.parents), linkList("Children", links.children)));
      }
      var comments = (d && d.comments) || [];
      if (comments.length) rows.push(h("div", { key: "cm", style: { display: "flex", flexDirection: "column", gap: 6 } }, h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Comments (" + comments.length + ")"),
        comments.map(function (c, i) { return h("div", { key: i, style: { fontSize: 12.5, borderLeft: "2px solid " + borderC, paddingLeft: 12 } }, h("span", { style: { color: muted, marginRight: 6 } }, (c.author || c.created_by || "?") + ":"), c.body || c.text || ""); })));
      var runs = (d && d.runs) || [];
      if (runs.length) rows.push(h("div", { key: "runs", style: { display: "flex", flexDirection: "column", gap: 4 } }, h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Runs (" + runs.length + ")"),
        runs.slice(0, 8).map(function (r, i) { return h("div", { key: i, style: { fontSize: 11.5, color: muted, fontFamily: "var(--font-courier, monospace)" } }, (r.outcome || r.state || "?") + (r.profile ? " \u00b7 " + r.profile : "") + (r.started_at ? " \u00b7 " + whenFull(r.started_at) : "")); })));

      var panel = h("div", { onClick: function (e) { e.stopPropagation(); }, style: { width: "min(760px, 94vw)", maxHeight: "88vh", overflow: "auto", background: cardBg, border: "1px solid " + borderC, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.55)", display: "flex", flexDirection: "column" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px", borderBottom: "1px solid " + borderC, position: "sticky", top: 0, background: cardBg, zIndex: 1 } },
          Dot(pri.color, 10),
          h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
            h("input", { value: titleDraft, onChange: function (e) { setTitleDraft(e.target.value); }, onBlur: function () { saveTitle(t); }, onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid transparent", borderRadius: 6, padding: "4px 6px", fontSize: 16, fontWeight: 700 }, onFocus: function (e) { e.target.style.border = "1px solid " + borderC; }, title: "Edit title (Enter to save)" }),
            h("div", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)", padding: "2px 6px" } }, t.id)
          ),
          h("button", { onClick: function () { setModalId(null); }, title: "Close (Esc)", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 8, padding: 6, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon(18))
        ),
        h("div", { style: { padding: "0 18px 18px" } }, editRow, h("div", { style: { display: "flex", flexDirection: "column", gap: 14, paddingTop: 14 } }, rows))
      );
      return h("div", { onClick: function () { setModalId(null); }, style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 12px" } }, panel);
    }

    // ---- page ---------------------------------------------------------------
    var total = filtered.length;
    return h("div", { className: "flex flex-col gap-2", style: { fontFamily: "inherit" } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        h("h1", { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, "List"),
        h("span", { style: { fontSize: 12, color: muted } }, loading ? "Loading\u2026" : (total + " task" + (total === 1 ? "" : "s") + (tasks.length !== total ? " of " + tasks.length : "")))
      ),
      toolbar,
      newListBar,
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      (!error && !loading && !groups.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, "No tasks match.") : null,
      groups.map(function (g) { return groupBlock(g); }),
      modal()
    );
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

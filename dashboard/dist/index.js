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
  var COLW = { status: 112, priority: 96, assignee: 132, list: 124, age: 46 };

  function statusMeta(s) { return STATUS[s] || { label: s || "?", dot: "#71717a" }; }
  function priorityBucket(p) { p = p == null ? 0 : p; if (p >= 3) return { label: "Urgent", color: "#f87171" }; if (p === 2) return { label: "High", color: "#fb923c" }; if (p === 1) return { label: "Normal", color: "#38bdf8" }; return { label: "Low", color: "#71717a" }; }
  function ago(e, now) { if (e == null) return ""; var d = Math.max(0, (now || Math.floor(Date.now() / 1000)) - e); if (d < 60) return d + "s"; if (d < 3600) return Math.floor(d / 60) + "m"; if (d < 86400) return Math.floor(d / 3600) + "h"; if (d < 2592000) return Math.floor(d / 86400) + "d"; return Math.floor(d / 2592000) + "mo"; }
  function whenFull(e) { if (e == null) return ""; try { return new Date(e * 1000).toLocaleString(); } catch (x) { return String(e); } }
  function asgName(x) { return typeof x === "string" ? x : (x && (x.name || x.assignee)) || ""; }
  function hsize(n) { if (n == null) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
  function fmtPayload(p) { if (p == null || p === "") return ""; var str; try { str = typeof p === "string" ? p : JSON.stringify(p); } catch (e) { str = String(p); } return str; }

  function Caret(open, sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" } }, h("polyline", { points: "9 6 15 12 9 18" })); }
  function Dot(c, s) { return h("span", { style: { display: "inline-block", width: (s || 8) + "px", height: (s || 8) + "px", borderRadius: "50%", background: c, flex: "0 0 auto" } }); }
  function Grip() { return h("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", style: { flex: "0 0 auto", opacity: .5 } }, h("circle", { cx: 9, cy: 6, r: 1.6 }), h("circle", { cx: 15, cy: 6, r: 1.6 }), h("circle", { cx: 9, cy: 12, r: 1.6 }), h("circle", { cx: 15, cy: 12, r: 1.6 }), h("circle", { cx: 9, cy: 18, r: 1.6 }), h("circle", { cx: 15, cy: 18, r: 1.6 })); }
  function BoardIcon() { return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flex: "0 0 auto", opacity: .8 } }, h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }), h("line", { x1: 9, y1: 3, x2: 9, y2: 21 }), h("line", { x1: 15, y1: 3, x2: 15, y2: 21 })); }
  function CommentIcon() { return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" })); }
  function XIcon(sz) { sz = sz || 16; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })); }
  function PlusIcon(sz) { sz = sz || 14; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }, h("line", { x1: 12, y1: 5, x2: 12, y2: 19 }), h("line", { x1: 5, y1: 12, x2: 19, y2: 12 })); }
  function PencilIcon(sz) { sz = sz || 12; return h("svg", { width: sz, height: sz, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M12 20h9" }), h("path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" })); }

  function getJSON(p) { return SDK.fetchJSON(p); }
  function send(method, p, body) { return SDK.fetchJSON(p, { method: method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }); }
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
        + ".tl-editable:hover .tl-penhint{opacity:1}";
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
        pe.removeEventListener("click", onNativeClick);
        if (!_createPortal && holder) { while (pe.firstChild) holder.appendChild(pe.firstChild); }
        if (pe.parentNode) pe.parentNode.removeChild(pe);
      };
    }, []);
    if (_createPortal && peRef.current) return h(Fragment, null, h("div", { ref: holderRef, style: { display: "none" } }), _createPortal(props.children, peRef.current));
    return h("div", { ref: holderRef, style: { display: "contents" } }, props.children);
  }

  function DotSelect(props) {
    var value = props.value, options = props.options || [], onChange = props.onChange, opts = props.opts || {};
    var st = useState(false); var open = st[0], setOpen = st[1];
    var ps = useState(null); var pos = ps[0], setPos = ps[1];
    var ref = useRef(null); var btnRef = useRef(null);
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
      if (r) { var up = (window.innerHeight - r.bottom) < 260; setPos({ left: r.left, width: r.width, top: up ? null : Math.round(r.bottom + 4), bottom: up ? Math.round(window.innerHeight - r.top + 4) : null }); }
      setOpen(true);
    }
    var cur = null; for (var i = 0; i < options.length; i++) { if (String(options[i].value) === String(value)) { cur = options[i]; break; } }
    var anyDot = false; for (var j = 0; j < options.length; j++) { if (options[j].dot) { anyDot = true; break; } }
    var menu = (open && pos) ? h("div", { style: { position: "fixed", left: pos.left, top: pos.top == null ? undefined : pos.top, bottom: pos.bottom == null ? undefined : pos.bottom, minWidth: Math.max(pos.width, 150), maxHeight: 260, overflow: "auto", background: "var(--background, #111)", border: "1px solid " + borderC, borderRadius: 8, boxShadow: "0 12px 34px rgba(0,0,0,.55)", zIndex: 2000, padding: 4 } },
      options.map(function (o) {
        var sel = String(o.value) === String(value);
        return h("div", { key: o.value, onClick: function () { onChange(o.value); setOpen(false); }, style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, whiteSpace: "nowrap", background: sel ? accent + "22" : "transparent" }, onMouseEnter: function (e) { if (!sel) e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { if (!sel) e.currentTarget.style.background = "transparent"; } },
          o.dot ? Dot(o.dot, 9) : (anyDot ? h("span", { style: { width: 9, flex: "0 0 auto" } }) : null),
          h("span", null, o.label));
      })) : null;
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
    s = useState("priority"); var sortBy = s[0], setSortBy = s[1];
    s = useState("desc"); var sortDir = s[0], setSortDir = s[1];
    s = useState(""); var search = s[0], setSearch = s[1];
    s = useState(""); var fAssignee = s[0], setFAssignee = s[1];
    s = useState(false); var showArchived = s[0], setShowArchived = s[1];

    s = useState({}); var collapsedSec = s[0], setCollapsedSec = s[1];
    s = useState(null); var addTaskSec = s[0], setAddTaskSec = s[1];
    s = useState(""); var addTaskTitle = s[0], setAddTaskTitle = s[1];
    s = useState(null); var modalId = s[0], setModalId = s[1];
    s = useState("details"); var modalTab = s[0], setModalTab = s[1];
    useEffect(function () { setModalTab("details"); }, [modalId]);
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
    s = useState(true); var sidebarOpen = s[0], setSidebarOpen = s[1];

    useEffect(function () {
      if (typeof window === "undefined" || !window.matchMedia) return;
      var mq = window.matchMedia("(max-width: 820px)");
      function on() { setIsNarrow(mq.matches); setSidebarOpen(!mq.matches); }
      on();
      if (mq.addEventListener) mq.addEventListener("change", on); else if (mq.addListener) mq.addListener(on);
      return function () { if (mq.removeEventListener) mq.removeEventListener("change", on); else if (mq.removeListener) mq.removeListener(on); };
    }, []);

    var lastEvent = useRef(-1);
    var boardRef = useRef(board); boardRef.current = board;
    var dragRef = useRef(null);

    useEffect(function () { try { localStorage.setItem(LS_GROUPBY, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);
    useEffect(function () { try { localStorage.setItem(LS_SCOPE, JSON.stringify(scope)); } catch (e) {} }, [scope]);

    var bq = useCallback(function (extra) { var q = board ? ("?board=" + encodeURIComponent(board)) : ""; return extra ? (q ? q + "&" + extra : "?" + extra) : q; }, [board]);
    function tlq(slug) { return "?board=" + encodeURIComponent(slug || "default"); }

    useEffect(function () { getJSON(KAPI + "/boards").then(function (r) { setBoards((r && r.boards) || []); if (!boardRef.current && r && r.current) setBoard(r.current); }).catch(function () {}); }, []);

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
    useEffect(function () { if (modalId) loadDetail(modalId, false); }, [modalId]); // eslint-disable-line
    useEffect(function () {
      if (!modalId) return; var t = taskById[modalId]; setTitleDraft(t ? (t.title || "") : ""); setDescEdit(false); setCommentDraft(""); setAddParentSel(""); setAddChildSel("");
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

    // ---- list / membership mutations ----------------------------------------
    function activate(slug, sc) { setBoard(slug); setScope(sc); setCollapsedBoards(function (n) { var x = Object.assign({}, n); x[slug] = false; return x; }); if (isNarrow) setSidebarOpen(false); }
    function createList(name, slug) { name = (name || "").trim(); if (!name) return; var color = LIST_COLORS[treeFor(slug).lists.length % LIST_COLORS.length]; send("POST", TLAPI + "/lists" + tlq(slug), { name: name, color: color }).then(function (r) { setAdding(null); setAddName(""); loadTreeFor(slug); if (r && r.list) activate(slug, { type: "list", id: r.list.id }); }).catch(function (e) { setNotice("Could not create list: " + ((e && e.message) || "error")); }); }
    function renameNode() { if (!editing) return; var nm = editName.trim(); var cur = editing; setEditing(null); if (!nm) return; send("PATCH", TLAPI + "/lists/" + encodeURIComponent(cur.id) + tlq(cur.board), { name: nm }).then(function () { loadTreeFor(cur.board); }).catch(function () { loadTreeFor(cur.board); }); }
    function deleteList(l, slug) { if (!window.confirm("Delete list \u201c" + l.name + "\u201d? Tasks stay on the board, they just leave this list.")) return; send("DELETE", TLAPI + "/lists/" + encodeURIComponent(l.id) + tlq(slug), null).then(function () { if (scope.type === "list" && scope.id === l.id) setScope({ type: "all" }); loadTreeFor(slug); }).catch(function () { loadTreeFor(slug); }); }
    function moveToList(taskId, listId) { if (!taskId) return; var ids = [taskId].concat(descendantsOf(taskId)); setNotice(null); var chain = Promise.resolve(); ids.forEach(function (tid) { chain = chain.then(function () { return send("PUT", TLAPI + "/membership" + tlq(board), { task_id: tid, list_id: listId || null }); }); }); chain.then(function () { loadTreeFor(board); }).catch(function (e) { setNotice("Could not move task: " + ((e && e.message) || "error")); loadTreeFor(board); }); }
    function addTask(listId, status, title) {
      title = (title || "").trim(); if (!title) return; setNotice(null);
      send("POST", KAPI + "/tasks" + bq(), { title: title, triage: status === "triage" }).then(function (r) {
        var id = r && r.task && r.task.id; var p = Promise.resolve();
        if (id && listId) p = send("PUT", TLAPI + "/membership" + tlq(board), { task_id: id, list_id: listId });
        if (id && status && status !== "triage" && SETTABLE.indexOf(status) !== -1) p = p.then(function () { return send("PATCH", KAPI + "/tasks/" + encodeURIComponent(id) + bq(), { status: status }); });
        return p;
      }).then(function () { setAddTaskTitle(""); load(true); loadTreeFor(board); }).catch(function (e) { setNotice("Could not add task: " + ((e && e.message) || "error")); load(true); loadTreeFor(board); });
    }

    // ---- detail-popup mutations (parity with the native kanban drawer) ------
    function reloadTask(id) { loadDetail(id, true); load(true); }
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
        var cols = STATUS_ORDER.filter(function (c) { return c !== "archived" || showArchived; });
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
        return h("div", { key: l.id, style: { padding: "2px 8px 2px 30px" } }, h("input", { autoFocus: true, value: editName, onChange: function (e) { setEditName(e.target.value); }, onBlur: renameNode, onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }, className: "font-courier", style: { width: "100%", background: "transparent", color: "inherit", border: "1px solid " + accent, borderRadius: 4, padding: "3px 6px", fontSize: 12.5 } }));
      }
      var btnStyle = { background: "transparent", border: "none", color: muted, cursor: "pointer", padding: 0, display: "inline-flex", flex: "0 0 auto" };
      var trailing = h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto" } },
        h("button", { onClick: function (e) { e.stopPropagation(); setEditing({ id: l.id, board: slug }); setEditName(l.name); }, title: "Rename list", style: btnStyle }, PencilIcon(12)),
        h("button", { onClick: function (e) { e.stopPropagation(); deleteList(l, slug); }, title: "Delete list", style: btnStyle }, XIcon(13))
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
        ? h("span", { onClick: function (e) { e.stopPropagation(); var willOpen = !expandedTasks[t.id]; setExpandedTasks(function (n) { var x = Object.assign({}, n); x[t.id] = !x[t.id]; return x; }); if (willOpen) ensureChildEdges(t.id); }, title: expanded ? "Collapse subtasks" : "Expand subtasks", style: { display: "inline-flex", color: muted, cursor: "pointer", flex: "0 0 auto" } }, Caret(expanded, 12))
        : h("span", { style: { display: "inline-block", width: 12, flex: "0 0 auto" } });
      if (isNarrow) {
        return h("div", {
          key: t.id, onClick: function () { setModalId(t.id); },
          style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px", paddingLeft: (14 + depth * 16) + "px", borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 13 }
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
            disc,
            Dot(pri.color, 8),
            h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 } }, t.title || "(untitled)"),
            prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
            (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null)
          ),
          h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, paddingLeft: 20 } },
            h(DotSelect, { value: t.status, options: statusOptions(t).map(function (o) { return { value: o.value, label: o.label, dot: statusMeta(o.value).dot }; }), onChange: function (v) { setStatus(t, v); }, opts: { small: true, pill: true } }),
            h(DotSelect, { value: String(t.priority == null ? 0 : t.priority), options: prioOptions(t).map(function (o) { var n = parseInt(o.value, 10); return { value: o.value, label: o.label, dot: priorityBucket(isNaN(n) ? 0 : n).color }; }), onChange: function (v) { setPriority(t, v); }, opts: { small: true, pill: true } }),
            h(DotSelect, { value: t.assignee || "", options: [{ value: "", label: "Unassigned" }].concat(assigneeChoices.map(function (x) { return { value: x, label: x }; })), onChange: function (v) { setAssignee(t, v); }, opts: { small: true, pill: true, maxWidth: "150px" } }),
            h(DotSelect, { value: activeMembership[t.id] && liveListIds[activeMembership[t.id]] ? activeMembership[t.id] : "", options: listOpts, onChange: function (v) { moveToList(t.id, v || null); }, opts: { small: true, pill: true, maxWidth: "140px" } }),
            h("span", { style: { fontSize: 11, color: muted, marginLeft: "auto" } }, ago(t.created_at, now))
          )
        );
      }
      return h("div", {
        onDragStart: function (e) { dragRef.current = t.id; setDragId(t.id); try { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} },
        onDragEnd: function () { dragRef.current = null; setDragId(null); setDropList(null); },
        style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", paddingLeft: (14 + depth * 22) + "px", borderTop: "1px solid " + borderC, cursor: "grab", fontSize: 13, opacity: dragId === t.id ? .4 : 1 },
        onMouseEnter: function (e) { e.currentTarget.style.background = bgMuted; }, onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
      },
        h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 10 } },
          disc,
          h("span", { style: { display: "inline-flex", color: muted } }, Grip()),
          Dot(pri.color, 8),
          h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title || "(untitled)"),
          prog ? badge(prog.done + "/" + prog.total, prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
          (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null)
        ),
        h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 } },
          cell(COLW.status, h(DotSelect, { value: t.status, options: statusOptions(t).map(function (o) { return { value: o.value, label: o.label, dot: statusMeta(o.value).dot }; }), onChange: function (v) { setStatus(t, v); }, opts: { full: true, small: true, pill: true } })),
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
      var canAdd = addInto !== undefined && sec.status && (sec.status === "triage" || SETTABLE.indexOf(sec.status) !== -1);
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
        isCollapsed ? null : (isNarrow
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
        field("Status", h(DotSelect, { value: t.status, options: statusOptions(t).map(function (o) { return { value: o.value, label: o.label, dot: statusMeta(o.value).dot }; }), onChange: function (v) { setStatus(t, v); }, opts: { full: true, lg: true } })),
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
              ? h("div", { style: { whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.65 } }, task.body)
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
          d ? h(DotSelect, { value: "", options: otherOpts("\u2014 add parent \u2014"), onChange: function (v) { if (v) addLink(v, id); }, opts: { maxWidth: "240px" } }) : null),
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 } },
          h("span", { style: { fontSize: 12.5, color: muted, minWidth: 70 } }, "Children"),
          children.length ? children.map(function (c) { return linkChip(c, function () { removeLink(id, c); }); }) : muteSpan("none"),
          d ? h(DotSelect, { value: "", options: otherOpts("\u2014 add child \u2014"), onChange: function (v) { if (v) addLink(id, v); }, opts: { maxWidth: "240px" } }) : null));
      L.push(h("div", { key: "deps" }, section("Dependencies", null, depBody)));

      // ---- Result ------------------------------------------------------------
      if (task.result) L.push(h("div", { key: "res" }, section("Result", null, h("div", { style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6 } }, task.result))));

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
            r.summary ? h("div", { style: { marginTop: 4, lineHeight: 1.5 } }, r.summary) : null,
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
                h("div", { style: { fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" } }, c.body || c.text || "")));
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
          h("button", { onClick: function () { setModalId(null); }, "data-tl-close": "1", title: "Close (Esc)", style: { background: "transparent", color: muted, border: "1px solid " + borderC, borderRadius: 9, padding: 8, cursor: "pointer", display: "inline-flex", flex: "0 0 auto" } }, XIcon(20))),
        body);
      return h(Portal, { onClose: function () { setModalId(null); } }, h("div", { onClick: function () { setModalId(null); }, "data-tl-backdrop": "1", style: { position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(0,0,0,.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: isNarrow ? "0" : "3vh 2vw" } }, panel));
    }

    // ---- page ---------------------------------------------------------------
    var activeBoardLabel = (function () { var b = boards.filter(function (x) { return x.slug === board; })[0]; return b ? (b.label || b.name || b.slug) : board; })();
    var main = h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } },
          isNarrow ? h("button", { onClick: function () { setSidebarOpen(!sidebarOpen); }, title: "Show/hide boards", style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer", flex: "0 0 auto" } }, "\u2630 Boards") : null,
          h("h1", { style: { fontSize: isNarrow ? 16 : 18, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, scopeTitle, activeBoardLabel ? h("span", { style: { fontSize: 12, fontWeight: 400, color: muted, marginLeft: 8 } }, "in " + activeBoardLabel) : null)),
        h("span", { style: { fontSize: 12, color: muted, flex: "0 0 auto" } }, loading ? "Loading\u2026" : (scopeTasks.length + " task" + (scopeTasks.length === 1 ? "" : "s")))
      ),
      toolbar,
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      (!error && !loading && !sections.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, scope.type === "list" ? "This list is empty. Drag tasks onto it, use the List dropdown on a task, or add one below." : "No tasks here.") : null,
      sections.map(function (sec) { return sectionBlock(sec); })
    );

    return h("div", { style: { display: "flex", flexDirection: isNarrow ? "column" : "row", alignItems: isNarrow ? "stretch" : "flex-start", fontFamily: "inherit" } }, (isNarrow && !sidebarOpen) ? null : sidebar, main, modal());
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

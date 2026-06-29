/**
 * Task List — ClickUp-style list view for the Hermes Kanban board.
 *
 * No build step. Plain IIFE using the Hermes Plugin SDK globals.
 * Reads /api/plugins/kanban/* (the same backend the board uses), so it
 * stays perfectly in sync with the Kanban tab, the CLI and the workers.
 *
 * Features:
 *   - Group by Status / Assignee / Priority / Tenant / Project / None
 *   - Sort within group by Priority / Created / Title (asc/desc)
 *   - Search (title / id / body), filter by tenant & assignee, show archived
 *   - Collapsible groups with counts + subtask-progress rollup
 *   - Click a row to expand inline details (lazy /tasks/:id): body, summary,
 *     links, comments, workspace, runs
 *   - Inline status move via PATCH /tasks/:id (routes through the same
 *     validated state machine as drag-drop on the board)
 *   - Board switcher (when >1 board) + live polling on latest_event_id
 *
 * Drop this folder into ~/.hermes/plugins/tasklist/ and refresh the dashboard.
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
  var cn = (SDK.utils && SDK.utils.cn) || function () {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  };

  var API = "/api/plugins/kanban";
  var LS_BOARD = "tasklist.board";
  var LS_GROUP = "tasklist.groupBy";
  var POLL_MS = 4000;

  // ---- status metadata (order mirrors the board's BOARD_COLUMNS) ----------
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
  // statuses a human may set directly from the dropdown. 'running' is rejected
  // by the backend (must go through the dispatcher); 'archived' is a delete op.
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

  // small inline icons (no icon lib dependency in plugin bundles) ------------
  function Caret(open) {
    return h("svg", {
      width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round",
      style: { transition: "transform .12s", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" }
    }, h("polyline", { points: "9 6 15 12 9 18" }));
  }
  function Dot(color, size) {
    return h("span", {
      style: {
        display: "inline-block", width: (size || 8) + "px", height: (size || 8) + "px",
        borderRadius: "50%", background: color, flex: "0 0 auto"
      }
    });
  }
  function CommentIcon() {
    return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }));
  }

  // ---- data fetching -------------------------------------------------------
  function getJSON(path) {
    return SDK.fetchJSON(path);
  }
  function patchTask(id, body, board) {
    var q = board ? ("?board=" + encodeURIComponent(board)) : "";
    return SDK.fetchJSON(API + "/tasks/" + encodeURIComponent(id) + q, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  // =========================================================================
  function TaskListPage() {
    var bInit = (function () { try { return localStorage.getItem(LS_BOARD) || ""; } catch (e) { return ""; } })();
    var gInit = (function () { try { return localStorage.getItem(LS_GROUP) || "status"; } catch (e) { return "status"; } })();

    var s = useState([]); var boards = s[0], setBoards = s[1];
    s = useState(bInit); var board = s[0], setBoard = s[1];
    s = useState(null); var data = s[0], setData = s[1];
    s = useState(true); var loading = s[0], setLoading = s[1];
    s = useState(null); var error = s[0], setError = s[1];

    s = useState(gInit); var groupBy = s[0], setGroupBy = s[1];
    s = useState("priority"); var sortBy = s[0], setSortBy = s[1];
    s = useState("desc"); var sortDir = s[0], setSortDir = s[1];
    s = useState(""); var search = s[0], setSearch = s[1];
    s = useState(""); var fTenant = s[0], setFTenant = s[1];
    s = useState(""); var fAssignee = s[0], setFAssignee = s[1];
    s = useState(false); var showArchived = s[0], setShowArchived = s[1];

    s = useState({}); var collapsed = s[0], setCollapsed = s[1];
    s = useState(null); var openId = s[0], setOpenId = s[1];
    s = useState({}); var detail = s[0], setDetail = s[1];
    s = useState(null); var notice = s[0], setNotice = s[1];

    var lastEvent = useRef(-1);
    var boardRef = useRef(board);
    boardRef.current = board;

    // persist prefs
    useEffect(function () { try { localStorage.setItem(LS_GROUP, groupBy); } catch (e) {} }, [groupBy]);
    useEffect(function () { try { if (board) localStorage.setItem(LS_BOARD, board); } catch (e) {} }, [board]);

    // load board list once
    useEffect(function () {
      getJSON(API + "/boards").then(function (r) {
        setBoards((r && r.boards) || []);
        if (!boardRef.current && r && r.current) setBoard(r.current);
      }).catch(function () { /* single-board installs may still work via default */ });
    }, []);

    var load = useCallback(function (silent) {
      if (!silent) setLoading(true);
      var q = "?include_archived=" + (showArchived ? "true" : "false");
      if (board) q += "&board=" + encodeURIComponent(board);
      getJSON(API + "/board" + q).then(function (r) {
        lastEvent.current = r.latest_event_id;
        setData(r); setError(null); setLoading(false);
      }).catch(function (e) {
        setError((e && e.message) || "Failed to load board"); setLoading(false);
      });
    }, [board, showArchived]);

    useEffect(function () { load(false); }, [load]);

    // live polling — refetch only when the append-only event log advanced
    useEffect(function () {
      var t = setInterval(function () {
        if (document.hidden) return;
        var q = "?include_archived=" + (showArchived ? "true" : "false");
        if (boardRef.current) q += "&board=" + encodeURIComponent(boardRef.current);
        getJSON(API + "/board" + q).then(function (r) {
          if (r.latest_event_id !== lastEvent.current) {
            lastEvent.current = r.latest_event_id;
            setData(r);
          }
        }).catch(function () {});
      }, POLL_MS);
      return function () { clearInterval(t); };
    }, [showArchived]);

    // flatten columns -> tasks
    var tasks = useMemo(function () {
      if (!data || !data.columns) return [];
      var out = [];
      data.columns.forEach(function (c) {
        (c.tasks || []).forEach(function (t) { out.push(t); });
      });
      return out;
    }, [data]);

    var tenants = (data && data.tenants) || [];
    var assignees = (data && data.assignees) || [];
    var now = (data && data.now) || Math.floor(Date.now() / 1000);

    // filter
    var filtered = useMemo(function () {
      var q = search.trim().toLowerCase();
      return tasks.filter(function (t) {
        if (fTenant && (t.tenant || "") !== fTenant) return false;
        if (fAssignee && (t.assignee || "") !== fAssignee) return false;
        if (q) {
          var hay = ((t.title || "") + " " + (t.id || "") + " " + (t.body || "")).toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
    }, [tasks, search, fTenant, fAssignee]);

    // group
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
      filtered.forEach(function (t) {
        var k = keyOf(t);
        (map[k] || (map[k] = [])).push(t);
      });

      var dir = sortDir === "asc" ? 1 : -1;
      Object.keys(map).forEach(function (k) {
        map[k].sort(function (a, b) {
          var av, bv;
          if (sortBy === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); }
          else if (sortBy === "created") { av = a.created_at || 0; bv = b.created_at || 0; }
          else { av = a.priority == null ? 0 : a.priority; bv = b.priority == null ? 0 : b.priority; }
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      });

      var keys = Object.keys(map);
      // order the group headers sensibly per grouping mode
      if (groupBy === "status") {
        keys.sort(function (a, b) { return STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b); });
      } else if (groupBy === "priority") {
        keys.sort(function (a, b) { return parseInt(b.slice(2), 10) - parseInt(a.slice(2), 10); });
      } else {
        keys.sort(function (a, b) {
          // empty-bucket sentinel (\u0000…) sinks to the bottom
          var ae = a.charCodeAt(0) === 0, be = b.charCodeAt(0) === 0;
          if (ae !== be) return ae ? 1 : -1;
          return a.localeCompare(b);
        });
      }
      return keys.map(function (k) { return { key: k, items: map[k] }; });
    }, [filtered, groupBy, sortBy, sortDir]);

    function groupHeader(k) {
      if (groupBy === "status") { var m = statusMeta(k); return { label: m.label, dot: m.dot }; }
      if (groupBy === "priority") { var b = priorityBucket(parseInt(k.slice(2), 10)); return { label: b.label + " (P" + k.slice(2) + ")", dot: b.color }; }
      if (k.charCodeAt(0) === 0) return { label: k.slice(1), dot: "#52525b" };
      return { label: k, dot: "#64748b" };
    }

    function toggleGroup(k) {
      setCollapsed(function (c) { var n = Object.assign({}, c); n[k] = !n[k]; return n; });
    }

    function openRow(t) {
      if (openId === t.id) { setOpenId(null); return; }
      setOpenId(t.id);
      if (!detail[t.id]) {
        var q = board ? ("?board=" + encodeURIComponent(board)) : "";
        getJSON(API + "/tasks/" + encodeURIComponent(t.id) + q).then(function (d) {
          setDetail(function (m) { var n = Object.assign({}, m); n[t.id] = d; return n; });
        }).catch(function () {
          setDetail(function (m) { var n = Object.assign({}, m); n[t.id] = { _error: true }; return n; });
        });
      }
    }

    function moveStatus(t, next) {
      if (next === t.status) return;
      setNotice(null);
      patchTask(t.id, { status: next }, board).then(function () {
        load(true);
      }).catch(function (e) {
        setNotice("Could not move \u201c" + (t.title || t.id) + "\u201d to " + next + ": " + ((e && e.message) || "transition not allowed") + ". Reloading.");
        load(true);
      });
    }

    // ---- render bits -------------------------------------------------------
    var muted = "var(--muted-foreground, #9ca3af)";
    var borderC = "var(--border, #2a2a2a)";

    function selectEl(value, onChange, options, ariaLabel) {
      return h("select", {
        value: value, "aria-label": ariaLabel,
        onChange: function (e) { onChange(e.target.value); },
        className: "font-courier",
        style: {
          background: "transparent", color: "inherit", border: "1px solid " + borderC,
          borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer"
        }
      }, options.map(function (o) {
        return h("option", { key: o.value, value: o.value, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, o.label);
      }));
    }

    var toolbar = h("div", {
      style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }
    },
      // board switcher
      boards && boards.length > 1 ? selectEl(board, setBoard,
        boards.map(function (b) { return { value: b.slug, label: (b.label || b.name || b.slug) + " (" + (b.total != null ? b.total : "?") + ")" }; }),
        "Board") : null,
      h("span", { style: { fontSize: 11, color: muted } }, "Group"),
      selectEl(groupBy, setGroupBy, [
        { value: "status", label: "Status" },
        { value: "assignee", label: "Assignee" },
        { value: "priority", label: "Priority" },
        { value: "tenant", label: "Tenant" },
        { value: "project", label: "Project" },
        { value: "none", label: "None" }
      ], "Group by"),
      h("span", { style: { fontSize: 11, color: muted } }, "Sort"),
      selectEl(sortBy, setSortBy, [
        { value: "priority", label: "Priority" },
        { value: "created", label: "Created" },
        { value: "title", label: "Title" }
      ], "Sort by"),
      h("button", {
        onClick: function () { setSortDir(sortDir === "asc" ? "desc" : "asc"); },
        title: "Toggle sort direction",
        className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 9px", fontSize: 12, cursor: "pointer" }
      }, sortDir === "asc" ? "\u2191 Asc" : "\u2193 Desc"),
      h("input", {
        value: search, placeholder: "Search title / id / body\u2026",
        onChange: function (e) { setSearch(e.target.value); },
        className: "font-courier",
        style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 4, padding: "4px 8px", fontSize: 12, minWidth: 180, flex: "1 1 180px" }
      }),
      tenants.length ? selectEl(fTenant, setFTenant,
        [{ value: "", label: "All tenants" }].concat(tenants.map(function (x) { return { value: x, label: x }; })), "Filter tenant") : null,
      assignees.length ? selectEl(fAssignee, setFAssignee,
        [{ value: "", label: "All assignees" }].concat(assignees.map(function (x) { return { value: x, label: x }; })), "Filter assignee") : null,
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: showArchived, onChange: function (e) { setShowArchived(e.target.checked); } }),
        "Archived")
    );

    function badge(text, color) {
      return h("span", {
        style: {
          display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, lineHeight: 1,
          padding: "3px 7px", borderRadius: 999, border: "1px solid " + borderC, color: "inherit", whiteSpace: "nowrap"
        }
      }, color ? Dot(color, 7) : null, text);
    }

    function detailPanel(t) {
      var d = detail[t.id];
      if (!d) return h("div", { style: { padding: "10px 14px", fontSize: 12, color: muted } }, "Loading details\u2026");
      if (d._error) return h("div", { style: { padding: "10px 14px", fontSize: 12, color: "#f87171" } }, "Failed to load details.");
      var task = d.task || t;
      var rows = [];
      if (task.body) rows.push(h("div", { key: "body", style: { whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.5 } }, task.body));
      if (task.latest_summary) rows.push(h("div", { key: "sum", style: { fontSize: 12, color: muted, borderLeft: "2px solid " + borderC, paddingLeft: 10 } },
        h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, marginBottom: 3 } }, "Latest run summary"), task.latest_summary));
      var meta = [];
      if (task.workspace_path) meta.push("workspace: " + task.workspace_kind + " \u00b7 " + task.workspace_path);
      else if (task.workspace_kind) meta.push("workspace: " + task.workspace_kind);
      if (task.created_by) meta.push("created by " + task.created_by);
      if (task.model_override) meta.push("model: " + task.model_override);
      if (meta.length) rows.push(h("div", { key: "meta", style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)" } }, meta.join("   \u00b7   ")));

      var links = d.links;
      if (links && (((links.parents || []).length) || ((links.children || []).length))) {
        function linkList(title, arr) {
          if (!arr || !arr.length) return null;
          return h("div", { style: { fontSize: 12 } },
            h("span", { style: { color: muted, marginRight: 6 } }, title),
            arr.map(function (x, i) {
              var lt = x.title || x.id || x.child_id || x.parent_id || x;
              var ls = x.status;
              return h("span", { key: i, style: { marginRight: 8 } }, ls ? Dot(statusMeta(ls).dot, 7) : null, " ", lt);
            }));
        }
        rows.push(h("div", { key: "links", style: { display: "flex", flexDirection: "column", gap: 4 } },
          linkList("Parents", links.parents), linkList("Children", links.children)));
      }
      var comments = d.comments || [];
      if (comments.length) {
        rows.push(h("div", { key: "cm", style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10, color: muted } }, "Comments (" + comments.length + ")"),
          comments.slice(-6).map(function (c, i) {
            return h("div", { key: i, style: { fontSize: 12, borderLeft: "2px solid " + borderC, paddingLeft: 10 } },
              h("span", { style: { color: muted, marginRight: 6 } }, (c.author || c.created_by || "?") + ":"), c.body || c.text || "");
          })));
      }
      return h("div", { style: { padding: "12px 16px 16px 34px", display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed " + borderC, background: "var(--muted, rgba(255,255,255,.02))" } }, rows);
    }

    function taskRow(t) {
      var sm = statusMeta(t.status);
      var pri = priorityBucket(t.priority);
      var prog = t.progress;
      var isOpen = openId === t.id;
      return h(Fragment, { key: t.id },
        h("div", {
          onClick: function () { openRow(t); },
          style: {
            display: "flex", alignItems: "center", gap: 10, padding: "8px 14px 8px 10px",
            borderTop: "1px solid " + borderC, cursor: "pointer", fontSize: 13
          },
          onMouseEnter: function (e) { e.currentTarget.style.background = "var(--muted, rgba(255,255,255,.03))"; },
          onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; }
        },
          h("span", { style: { color: muted, display: "inline-flex" } }, Caret(isOpen)),
          Dot(pri.color, 8),
          h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title || "(untitled)"),
          prog ? badge(prog.done + "/" + prog.total + " subtasks", prog.done >= prog.total && prog.total > 0 ? "#34d399" : "#fbbf24") : null,
          (t.comment_count ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: muted } }, CommentIcon(), t.comment_count) : null),
          // status dropdown (stop row toggle when interacting)
          h("span", { onClick: function (e) { e.stopPropagation(); } },
            h("select", {
              value: SETTABLE.indexOf(t.status) === -1 ? "" : t.status,
              onChange: function (e) { moveStatus(t, e.target.value); },
              title: "Move status",
              className: "font-courier",
              style: { background: "transparent", color: "inherit", border: "1px solid " + borderC, borderRadius: 999, padding: "2px 6px", fontSize: 11, cursor: "pointer" }
            },
              SETTABLE.indexOf(t.status) === -1 ? h("option", { value: "", style: { background: "var(--background,#111)" } }, sm.label) : null,
              SETTABLE.map(function (st) {
                return h("option", { key: st, value: st, style: { background: "var(--background,#111)", color: "var(--foreground,#eee)" } }, statusMeta(st).label);
              }))),
          t.assignee ? badge(t.assignee) : h("span", { style: { fontSize: 11, color: muted } }, "\u2014"),
          (t.tenant ? h("span", { style: { fontSize: 11, color: muted, fontFamily: "var(--font-courier, monospace)" } }, t.tenant) : null),
          h("span", { style: { fontSize: 11, color: muted, width: 34, textAlign: "right", flex: "0 0 auto" } }, ago(t.created_at, now))
        ),
        isOpen ? detailPanel(t) : null
      );
    }

    function groupBlock(g) {
      var head = groupHeader(g.key);
      var isCollapsed = !!collapsed[g.key];
      var doneCount = g.items.filter(function (t) { return t.status === "done"; }).length;
      return h("div", { key: g.key, style: { border: "1px solid " + borderC, borderRadius: 8, overflow: "hidden", marginBottom: 10 } },
        h("div", {
          onClick: function () { toggleGroup(g.key); },
          style: {
            display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer",
            background: "var(--muted, rgba(255,255,255,.03))", userSelect: "none"
          }
        },
          h("span", { style: { color: muted, display: "inline-flex" } }, Caret(!isCollapsed)),
          Dot(head.dot, 9),
          h("span", { style: { fontWeight: 600, fontSize: 13 } }, head.label),
          h("span", { style: { fontSize: 11, color: muted } }, g.items.length + (doneCount ? "  \u00b7  " + doneCount + " done" : ""))
        ),
        isCollapsed ? null : h("div", null, g.items.map(function (t) { return taskRow(t); }))
      );
    }

    var total = filtered.length;

    return h("div", { className: "flex flex-col gap-2", style: { fontFamily: "inherit" } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        h("h1", { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, "List"),
        h("span", { style: { fontSize: 12, color: muted } },
          loading ? "Loading\u2026" : (total + " task" + (total === 1 ? "" : "s") + (tasks.length !== total ? " of " + tasks.length : "")))
      ),
      toolbar,
      notice ? h("div", { style: { fontSize: 12, color: "#fbbf24", border: "1px solid " + borderC, borderRadius: 6, padding: "8px 12px", marginBottom: 10 } }, notice) : null,
      error ? h("div", { style: { fontSize: 13, color: "#f87171", border: "1px solid " + borderC, borderRadius: 8, padding: "16px" } }, "Error: " + error) : null,
      (!error && !loading && !groups.length) ? h("div", { style: { fontSize: 13, color: muted, border: "1px dashed " + borderC, borderRadius: 8, padding: "24px", textAlign: "center" } }, "No tasks match.") : null,
      groups.map(function (g) { return groupBlock(g); })
    );
  }

  window.__HERMES_PLUGINS__.register("tasklist", TaskListPage);
})();

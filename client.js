/**
 * dsh-sidebar-focus — Client half.
 *
 * Order and disclosure for the left sidebar, driven by what is actually running:
 *   1. a workspace with an active session floats to the top of the list;
 *   2. the workspace holding the selected session floats too — a brand-new session renders no
 *      status dot at all, so rule 1 can never see it;
 *   3. an active session floats to the top of its workspace;
 *   4. a workspace with nothing running stays folded.
 * Each rule is a switch on this bundle's own page in the Plugins panel.
 *
 * ## Contracts this file relies on
 *
 * Measured in the `@deepseek-ai/dsh-client-ui-workspace` build shipped with this profile
 * (`lib/client.js`, rows/WorkspaceBrowser sources), not guessed:
 *
 *   - the scrolling list is a `div[role="tree"]` (`AnimatedRows.render`);
 *   - a workspace header is `div[data-row-key="workspace:<key>"][role="treeitem"][aria-expanded]`,
 *     where `<key>` is the workspace id (`""` for Ungrouped). Its `parentElement` is a HoverCard
 *     span, NOT the section — resolve the section with `sectionOf`;
 *   - a session row is `div[data-row-key="session:<id>"][role="treeitem"][aria-selected]`, wrapped
 *     in a HoverCard span of its own, whose FIRST child is the status slot — the only place a
 *     row's own state dot lives (`SessionNodeItem` renders `SessionStatusDots` inside `span.slot`,
 *     and only when the row is neither archived nor blank);
 *   - a state dot carries `data-state` in {`ongoing`, `warning`, `done`, `error`, `idle`}
 *     (`ui-primitives` `StateDot`);
 *   - disclosure is persisted by the host store `dsh.workspace.view.v5` and is reachable as
 *     `ctx.get('uiWorkspace').view.setGroupExpanded(key, expanded)`
 *     (`UiWorkspaceService` receives `viewInstance.actions` as its `view` field).
 *
 * ## Why ordering is CSS and folding is a store write
 *
 * The list column is a plain block container (`overflow-y:auto`), so `order` does nothing until it
 * is made a flex column; ranking rows that way never moves a DOM node, so React reconciliation is
 * untouched. Folding cannot be done that way at all: a folded group renders no session rows
 * (`deriveGroups` returns an empty `sessions` array), so the disclosure state itself has to change.
 *
 * Every attribute this file writes is `data-wsf-*`, which is deliberately absent from the
 * MutationObserver filter below — the watcher cannot drive itself.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-focus',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-sidebar-focus'
    const CONFIG_KEY = 'dsh.sidebar-focus.v1'

    /** The scrolling session list; both the grouped and the flat body render one. */
    const TREE = '[role="tree"]'
    /** A workspace header. `parentElement` is NOT its section — see `sectionOf`. */
    const GROUP_HEAD = '[data-row-key^="workspace:"]'
    /** A session row. Its first child is the row's own status slot. */
    const SESSION_ROW = '[data-row-key^="session:"]'
    const GROUP_PREFIX = 'workspace:'

    /** Dots that mean "this session is working right now". */
    const ACTIVE_STATES = ['ongoing']
    /** Dots that mean "this session is waiting for you" — never hidden, and worth surfacing. */
    const ATTENTION_STATES = ['warning']
    /** The "finished while you were away" reminder dot. */
    const REMINDER_STATES = ['done']

    /**
     * How long a workspace must look foldable before disclosure may actually close it.
     *
     * The host clears `running` before it raises `completionUnread`, so the first "nothing is
     * running in here" scan can arrive while the finished-session reminder is still in flight.
     * Folding on that scan shut a workspace that had just produced a result — the "it collapses
     * the moment the task ends" symptom. The timer only has to outlast that hand-off.
     */
    const FOLD_GRACE_MS = 2500
    /** Base for `order`: every ranked workspace sorts ahead of the unranked ones (order 0). */
    const RANK_BASE = -10000

    /**
     * Attributes written by this plugin. Never observed, so the watcher cannot self-trigger.
     * `rank-tree` turns the scrolling column into a flex column (a prerequisite for `order`, on
     * both the grouped and the flat body); `rank-rows` does the same for one group section, so
     * sessions can be ranked inside it. Both are removed the moment their switch goes off, which
     * returns the sidebar to its stock layout.
     */
    const MARKS = ['data-wsf-group', 'data-wsf-rank-tree', 'data-wsf-rank-rows', 'data-wsf-busy', 'data-wsf-active']

    /** The switch surface, in the order the rows appear under Settings -> General. */
    const OPTIONS = [
      {
        key: 'pinBusyWorkspaces',
        order: 40,
        label: 'settings.pinBusyWorkspaces.label',
        hint: 'settings.pinBusyWorkspaces.hint',
      },
      {
        key: 'pinCurrentWorkspace',
        order: 41,
        label: 'settings.pinCurrentWorkspace.label',
        hint: 'settings.pinCurrentWorkspace.hint',
      },
      {
        key: 'expandBusyWorkspaces',
        order: 42,
        label: 'settings.expandBusyWorkspaces.label',
        hint: 'settings.expandBusyWorkspaces.hint',
      },
      {
        key: 'pinActiveSessions',
        order: 43,
        label: 'settings.pinActiveSessions.label',
        hint: 'settings.pinActiveSessions.hint',
      },
      {
        key: 'foldIdleWorkspaces',
        order: 44,
        label: 'settings.foldIdleWorkspaces.label',
        hint: 'settings.foldIdleWorkspaces.hint',
      },
      {
        key: 'keepAttentionOpen',
        order: 45,
        label: 'settings.keepAttentionOpen.label',
        hint: 'settings.keepAttentionOpen.hint',
      },
    ]

    /** Defaults: every rule on, reminder dots protected. */
    const DEFAULTS = {
      pinBusyWorkspaces: true,
      pinCurrentWorkspace: true,
      expandBusyWorkspaces: true,
      pinActiveSessions: true,
      foldIdleWorkspaces: true,
      keepAttentionOpen: true,
    }

    const CSS = `
/* Rank whole workspaces. The list column is a plain block container, so it is made a flex column
   first; the ranking itself is written as an inline order on each section, because the rank differs
   per workspace and no static rule can express that. A workspace keeps the place it earned when its
   session started — finishing does not drop it back — so this stylesheet's whole job is the flex
   column. No DOM node moves, so reconciliation is untouched, and with every ranking switch off the
   attribute is absent and the sidebar keeps its stock layout. */
[role="tree"][data-wsf-rank-tree]{display:flex;flex-direction:column}
/* Rank sessions inside one workspace: the header keeps the first slot, active rows follow it.
   A row is wrapped in HoverCard's own span (see sectionOf), so the flex item that carries order
   is that span and not the row: every rule matches the wrapped shape first and keeps the unwrapped
   one for the ungrouped bucket, whose header the host returns bare. */
[data-wsf-rank-rows]{display:flex;flex-direction:column}
[data-wsf-rank-rows] > *:has(> [data-row-key^="workspace:"]),
[data-wsf-rank-rows] > [data-row-key^="workspace:"]{order:-10}
[data-wsf-rank-rows] > *:has(> [data-row-key^="session:"][data-wsf-active]),
[data-wsf-rank-rows] > [data-row-key^="session:"][data-wsf-active]{order:-5}
/* The flat "one list" body ranks active sessions the same way, wrapped the same way. */
[role="tree"][data-wsf-rank-tree] > *:has(> [data-row-key^="session:"][data-wsf-active]),
[role="tree"][data-wsf-rank-tree] > [data-row-key^="session:"][data-wsf-active]{order:-1}
`

    const DICT = {
      zh: {
        'settings.pinBusyWorkspaces.label': '置顶最近有活动的工作区',
        'settings.pinBusyWorkspaces.hint': '有会话跑过的工作区排到最前，按最近一次活动排序；跑完不会掉回原位，直到别的会话把它顶下去（只影响显示，不改动你手动排好的顺序）',
        'settings.pinCurrentWorkspace.label': '置顶当前会话所在的工作区',
        'settings.pinCurrentWorkspace.hint': '你正在用的那个会话（包括刚新建、还没开始跑的）所在的工作区排到最前',
        'settings.expandBusyWorkspaces.label': '自动展开正在运行的工作区',
        'settings.expandBusyWorkspaces.hint': '有会话正在跑、或正在等你的工作区会自动展开，不用再点一下；你亲手折叠过的会保持折叠',
        'settings.pinActiveSessions.label': '置顶正在进行的会话',
        'settings.pinActiveSessions.hint': '运行中与等待你处理的会话，排到所属工作区的最前',
        'settings.foldIdleWorkspaces.label': '收起没有运行的工作区',
        'settings.foldIdleWorkspaces.hint': '没有任何会话在跑的工作区保持折叠；刚跑完的会先留一会儿再收，你手动展开过的会一直留着，直到它重新忙碌',
        'settings.keepAttentionOpen.label': '保留未读完成提醒',
        'settings.keepAttentionOpen.hint': '含「已完成未查看」提醒的工作区不自动折叠，避免漏掉刚跑完的会话',
        'settings.intro': '左侧工作区的排序与展开：6 个开关各自独立，改动立刻生效。',
        'settings.summary': '侧栏排序与展开 · 6 个开关',
        'settings.unavailable': '宿主接口不可用，自动折叠已关闭（见控制台）',
      },
      en: {
        'settings.pinBusyWorkspaces.label': 'Float recently active workspaces',
        'settings.pinBusyWorkspaces.hint': 'A workspace whose session ran most recently leads the list; finishing does not drop it back — only newer activity pushes it down (display only; your manual order is never rewritten)',
        'settings.pinCurrentWorkspace.label': 'Float the workspace you are working in',
        'settings.pinCurrentWorkspace.hint': 'The workspace holding the selected session leads the list — including a brand-new session that has not started yet',
        'settings.expandBusyWorkspaces.label': 'Expand running workspaces automatically',
        'settings.expandBusyWorkspaces.hint': 'A workspace with a running or waiting session opens by itself; one you folded yourself stays folded',
        'settings.pinActiveSessions.label': 'Float active sessions to the top',
        'settings.pinActiveSessions.hint': 'Running and waiting sessions lead their workspace',
        'settings.foldIdleWorkspaces.label': 'Fold workspaces with nothing running',
        'settings.foldIdleWorkspaces.hint': 'A workspace whose sessions are all idle stays folded; one that just finished is left open for a moment first, and one you opened yourself stays open until it gets busy again',
        'settings.keepAttentionOpen.label': 'Keep unread completion reminders open',
        'settings.keepAttentionOpen.hint': 'A workspace holding a finished-but-unseen session is never folded, so a completed run cannot slip past you',
        'settings.intro': 'Order and disclosure for the left sidebar: six independent switches, applied immediately.',
        'settings.summary': 'Sidebar order and disclosure · 6 switches',
        'settings.unavailable': 'Host interface unavailable — auto-fold is off (see console)',
      },
    }

    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    /** Read persisted settings, falling back per key: an unknown or unreadable value keeps the default. */
    function readConfig() {
      const next = { ...DEFAULTS }
      try {
        const raw = window.localStorage.getItem(CONFIG_KEY)
        if (raw === null) return next
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return next
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof parsed[key] === 'boolean') next[key] = parsed[key]
        }
      } catch (error) {
        console.error(`[${NS}] settings were unreadable; defaults are in use:`, error)
      }
      return next
    }

    /** One observable boolean/string slot, shared by the watcher and the settings rows. */
    function createCell(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (value === next) return
          value = next
          for (const listener of [...listeners]) listener(value)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    function createConfig() {
      const cell = createCell(readConfig())
      return {
        get: cell.get,
        subscribe: cell.subscribe,
        set(key, next) {
          const current = cell.get()
          if (current[key] === next) return
          const updated = { ...current, [key]: next }
          cell.set(updated)
          try {
            window.localStorage.setItem(CONFIG_KEY, JSON.stringify(updated))
          } catch (error) {
            console.error(`[${NS}] settings could not be persisted:`, error)
          }
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Reading the sidebar
     * ------------------------------------------------------------------ */

    /**
     * The states one session row reports, read from its own status slot only.
     * The hover card and the row menu render outside that slot, so neither pollutes this reading.
     */
    function rowStates(row) {
      const slot = row.firstElementChild
      if (slot === null) return []
      const states = []
      for (const dot of slot.querySelectorAll('[data-state]')) {
        const state = dot.getAttribute('data-state')
        if (state !== null) states.push(state)
      }
      return states
    }

    function hasAny(states, wanted) {
      for (const state of states) if (wanted.includes(state)) return true
      return false
    }

    /** Add or remove a marker attribute without touching anything else on the element. */
    function mark(element, attribute, present) {
      if (present) {
        if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '')
      } else if (element.hasAttribute(attribute)) {
        element.removeAttribute(attribute)
      }
    }

    /**
     * The group section that owns an element — and NOT `element.parentElement`.
     *
     * Every row the host renders is passed through the `HoverCard` primitive, which renders its
     * anchor inside a wrapper of its own (`ui-primitives` HoverCard returns
     * `jsxs("span", { ref: rootRef, … children: [Provider({ children: anchor })] })`), and
     * `ProjectRowItem` skips that wrapper only for the ungrouped bucket
     * (`if (row.createdAt === void 0) return ownRow`). So for every real workspace the header's
     * `parentElement` is that span and never the section. Marking the span anchored every rule to
     * an element the CSS can never match — the sidebar silently kept its stock order, which is
     * exactly the "nothing floats" symptom.
     *
     * A section is therefore found by walking up to the element whose own parent is the tree, or
     * the `role="group"` container that holds a nested workspace's section.
     */
    function sectionOf(tree, element) {
      let node = element
      while (node.parentElement !== null) {
        const parent = node.parentElement
        if (parent === tree || parent.getAttribute('role') === 'group') return node
        node = parent
      }
      return null
    }

    /**
     * The session rows one section owns.
     *
     * `:scope > row` finds nothing (the HoverCard span sits in between), and a plain descendant
     * search would also drag in the rows of a nested workspace group — so every candidate is
     * attributed by its own section instead.
     */
    function rowsOf(tree, group) {
      const rows = []
      for (const row of group.querySelectorAll(SESSION_ROW)) {
        if (sectionOf(tree, row) === group) rows.push(row)
      }
      return rows
    }

    /* ------------------------------------------------------------------ *
     * The watcher
     * ------------------------------------------------------------------ */

    /**
     * Follow the sidebar and apply the rules.
     *
     * Disclosure bookkeeping, in one place. The host stores one explicit boolean per workspace and
     * treats "unset" as folded (except for the group holding the selected session, which it opens
     * once), so both directions are ours to drive:
     *   - the first disclosure value seen for a key is a BASELINE, never intent;
     *   - a later flip this plugin did not write is someone else's decision — the user's, or a
     *     deliberate host action such as reveal-on-search — and is remembered as intent in that
     *     direction, so we never fight it;
     *   - both intents expire when the workspace's busy reading changes, because they described the
     *     previous situation.
     */
    function createWatcher(ctx, config, foldStatus) {
      /** Keys the user opened themselves: left open while that intent stands. */
      const keepOpen = new Set()
      /** Keys the user closed themselves: left closed while that intent stands. */
      const keepClosed = new Set()
      /** Last disclosure value observed per key. */
      const seen = new Map()
      /** The value this plugin last wrote per key, so its own flips are not read as intent. */
      const wrote = new Map()
      /** Last busy reading per key; a change of context expires both intents. */
      const busySeen = new Map()
      /** Per-key debounce, so a host that ignored a write cannot turn this into a loop. */
      const writtenAt = new Map()
      /**
       * The Session status snapshot and the Workspace membership, published by the
       * zero-render bridge registered on `shell.overlay` (see StatusBridge). Both
       * stay null until that component mounts, and every reader treats null as
       * "not known yet" rather than as "nothing is running".
       */
      const statusCell = createCell(null)
      const workspacesCell = createCell(null)
      // A status or membership change alters no DOM inside a folded group, so it has
      // to wake the scan itself — otherwise a workspace that just started working
      // stays shut. `schedule` is a function declaration, so this is not a TDZ read.
      const stopStatusWatch = statusCell.subscribe(schedule)
      const stopWorkspaceWatch = workspacesCell.subscribe(schedule)
      const broken = { value: false }
      let frame = 0
      let stopped = false
      /**
       * Ranking is LATCHED, not live. A workspace keeps the place it earned when its session
       * started: finishing does not drop it back, only a *newer* activity pushes it down. So the
       * timestamp is written on the idle -> active edge and never refreshed while it stays active,
       * which is exactly what "the current one shifts down one slot" needs.
       */
      const lastActive = new Map()
      /** Last "this workspace should lead" reading per key, so the edge can be detected. */
      const activeSeen = new Map()
      /**
       * When a workspace first looked foldable. Nothing is closed until it has looked that way for
       * `FOLD_GRACE_MS`, because the host reports "finished" in two steps (see FOLD_GRACE_MS).
       */
      const idleSince = new Map()
      /** One pending re-check, so a skipped fold is revisited without a DOM change to wake us. */
      let wakeTimer = 0
      /** When that pending re-check is due, so the earliest request wins rather than the first. */
      let wakeAt = 0
      /** Set when a pass discovers a new activity whose rank that same pass cannot apply yet. */
      let rankDirty = false

      /** Write one disclosure value through the workspace browser's own view store. */
      function write(key, expanded) {
        const face = ctx.get('uiWorkspace')
        const view = face === null || face === undefined ? undefined : face.view
        if (view === undefined || typeof view.setGroupExpanded !== 'function') {
          if (!broken.value) {
            broken.value = true
            foldStatus.set('unavailable')
            console.error(`[${NS}] uiWorkspace.view.setGroupExpanded is missing; disclosure control is off`)
          }
          return false
        }
        try {
          view.setGroupExpanded(key, expanded)
          wrote.set(key, expanded)
          writtenAt.set(key, Date.now())
          return true
        } catch (error) {
          if (!broken.value) {
            broken.value = true
            foldStatus.set('unavailable')
            console.error(`[${NS}] changing a workspace's disclosure failed; disclosure control is off:`, error)
          }
          return false
        }
      }

      /** Whether the per-key debounce still blocks a write. */
      function cooling(key) {
        const last = writtenAt.get(key)
        return last !== undefined && Date.now() - last < 600
      }

      /**
       * Whether a workspace holds a running or waiting session, judged from the
       * Session status snapshot instead of from rendered rows.
       *
       * This is the only source that stays true while a group is folded: the
       * workspace browser renders NO session row for a folded group, so a check
       * reading rows can never notice a session starting inside one — and that
       * group stays shut with work running in it. The rows are still read, for the
       * row-level marks and as a fallback while the snapshot is not ready.
       */
      function factsFromSnapshot(key, settings) {
        const statuses = statusCell.get()
        const list = workspacesCell.get()
        if (statuses === null || list === null) return { busy: false, blocking: false }
        const items = Array.isArray(list.items) ? list.items : []
        const view = items.find((item) => item !== null && item !== undefined && item.workspaceId === key)
        if (view === undefined) return { busy: false, blocking: false }
        const ids = Array.isArray(view.sessionIds) ? view.sessionIds : []
        let busy = false
        let blocking = false
        for (const id of ids) {
          const status = statuses.get(id)
          if (status === undefined || status === null) continue
          const running = status.running === true
          const waiting = status.pendingInteraction !== undefined && status.pendingInteraction !== null
          if (running || waiting) busy = true
          if (running || waiting || (settings.keepAttentionOpen && status.completionUnread === true)) {
            blocking = true
          }
        }
        return { busy, blocking }
      }

      function scanGroup(settings, tree, group, head, key, ranking) {
        const rows = rowsOf(tree, group)
        let busy = false
        let blocking = false
        // The selected session's workspace is where you are working right now — and a brand-new
        // session is exactly that case. `SessionNodeItem` renders its status slot as
        // `!row.blank && …`, so a just-created session draws NO state dot at all, and the status
        // snapshot has not listed it yet either; neither "busy" source can ever see it. The
        // selection is read off the row itself (`aria-selected`), which a blank row carries too.
        let containsCurrent = false
        for (const row of rows) {
          if (row.getAttribute('aria-selected') === 'true') containsCurrent = true
          const states = rowStates(row)
          const active = hasAny(states, ACTIVE_STATES)
          const attention = hasAny(states, ATTENTION_STATES)
          const reminder = hasAny(states, REMINDER_STATES)
          mark(row, 'data-wsf-active', settings.pinActiveSessions && (active || attention))
          busy = busy || active || attention
          blocking = blocking || active || attention || (settings.keepAttentionOpen && reminder)
        }

        // Rows exist only while the group is open, so the snapshot is what carries
        // "something is running in here" for a folded group. Union the two sources:
        // either one seeing work is enough to keep the workspace from being shut.
        const facts = factsFromSnapshot(key, settings)
        busy = busy || facts.busy
        blocking = blocking || facts.blocking

        // `data-wsf-group` identifies the section for the workspace-level rank rule; ranking rows
        // inside it additionally needs a flex section.
        mark(group, 'data-wsf-group', true)
        mark(group, 'data-wsf-rank-rows', settings.pinActiveSessions)
        // Two independent reasons to lead, either one is enough — the busy switch owns "busy",
        // the current-workspace switch owns "selected", and turning one off must not disable
        // the other.
        const leads =
          (settings.pinBusyWorkspaces && busy) || (settings.pinCurrentWorkspace && containsCurrent)
        mark(group, 'data-wsf-busy', leads)

        // Latch the moment a workspace STARTS leading. Only that edge moves it: while it keeps
        // leading the stamp stays put, and finishing never rewrites it — which is precisely what
        // "the finished workspace keeps its place, the newer one shifts it down" needs.
        if (leads && activeSeen.get(key) !== true) {
          lastActive.set(key, Date.now())
          rankDirty = true
        }
        activeSeen.set(key, leads)

        // The ranking is written as an inline `order`; the stylesheet only supplies the flex
        // column, because ranks differ per workspace and no static rule can express that.
        const rank = ranking.get(key)
        if (rank === undefined) {
          if (group.style.order !== '') group.style.order = ''
        } else {
          const next = String(RANK_BASE + rank)
          if (group.style.order !== next) group.style.order = next
        }

        const expanded = head.getAttribute('aria-expanded') === 'true'
        const previous = seen.get(key)
        seen.set(key, expanded)
        if (previous !== undefined && previous !== expanded) {
          // A flip this plugin did not write is someone else's decision; honour it in that
          // direction rather than fighting it on the next scan.
          if (wrote.get(key) !== expanded) {
            if (expanded) {
              keepOpen.add(key)
              keepClosed.delete(key)
            } else {
              keepClosed.add(key)
              keepOpen.delete(key)
            }
          }
        }
        if (busySeen.get(key) !== busy) {
          // The workspace's situation changed, so an intent recorded for the old one expires.
          busySeen.set(key, busy)
          keepOpen.delete(key)
          keepClosed.delete(key)
        }

        if (broken.value) return

        // The workspace holding the selected session stays open. The host opens that group on its
        // own only while it has no stored state — and we store state, so without this rule a
        // session switch could land on a workspace we had folded.
        if (containsCurrent && !expanded && !keepClosed.has(key) && !cooling(key)) {
          write(key, true)
          return
        }
        // A workspace that is working opens by itself, unless the user closed it on purpose.
        if (settings.expandBusyWorkspaces && busy && !expanded && !keepClosed.has(key) && !cooling(key)) {
          write(key, true)
          return
        }
        if (!settings.foldIdleWorkspaces) return
        // Ungrouped is the catch-all bucket, not a workspace someone chose: never fold it away.
        // Folded only while the selected session lives somewhere else. Every reason to stay open
        // also resets the grace period below, so a workspace that starts working again during it
        // is never closed on stale timing.
        if (!expanded || blocking || keepOpen.has(key) || key === '' || containsCurrent) {
          idleSince.delete(key)
          return
        }
        if (cooling(key)) return
        // `blocking` already covers a finished-but-unread reminder once it has arrived; this grace
        // period covers the gap before it does. Folding on the first idle scan is what shut a
        // workspace at the very moment its task ended.
        let since = idleSince.get(key)
        if (since === undefined) {
          since = Date.now()
          idleSince.set(key, since)
        }
        const remaining = FOLD_GRACE_MS - (Date.now() - since)
        if (remaining > 0) {
          wakeIn(remaining)
          return
        }
        idleSince.delete(key)
        write(key, false)
      }

      function scan() {
        const settings = config.get()
        // A new activity is discovered while walking the groups, i.e. AFTER this ranking has been
        // computed. That changes no DOM, so without the re-scan at the end of this function the
        // freshly earned order would never reach the sidebar.
        rankDirty = false
        // Rank once per scan: most recently activated workspace first. Workspaces that never led
        // carry no `order` at all, so they keep their stock sequence behind these.
        const ranking = new Map()
        const ranked = [...lastActive.entries()].sort((a, b) => b[1] - a[1])
        for (let at = 0; at < ranked.length; at += 1) ranking.set(ranked[at][0], at)
        const trees = document.querySelectorAll(TREE)
        for (const tree of trees) {
          // `order` needs a flex column; with every ranking switch off the stock block layout is
          // left alone. The current-workspace rule ranks the same column, so it arms this too.
          mark(
            tree,
            'data-wsf-rank-tree',
            settings.pinBusyWorkspaces || settings.pinCurrentWorkspace || settings.pinActiveSessions,
          )
          const heads = tree.querySelectorAll(GROUP_HEAD)
          if (heads.length > 0) {
            for (const head of heads) {
              const group = sectionOf(tree, head)
              if (group === null) continue
              scanGroup(
                settings,
                tree,
                group,
                head,
                (head.getAttribute('data-row-key') ?? '').slice(GROUP_PREFIX.length),
                ranking,
              )
            }
            continue
          }
          // Flat "one list" body: active rows lead the whole list. These rows are wrapped the same
          // way, so a descendant search is what finds them.
          for (const row of tree.querySelectorAll(SESSION_ROW)) {
            const states = rowStates(row)
            mark(
              row,
              'data-wsf-active',
              settings.pinActiveSessions && (hasAny(states, ACTIVE_STATES) || hasAny(states, ATTENTION_STATES)),
            )
          }
        }
        // A workspace just earned a rank; one more pass is what puts it into the DOM.
        if (rankDirty) wakeIn(0)
      }

      function schedule() {
        if (stopped || frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          if (stopped) return
          try {
            scan()
          } catch (error) {
            console.error(`[${NS}] a sidebar scan failed:`, error)
          }
        })
      }

      /**
       * Ask for one more scan in `ms`.
       *
       * A fold that is merely being deferred changes no DOM, so nothing else would wake the
       * observer afterwards and the workspace would sit on a stale reading forever — this timer is
       * what lets the grace period actually elapse.
       */
      function wakeIn(ms) {
        if (stopped) return
        const wait = Math.max(50, Math.ceil(ms))
        const at = Date.now() + wait
        // Coalesce the requests, but keep whichever is due first: a rank update must not be pushed
        // back just because a fold grace period happens to be pending.
        if (wakeTimer !== 0 && wakeAt <= at) return
        if (wakeTimer !== 0) window.clearTimeout(wakeTimer)
        wakeAt = at
        wakeTimer = window.setTimeout(() => {
          wakeTimer = 0
          schedule()
        }, wait)
      }

      const observer = new MutationObserver(schedule)
      const root = document.body ?? document.documentElement
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        // Only host-owned attributes: our own `data-wsf-*` writes are invisible to this observer.
        attributeFilter: ['data-row-key', 'aria-expanded', 'aria-selected', 'data-state', 'role'],
      })
      schedule()

      return {
        /** Re-run the rules now — a switch change alters no DOM, so nothing else would wake us. */
        refresh: schedule,
        /** The bridges publish into these cells; the watcher owns them. */
        statuses: statusCell,
        workspaces: workspacesCell,
        dispose() {
          stopped = true
          observer.disconnect()
          stopStatusWatch()
          stopWorkspaceWatch()
          if (frame !== 0) window.cancelAnimationFrame(frame)
          if (wakeTimer !== 0) window.clearTimeout(wakeTimer)
          // The inline `order` is ours as well; clear it before the markers that identify its owners.
          for (const element of document.querySelectorAll('[data-wsf-group]')) element.style.order = ''
          for (const element of document.querySelectorAll(MARKS.map((name) => `[${name}]`).join(','))) {
            for (const name of MARKS) element.removeAttribute(name)
          }
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Settings rows
     * ------------------------------------------------------------------ */

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      minHeight: '32px',
      padding: '4px 0',
    }
    const ROW_TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
    const ROW_LABEL_STYLE = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px' }
    const ROW_HINT_STYLE = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' }
    const ROW_NOTE_STYLE = { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px', lineHeight: '18px' }

    function switchStyle(on) {
      return {
        flex: 'none',
        width: '34px',
        height: '20px',
        padding: '0',
        border: 'none',
        borderRadius: '10px',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background-color .15s ease',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
      }
    }

    function knobStyle(on) {
      return {
        position: 'absolute',
        top: '2px',
        left: on ? '16px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-base)',
        transition: 'left .15s ease',
      }
    }

    function useCell(cell) {
      const [value, setValue] = React.useState(cell.get)
      React.useEffect(() => cell.subscribe(setValue), [cell])
      return value
    }

    /* The block the Plugins page renders inside this bundle's own detail page. */
    const PANEL_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px' }
    const PANEL_INTRO_STYLE = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
      marginBottom: '6px',
    }
    const SUMMARY_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' }

    /** One preference row: label + hint on the left, a switch on the right. */
    function OptionRow({ option, config, foldStatus, t }) {
      const settings = useCell(config)
      const fold = useCell(foldStatus)
      const on = settings[option.key] === true
      const brokenHere = option.key === 'foldIdleWorkspaces' && fold === 'unavailable'
      return h(
        'div',
        { style: ROW_STYLE },
        h(
          'div',
          { style: ROW_TEXT_STYLE },
          h('div', { style: ROW_LABEL_STYLE }, t(option.label)),
          h('div', { style: brokenHere ? ROW_NOTE_STYLE : ROW_HINT_STYLE }, brokenHere ? t('settings.unavailable') : t(option.hint)),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': on,
            'aria-label': t(option.label),
            onClick: () => {
              config.set(option.key, !on)
            },
            style: switchStyle(on),
          },
          h('span', { style: knobStyle(on) }),
        ),
      )
    }

    /**
     * This bundle's configuration block, rendered by the Plugins page inside its
     * own detail page.
     *
     * The owner dispatches the `plugins.bundle.config` key with `view: 'page'`
     * for a bundle page (it would ask for `view: 'summary'` where a one-liner is
     * wanted), so both shapes are answered here instead of assuming the page —
     * a registration alone is what makes the owner render this section at all.
     */
    function SettingsPanel({ config, foldStatus, view, t }) {
      if (view === 'summary') return h('div', { style: SUMMARY_STYLE }, t('settings.summary'))
      return h(
        'div',
        { style: PANEL_STYLE },
        h('div', { style: PANEL_INTRO_STYLE }, t('settings.intro')),
        ...OPTIONS.map((option) => h(OptionRow, { key: option.key, option, config, foldStatus, t })),
      )
    }

    /* ------------------------------------------------------------------ *
     * Status bridge
     * ------------------------------------------------------------------ */

    /**
     * Two zero-render bridges that hand the sidebar watcher facts the DOM cannot
     * give it while a group is folded: the Session status snapshot, and the
     * Workspace membership that says which sessions belong to which workspace.
     *
     * They register on `shell.overlay` only because that seat is always mounted.
     * Each hook gets its own component on purpose: if a host ever stops supplying
     * one, only that bridge falls silent instead of changing the number of hooks a
     * component calls.
     */
    function StatusBridge({ useSessionStatus, publish }) {
      if (typeof useSessionStatus !== 'function') return null
      const statuses = useSessionStatus((snapshot) => snapshot)
      React.useEffect(() => {
        publish(statuses)
      }, [publish, statuses])
      return null
    }

    function WorkspaceBridge({ useWorkspaces, publish }) {
      if (typeof useWorkspaces !== 'function') return null
      const workspaces = useWorkspaces((snapshot) => snapshot)
      React.useEffect(() => {
        publish(workspaces)
      }, [publish, workspaces])
      return null
    }

    /** One seat occupant hosting both bridges. */
    function FactsBridge({ useSessionStatus, useWorkspaces, publishStatus, publishWorkspaces }) {
      return h(
        React.Fragment,
        null,
        h(StatusBridge, { useSessionStatus, publish: publishStatus }),
        h(WorkspaceBridge, { useWorkspaces, publish: publishWorkspaces }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Wiring
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      const config = createConfig()
      const foldStatus = createCell('unknown')

      ctx.effect(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.textContent = CSS
        document.head.append(tag)
        return () => {
          tag.remove()
        }
      }, `${NS}: styles`)

      const watcher = createWatcher(ctx, config, foldStatus)
      ctx.effect(() => () => watcher.dispose(), `${NS}: sidebar watcher`)
      // Flipping a switch changes no DOM node, so the observer would not fire on its own.
      ctx.effect(() => config.subscribe(watcher.refresh), `${NS}: settings -> sidebar`)

      // `shell.overlay` is the always-mounted seat. This occupant paints nothing: it
      // exists so the watcher can learn about work running inside a FOLDED group,
      // where no session row exists to read (see StatusBridge).
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: `${NS}.status-bridge`,
            order: 0,
          },
          (props) =>
            h(FactsBridge, {
              useSessionStatus: props.useSessionStatus,
              useWorkspaces: props.useWorkspaces,
              publishStatus: watcher.statuses.set,
              publishWorkspaces: watcher.workspaces.set,
            }),
        ),
      )

      /* The switches live on this bundle's own page in the Plugins panel, keyed by
       * the package name. That page renders the section only when a registration
       * exists under that key, so registering here is what makes the controls
       * appear there — and removing the old General-page rows is what keeps them
       * from showing up in two places. */
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: NS,
            locale: NS,
          },
          (props) => h(SettingsPanel, { config, foldStatus, view: props.view, t: props.t }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})

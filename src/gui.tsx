/**
 * Desktop GUI part of the quota-watchdog plugin.
 *
 * Adds to OpenCode Desktop:
 * - a side panel tab "MiniMax 额度" with live quota bars per window and the
 *   task queue (add / list / edit / run),
 * - a composer pill showing the worst remaining percent,
 * - a palette command to open the panel.
 *
 * Data comes from the server part over the WatchdogRpc contract
 * (initial fetch + `updated` / `queueUpdated` events + a slow polling fallback).
 *
 * NOTE: the panel renders once and then updates through Solid's reactivity, so
 * every dynamic value must be read inside the JSX (never captured in a plain
 * variable at the top of a component body).
 */
import { onCleanup, createSignal, createMemo } from "solid-js"
import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  type ComposerPillRow,
  type ComposerPillTone,
  type PanelTab,
} from "@opencode/plugin/gui"
import { WatchdogRpc, type WatchdogStatus, type QueueSnapshot, type QueueTask } from "./rpc"

const WINDOW_LABELS: Record<string, string> = { "5h": "5 小时窗口", weekly: "每周窗口" }

function barColor(percentRemaining: number | null, mode: WatchdogStatus["mode"], stopPercentUsed: number): string {
  if (mode === "paused") return "#ef4444"
  if (percentRemaining === null) return "#9ca3af"
  const used = 100 - percentRemaining
  if (used >= stopPercentUsed || percentRemaining <= 10) return "#ef4444"
  if (percentRemaining <= 35) return "#f59e0b"
  return "#22c55e"
}

function formatTime(epochMs: number | null): string {
  if (epochMs === null) return "未知"
  return new Date(epochMs).toLocaleString("zh-CN", { hour12: false })
}

function formatClock(epochMs: number | null): string {
  if (!epochMs) return ""
  return new Date(epochMs).toLocaleTimeString("zh-CN", { hour12: false })
}

/** Reset time in a compact form: "15:00" today, "11-18 15:00" otherwise. */
function formatReset(epochMs: number | null): string {
  if (!epochMs) return "未知"
  const date = new Date(epochMs)
  const time = date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return time
  return `${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${time}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0 分钟"
  const total = Math.floor(ms / 60_000)
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours <= 0) return `${minutes} 分钟`
  return `${hours} 小时 ${minutes} 分`
}

export default Plugin.define({
  setup(ctx) {
    const [status, setStatus] = createSignal<WatchdogStatus | null>(null)
    const [queue, setQueue] = createSignal<QueueSnapshot | null>(null)
    const [draft, setDraft] = createSignal("")
    const [autoHours, setAutoHours] = createSignal("8")
    const [idleStartValue, setIdleStartValue] = createSignal("22:00")
    const [idleEndValue, setIdleEndValue] = createSignal("05:00")
    const [idleEdited, setIdleEdited] = createSignal(false)
    const [editing, setEditing] = createSignal<string | null>(null)
    const [editText, setEditText] = createSignal("")
    const [now, setNow] = createSignal(Date.now())

    const client = ctx.client.rpc(WatchdogRpc)

    function currentSessionID(): string | undefined {
      return ctx.sessions.current()?.id
    }

    async function refresh(): Promise<void> {
      try {
        const result = (await client.status({})) as WatchdogStatus
        setStatus(result)
      } catch {
        // Server restarting, RPC not registered, or plugin disabled: keep last data.
      }
    }

    /**
     * Rebuilds the static stop/resume report on the server and opens it with
     * the system's default browser. Nothing is rendered in the panel itself.
     */
    async function openReport(): Promise<void> {
      try {
        const result = (await client.report({})) as { path: string; count: number }
        if (ctx.desktop) await ctx.desktop.launch(result.path)
      } catch {
        // No desktop shell or no RPC: nothing to open, keep the panel as is.
      }
    }

    async function refreshQueue(): Promise<void> {
      try {
        const result = (await client.queueList({})) as QueueSnapshot
        applyQueue(result)
      } catch {
        // keep last data
      }
    }

    function applyQueue(result: unknown): void {
      if (result && typeof result === "object") {
        const snapshot = result as QueueSnapshot
        setQueue(snapshot)
        // Keep the idle window inputs in sync until the user edits them.
        if (!idleEdited()) {
          if (snapshot.idleStart) setIdleStartValue(snapshot.idleStart)
          if (snapshot.idleEnd) setIdleEndValue(snapshot.idleEnd)
        }
      }
    }

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = client.events.on("updated", (event: { data?: unknown }) => {
        const payload = (event?.data ?? event) as WatchdogStatus
        if (payload && typeof payload === "object" && "mode" in payload) setStatus(payload)
      })
      const unsubscribeQueue = client.events.on("queueUpdated", (event: { data?: unknown }) => {
        const payload = (event?.data ?? event) as QueueSnapshot
        if (payload && typeof payload === "object" && "tasks" in payload) setQueue(payload)
      })
      const previous = unsubscribe
      unsubscribe = () => {
        previous?.()
        unsubscribeQueue()
      }
    } catch {
      // Fall back to polling only.
    }

    const fallbackTimer = setInterval(() => void refresh(), 30_000)
    const queueTimer = setInterval(() => void refreshQueue(), 10_000)
    const clockTimer = setInterval(() => setNow(Date.now()), 10_000)
    void refresh()
    void refreshQueue()

    onCleanup(() => {
      clearInterval(fallbackTimer)
      clearInterval(queueTimer)
      clearInterval(clockTimer)
      unsubscribe?.()
    })

    type PanelTarget = NonNullable<ReturnType<typeof ctx.sessions.current>>

    function openPanelFor(target?: PanelTarget): void {
      const session = target ?? ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:quota`, session)
    }

    function openPanel(): void {
      openPanelFor()
    }

    // ------------------------------------------------------------- task queue

    async function addTask(): Promise<void> {
      const text = draft().trim()
      const sessionID = currentSessionID()
      if (!text || !sessionID) return
      try {
        applyQueue(await client.queueAdd({ text, sessionID }))
        setDraft("")
      } catch {
        // keep the draft
      }
    }

    async function removeTask(task: QueueTask): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) return
      try {
        applyQueue(await client.queueRemove({ taskID: task.id, sessionID }))
      } catch {}
    }

    async function saveTask(task: QueueTask): Promise<void> {
      const sessionID = currentSessionID()
      const text = editText().trim()
      if (!sessionID || !text) return
      try {
        applyQueue(await client.queueUpdate({ taskID: task.id, text, sessionID }))
        setEditing(null)
      } catch {}
    }

    async function runTask(task: QueueTask): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) return
      try {
        applyQueue(await client.queueRunNow({ taskID: task.id, sessionID }))
      } catch {}
    }

    async function runHead(): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) return
      try {
        applyQueue(await client.queueRunNow({ sessionID }))
      } catch {}
    }

    async function toggleAuto(enabled: boolean): Promise<void> {
      try {
        const hours = Number(autoHours())
        const durationMs = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : undefined
        applyQueue(await client.queueSetAuto({ enabled, durationMs: durationMs ?? null }))
      } catch {}
    }

    /** Update the daily idle window (HH:MM local time, may cross midnight). */
    async function setIdle(patch: { enabled?: boolean; start?: string; end?: string }): Promise<void> {
      if (patch.start !== undefined) {
        setIdleStartValue(patch.start)
        setIdleEdited(true)
      }
      if (patch.end !== undefined) {
        setIdleEndValue(patch.end)
        setIdleEdited(true)
      }
      try {
        applyQueue(await client.queueSetIdle(patch))
      } catch {}
    }

    async function clearExecuted(): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) return
      try {
        applyQueue(await client.queueClearExecuted({ sessionID }))
      } catch {}
    }

    interface Group {
      sessionID: string
      label: string
      project: string
      tasks: QueueTask[]
    }

    const groups = createMemo<Group[]>(() => {
      const snapshot = queue()
      if (!snapshot) return []
      const mine = currentSessionID()
      const map = new Map<string, Group>()
      for (const task of snapshot.tasks) {
        let group = map.get(task.sessionID)
        if (!group) {
          group = {
            sessionID: task.sessionID,
            label: task.sessionTitle || task.sessionID,
            project: task.projectName || task.projectDir,
            tasks: [],
          }
          map.set(task.sessionID, group)
        }
        group.tasks.push(task)
      }
      const list = [...map.values()]
      for (const group of list) {
        group.tasks.sort((a, b) => {
          if (a.state !== b.state) return a.state === "pending" ? -1 : 1
          return a.state === "pending" ? a.createdAt - b.createdAt : (b.dispatchedAt ?? 0) - (a.dispatchedAt ?? 0)
        })
      }
      // Current session first, then the rest by most recent activity.
      list.sort((a, b) => {
        const aMine = a.sessionID === mine
        const bMine = b.sessionID === mine
        if (aMine !== bMine) return aMine ? -1 : 1
        const aTime = Math.max(...a.tasks.map((t) => t.dispatchedAt ?? t.createdAt))
        const bTime = Math.max(...b.tasks.map((t) => t.dispatchedAt ?? t.createdAt))
        return bTime - aTime
      })
      return list
    })

    function TaskRow(props: { task: QueueTask; mine: boolean }) {
      const task = () => props.task
      const editable = () => props.mine && task().state === "pending"
      return (
        <div
          style={{
            "border-left": `2px solid ${task().state === "pending" ? "#3b82f6" : "#22c55e"}`,
            padding: "4px 0 4px 8px",
            margin: "6px 0",
            opacity: task().state === "pending" ? 1 : 0.62,
          }}
        >
          {editing() === task().id ? (
            <div>
              <textarea
                value={editText()}
                onInput={(e) => setEditText(e.currentTarget.value)}
                style={{
                  width: "100%",
                  "min-height": "54px",
                  "font-size": "12px",
                  padding: "4px",
                  "border-radius": "4px",
                  "border": "1px solid rgba(127,127,127,.4)",
                  background: "transparent",
                  color: "inherit",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", gap: "6px", "margin-top": "4px" }}>
                <button
                  style={{ "font-size": "11px", padding: "2px 8px", cursor: "pointer" }}
                  onClick={() => void saveTask(task())}
                >
                  保存
                </button>
                <button
                  style={{ "font-size": "11px", padding: "2px 8px", cursor: "pointer" }}
                  onClick={() => setEditing(null)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div
                style={{
                  "font-size": "12px",
                  "line-height": "1.35",
                  "overflow": "hidden",
                  "display": "-webkit-box",
                  "-webkit-line-clamp": "2",
                  "-webkit-box-orient": "vertical",
                }}
                title={task().text}
              >
                {task().text}
              </div>
              <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-top": "3px" }}>
                <span style={{ "font-size": "10px", opacity: 0.6 }}>
                  {task().state === "pending" ? "待执行" : "已执行"}
                  {task().dispatchedAt ? ` · ${formatClock(task().dispatchedAt)}` : ""}
                  {task().error ? ` · ${task().error}` : ""}
                </span>
                {editable() ? (
                  <span style={{ display: "flex", gap: "4px" }}>
                    <button
                      title="立即执行"
                      style={{ "font-size": "10px", padding: "0 5px", cursor: "pointer" }}
                      onClick={() => void runTask(task())}
                    >
                      ▶
                    </button>
                    <button
                      title="编辑"
                      style={{ "font-size": "10px", padding: "0 5px", cursor: "pointer" }}
                      onClick={() => {
                        setEditing(task().id)
                        setEditText(task().text)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      title="删除"
                      style={{ "font-size": "10px", padding: "0 5px", cursor: "pointer" }}
                      onClick={() => void removeTask(task())}
                    >
                      ✕
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )
    }

    ctx.add(
      Command,
      (): Command => ({
        id: "quota",
        title: "打开 MiniMax 额度面板",
        description: "quota-watchdog",
        run: openPanel,
      }),
    )

    ctx.add(MenuItem, (): MenuItem => {
      const current = status()
      const pending = queue()?.pending ?? 0
      return {
        menu: "session.panel",
        id: "quota",
        title: "MiniMax 额度",
        description:
          !current || current.worstPercentRemaining === null
            ? "尚未获取额度"
            : current.mode === "paused"
              ? "已暂停任务"
              : `剩余 ${current.worstPercentRemaining}%${pending > 0 ? ` · ${pending} 个待执行` : ""}`,
        run: openPanel,
      }
    })

    const quotaTab: PanelTab = {
      id: "quota",
      title: "MiniMax 额度",
    }

    ctx.add(Panel, {
      id: "quota",
      region: "side",
      width: "narrow",
      list: (input) => (input.open.includes("quota") ? [quotaTab] : []),
      render: () => (
        <div style={{ padding: "12px", "font-size": "13px" }}>
          {/* ---------------------------------------------------------- quota */}
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
            <strong>MiniMax 额度</strong>
            <span
              style={{
                "font-size": "11px",
                padding: "2px 8px",
                "border-radius": "999px",
                background:
                  !status() || status()!.mode === "disabled"
                    ? "rgba(127,127,127,.2)"
                    : status()!.mode === "paused"
                      ? "rgba(239,68,68,.15)"
                      : "rgba(34,197,94,.15)",
                color: !status() || status()!.mode === "disabled" ? "inherit" : status()!.mode === "paused" ? "#ef4444" : "#22c55e",
              }}
            >
              {!status()
                ? "加载中"
                : status()!.mode === "ok"
                  ? "监控中"
                  : status()!.mode === "paused"
                    ? `${status()!.pausedMarker || "⛔"} 已暂停任务`
                    : "已停用"}
            </span>
          </div>

          {status() && status()!.windows.length > 0 ? (
            <div>
              {status()!.windows.map((row) => {
                const color = () => barColor(row.percentRemaining, status()!.mode, status()!.stopPercentUsed)
                const used = () => (row.percentRemaining === null ? null : Math.round(100 - row.percentRemaining))
                return (
                  <div style={{ margin: "10px 0" }}>
                    <div style={{ display: "flex", "justify-content": "space-between", "font-size": "12px", "margin-bottom": "4px" }}>
                      <span style={{ "font-weight": "600" }}>{WINDOW_LABELS[row.window] ?? row.window}</span>
                      <span style={{ color: color() }}>
                        {row.percentRemaining === null ? "无数据" : `已用 ${used()}% / 剩余 ${row.percentRemaining}%`}
                      </span>
                    </div>
                    <div style={{ height: "6px", background: "rgba(127,127,127,.25)", "border-radius": "3px", overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${row.percentRemaining ?? 0}%`,
                          background: color(),
                          "border-radius": "3px",
                          transition: "width .4s ease",
                        }}
                      />
                    </div>
                    <div style={{ "font-size": "11px", opacity: 0.7, "margin-top": "3px" }}>
                      {row.model} · 重置 {formatTime(row.resetsAt)}
                    </div>
                  </div>
                )
              })}
              <div style={{ "font-size": "11px", opacity: 0.7, "margin-top": "8px" }}>
                {status()!.mode === "paused" && status()!.nextResetAt !== null
                  ? `预计恢复：${formatTime(status()!.nextResetAt)}`
                  : `停止阈值：已用 ≥ ${status()!.stopPercentUsed}%`}
                {status()!.stoppedSessions > 0 ? ` · 已停止 ${status()!.stoppedSessions} 个会话` : ""}
              </div>
              <div style={{ "font-size": "11px", opacity: 0.5, "margin-top": "4px" }}>
                更新于 {formatTime(status()!.lastCheckMs)}（{status()!.endpoint === "cn" ? "国内版" : "国际版"}）
              </div>
              {status()!.lastError ? (
                <div style={{ "font-size": "11px", color: "#f59e0b", "margin-top": "6px" }}>最近错误：{status()!.lastError}</div>
              ) : null}
            </div>
          ) : (
            <div style={{ opacity: 0.7, "margin-top": "10px" }}>等待额度数据…</div>
          )}

          {/* -------------------------------------------------- stop/resume log */}
          <button
            onClick={() => void openReport()}
            title="在浏览器中打开被停止 / 自动继续的会话行为记录（静态页面，可按日期筛选）"
            style={{
              "margin-top": "12px",
              width: "100%",
              padding: "6px 10px",
              "font-size": "12px",
              "border-radius": "6px",
              border: "1px solid rgba(127,127,127,.35)",
              background: "rgba(127,127,127,.12)",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            📜 行为记录
          </button>

          {/* ----------------------------------------------------- task queue */}
          <div style={{ "border-top": "1px solid rgba(127,127,127,.25)", "margin-top": "14px", padding: "10px 0 0" }}>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
              <strong style={{ "font-size": "12px" }}>任务队列</strong>
              <span style={{ display: "flex", "align-items": "center", gap: "5px", "font-size": "11px" }}>
                <input
                  type="checkbox"
                  checked={queue()?.autoExecute ?? false}
                  onChange={(e) => void toggleAuto(e.currentTarget.checked)}
                />
                自动执行
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={autoHours()}
                  onInput={(e) => setAutoHours(e.currentTarget.value)}
                  style={{ width: "38px", "font-size": "11px", padding: "0 3px" }}
                  title="自动执行时长（小时）"
                />
                小时
              </span>
            </div>

            {queue()?.autoExecute ? (
              <div style={{ "font-size": "11px", opacity: 0.7, "margin-top": "4px" }}>
                {queue()!.autoUntil
                  ? `将在 ${formatTime(queue()!.autoUntil)} 停止派发（还剩 ${formatDuration(queue()!.autoUntil! - now())}）`
                  : "自动执行已开启"}
                {queue()!.mode === "paused" ? " · 等待额度恢复" : ""}
              </div>
            ) : null}

            {/* ------------------------------------------------- idle window */}
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "5px",
                "font-size": "11px",
                "margin-top": "8px",
              }}
            >
              <input
                type="checkbox"
                checked={queue()?.idleEnabled ?? false}
                onChange={(e) => void setIdle({ enabled: e.currentTarget.checked })}
              />
              闲时自动执行
              <input
                type="time"
                value={idleStartValue()}
                onChange={(e) => void setIdle({ start: e.currentTarget.value })}
                style={{ width: "78px", "font-size": "11px", padding: "0 2px" }}
                title="闲时开始时间（本地时间）"
              />
              至
              <input
                type="time"
                value={idleEndValue()}
                onChange={(e) => void setIdle({ end: e.currentTarget.value })}
                style={{ width: "78px", "font-size": "11px", padding: "0 2px" }}
                title="闲时结束时间（本地时间，可早于开始时间以跨 0 点）"
              />
            </div>

            {queue()?.idleEnabled ? (
              <div style={{ "font-size": "11px", opacity: 0.7, "margin-top": "4px" }}>
                {queue()!.inIdleWindow
                  ? `当前在闲时区间内${queue()!.nextIdleChangeAt ? `，${formatTime(queue()!.nextIdleChangeAt)} 结束（还剩 ${formatDuration(queue()!.nextIdleChangeAt! - now())}）` : ""}`
                  : `当前不在闲时区间${queue()!.nextIdleChangeAt ? `，${formatTime(queue()!.nextIdleChangeAt)} 开始（还剩 ${formatDuration(queue()!.nextIdleChangeAt! - now())}）` : ""}`}
                {queue()!.mode === "paused" ? " · 等待额度恢复" : ""}
              </div>
            ) : null}

            <div style={{ "margin-top": "8px" }}>
              <textarea
                placeholder="添加到当前会话的待执行任务…"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                style={{
                  width: "100%",
                  "min-height": "48px",
                  "font-size": "12px",
                  padding: "4px",
                  "border-radius": "4px",
                  "border": "1px solid rgba(127,127,127,.4)",
                  background: "transparent",
                  color: "inherit",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", "gap": "6px", "margin-top": "4px", "align-items": "center" }}>
                <button style={{ "font-size": "11px", padding: "2px 10px", cursor: "pointer" }} onClick={() => void addTask()}>
                  添加
                </button>
                <button style={{ "font-size": "11px", padding: "2px 10px", cursor: "pointer" }} onClick={() => void runHead()}>
                  ▶ 立即执行队首
                </button>
                <span style={{ "font-size": "10px", opacity: 0.6, "margin-left": "auto" }}>
                  待执行 {queue()?.pending ?? 0} · 已执行 {queue()?.executed ?? 0}
                </span>
              </div>
            </div>

            {groups().length === 0 ? (
              <div style={{ "font-size": "11px", opacity: 0.6, "margin-top": "10px" }}>还没有任务。</div>
            ) : (
              groups().map((group) => (
                <div style={{ "margin-top": "10px" }}>
                  <div
                    style={{
                      display: "flex",
                      "justify-content": "space-between",
                      "font-size": "11px",
                      opacity: 0.75,
                      "font-weight": "600",
                    }}
                  >
                    <span title={group.project}>
                      {group.sessionID === currentSessionID() ? "▼ 当前会话" : "▼"} {group.label}
                    </span>
                    {group.sessionID !== currentSessionID() ? <span style={{ opacity: 0.7 }}>只读</span> : null}
                  </div>
                  {group.tasks.map((task) => (
                    <TaskRow task={task} mine={group.sessionID === currentSessionID()} />
                  ))}
                </div>
              ))
            )}

            {queue() && queue()!.executed > 0 ? (
              <button
                style={{ "font-size": "10px", padding: "2px 8px", cursor: "pointer", "margin-top": "8px" }}
                onClick={() => void clearExecuted()}
              >
                清除本会话已执行任务
              </button>
            ) : null}
          </div>
        </div>
      ),
    })

    ctx.add(ComposerPill, {
      id: "quota",
      order: 0,
      show: (input) => {
        const current = status()
        if (!current || current.mode === "disabled" || current.worstPercentRemaining === null) return undefined
        const remaining = current.worstPercentRemaining
        const tone: ComposerPillTone =
          current.mode === "paused" || remaining <= 10 ? "danger" : remaining <= 35 ? "warning" : "success"
        const paused = current.mode === "paused"
        const marker = current.pausedMarker || "⛔"
        const rows: ComposerPillRow[] = []
        if (paused) {
          rows.push({
            id: "paused",
            label: `${marker} 额度不足，已自动中止任务`,
            detail: `${current.stoppedSessions} 个会话`,
            tone: "danger",
          })
        }
        for (const window of current.windows) {
          const left = window.percentRemaining
          rows.push({
            id: window.window,
            label: `${WINDOW_LABELS[window.window] ?? window.window} 剩余 ${left === null ? "未知" : `${left}%`}`,
            detail: `${formatReset(window.resetsAt)} 重置`,
            tone: left === null ? "warning" : left <= 10 ? "danger" : left <= 35 ? "warning" : "success",
          })
        }
        rows.push({
          id: "open",
          label: "打开额度 · 任务队列面板",
          icon: "sidebar",
          run: () => openPanelFor(input.session),
        })
        return {
          label: paused ? `⚡ 剩余 ${remaining}% ${marker}` : `⚡ 剩余 ${remaining}%`,
          tone,
          title: paused
            ? `MiniMax 额度不足，插件已中止任务（${current.stoppedSessions} 个会话）——请勿手动输入新内容，窗口刷新后会自动继续。点击查看额度详情`
            : "MiniMax 额度（quota-watchdog）——点击查看额度详情",
          rows,
          run: () => openPanelFor(input.session),
        }
      },
    })
  },
})

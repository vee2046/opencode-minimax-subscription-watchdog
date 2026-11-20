/**
 * Task queue for the quota-watchdog plugin.
 *
 * Tasks are created from the desktop side panel (or the TUI commands) and stay
 * bound to the session that created them. Execution is strictly serial: one
 * task at a time, waiting for the target session to go idle before the next
 * task starts. A task is marked "executed" the moment it is handed to a
 * session, so it can never be dispatched twice.
 *
 * The module is pure logic: every side effect (storage, prompting, logging)
 * is injected by the host so it can be unit tested without OpenCode.
 */
import type { QueueSnapshot, QueueTask } from "./rpc"

export interface QueueDeps {
  /** Load the persisted queue state. */
  load(): Promise<
    | {
        tasks?: QueueTask[]
        autoExecute?: boolean
        autoUntil?: number
        idleEnabled?: boolean
        idleStart?: string
        idleEnd?: string
      }
    | undefined
  >
  /** Persist the queue state. */
  save(state: {
    tasks: QueueTask[]
    autoExecute: boolean
    autoUntil?: number
    idleEnabled: boolean
    idleStart: string
    idleEnd: string
  }): Promise<void>
  /** Resolve display metadata of a session (title, project directory). */
  resolveSession(sessionID: string): Promise<{ title?: string; directory?: string } | undefined>
  /** Deliver a prompt into a session. */
  prompt(sessionID: string, text: string): Promise<void>
  /** Interrupt a session that exceeded its time budget. */
  interrupt(sessionID: string): Promise<void>
  /**
   * Optional: read the live state of a session so the queue can tell that a
   * dispatched turn has finished even when the idle hook does not fire (for
   * example when the provider call failed).
   */
  getSessionInfo?(
    sessionID: string,
  ): Promise<{ idleAt?: number; busyAt?: number; outcome?: string } | undefined>
  /** Current watchdog mode. Only "ok" allows dispatching. */
  getMode(): "ok" | "paused" | "disabled"
  /** True while the watchdog is resuming quota-stopped sessions (they come first). */
  isResuming(): boolean
  /** Called whenever the queue changed and the UI should refresh. */
  onChange(): void
  log(message: string): void
}

export interface QueueOptions {
  /** A task may run at most this many minutes before it is abandoned. Default 30. */
  maxTaskMinutes?: number
  /** How often the queue looks for the next runnable task. Default 3000. */
  dispatchIntervalMs?: number
  /** Clock, injectable for tests. */
  now?: () => number
  /** Daily idle window: dispatch queued tasks automatically inside it. Default true. */
  idleEnabled?: boolean
  /** Idle window start, "HH:MM" local time. Default "22:00". */
  idleStart?: string
  /** Idle window end, "HH:MM" local time. Default "05:00" (crosses midnight). */
  idleEnd?: string
}

/**
 * Parse a "HH:MM" clock value into minutes since midnight.
 * Returns undefined for anything that is not a valid 24h time.
 */
export function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined
  return hours * 60 + minutes
}

let counter = 0
function nextID(): string {
  counter += 1
  return `tsk_${Date.now().toString(36)}_${counter.toString(36)}`
}

export function createQueue(deps: QueueDeps, options: QueueOptions = {}) {
  const maxTaskMs = (options.maxTaskMinutes ?? 30) * 60_000
  const dispatchIntervalMs = options.dispatchIntervalMs ?? 3_000
  const now = options.now ?? (() => Date.now())

  let tasks: QueueTask[] = []
  let autoExecute = false
  let autoUntil: number | undefined
  let running: { taskID: string; sessionID: string; startedAt: number } | undefined
  /** Task explicitly requested via "run now". */
  let nextTaskID: string | undefined
  /** Sessions with a model dispatch in flight (filled by the host hooks). */
  const busySessions = new Set<string>()
  /** Daily idle window in which queued tasks run without the manual switch. */
  let idleEnabled = options.idleEnabled ?? true
  let idleStart = parseClock(options.idleStart ?? "") !== undefined ? (options.idleStart ?? "22:00") : "22:00"
  let idleEnd = parseClock(options.idleEnd ?? "") !== undefined ? (options.idleEnd ?? "05:00") : "05:00"
  /** Last observed idle state, used to log window transitions. */
  let lastIdleActive: boolean | undefined

  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined

  async function persist(): Promise<void> {
    await deps.save({
      tasks,
      autoExecute,
      autoUntil,
      idleEnabled,
      idleStart,
      idleEnd,
    })
  }

  /**
   * Current idle window state and the next moment it opens or closes.
   * The window may cross midnight (e.g. 22:00 -> 05:00).
   */
  function idleBounds(ts: number): { active: boolean; next: number } {
    const start = parseClock(idleStart)
    const end = parseClock(idleEnd)
    if (start === undefined || end === undefined || start === end) return { active: false, next: ts }
    const date = new Date(ts)
    const current = date.getHours() * 60 + date.getMinutes()
    const at = (dayOffset: number, minutes: number): number => {
      const next = new Date(ts)
      next.setDate(next.getDate() + dayOffset)
      next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
      return next.getTime()
    }
    if (start < end) {
      if (current >= start && current < end) return { active: true, next: at(0, end) }
      return { active: false, next: current < start ? at(0, start) : at(1, start) }
    }
    // start > end: the window wraps around midnight.
    if (current >= start) return { active: true, next: at(1, end) }
    if (current < end) return { active: true, next: at(0, end) }
    return { active: false, next: at(0, start) }
  }

  function idleActive(): boolean {
    if (!idleEnabled) return false
    return idleBounds(now()).active
  }

  function snapshot(): QueueSnapshot {
    const bounds = idleBounds(now())
    return {
      tasks: tasks.map((task) => ({ ...task })),
      autoExecute,
      autoUntil: autoUntil ?? null,
      running: running ? { ...running } : null,
      pending: tasks.filter((task) => task.state === "pending").length,
      executed: tasks.filter((task) => task.state === "executed").length,
      mode: deps.getMode(),
      idleEnabled,
      idleStart,
      idleEnd,
      inIdleWindow: idleEnabled && bounds.active,
      nextIdleChangeAt: idleEnabled ? bounds.next : null,
    }
  }

  function announce(): void {
    deps.onChange()
  }

  // ---------------------------------------------------------------- mutations

  async function add(text: string, sessionID: string): Promise<QueueTask> {
    const trimmed = text.trim()
    if (!trimmed) throw new Error("task text is empty")
    const info = await deps.resolveSession(sessionID)
    const task: QueueTask = {
      id: nextID(),
      text: trimmed,
      sessionID,
      sessionTitle: info?.title ?? sessionID,
      projectDir: info?.directory ?? "",
      projectName: info?.directory ? info.directory.split("/").filter(Boolean).pop() ?? "" : "",
      state: "pending",
      createdAt: now(),
      dispatchedAt: null,
      error: null,
    }
    tasks.push(task)
    await persist()
    deps.log(`task added (${task.id}) for session ${sessionID}`)
    announce()
    return task
  }

  /** Edits are only allowed by the session that owns the task. */
  async function update(taskID: string, text: string, requesterSessionID: string): Promise<void> {
    const task = tasks.find((item) => item.id === taskID)
    if (!task) throw new Error(`unknown task ${taskID}`)
    if (task.sessionID !== requesterSessionID) throw new Error("task belongs to another session")
    const trimmed = text.trim()
    if (!trimmed) throw new Error("task text is empty")
    task.text = trimmed
    await persist()
    announce()
  }

  async function remove(taskID: string, requesterSessionID: string): Promise<void> {
    const index = tasks.findIndex((item) => item.id === taskID)
    if (index < 0) throw new Error(`unknown task ${taskID}`)
    if (tasks[index].sessionID !== requesterSessionID) throw new Error("task belongs to another session")
    tasks.splice(index, 1)
    if (nextTaskID === taskID) nextTaskID = undefined
    await persist()
    announce()
  }

  async function clearExecuted(requesterSessionID: string): Promise<void> {
    const before = tasks.length
    tasks = tasks.filter((task) => task.state !== "executed" || task.sessionID !== requesterSessionID)
    if (tasks.length !== before) {
      await persist()
      announce()
    }
  }

  async function setAuto(enabled: boolean, durationMs?: number): Promise<void> {
    autoExecute = enabled
    autoUntil = enabled ? now() + (durationMs && durationMs > 0 ? durationMs : 8 * 60 * 60_000) : undefined
    await persist()
    deps.log(enabled ? `auto execute on until ${new Date(autoUntil!).toLocaleString("zh-CN", { hour12: false })}` : "auto execute off")
    announce()
    if (enabled) void tick()
  }

  /**
   * Configure the daily idle window. Times are "HH:MM" local time and the
   * window may cross midnight (22:00 -> 05:00). Only the given fields change.
   */
  async function setIdle(update: { enabled?: boolean; start?: string; end?: string }): Promise<void> {
    if (update.start !== undefined) {
      if (parseClock(update.start) === undefined) throw new Error(`invalid idle start time "${update.start}"`)
      idleStart = update.start.trim()
    }
    if (update.end !== undefined) {
      if (parseClock(update.end) === undefined) throw new Error(`invalid idle end time "${update.end}"`)
      idleEnd = update.end.trim()
    }
    if (update.enabled !== undefined) idleEnabled = update.enabled
    if (parseClock(idleStart) === parseClock(idleEnd)) {
      deps.log("idle window start and end are identical: the window will never match")
    }
    await persist()
    deps.log(`idle window ${idleEnabled ? "enabled" : "disabled"} (${idleStart}-${idleEnd})`)
    announce()
    void tick()
  }

  /**
   * Requests an immediate dispatch of one task (or the head of the requester's
   * own pending tasks). Manual runs are always scoped to the calling session:
   * tasks of other sessions are read-only for it.
   */
  async function runNow(taskID: string | undefined, requesterSessionID: string): Promise<void> {
    const candidate = taskID
      ? tasks.find((task) => task.id === taskID)
      : tasks
          .filter((task) => task.state === "pending" && task.sessionID === requesterSessionID)
          .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!candidate) throw new Error("no task to run")
    if (candidate.sessionID !== requesterSessionID) throw new Error("task belongs to another session")
    if (candidate.state !== "pending") throw new Error("task already executed")
    nextTaskID = candidate.id
    deps.log(`run now requested for task ${candidate.id}`)
    await tick()
    // A poll that was already in flight may have made its decision before this
    // request arrived; make sure the task really goes out now.
    const after = tasks.find((item) => item.id === candidate.id)
    if (after && after.state === "pending") await tick()
  }

  // ----------------------------------------------------------------- dispatch

  function pickNext(): QueueTask | undefined {
    const pending = tasks.filter((task) => task.state === "pending").sort((a, b) => a.createdAt - b.createdAt)
    if (nextTaskID) {
      const forced = pending.find((task) => task.id === nextTaskID)
      if (forced) return forced
    }
    for (const task of pending) {
      if (!busySessions.has(task.sessionID)) return task
    }
    return undefined
  }

  async function dispatch(task: QueueTask): Promise<void> {
    // Mark as executed BEFORE handing it over: a task that reached a session
    // must never be dispatched again (e.g. after a quota stop/resume cycle).
    task.state = "executed"
    task.dispatchedAt = now()
    task.error = null
    running = { taskID: task.id, sessionID: task.sessionID, startedAt: now() }
    await persist()
    announce()
    deps.log(`dispatching task ${task.id} into session ${task.sessionID}`)
    try {
      await deps.prompt(task.sessionID, task.text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      task.error = message
      running = undefined
      await persist()
      announce()
      deps.log(`dispatch failed for task ${task.id}: ${message}`)
    }
  }

  /**
   * Detect that the turn we dispatched has finished.
   *
   * The idle hook is the fast path, but it does not fire for every turn (a
   * provider error that ends the session leaves no idle event), which would
   * block the whole queue. Polling the session state closes that hole.
   */
  async function checkFinished(active: { taskID: string; sessionID: string; startedAt: number }) {
    if (!deps.getSessionInfo) return undefined
    try {
      const info = await deps.getSessionInfo(active.sessionID)
      if (info && typeof info.idleAt === "number" && info.idleAt > active.startedAt) {
        return { outcome: info.outcome }
      }
    } catch {
      // a session that vanished simply keeps the task running until the timeout
    }
    return undefined
  }

  /**
   * Keep the busy set in sync with reality.
   *
   * The busy flag is set by the host hooks, but it is cleared by the idle hook
   * which does not fire for every turn. Asking the session itself keeps a
   * finished session from blocking the queue forever.
   */
  async function refreshBusySessions(): Promise<void> {
    if (!deps.getSessionInfo || busySessions.size === 0) return
    for (const sessionID of Array.from(busySessions)) {
      try {
        const info = await deps.getSessionInfo(sessionID)
        if (
          info &&
          typeof info.idleAt === "number" &&
          typeof info.busyAt === "number" &&
          info.idleAt > info.busyAt
        ) {
          busySessions.delete(sessionID)
        }
      } catch {
        // keep the flag, the timeout still applies
      }
    }
  }

  /**
   * One scheduling pass.
   *
   * Concurrent callers share the same pass instead of dropping it: whoever asks
   * while a pass is running waits for that pass to finish. Otherwise a manual
   * "run now" could be swallowed by a poll that was already in flight.
   */
  async function tick(): Promise<void> {
    // Wait for a pass that is already in flight, then run our own: a caller
    // that just changed the state (clock, deadline, new task) must never be
    // answered by a pass that started before that change.
    while (ticking) await ticking
    const run = doTick()
    ticking = run
    try {
      await run
    } finally {
      if (ticking === run) ticking = undefined
    }
  }

  async function doTick(): Promise<void> {
    await syncFromStorage()
    {
      // Log the idle window opening/closing so the user can see why tasks
      // started or stopped on their own.
      const idle = idleActive()
      if (lastIdleActive !== undefined && lastIdleActive !== idle) {
        deps.log(
          idle
            ? `idle window opened (${idleStart}-${idleEnd}); queued tasks are dispatched automatically`
            : `idle window closed (${idleStart}-${idleEnd}); stopped dispatching queued tasks`,
        )
        lastIdleActive = idle
        announce()
      }

      // Auto execute stops on its own when the deadline passed.
      if (autoExecute && autoUntil !== undefined && now() >= autoUntil) {
        autoExecute = false
        autoUntil = undefined
        await persist()
        deps.log("auto execute deadline reached; stopped dispatching")
        announce()
      }

      if (running) {
        const active = running
        const finished = await checkFinished(active)
        if (finished) {
          running = undefined
          const task = tasks.find((item) => item.id === active.taskID)
          if (task && finished.outcome === "failed") task.error = "模型回合结束但失败"
          deps.log(`task ${active.taskID} finished (outcome=${finished.outcome ?? "unknown"})`)
          await persist()
          announce()
          return
        }
        if (now() - running.startedAt > maxTaskMs) {
          const stuck = running
          deps.log(`task ${stuck.taskID} exceeded ${maxTaskMs / 60_000} minutes; interrupting session ${stuck.sessionID}`)
          const task = tasks.find((item) => item.id === stuck.taskID)
          if (task) task.error = "执行超时，已中断"
          running = undefined
          try {
            await deps.interrupt(stuck.sessionID)
          } catch {}
          await persist()
          announce()
          return
        }
        return
      }

      if (deps.getMode() !== "ok") return
      if (deps.isResuming()) return
      if (!autoExecute && !nextTaskID && !idle) return

      await refreshBusySessions()
      const next = pickNext()
      if (!next) {
        if (nextTaskID) {
          deps.log(`task ${nextTaskID} is not runnable yet (target session busy)`)
          nextTaskID = undefined
        }
        return
      }
      nextTaskID = undefined
      await dispatch(next)
    }
  }

  /** Called by the host when a session goes idle. */
  function onSessionIdle(sessionID: string): void {
    busySessions.delete(sessionID)
    if (running && running.sessionID === sessionID) {
      deps.log(`task ${running.taskID} finished`)
      running = undefined
      void persist().then(() => {
        announce()
        void tick()
      })
    }
  }

  /** Called by the host when a session starts a model call. */
  function onSessionBusy(sessionID: string): void {
    busySessions.add(sessionID)
  }

  /**
   * Another plugin instance may have handled a queue mutation through its own
   * copy (OpenCode can serve the RPC route from any instance), so the owner
   * re-reads the persisted queue whenever it is not mid-dispatch.
   */
  async function syncFromStorage(): Promise<void> {
    if (running) return
    let stored: Awaited<ReturnType<typeof deps.load>>
    try {
      stored = await deps.load()
    } catch {
      return
    }
    if (!stored) return
    const next = Array.isArray(stored.tasks) ? stored.tasks : []
    if (JSON.stringify(next) === JSON.stringify(tasks)) return
    tasks = next
    autoExecute = stored.autoExecute === true
    autoUntil = typeof stored.autoUntil === "number" ? stored.autoUntil : undefined
    if (typeof stored.idleEnabled === "boolean") idleEnabled = stored.idleEnabled
    if (typeof stored.idleStart === "string" && parseClock(stored.idleStart) !== undefined) idleStart = stored.idleStart
    if (typeof stored.idleEnd === "string" && parseClock(stored.idleEnd) !== undefined) idleEnd = stored.idleEnd
    announce()
  }

  async function init(): Promise<void> {
    const stored = await deps.load()
    tasks = Array.isArray(stored?.tasks) ? stored.tasks : []
    autoExecute = stored?.autoExecute === true
    autoUntil = typeof stored?.autoUntil === "number" ? stored.autoUntil : undefined
    idleEnabled = typeof stored?.idleEnabled === "boolean" ? stored.idleEnabled : (options.idleEnabled ?? true)
    if (typeof stored?.idleStart === "string" && parseClock(stored.idleStart) !== undefined) idleStart = stored.idleStart
    if (typeof stored?.idleEnd === "string" && parseClock(stored.idleEnd) !== undefined) idleEnd = stored.idleEnd
    lastIdleActive = idleActive()
    if (autoExecute && autoUntil !== undefined && now() >= autoUntil) {
      autoExecute = false
      autoUntil = undefined
    }
    await persist()
    timer = setInterval(() => void tick(), dispatchIntervalMs)
    announce()
  }

  function dispose(): void {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return {
    init,
    dispose,
    syncFromStorage,
    snapshot,
    add,
    update,
    remove,
    clearExecuted,
    setAuto,
    setIdle,
    runNow,
    onSessionIdle,
    onSessionBusy,
    tick,
  }
}

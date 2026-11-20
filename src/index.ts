/**
 * opencode-quota-watchdog
 *
 * Watches the MiniMax subscription quota in real time. When usage reaches a
 * threshold (default 95%), it interrupts running sessions and blocks every new
 * model call until the quota window resets, then re-prompts the stopped
 * sessions to continue (serially, one session at a time).
 *
 * On top of that it runs a task queue: tasks are added from the desktop side
 * panel (or the TUI commands) and stay bound to their session. Tasks are
 * dispatched strictly serially, only while the quota allows it, and only while
 * the auto-execute deadline has not passed. A task is marked "executed" the
 * moment it is handed to a session, so it can never run twice.
 *
 * Designed for OpenCode V2 server plugins.
 */
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  type EndpointId,
  type Evaluation,
  type WindowId,
  evaluateQuota,
  fetchMiniMaxQuota,
} from "./minimax"
import { WatchdogRpc, type WatchdogStatus, type QueueSnapshot, type QueueTask } from "./rpc"
import { createQueue } from "./queue"

export interface WatchdogOptions {
  /** Integration/credential ID in OpenCode that holds the MiniMax API key. Default "minimax-cn". */
  integrationID?: string
  /** "cn" | "international" | "auto" (from integrationID). Default "auto". */
  endpoint?: "cn" | "international" | "auto"
  /** Stop all tasks when used percent reaches this value. Default 95. */
  stopPercentUsed?: number
  /** Quota poll interval in ms. Default 60000. */
  pollMs?: number
  /** Extra wait after the reset time before resuming. Default 60000. */
  resumeBufferMs?: number
  /** Which windows to watch. Default ["5h", "weekly"]. */
  windows?: WindowId[]
  /** Sessions with a model dispatch within this window are interrupted on stop. Default 600000 (10 min). */
  interruptWindowMs?: number
  /** Re-prompt stopped sessions to continue after the reset. Default true. */
  autoResume?: boolean
  /** Text of the auto-resume prompt. */
  resumeText?: string
  /** Env var fallback for the API key. Default "MINIMAX_API_KEY". */
  apiKeyEnv?: string
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number
  /**
   * Wildcard patterns (case-insensitive, `*` supported) matched against `providerID`
   * and `providerID/modelID`. Only model calls matching at least one pattern are
   * recorded/blocked/interrupted; other models are untouched. Default:
   * [`"<integrationID>/*"`] — e.g. "minimax-cn/*", which excludes models such as
   * "opencode/minimax-m3.1-flash-free" (free pool, does not consume the subscription).
   */
  modelFilter?: string[]
  /** A queued task may run at most this many minutes before it is interrupted. Default 30. */
  maxTaskMinutes?: number
  /** How often the task queue looks for the next runnable task (ms). Default 3000. */
  dispatchIntervalMs?: number
  /** How long a resumed session may stay silent before the resume chain continues (ms). Default 180000. */
  resumeTimeoutMs?: number
  /**
   * Marker appended to the composer pill while the watchdog has paused the work,
   * so a low remaining quota is obvious at a glance. Default "⛔".
   */
  pausedMarker?: string
  /**
   * Dispatch queued tasks automatically during the daily idle window, without
   * turning the manual "auto execute" switch on. Default true.
   */
  idleAutoExecute?: boolean
  /** Idle window start, "HH:MM" local time. Default "22:00". */
  idleStart?: string
  /** Idle window end, "HH:MM" local time. Default "05:00" (crosses midnight). */
  idleEnd?: string
}

interface WatchdogState {
  mode: "ok" | "paused" | "disabled"
  pausedAt?: number
  /** Re-check quota no earlier than this (epoch ms). */
  recheckAt?: number
  stoppedSessions: { sessionID: string; stoppedAt: number }[]
  /** Sessions that still have to be resumed, in order. */
  resumeQueue?: string[]
  /** Session whose resume prompt is currently in flight. */
  resumeActive?: string
  /** When the current resume prompt was sent (epoch ms). */
  resumeActiveAt?: number
  lastCheckMs?: number
  lastError?: string
  lastWorstPercentRemaining?: number
  /** sessionID -> epoch ms of the last model dispatch, persisted so a plugin re-init keeps it. */
  lastDispatch?: [string, number][]
  /**
   * Which plugin instance owns the watchdog. OpenCode reloads plugins without
   * disposing the previous instance, so several copies can end up polling and
   * overwriting the same state; the newest instance claims the lease and the
   * older ones retire as soon as they notice.
   */
  owner?: string
  ownerBeatAt?: number
  /**
   * Lease format version. An owner written by an older plugin build has no
   * version, so a freshly loaded instance may take the lease over from it —
   * otherwise a stale build would keep the watchdog forever.
   */
  ownerVersion?: number
  /** Last quota snapshot, so any instance can answer the status RPC from storage. */
  lastWindows?: WatchdogStatus["windows"]
}

/** Sessions that were stopped by a pause and must be resumed. Append-only until a resume. */
interface StoppedEntry {
  sessionID: string
  stoppedAt: number
}

const STORAGE_KEY = "state"
const QUEUE_STORAGE_KEY = "queue"
/** Append-only ledger of sessions to resume; survives state clobbering across plugin reloads. */
const STOPPED_KEY = "stopped"
/** sessionID -> epoch ms of the last managed model dispatch, shared by all instances. */
const DISPATCH_KEY = "dispatch"
/** Set by any instance that saw a real quota error; the owner turns it into a pause. */
const PAUSE_REQUEST_KEY = "pauseRequest"
/** How long an instance stays the owner without refreshing its heartbeat. */
const LEASE_MS = 180_000
/** Bumped whenever the shared state layout changes incompatibly. */
const LEASE_VERSION = 2
/** Storage reads are cached briefly so the guard hook does not hit sqlite per call. */
const STATE_CACHE_MS = 1_500
const DEFAULT_RESUME_TEXT =
  "[quota-watchdog] MiniMax 额度窗口已刷新，额度已恢复。请从中断处继续完成刚才被暂停的任务。"

const LOG = "[quota-watchdog]"

/**
 * The server's own stdout is not captured anywhere the user can read, so the
 * plugin also appends its diagnostics to a file next to the OpenCode data dir.
 */
const DATA_DIR = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share", "opencode")
const LOG_FILE = join(DATA_DIR, "quota-watchdog.log")
/** Append-only history of stopped / resumed sessions, one JSON object per line. */
const EVENTS_FILE = join(DATA_DIR, "quota-watchdog-events.jsonl")
/** Static HTML view of EVENTS_FILE, opened from the side panel. */
const REPORT_FILE = join(DATA_DIR, "quota-watchdog-report.html")
let logDirReady = false

function log(message: string): void {
  const line = `${new Date().toISOString()} ${LOG} ${message}`
  console.log(line)
  try {
    if (!logDirReady) {
      mkdirSync(dirname(LOG_FILE), { recursive: true })
      logDirReady = true
    }
    appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    // Never let logging break the watchdog.
  }
}

/** One row of the stop/resume history shown in the generated report. */
interface WatchdogEvent {
  at: number
  kind: "paused" | "stopped" | "blocked" | "resumed" | "resume-sent" | "resume-failed"
  sessionID?: string
  title?: string
  detail?: string
}

const EVENT_LABELS: Record<WatchdogEvent["kind"], string> = {
  paused: "进入暂停",
  stopped: "中断会话",
  blocked: "拦截请求",
  resumed: "恢复监控",
  "resume-sent": "自动继续",
  "resume-failed": "继续失败",
}

const EVENT_COLORS: Record<WatchdogEvent["kind"], string> = {
  paused: "#ef4444",
  stopped: "#f97316",
  blocked: "#f59e0b",
  resumed: "#22c55e",
  "resume-sent": "#3b82f6",
  "resume-failed": "#a855f7",
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function readEvents(limit: number): WatchdogEvent[] {
  try {
    if (!existsSync(EVENTS_FILE)) return []
    const lines = readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean)
    const events: WatchdogEvent[] = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as WatchdogEvent
        if (parsed && typeof parsed.at === "number" && typeof parsed.kind === "string") events.push(parsed)
      } catch {
        // Skip a torn line; the history must never fail to render.
      }
    }
    return events
  } catch {
    return []
  }
}

function renderReport(events: WatchdogEvent[]): string {
  const rows = [...events].reverse()
  const count = (kind: WatchdogEvent["kind"]) => events.filter((event) => event.kind === kind).length
  const fmt = (epochMs: number) =>
    new Date(epochMs).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  /** Local YYYY-MM-DD, used by the date-range filter in the page. */
  const dayKey = (epochMs: number) => {
    const date = new Date(epochMs)
    const pad = (value: number) => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const body = rows.length
    ? rows
        .map((event) => {
          const color = EVENT_COLORS[event.kind] ?? "#9ca3af"
          const label = EVENT_LABELS[event.kind] ?? event.kind
          const who = event.title ? `${event.title}<span class="sid">${escapeHtml(event.sessionID ?? "")}</span>` : event.sessionID ? `<span class="sid">${escapeHtml(event.sessionID)}</span>` : "—"
          return `<tr data-date="${dayKey(event.at)}" data-kind="${event.kind}">
  <td class="time">${fmt(event.at)}</td>
  <td><span class="badge" style="background:${color}22;color:${color};border-color:${color}55">${label}</span></td>
  <td class="who">${who}</td>
  <td class="detail">${escapeHtml(event.detail ?? "")}</td>
</tr>`
        })
        .join("\n")
    : `<tr><td colspan="4" class="empty">还没有记录。额度达到阈值时，被中断和自动继续的会话会出现在这里。</td></tr>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>MiniMax 额度看门狗 · 行为记录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 28px 60px; background: #0b0f17; color: #e5e7eb;
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 650; }
  .sub { color: #8b93a7; font-size: 12px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  .card { background: #131926; border: 1px solid #1f2737; border-radius: 10px; padding: 10px 16px; min-width: 110px; }
  .card b { display: block; font-size: 22px; line-height: 1.2; }
  .card span { color: #8b93a7; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; background: #131926; border: 1px solid #1f2737; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #1f2737; vertical-align: top; }
  th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #8b93a7; background: #101623; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #161e2d; }
  .time { white-space: nowrap; color: #b6bdcb; font-variant-numeric: tabular-nums; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; border: 1px solid; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .who { font-weight: 550; }
  .sid { display: block; color: #6b7385; font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .detail { color: #b6bdcb; font-size: 12px; }
  .empty { text-align: center; color: #8b93a7; padding: 40px 14px; }
  .filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px;
             background: #131926; border: 1px solid #1f2737; border-radius: 10px; padding: 10px 14px; }
  .filters label { display: inline-flex; align-items: center; gap: 6px; color: #8b93a7; font-size: 12px; }
  .filters input[type=date] { background: #0b0f17; color: #e5e7eb; border: 1px solid #2a3446; border-radius: 7px;
                              padding: 5px 8px; font: inherit; font-size: 12px; color-scheme: dark; }
  .filters button { background: #182031; color: #c7cedb; border: 1px solid #2a3446; border-radius: 7px;
                    padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer; }
  .filters button:hover { background: #1f2937; border-color: #3b4759; }
  .filters .spacer { flex: 1; }
  .filters .shown { color: #8b93a7; font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <h1>MiniMax 额度看门狗 · 行为记录</h1>
  <div class="sub">由 quota-watchdog 自动生成 · ${fmt(Date.now())} · 每 15 秒自动刷新</div>
  <div class="filters">
    <label>从 <input type="date" id="from"></label>
    <label>到 <input type="date" id="to"></label>
    <button data-range="today">今天</button>
    <button data-range="7">近 7 天</button>
    <button data-range="30">近 30 天</button>
    <button data-range="all">全部</button>
    <span class="spacer"></span>
    <span class="shown" id="shown"></span>
  </div>
  <div class="cards">
    <div class="card"><b id="c-stopped">${count("stopped") + count("blocked")}</b><span>被停止的会话</span></div>
    <div class="card"><b id="c-sent">${count("resume-sent")}</b><span>自动继续</span></div>
    <div class="card"><b id="c-paused">${count("paused")}</b><span>进入暂停</span></div>
    <div class="card"><b id="c-resumed">${count("resumed")}</b><span>恢复监控</span></div>
    <div class="card"><b id="c-total">${events.length}</b><span>记录总数</span></div>
  </div>
  <table>
    <thead><tr><th>时间</th><th>事件</th><th>会话</th><th>说明</th></tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr[data-date]'));
  var from = document.getElementById('from');
  var to = document.getElementById('to');
  var shownEl = document.getElementById('shown');
  var cards = {
    stopped: document.getElementById('c-stopped'),
    sent: document.getElementById('c-sent'),
    paused: document.getElementById('c-paused'),
    resumed: document.getElementById('c-resumed'),
    total: document.getElementById('c-total')
  };
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function apply(save) {
    var f = from.value;
    var t = to.value;
    var stopped = 0, sent = 0, paused = 0, resumed = 0, shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var day = tr.getAttribute('data-date');
      var ok = (!f || day >= f) && (!t || day <= t);
      tr.style.display = ok ? '' : 'none';
      if (!ok) continue;
      shown++;
      var kind = tr.getAttribute('data-kind');
      if (kind === 'stopped' || kind === 'blocked') stopped++;
      else if (kind === 'resume-sent') sent++;
      else if (kind === 'paused') paused++;
      else if (kind === 'resumed') resumed++;
    }
    cards.stopped.textContent = stopped;
    cards.sent.textContent = sent;
    cards.paused.textContent = paused;
    cards.resumed.textContent = resumed;
    cards.total.textContent = shown;
    shownEl.textContent = '显示 ' + shown + ' / ' + rows.length + ' 条';
    if (save) {
      try {
        localStorage.setItem('wd-from', f);
        localStorage.setItem('wd-to', t);
      } catch (e) {}
    }
  }
  function quick(kind) {
    var now = new Date();
    if (kind === 'all') {
      from.value = '';
      to.value = '';
    } else if (kind === 'today') {
      from.value = iso(now);
      to.value = iso(now);
    } else {
      var days = parseInt(kind, 10);
      from.value = iso(new Date(now.getTime() - (days - 1) * 86400000));
      to.value = iso(now);
    }
    apply(true);
  }
  try {
    from.value = localStorage.getItem('wd-from') || '';
    to.value = localStorage.getItem('wd-to') || '';
  } catch (e) {}
  from.addEventListener('change', function () { apply(true); });
  to.addEventListener('change', function () { apply(true); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-range]'), function (btn) {
    btn.addEventListener('click', function () { quick(btn.getAttribute('data-range')); });
  });
  apply(false);
})();
</script>
</body>
</html>
`
}

/** Rebuilds the static report from the event log; returns its path and row count. */
function writeReport(): { path: string; count: number } {
  const events = readEvents(500)
  try {
    if (!logDirReady) {
      mkdirSync(dirname(REPORT_FILE), { recursive: true })
      logDirReady = true
    }
    writeFileSync(REPORT_FILE, renderReport(events))
  } catch {
    // The caller reports the path; a failed write shows up as a missing file.
  }
  return { path: REPORT_FILE, count: events.length }
}


function stringifyBody(body: unknown): string {
  if (body === undefined || body === null) return ""
  try {
    if (typeof body === "string") return body
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

interface QuotaErrorLike {
  status?: number
  message?: string
  response?: { body?: unknown }
}

/**
 * True when the error means "the subscription is exhausted" (HTTP 429 or an
 * explicit quota wording). HTTP 529 / business code 2064 is an upstream
 * overload, not a quota problem, and must not pause the watchdog.
 */
function isQuotaError(error?: QuotaErrorLike): boolean {
  if (!error) return false
  const status = error.status ?? 0
  const text = `${error.message ?? ""} ${stringifyBody(error.response?.body)}`.toLowerCase()
  const overloadWords = ["负载", "高峰", "overload", "529", "2064", "busy"]
  if (overloadWords.some((word) => text.includes(word))) return false
  if (status === 429) return true
  const quotaWords = ["额度", "余额", "配额", "quota", "insufficient", "rate limit", "too many requests", "limit exceeded", "billing"]
  return quotaWords.some((word) => text.includes(word.toLowerCase()))
}

function formatWhen(epochMs: number | undefined): string {
  if (!epochMs) return "未知"
  return new Date(epochMs).toLocaleString("zh-CN", { hour12: false })
}

/** Strips the command name from a command prompt, tolerating "/name", "name" and ":". */
function extractCommandText(text: string | undefined, name: string): string {
  if (!text) return ""
  return text
    .trim()
    .replace(new RegExp(`^/?${name}\\b[:\\s]*`, "i"), "")
    .replace(/^[:\-\s]+/, "")
    .trim()
}

export default Plugin.define({
  id: "quota-watchdog",
  async setup(ctx) {
    const options: Required<Omit<WatchdogOptions, "endpoint" | "resumeText" | "modelFilter">> &
      Pick<WatchdogOptions, "endpoint" | "resumeText" | "modelFilter"> = {
      integrationID: "minimax-cn",
      endpoint: "auto",
      stopPercentUsed: 95,
      pollMs: 60_000,
      resumeBufferMs: 60_000,
      windows: ["5h", "weekly"],
      interruptWindowMs: 600_000,
      autoResume: true,
      apiKeyEnv: "MINIMAX_API_KEY",
      timeoutMs: 10_000,
      maxTaskMinutes: 30,
      dispatchIntervalMs: 3_000,
      resumeTimeoutMs: 180_000,
      pausedMarker: "⛔",
      idleAutoExecute: true,
      idleStart: "22:00",
      idleEnd: "05:00",
      resumeText: undefined,
      ...((ctx.options ?? {}) as WatchdogOptions),
    }
    const modelFilter: string[] =
      Array.isArray(options.modelFilter) && options.modelFilter.length > 0
        ? options.modelFilter
        : [`${options.integrationID}/*`]

    /** Case-insensitive wildcard match against providerID and providerID/modelID. */
    function matchesModelFilter(model: { providerID?: string; id?: string } | undefined): boolean {
      // These hook kinds are documented to always carry a model ref; if one ever
      // arrives without one, fail closed (treat as managed) to protect the quota.
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") return true
      const candidates = [model.providerID, `${model.providerID}/${model.id}`, model.id]
      return modelFilter.some((pattern) => {
        const regex = new RegExp(
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"),
          "i",
        )
        return candidates.some((candidate) => regex.test(candidate))
      })
    }
    const endpoint: EndpointId =
      options.endpoint === "cn" || options.endpoint === "international"
        ? options.endpoint
        : options.integrationID.toLowerCase().includes("cn")
          ? "cn"
          : "international"

    const stored = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
    // A session that was being resumed when the plugin got re-initialised (the
    // server evicts location services from time to time) must not be lost.
    const restoredActive =
      stored && typeof stored === "object" && typeof stored.resumeActive === "string" ? stored.resumeActive : undefined
    const state: WatchdogState =
      stored && typeof stored === "object" && typeof stored.mode === "string"
        ? {
            ...stored,
            stoppedSessions: Array.isArray(stored.stoppedSessions) ? stored.stoppedSessions : [],
            resumeQueue: Array.isArray(stored.resumeQueue) ? stored.resumeQueue : [],
            resumeActive: undefined,
            resumeActiveAt: undefined,
          }
        : { mode: "ok", stoppedSessions: [], resumeQueue: [] }
    const restoredQueue = state.resumeQueue ?? []
    if (restoredActive && !restoredQueue.includes(restoredActive)) {
      state.resumeQueue = [restoredActive, ...restoredQueue]
    }

    // Recover the append-only "must resume" ledger. It is written the moment a
    // session is stopped, so a reload (or another instance overwriting the main
    // state) can never erase a session that still needs its continuation.
    try {
      const ledger = (await ctx.storage.get(STOPPED_KEY)) as StoppedEntry[] | undefined
      if (Array.isArray(ledger)) {
        for (const entry of ledger) {
          if (
            entry &&
            typeof entry.sessionID === "string" &&
            !state.stoppedSessions.some((item) => item.sessionID === entry.sessionID)
          ) {
            state.stoppedSessions.push({
              sessionID: entry.sessionID,
              stoppedAt: typeof entry.stoppedAt === "number" ? entry.stoppedAt : Date.now(),
            })
          }
        }
      }
    } catch (error) {
      log(`stopped ledger read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Sessions left over from a pause that was already lifted must still be continued.
    if (state.mode !== "paused" && state.stoppedSessions.length > 0) {
      const pending = new Set(state.resumeQueue ?? [])
      for (const entry of state.stoppedSessions) {
        if (!pending.has(entry.sessionID)) {
          state.resumeQueue = [...(state.resumeQueue ?? []), entry.sessionID]
          pending.add(entry.sessionID)
        }
      }
      state.stoppedSessions = []
    }

    /** Identity of this plugin instance; only the owner polls and writes state. */
    const instanceID = randomUUID()
    let retired = false

    /** sessionID -> epoch ms of the last model dispatch, used to find live tasks. */
    const lastDispatch = new Map<string, number>()
    if (stored && Array.isArray(stored.lastDispatch)) {
      for (const entry of stored.lastDispatch) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
          lastDispatch.set(entry[0], entry[1])
        }
      }
    }

    /** Failed resume attempts per session, so a broken session is retried a few times. */
    const resumeAttempts = new Map<string, number>()

    /** Most recent evaluation, kept in memory for the live status payload. */
    let lastEvaluation: Evaluation | undefined

    function windowsPayload(): WatchdogStatus["windows"] {
      return (lastEvaluation?.rows ?? []).map((row) => ({
        window: row.window,
        model: row.model,
        percentRemaining: row.percentRemaining ?? null,
        usedPercent: row.percentRemaining !== undefined ? Math.round(100 - row.percentRemaining) : null,
        resetsAt: row.resetsAt ?? null,
      }))
    }

    /**
     * The RPC route may be served by an instance that is not the owner (the
     * registration slot is first come first served), so the status is built from
     * the persisted state instead of this instance's memory.
     */
    function buildStatus(fresh?: WatchdogState): WatchdogStatus {
      const snapshot = fresh && typeof fresh.mode === "string" ? fresh : state
      return {
        mode: snapshot.mode,
        endpoint,
        integrationID: options.integrationID,
        stopPercentUsed: options.stopPercentUsed,
        windows: snapshot.lastWindows ?? windowsPayload(),
        worstPercentRemaining: snapshot.lastWorstPercentRemaining ?? null,
        nextResetAt: snapshot.recheckAt ?? null,
        stoppedSessions: Array.isArray(snapshot.stoppedSessions) ? snapshot.stoppedSessions.length : 0,
        lastCheckMs: snapshot.lastCheckMs ?? null,
        lastError: snapshot.lastError ?? null,
        pausedMarker: options.pausedMarker,
      }
    }

    async function persist(): Promise<void> {
      // The dispatch map is persisted as well: a plugin re-init wipes memory and
      // the pause logic needs to know which sessions were live.
      state.lastDispatch = [...lastDispatch.entries()]
      await ctx.storage.set(STORAGE_KEY, JSON.parse(JSON.stringify(state)))
      stateCache = undefined
    }

    // ── shared state helpers ────────────────────────────────────────────────
    // OpenCode may keep several plugin instances alive at once and only one of
    // them owns the hook/RPC registration slot, so anything a hook decides must
    // come from storage rather than from this instance's memory.
    let stateCache: { at: number; value: WatchdogState | undefined } | undefined

    async function readState(): Promise<WatchdogState | undefined> {
      const now = Date.now()
      if (stateCache && now - stateCache.at < STATE_CACHE_MS) return stateCache.value
      try {
        const value = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
        stateCache = { at: now, value }
        return value
      } catch {
        return stateCache?.value
      }
    }

    /** sessionID -> epoch ms of the last managed dispatch, shared by all instances. */
    const dispatchWrites = new Map<string, number>()

    async function recordDispatch(sessionID: string): Promise<void> {
      const now = Date.now()
      if (now - (dispatchWrites.get(sessionID) ?? 0) < 10_000) return
      dispatchWrites.set(sessionID, now)
      try {
        const current = ((await ctx.storage.get(DISPATCH_KEY)) as Record<string, number> | undefined) ?? {}
        current[sessionID] = now
        await ctx.storage.set(DISPATCH_KEY, current as never)
      } catch {
        // Recording is best-effort; the pause still works from the ledger.
      }
    }

    async function readDispatch(): Promise<[string, number][]> {
      try {
        const value = (await ctx.storage.get(DISPATCH_KEY)) as Record<string, number> | undefined
        if (!value || typeof value !== "object") return []
        return Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")
      } catch {
        return []
      }
    }

    /** Any instance can flag "the quota is really gone"; the owner performs the pause. */
    async function requestPause(): Promise<void> {
      try {
        await ctx.storage.set(PAUSE_REQUEST_KEY, Date.now() as never)
      } catch {}
    }

    async function takePauseRequest(): Promise<number | undefined> {
      try {
        const value = (await ctx.storage.get(PAUSE_REQUEST_KEY)) as number | undefined
        if (typeof value !== "number") return undefined
        await ctx.storage.remove(PAUSE_REQUEST_KEY)
        return value
      } catch {
        return undefined
      }
    }

    /**
     * Appends one line to the stop/resume history and refreshes the static
     * report, so the side-panel button always opens an up-to-date page.
     */
    async function recordEvent(kind: WatchdogEvent["kind"], sessionID?: string, detail?: string): Promise<void> {
      let title: string | undefined
      if (sessionID) {
        try {
          const info = (await ctx.session.get({ sessionID })) as { title?: string } | undefined
          title = typeof info?.title === "string" ? info.title : undefined
        } catch {
          // A deleted session has no title; the id alone is enough.
        }
      }
      const event: WatchdogEvent = { at: Date.now(), kind, sessionID, title, detail }
      try {
        if (!logDirReady) {
          mkdirSync(dirname(EVENTS_FILE), { recursive: true })
          logDirReady = true
        }
        appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`)
      } catch (error) {
        log(`event log write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      writeReport()
    }

    /**
     * Append-only record of a session that has to be resumed later. It is stored
     * under its own key the moment the session is stopped, because the main
     * state object can be lost when the server reloads plugins (or when an older
     * instance overwrites it).
     */
    async function recordStopped(sessionID: string, at = Date.now()): Promise<void> {
      if (!state.stoppedSessions.some((entry) => entry.sessionID === sessionID)) {
        state.stoppedSessions.push({ sessionID, stoppedAt: at })
      }
      try {
        const current = (await ctx.storage.get(STOPPED_KEY)) as StoppedEntry[] | undefined
        const ledger = Array.isArray(current) ? current : []
        if (!ledger.some((entry) => entry.sessionID === sessionID)) {
          ledger.push({ sessionID, stoppedAt: at })
          await ctx.storage.set(STOPPED_KEY, JSON.parse(JSON.stringify(ledger)))
        }
      } catch (error) {
        log(`stopped ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /** Reads and clears the append-only resume ledger. */
    async function takeStoppedLedger(): Promise<StoppedEntry[]> {
      try {
        const current = (await ctx.storage.get(STOPPED_KEY)) as StoppedEntry[] | undefined
        const ledger = Array.isArray(current)
          ? current.filter((entry) => entry && typeof entry.sessionID === "string")
          : []
        await ctx.storage.set(STOPPED_KEY, [])
        return ledger
      } catch (error) {
        log(`stopped ledger take failed: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }

    /**
     * Stops polling without giving up the hook/RPC registrations. OpenCode keeps
     * a single registration slot per plugin id, first come first served, and the
     * instance that got the slot keeps it: disposing here would leave the plugin
     * with no guard at all (and no RPC route), which is exactly what happened
     * after every reload.
     */
    function goDormant(reason: string): void {
      if (retired) return
      retired = true
      log(`instance ${instanceID} dormant: ${reason}`)
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      try {
        queue.dispose()
      } catch {}
    }

    /**
     * The lease is incumbent-first: whoever holds it keeps it until the heartbeat
     * goes stale, because the hook registration cannot be moved to another
     * instance. The holder is the only one whose hooks are actually invoked, so
     * it must also be the only one that polls and persists.
     */
    async function ensureOwner(): Promise<boolean> {
      if (retired) return false
      try {
        const storedState = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
        const owner = storedState?.owner
        const beat = storedState?.ownerBeatAt ?? 0
        const sameBuild = storedState?.ownerVersion === LEASE_VERSION
        if (owner && owner !== instanceID && sameBuild && Date.now() - beat < LEASE_MS) {
          goDormant(`superseded by instance ${owner}`)
          return false
        }
      } catch {
        // A failed read must never stop the watchdog.
      }
      state.owner = instanceID
      state.ownerBeatAt = Date.now()
      state.ownerVersion = LEASE_VERSION
      return true
    }

    // Live status for the desktop GUI / TUI. Registration is best-effort: an
    // environment without RPC support keeps the watchdog fully functional.
    let rpcRegistration: Awaited<ReturnType<typeof registerRpc>> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined
    /** Dormant instances use this to notice that the owner disappeared. */
    let wakeTimer: ReturnType<typeof setInterval> | undefined
    let hookRegistrations: { dispose(): Promise<void> }[] = []
    async function registerRpc() {
      return ctx.rpc.register(WatchdogRpc, {
        status: async () => buildStatus(await readState()),
        report: async () => writeReport(),
        queueList: async () => {
          // The route may be answered by a non-owner instance; read the queue
          // from storage so the panel never shows a stale copy.
          await queue.syncFromStorage()
          const fresh = await readState()
          return { ...queue.snapshot(), mode: fresh?.mode ?? state.mode }
        },
        queueAdd: async (input: unknown) => {
          const { text, sessionID } = input as { text: string; sessionID: string }
          await queue.add(text, sessionID)
          return queue.snapshot()
        },
        queueUpdate: async (input: unknown) => {
          const { taskID, text, sessionID } = input as { taskID: string; text: string; sessionID: string }
          await queue.update(taskID, text, sessionID)
          return queue.snapshot()
        },
        queueRemove: async (input: unknown) => {
          const { taskID, sessionID } = input as { taskID: string; sessionID: string }
          await queue.remove(taskID, sessionID)
          return queue.snapshot()
        },
        queueClearExecuted: async (input: unknown) => {
          const { sessionID } = input as { sessionID: string }
          await queue.clearExecuted(sessionID)
          return queue.snapshot()
        },
        queueRunNow: async (input: unknown) => {
          const { taskID, sessionID } = input as { taskID?: string; sessionID: string }
          await queue.runNow(taskID, sessionID)
          return queue.snapshot()
        },
        queueSetAuto: async (input: unknown) => {
          const { enabled, durationMs } = input as { enabled: boolean; durationMs?: number | null }
          await queue.setAuto(enabled, durationMs ?? undefined)
          return queue.snapshot()
        },
        queueSetIdle: async (input: unknown) => {
          const payload = (input ?? {}) as { enabled?: boolean; start?: string; end?: string }
          await queue.setIdle({
            enabled: payload.enabled,
            start: payload.start,
            end: payload.end,
          })
          return queue.snapshot()
        },
      })
    }
    function announce(): void {
      if (!rpcRegistration) return
      void rpcRegistration.events.emit("updated", buildStatus()).catch((error) => {
        log(`rpc event emit failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    function announceQueue(): void {
      if (!rpcRegistration) return
      void rpcRegistration.events.emit("queueUpdated", queue.snapshot()).catch((error) => {
        log(`rpc queue event emit failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // ------------------------------------------------------------- task queue

    const queue = createQueue(
      {
        load: async () =>
          (await ctx.storage.get(QUEUE_STORAGE_KEY)) as
            | {
                tasks?: QueueTask[]
                autoExecute?: boolean
                autoUntil?: number
                idleEnabled?: boolean
                idleStart?: string
                idleEnd?: string
              }
            | undefined,
        save: async (value) => {
          await ctx.storage.set(QUEUE_STORAGE_KEY, JSON.parse(JSON.stringify(value)))
        },
        resolveSession: async (sessionID) => {
          try {
            const info = await ctx.session.get({ sessionID })
            return { title: info?.title, directory: info?.location?.directory }
          } catch {
            return undefined
          }
        },
        prompt: async (sessionID, text) => {
          await ctx.session.prompt({ sessionID, text })
        },
        interrupt: async (sessionID) => {
          await ctx.session.interrupt({ sessionID, resume: false })
        },
        getSessionInfo: async (sessionID) => {
          try {
            const info = await ctx.session.get({ sessionID })
            return {
              idleAt: info?.time?.idle,
              busyAt: info?.time?.busy,
              outcome: info?.outcome,
            }
          } catch {
            return undefined
          }
        },
        getMode: () => state.mode,
        // While the watchdog is resuming quota-stopped sessions, queued tasks
        // wait: the resumed sessions come first.
        isResuming: () => (state.resumeQueue?.length ?? 0) > 0 || Boolean(state.resumeActive),
        onChange: () => announceQueue(),
        log: (message) => log(message),
      },
      {
        maxTaskMinutes: options.maxTaskMinutes,
        dispatchIntervalMs: options.dispatchIntervalMs,
        idleEnabled: options.idleAutoExecute,
        idleStart: options.idleStart,
        idleEnd: options.idleEnd,
      },
    )

    let cachedKey: { key: string; at: number } | undefined
    async function resolveApiKey(): Promise<string> {
      if (cachedKey && Date.now() - cachedKey.at < 10 * 60_000) return cachedKey.key
      let key: string | undefined
      try {
        const connection = await ctx.integration.connection.active(options.integrationID)
        if (connection) {
          const value: unknown = await ctx.integration.connection.resolve(connection)
          if (typeof value === "string") key = value
          else if (value && typeof value === "object" && typeof (value as { key?: unknown }).key === "string") {
            key = (value as { key: string }).key
          }
        }
      } catch (error) {
        log(`credential lookup via integration API failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!key) {
        const fromEnv = process.env[options.apiKeyEnv]
        if (typeof fromEnv === "string" && fromEnv.length > 0) key = fromEnv
      }
      if (!key) throw new Error(`no MiniMax credential: integration "${options.integrationID}" and ${options.apiKeyEnv} both unavailable`)
      cachedKey = { key, at: Date.now() }
      return key
    }

    function pauseReasonMessage(evaluation: Evaluation): string {
      const reset = state.recheckAt
      return `MiniMax 额度已用 ${evaluation.usedPercent}%（阈值 ${options.stopPercentUsed}%），已自动停止所有任务。预计 ${formatWhen(reset)} 窗口刷新后自动恢复；如需立即恢复请执行 /watchdog-off`
    }

    async function pause(evaluation: Evaluation): Promise<void> {
      const now = Date.now()
      state.mode = "paused"
      state.pausedAt = now
      state.recheckAt = evaluation.nextResetAt ?? now + Math.max(options.pollMs, 15_000)
      const stopped = new Set(state.stoppedSessions.map((s) => s.sessionID))
      // Live sessions come from the shared dispatch key, not from this
      // instance's memory: the hooks that record dispatches may be served by a
      // different plugin instance.
      const dispatched = await readDispatch()
      const live = dispatched
        .filter(([sessionID, at]) => now - at <= options.interruptWindowMs && !stopped.has(sessionID))
        .map(([sessionID]) => sessionID)
      for (const sessionID of live) {
        try {
          await ctx.session.interrupt({ sessionID, resume: false })
          await recordStopped(sessionID, now)
          void recordEvent("stopped", sessionID, "额度达到阈值，已中断该会话")
          log(`interrupted session ${sessionID}`)
        } catch (error) {
          log(`interrupt ${sessionID} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      void recordEvent(
        "paused",
        undefined,
        `已用 ${evaluation.usedPercent}%，预计 ${formatWhen(state.recheckAt)} 窗口刷新后自动恢复`,
      )
      await persist()
      announce()
      log(`PAUSED: ${pauseReasonMessage(evaluation)} [live sessions interrupted: ${live.length}]`)
    }

    /**
     * Sends the resume prompt to the next session of the resume chain. Only one
     * session is resumed at a time; the chain advances when that session goes
     * idle (or when it stays silent for too long).
     */
    async function advanceResumeChain(): Promise<void> {
      if (!options.autoResume) {
        if ((state.resumeQueue?.length ?? 0) > 0 || state.resumeActive) {
          state.resumeQueue = []
          state.resumeActive = undefined
          state.resumeActiveAt = undefined
          await persist()
        }
        return
      }
      if (state.mode !== "ok") return
      if (state.resumeActive) return
      const next = state.resumeQueue?.[0]
      if (!next) return
      state.resumeActive = next
      state.resumeActiveAt = Date.now()
      state.resumeQueue = (state.resumeQueue ?? []).filter((sessionID) => sessionID !== next)
      await persist()
      const text = options.resumeText ?? DEFAULT_RESUME_TEXT
      try {
        await ctx.session.prompt({ sessionID: next, text })
        resumeAttempts.delete(next)
        log(`re-prompted session ${next} (${(state.resumeQueue ?? []).length} left in resume chain)`)
        void recordEvent("resume-sent", next, "已自动发送「继续」，恢复该会话的任务")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`re-prompt ${next} failed: ${message}`)
        void recordEvent("resume-failed", next, `「继续」发送失败：${message}`)
        // Never lose the session: put it back at the end of the queue and try
        // again later (a few attempts max).
        const attempts = (resumeAttempts.get(next) ?? 0) + 1
        resumeAttempts.set(next, attempts)
        state.resumeActive = undefined
        state.resumeActiveAt = undefined
        if (attempts < 3) {
          state.resumeQueue = [...(state.resumeQueue ?? []), next]
          log(`re-queued session ${next} for a later retry (attempt ${attempts})`)
        } else {
          resumeAttempts.delete(next)
          log(`giving up on session ${next} after ${attempts} attempts`)
        }
        await persist()
      }
    }

    async function resume(): Promise<void> {
      // Union both sources: the in-memory list and the append-only ledger. A
      // plugin reload can lose the former, a stale instance can overwrite the
      // latter's parent state — together they survive both.
      const ledger = await takeStoppedLedger()
      const pending = new Set(state.resumeQueue ?? [])
      const ids = [...(state.resumeQueue ?? [])]
      for (const entry of [...state.stoppedSessions, ...ledger]) {
        if (!pending.has(entry.sessionID)) {
          pending.add(entry.sessionID)
          ids.push(entry.sessionID)
        }
      }
      state.mode = "ok"
      state.pausedAt = undefined
      state.recheckAt = undefined
      state.stoppedSessions = []
      state.resumeQueue = ids
      state.resumeActive = undefined
      state.resumeActiveAt = undefined
      await persist()
      announce()
      log(`RESUMED: quota recovered (${state.lastWorstPercentRemaining ?? "?"}% remaining); ${ids.length} session(s) to continue`)
      void recordEvent(
        "resumed",
        undefined,
        `额度已恢复（剩余 ${state.lastWorstPercentRemaining ?? "?"}%），待继续 ${ids.length} 个会话`,
      )
      // Resumed sessions come first; queued tasks wait for the chain to finish.
      await advanceResumeChain()
    }

    async function tick(): Promise<void> {
      if (retired) return
      if (!(await ensureOwner())) return
      // A quota error reported to another instance's retry hook is turned into a
      // real pause here, where the timers and the resume chain live.
      const requested = await takePauseRequest()
      if (requested !== undefined && state.mode === "ok") {
        await pause({
          status: "exhausted",
          usedPercent: state.lastWorstPercentRemaining !== undefined ? 100 - state.lastWorstPercentRemaining : options.stopPercentUsed,
          worstPercentRemaining: state.lastWorstPercentRemaining,
          rows: [],
          nextResetAt: state.recheckAt,
        })
        return
      }
      if (state.mode === "disabled") return
      const now = Date.now()
      for (const [sessionID, at] of lastDispatch) {
        if (now - at > 60 * 60_000) lastDispatch.delete(sessionID)
      }
      // Persist the dispatch map so a plugin re-init does not lose it.
      await persist()
      let evaluation: Evaluation
      try {
        const apiKey = await resolveApiKey()
        const snapshot = await fetchMiniMaxQuota({ apiKey, endpoint, timeoutMs: options.timeoutMs })
        evaluation = evaluateQuota(snapshot, {
          windows: options.windows,
          stopPercentUsed: options.stopPercentUsed,
          nowMs: Date.now(),
        })
        state.lastCheckMs = Date.now()
        state.lastError = undefined
        state.lastWorstPercentRemaining = evaluation.worstPercentRemaining
        lastEvaluation = evaluation
        // Persist the window snapshot so any instance can answer the status RPC
        // with the same numbers (a stale in-memory copy is what made the panel
        // flicker between 0% and 10%).
        state.lastWindows = windowsPayload()
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
        log(`poll failed: ${state.lastError}`)
        announce()
        return
      }
      if (evaluation.status === "unknown") {
        log("no comparable quota data (no rows with a percentage); skipping")
        announce()
        return
      }
      if (state.mode !== "paused" && evaluation.status === "exhausted") {
        await pause(evaluation)
        return
      }
      announce()
      if (state.mode === "paused") {
        const recheck = state.recheckAt ?? 0
        if (now < recheck) return
        if (evaluation.status === "exhausted") {
          // Still below threshold: wait for the next window reset (e.g. weekly).
          state.recheckAt = evaluation.nextResetAt ?? now + Math.max(options.pollMs, 15_000)
          await persist()
          announce()
          log(`still exhausted after reset; next re-check ${formatWhen(state.recheckAt)}`)
          return
        }
        await resume()
      }
      // A resumed session that never goes idle must not block the queue forever.
      if (state.resumeActive && state.resumeActiveAt && Date.now() - state.resumeActiveAt > options.resumeTimeoutMs) {
        log(`resume of session ${state.resumeActive} timed out; continuing with the next one`)
        state.resumeActive = undefined
        state.resumeActiveAt = undefined
        await persist()
        await advanceResumeChain()
      }
      // A session whose re-prompt failed earlier is retried here: the quota is
      // already back to normal, so resume() will not run again on its own.
      if (state.mode === "ok" && (state.resumeQueue?.length ?? 0) > 0 && !state.resumeActive) {
        await advanceResumeChain()
      }
    }

    // Incumbent-first election. OpenCode cannot move a hook/RPC registration
    // between instances, so the instance that owns the registration slot must
    // stay the owner: a newer instance only takes over when the heartbeat has
    // gone stale (i.e. the previous process is really gone).
    let isOwner = false
    try {
      const current = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
      const beat = current?.ownerBeatAt ?? 0
      const taken =
        Boolean(current?.owner) &&
        current?.ownerVersion === LEASE_VERSION &&
        Date.now() - beat < LEASE_MS
      if (!taken) {
        state.owner = instanceID
        state.ownerBeatAt = Date.now()
        state.ownerVersion = LEASE_VERSION
        await persist()
        // Give a concurrent starter the chance to overwrite us: the last writer
        // wins, so only one instance comes out of the race as the owner.
        await new Promise((resolve) => setTimeout(resolve, 150))
        const reread = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
        isOwner = reread?.owner === instanceID
      }
    } catch (error) {
      log(`lease election failed: ${error instanceof Error ? error.message : String(error)}`)
      isOwner = true
    }

    if (isOwner) {
      pollTimer = setInterval(() => void tick().catch((error) => log(`tick error: ${error instanceof Error ? error.message : String(error)}`)), options.pollMs)
      void tick().catch((error) => log(`first tick error: ${error instanceof Error ? error.message : String(error)}`))
    } else {
      // Dormant: still register the hooks (they are storage-driven, so they are
      // correct either way) but do not poll, persist or dispatch. If the owner
      // disappears (server restart), take the lease over.
      retired = true
      log(`instance ${instanceID} dormant: another instance holds the lease`)
      wakeTimer = setInterval(() => {
        void (async () => {
          try {
            const current = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
            const beat = current?.ownerBeatAt ?? 0
            if (current?.owner && current?.ownerVersion === LEASE_VERSION && Date.now() - beat < LEASE_MS) return
            if (wakeTimer) clearInterval(wakeTimer)
            wakeTimer = undefined
            log(`instance ${instanceID} taking over the lease (previous owner is gone)`)
            if (current && typeof current.mode === "string") {
              state.mode = current.mode
              state.pausedAt = current.pausedAt
              state.recheckAt = current.recheckAt
              state.stoppedSessions = Array.isArray(current.stoppedSessions) ? current.stoppedSessions : []
              state.resumeQueue = Array.isArray(current.resumeQueue) ? current.resumeQueue : []
              state.lastWorstPercentRemaining = current.lastWorstPercentRemaining
              state.lastCheckMs = current.lastCheckMs
              state.lastError = current.lastError
            }
            state.owner = instanceID
            state.ownerBeatAt = Date.now()
            state.ownerVersion = LEASE_VERSION
            retired = false
            await persist()
            await queue.init()
            pollTimer = setInterval(
              () => void tick().catch((error) => log(`tick error: ${error instanceof Error ? error.message : String(error)}`)),
              options.pollMs,
            )
            void tick().catch((error) => log(`tick error: ${error instanceof Error ? error.message : String(error)}`))
          } catch (error) {
            log(`lease takeover failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      }, 20_000)
    }

    try {
      rpcRegistration = await registerRpc()
      log("rpc registered (live status + task queue available)")
    } catch (error) {
      log(`rpc registration unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (isOwner) {
      await queue.init()
    } else {
      // Never persist here: a dormant copy would overwrite the owner's queue.
      await queue.syncFromStorage()
    }

    // Block managed (MiniMax) model dispatches while paused. Recorded dispatches
    // also feed the live-session detection used by pause(); non-matching models
    // (e.g. other providers or the OpenCode free MiniMax pool) are never touched.
    const kinds = ["context", "compaction", "generate", "title"] as const
    hookRegistrations = []
    for (const kind of kinds) {
      hookRegistrations.push(
        await ctx.session.hook(kind, async (event: { sessionID: string; model?: { providerID: string; id: string } }) => {
          if (matchesModelFilter(event.model)) {
            // Shared key: the instance that records may not be the one that pauses.
            void recordDispatch(event.sessionID)
            // Read from storage — the pause may have been decided by another
            // plugin instance, and this instance's memory may be stale.
            const fresh = await readState()
            if (fresh?.mode === "paused") {
              // This session just got stopped mid-task, so it has to be
              // continued once the quota window refreshes. The ledger is
              // append-only, so any instance can write it safely.
              await recordStopped(event.sessionID)
              void recordEvent("blocked", event.sessionID, "额度暂停中，拦截了新的模型请求")
              const worst = fresh.lastWorstPercentRemaining
              throw new Error(
                `[quota-watchdog] ${pauseReasonMessage({
                  status: "exhausted",
                  usedPercent: worst !== undefined ? 100 - worst : options.stopPercentUsed,
                  worstPercentRemaining: worst,
                  rows: [],
                  nextResetAt: fresh.recheckAt,
                })}`,
              )
            }
          }
          // Busy tracking is model agnostic: a session that is producing model
          // output must not receive a queued task. Only the owner dispatches.
          if (!retired) queue.onSessionBusy(event.sessionID)
        }),
      )
    }
    hookRegistrations.push(
      await ctx.session.hook(
        "retry",
        async (event: {
          sessionID: string
          model?: { providerID: string; id: string }
          error?: QuotaErrorLike
          attempt?: number
          decision: { retry: boolean; delay?: number }
        }) => {
          // The pause may have been decided by another instance; storage wins.
          const fresh = await readState()
          if (fresh?.mode === "paused" && matchesModelFilter(event.model)) {
            event.decision = { retry: false }
            return
          }
          // A real quota error (HTTP 429 / quota wording) is ground truth: pause
          // right away and remember the session so it gets resumed later.
          // The model must match explicitly here: a 429 from another provider
          // (e.g. the OpenCode free pool) must not stop MiniMax work.
          if (!event.model || !matchesModelFilter(event.model)) return
          if (!isQuotaError(event.error)) return
          event.decision = { retry: false }
          const sessionID = event.sessionID
          log(`quota error in session ${sessionID}: ${event.error?.message ?? "unknown error"}`)
          // The ledger is what guarantees the session is resumed, and it is
          // written by whichever instance happens to serve the hook.
          await recordStopped(sessionID)
          if (!retired) {
            state.mode = "paused"
            state.pausedAt = state.pausedAt ?? Date.now()
            state.recheckAt = Date.now() + Math.max(options.pollMs, 15_000)
            await persist()
            announce()
          } else {
            await requestPause()
          }
        },
      ),
    )
    hookRegistrations.push(
      await ctx.session.hook("experimental.idle", (event: { sessionID: string }) => {
        if (retired) return
        queue.onSessionIdle(event.sessionID)
        if (state.resumeActive === event.sessionID) {
          state.resumeActive = undefined
          state.resumeActiveAt = undefined
          void persist().then(() => void advanceResumeChain())
        }
      }),
    )

    function statusText(): string {
      const lines = [
        `**quota-watchdog 状态**`,
        `- 模式: ${state.mode === "ok" ? "监控中" : state.mode === "paused" ? "已暂停任务（额度到达阈值）" : "已停用 (/watchdog-on 开启)"}`,
        `- 监控: ${endpoint === "cn" ? "MiniMax 国内版" : "MiniMax 国际版"}，integration "${options.integrationID}"`,
        `- 阈值: 已用 >= ${options.stopPercentUsed}% 时停止任务（windows: ${options.windows.join(", ")}）`,
        `- 轮询: 每 ${Math.round(options.pollMs / 1000)} 秒`,
      ]
      if (state.lastWorstPercentRemaining !== undefined) {
        lines.push(`- 最近额度: 剩余 ${state.lastWorstPercentRemaining}%（${formatWhen(state.lastCheckMs)} 查询）`)
      }
      if (state.mode === "paused") {
        lines.push(`- 预计恢复: ${formatWhen(state.recheckAt)}`)
        lines.push(`- 已停止会话: ${state.stoppedSessions.length} 个`)
      }
      if (state.lastError) lines.push(`- 最近错误: ${state.lastError}`)
      return lines.join("\n")
    }

    function queueText(): string {
      const snapshot = queue.snapshot()
      const lines = [
        `**任务队列**`,
        `- 自动执行: ${snapshot.autoExecute ? "开启" : "关闭"}${snapshot.autoUntil ? `（${formatWhen(snapshot.autoUntil)} 停止派发）` : ""}`,
        `- 闲时自动执行: ${snapshot.idleEnabled ? "开启" : "关闭"}（${snapshot.idleStart} - ${snapshot.idleEnd}${snapshot.idleStart > snapshot.idleEnd ? " 跨 0 点" : ""}，${snapshot.inIdleWindow ? "当前在闲时区间内" : "当前不在闲时区间"}）`,
        `- 待执行: ${snapshot.pending} · 已执行: ${snapshot.executed}${snapshot.running ? ` · 运行中: ${snapshot.running.taskID}` : ""}`,
      ]
      if (snapshot.tasks.length === 0) lines.push(`- （暂无任务）`)
      for (const task of snapshot.tasks) {
        const flag = task.state === "pending" ? "待执行" : "已执行"
        lines.push(`- [${flag}] ${task.sessionTitle || task.sessionID} · ${task.text.replace(/\s+/g, " ").slice(0, 60)}`)
      }
      return lines.join("\n")
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "watchdog-status",
        description: "quota-watchdog: show MiniMax quota watchdog state",
        execute: async ({ sessionID }) => {
          const text = statusText()
          log(`status requested\n${text}`)
          try {
            await ctx.session.synthetic({ sessionID, text })
          } catch (error) {
            log(`synthetic status failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })
      editor.add({
        name: "watchdog-off",
        description: "quota-watchdog: stop monitoring and unblock tasks",
        execute: async ({ sessionID }) => {
          state.mode = "disabled"
          state.pausedAt = undefined
          state.recheckAt = undefined
          state.stoppedSessions = []
          state.resumeQueue = []
          state.resumeActive = undefined
          state.resumeActiveAt = undefined
          await persist()
          announce()
          log("disabled by /watchdog-off")
          try {
            await ctx.session.synthetic({ sessionID, text: "quota-watchdog 已停用，任务恢复放行。" })
          } catch {}
        },
      })
      editor.add({
        name: "watchdog-on",
        description: "quota-watchdog: resume monitoring MiniMax quota",
        execute: async ({ sessionID }) => {
          state.mode = "ok"
          await persist()
          announce()
          log("enabled by /watchdog-on")
          void tick()
          try {
            await ctx.session.synthetic({ sessionID, text: "quota-watchdog 已开启，继续监控 MiniMax 额度。" })
          } catch {}
        },
      })
      editor.add({
        name: "tasks",
        description: "quota-watchdog: list the task queue",
        execute: async ({ sessionID }) => {
          const text = queueText()
          log(`queue status requested\n${text}`)
          try {
            await ctx.session.synthetic({ sessionID, text })
          } catch (error) {
            log(`synthetic queue status failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })
      editor.add({
        name: "task-add",
        description: "quota-watchdog: add a task to the queue (text after the command)",
        execute: async (input: { sessionID: string; prompt?: { text?: string } }) => {
          const text = extractCommandText(input.prompt?.text, "task-add")
          if (!text) {
            try {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: "用法：/task-add <任务提示词>（会在额度允许时自动执行到当前会话）",
              })
            } catch {}
            return
          }
          try {
            await queue.add(text, input.sessionID)
            try {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `已加入任务队列（${queue.snapshot().pending} 个待执行）：${text.slice(0, 60)}`,
              })
            } catch {}
          } catch (error) {
            log(`task-add failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })
    })

    return () => {
      retired = true
      if (pollTimer) clearInterval(pollTimer)
      if (wakeTimer) clearInterval(wakeTimer)
      queue.dispose()
      for (const registration of hookRegistrations) void registration.dispose()
      if (rpcRegistration) void rpcRegistration.dispose()
      // Hand the lease back: a deliberate teardown (hot reload) must not leave
      // the next instance dormant until the heartbeat expires.
      if (isOwner) {
        void (async () => {
          try {
            const current = (await ctx.storage.get(STORAGE_KEY)) as WatchdogState | undefined
            if (current?.owner === instanceID) {
              current.owner = undefined
              current.ownerBeatAt = undefined
              await ctx.storage.set(STORAGE_KEY, JSON.parse(JSON.stringify(current)))
            }
          } catch {
            // The heartbeat expires on its own anyway.
          }
        })()
      }
    }
  },
})

/**
 * RPC contract of the quota-watchdog plugin.
 *
 * The server part (src/index.ts) registers the quota status and the task
 * queue methods, and emits `updated` / `queueUpdated` on every state change.
 * The desktop GUI part (src/gui.tsx) and the TUI call these to render the
 * live quota display and the task queue.
 */
import { Rpc } from "@opencode/plugin/rpc"

/** Status payload shared by the `status` method and the `updated` event. */
const statusSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["ok", "paused", "disabled"] },
    endpoint: { type: "string", enum: ["cn", "international"] },
    integrationID: { type: "string" },
    stopPercentUsed: { type: "number" },
    windows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          window: { type: "string" },
          model: { type: "string" },
          percentRemaining: { type: ["number", "null"] },
          usedPercent: { type: ["number", "null"] },
          resetsAt: { type: ["number", "null"] },
        },
        required: ["window", "model", "percentRemaining", "usedPercent", "resetsAt"],
        additionalProperties: false,
      },
    },
    worstPercentRemaining: { type: ["number", "null"] },
    nextResetAt: { type: ["number", "null"] },
    stoppedSessions: { type: "number" },
    lastCheckMs: { type: ["number", "null"] },
    lastError: { type: ["string", "null"] },
    pausedMarker: { type: "string" },
  },
  required: [
    "mode",
    "endpoint",
    "integrationID",
    "stopPercentUsed",
    "windows",
    "worstPercentRemaining",
    "nextResetAt",
    "stoppedSessions",
    "lastCheckMs",
    "lastError",
    "pausedMarker",
  ],
  additionalProperties: false,
} as const

/** One queued task. */
const taskSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    sessionID: { type: "string" },
    sessionTitle: { type: "string" },
    projectName: { type: "string" },
    projectDir: { type: "string" },
    state: { type: "string", enum: ["pending", "executed"] },
    createdAt: { type: "number" },
    dispatchedAt: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
  },
  required: [
    "id",
    "text",
    "sessionID",
    "sessionTitle",
    "projectName",
    "projectDir",
    "state",
    "createdAt",
    "dispatchedAt",
    "error",
  ],
  additionalProperties: false,
} as const

/** Queue payload shared by the `queue*` methods and the `queueUpdated` event. */
const queueSchema = {
  type: "object",
  properties: {
    tasks: { type: "array", items: taskSchema },
    autoExecute: { type: "boolean" },
    autoUntil: { type: ["number", "null"] },
    running: {
      type: ["object", "null"],
      properties: {
        taskID: { type: "string" },
        sessionID: { type: "string" },
        startedAt: { type: "number" },
      },
      required: ["taskID", "sessionID", "startedAt"],
      additionalProperties: false,
    },
    pending: { type: "number" },
    executed: { type: "number" },
    mode: { type: "string", enum: ["ok", "paused", "disabled"] },
    idleEnabled: { type: "boolean" },
    idleStart: { type: "string" },
    idleEnd: { type: "string" },
    inIdleWindow: { type: "boolean" },
    nextIdleChangeAt: { type: ["number", "null"] },
  },
  required: [
    "tasks",
    "autoExecute",
    "autoUntil",
    "running",
    "pending",
    "executed",
    "mode",
    "idleEnabled",
    "idleStart",
    "idleEnd",
    "inIdleWindow",
    "nextIdleChangeAt",
  ],
  additionalProperties: false,
} as const

const emptyInput = { type: "object", additionalProperties: false } as const

/** Where the generated stop/resume report ended up. */
const reportSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "number" },
  },
  required: ["path", "count"],
  additionalProperties: false,
} as const

export const WatchdogRpc = Rpc.define({
  id: "quota-watchdog",
  methods: {
    status: { input: emptyInput, output: statusSchema },
    queueList: { input: emptyInput, output: queueSchema },
    /**
     * Rebuilds the static HTML report of the stop/resume history and returns
     * its absolute path, so the desktop part can open it in the browser.
     */
    report: { input: emptyInput, output: reportSchema },
    queueAdd: {
      input: {
        type: "object",
        properties: { text: { type: "string" }, sessionID: { type: "string" } },
        required: ["text", "sessionID"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueUpdate: {
      input: {
        type: "object",
        properties: { taskID: { type: "string" }, text: { type: "string" }, sessionID: { type: "string" } },
        required: ["taskID", "text", "sessionID"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueRemove: {
      input: {
        type: "object",
        properties: { taskID: { type: "string" }, sessionID: { type: "string" } },
        required: ["taskID", "sessionID"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueClearExecuted: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueRunNow: {
      input: {
        type: "object",
        properties: { taskID: { type: "string" }, sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueSetAuto: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" }, durationMs: { type: ["number", "null"] } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: queueSchema,
    },
    queueSetIdle: {
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          start: { type: "string" },
          end: { type: "string" },
        },
        additionalProperties: false,
      },
      output: queueSchema,
    },
  },
  events: {
    updated: { schema: statusSchema },
    queueUpdated: { schema: queueSchema },
  },
})

export type WatchdogStatus = {
  mode: "ok" | "paused" | "disabled"
  endpoint: "cn" | "international"
  integrationID: string
  stopPercentUsed: number
  windows: {
    window: string
    model: string
    percentRemaining: number | null
    usedPercent: number | null
    resetsAt: number | null
  }[]
  worstPercentRemaining: number | null
  nextResetAt: number | null
  stoppedSessions: number
  lastCheckMs: number | null
  lastError: string | null
  /** Marker shown in the composer pill while the watchdog has paused the work. */
  pausedMarker: string
}

export type QueueTask = {
  id: string
  text: string
  sessionID: string
  sessionTitle: string
  projectName: string
  projectDir: string
  state: "pending" | "executed"
  createdAt: number
  dispatchedAt: number | null
  error: string | null
}

export type QueueSnapshot = {
  tasks: QueueTask[]
  autoExecute: boolean
  autoUntil: number | null
  running: { taskID: string; sessionID: string; startedAt: number } | null
  pending: number
  executed: number
  mode: "ok" | "paused" | "disabled"
  /** Whether the daily idle window is active. */
  idleEnabled: boolean
  /** Idle window start, "HH:MM" local time. */
  idleStart: string
  /** Idle window end, "HH:MM" local time (may be earlier than the start). */
  idleEnd: string
  /** True while the current time is inside the idle window. */
  inIdleWindow: boolean
  /** When the idle window opens or closes next. */
  nextIdleChangeAt: number | null
}

/** Result of the `report` method: the generated HTML file and its event count. */
export type WatchdogReport = {
  path: string
  count: number
}

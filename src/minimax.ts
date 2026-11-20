/**
 * MiniMax coding/token plan quota client (pure, no OpenCode imports).
 *
 * Verified against the live API (Nov 2026, CN key):
 *   GET https://api.minimaxi.com/v1/token_plan/remains        (CN, works with plain Bearer key)
 *   GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains   (international)
 *
 * Response shape:
 *   { base_resp: { status_code, status_msg }, model_remains: [ {
 *       model_name, current_interval_total_count, current_interval_usage_count,
 *       current_interval_remaining_percent, remains_time (ms offset),
 *       start_time / end_time (epoch ms of the rolling 5h window),
 *       current_weekly_total_count, current_weekly_usage_count,
 *       current_weekly_remaining_percent, weekly_start_time / weekly_end_time,
 *       weekly_remains_time (ms offset) } ] }
 *
 * Count semantics differ per endpoint:
 *   CN endpoint:      *_usage_count is the USED count.
 *   International:    *_usage_count is the REMAINING count.
 * New plans report total_count = 0 and only the remaining_percent fields.
 */

export type EndpointId = "cn" | "international"

export type WindowId = "5h" | "weekly"

export const QUOTA_ENDPOINTS: Record<EndpointId, string> = {
  cn: "https://api.minimaxi.com/v1/token_plan/remains",
  international: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
}

export interface QuotaRow {
  window: WindowId
  model: string
  percentRemaining: number | undefined
  /** Epoch ms when this window resets; undefined when unknown. */
  resetsAt: number | undefined
  total: number | undefined
  remaining: number | undefined
}

export interface QuotaSnapshot {
  endpoint: EndpointId
  model: string
  rows: QuotaRow[]
  fetchedAtMs: number
}

export class MiniMaxQuotaError extends Error {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function roundPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Coding-relevant models: MiniMax-M* wildcard rows and the "general" bucket. */
function isCodingModelName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return normalized.startsWith("minimax-m") || normalized === "general"
}

function remainingFromCount(endpoint: EndpointId, total: number, count: number): number {
  // CN reports used count; international reports remaining count.
  const remaining = endpoint === "cn" ? total - count : count
  return Math.min(total, Math.max(0, remaining))
}

interface RawModelRow {
  model_name?: unknown
  current_interval_total_count?: unknown
  current_interval_usage_count?: unknown
  current_interval_remaining_percent?: unknown
  remains_time?: unknown
  end_time?: unknown
  current_weekly_total_count?: unknown
  current_weekly_usage_count?: unknown
  current_weekly_remaining_percent?: unknown
  weekly_remains_time?: unknown
  weekly_end_time?: unknown
}

interface WindowSpec {
  window: WindowId
  total: (m: RawModelRow) => unknown
  count: (m: RawModelRow) => unknown
  percent: (m: RawModelRow) => unknown
  resetEpoch: (m: RawModelRow) => unknown
  resetOffset: (m: RawModelRow) => unknown
}

const WINDOW_SPECS: WindowSpec[] = [
  {
    window: "5h",
    total: (m) => m.current_interval_total_count,
    count: (m) => m.current_interval_usage_count,
    percent: (m) => m.current_interval_remaining_percent,
    resetEpoch: (m) => m.end_time,
    resetOffset: (m) => m.remains_time,
  },
  {
    window: "weekly",
    total: (m) => m.current_weekly_total_count,
    count: (m) => m.current_weekly_usage_count,
    percent: (m) => m.current_weekly_remaining_percent,
    resetEpoch: (m) => m.weekly_end_time,
    resetOffset: (m) => m.weekly_remains_time,
  },
]

function rowForWindow(model: RawModelRow, modelName: string, spec: WindowSpec, endpoint: EndpointId, nowMs: number): QuotaRow | undefined {
  const total = spec.total(model)
  const count = spec.count(model)
  const percent = spec.percent(model)

  let percentRemaining: number | undefined
  let remaining: number | undefined
  let totalOut: number | undefined

  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(count)) {
    totalOut = total
    remaining = remainingFromCount(endpoint, total, count)
    percentRemaining = roundPercent((remaining / total) * 100)
  } else if (isFiniteNumber(percent)) {
    percentRemaining = roundPercent(percent)
  } else {
    return undefined
  }

  let resetsAt: number | undefined
  const epoch = spec.resetEpoch(model)
  if (isFiniteNumber(epoch) && epoch > nowMs) {
    resetsAt = epoch
  } else {
    const offset = spec.resetOffset(model)
    if (isFiniteNumber(offset)) resetsAt = nowMs + Math.max(0, offset)
  }

  return { window: spec.window, model: modelName, percentRemaining, resetsAt, total: totalOut, remaining }
}

/** Prefer the MiniMax-M* wildcard row; otherwise the coding row with the least left. */
function selectModel(models: RawModelRow[], endpoint: EndpointId, nowMs: number): RawModelRow | undefined {
  const candidates = models.filter((m) => typeof m.model_name === "string" && isCodingModelName(m.model_name))
  if (candidates.length === 0) return undefined
  const wildcard = candidates.find((m) => String(m.model_name).trim().toLowerCase() === "minimax-m*")
  if (wildcard) return wildcard
  const worstOf = (m: RawModelRow): number => {
    const percents = WINDOW_SPECS.map((spec) => rowForWindow(m, String(m.model_name), spec, endpoint, nowMs)?.percentRemaining)
      .filter((p): p is number => typeof p === "number")
    return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY
  }
  return [...candidates].sort((a, b) => worstOf(a) - worstOf(b))[0]
}

export interface FetchQuotaOptions {
  apiKey: string
  endpoint: EndpointId
  timeoutMs?: number
  nowMs?: number
}

export async function fetchMiniMaxQuota(options: FetchQuotaOptions): Promise<QuotaSnapshot> {
  const nowMs = options.nowMs ?? Date.now()
  const url = QUOTA_ENDPOINTS[options.endpoint]
  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
  } catch (error) {
    throw new MiniMaxQuotaError(`MiniMax quota request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new MiniMaxQuotaError(`MiniMax quota request got HTTP ${response.status}`)
  }
  let payload: {
    base_resp?: { status_code?: unknown; status_msg?: unknown }
    model_remains?: unknown
  }
  try {
    payload = await response.json()
  } catch (error) {
    throw new MiniMaxQuotaError(`MiniMax quota response is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!payload || (isFiniteNumber(payload.base_resp?.status_code) && payload.base_resp.status_code !== 0)) {
    throw new MiniMaxQuotaError(`MiniMax quota API error: ${String(payload?.base_resp?.status_msg ?? "unknown")}`)
  }
  const models = Array.isArray(payload.model_remains) ? (payload.model_remains as RawModelRow[]) : []
  const model = selectModel(models, options.endpoint, nowMs)
  if (!model) return { endpoint: options.endpoint, model: "", rows: [], fetchedAtMs: nowMs }
  const modelName = String(model.model_name)
  const rows = WINDOW_SPECS.flatMap((spec) => {
    const row = rowForWindow(model, modelName, spec, options.endpoint, nowMs)
    return row ? [row] : []
  })
  return { endpoint: options.endpoint, model: modelName, rows, fetchedAtMs: nowMs }
}

export interface EvaluateOptions {
  windows: WindowId[]
  /** Stop when used percent reaches this value (95 => stop at 5% remaining). */
  stopPercentUsed: number
  nowMs?: number
}

export interface Evaluation {
  /** "ok" | "exhausted" | "unknown" (no comparable data). */
  status: "ok" | "exhausted" | "unknown"
  worstPercentRemaining: number | undefined
  usedPercent: number | undefined
  rows: QuotaRow[]
  /**
   * Earliest future reset among rows that are below the threshold. While paused,
   * re-check no earlier than this.
   */
  nextResetAt: number | undefined
}

export function evaluateQuota(snapshot: QuotaSnapshot, options: EvaluateOptions): Evaluation {
  const nowMs = options.nowMs ?? Date.now()
  const thresholdRemaining = 100 - options.stopPercentUsed
  const rows = snapshot.rows.filter(
    (row) => options.windows.includes(row.window) && typeof row.percentRemaining === "number",
  )
  if (rows.length === 0) {
    return { status: "unknown", worstPercentRemaining: undefined, usedPercent: undefined, rows: snapshot.rows, nextResetAt: undefined }
  }
  const worst = Math.min(...rows.map((row) => row.percentRemaining as number))
  const used = 100 - worst
  const shouldStop = used >= options.stopPercentUsed
  const belowThreshold = rows.filter((row) => (row.percentRemaining as number) <= thresholdRemaining)
  const futureResets = belowThreshold
    .map((row) => row.resetsAt)
    .filter((t): t is number => typeof t === "number" && t > nowMs)
  return {
    status: shouldStop ? "exhausted" : "ok",
    worstPercentRemaining: worst,
    usedPercent: used,
    rows,
    nextResetAt: futureResets.length > 0 ? Math.min(...futureResets) : undefined,
  }
}

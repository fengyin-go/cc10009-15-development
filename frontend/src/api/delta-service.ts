import { loadDeltaBatchStore, saveDeltaBatchStore } from '@/data/delta-batches'
import type { DeltaBatch, DeltaStartRequest } from '@/data/delta-batches'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 增量批次引擎：同一游标的启动是幂等操作。
// - 并发/重复启动只允许一个运行中批次占用游标，重复请求回放首次决策，不产生第二个批次；
// - 批次提交成功才推进游标水位，失败保留上一水位；
// - 两个批次对水位归属冲突时，以最后完整提交的批次为准；
// - 批次启动时快照增量字段、回退步数、批次大小，历史批次按原值可查。

const CURSOR_MODULE = 'delta'
/** 与调度周期一致的默认步长：每 15 分钟一轮增量 */
const BATCH_INTERVAL_MINUTES = 15

export type StartBatchResult = {
  ok: boolean
  message: string
  batch?: DeltaBatch
}

export type CommitBatchInput = {
  successCount: number
  dedupHits: number
  endWatermark?: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatMoment(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function parseMoment(text: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!matched) {
    return null
  }
  const [, year, month, day, hour, minute, second] = matched
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

function compactMoment(text: string): string {
  const date = parseMoment(text)
  if (!date) {
    return text.replace(/[-: ]/g, '')
  }
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function shiftMinutes(text: string, minutes: number): string {
  const date = parseMoment(text)
  if (!date) {
    return text
  }
  return formatMoment(new Date(date.getTime() + minutes * 60_000))
}

function findCursor(cursorId: number): EntryRow | undefined {
  return listRows(CURSOR_MODULE).find((row) => Number(row.id) === cursorId)
}

function persistCursor(updated: EntryRow): void {
  const rows = listRows(CURSOR_MODULE).map((row) =>
    Number(row.id) === Number(updated.id) ? updated : row,
  )
  saveRows(CURSOR_MODULE, rows)
}

function runningBatchOf(cursorId: number): DeltaBatch | undefined {
  return loadDeltaBatchStore().batches.find(
    (batch) => batch.cursorId === cursorId && batch.status === '运行中',
  )
}

function recordRequest(
  requests: DeltaStartRequest[],
  entry: Omit<DeltaStartRequest, 'createdAt'>,
): void {
  requests.push({ ...entry, createdAt: formatMoment(new Date()) })
}

/** 下一个可用的幂等请求号，形如 R-78，供表单预填 */
export function nextRequestIdPreview(): string {
  const used = loadDeltaBatchStore().requests
    .map((request) => /^R-(\d+)$/.exec(request.requestId)?.[1])
    .filter((num): num is string => Boolean(num))
    .map(Number)
  const next = used.length > 0 ? Math.max(...used) + 1 : 1
  return `R-${next}`
}

/** 幂等启动：同一游标同一时刻只允许一个运行中批次，重复请求回放首次决策 */
export function startDeltaBatch(cursorId: number, requestId: string, rerun = false): StartBatchResult {
  const store = loadDeltaBatchStore()
  const cursor = findCursor(cursorId)
  if (!cursor) {
    return { ok: false, message: `没有找到编号为 ${cursorId} 的增量游标` }
  }
  const cursorCode = String(cursor['游标编号'])
  const normalizedId = requestId.trim()
  if (!normalizedId) {
    return { ok: false, message: '请求号（幂等键）不能为空' }
  }

  // 幂等回放：同一请求号直接返回首次决策，不产生第二个批次
  const replay = store.requests.find((request) => request.requestId === normalizedId)
  if (replay) {
    if (replay.decision === '已受理') {
      const batch = store.batches.find((item) => item.batchId === replay.batchId)
      return {
        ok: true,
        message: `请求 ${normalizedId} 已受理过，幂等返回批次 ${replay.batchId}，未产生新批次`,
        batch,
      }
    }
    return { ok: false, message: `请求 ${normalizedId} 此前已被拒绝：${replay.reason}` }
  }

  // 占用检查：游标已有运行中批次时，并发/重复启动一律拒绝
  const running = runningBatchOf(cursorId)
  if (running) {
    const reason = `同一游标已有运行中批次 ${running.batchId}，重复启动被幂等拒绝`
    recordRequest(store.requests, {
      requestId: normalizedId,
      cursorId,
      cursorCode,
      rerun,
      decision: '已拒绝',
      batchId: '',
      reason,
    })
    saveDeltaBatchStore(store)
    return { ok: false, message: `请求 ${normalizedId} 被拒绝：${reason}` }
  }

  // 重跑检查：重跑请求要求游标开启重跑开关
  if (rerun && String(cursor['重跑开关']) !== '开启') {
    const reason = `游标 ${cursorCode} 的重跑开关未开启，重跑请求被拒绝`
    recordRequest(store.requests, {
      requestId: normalizedId,
      cursorId,
      cursorCode,
      rerun,
      decision: '已拒绝',
      batchId: '',
      reason,
    })
    saveDeltaBatchStore(store)
    return { ok: false, message: `请求 ${normalizedId} 被拒绝：${reason}` }
  }

  const startedAt = formatMoment(new Date())
  // 全局序号：同一分钟内多个游标同时启动也不会撞批次号
  const seq = store.batches.length + 1
  const batch: DeltaBatch = {
    batchId: `DB-${compactMoment(startedAt)}-${pad(seq)}`,
    cursorId,
    cursorCode,
    site: String(cursor['目标站点']),
    requestId: normalizedId,
    startWatermark: String(cursor['当前水位']),
    endWatermark: '',
    successCount: 0,
    dedupHits: 0,
    status: '运行中',
    deltaField: String(cursor['增量字段']),
    backtrackSteps: String(cursor['回退步数']),
    batchSize: String(cursor['批次大小']),
    dedupWindow: String(cursor['去重窗口']),
    startedAt,
    finishedAt: '',
    failReason: '',
  }
  store.batches.push(batch)
  recordRequest(store.requests, {
    requestId: normalizedId,
    cursorId,
    cursorCode,
    rerun,
    decision: '已受理',
    batchId: batch.batchId,
    reason: '',
  })
  saveDeltaBatchStore(store)
  persistCursor({ ...cursor, status: '运行中' })
  return {
    ok: true,
    message: `批次 ${batch.batchId} 已启动，本批起始位点 ${batch.startWatermark}`,
    batch,
  }
}

/** 提交成功：推进游标水位；水位归属以最后完整提交的批次为准 */
export function commitDeltaBatch(batchId: string, input: CommitBatchInput): StartBatchResult {
  const store = loadDeltaBatchStore()
  const batch = store.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status !== '运行中') {
    return { ok: false, message: `批次 ${batchId} 当前状态「${batch.status}」，不能重复提交` }
  }
  const cursor = findCursor(batch.cursorId)
  if (!cursor) {
    return { ok: false, message: `批次 ${batchId} 关联的增量游标已不存在` }
  }
  const endWatermark =
    input.endWatermark?.trim() || shiftMinutes(batch.startWatermark, BATCH_INTERVAL_MINUTES)
  batch.status = '已提交'
  batch.endWatermark = endWatermark
  batch.successCount = Math.max(0, Math.floor(input.successCount))
  batch.dedupHits = Math.max(0, Math.floor(input.dedupHits))
  batch.finishedAt = formatMoment(new Date())
  saveDeltaBatchStore(store)
  // 最后完整提交的批次直接覆盖水位，天然解决归属冲突
  persistCursor({ ...cursor, status: '运行中', 当前水位: endWatermark })
  return {
    ok: true,
    message: `批次 ${batchId} 已提交，游标 ${batch.cursorCode} 水位推进到 ${endWatermark}（成功 ${batch.successCount} 条，去重命中 ${batch.dedupHits} 条）`,
    batch,
  }
}

/** 标记失败：保留上一水位，游标当前水位不变 */
export function failDeltaBatch(batchId: string, reason: string): StartBatchResult {
  const store = loadDeltaBatchStore()
  const batch = store.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status !== '运行中') {
    return { ok: false, message: `批次 ${batchId} 当前状态「${batch.status}」，不能标记失败` }
  }
  batch.status = '已失败'
  batch.failReason = reason.trim() || '采集执行失败'
  batch.finishedAt = formatMoment(new Date())
  saveDeltaBatchStore(store)
  const cursor = findCursor(batch.cursorId)
  const kept = cursor ? String(cursor['当前水位']) : batch.startWatermark
  return {
    ok: true,
    message: `批次 ${batchId} 已失败（${batch.failReason}），游标 ${batch.cursorCode} 水位保留在 ${kept}`,
    batch,
  }
}

export function listDeltaBatches(): DeltaBatch[] {
  return [...loadDeltaBatchStore().batches].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function listDeltaRequests(): DeltaStartRequest[] {
  return [...loadDeltaBatchStore().requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function listRunningBatches(): DeltaBatch[] {
  return loadDeltaBatchStore().batches.filter((batch) => batch.status === '运行中')
}

/** 采集任务页联动用：目标站点 → 运行中批次 */
export function runningBatchBySite(): Map<string, DeltaBatch> {
  const map = new Map<string, DeltaBatch>()
  for (const batch of listRunningBatches()) {
    if (!map.has(batch.site)) {
      map.set(batch.site, batch)
    }
  }
  return map
}

/** 当前水位的归属批次：同一游标最后完整提交的那一个 */
export function watermarkOwner(cursorId: number): DeltaBatch | undefined {
  return loadDeltaBatchStore()
    .batches.filter((batch) => batch.cursorId === cursorId && batch.status === '已提交')
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0]
}

/** 提交时预填的结束水位：本批起始位点 + 一个调度周期 */
export function defaultEndWatermark(batch: DeltaBatch): string {
  return shiftMinutes(batch.startWatermark, BATCH_INTERVAL_MINUTES)
}

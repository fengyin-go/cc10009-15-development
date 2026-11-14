// 增量批次与启动请求的本地持久化：一次「启动增量」产生一个批次，
// 游标水位只认最后完整提交的批次。数据放在独立 localStorage 键里，刷新、重开都还在。

export type DeltaBatchStatus = '运行中' | '已提交' | '已失败'

export type DeltaBatch = {
  batchId: string
  cursorId: number
  cursorCode: string
  site: string
  /** 幂等键：同一请求号重复启动不会产生第二个批次 */
  requestId: string
  /** 本批起始位点（启动那一刻游标的当前水位） */
  startWatermark: string
  /** 提交后推进到的水位；运行中/已失败为空 */
  endWatermark: string
  successCount: number
  dedupHits: number
  status: DeltaBatchStatus
  /** 以下四项是启动时从游标快照的配置，历史批次始终按原值可查 */
  deltaField: string
  backtrackSteps: string
  batchSize: string
  dedupWindow: string
  startedAt: string
  finishedAt: string
  failReason: string
}

export type DeltaStartRequest = {
  requestId: string
  cursorId: number
  cursorCode: string
  rerun: boolean
  decision: '已受理' | '已拒绝'
  batchId: string
  reason: string
  createdAt: string
}

export type DeltaBatchStore = {
  batches: DeltaBatch[]
  requests: DeltaStartRequest[]
}

const STORAGE_KEY = 'scraper-config-studio:delta-batches'

// 种子故事线：站点 FC-9A 的游标 DELT-0001
// - R-75：08:15 触发并完整提交，水位推进到 2026-11-13 08:15:30，成功 137 条，去重窗口命中 4 条
// - R-76：08:30 触发，批次仍在运行中
// - R-77：重跑请求，因游标已被运行中批次占用被幂等拒绝
export const SEED_DELTA_BATCHES: DeltaBatch[] = [
  {
    batchId: 'DB-20261113-0815-01',
    cursorId: 1,
    cursorCode: 'DELT-0001',
    site: 'FC-9A',
    requestId: 'R-75',
    startWatermark: '2026-11-13 08:00:30',
    endWatermark: '2026-11-13 08:15:30',
    successCount: 137,
    dedupHits: 4,
    status: '已提交',
    deltaField: '日志时间',
    backtrackSteps: '2',
    batchSize: '500',
    dedupWindow: '30分钟',
    startedAt: '2026-11-13 08:15:00',
    finishedAt: '2026-11-13 08:16:12',
    failReason: '',
  },
  {
    batchId: 'DB-20261113-0830-02',
    cursorId: 1,
    cursorCode: 'DELT-0001',
    site: 'FC-9A',
    requestId: 'R-76',
    startWatermark: '2026-11-13 08:15:30',
    endWatermark: '',
    successCount: 0,
    dedupHits: 0,
    status: '运行中',
    deltaField: '日志时间',
    backtrackSteps: '2',
    batchSize: '500',
    dedupWindow: '30分钟',
    startedAt: '2026-11-13 08:30:00',
    finishedAt: '',
    failReason: '',
  },
]

export const SEED_DELTA_REQUESTS: DeltaStartRequest[] = [
  {
    requestId: 'R-75',
    cursorId: 1,
    cursorCode: 'DELT-0001',
    rerun: false,
    decision: '已受理',
    batchId: 'DB-20261113-0815-01',
    reason: '',
    createdAt: '2026-11-13 08:15:00',
  },
  {
    requestId: 'R-76',
    cursorId: 1,
    cursorCode: 'DELT-0001',
    rerun: false,
    decision: '已受理',
    batchId: 'DB-20261113-0830-02',
    reason: '',
    createdAt: '2026-11-13 08:30:00',
  },
  {
    requestId: 'R-77',
    cursorId: 1,
    cursorCode: 'DELT-0001',
    rerun: true,
    decision: '已拒绝',
    batchId: '',
    reason: '同一游标已有运行中批次 DB-20261113-0830-02，重复启动被幂等拒绝',
    createdAt: '2026-11-13 08:30:20',
  },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedStore(): DeltaBatchStore {
  return { batches: clone(SEED_DELTA_BATCHES), requests: clone(SEED_DELTA_REQUESTS) }
}

function readStore(): DeltaBatchStore {
  const fallback = seedStore()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeltaBatchStore>
    return {
      batches: Array.isArray(parsed.batches) ? parsed.batches : fallback.batches,
      requests: Array.isArray(parsed.requests) ? parsed.requests : fallback.requests,
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: DeltaBatchStore | null = null

export function loadDeltaBatchStore(): DeltaBatchStore {
  if (cache === null) {
    cache = readStore()
  }
  return cache
}

export function saveDeltaBatchStore(store: DeltaBatchStore): void {
  cache = store
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

export function resetDeltaBatchStore(): DeltaBatchStore {
  const store = seedStore()
  saveDeltaBatchStore(store)
  return store
}

export function deltaBatchStorageKey(): string {
  return STORAGE_KEY
}

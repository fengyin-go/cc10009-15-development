<template>
  <section class="page" data-module="delta">
    <header class="page-head">
      <div>
        <h2>增量采集管理</h2>
        <p class="page-desc">维护增量采集游标的输入、执行约束与结果记录，为增量采集提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记增量游标</button>
        <button class="btn" type="button" @click="exportRows">导出增量采集清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无增量采集数据，可先登记增量游标</td>
        </tr>
      </tbody>
    </table>

    <section class="panel-block">
      <h3 class="section-title">增量批次</h3>
      <p class="page-desc">
        同一游标的启动是幂等操作：并发只允许一个运行中批次，重复请求回放首次决策，不产生第二个批次；
        批次提交成功才推进水位，失败保留上一水位；水位归属以最后完整提交的批次为准。
      </p>

      <form class="filter-bar" @submit.prevent="startBatch">
        <label class="filter-item">
          <span>目标游标</span>
          <select v-model="startForm.cursorId">
            <option v-for="row in rows" :key="String(row.id)" :value="Number(row.id)">
              {{ row['游标编号'] }} · {{ row['目标站点'] }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>请求号（幂等键）</span>
          <input v-model="startForm.requestId" placeholder="如 R-78" />
        </label>
        <label class="filter-item">
          <span>重跑请求</span>
          <input v-model="startForm.rerun" type="checkbox" />
        </label>
        <button class="btn primary" type="submit">启动增量批次</button>
      </form>
      <p v-if="panelMessage" :class="panelOk ? 'ok-text' : 'error-text'">{{ panelMessage }}</p>

      <h4 class="section-subtitle">运行中批次</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>游标编号</th>
            <th>目标站点</th>
            <th>本批起始位点</th>
            <th>启动时间</th>
            <th>结束水位</th>
            <th>成功条数</th>
            <th>去重命中</th>
            <th>失败原因</th>
            <th>批次操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in runningBatches" :key="batch.batchId">
            <td>{{ batch.batchId }}</td>
            <td>{{ batch.cursorCode }}</td>
            <td>{{ batch.site }}</td>
            <td>{{ batch.startWatermark }}</td>
            <td>{{ batch.startedAt }}</td>
            <td><input v-model="commitForms[batch.batchId].endWatermark" class="cell-input" /></td>
            <td><input v-model.number="commitForms[batch.batchId].successCount" class="cell-input narrow" type="number" min="0" /></td>
            <td><input v-model.number="commitForms[batch.batchId].dedupHits" class="cell-input narrow" type="number" min="0" /></td>
            <td><input v-model="commitForms[batch.batchId].failReason" class="cell-input" placeholder="标记失败时填写" /></td>
            <td class="row-actions">
              <button class="link" type="button" @click="commitBatch(batch)">提交批次</button>
              <button class="link" type="button" @click="failBatch(batch)">标记失败</button>
            </td>
          </tr>
          <tr v-if="!runningBatches.length">
            <td colspan="10" class="empty-state">当前没有运行中的增量批次</td>
          </tr>
        </tbody>
      </table>

      <h4 class="section-subtitle">批次历史</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>游标编号</th>
            <th>目标站点</th>
            <th>本批起始位点</th>
            <th>结束水位</th>
            <th>成功条数</th>
            <th>去重窗口命中</th>
            <th>增量字段</th>
            <th>回退步数</th>
            <th>批次大小</th>
            <th>状态</th>
            <th>水位归属</th>
            <th>完成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batchHistory" :key="batch.batchId">
            <td>{{ batch.batchId }}</td>
            <td>{{ batch.cursorCode }}</td>
            <td>{{ batch.site }}</td>
            <td>{{ batch.startWatermark }}</td>
            <td>{{ batch.endWatermark || '—' }}</td>
            <td>{{ batch.status === '已提交' ? batch.successCount : '—' }}</td>
            <td>{{ batch.status === '已提交' ? batch.dedupHits : '—' }}</td>
            <td>{{ batch.deltaField }}</td>
            <td>{{ batch.backtrackSteps }}</td>
            <td>{{ batch.batchSize }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ ownerMark(batch) }}</td>
            <td>{{ batch.finishedAt || '—' }}</td>
          </tr>
          <tr v-if="!batchHistory.length">
            <td colspan="13" class="empty-state">暂无增量批次记录</td>
          </tr>
        </tbody>
      </table>

      <h4 class="section-subtitle">启动请求日志</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>请求号</th>
            <th>游标编号</th>
            <th>请求类型</th>
            <th>决策</th>
            <th>关联批次</th>
            <th>说明</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="request in requestLog" :key="request.requestId">
            <td>{{ request.requestId }}</td>
            <td>{{ request.cursorCode }}</td>
            <td>{{ request.rerun ? '重跑' : '常规' }}</td>
            <td>{{ request.decision }}</td>
            <td>{{ request.batchId || '—' }}</td>
            <td>{{ request.reason || '—' }}</td>
            <td>{{ request.createdAt }}</td>
          </tr>
          <tr v-if="!requestLog.length">
            <td colspan="7" class="empty-state">暂无启动请求记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条增量采集记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  commitDeltaBatch,
  defaultEndWatermark,
  failDeltaBatch,
  listDeltaBatches,
  listDeltaRequests,
  listRunningBatches,
  nextRequestIdPreview,
  startDeltaBatch,
  watermarkOwner,
} from '@/api/delta-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { DeltaBatch, DeltaStartRequest } from '@/data/delta-batches'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('delta')
const columns = ["游标编号", "目标站点", "增量字段", "当前水位", "回退步数", "批次大小", "去重窗口", "重跑开关"]
const actions = ["提交校验", "启动增量", "暂停增量"]
const statuses = ["草稿", "待校验", "运行中", "已暂停"]
const stats = [{"label": "增量游标总数", "value": 0}, {"label": "运行中游标", "value": 0}, {"label": "待校验游标", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type CommitForm = {
  endWatermark: string
  successCount: number
  dedupHits: number
  failReason: string
}

const runningBatches = ref<DeltaBatch[]>([])
const batchHistory = ref<DeltaBatch[]>([])
const requestLog = ref<DeltaStartRequest[]>([])
const commitForms = ref<Record<string, CommitForm>>({})
const startForm = ref({ cursorId: 1, requestId: '', rerun: false })
const panelMessage = ref('')
const panelOk = ref(false)

function ownerMark(batch: DeltaBatch): string {
  if (batch.status !== '已提交') {
    return '—'
  }
  return watermarkOwner(batch.cursorId)?.batchId === batch.batchId ? '✓ 当前归属' : '—'
}

function showPanel(ok: boolean, message: string) {
  panelOk.value = ok
  panelMessage.value = message
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '增量游标登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '启动增量') {
    const result = startDeltaBatch(Number(row.id), nextRequestIdPreview(), false)
    showPanel(result.ok, result.message)
    refreshAll()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshAll()
}

function startBatch() {
  const result = startDeltaBatch(
    Number(startForm.value.cursorId),
    startForm.value.requestId,
    startForm.value.rerun,
  )
  showPanel(result.ok, result.message)
  startForm.value.requestId = nextRequestIdPreview()
  refreshAll()
}

function commitBatch(batch: DeltaBatch) {
  const form = commitForms.value[batch.batchId]
  const result = commitDeltaBatch(batch.batchId, {
    successCount: Number(form?.successCount) || 0,
    dedupHits: Number(form?.dedupHits) || 0,
    endWatermark: form?.endWatermark ?? '',
  })
  showPanel(result.ok, result.message)
  refreshAll()
}

function failBatch(batch: DeltaBatch) {
  const form = commitForms.value[batch.batchId]
  const result = failDeltaBatch(batch.batchId, form?.failReason ?? '')
  showPanel(result.ok, result.message)
  refreshAll()
}

function refreshAll() {
  reload()
  reloadBatches()
}

function reloadBatches() {
  runningBatches.value = listRunningBatches()
  batchHistory.value = listDeltaBatches()
  requestLog.value = listDeltaRequests()
  const forms: Record<string, CommitForm> = {}
  for (const batch of runningBatches.value) {
    forms[batch.batchId] = commitForms.value[batch.batchId] ?? {
      endWatermark: defaultEndWatermark(batch),
      successCount: Number(batch.batchSize) || 0,
      dedupHits: 0,
      failReason: '',
    }
  }
  commitForms.value = forms
  if (!startForm.value.requestId) {
    startForm.value.requestId = nextRequestIdPreview()
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (!rows.value.some((row) => Number(row.id) === Number(startForm.value.cursorId))) {
      startForm.value.cursorId = Number(rows.value[0]?.id ?? 1)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '增量采集列表读取失败'
  }
}

onMounted(refreshAll)
</script>

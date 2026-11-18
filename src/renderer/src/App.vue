<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  formatBytes,
  groupCapturesByTime,
  type AppGroup,
  type CaptureFileMeta,
  type PermissionState
} from '@shared/types'

/* ---------------- 状态 ---------------- */

const permission = ref<PermissionState | null>(null)
const groups = ref<AppGroup[]>([])
const loadingWindows = ref(false)
const selectedAppKey = ref('')
const intervalSec = ref(10)
const intervalInput = ref('10')
const outputDir = ref('')
const running = ref(false)
const statusMsg = ref('未开始')
const busy = ref(false)

const files = ref<CaptureFileMeta[]>([])
const loadingFiles = ref(false)
const preview = ref<CaptureFileMeta | null>(null)
/** 时间索引当前选中的轮次;'' = 全部 */
const selectedRoundKey = ref('')

const toast = ref<{ id: number; kind: 'ok' | 'error'; text: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
let galleryReloadTimer: ReturnType<typeof setTimeout> | undefined
let unsubs: (() => void)[] = []

/* ---------------- 工具 ---------------- */

function notify(text: string, kind: 'ok' | 'error' = 'ok'): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toast.value = { id: Date.now(), kind, text }
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 2600)
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 应用下拉的展示名:应用名 + 窗口数 */
function groupLabel(g: AppGroup): string {
  return `${g.ownerName} (${g.windows.length} 个窗口)`
}

/** 选中应用的窗口列表(标题/尺寸一目了然) */
const selectedWindows = computed(() => groups.value.find((g) => g.key === selectedAppKey.value)?.windows ?? [])

/** 截图按截取时间(轮次)分组,新→旧:时间索引的数据源 */
const rounds = computed(() => groupCapturesByTime(files.value))

/** 当前展示的截图:选了轮次则只看该轮,否则全部 */
const shownFiles = computed<CaptureFileMeta[]>(() =>
  selectedRoundKey.value
    ? (rounds.value.find((r) => r.key === selectedRoundKey.value)?.files ?? [])
    : files.value
)

/** 大图预览在当前列表中的序号(-1 = 不在列表中) */
const previewIndex = computed(() =>
  preview.value ? shownFiles.value.findIndex((f) => f.path === preview.value?.path) : -1
)

const needPermission = computed(() => permission.value !== null && !permission.value.granted)

function imgUrl(path: string): string {
  return window.api.imageUrl(path)
}

/* ---------------- 初始化与事件 ---------------- */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  unsubs.push(
    window.api.onMonitorChanged((p) => {
      running.value = p.running
      statusMsg.value = p.message
    }),
    // 同一轮多窗口会连发多个事件,合并成一次刷新
    window.api.onCaptureSaved(() => {
      if (galleryReloadTimer !== undefined) clearTimeout(galleryReloadTimer)
      galleryReloadTimer = setTimeout(() => void loadFiles(), 300)
    })
  )

  try {
    permission.value = await window.api.system.permissionState()
  } catch {
    permission.value = { granted: false, titlesAvailable: false }
  }

  const cfg = await window.api.monitor.config()
  selectedAppKey.value = cfg.appKey
  intervalSec.value = cfg.intervalSec
  intervalInput.value = String(cfg.intervalSec)
  outputDir.value = cfg.outputDir
  running.value = cfg.running

  await Promise.all([void loadWindows(), void loadFiles()])
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unsubs.forEach((u) => u())
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  if (galleryReloadTimer !== undefined) clearTimeout(galleryReloadTimer)
})

/* ---------------- 数据加载 ---------------- */

async function loadWindows(): Promise<void> {
  loadingWindows.value = true
  try {
    const res = await window.api.windows.list()
    groups.value = res.groups
    // 顺带刷新权限状态:无权限时窗口标题会被系统抹掉
    permission.value = {
      granted: res.groups.length === 0 || res.windows.some((w) => w.title),
      titlesAvailable: res.windows.some((w) => w.title)
    }
    // 已选应用退出后不在列表里:清空选择并提示
    if (selectedAppKey.value && !res.groups.some((g) => g.key === selectedAppKey.value)) {
      selectedAppKey.value = ''
      notify('之前选择的应用当前没有可见窗口', 'error')
    }
  } catch (err) {
    notify(`窗口枚举失败: ${err instanceof Error ? err.message : err}`, 'error')
  } finally {
    loadingWindows.value = false
  }
}

async function loadFiles(): Promise<void> {
  loadingFiles.value = true
  try {
    files.value = await window.api.gallery.list()
    // 选中的轮次已被删除(如清理)时回退到全部
    if (selectedRoundKey.value && !rounds.value.some((r) => r.key === selectedRoundKey.value)) {
      selectedRoundKey.value = ''
    }
  } finally {
    loadingFiles.value = false
  }
}

/* ---------------- 操作 ---------------- */

/** 选择应用:立即持久化;监控运行中下一轮即按新目标截图 */
async function pickApp(): Promise<void> {
  const group = groups.value.find((g) => g.key === selectedAppKey.value)
  if (!group) return
  const res = await window.api.monitor.setConfig({
    appKey: group.key,
    ownerName: group.ownerName
  })
  if (!res.ok) {
    notify('保存应用选择失败', 'error')
    return
  }
  notify(`已选择「${group.ownerName}」,共 ${group.windows.length} 个窗口`)
}

/** 应用频率:2~86400 秒;保存后运行中的定时器立即按新间隔生效 */
async function saveInterval(): Promise<void> {
  const v = Math.floor(Number(intervalInput.value))
  if (!Number.isFinite(v) || v < 2 || v > 86400) {
    notify('间隔需为 2~86400 之间的秒数', 'error')
    intervalInput.value = String(intervalSec.value)
    return
  }
  const res = await window.api.monitor.setConfig({ intervalSec: v })
  if (!res.ok) {
    notify('保存频率失败', 'error')
    return
  }
  intervalSec.value = res.config.intervalSec
  intervalInput.value = String(res.config.intervalSec)
  notify(`监控频率已设为每 ${v} 秒一轮`)
}

async function changeOutputDir(): Promise<void> {
  const dir = await window.api.system.selectDirectory()
  if (!dir) return
  const res = await window.api.monitor.setConfig({ outputDir: dir })
  if (!res.ok) {
    notify('修改输出目录失败', 'error')
    return
  }
  outputDir.value = res.config.outputDir
  await loadFiles()
  notify('输出目录已更新')
}

async function startMonitor(): Promise<void> {
  busy.value = true
  try {
    const res = await window.api.monitor.start()
    if (!res.ok) notify(res.message, 'error')
    else {
      running.value = true
      statusMsg.value = res.message
      await loadFiles()
    }
  } finally {
    busy.value = false
  }
}

async function stopMonitor(): Promise<void> {
  await window.api.monitor.stop()
  running.value = false
  statusMsg.value = '已停止'
}

async function captureNow(): Promise<void> {
  busy.value = true
  try {
    const res = await window.api.monitor.captureNow()
    if (!res.ok) notify(res.message, 'error')
    await loadFiles()
  } finally {
    busy.value = false
  }
}

async function goGrant(): Promise<void> {
  await window.api.system.openPermissionSettings()
}

async function removeFile(file: CaptureFileMeta): Promise<void> {
  const res = await window.api.gallery.delete(file.path)
  if (!res.ok) {
    notify(res.message ?? '删除失败', 'error')
    return
  }
  files.value = files.value.filter((f) => f.path !== file.path)
  if (preview.value?.path === file.path) preview.value = null
  notify('已删除')
}

async function revealFile(file: CaptureFileMeta): Promise<void> {
  const res = await window.api.gallery.reveal(file.path)
  if (!res.ok) notify(res.message ?? '打开失败', 'error')
}

/** 大图预览:在当前列表内前后翻页(循环) */
function stepPreview(delta: number): void {
  const list = shownFiles.value
  if (list.length === 0 || previewIndex.value < 0) return
  preview.value = list[(previewIndex.value + delta + list.length) % list.length]
}

/** 键盘导航:← → 翻页,Esc 关闭大图 */
function onKeydown(e: KeyboardEvent): void {
  if (!preview.value) return
  if (e.key === 'ArrowLeft') stepPreview(-1)
  else if (e.key === 'ArrowRight') stepPreview(1)
  else if (e.key === 'Escape') preview.value = null
}

/** 频率输入的回车/失焦提交 */
function onIntervalEnter(): void {
  void saveInterval()
}
</script>

<template>
  <div class="titlebar-drag"></div>

  <div class="layout">
    <!-- 左栏:监控控制 -->
    <aside class="panel control">
      <div class="panel-title">监控控制</div>

      <div v-if="needPermission" class="banner warn">
        <span style="flex: 1">未授予「屏幕录制」权限:无法获取窗口标题与画面。授权后无需重启应用。</span>
        <button class="btn small primary" @click="goGrant">去授权</button>
      </div>

      <label class="field">
        <div class="field-label">
          <span>1 · 选择应用</span>
          <button class="btn small" :disabled="loadingWindows" @click="loadWindows">
            {{ loadingWindows ? '刷新中…' : '↻ 刷新' }}
          </button>
        </div>
        <select v-model="selectedAppKey" class="select" @change="pickApp">
          <option value="" disabled>请选择要监控的应用…</option>
          <option v-for="g in groups" :key="g.key" :value="g.key">{{ groupLabel(g) }}</option>
        </select>
      </label>

      <div v-if="selectedWindows.length" class="window-list">
        <div class="field-label"><span>2 · 将截取的窗口({{ selectedWindows.length }})</span></div>
        <div v-for="w in selectedWindows" :key="w.windowId" class="window-item" :title="w.title">
          <span class="win-title">{{ w.title || '(无标题窗口)' }}</span>
          <span class="win-size">{{ Math.round(w.bounds.width) }}×{{ Math.round(w.bounds.height) }}</span>
        </div>
      </div>

      <label class="field">
        <div class="field-label"><span>3 · 监控频率(秒/轮)</span></div>
        <div class="interval-row">
          <input
            v-model="intervalInput"
            class="input"
            type="number"
            min="2"
            max="86400"
            @keyup.enter="onIntervalEnter"
            @blur="onIntervalEnter"
          />
          <button class="btn" @click="saveInterval">保存</button>
        </div>
        <div class="hint">范围 2~86400;当前每 {{ intervalSec }} 秒截一轮,保存后立即生效</div>
      </label>

      <div class="field">
        <div class="field-label"><span>输出目录</span></div>
        <div class="interval-row">
          <span class="dir-path" :title="outputDir">{{ outputDir }}</span>
          <button class="btn small" @click="changeOutputDir">更改</button>
        </div>
      </div>

      <div class="actions">
        <button v-if="!running" class="btn primary grow" :disabled="busy || !selectedAppKey" @click="startMonitor">
          ▶ 开始监控
        </button>
        <button v-else class="btn danger grow" @click="stopMonitor">■ 停止监控</button>
        <button class="btn" :disabled="busy || !selectedAppKey" title="立即按当前配置截一轮" @click="captureNow">
          立即截图
        </button>
      </div>

      <div class="status" :class="{ on: running }">
        <span class="dot"></span>
        <span>{{ statusMsg }}</span>
      </div>
    </aside>

    <!-- 右栏:截图预览 -->
    <section class="panel gallery">
      <div class="panel-title row">
        <span>截图预览</span>
        <span class="count">{{ files.length }} 张</span>
        <button class="btn small" style="margin-left: auto" @click="loadFiles">↻ 刷新</button>
      </div>

      <!-- 时间索引:每轮监控一个时间点,点选只看该轮的全部窗口截图 -->
      <div v-if="rounds.length > 0" class="round-tabs">
        <button
          class="chip"
          :class="{ active: selectedRoundKey === '' }"
          @click="selectedRoundKey = ''"
        >
          全部
        </button>
        <button
          v-for="r in rounds"
          :key="r.key"
          class="chip"
          :class="{ active: selectedRoundKey === r.key }"
          :title="`该轮 ${r.files.length} 张截图`"
          @click="selectedRoundKey = r.key"
        >
          {{ fmtTime(r.at) }}<span class="chip-n">{{ r.files.length }}</span>
        </button>
      </div>

      <div v-if="loadingFiles && files.length === 0" class="empty">加载中…</div>
      <div v-else-if="files.length === 0" class="empty">
        还没有截图;选择应用后点「开始监控」或「立即截图」试试
      </div>
      <div v-else-if="shownFiles.length === 0" class="empty">该时间点没有截图</div>

      <div v-else class="shot-grid">
        <div v-for="f in shownFiles" :key="f.path" class="shot-card" @click="preview = f">
          <img :src="imgUrl(f.path)" loading="lazy" alt="" />
          <div class="info">
            <span class="name" :title="f.name">{{ f.name }}</span>
            <span class="meta">{{ fmtTime(f.mtimeMs) }} · {{ formatBytes(f.bytes) }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- 大图预览:← → 或两侧按钮在当前索引内翻页 -->
  <div v-if="preview" class="modal-mask" @click.self="preview = null">
    <div class="modal">
      <div class="modal-head">
        <h3 class="modal-name">{{ preview.name }}</h3>
        <button class="x-btn" @click="preview = null">✕</button>
      </div>
      <div class="modal-body">
        <button
          v-if="shownFiles.length > 1"
          class="nav-btn prev"
          title="上一张 (←)"
          @click="stepPreview(-1)"
        >
          ‹
        </button>
        <img class="preview-img" :src="imgUrl(preview.path)" alt="" />
        <button
          v-if="shownFiles.length > 1"
          class="nav-btn next"
          title="下一张 (→)"
          @click="stepPreview(1)"
        >
          ›
        </button>
      </div>
      <div class="modal-foot">
        <span class="modal-meta">
          {{ formatBytes(preview.bytes) }} · {{ fmtTime(preview.mtimeMs) }}
          <template v-if="previewIndex >= 0"> · {{ previewIndex + 1 }} / {{ shownFiles.length }}</template>
        </span>
        <button class="btn" @click="revealFile(preview)">在 Finder 中显示</button>
        <button class="btn danger" @click="removeFile(preview)">删除</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="toast" :class="toast.kind">{{ toast.text }}</div>
</template>

<style>
:root {
  --bg: #16181d;
  --panel: #1d2026;
  --panel-2: #22262e;
  --border: #2c313a;
  --text: #d7dae0;
  --text-faint: #8b919c;
  --accent: #4a8cff;
  --danger: #e0564f;
  --ok: #3fa66a;
}

* {
  box-sizing: border-box;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-size: 13px;
  overflow: hidden;
}

/* hiddenInset 无原生标题栏,顶部留白区作为拖拽窗口的把手 */
.titlebar-drag {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 34px;
  -webkit-app-region: drag;
  z-index: 5;
}

#app {
  height: 100vh;
  padding-top: 34px;
}

.layout {
  display: flex;
  gap: 12px;
  height: calc(100vh - 34px);
  padding: 12px;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  overflow-y: auto;
}

.control {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.gallery {
  flex: 1;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
}

.panel-title.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.count {
  color: var(--text-faint);
  font-weight: 400;
  font-size: 12px;
}

/* ---- 表单 ---- */

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-faint);
}

.select,
.input {
  width: 100%;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  font-size: 13px;
  outline: none;
}

.select:focus,
.input:focus {
  border-color: var(--accent);
}

.interval-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hint {
  font-size: 11.5px;
  color: var(--text-faint);
}

.dir-path {
  flex: 1;
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

/* ---- 窗口列表 ---- */

.window-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.window-item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 9px;
  font-size: 12px;
}

.win-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.win-size {
  color: var(--text-faint);
  flex-shrink: 0;
}

/* ---- 按钮/状态 ---- */

.btn {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn.danger {
  background: transparent;
  border-color: var(--danger);
  color: var(--danger);
}

.btn.danger:hover:not(:disabled) {
  background: var(--danger);
  color: #fff;
}

.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}

.grow {
  flex: 1;
}

.actions {
  display: flex;
  gap: 8px;
}

.status {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: 6px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 12px;
  min-height: 36px;
}

.status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.status.on {
  color: var(--text);
}

.status.on .dot {
  background: var(--ok);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ---- 横幅 ---- */

.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
}

.banner.warn {
  background: #3a2e14;
  border: 1px solid #6b5518;
  color: #e8c268;
}

/* ---- 时间索引条 ---- */

.round-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px;
  margin-bottom: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 118px;
  overflow-y: auto;
}

.chip {
  background: transparent;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.chip:hover {
  color: var(--text);
  border-color: var(--accent);
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

/* 轮内截图数角标 */
.chip-n {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10.5px;
}

/* ---- 截图网格 ---- */

.empty {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}

.shot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}

.shot-card {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s;
}

.shot-card:hover {
  border-color: var(--accent);
}

.shot-card img {
  display: block;
  width: 100%;
  height: 128px;
  object-fit: cover;
  object-position: top;
  background: #0e1013;
}

.shot-card .info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  font-size: 11px;
}

.shot-card .name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.shot-card .meta {
  color: var(--text-faint);
}

/* ---- 大图预览 ---- */

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  width: min(92vw, 1200px);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.modal-name {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
  flex: 1;
}

.x-btn {
  background: none;
  border: none;
  color: var(--text-faint);
  font-size: 15px;
  cursor: pointer;
  padding: 2px 6px;
}

.x-btn:hover {
  color: var(--text);
}

.modal-body {
  position: relative;
  overflow: auto;
  background: #0e1013;
  display: flex;
  justify-content: center;
}

/* 大图两侧翻页按钮:随滚动吸顶居中,悬浮在图旁 */
.nav-btn {
  position: sticky;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: rgba(14, 16, 19, 0.75);
  color: var(--text);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0 10px;
}

.nav-btn:hover {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.preview-img {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}

.modal-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.modal-meta {
  margin-right: auto;
  font-size: 12px;
  color: var(--text-faint);
}

/* ---- toast ---- */

.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 12.5px;
  z-index: 30;
  background: var(--panel-2);
  border: 1px solid var(--border);
}

.toast.ok {
  border-color: var(--ok);
}

.toast.error {
  border-color: var(--danger);
}
</style>

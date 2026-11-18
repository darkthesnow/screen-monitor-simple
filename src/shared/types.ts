// 主进程与渲染进程共享的类型定义(简化版:窗口/应用/监控配置/截图文件)

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowInfo {
  windowId: number
  title: string
  ownerName: string
  bundleId: string | null
  pid: number
  bounds: WindowBounds
}

/** 按应用聚合后的窗口组(bundleId 缺失时回退 ownerName 作为 key) */
export interface AppGroup {
  key: string
  ownerName: string
  bundleId: string | null
  windows: WindowInfo[]
}

/** 可见窗口按应用聚合;bundleId 缺失时用 ownerName 兜底作 key。组内按窗口面积降序(主窗口在前) */
export function groupByApp(windows: WindowInfo[]): AppGroup[] {
  const map = new Map<string, AppGroup>()
  for (const w of windows) {
    const key = w.bundleId ?? w.ownerName
    let group = map.get(key)
    if (!group) {
      group = { key, ownerName: w.ownerName, bundleId: w.bundleId, windows: [] }
      map.set(key, group)
    }
    group.windows.push(w)
  }
  const groups = [...map.values()]
  groups.sort((a, b) => b.windows.length - a.windows.length || a.ownerName.localeCompare(b.ownerName))
  for (const g of groups) {
    g.windows.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
  }
  return groups
}

export interface PermissionState {
  granted: boolean
  /** 无权限时 macOS 会抹掉窗口标题,提示用户授权 */
  titlesAvailable: boolean
}

/** 监控配置:选定应用 + 截图间隔(秒);持久化于 userData/config.json */
export interface MonitorConfig {
  /** 目标应用 key(= bundleId 或 ownerName);空 = 未选择 */
  appKey: string
  ownerName: string
  intervalSec: number
  /** 截图输出目录;空 = 默认 ~/Pictures/screenMonitor */
  outputDir: string
}

export const MIN_INTERVAL_SEC = 2
export const MAX_INTERVAL_SEC = 86400

export function clampIntervalSec(v: unknown, fallback = 10): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n))
}

/** 每轮监控的结果快照(推送渲染层展示状态;ok 时含新落盘文件) */
export interface CaptureFileMeta {
  name: string
  path: string
  bytes: number
  mtimeMs: number
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

// ---------- 截图按时间(轮次)索引 ----------

/** 按截取时间聚合的截图组:同一监控轮次的所有窗口截图共享同一时间戳 */
export interface CaptureTimeGroup {
  /** 组键:文件名内嵌的时间戳字符串(yyyyMMdd-HHmmss);解析失败回退 mtime 格式化 */
  key: string
  /** 轮次时间(毫秒) */
  at: number
  files: CaptureFileMeta[]
}

/** 截图文件名尾部的时间戳:应用_标题_yyyyMMdd-HHmmss[-N].png/jpg */
const FILE_TS_RE = /_(\d{8})-(\d{6})(?:-\d+)?\.(?:png|jpe?g)$/i

/** 从文件名解析截取时间;失败回退文件 mtime(按秒取整) */
function captureAt(file: CaptureFileMeta): { key: string; at: number } {
  const m = FILE_TS_RE.exec(file.name)
  if (m) {
    const [, d, t] = m
    const at = new Date(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
      Number(t.slice(0, 2)),
      Number(t.slice(2, 4)),
      Number(t.slice(4, 6))
    ).getTime()
    if (Number.isFinite(at)) return { key: `${d}-${t}`, at }
  }
  const ms = Math.floor(file.mtimeMs / 1000) * 1000
  const dt = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return {
    key:
      `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}` +
      `-${p(dt.getHours())}${p(dt.getMinutes())}${p(dt.getSeconds())}`,
    at: ms
  }
}

/** 截图按截取时间(轮次)分组,新→旧;组内按落盘时间倒序。纯函数,便于单测 */
export function groupCapturesByTime(files: CaptureFileMeta[]): CaptureTimeGroup[] {
  const map = new Map<string, CaptureTimeGroup>()
  for (const f of files) {
    const { key, at } = captureAt(f)
    let g = map.get(key)
    if (!g) {
      g = { key, at, files: [] }
      map.set(key, g)
    }
    g.files.push(f)
  }
  const groups = [...map.values()]
  groups.sort((a, b) => b.at - a.at)
  for (const g of groups) g.files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return groups
}

/** 截图文件基名片段清洗:去非法字符、压空白、限长度 */
export function sanitizeFilePart(s: string, maxLen = 28): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen)
}

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { clampIntervalSec, type MonitorConfig } from '@shared/types'

interface PersistedConfig {
  monitor: MonitorConfig
  /** 上次会话是否在监控中:重启后自动恢复运行 */
  monitoring: boolean
  /** 本地 HTTP API 端口(外部程序调用截图接口用);缺省 8765 */
  apiPort?: number
}

/** 外部 HTTP API 默认端口 */
export const DEFAULT_API_PORT = 8765

function defaultConfig(): PersistedConfig {
  return {
    monitor: {
      appKey: '',
      ownerName: '',
      intervalSec: 10,
      outputDir: ''
    },
    monitoring: false
  }
}

/** 配置持久化:userData/config.json,临时文件原子写入 + 防抖保存 */
export class ConfigService {
  readonly file: string
  private data: PersistedConfig
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json')
    this.data = this.load()
    console.log(`[config] loaded file=${this.file} appKey=${this.data.monitor.appKey} interval=${this.data.monitor.intervalSec}`)
  }

  /** 监控配置的输出目录:空 = 默认 ~/Pictures/screenMonitor */
  get outputDir(): string {
    return this.data.monitor.outputDir || join(homedir(), 'Pictures', 'screenMonitor')
  }

  get monitor(): MonitorConfig {
    return { ...this.data.monitor, outputDir: this.outputDir }
  }

  get monitoring(): boolean {
    return this.data.monitoring
  }

  /** HTTP API 端口:config.json 手改;非法值回退默认 */
  get apiPort(): number {
    const p = this.data.apiPort
    return typeof p === 'number' && p >= 1 && p <= 65535 ? Math.floor(p) : DEFAULT_API_PORT
  }

  /** 更新监控配置(渲染进程提交);返回归一化后的配置 */
  updateMonitor(patch: Partial<MonitorConfig>): MonitorConfig {
    const next: MonitorConfig = {
      appKey: String(patch.appKey ?? this.data.monitor.appKey).trim(),
      ownerName: String(patch.ownerName ?? this.data.monitor.ownerName).trim(),
      intervalSec: clampIntervalSec(patch.intervalSec ?? this.data.monitor.intervalSec),
      outputDir: this.outputDir
    }
    this.data.monitor = next
    this.saveSoon()
    return this.monitor
  }

  setMonitoring(running: boolean): void {
    this.data.monitoring = running
    this.saveSoon()
  }

  private load(): PersistedConfig {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<PersistedConfig>
      const fallback = defaultConfig()
      return {
        monitor: { ...fallback.monitor, ...raw.monitor },
        monitoring: raw.monitoring === true,
        apiPort: raw.apiPort
      }
    } catch {
      // 文件不存在(首次启动)或损坏:回退默认配置。损坏时保留备份便于人工恢复
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        console.error(`[config] 配置解析失败,已备份并回退默认: ${this.file}`)
      } catch {
        // 首次启动文件不存在,属正常路径
      }
      return defaultConfig()
    }
  }

  /** 立即落盘(应用退出前调用)。临时文件名带 pid+时间戳避免并发踩踏 */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[config] 保存失败:', err)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 清理失败不影响主流程
      }
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 500)
  }
}

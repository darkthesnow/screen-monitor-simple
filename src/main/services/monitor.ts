import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { IPC } from '@shared/ipc'
import type { WindowInfo } from '@shared/types'
import type { PlatformAdapter } from '../platform/types'
import type { ConfigService } from './config'
import { compressAndSave, type SaveResult } from './compress'

/** 一轮截图里成功落盘的单个文件 */
export interface RoundFile {
  path: string
  bytes: number
  format: 'png' | 'jpg'
  windowId: number
  title: string
}

/** 一轮截图的结果摘要(成功项逐个广播 evCaptureSaved,HTTP API 直接返回给调用方) */
export interface RoundSummary {
  ok: boolean
  saved: number
  failed: number
  totalWindows: number
  message: string
  files: RoundFile[]
}

/**
 * 监控调度器:按配置间隔定时执行「枚举窗口 → 过滤选定应用的全部窗口 →
 * 逐个截图压缩落盘 → 广播渲染层」。窗口 ID 在应用重启后会变,每轮重新
 * 枚举匹配(与参考实现同策略);上一轮未结束时跳过本轮,避免堆叠。
 */
export class MonitorService {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(
    private adapter: PlatformAdapter,
    private cfg: ConfigService,
    private send: (channel: string, payload: unknown) => void
  ) {}

  get running(): boolean {
    return this.timer !== null
  }

  /** 状态快照广播(渲染层初始化/每次轮次结束时刷新 UI) */
  private broadcastState(message?: string): void {
    this.send(IPC.evMonitorChanged, {
      running: this.running,
      roundAt: 0,
      message: message ?? this.lastMessage
    })
  }

  private lastMessage = '未开始'

  /** 启动监控:需已选择目标应用;立即先跑一轮再进入定时循环 */
  start(): { ok: boolean; message: string } {
    if (this.running) return { ok: true, message: '监控已在运行' }
    const { appKey, intervalSec } = this.cfg.monitor
    if (!appKey) return { ok: false, message: '请先选择要监控的应用' }
    this.cfg.setMonitoring(true)
    this.startTimer()
    this.lastMessage = `监控中 · 每 ${intervalSec} 秒一轮`
    this.broadcastState()
    void this.tick()
    return { ok: true, message: this.lastMessage }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.cfg.setMonitoring(false)
    this.lastMessage = '已停止'
    this.broadcastState()
  }

  /** 间隔/目标应用变化后调用:运行中则按新配置重启定时器 */
  restartIfRunning(): void {
    if (!this.running) return
    const { intervalSec } = this.cfg.monitor
    this.stopTimerOnly()
    this.startTimer()
    this.lastMessage = `监控中 · 每 ${intervalSec} 秒一轮`
    this.broadcastState()
  }

  /** 手动「立即截图」:与定时轮共用一条链路;执行中则拒绝 */
  async captureNow(): Promise<{ ok: boolean; message: string }> {
    const { appKey, ownerName } = this.cfg.monitor
    const summary = await this.runRound(appKey, ownerName)
    return { ok: summary.ok, message: summary.message }
  }

  /**
   * 外部(HTTP API)触发:对指定应用立即截一轮全部窗口,不改变持久化配置。
   * appKey = bundleId 或 ownerName;与定时轮共用 inFlight 串行闸。
   */
  async captureApp(appKey: string, ownerName = ''): Promise<RoundSummary> {
    return this.runRound(appKey.trim(), ownerName.trim())
  }

  private startTimer(): void {
    const intervalMs = this.cfg.monitor.intervalSec * 1000
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  private stopTimerOnly(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 定时器轮次:按当前配置执行;上一轮未完成时静默跳过 */
  private async tick(): Promise<void> {
    if (this.inFlight) return
    const { appKey, ownerName } = this.cfg.monitor
    await this.runRound(appKey, ownerName)
  }

  /**
   * 执行一轮截图(定时轮/手动/外部触发共用):inFlight 串行,同一时刻只有一轮。
   * appKey/appName 由调用方给定(配置值或外部指定),不读配置,便于 API 免改配置触发。
   */
  private async runRound(appKey: string, ownerName: string): Promise<RoundSummary> {
    if (this.inFlight) {
      return { ok: false, saved: 0, failed: 0, totalWindows: 0, message: '上一轮截图未完成,请稍候', files: [] }
    }
    this.inFlight = true
    const roundAt = Date.now()
    this.send(IPC.evMonitorChanged, {
      running: this.running,
      roundAt,
      message: `本轮截图中… (${new Date(roundAt).toLocaleTimeString()})`
    })
    try {
      if (!appKey) {
        this.lastMessage = '未选择目标应用'
        this.broadcastState()
        return { ok: false, saved: 0, failed: 0, totalWindows: 0, message: this.lastMessage, files: [] }
      }
      const windows = await this.matchAppWindows(appKey, ownerName)
      if (windows.length === 0) {
        this.lastMessage = `目标应用无可见窗口(可能已退出或最小化),继续等待`
        this.broadcastState()
        return { ok: false, saved: 0, failed: 0, totalWindows: 0, message: this.lastMessage, files: [] }
      }

      const files: RoundFile[] = []
      let failed = 0
      let firstFail = ''
      // 同轮同标题窗口计数:文件名追加序号防覆盖(如同名文档窗口)
      const titleCount = new Map<string, number>()
      for (const win of windows) {
        const key = win.title || ''
        const idx = titleCount.get(key) ?? 0
        titleCount.set(key, idx + 1)
        const result = await this.captureOne(win, roundAt, idx, windows.length)
        if (result) {
          files.push({
            path: result.path,
            bytes: result.bytes,
            format: result.format,
            windowId: win.windowId,
            title: win.title
          })
        } else {
          failed++
          if (!firstFail) firstFail = win.title || win.ownerName
        }
      }

      this.lastMessage =
        failed === 0
          ? `本轮 ${files.length}/${windows.length} 个窗口已保存 (${new Date(roundAt).toLocaleTimeString()})`
          : `本轮 ${files.length}/${windows.length} 成功,失败:${firstFail}`
      this.broadcastState()
      return {
        ok: files.length > 0,
        saved: files.length,
        failed,
        totalWindows: windows.length,
        message: this.lastMessage,
        files
      }
    } catch (err) {
      this.lastMessage = `截图轮失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[monitor] ${this.lastMessage}`)
      this.broadcastState()
      return { ok: false, saved: 0, failed: 0, totalWindows: 0, message: this.lastMessage, files: [] }
    } finally {
      this.inFlight = false
    }
  }

  /** 按应用 key 过滤窗口;key 变化(如 bundle 变更)时用 ownerName 兜底再试一次 */
  private async matchAppWindows(appKey: string, ownerName: string): Promise<WindowInfo[]> {
    const windows = await this.adapter.listWindows()
    let hit = windows.filter((w) => (w.bundleId ?? w.ownerName) === appKey)
    if (hit.length === 0 && ownerName) {
      hit = windows.filter((w) => w.ownerName === ownerName)
    }
    return hit
  }

  /** 单窗口截图:临时 PNG → 压缩落盘 → 广播;失败记日志不中断本轮其余窗口,返回落盘结果 */
  private async captureOne(
    win: WindowInfo,
    roundAt: number,
    sameTitleIndex: number,
    totalWindows: number
  ): Promise<SaveResult | null> {
    const tmpPath = join(app.getPath('temp'), `sms-${roundAt}-${win.windowId}.png`)
    try {
      await this.adapter.captureWindow(win.windowId, tmpPath)
      const result = compressAndSave(
        tmpPath,
        this.cfg.outputDir,
        win.ownerName,
        win.title,
        new Date(roundAt),
        sameTitleIndex
      )
      console.log(`[monitor] 已保存 ${result.path} (${result.bytes} 字节, ${result.width}x${result.height})`)
      this.send(IPC.evCaptureSaved, {
        path: result.path,
        bytes: result.bytes,
        at: roundAt,
        totalWindows
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[monitor] 窗口 ${win.windowId}(${win.title || win.ownerName}) 截图失败: ${msg}`)
      return null
    } finally {
      rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

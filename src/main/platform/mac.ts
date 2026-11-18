import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, desktopCapturer, screen } from 'electron'
import type { PermissionState, WindowInfo } from '@shared/types'
import { PlatformError, type PlatformAdapter } from './types'
import { FrameCaptureHost } from '../services/framecapture'

interface HelperWindow {
  windowId: number
  title: string
  ownerName: string
  bundleId: string | null
  pid: number
  x: number
  y: number
  width: number
  height: number
}

interface HelperListResult {
  windows: HelperWindow[]
  titlesAvailable: boolean
}

type HelperErrorResult = { error: string; detail?: string }

/** Promise 超时包装:败方拒绝已兜底,不会产生未处理拒绝 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new PlatformError('timeout', message)), ms)
  )
  timeout.catch(() => {})
  return Promise.race([p, timeout])
}

/** PNG IHDR 宽高(大端,偏移 16/20):视频流导出的 buffer 没有附带尺寸,直接解析 */
function pngSize(buf: Buffer): { width: number; height: number } {
  return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : { width: 0, height: 0 }
}

const HELPER_TIMEOUT_MS = 25_000

/** desktopCapturer 单次获取的兜底超时 */
const CAPTURE_TIMEOUT_MS = 15_000

export class MacAdapter implements PlatformAdapter {
  readonly platform = 'mac' as const

  /** 视频流取帧宿主(隐藏渲染进程):拿实时帧,替代可能滞后的缩略图 */
  private frames = new FrameCaptureHost()

  private cachedPermission: PermissionState | null = null
  private permissionCheckedAt = 0

  /** 最近一次 listWindows 的窗口框架,供 captureWindow 按原生分辨率请求缩略图 */
  private boundsCache = new Map<number, { x: number; y: number; width: number; height: number }>()

  private get helperPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'bin', 'mac-helper')
    }
    return join(app.getAppPath(), 'resources', 'bin', 'mac-helper')
  }

  private run(args: string[]): Promise<string> {
    let helperPath: string
    try {
      helperPath = this.helperPath
      accessSync(helperPath, constants.X_OK)
    } catch {
      return Promise.reject(
        new PlatformError('helper_missing', '未找到 Swift 助手,请先运行 npm run build:native')
      )
    }
    return new Promise((resolve, reject) => {
      execFile(
        helperPath,
        args,
        { timeout: HELPER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean }
            if (e.killed) {
              reject(new PlatformError('timeout', 'Swift 助手执行超时'))
            } else {
              reject(new PlatformError('capture_failed', `Swift 助手启动失败: ${e.message}`))
            }
            return
          }
          resolve(stdout.trim())
        }
      )
    })
  }

  private parse<T>(raw: string): T {
    return JSON.parse(raw) as T
  }

  async listWindows(): Promise<WindowInfo[]> {
    const raw = await this.run(['list'])
    let parsed: HelperListResult | HelperErrorResult
    try {
      parsed = this.parse<HelperListResult | HelperErrorResult>(raw)
    } catch {
      throw new PlatformError('capture_failed', `助手输出解析失败: ${raw.slice(0, 200)}`)
    }
    if ('error' in parsed) {
      throw new PlatformError('capture_failed', parsed.detail ?? parsed.error)
    }
    // 缓存权限信息:list 能跑但标题缺失意味着无屏幕录制权限
    this.cachedPermission = {
      granted: parsed.titlesAvailable,
      titlesAvailable: parsed.titlesAvailable
    }
    this.permissionCheckedAt = Date.now()
    this.boundsCache.clear()
    for (const w of parsed.windows) {
      this.boundsCache.set(w.windowId, { x: w.x, y: w.y, width: w.width, height: w.height })
    }
    return parsed.windows.map((w) => ({
      windowId: w.windowId,
      title: w.title,
      ownerName: w.ownerName,
      bundleId: w.bundleId,
      pid: w.pid,
      bounds: { x: w.x, y: w.y, width: w.width, height: w.height }
    }))
  }

  /**
   * 在 Electron 进程内截图:优先视频流取帧(FrameCaptureHost,实时画面),
   * 失败时回退 desktopCapturer 缩略图(可能取到旧帧,见 FrameCaptureHost 注释)。
   * 不走 mac-helper 子进程截图:macOS 26 的新屏幕录制授权不跟随责任链传给
   * CLI 子进程,helper 里的 SCShareableContent 会永久挂起;而 Electron 自身
   * 作为已授权 App,进程内调用正常。helper 仅保留 list/permission。
   */
  async captureWindow(windowId: number, outputPngPath: string): Promise<{ width: number; height: number }> {
    // 目标物理像素:按窗口所在显示器缩放,避免默认小图;无缓存时退化为 4K 上限
    const bounds = this.boundsCache.get(windowId)
    const scaleFactor = bounds ? screen.getDisplayMatching(bounds).scaleFactor || 2 : 2
    const width = Math.min(5120, Math.ceil((bounds?.width ?? 1920) * scaleFactor))
    const height = Math.min(2880, Math.ceil((bounds?.height ?? 1080) * scaleFactor))

    // 源枚举只要 ID:1×1 缩略图几乎零开销
    const sources = await withTimeout(
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } }),
      CAPTURE_TIMEOUT_MS,
      'desktopCapturer 枚举窗口源超时'
    )
    // macOS 下窗口源 id 形如 "window:<CGWindowID>:0",与 helper list 的 windowId 同源
    const source = sources.find((s) => {
      const parts = s.id.split(':')
      return parts[0] === 'window' && Number(parts[1]) === windowId
    })
    if (!source) {
      throw new PlatformError('window_not_found', '窗口不存在或已最小化')
    }

    try {
      const png = await this.frames.capture(source.id, width, height)
      if (png.byteLength === 0) {
        throw new PlatformError('permission_denied', '视频流返回空画面(通常为未授予屏幕录制权限)')
      }
      await writeFile(outputPngPath, png)
      return pngSize(png)
    } catch (err) {
      // 回退缩略图:保住可用性,但缩略图可能是旧帧
      console.warn(
        `[mac] 视频流取帧失败,回退缩略图(可能取到旧帧):`,
        err instanceof Error ? err.message : err
      )
      const big = await withTimeout(
        desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } }),
        CAPTURE_TIMEOUT_MS,
        'desktopCapturer 获取窗口源超时'
      )
      const fallback = big.find((s) => {
        const parts = s.id.split(':')
        return parts[0] === 'window' && Number(parts[1]) === windowId
      })
      if (!fallback) {
        throw new PlatformError('window_not_found', '窗口不存在或已最小化')
      }
      const png = fallback.thumbnail.toPNG()
      const size = fallback.thumbnail.getSize()
      if (png.byteLength === 0 || size.width === 0 || size.height === 0) {
        throw new PlatformError('permission_denied', 'desktopCapturer 返回空缩略图(通常为未授予屏幕录制权限)')
      }
      await writeFile(outputPngPath, png)
      return size
    }
  }

  async checkPermission(): Promise<PermissionState> {
    // 30 秒内复用缓存,避免高频调用
    if (this.cachedPermission && Date.now() - this.permissionCheckedAt < 30_000) {
      return this.cachedPermission
    }
    const raw = await this.run(['permission'])
    try {
      const parsed = this.parse<{ granted: boolean }>(raw)
      const state: PermissionState = { granted: parsed.granted, titlesAvailable: parsed.granted }
      this.cachedPermission = state
      this.permissionCheckedAt = Date.now()
      return state
    } catch {
      throw new PlatformError('capture_failed', `助手输出解析失败: ${raw.slice(0, 200)}`)
    }
  }
}

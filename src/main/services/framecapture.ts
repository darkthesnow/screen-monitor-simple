import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { PlatformError } from '../platform/types'

/**
 * 隐藏渲染进程取帧宿主:desktopCapturer 的缩略图是窗口「最后一次合成」的帧,
 * 窗口不在前台空间/被遮挡时 macOS 不为它重绘,缩略图会长期停留在同一张旧帧
 * (实测可旧十几分钟)。这里改为对目标窗口建一次 getUserMedia 桌面窗口流
 * (底层 SCStream):流会强制窗口服务合成当前内容,等到首帧后画到 canvas 导出
 * PNG,必然是实时画面。取完即关流;隐藏窗口常驻复用,首次截图时才创建。
 */

/** 渲染侧取帧脚本:建流 → 等首帧 → 画布导出 PNG dataURL;流在 finally 里关闭 */
const CAPTURE_SCRIPT = `(async (sourceId, width, height) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minWidth: width, maxWidth: width,
        minHeight: height, maxHeight: height
      }
    }
  })
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    await new Promise((resolve) => {
      let settled = false
      const done = () => { if (!settled) { settled = true; resolve(null) } }
      // 首帧到达即取;requestVideoFrameCallback 不可用或迟迟不来时定时兜底
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(done)
      setTimeout(done, 2500)
    })
    const w = video.videoWidth || width
    const h = video.videoHeight || height
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(video, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } finally {
    for (const t of stream.getTracks()) t.stop()
  }
})`

/** 单次取帧整体上限:流建立 + 首帧 + 编码传输 */
const CAPTURE_TIMEOUT_MS = 15_000

/**
 * 取帧宿主重建周期:canvas/视频纹理在渲染进程里只分配不归还,RSS 高水位随
 * 截图次数单调爬升。活满 2 小时即销毁、下次取帧重建,把水位定期清零;
 * 销毁恰好撞上取帧中的极端情形本轮报错、下一轮自愈。
 */
const HOST_TTL_MS = 2 * 60 * 60 * 1000

export class FrameCaptureHost {
  private win: BrowserWindow | null = null
  private winAt = 0
  private loading: Promise<BrowserWindow> | null = null

  /** 隐藏窗口懒创建:BrowserWindow 须在 app ready 之后创建,不能随适配器构造 */
  private async ensure(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) {
      if (Date.now() - this.winAt < HOST_TTL_MS) return this.win
      this.win.destroy() // 到期强毁:隐藏工具窗口,无待保存状态可丢
      this.win = null
    }
    if (!this.loading) {
      this.loading = this.create().finally(() => {
        this.loading = null
      })
    }
    return this.loading
  }

  private async create(): Promise<BrowserWindow> {
    // 独立 partition:media 权限只放开给这个隐藏窗口,不影响应用主窗口
    const partition = session.fromPartition('frame-capture')
    partition.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
    // 宿主页写到 userData:免打包资源,dev 与安装包行为一致
    const html = join(app.getPath('userData'), 'frame-capture.html')
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><body>', 'utf-8')
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: 'frame-capture',
        backgroundThrottling: false, // 隐藏窗口不被节流,视频帧回调按时到达
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    await win.loadFile(html)
    this.win = win
    this.winAt = Date.now()
    return win
  }

  /** 对指定窗口源取一帧实时画面;sourceId 来自 desktopCapturer(形如 "window:<id>:0") */
  async capture(sourceId: string, width: number, height: number): Promise<Buffer> {
    const win = await this.ensure()
    const js = `${CAPTURE_SCRIPT}(${JSON.stringify(sourceId)}, ${Math.round(width)}, ${Math.round(height)})`
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError('timeout', '窗口视频流取帧超时')), CAPTURE_TIMEOUT_MS)
    })
    timeout.catch(() => {}) // 竞速败方兜底,避免未处理的拒绝告警
    try {
      const dataUrl = await Promise.race([win.webContents.executeJavaScript(js, false), timeout])
      const prefix = 'data:image/png;base64,'
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
        throw new PlatformError('capture_failed', '窗口视频流未返回有效画面')
      }
      return Buffer.from(dataUrl.slice(prefix.length), 'base64')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

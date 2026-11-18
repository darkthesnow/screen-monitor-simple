import { BrowserWindow, app, protocol } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { MacAdapter } from './platform/mac'
import { ConfigService } from './services/config'
import { MonitorService } from './services/monitor'
import { ApiServer } from './services/apiserver'
import { compressAndSave } from './services/compress'
import { registerIpc, readAllowedImage } from './ipc'

// shot:// 协议:渲染进程加载本地截图(仅放行输出目录内的图片)
protocol.registerSchemesAsPrivileged([
  { scheme: 'shot', privileges: { standard: true, supportFetchAPI: true, stream: true } }
])

// 单实例锁:config.json 不支持多进程并发写,第二实例启动时聚焦已有窗口后退出
if (!app.requestSingleInstanceLock()) {
  console.log('[main] 已有实例在运行,本次启动退出')
  app.quit()
}

let mainWindow: BrowserWindow | null = null

const adapter = new MacAdapter()

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: '屏幕监控',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 拖入文件等引起的窗口导航一律拒绝(否则整个界面会被拖入的文件替换);
  // 同址导航(页面 reload / 开发模式热更新)放行
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/** 退出前落盘用的主进程配置引用 */
let cfgRef: ConfigService | null = null
let apiRef: ApiServer | null = null

/**
 * dev 冒烟验证(SMOKE=1 npm run dev):不建主窗口,直接跑完整截图链路
 * 枚举 → 截最大窗口 → 压缩落盘 → 打印路径退出。用于无人工交互验证权限与管线。
 */
async function runSmokeTest(cfg: ConfigService): Promise<never> {
  try {
    const windows = await adapter.listWindows()
    console.log(`[smoke] 枚举到 ${windows.length} 个可见窗口`)
    const target = [...windows].sort(
      (a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height
    )[0]
    if (!target) throw new Error('没有可截取的窗口')
    console.log(`[smoke] 目标: ${target.ownerName} - ${target.title || '(无标题)'} #${target.windowId}`)
    const tmp = join(app.getPath('temp'), `smoke-${Date.now()}.png`)
    await adapter.captureWindow(target.windowId, tmp)
    const result = compressAndSave(tmp, cfg.outputDir, target.ownerName, target.title)
    console.log(`[smoke] OK 已保存 ${result.path} (${result.bytes} 字节, ${result.width}x${result.height}, ${result.format})`)
    app.exit(0)
    process.exit(0)
  } catch (err) {
    console.error(`[smoke] FAIL:`, err instanceof Error ? err.message : err)
    app.exit(1)
    process.exit(1)
  }
}

app.whenReady().then(async () => {
  const cfg = new ConfigService()
  cfgRef = cfg
  const monitor = new MonitorService(adapter, cfg, sendToRenderer)

  registerIpc({
    adapter,
    cfg,
    monitor,
    getMainWindow: () => mainWindow
  })

  // 本地 HTTP API:外部程序主动调用截图/查询(仅绑定 127.0.0.1)
  const api = new ApiServer({ adapter, cfg, monitor })
  api.start(cfg.apiPort)
  apiRef = api

  // shot://p/<encodeURIComponent(绝对路径)>
  protocol.handle('shot', (request) => {
    const url = new URL(request.url)
    const payload = url.pathname.replace(/^\/p\//, '')
    return readAllowedImage(payload, cfg.outputDir).then((result) => {
      if (!result) {
        return new Response('forbidden', { status: 403 })
      }
      return new Response(new Uint8Array(result.data), {
        headers: { 'content-type': result.mime, 'cache-control': 'no-cache' }
      })
    })
  })

  // 冒烟模式:验证完直接退出,不进入 GUI
  if (process.env.SMOKE === '1') {
    await runSmokeTest(cfg)
    return
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else mainWindow?.show()
  })

  // 第二实例启动时把主窗口带到前台(单实例锁的配套)
  app.on('second-instance', () => {
    if (!mainWindow) createMainWindow()
    else {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 上次会话在监控中:恢复运行(目标应用已不可见时每轮空转等待,不报错)
  if (cfg.monitoring && cfg.monitor.appKey) {
    const started = monitor.start()
    console.log(`[main] 恢复监控: ${started.message}`)
  }
})

app.on('before-quit', () => {
  apiRef?.stop()
  // 退出前立即落盘,避免防抖中的最后一次写入丢失
  cfgRef?.flush()
})

app.on('window-all-closed', () => {
  // 简化版无托盘:所有窗口关闭即退出(监控随进程结束)
  app.quit()
})

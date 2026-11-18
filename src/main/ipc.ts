import { readdirSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { groupByApp, type AppGroup, type CaptureFileMeta, type MonitorConfig, type WindowInfo } from '@shared/types'
import type { PlatformAdapter } from './platform/types'
import type { ConfigService } from './services/config'
import type { MonitorService } from './services/monitor'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg'])
const MAX_LIST = 300

export interface IpcContext {
  adapter: PlatformAdapter
  cfg: ConfigService
  monitor: MonitorService
  getMainWindow: () => BrowserWindow | null
}

/** 列出目录下的截图文件,按修改时间倒序(新→旧),超量截断(IPC 与 HTTP API 共用) */
export function listCaptures(dir: string): CaptureFileMeta[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const metas: CaptureFileMeta[] = []
  for (const name of names) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      metas.push({ name, path: full, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // 文件被并发删除时跳过
    }
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return metas.slice(0, MAX_LIST)
}

/** 校验路径在输出目录内且为图片文件,防止渲染进程越权读写 */
export function safeImagePath(p: string, root: string): string | null {
  if (!isAbsolute(p)) return null
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
  if (!(ext in IMAGE_MIME)) return null
  const abs = resolve(p)
  const rel = relative(resolve(root), abs)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return abs
  return null
}

/** shot:// 协议加载图片用:只放行输出目录内的图片文件 */
export async function readAllowedImage(urlPath: string, root: string): Promise<{ data: Buffer; mime: string } | null> {
  const safe = safeImagePath(decodeURIComponent(urlPath), root)
  if (!safe) return null
  try {
    const st = await stat(safe)
    if (!st.isFile() || st.size > 30 * 1024 * 1024) return null
    const ext = safe.slice(safe.lastIndexOf('.')).toLowerCase()
    return { data: await readFile(safe), mime: IMAGE_MIME[ext] }
  } catch {
    return null
  }
}

export function registerIpc(ctx: IpcContext): void {
  const { adapter, cfg, monitor } = ctx

  // ---------- 窗口(需求1:选择 app 的数据源) ----------

  ipcMain.handle(IPC.windowsList, async (): Promise<{ windows: WindowInfo[]; groups: AppGroup[] }> => {
    const windows = await adapter.listWindows()
    return { windows, groups: groupByApp(windows) }
  })

  // ---------- 系统权限 ----------

  ipcMain.handle(IPC.permissionState, () => adapter.checkPermission())

  ipcMain.handle(IPC.openPermissionSettings, async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
      return true
    }
    return false
  })

  ipcMain.handle(IPC.selectDirectory, async () => {
    const win = ctx.getMainWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择截图保存目录'
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---------- 监控配置(需求3:可改频率,保存即生效) ----------

  ipcMain.handle(IPC.monitorConfigGet, (): MonitorConfig & { running: boolean } => ({
    ...cfg.monitor,
    running: monitor.running
  }))

  ipcMain.handle(IPC.monitorConfigSet, (_e, patch: Partial<MonitorConfig>) => {
    const monitor2 = cfg.updateMonitor(patch)
    // 间隔或目标应用变化后,运行中的定时器按新配置重启
    monitor.restartIfRunning()
    return { ok: true as const, config: monitor2 }
  })

  // ---------- 监控启停与手动触发(需求4) ----------

  ipcMain.handle(IPC.monitorStart, () => monitor.start())

  ipcMain.handle(IPC.monitorStop, () => {
    monitor.stop()
    return { ok: true as const }
  })

  ipcMain.handle(IPC.monitorState, () => ({
    running: monitor.running
  }))

  ipcMain.handle(IPC.monitorCaptureNow, () => monitor.captureNow())

  // ---------- 截图库(需求5:预览数据源) ----------

  ipcMain.handle(IPC.galleryList, () => listCaptures(cfg.outputDir))

  ipcMain.handle(IPC.galleryDelete, (_e, path: string) => {
    const safe = safeImagePath(path, cfg.outputDir)
    if (!safe) return { ok: false as const, message: '路径不在输出目录内' }
    try {
      rmSync(safe, { force: true })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.galleryReveal, (_e, path: string) => {
    const safe = safeImagePath(path, cfg.outputDir)
    if (!safe) return { ok: false as const, message: '路径不在输出目录内' }
    shell.showItemInFolder(safe)
    return { ok: true as const }
  })
}

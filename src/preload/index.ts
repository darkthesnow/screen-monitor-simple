import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppGroup, CaptureFileMeta, MonitorConfig, PermissionState, WindowInfo } from '@shared/types'

type MonitorStartResult = { ok: boolean; message: string }

const api = {
  platform: process.platform,

  windows: {
    /** 枚举当前可见窗口并按应用聚合(需求1:选择 app) */
    list: (): Promise<{ windows: WindowInfo[]; groups: AppGroup[] }> => ipcRenderer.invoke(IPC.windowsList)
  },

  system: {
    permissionState: (): Promise<PermissionState> => ipcRenderer.invoke(IPC.permissionState),
    openPermissionSettings: (): Promise<boolean> => ipcRenderer.invoke(IPC.openPermissionSettings),
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectDirectory)
  },

  monitor: {
    config: (): Promise<MonitorConfig & { running: boolean }> => ipcRenderer.invoke(IPC.monitorConfigGet),
    /** 保存配置(应用/频率/输出目录);监控运行中立即生效 */
    setConfig: (patch: Partial<MonitorConfig>): Promise<{ ok: boolean; config: MonitorConfig }> =>
      ipcRenderer.invoke(IPC.monitorConfigSet, patch),
    start: (): Promise<MonitorStartResult> => ipcRenderer.invoke(IPC.monitorStart),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.monitorStop),
    state: (): Promise<{ running: boolean }> => ipcRenderer.invoke(IPC.monitorState),
    /** 立即截一轮(不等定时器) */
    captureNow: (): Promise<MonitorStartResult> => ipcRenderer.invoke(IPC.monitorCaptureNow)
  },

  gallery: {
    /** 输出目录内的截图列表,新→旧 */
    list: (): Promise<CaptureFileMeta[]> => ipcRenderer.invoke(IPC.galleryList),
    delete: (path: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke(IPC.galleryDelete, path),
    reveal: (path: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke(IPC.galleryReveal, path)
  },

  /** 截图文件在渲染进程中的可访问 URL(shot:// 协议,主进程校验路径) */
  imageUrl: (path: string): string => `shot://p/${encodeURIComponent(path)}`,

  onMonitorChanged(cb: (payload: { running: boolean; roundAt: number; message: string }) => void): () => void {
    const listener = (_e: unknown, payload: { running: boolean; roundAt: number; message: string }): void => cb(payload)
    ipcRenderer.on(IPC.evMonitorChanged, listener)
    return () => ipcRenderer.removeListener(IPC.evMonitorChanged, listener)
  },

  onCaptureSaved(
    cb: (payload: { path: string; bytes: number; at: number; totalWindows: number }) => void
  ): () => void {
    const listener = (
      _e: unknown,
      payload: { path: string; bytes: number; at: number; totalWindows: number }
    ): void => cb(payload)
    ipcRenderer.on(IPC.evCaptureSaved, listener)
    return () => ipcRenderer.removeListener(IPC.evCaptureSaved, listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)

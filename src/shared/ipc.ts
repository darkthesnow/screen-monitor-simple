// IPC 通道契约:主进程 handler、preload 转发、渲染进程调用三方共用

import type { CaptureFileMeta } from './types'

export const IPC = {
  windowsList: 'windows:list',
  permissionState: 'system:permission-state',
  openPermissionSettings: 'system:open-permission-settings',
  selectDirectory: 'system:select-directory',
  monitorConfigGet: 'monitor:config-get',
  monitorConfigSet: 'monitor:config-set',
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  monitorState: 'monitor:state-get',
  monitorCaptureNow: 'monitor:capture-now',
  galleryList: 'gallery:list',
  galleryDelete: 'gallery:delete',
  galleryReveal: 'gallery:reveal',
  // 主进程 → 渲染进程 事件
  evMonitorChanged: 'events:monitor-changed',
  evCaptureSaved: 'events:capture-saved'
} as const

export interface EvMonitorChanged {
  running: boolean
  /** 本轮开始时间(毫秒);0 = 空闲 */
  roundAt: number
  message: string
}

export interface EvCaptureSaved {
  path: string
  bytes: number
  at: number
  /** 本轮该应用命中的窗口数(含失败),便于展示"本轮 N 个窗口" */
  totalWindows: number
}

export type { CaptureFileMeta }

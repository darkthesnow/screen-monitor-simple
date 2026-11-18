import type { PermissionState, WindowInfo } from '@shared/types'

export type PlatformErrorCode =
  | 'permission_denied'
  | 'window_not_found'
  | 'helper_missing'
  | 'timeout'
  | 'capture_failed'

export class PlatformError extends Error {
  constructor(
    public readonly code: PlatformErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}

/**
 * 平台适配器统一契约(简化版仅实现 macOS)。
 *
 * Windows 预留说明(对齐 mac-helper 的 JSON 契约):
 * - listWindows:EnumWindows 过滤 IsWindowVisible,返回 HWND、标题、进程名、边界
 * - captureWindow:PrintWindow 或 Windows.Graphics.Capture
 * - checkPermission:Windows 无需屏幕录制权限,直接 granted: true
 */
export interface PlatformAdapter {
  /** 列出当前可见(未最小化、layer 0)的窗口 */
  listWindows(): Promise<WindowInfo[]>
  /**
   * 按窗口 ID 截图,输出原生分辨率 PNG 到指定路径。
   * 可截取被遮挡窗口;最小化窗口按 window_not_found 处理
   */
  captureWindow(windowId: number, outputPngPath: string): Promise<{ width: number; height: number }>
  checkPermission(): Promise<PermissionState>
}

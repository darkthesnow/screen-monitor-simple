// mac-helper: 简化版屏幕监控的 macOS 原生助手
//
// 子命令:
//   permission   → {"granted":bool} 检查屏幕录制权限(不弹窗)
//   list         → {"windows":[...]} 当前可见窗口列表
//
// 设计约束:
// - 窗口枚举用 CGWindowListCopyWindowInfo(未废弃);截图在 Electron 进程内
//   走 desktopCapturer,不经本助手(macOS 26 新授权不传给 CLI 子进程)
// - 所有输出为单行 JSON(stdout),错误时 exit code != 0 并输出 {"error":"..."}
// - 最低支持 macOS 14.0

import Foundation
import CoreGraphics
import AppKit

struct WindowEntry: Codable {
    let windowId: Int
    let title: String
    let ownerName: String
    let bundleId: String?
    let pid: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

// 无权限时窗口标题会被系统抹掉,但仍可列出窗口框架
struct ListOk: Codable {
    let windows: [WindowEntry]
    let titlesAvailable: Bool
}

func output<T: Codable>(_ value: T) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(value) {
        FileHandle.standardOutput.write(data)
    }
    print("")
}

func fail(_ error: String, _ detail: String? = nil, _ code: Int32 = 1) -> Never {
    var obj: [String: String] = ["error": error]
    if let detail { obj["detail"] = detail }
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(data)
    }
    print("")
    exit(code)
}

// MARK: - list

func listWindows() {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        fail("list_failed", "CGWindowListCopyWindowInfo 返回空")
    }

    let myPid = ProcessInfo.processInfo.processIdentifier
    let excludedOwners: Set<String> = ["Dock", "Window Server", "WindowManager"]
    // 无权限时 kCGWindowName 键缺失,据此判断权限状态
    var sawTitleKey = false
    var windows: [WindowEntry] = []

    for info in raw {
        guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != myPid else { continue }
        guard let owner = info[kCGWindowOwnerName as String] as? String else { continue }
        if excludedOwners.contains(owner) { continue }
        guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let w = bounds["Width"] as? Double,
              let h = bounds["Height"] as? Double,
              w >= 40, h >= 40 else { continue }

        let title = info[kCGWindowName as String] as? String ?? ""
        if info[kCGWindowName as String] != nil { sawTitleKey = true }

        let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        // AppleScript/Terminal 等无 bundle 的进程 bundleId 为 nil,分组时降级为 ownerName
        windows.append(WindowEntry(
            windowId: Int(info[kCGWindowNumber as String] as? Int32 ?? 0),
            title: title,
            ownerName: owner,
            bundleId: bundleId,
            pid: Int(pid),
            x: bounds["X"] as? Double ?? 0,
            y: bounds["Y"] as? Double ?? 0,
            width: w,
            height: h
        ))
    }
    output(ListOk(windows: windows, titlesAvailable: sawTitleKey))
}

// MARK: - main

var args = Array(CommandLine.arguments.dropFirst())
guard let sub = args.first else {
    fail("usage", "用法: mac-helper permission | list")
}

switch sub {
case "permission":
    let granted = CGPreflightScreenCaptureAccess()
    output(["granted": granted])
case "list":
    listWindows()
default:
    fail("usage", "未知子命令: \(sub)")
}

import AppKit
import Darwin

// A regular app + menu-bar controller. Keeping a Dock icon makes first launch
// discoverable for non-technical users; the actual controls remain in the menu bar.
let app = NSApplication.shared
app.setActivationPolicy(.regular)

// Single-instance guard: a login item plus a manual launch could otherwise put two
// icons in the menu bar. Unlike the previous silent exit, show an explicit message
// when the app is already running so a second Finder/Launchpad click never looks hung.
let lockDir = NSHomeDirectory() + "/.cxx/remote"
try? FileManager.default.createDirectory(atPath: lockDir, withIntermediateDirectories: true)
let lockFd = open(lockDir + "/menu.lock", O_CREAT | O_RDWR, 0o644)
if lockFd < 0 || flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = cxxIsChineseUI ? "口袋Agent已在运行" : "Pocket Agent is already running"
    alert.informativeText = cxxIsChineseUI
        ? "请点击 Dock 中的口袋Agent图标，或查看屏幕顶部右侧菜单栏图标。"
        : "Click Pocket Agent in the Dock, or use its menu bar icon at the top-right of the screen."
    alert.addButton(withTitle: cxxIsChineseUI ? "知道了" : "Got it")
    alert.runModal()
    exit(0)
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()

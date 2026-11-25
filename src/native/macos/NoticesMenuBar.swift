import AppKit
import Foundation

struct MiniConfig: Decodable {
    let enabled: Bool?
    let dnd: Bool?
    let dndUntil: String?
    let popup: MiniPopup?
    let ui: MiniUI?
}

struct MiniPopup: Decodable {
    let style: String?
    let cardVariant: String?
}

struct MiniUI: Decodable {
    let port: Int?
}

struct MiniState: Decodable {
    let unreadCount: Int?
}

struct MiniFocusTarget: Decodable {
    let appName: String?
    let bundleId: String?
    let windowHint: String?
}

struct MiniHistoryItem: Decodable {
    let id: String?
    let timestamp: String?
    let agent: String?
    let agentLabel: String?
    let kind: String?
    let title: String?
    let message: String?
    let project: String?
    let durationMs: Double?
    let focusTarget: MiniFocusTarget?
}

@MainActor
final class MenuBarAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private let cliPath: String
    private let nodePath: String
    private let dataDir: String
    private var lockFd: Int32 = -1
    private var historyCache: [MiniHistoryItem] = []

    init(cliPath: String, nodePath: String, dataDir: String) {
        self.cliPath = cliPath
        self.nodePath = nodePath
        self.dataDir = dataDir
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !acquireSingleInstanceLock() {
            fputs("NoticesMenuBar is already running.\n", stderr)
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        refreshStatusBarIcon()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshStatusBarIcon()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if lockFd >= 0 {
            flock(lockFd, LOCK_UN)
            close(lockFd)
        }
    }

    private func acquireSingleInstanceLock() -> Bool {
        let lockPath = "/tmp/agent-notices-menubar.lock"
        let fd = open(lockPath, O_CREAT | O_RDWR, 0o644)
        if fd < 0 { return true }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return false
        }
        lockFd = fd
        return true
    }

    private func readConfig() -> MiniConfig? {
        let path = "\(dataDir)/config.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(MiniConfig.self, from: data)
    }

    private func readUnreadCount() -> Int {
        let path = "\(dataDir)/state.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let state = try? JSONDecoder().decode(MiniState.self, from: data) else {
            return 0
        }
        return max(0, state.unreadCount ?? 0)
    }

    private func readRecentHistory(limit: Int = 8) -> [MiniHistoryItem] {
        let path = "\(dataDir)/history.jsonl"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        let lines = text.split(separator: "\n")
        var items: [MiniHistoryItem] = []
        let decoder = JSONDecoder()
        for line in lines.reversed() {
            if let data = line.data(using: .utf8),
               let item = try? decoder.decode(MiniHistoryItem.self, from: data) {
                items.append(item)
                if items.count >= limit { break }
            }
        }
        return items
    }

    private func isDnd(_ cfg: MiniConfig?) -> Bool {
        guard let cfg else { return false }
        if cfg.enabled == false { return true }
        if cfg.dnd == true { return true }
        if let untilStr = cfg.dndUntil, !untilStr.isEmpty {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: untilStr) ?? ISO8601DateFormatter().date(from: untilStr) {
                return date > Date()
            }
        }
        return false
    }

    private func refreshStatusBarIcon() {
        guard let button = statusItem.button else { return }
        let cfg = readConfig()
        let dnd = isDnd(cfg)
        let unread = readUnreadCount()

        let symName: String
        if dnd {
            symName = "bell.slash"
        } else if unread > 0 {
            symName = "bell.badge.fill"
        } else {
            symName = "bell.fill"
        }

        if let img = NSImage(systemSymbolName: symName, accessibilityDescription: "AgentNotices") {
            img.isTemplate = true
            button.image = img
        }
        button.title = (!dnd && unread > 0) ? " \(unread)" : ""
        button.toolTip = dnd ? "AgentNotices · 免打扰已开启" : "AgentNotices · 未读提醒 \(unread) 条"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let cfg = readConfig()
        let dnd = isDnd(cfg)
        let unread = readUnreadCount()
        let curStyle = cfg?.popup?.style ?? "card"
        let curVariant = cfg?.popup?.cardVariant ?? "pill"

        // Header
        let headerTitle = dnd ? "AgentNotices · 免打扰中" : "AgentNotices · 监听中"
        let headerItem = NSMenuItem(title: headerTitle, action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(NSMenuItem.separator())

        // DND controls
        if dnd {
            let resume = NSMenuItem(title: "恢复提醒", action: #selector(handleResumeDnd), keyEquivalent: "r")
            resume.target = self
            menu.addItem(resume)
        } else {
            let pause30 = NSMenuItem(title: "静音 30 分钟", action: #selector(handlePause30), keyEquivalent: "")
            pause30.target = self
            menu.addItem(pause30)

            let dndOn = NSMenuItem(title: "开启免打扰", action: #selector(handleEnableDnd), keyEquivalent: "d")
            dndOn.target = self
            menu.addItem(dndOn)
        }

        // Popup style submenu
        let styleItem = NSMenuItem(title: "默认弹窗形态", action: nil, keyEquivalent: "")
        let styleMenu = NSMenu()
        let styles: [(String, String)] = [
            ("card", "角落悬浮卡片 (Card)"),
            ("modal", "屏幕居中强提醒 (Modal)"),
            ("banner", "顶部灵动横幅 (Banner)"),
        ]
        for (val, label) in styles {
            let item = NSMenuItem(title: label, action: #selector(handleSwitchStyle(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = val
            item.state = curStyle == val ? .on : .off
            styleMenu.addItem(item)
        }
        styleItem.submenu = styleMenu
        menu.addItem(styleItem)

        // Card appearance variant submenu
        let variantItem = NSMenuItem(title: "卡片视觉样式", action: nil, keyEquivalent: "")
        let variantMenu = NSMenu()
        let variants: [(String, String)] = [
            ("pill", "紧凑灵动胶囊卡 (默认)"),
            ("glass", "Apple 液态玻璃"),
        ]
        for (val, label) in variants {
            let item = NSMenuItem(title: label, action: #selector(handleSwitchVariant(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = val
            item.state = curVariant == val ? .on : .off
            variantMenu.addItem(item)
        }
        variantItem.submenu = variantMenu
        menu.addItem(variantItem)

        menu.addItem(NSMenuItem.separator())

        // Recent history
        historyCache = readRecentHistory(limit: 8)
        let histHeader = NSMenuItem(title: "最近完成记录 (\(historyCache.count))", action: nil, keyEquivalent: "")
        histHeader.isEnabled = false
        menu.addItem(histHeader)

        if historyCache.isEmpty {
            let emptyItem = NSMenuItem(title: "  暂无提醒记录", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            menu.addItem(emptyItem)
        } else {
            for (idx, item) in historyCache.enumerated() {
                let icon = item.kind == "error" ? "✕" : item.kind == "attention" ? "⚠" : "✓"
                let proj = item.project ?? "Workspace"
                let title = item.title ?? "任务完成"
                let dur = formatDuration(item.durationMs)
                let label = dur.isEmpty ? "  \(icon) [\(proj)] \(title)" : "  \(icon) [\(proj)] \(title) · \(dur)"
                let row = NSMenuItem(title: label, action: #selector(handleHistoryClick(_:)), keyEquivalent: "")
                row.target = self
                row.tag = idx
                row.toolTip = item.message
                menu.addItem(row)
            }
            if unread > 0 {
                let clearUnread = NSMenuItem(title: "全部标为已读", action: #selector(handleMarkAllRead), keyEquivalent: "")
                clearUnread.target = self
                menu.addItem(clearUnread)
            }
        }

        menu.addItem(NSMenuItem.separator())

        let testCard = NSMenuItem(title: "发送测试弹窗", action: #selector(handleTestPopup), keyEquivalent: "t")
        testCard.target = self
        menu.addItem(testCard)

        let openUi = NSMenuItem(title: "打开 Web 配置控制台…", action: #selector(handleOpenWebUI), keyEquivalent: ",")
        openUi.target = self
        menu.addItem(openUi)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "退出菜单栏助手", action: #selector(handleQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    private func formatDuration(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let sec = Int(round(ms / 1000.0))
        if sec < 60 { return "\(sec)s" }
        let min = sec / 60
        let rem = sec % 60
        return rem > 0 ? "\(min)m \(rem)s" : "\(min)m"
    }

    private func runCLI(_ args: [String]) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [cliPath] + args
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try? proc.run()
    }

    @objc private func handleResumeDnd() {
        runCLI(["dnd", "off"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.refreshStatusBarIcon()
        }
    }

    @objc private func handlePause30() {
        runCLI(["dnd", "--minutes", "30"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.refreshStatusBarIcon()
        }
    }

    @objc private func handleEnableDnd() {
        runCLI(["dnd", "on"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.refreshStatusBarIcon()
        }
    }

    @objc private func handleSwitchStyle(_ sender: NSMenuItem) {
        guard let style = sender.representedObject as? String else { return }
        runCLI(["config", "set", "popup.style", style])
    }

    @objc private func handleSwitchVariant(_ sender: NSMenuItem) {
        guard let variant = sender.representedObject as? String else { return }
        runCLI(["config", "set", "popup.cardVariant", variant])
    }

    @objc private func handleHistoryClick(_ sender: NSMenuItem) {
        let idx = sender.tag
        guard idx >= 0 && idx < historyCache.count else { return }
        let item = historyCache[idx]
        runCLI(["history", "read-all"])
        if let bundleId = item.focusTarget?.bundleId, !bundleId.isEmpty {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            proc.arguments = ["-b", bundleId]
            try? proc.run()
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
                _ = app.activate(options: .activateAllWindows)
            }
        } else if let appName = item.focusTarget?.appName, !appName.isEmpty {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            proc.arguments = ["-a", appName]
            try? proc.run()
            let apps = NSWorkspace.shared.runningApplications.filter {
                $0.localizedName?.caseInsensitiveCompare(appName) == .orderedSame
            }
            if let app = apps.first {
                _ = app.activate(options: .activateAllWindows)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.refreshStatusBarIcon()
        }
    }

    @objc private func handleMarkAllRead() {
        runCLI(["history", "read-all"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.refreshStatusBarIcon()
        }
    }

    @objc private func handleTestPopup() {
        runCLI(["test"])
    }

    @objc private func handleOpenWebUI() {
        let port = readConfig()?.ui?.port ?? 47890
        let urlStr = "http://127.0.0.1:\(port)"
        // Ensure UI server is running in background, then open browser
        runCLI(["ui", "--open"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if let url = URL(string: urlStr) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    @objc private func handleQuit() {
        NSApp.terminate(nil)
    }
}

func argValue(_ flag: String) -> String? {
    let args = CommandLine.arguments
    if let idx = args.firstIndex(of: flag), idx + 1 < args.count {
        return args[idx + 1]
    }
    return nil
}

let cliPath = argValue("--cli") ?? ""
let nodePath = argValue("--node") ?? "/usr/bin/env"
let defaultDataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/agent-notices").path
let dataDir = argValue("--data-dir") ?? ProcessInfo.processInfo.environment["AGENT_NOTICES_HOME"] ?? defaultDataDir

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = MenuBarAppDelegate(cliPath: cliPath, nodePath: nodePath, dataDir: dataDir)
    app.delegate = delegate
    app.run()
}

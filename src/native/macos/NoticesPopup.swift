import AppKit
import Foundation

struct PopupPayload: Decodable, Sendable {
    let id: String?
    let agent: String?
    let agentLabel: String?
    let kind: String?
    let title: String?
    let message: String?
    let project: String?
    let durationText: String?
    let style: String?
    let position: String?
    let durationSeconds: Double?
    let sticky: Bool?
    let theme: String?
    let showFocusButton: Bool?
    let showMuteButton: Bool?
    let focusAppName: String?
    let focusBundleId: String?
    let focusWindowHint: String?
    let cliPath: String?
    let nodePath: String?
}

final class SlotManager {
    private let dir = "/tmp/agent-notices-slots"
    private(set) var slotIndex: Int = 0
    private var slotFilePath: String?

    func acquire(maxSlots: Int = 5) -> Int {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)

        // Clean stale slots whose process is no longer alive
        if let files = try? fm.contentsOfDirectory(atPath: dir) {
            for f in files where f.hasPrefix("slot-") {
                let full = "\(dir)/\(f)"
                if let content = try? String(contentsOfFile: full, encoding: .utf8),
                   let pid = Int32(content.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    if kill(pid, 0) != 0 {
                        try? fm.removeItem(atPath: full)
                    }
                } else {
                    try? fm.removeItem(atPath: full)
                }
            }
        }

        let myPid = "\(ProcessInfo.processInfo.processIdentifier)"
        for idx in 0..<maxSlots {
            let path = "\(dir)/slot-\(idx).lock"
            let fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0o644)
            if fd >= 0 {
                let data = Data(myPid.utf8)
                data.withUnsafeBytes { raw in
                    if let base = raw.baseAddress {
                        _ = write(fd, base, data.count)
                    }
                }
                close(fd)
                self.slotIndex = idx
                self.slotFilePath = path
                return idx
            }
        }
        self.slotIndex = 0
        return 0
    }

    func release() {
        if let p = slotFilePath {
            try? FileManager.default.removeItem(atPath: p)
            slotFilePath = nil
        }
    }
}

final class HoverTrackingView: NSView {
    var onHoverChange: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = tracking {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        onHoverChange?(true)
    }

    override func mouseExited(with event: NSEvent) {
        onHoverChange?(false)
    }
}

final class PillButton: NSButton {
    var bgColor: NSColor = .controlAccentColor
    var fgColor: NSColor = .white
    var borderCol: NSColor? = nil
    var corner: CGFloat = 8

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: corner, yRadius: corner)
        let fill = isHighlighted ? bgColor.blended(withFraction: 0.18, of: .black) ?? bgColor : bgColor
        fill.setFill()
        path.fill()
        if let borderCol {
            borderCol.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: fgColor,
            .paragraphStyle: para,
        ]
        let size = title.size(withAttributes: attrs)
        let textRect = NSRect(
            x: 0,
            y: (bounds.height - size.height) / 2.0 - 0.5,
            width: bounds.width,
            height: size.height
        )
        title.draw(in: textRect, withAttributes: attrs)
    }
}

final class NoticePanel: NSPanel {
    var onEscape: (() -> Void)?
    var onReturn: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape
            onEscape?()
            return
        }
        if event.keyCode == 36 || event.keyCode == 76 { // Return / Enter
            onReturn?()
            return
        }
        super.keyDown(with: event)
    }
}

@MainActor
final class PopupAppDelegate: NSObject, NSApplicationDelegate {
    private let payload: PopupPayload
    private let slotManager = SlotManager()
    private var panel: NoticePanel?
    private var progressFill: NSView?
    private var progressWidthConstraint: NSLayoutConstraint?
    private var timer: Timer?
    private var totalDuration: Double = 10
    private var remaining: Double = 10
    private var isHovered: Bool = false
    private var isSticky: Bool = false
    private var isDismissing: Bool = false

    init(payload: PopupPayload) {
        self.payload = payload
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildAndShowPanel()
    }

    func applicationWillTerminate(_ notification: Notification) {
        slotManager.release()
    }

    private func accentColor(for kind: String) -> NSColor {
        switch kind {
        case "error":
            return NSColor(calibratedRed: 0.94, green: 0.27, blue: 0.27, alpha: 1.0)
        case "attention":
            return NSColor(calibratedRed: 0.96, green: 0.62, blue: 0.04, alpha: 1.0)
        case "info":
            return NSColor(calibratedRed: 0.23, green: 0.51, blue: 0.96, alpha: 1.0)
        default: // done
            return NSColor(calibratedRed: 0.13, green: 0.77, blue: 0.37, alpha: 1.0)
        }
    }

    private func symbolName(for kind: String) -> String {
        switch kind {
        case "error": return "xmark.octagon.fill"
        case "attention": return "exclamationmark.triangle.fill"
        case "info": return "bell.badge.fill"
        default: return "checkmark.circle.fill"
        }
    }

    private func activeScreen() -> NSScreen {
        let mouseLoc = NSEvent.mouseLocation
        for screen in NSScreen.screens where screen.frame.contains(mouseLoc) {
            return screen
        }
        return NSScreen.main ?? NSScreen.screens[0]
    }

    private func resolveAppearance() -> NSAppearance? {
        switch (payload.theme ?? "auto").lowercased() {
        case "dark": return NSAppearance(named: .darkAqua)
        case "light": return NSAppearance(named: .aqua)
        default: return nil
        }
    }

    private func buildAndShowPanel() {
        let style = (payload.style ?? "card").lowercased()
        let kind = (payload.kind ?? "done").lowercased()
        let accent = accentColor(for: kind)
        let titleText = payload.title ?? "会话任务已完成"
        let bodyText = payload.message ?? "任务已结束，可返回查看。"
        let agentText = (payload.agentLabel ?? payload.agent ?? "Agent").uppercased()
        let projectText = payload.project ?? "Workspace"
        let durationText = payload.durationText ?? ""
        let showFocus = (payload.showFocusButton ?? true) && !((payload.focusBundleId ?? "").isEmpty && (payload.focusAppName ?? "").isEmpty)
        let showMute = (payload.showMuteButton ?? true) && !(payload.cliPath ?? "").isEmpty

        let durationSec = payload.durationSeconds ?? 10
        self.isSticky = (payload.sticky ?? false) || durationSec <= 0
        self.totalDuration = max(3.0, durationSec)
        self.remaining = self.totalDuration

        let panelWidth: CGFloat
        let panelHeight: CGFloat
        switch style {
        case "modal":
            panelWidth = 468
            panelHeight = bodyText.count > 95 ? 248 : 220
        case "banner":
            panelWidth = 456
            panelHeight = 80
        default: // card
            panelWidth = 396
            panelHeight = bodyText.count > 90 ? 186 : 162
        }

        let styleMask: NSWindow.StyleMask = style == "modal"
            ? [.borderless, .nonactivatingPanel]
            : [.borderless, .nonactivatingPanel]

        let panel = NoticePanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = style == "modal" ? .statusBar : .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        if let appearance = resolveAppearance() {
            panel.appearance = appearance
        }
        panel.onEscape = { [weak self] in self?.dismiss() }
        panel.onReturn = { [weak self] in self?.handleFocusTap() }
        self.panel = panel

        let cornerRadius: CGFloat = style == "banner" ? 22 : (style == "modal" ? 20 : 16)

        // Root hover-tracking container
        let root = HoverTrackingView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
        root.wantsLayer = true
        root.layer?.cornerRadius = cornerRadius
        root.layer?.masksToBounds = true
        root.onHoverChange = { [weak self] hovered in
            self?.isHovered = hovered
        }

        // Frosted glass background
        let blur = NSVisualEffectView(frame: root.bounds)
        blur.autoresizingMask = [.width, .height]
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = cornerRadius
        blur.layer?.borderWidth = 1.0
        blur.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.14).cgColor
        root.addSubview(blur)

        if style == "banner" {
            buildBannerLayout(
                in: root,
                width: panelWidth,
                height: panelHeight,
                accent: accent,
                kind: kind,
                agentText: agentText,
                projectText: projectText,
                durationText: durationText,
                titleText: titleText,
                bodyText: bodyText,
                showFocus: showFocus
            )
        } else if style == "modal" {
            buildModalLayout(
                in: root,
                width: panelWidth,
                height: panelHeight,
                accent: accent,
                kind: kind,
                agentText: agentText,
                projectText: projectText,
                durationText: durationText,
                titleText: titleText,
                bodyText: bodyText,
                showFocus: showFocus,
                showMute: showMute
            )
        } else {
            buildCardLayout(
                in: root,
                width: panelWidth,
                height: panelHeight,
                accent: accent,
                kind: kind,
                agentText: agentText,
                projectText: projectText,
                durationText: durationText,
                titleText: titleText,
                bodyText: bodyText,
                showFocus: showFocus,
                showMute: showMute
            )
        }

        // Bottom countdown progress bar
        if !isSticky {
            let track = NSView()
            track.wantsLayer = true
            track.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
            track.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(track)

            let fill = NSView()
            fill.wantsLayer = true
            fill.layer?.backgroundColor = accent.withAlphaComponent(0.9).cgColor
            fill.translatesAutoresizingMaskIntoConstraints = false
            track.addSubview(fill)
            self.progressFill = fill

            let widthConstraint = fill.widthAnchor.constraint(equalToConstant: panelWidth)
            self.progressWidthConstraint = widthConstraint

            NSLayoutConstraint.activate([
                track.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                track.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                track.bottomAnchor.constraint(equalTo: root.bottomAnchor),
                track.heightAnchor.constraint(equalToConstant: 3),

                fill.leadingAnchor.constraint(equalTo: track.leadingAnchor),
                fill.topAnchor.constraint(equalTo: track.topAnchor),
                fill.bottomAnchor.constraint(equalTo: track.bottomAnchor),
                widthConstraint,
            ])
        }

        panel.contentView = root

        // Compute target frame on active screen
        let screen = activeScreen()
        let vf = screen.visibleFrame
        let pos = (payload.position ?? (style == "modal" ? "center" : style == "banner" ? "top-center" : "top-right")).lowercased()

        let targetOrigin: NSPoint
        let startOrigin: NSPoint

        if style == "modal" || pos == "center" {
            let x = vf.midX - panelWidth / 2.0
            let y = vf.midY - panelHeight / 2.0 + vf.height * 0.05
            targetOrigin = NSPoint(x: x, y: y)
            startOrigin = NSPoint(x: x, y: y - 16)
        } else if style == "banner" || pos == "top-center" {
            let slot = slotManager.acquire(maxSlots: 4)
            let x = vf.midX - panelWidth / 2.0
            let y = vf.maxY - panelHeight - 12 - CGFloat(slot) * (panelHeight + 10)
            targetOrigin = NSPoint(x: x, y: y)
            startOrigin = NSPoint(x: x, y: y + 20)
        } else if pos == "bottom-right" {
            let slot = slotManager.acquire(maxSlots: 5)
            let x = vf.maxX - panelWidth - 16
            let y = vf.minY + 16 + CGFloat(slot) * (panelHeight + 12)
            targetOrigin = NSPoint(x: x, y: y)
            startOrigin = NSPoint(x: x + 28, y: y)
        } else {
            // top-right default
            let slot = slotManager.acquire(maxSlots: 5)
            let x = vf.maxX - panelWidth - 16
            let y = vf.maxY - panelHeight - 14 - CGFloat(slot) * (panelHeight + 12)
            targetOrigin = NSPoint(x: x, y: y)
            startOrigin = NSPoint(x: x + 28, y: y)
        }

        panel.setFrameOrigin(startOrigin)
        panel.alphaValue = 0.0
        panel.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.26
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrameOrigin(targetOrigin)
            panel.animator().alphaValue = 1.0
        }

        if !isSticky {
            startCountdown(panelWidth: panelWidth)
        }
    }

    private func makeBadge(text: String, bg: NSColor, fg: NSColor) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = bg.cgColor
        container.layer?.cornerRadius = 5
        container.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 10, weight: .bold)
        label.textColor = fg
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -6),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),
        ])
        return container
    }

    private func makeCloseIconButton() -> NSButton {
        let btn = NSButton(title: "✕", target: self, action: #selector(handleDismissTap))
        btn.isBordered = false
        btn.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        btn.contentTintColor = .secondaryLabelColor
        btn.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            btn.widthAnchor.constraint(equalToConstant: 22),
            btn.heightAnchor.constraint(equalToConstant: 22),
        ])
        return btn
    }

    private func makeActionButton(title: String, bg: NSColor, fg: NSColor, border: NSColor? = nil, action: Selector, height: CGFloat = 28) -> PillButton {
        let btn = PillButton(title: title, target: self, action: action)
        btn.isBordered = false
        btn.bgColor = bg
        btn.fgColor = fg
        btn.borderCol = border
        btn.corner = height >= 32 ? 9 : 7
        btn.font = NSFont.systemFont(ofSize: height >= 32 ? 12.5 : 11.5, weight: .semibold)
        btn.translatesAutoresizingMaskIntoConstraints = false
        let measured = (title as NSString).size(withAttributes: [.font: btn.font!]).width
        NSLayoutConstraint.activate([
            btn.heightAnchor.constraint(equalToConstant: height),
            btn.widthAnchor.constraint(greaterThanOrEqualToConstant: measured + 24),
        ])
        return btn
    }

    private func buildCardLayout(
        in root: NSView,
        width: CGFloat,
        height: CGFloat,
        accent: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool,
        showMute: Bool
    ) {
        // Left accent stripe
        let stripe = NSView()
        stripe.wantsLayer = true
        stripe.layer?.backgroundColor = accent.cgColor
        stripe.layer?.cornerRadius = 2
        stripe.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stripe)

        // Header row
        let badge = makeBadge(text: agentText, bg: accent.withAlphaComponent(0.18), fg: accent)
        let projLabel = NSTextField(labelWithString: projectText)
        projLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        projLabel.textColor = .secondaryLabelColor
        projLabel.lineBreakMode = .byTruncatingTail
        projLabel.translatesAutoresizingMaskIntoConstraints = false

        let closeBtn = makeCloseIconButton()

        let header = NSStackView(views: [badge, projLabel])
        header.orientation = .horizontal
        header.spacing = 7
        header.alignment = .centerY
        header.translatesAutoresizingMaskIntoConstraints = false

        if !durationText.isEmpty {
            let durBadge = makeBadge(
                text: "⏱ \(durationText)",
                bg: NSColor.labelColor.withAlphaComponent(0.08),
                fg: .secondaryLabelColor
            )
            header.addArrangedSubview(durBadge)
        }
        if isSticky {
            let pinBadge = makeBadge(
                text: "常驻",
                bg: accent.withAlphaComponent(0.14),
                fg: accent
            )
            header.addArrangedSubview(pinBadge)
        }

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        header.addArrangedSubview(spacer)
        header.addArrangedSubview(closeBtn)

        // Title + icon
        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = accent
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let titleField = NSTextField(labelWithString: titleText)
        titleField.font = NSFont.systemFont(ofSize: 14.5, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        let titleRow = NSStackView(views: [iconView, titleField])
        titleRow.orientation = .horizontal
        titleRow.spacing = 6
        titleRow.alignment = .centerY
        titleRow.translatesAutoresizingMaskIntoConstraints = false

        // Body
        let bodyField = NSTextField(wrappingLabelWithString: bodyText)
        bodyField.font = NSFont.systemFont(ofSize: 12.2, weight: .regular)
        bodyField.textColor = NSColor.labelColor.withAlphaComponent(0.84)
        bodyField.maximumNumberOfLines = 3
        bodyField.lineBreakMode = .byTruncatingTail
        bodyField.translatesAutoresizingMaskIntoConstraints = false

        // Actions
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.alignment = .centerY
        actions.translatesAutoresizingMaskIntoConstraints = false

        if showFocus {
            let appLabel = payload.focusAppName ?? "原窗口"
            let focusBtn = makeActionButton(
                title: "切回 \(appLabel) ↗",
                bg: accent,
                fg: .white,
                action: #selector(handleFocusTap)
            )
            actions.addArrangedSubview(focusBtn)
        }
        if showMute {
            let muteBtn = makeActionButton(
                title: "静音 30m",
                bg: NSColor.labelColor.withAlphaComponent(0.08),
                fg: .labelColor,
                border: NSColor.labelColor.withAlphaComponent(0.12),
                action: #selector(handleMuteTap)
            )
            actions.addArrangedSubview(muteBtn)
        }
        let btnSpacer = NSView()
        btnSpacer.translatesAutoresizingMaskIntoConstraints = false
        actions.addArrangedSubview(btnSpacer)

        let okBtn = makeActionButton(
            title: "关闭",
            bg: NSColor.labelColor.withAlphaComponent(0.07),
            fg: .secondaryLabelColor,
            action: #selector(handleDismissTap)
        )
        actions.addArrangedSubview(okBtn)

        root.addSubview(header)
        root.addSubview(titleRow)
        root.addSubview(bodyField)
        root.addSubview(actions)

        NSLayoutConstraint.activate([
            stripe.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 6),
            stripe.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            stripe.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
            stripe.widthAnchor.constraint(equalToConstant: 4),

            header.leadingAnchor.constraint(equalTo: stripe.trailingAnchor, constant: 10),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 11),

            titleRow.leadingAnchor.constraint(equalTo: stripe.trailingAnchor, constant: 10),
            titleRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            titleRow.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 7),

            bodyField.leadingAnchor.constraint(equalTo: stripe.trailingAnchor, constant: 10),
            bodyField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            bodyField.topAnchor.constraint(equalTo: titleRow.bottomAnchor, constant: 5),

            actions.leadingAnchor.constraint(equalTo: stripe.trailingAnchor, constant: 10),
            actions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            actions.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
    }

    private func buildModalLayout(
        in root: NSView,
        width: CGFloat,
        height: CGFloat,
        accent: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool,
        showMute: Bool
    ) {
        // Top accent bar
        let topBar = NSView()
        topBar.wantsLayer = true
        topBar.layer?.backgroundColor = accent.cgColor
        topBar.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(topBar)

        let iconBg = NSView()
        iconBg.wantsLayer = true
        iconBg.layer?.backgroundColor = accent.withAlphaComponent(0.16).cgColor
        iconBg.layer?.cornerRadius = 20
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 21, weight: .bold)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = accent
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        let badge = makeBadge(text: agentText, bg: accent.withAlphaComponent(0.18), fg: accent)
        let proj = NSTextField(labelWithString: projectText)
        proj.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        proj.textColor = .secondaryLabelColor
        proj.translatesAutoresizingMaskIntoConstraints = false

        let metaRow = NSStackView(views: [badge, proj])
        metaRow.orientation = .horizontal
        metaRow.spacing = 8
        metaRow.alignment = .centerY
        metaRow.translatesAutoresizingMaskIntoConstraints = false
        if !durationText.isEmpty {
            metaRow.addArrangedSubview(
                makeBadge(text: "⏱ \(durationText)", bg: NSColor.labelColor.withAlphaComponent(0.08), fg: .secondaryLabelColor)
            )
        }
        if isSticky {
            metaRow.addArrangedSubview(
                makeBadge(text: "等待确认", bg: accent.withAlphaComponent(0.14), fg: accent)
            )
        }

        let titleField = NSTextField(labelWithString: titleText)
        titleField.font = NSFont.systemFont(ofSize: 17.5, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        let closeBtn = makeCloseIconButton()
        root.addSubview(metaRow)
        root.addSubview(titleField)
        root.addSubview(closeBtn)

        // Inner summary card
        let summaryBox = NSView()
        summaryBox.wantsLayer = true
        summaryBox.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.055).cgColor
        summaryBox.layer?.cornerRadius = 11
        summaryBox.layer?.borderWidth = 0.8
        summaryBox.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
        summaryBox.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(summaryBox)

        let bodyField = NSTextField(wrappingLabelWithString: bodyText)
        bodyField.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        bodyField.textColor = NSColor.labelColor.withAlphaComponent(0.88)
        bodyField.maximumNumberOfLines = 4
        bodyField.lineBreakMode = .byTruncatingTail
        bodyField.translatesAutoresizingMaskIntoConstraints = false
        summaryBox.addSubview(bodyField)

        // Action row
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        actions.alignment = .centerY
        actions.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(actions)

        if showFocus {
            let appLabel = payload.focusAppName ?? "原窗口"
            actions.addArrangedSubview(
                makeActionButton(
                    title: "切回 \(appLabel) ↩",
                    bg: accent,
                    fg: .white,
                    action: #selector(handleFocusTap),
                    height: 33
                )
            )
        }
        if showMute {
            actions.addArrangedSubview(
                makeActionButton(
                    title: "静音 30 分钟",
                    bg: NSColor.labelColor.withAlphaComponent(0.08),
                    fg: .labelColor,
                    border: NSColor.labelColor.withAlphaComponent(0.14),
                    action: #selector(handleMuteTap),
                    height: 33
                )
            )
        }
        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        actions.addArrangedSubview(spacer)

        actions.addArrangedSubview(
            makeActionButton(
                title: "知道了 Esc",
                bg: NSColor.labelColor.withAlphaComponent(0.08),
                fg: .labelColor,
                border: NSColor.labelColor.withAlphaComponent(0.14),
                action: #selector(handleDismissTap),
                height: 33
            )
        )

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: root.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 4),

            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            iconBg.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 16),
            iconBg.widthAnchor.constraint(equalToConstant: 40),
            iconBg.heightAnchor.constraint(equalToConstant: 40),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            closeBtn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            closeBtn.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 14),

            metaRow.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 12),
            metaRow.trailingAnchor.constraint(lessThanOrEqualTo: closeBtn.leadingAnchor, constant: -8),
            metaRow.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 14),

            titleField.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 12),
            titleField.trailingAnchor.constraint(equalTo: closeBtn.leadingAnchor, constant: -8),
            titleField.topAnchor.constraint(equalTo: metaRow.bottomAnchor, constant: 3),

            summaryBox.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            summaryBox.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            summaryBox.topAnchor.constraint(equalTo: iconBg.bottomAnchor, constant: 14),
            summaryBox.bottomAnchor.constraint(equalTo: actions.topAnchor, constant: -14),

            bodyField.leadingAnchor.constraint(equalTo: summaryBox.leadingAnchor, constant: 12),
            bodyField.trailingAnchor.constraint(equalTo: summaryBox.trailingAnchor, constant: -12),
            bodyField.topAnchor.constraint(equalTo: summaryBox.topAnchor, constant: 10),
            bodyField.bottomAnchor.constraint(lessThanOrEqualTo: summaryBox.bottomAnchor, constant: -10),

            actions.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            actions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            actions.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
        ])
    }

    private func buildBannerLayout(
        in root: NSView,
        width: CGFloat,
        height: CGFloat,
        accent: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool
    ) {
        let iconBg = NSView()
        iconBg.wantsLayer = true
        iconBg.layer?.backgroundColor = accent.withAlphaComponent(0.18).cgColor
        iconBg.layer?.cornerRadius = 18
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 17, weight: .bold)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = accent
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        let subtitlePrefix = durationText.isEmpty ? "\(agentText) · \(projectText)" : "\(agentText) · \(projectText) · \(durationText)"
        let titleField = NSTextField(labelWithString: "\(titleText)  (\(subtitlePrefix))")
        titleField.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        let bodyField = NSTextField(labelWithString: bodyText)
        bodyField.font = NSFont.systemFont(ofSize: 11.8, weight: .regular)
        bodyField.textColor = .secondaryLabelColor
        bodyField.lineBreakMode = .byTruncatingTail
        bodyField.translatesAutoresizingMaskIntoConstraints = false

        let textCol = NSStackView(views: [titleField, bodyField])
        textCol.orientation = .vertical
        textCol.spacing = 2
        textCol.alignment = .leading
        textCol.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(textCol)

        let closeBtn = makeCloseIconButton()
        root.addSubview(closeBtn)

        var rightAnchorTarget = closeBtn.leadingAnchor
        if showFocus {
            let focusBtn = makeActionButton(
                title: "切回 ↗",
                bg: accent,
                fg: .white,
                action: #selector(handleFocusTap),
                height: 28
            )
            root.addSubview(focusBtn)
            NSLayoutConstraint.activate([
                focusBtn.centerYAnchor.constraint(equalTo: root.centerYAnchor),
                focusBtn.trailingAnchor.constraint(equalTo: closeBtn.leadingAnchor, constant: -6),
            ])
            rightAnchorTarget = focusBtn.leadingAnchor
        }

        NSLayoutConstraint.activate([
            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            iconBg.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            iconBg.widthAnchor.constraint(equalToConstant: 36),
            iconBg.heightAnchor.constraint(equalToConstant: 36),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            closeBtn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            closeBtn.centerYAnchor.constraint(equalTo: root.centerYAnchor),

            textCol.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 11),
            textCol.trailingAnchor.constraint(equalTo: rightAnchorTarget, constant: -10),
            textCol.centerYAnchor.constraint(equalTo: root.centerYAnchor),
        ])
    }

    private func startCountdown(panelWidth: CGFloat) {
        let interval = 0.05
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.isHovered { return }
                self.remaining -= interval
                let ratio = max(0.0, min(1.0, self.remaining / self.totalDuration))
                self.progressWidthConstraint?.constant = panelWidth * CGFloat(ratio)
                if self.remaining <= 0 {
                    self.dismiss()
                }
            }
        }
    }

    @objc private func handleDismissTap() {
        dismiss()
    }

    @objc private func handleMuteTap() {
        if let cliPath = payload.cliPath, !cliPath.isEmpty {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: payload.nodePath ?? "/usr/bin/env")
            if payload.nodePath != nil {
                proc.arguments = [cliPath, "dnd", "--minutes", "30"]
            } else {
                proc.arguments = ["node", cliPath, "dnd", "--minutes", "30"]
            }
            try? proc.run()
        }
        dismiss()
    }

    @objc private func handleFocusTap() {
        focusTargetApp()
        dismiss()
    }

    private func focusTargetApp() {
        let bundleId = payload.focusBundleId ?? ""
        let appName = payload.focusAppName ?? ""
        let hint = payload.focusWindowHint ?? ""

        var activated = false
        if !bundleId.isEmpty {
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            if let app = apps.first {
                activated = app.activate()
            }
        }
        if !activated && !appName.isEmpty {
            let apps = NSWorkspace.shared.runningApplications.filter {
                $0.localizedName?.caseInsensitiveCompare(appName) == .orderedSame
            }
            if let app = apps.first {
                activated = app.activate()
            }
        }

        // Best-effort window title raise via AppleScript when a workspace hint is provided
        if !hint.isEmpty && !appName.isEmpty {
            let safeApp = appName.replacingOccurrences(of: "\"", with: "\\\"")
            let safeHint = hint.replacingOccurrences(of: "\"", with: "\\\"")
            let script = """
            tell application "System Events"
                if exists process "\(safeApp)" then
                    tell process "\(safeApp)"
                        set frontmost to true
                        repeat with w in windows
                            try
                                if (name of w) contains "\(safeHint)" then
                                    perform action "AXRaise" of w
                                    exit repeat
                                end if
                            end try
                        end repeat
                    end tell
                end if
            end tell
            """
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            proc.arguments = ["-e", script]
            proc.standardOutput = Pipe()
            proc.standardError = Pipe()
            try? proc.run()
        }
    }

    private func dismiss() {
        if isDismissing { return }
        isDismissing = true
        timer?.invalidate()
        timer = nil

        guard let panel else {
            slotManager.release()
            NSApp.terminate(nil)
            return
        }

        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.20
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                self?.slotManager.release()
                NSApp.terminate(nil)
            }
        })
    }
}

func parsePayloadFromArgs() -> PopupPayload? {
    let args = CommandLine.arguments
    var filePath: String?
    var inlineJson: String?
    var cleanup = false

    var i = 1
    while i < args.count {
        let a = args[i]
        if a == "--payload", i + 1 < args.count {
            filePath = args[i + 1]
            i += 2
        } else if a == "--json", i + 1 < args.count {
            inlineJson = args[i + 1]
            i += 2
        } else if a == "--cleanup" {
            cleanup = true
            i += 1
        } else {
            i += 1
        }
    }

    var rawData: Data?
    if let p = filePath {
        rawData = try? Data(contentsOf: URL(fileURLWithPath: p))
        if cleanup {
            try? FileManager.default.removeItem(atPath: p)
        }
    } else if let j = inlineJson {
        rawData = Data(j.utf8)
    }

    guard let data = rawData else { return nil }
    return try? JSONDecoder().decode(PopupPayload.self, from: data)
}

guard let payload = parsePayloadFromArgs() else {
    fputs("Usage: NoticesPopup --payload <file.json> [--cleanup] | --json '<json>'\n", stderr)
    exit(2)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = PopupAppDelegate(payload: payload)
    app.delegate = delegate
    app.run()
}

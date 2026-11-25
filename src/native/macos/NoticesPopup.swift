import AppKit
import Foundation
import QuartzCore

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
    let cardVariant: String? // "pill" (default, Scheme C) | "glass" (Scheme A)
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

/// Top-right circular countdown ring that also acts as the close button.
final class CircularCountdownButton: NSView {
    var onTap: (() -> Void)?
    var accentColor: NSColor = .systemGreen {
        didSet { progressLayer.strokeColor = accentColor.cgColor }
    }
    var isSticky: Bool = false {
        didSet { updateAppearance() }
    }
    var progress: CGFloat = 1.0 {
        didSet {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            progressLayer.strokeEnd = max(0.0, min(1.0, progress))
            CATransaction.commit()
        }
    }

    private let trackLayer = CAShapeLayer()
    private let progressLayer = CAShapeLayer()
    private let hoverBgLayer = CALayer()
    private let glyphLabel = NSTextField(labelWithString: "✕")
    private var tracking: NSTrackingArea?
    private var isHovered = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        wantsLayer = true
        guard let rootLayer = layer else { return }

        hoverBgLayer.backgroundColor = NSColor.labelColor.withAlphaComponent(0.0).cgColor
        rootLayer.addSublayer(hoverBgLayer)

        trackLayer.fillColor = NSColor.clear.cgColor
        trackLayer.strokeColor = NSColor.labelColor.withAlphaComponent(0.16).cgColor
        trackLayer.lineWidth = 2.2
        rootLayer.addSublayer(trackLayer)

        progressLayer.fillColor = NSColor.clear.cgColor
        progressLayer.strokeColor = accentColor.cgColor
        progressLayer.lineWidth = 2.2
        progressLayer.lineCap = .round
        progressLayer.strokeStart = 0
        progressLayer.strokeEnd = 1.0
        rootLayer.addSublayer(progressLayer)

        glyphLabel.font = NSFont.systemFont(ofSize: 10, weight: .bold)
        glyphLabel.textColor = NSColor.labelColor.withAlphaComponent(0.76)
        glyphLabel.alignment = .center
        glyphLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyphLabel)

        NSLayoutConstraint.activate([
            glyphLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            glyphLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -0.5),
        ])
    }

    private func updateAppearance() {
        if isSticky {
            progressLayer.strokeEnd = 1.0
            progressLayer.lineDashPattern = [3, 3]
            toolTip = "常驻置顶 · 点击关闭"
        } else {
            progressLayer.lineDashPattern = nil
            toolTip = "倒计时 · 悬停暂停 · 点击关闭"
        }
    }

    override func layout() {
        super.layout()
        let rect = bounds
        hoverBgLayer.frame = rect.insetBy(dx: 2, dy: 2)
        hoverBgLayer.cornerRadius = hoverBgLayer.bounds.width / 2.0

        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2.0 - 2.0
        // Start at 12 o'clock (pi/2 in non-flipped AppKit coordinates) and go clockwise
        let circlePath = CGMutablePath()
        circlePath.addArc(
            center: center,
            radius: radius,
            startAngle: .pi / 2.0,
            endAngle: .pi / 2.0 - .pi * 2.0,
            clockwise: true
        )
        trackLayer.path = circlePath
        progressLayer.path = circlePath
    }

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
        isHovered = true
        hoverBgLayer.backgroundColor = NSColor.labelColor.withAlphaComponent(0.14).cgColor
        glyphLabel.textColor = .labelColor
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        hoverBgLayer.backgroundColor = NSColor.labelColor.withAlphaComponent(0.0).cgColor
        glyphLabel.textColor = NSColor.labelColor.withAlphaComponent(0.76)
    }

    override func mouseDown(with event: NSEvent) {
        onTap?()
    }
}

/// Soft ambient corner glow view for Apple Liquid Glass card variant (Scheme A).
final class AmbientGlowView: NSView {
    var glowColor: NSColor = .systemGreen {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let colors = [
            glowColor.withAlphaComponent(0.30).cgColor,
            glowColor.withAlphaComponent(0.10).cgColor,
            glowColor.withAlphaComponent(0.0).cgColor,
        ] as CFArray
        let locations: [CGFloat] = [0.0, 0.45, 1.0]
        guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: locations) else { return }
        let center = CGPoint(x: 34, y: bounds.height - 18)
        ctx.drawRadialGradient(
            gradient,
            startCenter: center,
            startRadius: 2,
            endCenter: center,
            endRadius: 135,
            options: []
        )
    }
}

final class PillButton: NSButton {
    var bgColor: NSColor = .controlAccentColor
    var gradientBottomColor: NSColor? = nil
    var fgColor: NSColor = .white
    var borderCol: NSColor? = nil
    var topHighlight: Bool = false
    var corner: CGFloat = 10

    override func draw(_ dirtyRect: NSRect) {
        let insetRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: insetRect, xRadius: corner, yRadius: corner)

        if let bottomCol = gradientBottomColor {
            let topCol = isHighlighted ? bgColor.blended(withFraction: 0.16, of: .black) ?? bgColor : bgColor
            let botCol = isHighlighted ? bottomCol.blended(withFraction: 0.16, of: .black) ?? bottomCol : bottomCol
            let grad = NSGradient(starting: botCol, ending: topCol)
            grad?.draw(in: path, angle: 90)
        } else {
            let fill = isHighlighted ? bgColor.blended(withFraction: 0.18, of: .black) ?? bgColor : bgColor
            fill.setFill()
            path.fill()
        }

        if topHighlight {
            let hlPath = NSBezierPath(roundedRect: insetRect.insetBy(dx: 0.5, dy: 0.5), xRadius: max(1, corner - 0.5), yRadius: max(1, corner - 0.5))
            NSColor.white.withAlphaComponent(0.24).setStroke()
            hlPath.lineWidth = 0.8
            hlPath.stroke()
        }

        if let borderCol {
            borderCol.setStroke()
            path.lineWidth = 1.0
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
    private var countdownRing: CircularCountdownButton?
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

    private func accentColors(for kind: String) -> (top: NSColor, bottom: NSColor) {
        switch kind {
        case "error":
            return (
                NSColor(calibratedRed: 0.95, green: 0.28, blue: 0.28, alpha: 1.0),
                NSColor(calibratedRed: 0.84, green: 0.16, blue: 0.16, alpha: 1.0)
            )
        case "attention":
            return (
                NSColor(calibratedRed: 0.96, green: 0.63, blue: 0.06, alpha: 1.0),
                NSColor(calibratedRed: 0.85, green: 0.47, blue: 0.03, alpha: 1.0)
            )
        case "info":
            return (
                NSColor(calibratedRed: 0.24, green: 0.53, blue: 0.97, alpha: 1.0),
                NSColor(calibratedRed: 0.15, green: 0.39, blue: 0.88, alpha: 1.0)
            )
        default: // done
            return (
                NSColor(calibratedRed: 0.15, green: 0.78, blue: 0.39, alpha: 1.0),
                NSColor(calibratedRed: 0.09, green: 0.64, blue: 0.29, alpha: 1.0)
            )
        }
    }

    private func symbolName(for kind: String) -> String {
        switch kind {
        case "error": return "xmark"
        case "attention": return "exclamationmark"
        case "info": return "bell.fill"
        default: return "checkmark"
        }
    }

    private func modalSymbolName(for kind: String) -> String {
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

    private func makeCountdownRing(accent: NSColor, size: CGFloat = 28) -> CircularCountdownButton {
        let ring = CircularCountdownButton(frame: NSRect(x: 0, y: 0, width: size, height: size))
        ring.accentColor = accent
        ring.isSticky = isSticky
        ring.progress = 1.0
        ring.onTap = { [weak self] in self?.dismiss() }
        ring.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            ring.widthAnchor.constraint(equalToConstant: size),
            ring.heightAnchor.constraint(equalToConstant: size),
        ])
        self.countdownRing = ring
        return ring
    }

    private func makeBadge(text: String, bg: NSColor, fg: NSColor, corner: CGFloat = 999) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = bg.cgColor
        container.layer?.cornerRadius = corner == 999 ? 9 : corner
        container.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(labelWithString: text)
        label.font = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold)
        label.textColor = fg
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -7),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 2.5),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2.5),
        ])
        return container
    }

    private func makeActionButton(
        title: String,
        bg: NSColor,
        gradientBottom: NSColor? = nil,
        fg: NSColor,
        border: NSColor? = nil,
        topHighlight: Bool = false,
        action: Selector,
        height: CGFloat = 30,
        corner: CGFloat = 15,
        flexibleWidth: Bool = false
    ) -> PillButton {
        let btn = PillButton(title: title, target: self, action: action)
        btn.isBordered = false
        btn.bgColor = bg
        btn.gradientBottomColor = gradientBottom
        btn.fgColor = fg
        btn.borderCol = border
        btn.topHighlight = topHighlight
        btn.corner = corner
        btn.font = NSFont.systemFont(ofSize: height >= 32 ? 12.5 : 11.8, weight: .semibold)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.heightAnchor.constraint(equalToConstant: height).isActive = true
        if !flexibleWidth {
            let measured = (title as NSString).size(withAttributes: [.font: btn.font!]).width
            btn.widthAnchor.constraint(greaterThanOrEqualToConstant: measured + 26).isActive = true
        }
        return btn
    }

    private func buildAndShowPanel() {
        let style = (payload.style ?? "card").lowercased()
        let variant = (payload.cardVariant ?? "pill").lowercased() // default: pill (Scheme C), alternate: glass (Scheme A)
        let kind = (payload.kind ?? "done").lowercased()
        let colors = accentColors(for: kind)
        let accent = colors.top
        let accentBottom = colors.bottom
        let titleText = payload.title ?? "会话任务已完成"
        let bodyText = payload.message ?? "任务已结束，可返回查看。"
        let agentText = payload.agentLabel ?? payload.agent ?? "Agent"
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
        let cornerRadius: CGFloat

        switch style {
        case "modal":
            panelWidth = 468
            panelHeight = bodyText.count > 95 ? 246 : 218
            cornerRadius = 22
        case "banner":
            panelWidth = 456
            panelHeight = 76
            cornerRadius = 22
        default: // card
            if variant == "glass" {
                // Scheme A: Apple Liquid Glass
                panelWidth = 396
                panelHeight = bodyText.count > 75 ? 176 : 158
                cornerRadius = 20
            } else {
                // Scheme C (Default): Compact Dynamic Pill Card
                panelWidth = 360
                panelHeight = bodyText.count > 55 ? 148 : 134
                cornerRadius = 24
            }
        }

        let panel = NoticePanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
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

        // Root hover-tracking container
        let root = HoverTrackingView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
        root.wantsLayer = true
        root.layer?.cornerRadius = cornerRadius
        root.layer?.masksToBounds = true
        root.onHoverChange = { [weak self] hovered in
            self?.isHovered = hovered
        }

        // Frosted glass material
        let blur = NSVisualEffectView(frame: root.bounds)
        blur.autoresizingMask = [.width, .height]
        blur.material = (style == "card" && variant == "glass") ? .popover : .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = cornerRadius
        blur.layer?.borderWidth = 1.0
        blur.layer?.borderColor = NSColor.labelColor.withAlphaComponent(variant == "glass" ? 0.18 : 0.14).cgColor
        root.addSubview(blur)

        if style == "banner" {
            buildBannerLayout(
                in: root,
                accent: accent,
                accentBottom: accentBottom,
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
                accent: accent,
                accentBottom: accentBottom,
                kind: kind,
                agentText: agentText,
                projectText: projectText,
                durationText: durationText,
                titleText: titleText,
                bodyText: bodyText,
                showFocus: showFocus,
                showMute: showMute
            )
        } else if variant == "glass" {
            buildGlassCardLayout(
                in: root,
                accent: accent,
                accentBottom: accentBottom,
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
            buildPillCardLayout(
                in: root,
                accent: accent,
                accentBottom: accentBottom,
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
            startCountdown()
        }
    }

    // MARK: - Scheme C (Default): Compact Dynamic Pill Card
    private func buildPillCardLayout(
        in root: NSView,
        accent: NSColor,
        accentBottom: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool,
        showMute: Bool
    ) {
        // Solid glowing status circle badge
        let iconBg = NSView()
        iconBg.wantsLayer = true
        iconBg.layer?.backgroundColor = accent.cgColor
        iconBg.layer?.cornerRadius = 14
        iconBg.layer?.shadowColor = accent.cgColor
        iconBg.layer?.shadowOpacity = 0.45
        iconBg.layer?.shadowRadius = 7
        iconBg.layer?.shadowOffset = .zero
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 12.5, weight: .black)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = .white
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        // Title + compact single-line subtitle
        let titleField = NSTextField(labelWithString: titleText)
        titleField.font = NSFont.systemFont(ofSize: 14, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        var metaParts = [agentText, projectText]
        if !durationText.isEmpty { metaParts.append(durationText) }
        if isSticky { metaParts.append("常驻") }
        let subField = NSTextField(labelWithString: metaParts.joined(separator: " · "))
        subField.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        subField.textColor = .secondaryLabelColor
        subField.lineBreakMode = .byTruncatingTail
        subField.translatesAutoresizingMaskIntoConstraints = false

        let textCol = NSStackView(views: [titleField, subField])
        textCol.orientation = .vertical
        textCol.spacing = 1.5
        textCol.alignment = .leading
        textCol.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(textCol)

        // Top-right circular countdown close button
        let ring = makeCountdownRing(accent: accent, size: 28)
        root.addSubview(ring)

        // Compact 2-line summary
        let bodyField = NSTextField(wrappingLabelWithString: bodyText)
        bodyField.font = NSFont.systemFont(ofSize: 12.2, weight: .regular)
        bodyField.textColor = NSColor.labelColor.withAlphaComponent(0.84)
        bodyField.maximumNumberOfLines = 2
        bodyField.lineBreakMode = .byTruncatingTail
        bodyField.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(bodyField)

        // Full-width docked dual action bar
        let dock = NSView()
        dock.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(dock)

        if showFocus && showMute {
            let appLabel = payload.focusAppName ?? "原窗口"
            let focusBtn = makeActionButton(
                title: "切回 \(appLabel) ↗",
                bg: accent,
                gradientBottom: accentBottom,
                fg: .white,
                topHighlight: true,
                action: #selector(handleFocusTap),
                height: 32,
                corner: 13,
                flexibleWidth: true
            )
            let muteBtn = makeActionButton(
                title: "静音 30m",
                bg: NSColor.labelColor.withAlphaComponent(0.11),
                fg: .labelColor,
                action: #selector(handleMuteTap),
                height: 32,
                corner: 13,
                flexibleWidth: true
            )
            dock.addSubview(focusBtn)
            dock.addSubview(muteBtn)

            NSLayoutConstraint.activate([
                focusBtn.leadingAnchor.constraint(equalTo: dock.leadingAnchor),
                focusBtn.topAnchor.constraint(equalTo: dock.topAnchor),
                focusBtn.bottomAnchor.constraint(equalTo: dock.bottomAnchor),

                muteBtn.leadingAnchor.constraint(equalTo: focusBtn.trailingAnchor, constant: 8),
                muteBtn.trailingAnchor.constraint(equalTo: dock.trailingAnchor),
                muteBtn.topAnchor.constraint(equalTo: dock.topAnchor),
                muteBtn.bottomAnchor.constraint(equalTo: dock.bottomAnchor),
                muteBtn.widthAnchor.constraint(equalTo: dock.widthAnchor, multiplier: 0.35),
            ])
        } else if showFocus {
            let appLabel = payload.focusAppName ?? "原窗口"
            let focusBtn = makeActionButton(
                title: "切回 \(appLabel) ↗",
                bg: accent,
                gradientBottom: accentBottom,
                fg: .white,
                topHighlight: true,
                action: #selector(handleFocusTap),
                height: 32,
                corner: 13,
                flexibleWidth: true
            )
            dock.addSubview(focusBtn)
            NSLayoutConstraint.activate([
                focusBtn.leadingAnchor.constraint(equalTo: dock.leadingAnchor),
                focusBtn.trailingAnchor.constraint(equalTo: dock.trailingAnchor),
                focusBtn.topAnchor.constraint(equalTo: dock.topAnchor),
                focusBtn.bottomAnchor.constraint(equalTo: dock.bottomAnchor),
            ])
        } else {
            let closeBtn = makeActionButton(
                title: "知道了",
                bg: NSColor.labelColor.withAlphaComponent(0.11),
                fg: .labelColor,
                action: #selector(handleDismissTap),
                height: 32,
                corner: 13,
                flexibleWidth: true
            )
            dock.addSubview(closeBtn)
            NSLayoutConstraint.activate([
                closeBtn.leadingAnchor.constraint(equalTo: dock.leadingAnchor),
                closeBtn.trailingAnchor.constraint(equalTo: dock.trailingAnchor),
                closeBtn.topAnchor.constraint(equalTo: dock.topAnchor),
                closeBtn.bottomAnchor.constraint(equalTo: dock.bottomAnchor),
            ])
        }

        NSLayoutConstraint.activate([
            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            iconBg.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            iconBg.widthAnchor.constraint(equalToConstant: 28),
            iconBg.heightAnchor.constraint(equalToConstant: 28),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            ring.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -13),
            ring.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            textCol.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 10),
            textCol.trailingAnchor.constraint(equalTo: ring.leadingAnchor, constant: -8),
            textCol.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            bodyField.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 15),
            bodyField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -15),
            bodyField.topAnchor.constraint(equalTo: iconBg.bottomAnchor, constant: 10),

            dock.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            dock.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            dock.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -13),
            dock.heightAnchor.constraint(equalToConstant: 32),
        ])
    }

    // MARK: - Scheme A: Apple Liquid Glass Card (with top-right circular countdown)
    private func buildGlassCardLayout(
        in root: NSView,
        accent: NSColor,
        accentBottom: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool,
        showMute: Bool
    ) {
        // Subtle ambient status glow in top-left corner
        let glow = AmbientGlowView(frame: root.bounds)
        glow.glowColor = accent
        glow.autoresizingMask = [.width, .height]
        root.addSubview(glow)

        // Rounded squircle frosted status icon container
        let iconBg = NSView()
        iconBg.wantsLayer = true
        iconBg.layer?.backgroundColor = accent.withAlphaComponent(0.16).cgColor
        iconBg.layer?.cornerRadius = 12
        iconBg.layer?.borderWidth = 1.0
        iconBg.layer?.borderColor = accent.withAlphaComponent(0.36).cgColor
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 15, weight: .bold)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = accent
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        // Top-right circular countdown close button + optional duration pill
        let ring = makeCountdownRing(accent: accent, size: 28)
        root.addSubview(ring)

        let rightStack = NSStackView()
        rightStack.orientation = .horizontal
        rightStack.spacing = 7
        rightStack.alignment = .centerY
        rightStack.translatesAutoresizingMaskIntoConstraints = false
        if !durationText.isEmpty {
            rightStack.addArrangedSubview(
                makeBadge(
                    text: durationText,
                    bg: NSColor.labelColor.withAlphaComponent(0.10),
                    fg: .secondaryLabelColor
                )
            )
        } else if isSticky {
            rightStack.addArrangedSubview(
                makeBadge(text: "常驻", bg: accent.withAlphaComponent(0.16), fg: accent)
            )
        }
        rightStack.addArrangedSubview(ring)
        root.addSubview(rightStack)

        // Title & meta line
        let titleField = NSTextField(labelWithString: titleText)
        titleField.font = NSFont.systemFont(ofSize: 14.5, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        let metaText = isSticky && !durationText.isEmpty ? "\(agentText) · \(projectText) · 常驻" : "\(agentText) · \(projectText)"
        let metaField = NSTextField(labelWithString: metaText)
        metaField.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        metaField.textColor = .secondaryLabelColor
        metaField.lineBreakMode = .byTruncatingTail
        metaField.translatesAutoresizingMaskIntoConstraints = false

        let headCol = NSStackView(views: [titleField, metaField])
        headCol.orientation = .vertical
        headCol.spacing = 2
        headCol.alignment = .leading
        headCol.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(headCol)

        // Airy 3-line summary
        let bodyField = NSTextField(wrappingLabelWithString: bodyText)
        bodyField.font = NSFont.systemFont(ofSize: 12.6, weight: .regular)
        bodyField.textColor = NSColor.labelColor.withAlphaComponent(0.86)
        bodyField.maximumNumberOfLines = 3
        bodyField.lineBreakMode = .byTruncatingTail
        bodyField.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(bodyField)

        // Bottom pill action row (left ghost mute, right gradient focus)
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.alignment = .centerY
        actions.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(actions)

        if showMute {
            actions.addArrangedSubview(
                makeActionButton(
                    title: "静音 30m",
                    bg: NSColor.labelColor.withAlphaComponent(0.08),
                    fg: .labelColor,
                    border: NSColor.labelColor.withAlphaComponent(0.16),
                    action: #selector(handleMuteTap),
                    height: 30,
                    corner: 15
                )
            )
        }

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        actions.addArrangedSubview(spacer)

        if showFocus {
            let appLabel = payload.focusAppName ?? "原窗口"
            actions.addArrangedSubview(
                makeActionButton(
                    title: "切回 \(appLabel) ↗",
                    bg: accent,
                    gradientBottom: accentBottom,
                    fg: .white,
                    topHighlight: true,
                    action: #selector(handleFocusTap),
                    height: 30,
                    corner: 15
                )
            )
        } else {
            actions.addArrangedSubview(
                makeActionButton(
                    title: "知道了",
                    bg: NSColor.labelColor.withAlphaComponent(0.10),
                    fg: .labelColor,
                    action: #selector(handleDismissTap),
                    height: 30,
                    corner: 15
                )
            )
        }

        NSLayoutConstraint.activate([
            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            iconBg.topAnchor.constraint(equalTo: root.topAnchor, constant: 15),
            iconBg.widthAnchor.constraint(equalToConstant: 36),
            iconBg.heightAnchor.constraint(equalToConstant: 36),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            rightStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            rightStack.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            headCol.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 11),
            headCol.trailingAnchor.constraint(lessThanOrEqualTo: rightStack.leadingAnchor, constant: -8),
            headCol.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            bodyField.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            bodyField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            bodyField.topAnchor.constraint(equalTo: iconBg.bottomAnchor, constant: 11),

            actions.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            actions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            actions.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
    }

    // MARK: - Modal (Centered Strong Alert with top-right circular countdown)
    private func buildModalLayout(
        in root: NSView,
        accent: NSColor,
        accentBottom: NSColor,
        kind: String,
        agentText: String,
        projectText: String,
        durationText: String,
        titleText: String,
        bodyText: String,
        showFocus: Bool,
        showMute: Bool
    ) {
        let glow = AmbientGlowView(frame: root.bounds)
        glow.glowColor = accent
        glow.autoresizingMask = [.width, .height]
        root.addSubview(glow)

        let iconBg = NSView()
        iconBg.wantsLayer = true
        iconBg.layer?.backgroundColor = accent.withAlphaComponent(0.16).cgColor
        iconBg.layer?.cornerRadius = 20
        iconBg.layer?.borderWidth = 1.0
        iconBg.layer?.borderColor = accent.withAlphaComponent(0.32).cgColor
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: modalSymbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 21, weight: .bold)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = accent
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        let badge = makeBadge(text: agentText.uppercased(), bg: accent.withAlphaComponent(0.18), fg: accent, corner: 6)
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
                makeBadge(text: durationText, bg: NSColor.labelColor.withAlphaComponent(0.08), fg: .secondaryLabelColor)
            )
        }
        if isSticky {
            metaRow.addArrangedSubview(
                makeBadge(text: "等待确认", bg: accent.withAlphaComponent(0.16), fg: accent)
            )
        }

        let titleField = NSTextField(labelWithString: titleText)
        titleField.font = NSFont.systemFont(ofSize: 17.5, weight: .bold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        let ring = makeCountdownRing(accent: accent, size: 30)
        root.addSubview(metaRow)
        root.addSubview(titleField)
        root.addSubview(ring)

        let summaryBox = NSView()
        summaryBox.wantsLayer = true
        summaryBox.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.055).cgColor
        summaryBox.layer?.cornerRadius = 12
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
                    gradientBottom: accentBottom,
                    fg: .white,
                    topHighlight: true,
                    action: #selector(handleFocusTap),
                    height: 34,
                    corner: 17
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
                    height: 34,
                    corner: 17
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
                height: 34,
                corner: 17
            )
        )

        NSLayoutConstraint.activate([
            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            iconBg.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            iconBg.widthAnchor.constraint(equalToConstant: 40),
            iconBg.heightAnchor.constraint(equalToConstant: 40),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            ring.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            ring.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),

            metaRow.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 12),
            metaRow.trailingAnchor.constraint(lessThanOrEqualTo: ring.leadingAnchor, constant: -8),
            metaRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 17),

            titleField.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 12),
            titleField.trailingAnchor.constraint(equalTo: ring.leadingAnchor, constant: -8),
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

    // MARK: - Banner (Top Dynamic Capsule with circular countdown)
    private func buildBannerLayout(
        in root: NSView,
        accent: NSColor,
        accentBottom: NSColor,
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
        iconBg.layer?.backgroundColor = accent.cgColor
        iconBg.layer?.cornerRadius = 16
        iconBg.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(iconBg)

        let iconView = NSImageView()
        if let sym = NSImage(systemSymbolName: symbolName(for: kind), accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .black)
            iconView.image = sym.withSymbolConfiguration(cfg)
            iconView.contentTintColor = .white
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconBg.addSubview(iconView)

        let subtitlePrefix = durationText.isEmpty ? "\(agentText) · \(projectText)" : "\(agentText) · \(projectText) · \(durationText)"
        let titleField = NSTextField(labelWithString: "\(titleText)  ·  \(subtitlePrefix)")
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

        let ring = makeCountdownRing(accent: accent, size: 28)
        root.addSubview(ring)

        var rightAnchorTarget = ring.leadingAnchor
        if showFocus {
            let focusBtn = makeActionButton(
                title: "切回 ↗",
                bg: accent,
                gradientBottom: accentBottom,
                fg: .white,
                topHighlight: true,
                action: #selector(handleFocusTap),
                height: 28,
                corner: 14
            )
            root.addSubview(focusBtn)
            NSLayoutConstraint.activate([
                focusBtn.centerYAnchor.constraint(equalTo: root.centerYAnchor),
                focusBtn.trailingAnchor.constraint(equalTo: ring.leadingAnchor, constant: -8),
            ])
            rightAnchorTarget = focusBtn.leadingAnchor
        }

        NSLayoutConstraint.activate([
            iconBg.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            iconBg.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            iconBg.widthAnchor.constraint(equalToConstant: 32),
            iconBg.heightAnchor.constraint(equalToConstant: 32),

            iconView.centerXAnchor.constraint(equalTo: iconBg.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBg.centerYAnchor),

            ring.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -13),
            ring.centerYAnchor.constraint(equalTo: root.centerYAnchor),

            textCol.leadingAnchor.constraint(equalTo: iconBg.trailingAnchor, constant: 11),
            textCol.trailingAnchor.constraint(equalTo: rightAnchorTarget, constant: -10),
            textCol.centerYAnchor.constraint(equalTo: root.centerYAnchor),
        ])
    }

    private func startCountdown() {
        let interval = 0.04
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.isHovered { return }
                self.remaining -= interval
                let ratio = max(0.0, min(1.0, self.remaining / self.totalDuration))
                self.countdownRing?.progress = CGFloat(ratio)
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

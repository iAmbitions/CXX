import AppKit

// The action tiles contain labels and image views. AppKit normally hit-tests those
// child views first, so a physical click on the text/icon may never reach NSButton.
// Keep the whole tile as one native button hit target while preserving its custom layout.
private final class ControlCenterActionButton: NSButton {
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, alphaValue > 0, isEnabled else { return nil }
        // NSView.hitTest receives the point in the superview's coordinate space.
        // Comparing it with bounds makes every button outside the parent's origin
        // effectively unclickable; frame is expressed in the matching coordinate space.
        return frame.contains(point) ? self : nil
    }
}

private final class ControlCenterButtonContentView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// Dock/Finder-facing control center. It deliberately shows only local service state
// and local actions—never a pairing URL, device credential, notification credential,
// or remote-session payload. The menu-bar item stays available after this window closes.
extension AppDelegate {
    func showControlCenter() {
        if let existing = windows.first(where: { $0.identifier == Self.controlCenterWindowID && $0.isVisible }) {
            NSApp.activate(ignoringOtherApps: true)
            existing.makeKeyAndOrderFront(nil)
            return
        }

        let st = status()
        let enabled = st["enabled"] as? Bool ?? false
        let running = st["running"] as? Bool ?? false
        let devices = st["deviceCount"] as? Int ?? 0
        let notifierCount = st["notifierCount"] as? Int ?? 0

        let content = NSVisualEffectView()
        content.material = .underWindowBackground
        content.blendingMode = .behindWindow
        content.state = .active

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .width
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
        ])

        let header = makeHeader(enabled: enabled, running: running)
        stack.addArrangedSubview(header)
        pinToStackWidth(header, stack: stack)
        stack.setCustomSpacing(12, after: header)

        let overview = makeOverview(enabled: enabled, running: running, devices: devices, notifierCount: notifierCount)
        stack.addArrangedSubview(overview)
        pinToStackWidth(overview, stack: stack)
        stack.setCustomSpacing(12, after: overview)

        let primary = makePrimaryButton(
            L(enabled ? "配对一台新手机" : "开启远程并配对手机", enabled ? "Pair a new phone" : "Enable remote and pair"),
            detail: enabled
                ? L("生成仅供本人使用的长期配对二维码", "Create a personal, persistent pairing QR code")
                : L("开启后台服务并生成长期配对二维码", "Start the service and create a persistent pairing QR code"),
            action: #selector(controlCenterPairTapped)
        )
        stack.addArrangedSubview(primary)
        pinToStackWidth(primary, stack: stack)
        stack.setCustomSpacing(14, after: primary)

        let actionTitle = NSTextField(labelWithString: L("设置与工具", "Settings and tools"))
        actionTitle.font = .systemFont(ofSize: 11, weight: .semibold)
        actionTitle.textColor = .secondaryLabelColor
        stack.addArrangedSubview(actionTitle)
        pinToStackWidth(actionTitle, stack: stack)
        stack.setCustomSpacing(6, after: actionTitle)

        let actionGroup = makeActionGroup()
        stack.addArrangedSubview(actionGroup)
        pinToStackWidth(actionGroup, stack: stack)
        stack.setCustomSpacing(12, after: actionGroup)

        let footer = makeFooter(enabled: enabled)
        stack.addArrangedSubview(footer)
        pinToStackWidth(footer, stack: stack)

        let window = makeWindow(L("口袋Agent", "Pocket Agent"), content, width: 548, height: 446)
        window.identifier = Self.controlCenterWindowID
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.backgroundColor = .windowBackgroundColor
        window.minSize = NSSize(width: 520, height: 420)
    }

    @objc func controlCenterPairTapped() { doPair() }
    @objc func controlCenterDevicesTapped() { doDevices() }
    @objc func controlCenterNotifyTapped() { doNotify() }
    @objc func controlCenterTerminalTapped() { doTerminal() }
    @objc func controlCenterDisableTapped() {
        doDisable()
        closeControlCenterWindows()
        showControlCenter()
    }
    @objc func controlCenterRefreshTapped() {
        closeControlCenterWindows()
        showControlCenter()
    }

    static let controlCenterWindowID = NSUserInterfaceItemIdentifier("pocket-agent.control-center")
    func closeControlCenterWindows() {
        for w in windows where w.identifier == Self.controlCenterWindowID { w.close() }
    }

    // MARK: - Layout

    private func pinToStackWidth(_ view: NSView, stack: NSStackView) {
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func makeHeader(enabled: Bool, running: Bool) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        row.heightAnchor.constraint(equalToConstant: 42).isActive = true

        let appIcon = NSImageView()
        appIcon.image = Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
            .flatMap(NSImage.init(contentsOf:)) ?? NSApp.applicationIconImage
        appIcon.imageScaling = .scaleProportionallyUpOrDown
        appIcon.wantsLayer = true
        appIcon.layer?.cornerRadius = 10
        appIcon.layer?.masksToBounds = true
        appIcon.translatesAutoresizingMaskIntoConstraints = false
        appIcon.widthAnchor.constraint(equalToConstant: 40).isActive = true
        appIcon.heightAnchor.constraint(equalToConstant: 40).isActive = true

        let labels = NSStackView()
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        let title = NSTextField(labelWithString: L("口袋Agent", "Pocket Agent"))
        title.font = .systemFont(ofSize: 19, weight: .bold)
        title.textColor = .labelColor
        let subtitle = NSTextField(labelWithString: L("本机 Agent 连接与设置", "Local Agent connections and settings"))
        subtitle.font = .systemFont(ofSize: 11, weight: .regular)
        subtitle.textColor = .secondaryLabelColor
        labels.addArrangedSubview(title)
        labels.addArrangedSubview(subtitle)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let state = enabled && running
            ? L("服务正常", "Service ready")
            : (enabled ? L("正在连接", "Connecting") : L("远程未开启", "Remote off"))
        let stateColor: NSColor = enabled && running ? Self.readyGreen : (enabled ? .systemOrange : .secondaryLabelColor)

        row.addArrangedSubview(appIcon)
        row.addArrangedSubview(labels)
        row.addArrangedSubview(spacer)
        row.addArrangedSubview(makeStatusBadge(state, color: stateColor))
        return row
    }

    private func makeOverview(enabled: Bool, running: Bool, devices: Int, notifierCount: Int) -> NSView {
        let hero = NSView()
        hero.wantsLayer = true
        hero.layer?.backgroundColor = heroColor(enabled: enabled, running: running).cgColor
        hero.layer?.cornerRadius = 15
        hero.layer?.masksToBounds = true
        hero.translatesAutoresizingMaskIntoConstraints = false
        hero.heightAnchor.constraint(equalToConstant: 108).isActive = true

        let copy = NSStackView()
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 4
        copy.translatesAutoresizingMaskIntoConstraints = false

        let eyebrow = makeHeroEyebrow(enabled: enabled, running: running)
        let headline = NSTextField(labelWithString: enabled && running
            ? L("手机现在可以安全连接本机 Agent", "Your phone can securely connect to the local Agent")
            : (enabled ? L("正在连接本机后台服务", "Connecting to the local background service") : L("开启后即可从手机连接本机 Agent", "Turn it on to connect to the local Agent from your phone")))
        headline.font = .systemFont(ofSize: 16, weight: .semibold)
        headline.textColor = .white
        headline.lineBreakMode = .byTruncatingTail

        let stats = NSStackView()
        stats.orientation = .horizontal
        stats.alignment = .centerY
        stats.spacing = 7
        stats.addArrangedSubview(makeHeroPill(
            L("\(devices) 台设备", "\(devices) device\(devices == 1 ? "" : "s")"),
            symbol: "iphone"
        ))
        stats.addArrangedSubview(makeHeroPill(
            L("\(notifierCount) 位通知接收人", "\(notifierCount) notification recipient\(notifierCount == 1 ? "" : "s")"),
            symbol: "bell"
        ))

        copy.addArrangedSubview(eyebrow)
        copy.addArrangedSubview(headline)
        copy.setCustomSpacing(9, after: headline)
        copy.addArrangedSubview(stats)

        let shield = NSImageView(image: NSImage(
            systemSymbolName: enabled && running ? "lock.shield.fill" : "lock.shield",
            accessibilityDescription: nil
        ) ?? NSImage())
        shield.contentTintColor = NSColor.white.withAlphaComponent(0.16)
        shield.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 50, weight: .regular)
        shield.translatesAutoresizingMaskIntoConstraints = false

        hero.addSubview(copy)
        hero.addSubview(shield)
        NSLayoutConstraint.activate([
            copy.leadingAnchor.constraint(equalTo: hero.leadingAnchor, constant: 17),
            copy.centerYAnchor.constraint(equalTo: hero.centerYAnchor),
            copy.trailingAnchor.constraint(lessThanOrEqualTo: shield.leadingAnchor, constant: -12),
            shield.trailingAnchor.constraint(equalTo: hero.trailingAnchor, constant: -18),
            shield.centerYAnchor.constraint(equalTo: hero.centerYAnchor),
            shield.widthAnchor.constraint(equalToConstant: 54),
            shield.heightAnchor.constraint(equalToConstant: 54),
        ])
        return hero
    }

    private func makeActionGroup() -> NSView {
        let group = NSView()
        group.wantsLayer = true
        group.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.74).cgColor
        group.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
        group.layer?.borderWidth = 1
        group.layer?.cornerRadius = 12
        group.layer?.masksToBounds = true
        group.translatesAutoresizingMaskIntoConstraints = false
        group.heightAnchor.constraint(equalToConstant: 106).isActive = true

        let firstRow = makeActionRow(
            makeQuickAction(
                L("设备管理", "Devices"),
                detail: L("查看与撤销配对", "Review paired devices"),
                symbol: "iphone",
                action: #selector(controlCenterDevicesTapped)
            ),
            makeQuickAction(
                L("京 Me 通知", "Jing Me notifications"),
                detail: L("管理消息接收人", "Manage recipients"),
                symbol: "bell",
                action: #selector(controlCenterNotifyTapped)
            )
        )
        let secondRow = makeActionRow(
            makeQuickAction(
                L("终端模式", "Terminal mode"),
                detail: L("设置手机终端权限", "Set terminal access"),
                symbol: "terminal",
                action: #selector(controlCenterTerminalTapped)
            ),
            makeQuickAction(
                L("刷新状态", "Refresh status"),
                detail: L("重新读取本机服务", "Reload local service state"),
                symbol: "arrow.clockwise",
                action: #selector(controlCenterRefreshTapped)
            )
        )
        firstRow.translatesAutoresizingMaskIntoConstraints = false
        secondRow.translatesAutoresizingMaskIntoConstraints = false

        let horizontalSeparator = makeSeparator()
        let verticalSeparator = makeSeparator()
        group.addSubview(firstRow)
        group.addSubview(secondRow)
        group.addSubview(horizontalSeparator)
        group.addSubview(verticalSeparator)
        NSLayoutConstraint.activate([
            firstRow.leadingAnchor.constraint(equalTo: group.leadingAnchor),
            firstRow.trailingAnchor.constraint(equalTo: group.trailingAnchor),
            firstRow.topAnchor.constraint(equalTo: group.topAnchor),
            firstRow.bottomAnchor.constraint(equalTo: horizontalSeparator.topAnchor),
            secondRow.leadingAnchor.constraint(equalTo: group.leadingAnchor),
            secondRow.trailingAnchor.constraint(equalTo: group.trailingAnchor),
            secondRow.topAnchor.constraint(equalTo: horizontalSeparator.bottomAnchor),
            secondRow.bottomAnchor.constraint(equalTo: group.bottomAnchor),
            horizontalSeparator.leadingAnchor.constraint(equalTo: group.leadingAnchor, constant: 12),
            horizontalSeparator.trailingAnchor.constraint(equalTo: group.trailingAnchor, constant: -12),
            horizontalSeparator.centerYAnchor.constraint(equalTo: group.centerYAnchor),
            horizontalSeparator.heightAnchor.constraint(equalToConstant: 1),
            verticalSeparator.centerXAnchor.constraint(equalTo: group.centerXAnchor),
            verticalSeparator.topAnchor.constraint(equalTo: group.topAnchor, constant: 9),
            verticalSeparator.bottomAnchor.constraint(equalTo: group.bottomAnchor, constant: -9),
            verticalSeparator.widthAnchor.constraint(equalToConstant: 1),
        ])
        return group
    }

    private func makeFooter(enabled: Bool) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        row.heightAnchor.constraint(equalToConstant: 24).isActive = true

        let hint = NSTextField(labelWithString: L(
            "关闭窗口后，Agent 服务仍会在后台运行。",
            "The Agent service keeps running after this window closes."
        ))
        hint.font = .systemFont(ofSize: 10.5, weight: .regular)
        hint.textColor = .tertiaryLabelColor
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        row.addArrangedSubview(hint)
        row.addArrangedSubview(spacer)
        if enabled {
            row.addArrangedSubview(makeDisableButton())
        }
        return row
    }

    // MARK: - Visual primitives

    private static let readyGreen = NSColor(calibratedRed: 0.08, green: 0.62, blue: 0.36, alpha: 1)
    private static let primaryGreen = NSColor(calibratedRed: 0.03, green: 0.52, blue: 0.30, alpha: 1)
    private static let activeHero = NSColor(calibratedRed: 0.045, green: 0.17, blue: 0.145, alpha: 1)
    private static let connectingHero = NSColor(calibratedRed: 0.20, green: 0.16, blue: 0.09, alpha: 1)
    private static let inactiveHero = NSColor(calibratedRed: 0.15, green: 0.17, blue: 0.20, alpha: 1)

    private func heroColor(enabled: Bool, running: Bool) -> NSColor {
        if enabled && running { return Self.activeHero }
        if enabled { return Self.connectingHero }
        return Self.inactiveHero
    }

    private func makeStatusBadge(_ title: String, color: NSColor) -> NSView {
        let holder = NSView()
        holder.wantsLayer = true
        holder.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.72).cgColor
        holder.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.5).cgColor
        holder.layer?.borderWidth = 1
        holder.layer?.cornerRadius = 11
        holder.translatesAutoresizingMaskIntoConstraints = false

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.backgroundColor = color.cgColor
        dot.layer?.cornerRadius = 3.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true

        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 10.5, weight: .semibold)
        label.textColor = color

        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 9),
            row.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -9),
            row.topAnchor.constraint(equalTo: holder.topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -6),
        ])
        return holder
    }

    private func makeHeroEyebrow(enabled: Bool, running: Bool) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.backgroundColor = (enabled && running ? NSColor.systemGreen : (enabled ? .systemOrange : .systemGray)).cgColor
        dot.layer?.cornerRadius = 3
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 6).isActive = true

        let label = NSTextField(labelWithString: enabled && running
            ? L("Agent 远程访问已开启", "Agent remote access is on")
            : (enabled ? L("后台服务正在启动", "Background service is starting") : L("Agent 远程访问已关闭", "Agent remote access is off")))
        label.font = .systemFont(ofSize: 10.5, weight: .semibold)
        label.textColor = NSColor.white.withAlphaComponent(0.72)

        row.addArrangedSubview(dot)
        row.addArrangedSubview(label)
        return row
    }

    private func makeHeroPill(_ title: String, symbol: String) -> NSView {
        let holder = NSView()
        holder.wantsLayer = true
        holder.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.10).cgColor
        holder.layer?.cornerRadius = 9
        holder.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: title) ?? NSImage())
        icon.contentTintColor = NSColor.white.withAlphaComponent(0.78)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 10.5, weight: .medium)
        label.textColor = NSColor.white.withAlphaComponent(0.84)

        let row = NSStackView(views: [icon, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: holder.topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -4),
        ])
        return holder
    }

    private func makePrimaryButton(_ title: String, detail: String, action: Selector) -> NSButton {
        let button = ControlCenterActionButton(title: "", target: self, action: action)
        button.sendAction(on: .leftMouseUp)
        button.bezelStyle = .regularSquare
        button.isBordered = false
        button.focusRingType = .none
        button.wantsLayer = true
        button.layer?.backgroundColor = Self.primaryGreen.cgColor
        button.layer?.cornerRadius = 12
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 54).isActive = true
        button.toolTip = title

        let icon = NSImageView(image: NSImage(systemSymbolName: "qrcode", accessibilityDescription: title) ?? NSImage())
        icon.contentTintColor = .white
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 20, weight: .medium)
        icon.translatesAutoresizingMaskIntoConstraints = false

        let labels = NSStackView()
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        labels.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        heading.textColor = .white
        let subheading = NSTextField(labelWithString: detail)
        subheading.font = .systemFont(ofSize: 10.5, weight: .regular)
        subheading.textColor = NSColor.white.withAlphaComponent(0.72)
        labels.addArrangedSubview(heading)
        labels.addArrangedSubview(subheading)

        let chevron = NSImageView(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil) ?? NSImage())
        chevron.contentTintColor = NSColor.white.withAlphaComponent(0.62)
        chevron.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        chevron.translatesAutoresizingMaskIntoConstraints = false

        let content = ControlCenterButtonContentView()
        content.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(content)
        content.addSubview(icon)
        content.addSubview(labels)
        content.addSubview(chevron)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            content.topAnchor.constraint(equalTo: button.topAnchor),
            content.bottomAnchor.constraint(equalTo: button.bottomAnchor),
            icon.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 17),
            icon.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 24),
            labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 11),
            labels.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            labels.trailingAnchor.constraint(lessThanOrEqualTo: chevron.leadingAnchor, constant: -10),
            chevron.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -17),
            chevron.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        return button
    }

    private func makeActionRow(_ first: NSButton, _ second: NSButton) -> NSView {
        // Do not use an NSStackView here. Borderless NSButtons with custom child views
        // have no useful intrinsic height, so stack alignment can place their content on
        // the row boundary (and make the separator run through the labels). Pin both
        // buttons to the row edges explicitly so each tile owns its complete hit area.
        let row = NSView()
        first.translatesAutoresizingMaskIntoConstraints = false
        second.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(first)
        row.addSubview(second)
        NSLayoutConstraint.activate([
            first.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            first.trailingAnchor.constraint(equalTo: row.centerXAnchor),
            first.topAnchor.constraint(equalTo: row.topAnchor),
            first.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            second.leadingAnchor.constraint(equalTo: row.centerXAnchor),
            second.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            second.topAnchor.constraint(equalTo: row.topAnchor),
            second.bottomAnchor.constraint(equalTo: row.bottomAnchor),
        ])
        return row
    }

    private func makeQuickAction(_ title: String, detail: String, symbol: String, action: Selector) -> NSButton {
        let button = ControlCenterActionButton(title: "", target: self, action: action)
        button.sendAction(on: .leftMouseUp)
        button.bezelStyle = .regularSquare
        button.isBordered = false
        button.focusRingType = .none
        button.toolTip = title

        let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: title) ?? NSImage())
        icon.contentTintColor = Self.primaryGreen
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 19).isActive = true

        let labels = NSStackView()
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        labels.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 12, weight: .semibold)
        heading.textColor = .labelColor
        let subheading = NSTextField(labelWithString: detail)
        subheading.font = .systemFont(ofSize: 9.5, weight: .regular)
        subheading.textColor = .secondaryLabelColor
        labels.addArrangedSubview(heading)
        labels.addArrangedSubview(subheading)

        let chevron = NSImageView(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil) ?? NSImage())
        chevron.contentTintColor = .tertiaryLabelColor
        chevron.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold)
        chevron.translatesAutoresizingMaskIntoConstraints = false

        let content = ControlCenterButtonContentView()
        content.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(content)
        content.addSubview(icon)
        content.addSubview(labels)
        content.addSubview(chevron)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            content.topAnchor.constraint(equalTo: button.topAnchor),
            content.bottomAnchor.constraint(equalTo: button.bottomAnchor),
            icon.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 13),
            icon.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            labels.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            labels.trailingAnchor.constraint(lessThanOrEqualTo: chevron.leadingAnchor, constant: -6),
            chevron.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -11),
            chevron.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        return button
    }

    private func makeSeparator() -> NSView {
        let separator = NSView()
        separator.wantsLayer = true
        separator.layer?.backgroundColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
        separator.translatesAutoresizingMaskIntoConstraints = false
        return separator
    }

    private func makeDisableButton() -> NSButton {
        let button = NSButton(title: L("停用远程", "Disable remote"), target: self, action: #selector(controlCenterDisableTapped))
        button.bezelStyle = .inline
        button.isBordered = false
        button.focusRingType = .none
        button.font = .systemFont(ofSize: 10.5, weight: .medium)
        button.contentTintColor = .systemRed
        return button
    }
}

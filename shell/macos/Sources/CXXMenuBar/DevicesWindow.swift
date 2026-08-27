import AppKit

// The paired-devices window lists browser credentials and lets the user manually
// group known browser identities as one physical phone. Grouping is presentation-only:
// credentials remain independent, so an incorrect grouping never revokes another phone.
extension AppDelegate {
    func showDevices(_ devices: [[String: Any]]) {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let fullConnected = devices.filter {
            ($0["role"] as? String) != "viewer" && (($0["lastSeenAt"] as? NSNumber)?.doubleValue ?? 0) > 0
        }
        if fullConnected.count >= 2 {
            let section = NSTextField(labelWithString: L("把浏览器归为同一台手机", "Group browsers as one phone"))
            section.font = .boldSystemFont(ofSize: 13)
            let hint = NSTextField(wrappingLabelWithString: L(
                "只在这里合并展示，不会合并凭据、不撤销设备。建议把同一部手机的微信/QQ/Chrome 归到一起；不确定的设备先不要合并。",
                "This only groups the display. Credentials stay independent and no device is revoked. Group WeChat/QQ/Chrome only when you know they are on the same phone.",
            ))
            hint.font = .systemFont(ofSize: 11)
            hint.textColor = .secondaryLabelColor
            hint.translatesAutoresizingMaskIntoConstraints = false
            hint.widthAnchor.constraint(equalToConstant: 350).isActive = true

            let primary = NSPopUpButton(frame: .zero, pullsDown: false)
            let member = NSPopUpButton(frame: .zero, pullsDown: false)
            for d in fullConnected {
                let id = d["deviceId"] as? String ?? "?"
                let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("设备 \(id.prefix(6))", "Device \(id.prefix(6))")
                let title = "\(name)  #\(id.prefix(6))"
                primary.addItem(withTitle: title)
                primary.lastItem?.representedObject = id
                member.addItem(withTitle: title)
                member.lastItem?.representedObject = id
            }
            if member.numberOfItems > 1 { member.selectItem(at: 1) }
            primary.translatesAutoresizingMaskIntoConstraints = false
            member.translatesAutoresizingMaskIntoConstraints = false
            primary.widthAnchor.constraint(equalToConstant: 350).isActive = true
            member.widthAnchor.constraint(equalToConstant: 350).isActive = true
            deviceGroupPrimaryPopup = primary
            deviceGroupMemberPopup = member

            let groupName = NSTextField()
            groupName.placeholderString = L("手机显示名称（可选，例如：荣耀手机）", "Phone label (optional, e.g. Honor phone)")
            groupName.translatesAutoresizingMaskIntoConstraints = false
            groupName.widthAnchor.constraint(equalToConstant: 350).isActive = true
            deviceGroupNameField = groupName

            let merge = NSButton(title: L("合并为同一手机", "Group as one phone"), target: self, action: #selector(groupDevicesTapped))
            stack.addArrangedSubview(section)
            stack.addArrangedSubview(hint)
            stack.addArrangedSubview(NSTextField(labelWithString: L("主设备", "Primary device")))
            stack.addArrangedSubview(primary)
            stack.addArrangedSubview(NSTextField(labelWithString: L("同一手机的另一个浏览器", "Another browser on the same phone")))
            stack.addArrangedSubview(member)
            stack.addArrangedSubview(groupName)
            stack.addArrangedSubview(merge)
            stack.addArrangedSubview(NSBox())
        }

        if devices.isEmpty {
            stack.addArrangedSubview(NSTextField(labelWithString: L("暂无已配对设备", "No paired devices")))
        }
        for d in devices {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 10
            row.alignment = .centerY
            let id = d["deviceId"] as? String ?? "?"
            let isViewer = (d["role"] as? String) == "viewer"
            let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("设备 \(id.prefix(6))", "Device \(id.prefix(6))")
            let groupName = d["phoneGroupName"] as? String
            let isGrouped = !isViewer && !(groupName?.isEmpty ?? true)

            let titleText: String
            if isViewer {
                titleText = L("🔗 \(name)（只读）", "🔗 \(name) (read-only)")
            } else if let groupName, !groupName.isEmpty {
                titleText = L("📱 \(groupName) · \(name)", "📱 \(groupName) · \(name)")
            } else {
                titleText = name
            }
            let title = NSTextField(labelWithString: titleText)
            let idTag = "#\(id.prefix(6))"
            let subtitle: String
            if isViewer {
                let expiry: String
                if let exp = (d["expiresAt"] as? NSNumber)?.doubleValue, exp > 0 {
                    expiry = exp <= Date().timeIntervalSince1970 * 1000
                        ? L("已过期", "expired") : L("至 \(formatEpochMs(exp) ?? "-")", "until \(formatEpochMs(exp) ?? "-")")
                } else {
                    expiry = L("永久", "permanent")
                }
                let viewers = (d["viewers"] as? NSNumber)?.intValue ?? 0
                let watching = viewers > 0 ? L("\(viewers) 人正在围观", "\(viewers) watching") : L("暂无人围观", "no viewers")
                subtitle = "\(expiry) · \(watching) · \(idTag)"
            } else if let seen = formatEpochMs((d["lastSeenAt"] as? NSNumber)?.doubleValue) {
                let groupPrefix = isGrouped ? L("同一手机组 · ", "Grouped phone · ") : ""
                subtitle = L("\(groupPrefix)最近连接：\(seen) · \(idTag)", "\(groupPrefix)Last seen: \(seen) · \(idTag)")
            } else if let made = formatEpochMs((d["createdAt"] as? NSNumber)?.doubleValue) {
                subtitle = L("从未连接（配对于 \(made)） · \(idTag)", "Never connected (paired \(made)) · \(idTag)")
            } else {
                subtitle = L("从未连接 · \(idTag)", "Never connected · \(idTag)")
            }
            let sub = NSTextField(labelWithString: subtitle)
            sub.font = .systemFont(ofSize: 11)
            sub.textColor = .secondaryLabelColor
            let col = NSStackView(views: [title, sub])
            col.orientation = .vertical
            col.alignment = .leading
            col.spacing = 2
            col.translatesAutoresizingMaskIntoConstraints = false
            col.widthAnchor.constraint(equalToConstant: 220).isActive = true

            let btn = NSButton(title: isViewer ? L("撤销", "Revoke") : L("移除", "Remove"), target: self, action: #selector(revokeTapped(_:)))
            btn.identifier = NSUserInterfaceItemIdentifier(id)
            row.addArrangedSubview(col)
            if isGrouped {
                let ungroup = NSButton(title: L("解除", "Ungroup"), target: self, action: #selector(ungroupTapped(_:)))
                ungroup.identifier = NSUserInterfaceItemIdentifier(id)
                row.addArrangedSubview(ungroup)
            }
            row.addArrangedSubview(btn)
            stack.addArrangedSubview(row)
        }

        // 「从未连接」= 生成过但没人扫过的链接（lastSeenAt 空）。给一键清理，作废这些悬空令牌。
        // 新版默认二维码只在实际连接后建记录；此入口仅用于清理历史版本留下的条目。
        let unused = devices.filter {
            (($0["lastSeenAt"] as? NSNumber)?.doubleValue ?? 0) <= 0 && ($0["role"] as? String) != "viewer"
        }.count
        var extra = fullConnected.count >= 2 ? 205 : 0
        if unused > 0 {
            let tip = NSTextField(labelWithString: L("有 \(unused) 条历史从未连接的链接", "\(unused) historical link(s) never connected"))
            tip.font = .systemFont(ofSize: 11)
            tip.textColor = .secondaryLabelColor
            let prune = NSButton(title: L("清理从未连接的链接（\(unused)）", "Clean up unused (\(unused))"), target: self, action: #selector(pruneUnusedTapped))
            prune.bezelStyle = .rounded
            stack.addArrangedSubview(tip)
            stack.addArrangedSubview(prune)
            extra += 56
        }
        let w = makeWindow(L("已配对设备", "Devices"), stack, width: 400, height: max(160, CGFloat(60 + devices.count * 50 + extra)))
        w.identifier = Self.devicesWindowID
    }

    @objc func groupDevicesTapped() {
        guard let primary = deviceGroupPrimaryPopup?.selectedItem?.representedObject as? String,
              let member = deviceGroupMemberPopup?.selectedItem?.representedObject as? String else { return }
        let name = deviceGroupNameField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let result = backendWithInput("device-group", ["primaryId": primary, "memberId": member, "name": name])
        guard result["ok"] as? Bool == true else {
            alert(L("未合并", "Not grouped"), "\(result["error"] ?? L("请检查所选设备。", "Check the selected devices."))"); return
        }
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
    }

    @objc func ungroupTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let result = backend(["device-ungroup", "--", id])
        guard result["ok"] as? Bool == true else {
            alert(L("未解除", "Not ungrouped"), "\(result["error"] ?? L("操作失败。", "Operation failed."))"); return
        }
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
    }

    @objc func revokeTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        backend(["revoke", "--", id])
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
    }

    @objc func pruneUnusedTapped() {
        let a = NSAlert()
        a.messageText = L("清理从未连接的链接", "Clean up unused links")
        a.informativeText = L(
            "将移除所有“生成过但从未连接”的历史链接，作废这些悬空凭据。不影响任何已连接过的设备。新版扫码二维码不会再产生这类记录。",
            "Removes historical links that were generated but never connected, voiding dangling credentials. Devices that have connected are unaffected. New QR codes no longer create these records.")
        a.addButton(withTitle: L("清理", "Clean up"))
        a.addButton(withTitle: L("取消", "Cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let res = backend(["prune-unused"])
        let removed = res["removed"] as? Int ?? 0
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
        alert(L("已清理", "Cleaned up"), L("已作废 \(removed) 条从未使用的历史链接。", "Voided \(removed) historical unused link(s)."))
    }

    static let devicesWindowID = NSUserInterfaceItemIdentifier("cxx.devices")
    func closeDevicesWindows() {
        for w in windows where w.identifier == Self.devicesWindowID { w.close() }
    }
}

import AppKit

// 京Me机器人通知设置。产品已收敛为唯一渠道：输入接收人的 ERP 即可；机器人凭据
// 只保存在本机 daemon.json，界面和仓库均不展示、不保存这些敏感值。
extension AppDelegate {
    func showNotify() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)

        let title = NSTextField(labelWithString: L("京Me机器人通知", "JingMe robot notifications"))
        title.font = .boldSystemFont(ofSize: 15)
        let hint = NSTextField(labelWithString: L(
            "填写不同 ERP 后点“添加接收人”。任务通知会发给下方全部已配置 ERP；测试仅发送给当前输入的 ERP。",
            "Add each recipient ERP below. Task, approval, and terminal alerts go to every configured ERP; tests go only to the ERP currently entered.",
        ))
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 12)
        hint.maximumNumberOfLines = 2
        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.widthAnchor.constraint(equalToConstant: 360).isActive = true

        let field = NSTextField()
        field.placeholderString = L("接收通知的 ERP，例如 tanchuxiong.1", "Recipient ERP, e.g. tanchuxiong.1")
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: 360).isActive = true
        notifyField = field

        let addBtn = NSButton(title: L("添加接收人", "Add recipient"), target: self, action: #selector(notifyAddTapped))
        let testBtn = NSButton(title: L("测试当前 ERP", "Test current ERP"), target: self, action: #selector(notifyTestTapped))
        let btnRow = NSStackView(views: [addBtn, testBtn])
        btnRow.spacing = 10

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(hint)
        stack.addArrangedSubview(field)
        stack.addArrangedSubview(btnRow)
        stack.addArrangedSubview(NSTextField(labelWithString: L("已配置接收人", "Configured recipients:")))

        let list = backend(["notify-list"])["notifiers"] as? [[String: Any]] ?? []
        for n in list {
            let label = n["label"] as? String ?? ""
            let idx = n["index"] as? Int ?? 0
            let row = NSStackView()
            row.spacing = 10
            let l = NSTextField(labelWithString: label)
            l.translatesAutoresizingMaskIntoConstraints = false
            l.widthAnchor.constraint(equalToConstant: 170).isActive = true
            let test = NSButton(title: L("测试", "Test"), target: self, action: #selector(notifyTestRowTapped(_:)))
            test.identifier = NSUserInterfaceItemIdentifier(String(idx))
            let rm = NSButton(title: L("删除", "Remove"), target: self, action: #selector(notifyRemoveTapped(_:)))
            rm.identifier = NSUserInterfaceItemIdentifier(String(idx))
            row.addArrangedSubview(l)
            row.addArrangedSubview(test)
            row.addArrangedSubview(rm)
            stack.addArrangedSubview(row)
        }

        let w = makeWindow(L("京Me通知", "JingMe notifications"), stack, width: 410, height: max(230, CGFloat(205 + list.count * 34)))
        w.identifier = Self.notifyWindowID
    }

    private func currentNotifyPayload() -> [String: Any]? {
        guard let field = notifyField else { return nil }
        let erp = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return erp.isEmpty ? nil : ["type": "jingme", "erp": erp]
    }

    @objc func notifyAddTapped() {
        guard let payload = currentNotifyPayload() else {
            alert(L("请填写 ERP", "ERP required"), L("请填入接收通知的 ERP。", "Enter the recipient ERP.")); return
        }
        let result = backendWithInput("notify-add", payload)
        guard result["ok"] as? Bool == true else {
            alert(L("添加失败", "Could not add"), "\(result["error"] ?? L("请检查 ERP 和本机机器人配置。", "Check the ERP and local robot configuration."))"); return
        }
        closeNotifyWindows()
        showNotify()
    }

    // 顶部测试只发给输入框里的 ERP，不落盘。
    @objc func notifyTestTapped() {
        guard let payload = currentNotifyPayload() else {
            alert(L("请填写 ERP", "ERP required"), L("请先填入 ERP 再发送测试。", "Enter an ERP before sending a test.")); return
        }
        let result = backendWithInput("notify-test", payload)
        guard result["ok"] as? Bool == true else {
            alert(L("未发送", "Not sent"), "\(result["error"] ?? L("京Me机器人发送失败，请检查本机网络和机器人配置。", "JingMe delivery failed; check the local network and robot configuration."))"); return
        }
        alert(L("已发送", "Sent"), L("已向该 ERP 发送京Me测试通知，请检查京Me。", "A JingMe test was sent to this ERP."))
    }

    @objc func notifyTestRowTapped(_ sender: NSButton) {
        guard let idx = sender.identifier?.rawValue else { return }
        let result = backend(["notify-test-index", idx])
        guard result["ok"] as? Bool == true else {
            alert(L("未发送", "Not sent"), "\(result["error"] ?? L("京Me机器人发送失败，请检查本机网络和机器人配置。", "JingMe delivery failed; check the local network and robot configuration."))"); return
        }
        alert(L("已发送", "Sent"), L("已发送京Me测试通知，请检查京Me。", "A JingMe test was sent."))
    }

    @objc func notifyRemoveTapped(_ sender: NSButton) {
        guard let idx = sender.identifier?.rawValue else { return }
        backend(["notify-remove", idx])
        closeNotifyWindows()
        showNotify()
    }

    static let notifyWindowID = NSUserInterfaceItemIdentifier("cxx.notify")
    func closeNotifyWindows() {
        for w in windows where w.identifier == Self.notifyWindowID { w.close() }
    }
}

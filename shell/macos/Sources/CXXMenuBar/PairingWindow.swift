import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

// Native pairing QR window. The primary flow creates a long-lived personal link:
// reopening the same link authenticates the same device credential. A separate temporary
// QR remains available for one-time pairing within five minutes.
extension AppDelegate {
    func showQR(_ url: String, permanent: Bool = false) {
        qrPermURL = url
        qrIsPermanent = permanent

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 26, left: 28, bottom: 26, right: 28)

        let title = NSTextField(labelWithString: permanent
            ? L("配对一台新手机", "Pair a new phone")
            : L("临时配对口袋Agent", "Temporarily pair Pocket Agent"))
        title.font = .boldSystemFont(ofSize: 20)

        let statusLabel = NSTextField(labelWithString: permanent
            ? L("● 长期配对 · 链接长期有效", "● Persistent pairing · link does not expire")
            : L("● 临时连接 · 5 分钟内仅可使用一次", "● Temporary · one use within 5 minutes"))
        statusLabel.textColor = permanent ? .systemGreen : .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)

        // QR rests on a stable white card: CIQRCodeGenerator produces transparent
        // pixels, so a white background keeps it scannable in both appearance modes.
        let qrSize: CGFloat = 288
        let qrPad: CGFloat = 16
        let qrCard = NSView()
        qrCard.wantsLayer = true
        qrCard.layer?.backgroundColor = NSColor.white.cgColor
        qrCard.layer?.cornerRadius = 14
        qrCard.translatesAutoresizingMaskIntoConstraints = false
        qrCard.widthAnchor.constraint(equalToConstant: qrSize + qrPad * 2).isActive = true
        qrCard.heightAnchor.constraint(equalToConstant: qrSize + qrPad * 2).isActive = true
        let imgView = NSImageView()
        imgView.image = makeQRImage(url, size: qrSize)
        imgView.translatesAutoresizingMaskIntoConstraints = false
        qrCard.addSubview(imgView)
        imgView.centerXAnchor.constraint(equalTo: qrCard.centerXAnchor).isActive = true
        imgView.centerYAnchor.constraint(equalTo: qrCard.centerYAnchor).isActive = true
        imgView.widthAnchor.constraint(equalToConstant: qrSize).isActive = true
        imgView.heightAnchor.constraint(equalToConstant: qrSize).isActive = true

        let note = NSTextField(labelWithString: permanent
            ? L("此链接包含长期设备凭据，只供本人使用。重复打开同一链接不会新增设备；如有泄露，请在“已配对设备”中撤销。", "This link contains a persistent device credential for personal use. Reopening the same link does not add another device; revoke it in Devices if exposed.")
            : L("该二维码仅可使用一次，5 分钟后失效。手机完成连接后会保存自己的长期凭据。", "This QR can be used once and expires in 5 minutes. After connecting, the phone saves its own persistent credential."))
        note.textColor = permanent ? .systemOrange : .secondaryLabelColor
        note.alignment = .center
        note.font = .systemFont(ofSize: 13)
        note.maximumNumberOfLines = 3
        note.translatesAutoresizingMaskIntoConstraints = false
        note.widthAnchor.constraint(equalToConstant: 340).isActive = true

        let copyTitle = permanent ? L("复制长期配对链接", "Copy persistent pairing link") : L("复制临时配对链接", "Copy temporary pairing link")
        let copyBtn = NSButton(title: copyTitle, target: self, action: #selector(copyPairLink(_:)))
        copyBtn.bezelStyle = .rounded
        copyBtn.font = .systemFont(ofSize: 14, weight: .medium)
        copyBtn.toolTip = permanent
            ? L("链接含长期设备凭据，只供本人使用，请勿分享", "The link contains a persistent device credential; keep it private")
            : L("复制后在 5 分钟内打开并完成一次配对", "Open and finish pairing within 5 minutes")
        copyBtn.translatesAutoresizingMaskIntoConstraints = false
        copyBtn.widthAnchor.constraint(equalToConstant: 220).isActive = true

        let alternateTitle = permanent ? L("改用临时二维码", "Use a temporary QR") : L("生成长期二维码", "Generate a persistent QR")
        let alternateBtn = NSButton(title: alternateTitle, target: self, action: #selector(switchPairingMode(_:)))
        alternateBtn.bezelStyle = .rounded
        alternateBtn.font = .systemFont(ofSize: 13)

        let row = NSStackView(views: [copyBtn, alternateBtn])
        row.spacing = 10

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(statusLabel)
        stack.setCustomSpacing(10, after: title)
        stack.addArrangedSubview(qrCard)
        stack.addArrangedSubview(note)
        stack.addArrangedSubview(row)
        let window = makeWindow(L("扫码配对口袋Agent", "Pair Pocket Agent"), stack, width: 400, height: 520)
        window.identifier = Self.pairWindowID
    }

    @objc func copyPairLink(_ sender: NSButton) {
        copyToPasteboard(qrPermURL)
        flashCopied(sender, restore: qrIsPermanent
            ? L("复制长期配对链接", "Copy persistent pairing link")
            : L("复制临时配对链接", "Copy temporary pairing link"))
    }

    @objc func switchPairingMode(_ sender: NSButton) {
        let permanent = !qrIsPermanent
        let command = permanent ? "pair-permanent" : "pair"
        let res = backend([command])
        guard let url = res["url"] as? String else {
            alert(L("生成失败", "Failed"), "\(res["error"] ?? L("未知错误", "Unknown error"))"); return
        }
        closePairWindows()
        showQR(url, permanent: permanent)
    }

    // 复制后短暂把按钮标题变为「已复制 ✓」再复原。
    func flashCopied(_ button: NSButton, restore: String) {
        button.title = L("已复制 ✓", "Copied ✓")
        button.isEnabled = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            button.title = restore
            button.isEnabled = true
        }
    }

    static let pairWindowID = NSUserInterfaceItemIdentifier("cxx.pair")
    func closePairWindows() {
        for w in windows where w.identifier == Self.pairWindowID { w.close() }
    }
}

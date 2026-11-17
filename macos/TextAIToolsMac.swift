import Cocoa
import Carbon
import ApplicationServices

let TAIT_MAGIC_USERDATA: Int64 = 0x54414954 // "TAIT"
let NX_DEVICERCMDKEYMASK: UInt64 = 0x00000010 // Right Command key mask

final class InlineActionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class WorkerBridge {
    private var process: Process?
    private var stdinHandle: FileHandle?
    private let lock = NSLock()
    private var pendingCallbacks: [Int: ([String: Any]) -> Void] = [:]
    private var nextId: Int = 1
    private var stdoutBuffer = Data()
    private let rootDir: String

    init(rootDir: String) {
        self.rootDir = rootDir
        start()
    }

    private func findNodePath() -> String {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        return "/opt/homebrew/bin/node"
    }

    func start() {
        let nodePath = findNodePath()
        let workerScript = (rootDir as NSString).appendingPathComponent("macos/engine-worker.mjs")
        guard FileManager.default.fileExists(atPath: workerScript) else {
            NSLog("TextAIToolsMac: worker script not found at %@", workerScript)
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [workerScript]
        proc.currentDirectoryURL = URL(fileURLWithPath: rootDir)

        let inPipe = Pipe()
        let outPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.standardError

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            self?.handleStdoutData(data)
        }

        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self?.start()
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.stdinHandle = inPipe.fileHandleForWriting
        } catch {
            NSLog("TextAIToolsMac: failed to launch node worker: %@", error.localizedDescription)
        }
    }

    private func handleStdoutData(_ data: Data) {
        lock.lock()
        stdoutBuffer.append(data)
        while let newlineRange = stdoutBuffer.range(of: Data([0x0A])) {
            let lineData = stdoutBuffer.subdata(in: 0..<newlineRange.lowerBound)
            stdoutBuffer.removeSubrange(0...newlineRange.lowerBound)
            if lineData.isEmpty { continue }
            if let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
               let id = obj["id"] as? Int,
               let cb = pendingCallbacks.removeValue(forKey: id) {
                lock.unlock()
                cb(obj)
                lock.lock()
            }
        }
        lock.unlock()
    }

    func sendSync(_ payload: [String: Any], timeoutMs: Int = 25) -> [String: Any]? {
        let sem = DispatchSemaphore(value: 0)
        var result: [String: Any]?
        sendAsync(payload) { res in
            result = res
            sem.signal()
        }
        let waitRes = sem.wait(timeout: .now() + .milliseconds(timeoutMs))
        if waitRes == .timedOut {
            return nil
        }
        return result
    }

    func sendAsync(_ payload: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        lock.lock()
        guard let stdin = stdinHandle else {
            lock.unlock()
            return
        }
        let id = nextId
        nextId += 1
        var body = payload
        body["id"] = id
        pendingCallbacks[id] = completion
        lock.unlock()

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }
        var line = jsonData
        line.append(0x0A)
        stdin.write(line)
    }

    func stop() {
        process?.terminate()
        process = nil
        stdinHandle = nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var worker: WorkerBridge!
    private var eventTap: CFMachPort?

    private var autoCorrectEnabled = true
    private var skipBrowsers = true
    private var wordBuffer = ""
    private var contextTokens: [String] = []
    private var lastAppBundleId = ""

    private struct UndoRecord {
        let originalWord: String
        let correctedWord: String
        let boundaryChar: String
        let timestamp: Date
    }
    private var lastUndo: UndoRecord?

    private let ignoredTerminals: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "io.alacritty",
        "com.mitchellh.ghostty"
    ]
    private let browserBundleIds: Set<String> = [
        "com.google.Chrome",
        "com.operasoftware.Opera",
        "com.operasoftware.OperaGX",
        "com.brave.Browser",
        "com.microsoft.edgemac"
    ]
    private let boundaryChars: Set<Character> = [" ", "\n", "\r", ".", ",", "!", "?", ";", ":"]

    private var toggleItem: NSMenuItem!
    private var skipBrowsersItem: NSMenuItem!
    private var statusMenuItem: NSMenuItem!
    private var retryTimer: Timer?
    private var actionPanel: InlineActionPanel?
    private var savedFrontApp: NSRunningApplication?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rootDir = (Bundle.main.object(forInfoDictionaryKey: "TextAIToolsRootDir") as? String)
            ?? FileManager.default.currentDirectoryPath
        worker = WorkerBridge(rootDir: rootDir)

        setupMenuBar()
        requestAccessibilityIfNeeded()
        startEventTap()
        if eventTap == nil {
            retryTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if self.eventTap == nil {
                    self.startEventTap()
                } else {
                    self.retryTimer?.invalidate()
                    self.retryTimer = nil
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        worker?.stop()
    }

    private func makeHandPenMenuBarImage() -> NSImage {
        let size = NSSize(width: 20, height: 18)
        let img = NSImage(size: size, flipped: false) { _ in
            NSColor.labelColor.setStroke()
            NSColor.labelColor.setFill()

            // Pen angled down-left
            let pen = NSBezierPath()
            pen.lineWidth = 1.4
            pen.lineCapStyle = .round
            pen.lineJoinStyle = .round
            pen.move(to: NSPoint(x: 3.4, y: 4.5))
            pen.line(to: NSPoint(x: 5.1, y: 5.5))
            pen.line(to: NSPoint(x: 9.8, y: 14.3))
            pen.line(to: NSPoint(x: 8.3, y: 15.1))
            pen.line(to: NSPoint(x: 3.6, y: 6.3))
            pen.close()
            pen.stroke()

            // Hand + wrist cuff on the right
            let hand = NSBezierPath()
            hand.lineWidth = 1.4
            hand.lineCapStyle = .round
            hand.lineJoinStyle = .round
            // Upper hand curve to cuff
            hand.move(to: NSPoint(x: 9.3, y: 13.0))
            hand.curve(to: NSPoint(x: 15.2, y: 11.8),
                       controlPoint1: NSPoint(x: 11.4, y: 12.6),
                       controlPoint2: NSPoint(x: 13.4, y: 11.8))
            // Lower palm & thumb grip
            hand.move(to: NSPoint(x: 4.9, y: 7.4))
            hand.curve(to: NSPoint(x: 9.8, y: 8.4),
                       controlPoint1: NSPoint(x: 6.4, y: 8.2),
                       controlPoint2: NSPoint(x: 8.2, y: 8.4))
            hand.move(to: NSPoint(x: 5.6, y: 6.2))
            hand.curve(to: NSPoint(x: 15.2, y: 7.4),
                       controlPoint1: NSPoint(x: 8.8, y: 5.6),
                       controlPoint2: NSPoint(x: 12.6, y: 7.4))
            // Cuff rectangle
            hand.move(to: NSPoint(x: 15.2, y: 6.6))
            hand.line(to: NSPoint(x: 17.6, y: 6.6))
            hand.line(to: NSPoint(x: 17.6, y: 12.6))
            hand.line(to: NSPoint(x: 15.2, y: 12.6))
            hand.close()
            hand.stroke()

            // Wavy line underneath
            let wave = NSBezierPath()
            wave.lineWidth = 1.4
            wave.lineCapStyle = .round
            wave.move(to: NSPoint(x: 2.4, y: 2.3))
            wave.curve(to: NSPoint(x: 6.2, y: 2.3),
                       controlPoint1: NSPoint(x: 3.6, y: 1.1),
                       controlPoint2: NSPoint(x: 5.0, y: 3.5))
            wave.curve(to: NSPoint(x: 10.0, y: 2.3),
                       controlPoint1: NSPoint(x: 7.4, y: 1.1),
                       controlPoint2: NSPoint(x: 8.8, y: 3.5))
            wave.stroke()
            return true
        }
        img.isTemplate = true
        return img
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = makeHandPenMenuBarImage()
        statusItem.button?.imagePosition = .imageLeading

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "Text AI Tools — Initializing…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem.separator())

        toggleItem = NSMenuItem(title: "Auto-Correct Enabled", action: #selector(toggleAutoCorrect), keyEquivalent: "")
        toggleItem.state = .on
        menu.addItem(toggleItem)

        skipBrowsersItem = NSMenuItem(title: "Skip Chrome/Opera (Use Browser Extension)", action: #selector(toggleSkipBrowsers), keyEquivalent: "")
        skipBrowsersItem.state = .on
        menu.addItem(skipBrowsersItem)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Set Gemini API Key…", action: #selector(promptApiKey), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Check / Retry Permissions", action: #selector(checkAccessibility), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    @objc private func toggleAutoCorrect() {
        autoCorrectEnabled.toggle()
        toggleItem.state = autoCorrectEnabled ? .on : .off
        statusItem.button?.appearsDisabled = !autoCorrectEnabled
        wordBuffer = ""
        lastUndo = nil
    }

    @objc private func toggleSkipBrowsers() {
        skipBrowsers.toggle()
        skipBrowsersItem.state = skipBrowsers ? .on : .off
        wordBuffer = ""
    }

    @objc private func promptApiKey() {
        _ = promptAndSaveApiKeyToKeychain()
    }

    @discardableResult
    private func promptAndSaveApiKeyToKeychain() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Gemini API Key"
        alert.informativeText = "Saved securely in your macOS Keychain (TextAITools-Gemini-API-Key). Never stored in plaintext."
        alert.addButton(withTitle: "Save to Keychain")
        alert.addButton(withTitle: "Cancel")

        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.placeholderString = "AIza..."
        alert.accessoryView = input

        if alert.runModal() == .alertFirstButtonReturn {
            let key = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                _ = worker.sendSync(["type": "setConfig", "apiKey": key], timeoutMs: 1000)
                return true
            }
        }
        return false
    }

    @objc private func checkAccessibility() {
        let trusted = AXIsProcessTrusted()
        if !trusted {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
        if #available(macOS 10.15, *) {
            if !CGPreflightListenEventAccess() {
                CGRequestListenEventAccess()
            }
        }
        if eventTap == nil {
            startEventTap()
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        if eventTap != nil && AXIsProcessTrusted() {
            alert.messageText = "System-Wide Auto-Correct Active ✓"
            alert.informativeText = "Accessibility & Keyboard Tap are active. Note: Chrome/Opera are skipped by default so the browser extension handles them."
        } else {
            alert.messageText = "Permission Required"
            alert.informativeText = "In System Settings → Privacy & Security, turn ON 'Text AI Tools' under BOTH Accessibility AND Input Monitoring (Giriş İzleme). If it's already ON, remove it with '-' and re-add ~/Applications/TextAIToolsMac.app."
        }
        alert.runModal()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func requestAccessibilityIfNeeded() {
        if !AXIsProcessTrusted() {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
        if #available(macOS 10.15, *) {
            if !CGPreflightListenEventAccess() {
                CGRequestListenEventAccess()
            }
        }
    }

    private func isFocusedFieldSecure() -> Bool {
        let sys = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            return false
        }
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXRoleAttribute as CFString, &roleRef) == .success,
           let role = roleRef as? String {
            return role == "AXSecureTextField"
        }
        return false
    }

    private func startEventTap() {
        let mask = (1 << CGEventType.keyDown.rawValue) |
                   (1 << CGEventType.leftMouseDown.rawValue) |
                   (1 << CGEventType.rightMouseDown.rawValue)

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { (_, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
                let delegate = Unmanaged<AppDelegate>.fromOpaque(refcon).takeUnretainedValue()
                return delegate.handleCGEvent(type: type, event: event)
            },
            userInfo: refcon
        ) else {
            statusItem.button?.title = "⚠"
            statusMenuItem?.title = "Status: Needs Accessibility / Input Monitoring"
            NSLog("TextAIToolsMac: CGEvent.tapCreate failed — grant Accessibility/Input Monitoring permission and relaunch.")
            return
        }

        self.eventTap = tap
        statusItem.button?.title = ""
        statusItem.button?.appearsDisabled = !autoCorrectEnabled
        statusMenuItem?.title = "Status: Active (System-Wide)"
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handleCGEvent(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }

        if event.getIntegerValueField(.eventSourceUserData) == TAIT_MAGIC_USERDATA {
            return Unmanaged.passUnretained(event)
        }

        if type == .leftMouseDown || type == .rightMouseDown {
            wordBuffer = ""
            lastUndo = nil
            return Unmanaged.passUnretained(event)
        }

        guard type == .keyDown, autoCorrectEnabled else {
            return Unmanaged.passUnretained(event)
        }

        let frontBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        if frontBundle != lastAppBundleId {
            lastAppBundleId = frontBundle
            wordBuffer = ""
            contextTokens = []
            lastUndo = nil
        }

        if ignoredTerminals.contains(frontBundle) || (skipBrowsers && browserBundleIds.contains(frontBundle)) {
            return Unmanaged.passUnretained(event)
        }

        let flags = event.flags
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

        // Global Hotkey: Right Cmd + . (keyCode 47 + NX_DEVICERCMDKEYMASK)
        if keyCode == 47 && flags.contains(.maskCommand) && (flags.rawValue & NX_DEVICERCMDKEYMASK) != 0 &&
           !flags.contains(.maskShift) && !flags.contains(.maskControl) && !flags.contains(.maskAlternate) {
            wordBuffer = ""
            lastUndo = nil
            DispatchQueue.main.async { [weak self] in
                self?.triggerGlobalSelectionMenu()
            }
            return nil
        }

        // Cmd+Z immediate undo after auto-correct
        if flags.contains(.maskCommand) && !flags.contains(.maskShift) && keyCode == 6 /* Z */ {
            if let undo = lastUndo, Date().timeIntervalSince(undo.timestamp) < 12.0 {
                lastUndo = nil
                let deleteCount = undo.correctedWord.count + undo.boundaryChar.count
                replacePreviousChars(deleteCount: deleteCount, with: undo.originalWord + undo.boundaryChar)
                worker.sendAsync(["type": "recordUndo", "originalWord": undo.originalWord, "correctedWord": undo.correctedWord]) { _ in }
                return nil
            }
            wordBuffer = ""
            return Unmanaged.passUnretained(event)
        }

        if flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate) {
            wordBuffer = ""
            lastUndo = nil
            return Unmanaged.passUnretained(event)
        }

        // Navigation / escape keys reset buffer
        let navKeyCodes: Set<Int64> = [48 /* Tab */, 53 /* Esc */, 123, 124, 125, 126 /* Arrows */, 115, 119, 116, 121]
        if navKeyCodes.contains(keyCode) {
            wordBuffer = ""
            lastUndo = nil
            return Unmanaged.passUnretained(event)
        }

        // Backspace
        if keyCode == 51 {
            if let undo = lastUndo, Date().timeIntervalSince(undo.timestamp) < 12.0, wordBuffer.isEmpty {
                lastUndo = nil
                let deleteCount = undo.correctedWord.count + undo.boundaryChar.count
                replacePreviousChars(deleteCount: deleteCount, with: undo.originalWord + undo.boundaryChar)
                worker.sendAsync(["type": "recordUndo", "originalWord": undo.originalWord, "correctedWord": undo.correctedWord]) { _ in }
                return nil
            }
            if !wordBuffer.isEmpty {
                wordBuffer.removeLast()
            }
            return Unmanaged.passUnretained(event)
        }

        // Extract typed Unicode character(s)
        var actualLen = 0
        var chars = [UniChar](repeating: 0, count: 8)
        event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &actualLen, unicodeString: &chars)
        guard actualLen > 0 else {
            return Unmanaged.passUnretained(event)
        }
        let typed = String(utf16CodeUnits: chars, count: actualLen)

        if typed.count == 1, let ch = typed.first, boundaryChars.contains(ch) {
            if wordBuffer.count >= 2 && !isFocusedFieldSecure() {
                let currentWord = wordBuffer
                let appName = frontBundle.isEmpty ? "macos" : frontBundle
                let resp = worker.sendSync([
                    "type": "checkWord",
                    "word": currentWord,
                    "contextTokens": contextTokens,
                    "appName": appName
                ], timeoutMs: 80)

                wordBuffer = ""
                if let resp = resp,
                   let decision = resp["decision"] as? String,
                   decision == "auto_correct",
                   let replacement = resp["replacement"] as? String,
                   replacement != currentWord {
                    pushContextToken(replacement)
                    lastUndo = UndoRecord(
                        originalWord: currentWord,
                        correctedWord: replacement,
                        boundaryChar: typed,
                        timestamp: Date()
                    )
                    replacePreviousChars(deleteCount: currentWord.count, with: replacement + typed)
                    return nil
                } else {
                    pushContextToken(currentWord)
                    lastUndo = nil
                }
            } else {
                wordBuffer = ""
                lastUndo = nil
            }
            return Unmanaged.passUnretained(event)
        }

        // Accumulate word characters (letters, digits, apostrophe, hyphen)
        if typed.range(of: "^[\\p{L}\\p{N}'\\u2019-]+$", options: .regularExpression) != nil {
            lastUndo = nil
            if wordBuffer.count < 48 {
                wordBuffer += typed
            }
        } else {
            wordBuffer = ""
            lastUndo = nil
        }

        return Unmanaged.passUnretained(event)
    }

    private func pushContextToken(_ tok: String) {
        contextTokens.append(tok)
        if contextTokens.count > 12 {
            contextTokens.removeFirst(contextTokens.count - 12)
        }
    }

    private func replacePreviousChars(deleteCount: Int, with replacement: String) {
        let src = CGEventSource(stateID: .privateState)
        for _ in 0..<deleteCount {
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: true),
               let up = CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: false) {
                down.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
                up.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
        }
        let utf16 = Array(replacement.utf16)
        let chunkSize = 16
        var idx = 0
        while idx < utf16.count {
            let end = min(utf16.count, idx + chunkSize)
            var slice = Array(utf16[idx..<end])
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
               let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
                down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
                down.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
                up.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
            idx = end
        }
    }

    // MARK: - Global Hotkey (Right Cmd + .) Selection Menu

    private func postCommandKey(virtualKey: CGKeyCode) {
        let src = CGEventSource(stateID: .privateState)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: virtualKey, keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: virtualKey, keyDown: false) {
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
            up.setIntegerValueField(.eventSourceUserData, value: TAIT_MAGIC_USERDATA)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private func triggerGlobalSelectionMenu() {
        savedFrontApp = NSWorkspace.shared.frontmostApplication
        let pb = NSPasteboard.general
        let prevString = pb.string(forType: .string)
        let prevChangeCount = pb.changeCount

        // Send Cmd+C to copy current selection
        postCommandKey(virtualKey: 8) // 'c'

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { [weak self] in
            guard let self = self else { return }
            let changed = pb.changeCount != prevChangeCount
            let selectedText = (changed ? pb.string(forType: .string) : nil) ?? ""

            // Restore previous clipboard immediately
            if let prev = prevString {
                pb.clearContents()
                pb.setString(prev, forType: .string)
            }

            let trimmed = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                self.showQuickStatusPanel(message: "Select some text first, then press Right ⌘ + .")
                return
            }

            self.showActionMenuPanel(selectedText: selectedText, previousClipboard: prevString)
        }
    }

    private func showQuickStatusPanel(message: String) {
        actionPanel?.close()
        let panel = createPanel(width: 310, height: 64)
        let label = NSTextField(labelWithString: message)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.alignment = .center
        label.frame = NSRect(x: 12, y: 20, width: 286, height: 24)
        panel.contentView?.addSubview(label)
        panel.makeKeyAndOrderFront(nil)
        actionPanel = panel
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak panel] in
            panel?.close()
        }
    }

    private func createPanel(width: CGFloat, height: CGFloat) -> InlineActionPanel {
        let mouse = NSEvent.mouseLocation
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var x = mouse.x - width / 2
        var y = mouse.y - height - 12
        x = max(screenFrame.minX + 12, min(screenFrame.maxX - width - 12, x))
        y = max(screenFrame.minY + 12, min(screenFrame.maxY - height - 12, y))

        let panel = InlineActionPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "✦ Text AI Tools"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        return panel
    }

    private func showActionMenuPanel(selectedText: String, previousClipboard: String?) {
        actionPanel?.close()
        let width: CGFloat = 320
        let height: CGFloat = 176
        let panel = createPanel(width: width, height: height)
        guard let contentView = panel.contentView else { return }

        let actions: [(id: String, title: String, key: String)] = [
            ("fix", "1. Fix Grammar", "1"),
            ("concise", "2. Shorten (Keep Meaning)", "2"),
            ("professional", "3. Professional", "3"),
            ("translate", "4. Translate (TR ↔ EN)", "4"),
            ("summarize", "5. Summarize", "5")
        ]

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.frame = NSRect(x: 14, y: 12, width: width - 28, height: height - 42)

        for act in actions {
            let btn = NSButton(title: act.title, target: nil, action: nil)
            btn.bezelStyle = .rounded
            btn.controlSize = .regular
            btn.widthAnchor.constraint(equalToConstant: width - 28).isActive = true
            btn.keyEquivalent = act.key
            btn.target = ActionTarget.shared
            btn.action = #selector(ActionTarget.handleClick(_:))
            ActionTarget.shared.register(button: btn) { [weak self, weak panel] in
                guard let self = self, let panel = panel else { return }
                self.executePanelAction(
                    actionId: act.id,
                    label: act.title,
                    selectedText: selectedText,
                    previousClipboard: previousClipboard,
                    panel: panel
                )
            }
            stack.addArrangedSubview(btn)
        }

        contentView.addSubview(stack)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        actionPanel = panel
    }

    private func executePanelAction(
        actionId: String,
        label: String,
        selectedText: String,
        previousClipboard: String?,
        panel: InlineActionPanel
    ) {
        panel.contentView?.subviews.forEach { $0.removeFromSuperview() }
        let statusLbl = NSTextField(labelWithString: "Running \(label)…")
        statusLbl.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        statusLbl.frame = NSRect(x: 16, y: (panel.frame.height - 44) / 2, width: panel.frame.width - 32, height: 22)
        panel.contentView?.addSubview(statusLbl)

        worker.sendAsync(["type": "inlineAction", "actionId": actionId, "text": selectedText]) { [weak self] resp in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let ok = (resp["ok"] as? Bool) ?? false
                if !ok {
                    let code = (resp["code"] as? String) ?? ""
                    if code == "MISSING_API_KEY" {
                        panel.close()
                        if self.promptAndSaveApiKeyToKeychain() {
                            let retryPanel = self.createPanel(width: 320, height: 176)
                            retryPanel.makeKeyAndOrderFront(nil)
                            self.actionPanel = retryPanel
                            self.executePanelAction(
                                actionId: actionId,
                                label: label,
                                selectedText: selectedText,
                                previousClipboard: previousClipboard,
                                panel: retryPanel
                            )
                        }
                        return
                    }
                    let err = (resp["error"] as? String) ?? "Gemini request failed."
                    self.showPanelResult(text: err, isError: true, previousClipboard: previousClipboard, panel: panel)
                    return
                }
                let resultText = ((resp["result"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let mode = (resp["mode"] as? String) ?? "modal"
                if mode == "replace" {
                    panel.close()
                    self.pasteReplacement(resultText, restoreClipboard: previousClipboard)
                } else {
                    self.showPanelResult(text: resultText, isError: false, previousClipboard: previousClipboard, panel: panel)
                }
            }
        }
    }

    private func pasteReplacement(_ text: String, restoreClipboard: String?) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        savedFrontApp?.activate(options: [])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            self?.postCommandKey(virtualKey: 9) // 'v'
            if let prev = restoreClipboard {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    pb.clearContents()
                    pb.setString(prev, forType: .string)
                }
            }
        }
    }

    private func showPanelResult(text: String, isError: Bool, previousClipboard: String?, panel: InlineActionPanel) {
        let newWidth: CGFloat = 380
        let newHeight: CGFloat = 230
        var frame = panel.frame
        frame.size = NSSize(width: newWidth, height: newHeight)
        panel.setFrame(frame, display: true)
        guard let contentView = panel.contentView else { return }
        contentView.subviews.forEach { $0.removeFromSuperview() }

        let scroll = NSScrollView(frame: NSRect(x: 12, y: 46, width: newWidth - 24, height: newHeight - 82))
        scroll.hasVerticalScroller = true
        let tv = NSTextView(frame: scroll.bounds)
        tv.isEditable = false
        tv.font = NSFont.systemFont(ofSize: 12.5)
        tv.string = text
        if isError { tv.textColor = .systemRed }
        scroll.documentView = tv
        contentView.addSubview(scroll)

        let copyBtn = NSButton(title: "Copy & Close", target: nil, action: nil)
        copyBtn.bezelStyle = .rounded
        copyBtn.frame = NSRect(x: newWidth - 126, y: 10, width: 114, height: 28)
        copyBtn.keyEquivalent = "\r"
        copyBtn.target = ActionTarget.shared
        copyBtn.action = #selector(ActionTarget.handleClick(_:))
        ActionTarget.shared.register(button: copyBtn) { [weak panel] in
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
            panel?.close()
        }
        contentView.addSubview(copyBtn)

        if !isError {
            let replaceBtn = NSButton(title: "Replace Selection", target: nil, action: nil)
            replaceBtn.bezelStyle = .rounded
            replaceBtn.frame = NSRect(x: 12, y: 10, width: 140, height: 28)
            replaceBtn.target = ActionTarget.shared
            replaceBtn.action = #selector(ActionTarget.handleClick(_:))
            ActionTarget.shared.register(button: replaceBtn) { [weak self, weak panel] in
                panel?.close()
                self?.pasteReplacement(text, restoreClipboard: previousClipboard)
            }
            contentView.addSubview(replaceBtn)
        }
    }
}

final class ActionTarget: NSObject {
    static let shared = ActionTarget()
    private var handlers: [ObjectIdentifier: () -> Void] = [:]

    func register(button: NSButton, handler: @escaping () -> Void) {
        handlers[ObjectIdentifier(button)] = handler
    }

    @objc func handleClick(_ sender: NSButton) {
        handlers[ObjectIdentifier(sender)]?()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

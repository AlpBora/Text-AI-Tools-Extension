import Cocoa
import Carbon
import ApplicationServices

let TAIT_MAGIC_USERDATA: Int64 = 0x54414954 // "TAIT"

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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rootDir = (Bundle.main.object(forInfoDictionaryKey: "TextAIToolsRootDir") as? String)
            ?? FileManager.default.currentDirectoryPath
        worker = WorkerBridge(rootDir: rootDir)

        setupMenuBar()
        requestAccessibilityIfNeeded()
        startEventTap()
    }

    func applicationWillTerminate(_ notification: Notification) {
        worker?.stop()
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "✦"

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
        statusItem.button?.title = autoCorrectEnabled ? "✦" : "✧"
        wordBuffer = ""
        lastUndo = nil
    }

    @objc private func toggleSkipBrowsers() {
        skipBrowsers.toggle()
        skipBrowsersItem.state = skipBrowsers ? .on : .off
        wordBuffer = ""
    }

    @objc private func promptApiKey() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Gemini API Key"
        alert.informativeText = "Stored locally in ~/.text-ai-tools/config.json (chmod 600)."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.placeholderString = "AIza..."
        alert.accessoryView = input

        if alert.runModal() == .alertFirstButtonReturn {
            let key = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                worker.sendAsync(["type": "setConfig", "apiKey": key]) { _ in }
            }
        }
    }

    @objc private func checkAccessibility() {
        let trusted = AXIsProcessTrusted()
        if !trusted {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
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
            alert.informativeText = "Enable Text AI Tools in System Settings → Privacy & Security → Accessibility AND Input Monitoring, then click 'Check / Retry Permissions' (or relaunch)."
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
            statusItem.button?.title = "⚠✦"
            statusMenuItem?.title = "Status: Needs Accessibility / Input Monitoring"
            NSLog("TextAIToolsMac: CGEvent.tapCreate failed — grant Accessibility/Input Monitoring permission and relaunch.")
            return
        }

        self.eventTap = tap
        statusItem.button?.title = autoCorrectEnabled ? "✦" : "✧"
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
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

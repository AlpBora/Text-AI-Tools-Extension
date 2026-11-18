import Cocoa
import Carbon
import ApplicationServices

let TAIT_MAGIC_USERDATA: Int64 = 0x54414954 // "TAIT"
let NX_DEVICERCMDKEYMASK: UInt64 = 0x00000010 // Right Command key mask

final class InlineActionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) {
        close()
    }
}

final class LiquidGlassContainer: NSVisualEffectView {
    private let gradientLayer = CAGradientLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        layer?.borderWidth = 1.0
        layer?.borderColor = NSColor(calibratedRed: 0.35, green: 0.90, blue: 0.96, alpha: 0.38).cgColor

        gradientLayer.colors = [
            NSColor(calibratedRed: 0.04, green: 0.65, blue: 0.78, alpha: 0.56).cgColor,
            NSColor(calibratedRed: 0.04, green: 0.16, blue: 0.42, alpha: 0.68).cgColor
        ]
        gradientLayer.startPoint = CGPoint(x: 0.0, y: 1.0)
        gradientLayer.endPoint = CGPoint(x: 1.0, y: 0.0)
        layer?.insertSublayer(gradientLayer, at: 0)
        maskImage = Self.makeRoundedMaskImage(radius: 16)
    }

    private static func makeRoundedMaskImage(radius: CGFloat) -> NSImage {
        let edge = radius * 2 + 2
        let img = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        img.resizingMode = .stretch
        return img
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        gradientLayer.frame = bounds
    }
}

final class GlassActionButton: NSButton {
    private var tracking: NSTrackingArea?
    private var isHovered = false {
        didSet { updateAppearance() }
    }
    var isPrimaryGlass = false {
        didSet { updateAppearance() }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBordered = false
        wantsLayer = true
        alignment = .left
        font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        contentTintColor = .white
        layer?.cornerRadius = 9
        updateAppearance()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func updateAppearance() {
        if isHovered {
            layer?.backgroundColor = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.90, alpha: 0.42).cgColor
            layer?.borderWidth = 0.8
            layer?.borderColor = NSColor.white.withAlphaComponent(0.45).cgColor
        } else if isPrimaryGlass {
            layer?.backgroundColor = NSColor(calibratedRed: 0.10, green: 0.72, blue: 0.84, alpha: 0.34).cgColor
            layer?.borderWidth = 0.8
            layer?.borderColor = NSColor(calibratedRed: 0.45, green: 0.94, blue: 0.98, alpha: 0.42).cgColor
        } else {
            layer?.backgroundColor = NSColor.white.withAlphaComponent(0.11).cgColor
            layer?.borderWidth = 0.8
            layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        }
    }

    override var title: String {
        didSet { updateAppearance() }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        tracking = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        if let t = tracking { addTrackingArea(t) }
    }

    override func mouseEntered(with event: NSEvent) { isHovered = true }
    override func mouseExited(with event: NSEvent) { isHovered = false }
}

final class WorkerBridge {
    private var process: Process?
    private var stdinHandle: FileHandle?
    private let lock = NSLock()
    private var pendingCallbacks: [Int: ([String: Any]) -> Void] = [:]
    private var nextId: Int = 1
    private var stdoutBuffer = Data()
    private let rootDir: String
    private(set) var startedAt = Date()

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
            self.startedAt = Date()
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
        process?.terminationHandler = nil
        process?.terminate()
        process = nil
        stdinHandle = nil
    }

    func restart() {
        stop()
        lock.lock()
        stdoutBuffer.removeAll()
        pendingCallbacks.removeAll()
        lock.unlock()
        start()
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
    private var hotkeyMenuItem: NSMenuItem!
    private var autoUpdateItem: NSMenuItem!
    private var retryTimer: Timer?
    private var updateTimer: Timer?
    private var lastRemoteFetchAt: Date = .distantPast
    private var rootDir = ""
    private var isUpdating = false
    private var autoUpdateEnabled: Bool = {
        if UserDefaults.standard.object(forKey: "autoUpdateEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "autoUpdateEnabled")
    }()
    private var actionPanel: InlineActionPanel?
    private var savedFrontApp: NSRunningApplication?
    private var mouseMonitor: Any?

    private struct HotkeyConfig {
        var keyCode: Int64 = 47
        var cmd: Bool = true
        var requireRightCmd: Bool = true
        var opt: Bool = false
        var ctrl: Bool = false
        var shift: Bool = false
        var label: String = "Right ⌘ + ."
    }
    private var hotkey = HotkeyConfig()
    private var isRecordingHotkey = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rootDir = (Bundle.main.object(forInfoDictionaryKey: "TextAIToolsRootDir") as? String)
            ?? FileManager.default.currentDirectoryPath
        self.rootDir = rootDir
        worker = WorkerBridge(rootDir: rootDir)

        setupMenuBar()
        loadSavedHotkey()
        requestAccessibilityIfNeeded()
        startMouseMonitor()
        startEventTap()
        startAutoUpdateLoop()
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
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            eventTap = nil
        }
        if let m = mouseMonitor {
            NSEvent.removeMonitor(m)
            mouseMonitor = nil
        }
        worker?.stop()
    }

    private func startMouseMonitor() {
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.wordBuffer = ""
            self?.lastUndo = nil
        }
    }

    private func makeHandPenMenuBarImage() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let img = NSImage(size: size, flipped: false) { _ in
            NSColor.labelColor.setStroke()
            NSColor.labelColor.setFill()

            // Top paper sheet
            let paper = NSBezierPath(roundedRect: NSRect(x: 4.5, y: 11.2, width: 9.0, height: 4.8), xRadius: 0.8, yRadius: 0.8)
            paper.lineWidth = 1.3
            paper.stroke()

            // Typewriter carriage bar
            let carriage = NSBezierPath()
            carriage.lineWidth = 1.4
            carriage.lineCapStyle = .round
            carriage.move(to: NSPoint(x: 2.0, y: 11.2))
            carriage.line(to: NSPoint(x: 16.0, y: 11.2))
            carriage.stroke()

            // Typewriter body
            let body = NSBezierPath(roundedRect: NSRect(x: 2.6, y: 2.4, width: 12.8, height: 7.4), xRadius: 2.0, yRadius: 2.0)
            body.lineWidth = 1.4
            body.stroke()

            // Minimalist key dots + spacebar
            for kx in stride(from: 4.8, through: 13.2, by: 2.8) {
                NSBezierPath(ovalIn: NSRect(x: kx - 0.65, y: 6.4, width: 1.3, height: 1.3)).fill()
            }
            let spacebar = NSBezierPath(roundedRect: NSRect(x: 5.5, y: 3.8, width: 7.0, height: 1.2), xRadius: 0.6, yRadius: 0.6)
            spacebar.fill()
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
        hotkeyMenuItem = NSMenuItem(title: "Shortcut: \(hotkey.label) (Change…)", action: #selector(openShortcutRecorder), keyEquivalent: "")
        menu.addItem(hotkeyMenuItem)
        menu.addItem(NSMenuItem(title: "Set Gemini API Key…", action: #selector(promptApiKey), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Check / Retry Permissions", action: #selector(checkAccessibility), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        autoUpdateItem = NSMenuItem(title: "Auto-Update in Background", action: #selector(toggleAutoUpdate), keyEquivalent: "")
        autoUpdateItem.state = autoUpdateEnabled ? .on : .off
        menu.addItem(autoUpdateItem)
        menu.addItem(NSMenuItem(title: "Check for Updates / Rebuild Now", action: #selector(manualCheckForUpdates), keyEquivalent: ""))
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
        updateTimer?.invalidate()
        updateTimer = nil
        NSApp.terminate(nil)
    }

    @objc private func toggleAutoUpdate() {
        autoUpdateEnabled.toggle()
        UserDefaults.standard.set(autoUpdateEnabled, forKey: "autoUpdateEnabled")
        autoUpdateItem.state = autoUpdateEnabled ? .on : .off
        if autoUpdateEnabled {
            startAutoUpdateLoop()
        } else {
            updateTimer?.invalidate()
            updateTimer = nil
        }
    }

    @objc private func manualCheckForUpdates() {
        checkForUpdates(manual: true)
    }

    private func startAutoUpdateLoop() {
        updateTimer?.invalidate()
        updateTimer = nil
        guard autoUpdateEnabled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15.0) { [weak self] in
            guard let self = self, self.autoUpdateEnabled else { return }
            self.checkForUpdates(manual: false)
        }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 300.0, repeats: true) { [weak self] _ in
            self?.checkForUpdates(manual: false)
        }
    }

    private func fileModDate(_ relativePath: String) -> Date? {
        let full = (rootDir as NSString).appendingPathComponent(relativePath)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: full) else { return nil }
        return attrs[.modificationDate] as? Date
    }

    private func runSyncCommand(_ launchPath: String, _ args: [String], cwd: String) -> (Int32, String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (proc.terminationStatus, out)
        } catch {
            return (-1, error.localizedDescription)
        }
    }

    private func checkForUpdates(manual: Bool) {
        guard !rootDir.isEmpty else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            if self.isUpdating { return }
            self.isUpdating = true
            defer { self.isUpdating = false }

            // 1. Pull origin/main cleanly if working tree has no local edits (at most once per hour unless manual)
            let gitDir = (self.rootDir as NSString).appendingPathComponent(".git")
            let shouldFetchRemote = manual || Date().timeIntervalSince(self.lastRemoteFetchAt) >= 3600.0
            if shouldFetchRemote && FileManager.default.fileExists(atPath: gitDir) {
                self.lastRemoteFetchAt = Date()
                let (stCode, stOut) = self.runSyncCommand("/usr/bin/git", ["status", "--porcelain"], cwd: self.rootDir)
                if stCode == 0 && stOut.isEmpty {
                    let (fetchCode, _) = self.runSyncCommand("/usr/bin/git", ["fetch", "origin", "main", "--quiet"], cwd: self.rootDir)
                    if fetchCode == 0 {
                        let (cntCode, cntOut) = self.runSyncCommand("/usr/bin/git", ["rev-list", "HEAD..origin/main", "--count"], cwd: self.rootDir)
                        if cntCode == 0, let ahead = Int(cntOut), ahead > 0 {
                            _ = self.runSyncCommand("/usr/bin/git", ["pull", "--ff-only", "origin", "main"], cwd: self.rootDir)
                        }
                    }
                }
            }

            // 2. Check if native Swift / icon / build script changed vs running binary
            let exeDate: Date = {
                if let exeURL = Bundle.main.executableURL,
                   let attrs = try? FileManager.default.attributesOfItem(atPath: exeURL.path),
                   let d = attrs[.modificationDate] as? Date {
                    return d
                }
                return Date.distantFuture
            }()

            let nativeFiles = ["macos/TextAIToolsMac.swift", "macos/build.sh", "icons/icon1024.png"]
            let needsRebuild = nativeFiles.contains { rel in
                if let m = self.fileModDate(rel) { return m > exeDate }
                return false
            }

            if needsRebuild {
                self.triggerBackgroundRebuildAndRelaunch()
                return
            }

            // 3. Check if JS worker / engine files changed vs worker start time
            let jsFiles = [
                "macos/engine-worker.mjs",
                "shared/actions.js",
                "content/spellcheck-engine.js",
                "content/turkish-morphology.js",
                "content/turkish-deasciifier.js",
                "content/language-registry.js",
                "content/personal-model.js"
            ]
            let workerDate = self.worker.startedAt
            let needsWorkerRestart = jsFiles.contains { rel in
                if let m = self.fileModDate(rel) { return m > workerDate }
                return false
            }

            if needsWorkerRestart {
                DispatchQueue.main.async {
                    self.worker.restart()
                    if manual {
                        self.showUpdateAlert(title: "Engine Reloaded ✓", message: "Updated JavaScript engine files were reloaded in the background without restarting the app.")
                    }
                }
                return
            }

            if manual {
                DispatchQueue.main.async {
                    self.showUpdateAlert(title: "You're Up to Date ✓", message: "No new updates found in GitHub (origin/main) or local source files.")
                }
            }
        }
    }

    private func showUpdateAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    private func triggerBackgroundRebuildAndRelaunch() {
        let appBundle = Bundle.main.bundleURL.path
        let outDir = (appBundle as NSString).deletingLastPathComponent
        let pid = ProcessInfo.processInfo.processIdentifier

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [
            "-c",
            "nohup /bin/bash -c 'sleep 0.2; if bash \"$TAIT_ROOT/macos/build.sh\" \"$TAIT_OUT\" >/tmp/text-ai-tools-update.log 2>&1; then kill \"$TAIT_PID\" 2>/dev/null || true; sleep 0.4; open \"$TAIT_BUNDLE\"; fi' >/dev/null 2>&1 &"
        ]
        var env = ProcessInfo.processInfo.environment
        env["TAIT_ROOT"] = rootDir
        env["TAIT_OUT"] = outDir
        env["TAIT_BUNDLE"] = appBundle
        env["TAIT_PID"] = "\(pid)"
        proc.environment = env
        try? proc.run()
        proc.waitUntilExit()
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
        AXUIElementSetMessagingTimeout(sys, 0.05)
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            return false
        }
        let axEl = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(axEl, 0.05)
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axEl, kAXRoleAttribute as CFString, &roleRef) == .success,
           let role = roleRef as? String {
            return role == "AXSecureTextField"
        }
        return false
    }

    private func startEventTap() {
        let mask = (1 << CGEventType.keyDown.rawValue)

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

        // Global Hotkey check (customizable, defaults to Right Cmd + .)
        if !isRecordingHotkey && matchesHotkey(keyCode: keyCode, flags: flags, event: event) {
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

    private func getFocusedSelectionScreenRect() -> NSRect? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.05)
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            return nil
        }
        let axEl = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(axEl, 0.05)
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axEl, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
              let rangeVal = rangeRef else {
            return nil
        }
        var boundsRef: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            axEl,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeVal,
            &boundsRef
        ) == .success,
              let boundsVal = boundsRef else {
            return nil
        }
        var axRect = CGRect.zero
        guard AXValueGetValue(boundsVal as! AXValue, .cgRect, &axRect),
              axRect.width > 0 || axRect.height > 0 else {
            return nil
        }
        // Convert top-left AX global coordinates to Cocoa bottom-left screen coordinates
        let primaryHeight = NSScreen.screens.first?.frame.height ?? CGDisplayBounds(CGMainDisplayID()).height
        let cocoaY = primaryHeight - axRect.origin.y - axRect.size.height
        return NSRect(x: axRect.origin.x, y: cocoaY, width: axRect.size.width, height: axRect.size.height)
    }

    private func triggerGlobalSelectionMenu() {
        savedFrontApp = NSWorkspace.shared.frontmostApplication
        let selectionRect = getFocusedSelectionScreenRect()
        let pb = NSPasteboard.general
        let prevString = pb.string(forType: .string)
        let prevChangeCount = pb.changeCount

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
            guard let self = self else { return }
            // Send Cmd+C to copy current selection
            self.postCommandKey(virtualKey: 8) // 'c'

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
                    self.showQuickStatusPanel(message: "Select text first, then press \(self.hotkey.label)", anchorRect: selectionRect)
                    return
                }

                self.showActionMenuPanel(selectedText: selectedText, previousClipboard: prevString, anchorRect: selectionRect)
            }
        }
    }

    private func showQuickStatusPanel(message: String, anchorRect: NSRect?) {
        actionPanel?.close()
        let width: CGFloat = 270
        let height: CGFloat = 46
        let panel = createPanel(width: width, height: height, anchorRect: anchorRect)
        let label = NSTextField(labelWithString: message)
        label.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        label.textColor = .white
        label.alignment = .center
        label.frame = NSRect(x: 10, y: 12, width: width - 20, height: 20)
        panel.contentView?.addSubview(label)
        panel.makeKeyAndOrderFront(nil)
        actionPanel = panel
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak panel] in
            panel?.close()
        }
    }

    private func createPanel(width: CGFloat, height: CGFloat, anchorRect: NSRect? = nil) -> InlineActionPanel {
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var x: CGFloat
        var y: CGFloat
        if let anchor = anchorRect {
            // Align neatly under the bottom-right of the selected text (or left edge for short single-word selections)
            x = max(anchor.minX, anchor.maxX - width)
            y = anchor.minY - height - 14
            if y < screenFrame.minY + 12 {
                // If not enough room below, place neatly above the selected text
                y = anchor.maxY + 14
            }
        } else {
            // Offset away from mouse cursor so it never covers what you're clicking/reading
            let mouse = NSEvent.mouseLocation
            x = mouse.x + 22
            y = mouse.y - height - 24
            if y < screenFrame.minY + 12 {
                y = mouse.y + 20
            }
        }
        x = max(screenFrame.minX + 12, min(screenFrame.maxX - width - 12, x))
        y = max(screenFrame.minY + 12, min(screenFrame.maxY - height - 12, y))

        let panel = InlineActionPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false

        let glass = LiquidGlassContainer(frame: NSRect(x: 0, y: 0, width: width, height: height))
        glass.autoresizingMask = [.width, .height]
        panel.contentView = glass
        return panel
    }

    private func addGlassHeader(to container: NSView, width: CGFloat, height: CGFloat, panel: InlineActionPanel) {
        let titleLbl = NSTextField(labelWithString: "✦ Text AI")
        titleLbl.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        titleLbl.textColor = NSColor.white.withAlphaComponent(0.90)
        titleLbl.frame = NSRect(x: 12, y: height - 26, width: width - 44, height: 16)
        container.addSubview(titleLbl)

        let closeBtn = NSButton(title: "×", target: nil, action: nil)
        closeBtn.isBordered = false
        closeBtn.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        closeBtn.contentTintColor = NSColor.white.withAlphaComponent(0.75)
        closeBtn.frame = NSRect(x: width - 28, y: height - 28, width: 20, height: 20)
        closeBtn.target = ActionTarget.shared
        closeBtn.action = #selector(ActionTarget.handleClick(_:))
        ActionTarget.shared.register(button: closeBtn) { [weak panel] in
            panel?.close()
        }
        container.addSubview(closeBtn)
    }

    private func showActionMenuPanel(selectedText: String, previousClipboard: String?, anchorRect: NSRect?) {
        actionPanel?.close()
        let width: CGFloat = 228
        let height: CGFloat = 227
        let panel = createPanel(width: width, height: height, anchorRect: anchorRect)
        guard let contentView = panel.contentView else { return }
        addGlassHeader(to: contentView, width: width, height: height, panel: panel)

        let actions: [(id: String, title: String, key: String, primary: Bool)] = [
            ("fix", "1. Proofread", "1", true),
            ("concise", "2. Shorten", "2", false),
            ("professional", "3. Professional", "3", false),
            ("translate", "4. Translate (TR↔EN)", "4", false),
            ("summarize", "5. Summarize", "5", false),
            ("keypoints", "6. Key Points", "6", false)
        ]

        var curY = height - 60
        for act in actions {
            let btn = GlassActionButton(frame: NSRect(x: 10, y: curY, width: width - 20, height: 27))
            btn.title = "  " + act.title
            btn.isPrimaryGlass = act.primary
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
            contentView.addSubview(btn)
            curY -= 31
        }

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
        if let cv = panel.contentView {
            addGlassHeader(to: cv, width: panel.frame.width, height: panel.frame.height, panel: panel)
            let statusLbl = NSTextField(labelWithString: "Running \(label)…")
            statusLbl.font = NSFont.systemFont(ofSize: 12, weight: .medium)
            statusLbl.textColor = .white
            statusLbl.alignment = .center
            statusLbl.frame = NSRect(x: 12, y: (panel.frame.height - 28) / 2, width: panel.frame.width - 24, height: 20)
            cv.addSubview(statusLbl)
        }

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

        if let app = savedFrontApp {
            if #available(macOS 14.0, *) {
                NSApp.yieldActivation(to: app)
            }
            app.activate(options: [.activateIgnoringOtherApps])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
            self?.postCommandKey(virtualKey: 9) // 'v'
            if let prev = restoreClipboard {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                    pb.clearContents()
                    pb.setString(prev, forType: .string)
                }
            }
        }
    }

    private func showPanelResult(text: String, isError: Bool, previousClipboard: String?, panel: InlineActionPanel) {
        let newWidth: CGFloat = 330
        let newHeight: CGFloat = 200
        var frame = panel.frame
        frame.size = NSSize(width: newWidth, height: newHeight)
        panel.setFrame(frame, display: true)
        guard let contentView = panel.contentView else { return }
        contentView.subviews.forEach { $0.removeFromSuperview() }
        addGlassHeader(to: contentView, width: newWidth, height: newHeight, panel: panel)

        let scroll = NSScrollView(frame: NSRect(x: 12, y: 44, width: newWidth - 24, height: newHeight - 78))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let tv = NSTextView(frame: scroll.bounds)
        tv.isEditable = false
        tv.drawsBackground = false
        tv.font = NSFont.systemFont(ofSize: 12)
        tv.textColor = isError ? NSColor(calibratedRed: 1.0, green: 0.65, blue: 0.65, alpha: 1.0) : .white
        tv.string = text
        scroll.documentView = tv
        contentView.addSubview(scroll)

        let copyBtn = GlassActionButton(frame: NSRect(x: newWidth - 112, y: 10, width: 100, height: 26))
        copyBtn.title = "Copy"
        copyBtn.isPrimaryGlass = true
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
            let replaceBtn = GlassActionButton(frame: NSRect(x: 12, y: 10, width: 124, height: 26))
            replaceBtn.title = "Replace"
            replaceBtn.target = ActionTarget.shared
            replaceBtn.action = #selector(ActionTarget.handleClick(_:))
            ActionTarget.shared.register(button: replaceBtn) { [weak self, weak panel] in
                panel?.close()
                self?.pasteReplacement(text, restoreClipboard: previousClipboard)
            }
            contentView.addSubview(replaceBtn)
        }
    }

    // MARK: - Customizable Shortcut Recorder

    private func matchesHotkey(keyCode: Int64, flags: CGEventFlags, event: CGEvent) -> Bool {
        var keyMatches = (keyCode == hotkey.keyCode)
        if !keyMatches && hotkey.keyCode == 47 {
            if let ch = NSEvent(cgEvent: event)?.charactersIgnoringModifiers, ch == "." {
                keyMatches = true
            }
        }
        guard keyMatches else { return false }
        if flags.contains(.maskCommand) != hotkey.cmd { return false }
        if flags.contains(.maskAlternate) != hotkey.opt { return false }
        if flags.contains(.maskControl) != hotkey.ctrl { return false }
        if flags.contains(.maskShift) != hotkey.shift { return false }
        if hotkey.cmd && hotkey.requireRightCmd {
            if (flags.rawValue & NX_DEVICERCMDKEYMASK) == 0 { return false }
        }
        return true
    }

    private func loadSavedHotkey() {
        worker.sendAsync(["type": "getConfig"]) { [weak self] resp in
            guard let self = self,
                  let cfg = resp["config"] as? [String: Any],
                  let hk = cfg["hotkey"] as? [String: Any],
                  let kc = hk["keyCode"] as? Int else { return }
            DispatchQueue.main.async {
                self.hotkey = HotkeyConfig(
                    keyCode: Int64(kc),
                    cmd: (hk["cmd"] as? Bool) ?? false,
                    requireRightCmd: (hk["requireRightCmd"] as? Bool) ?? false,
                    opt: (hk["opt"] as? Bool) ?? false,
                    ctrl: (hk["ctrl"] as? Bool) ?? false,
                    shift: (hk["shift"] as? Bool) ?? false,
                    label: (hk["label"] as? String) ?? "Custom"
                )
                self.hotkeyMenuItem?.title = "Shortcut: \(self.hotkey.label) (Change…)"
            }
        }
    }

    private func saveHotkey(_ next: HotkeyConfig) {
        self.hotkey = next
        self.hotkeyMenuItem?.title = "Shortcut: \(next.label) (Change…)"
        let dict: [String: Any] = [
            "keyCode": Int(next.keyCode),
            "cmd": next.cmd,
            "requireRightCmd": next.requireRightCmd,
            "opt": next.opt,
            "ctrl": next.ctrl,
            "shift": next.shift,
            "label": next.label
        ]
        worker.sendAsync(["type": "setConfig", "hotkey": dict]) { _ in }
    }

    private func formatKeyName(keyCode: UInt16, chars: String?) -> String {
        switch keyCode {
        case 47: return "."
        case 49: return "Space"
        case 36: return "Return"
        case 48: return "Tab"
        case 44: return "/"
        case 43: return ","
        default:
            let s = (chars ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            return s.isEmpty ? "Key(\(keyCode))" : s
        }
    }

    @objc private func openShortcutRecorder() {
        isRecordingHotkey = true
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Change Global Shortcut"
        alert.informativeText = "Current: \(hotkey.label)\nPress your new key combination (with ⌘, ⌥, ⌃, or ⇧) now…"
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Reset (Right ⌘ + .)")
        alert.addButton(withTitle: "Cancel")

        let preview = NSTextField(labelWithString: "Waiting for key press…")
        preview.alignment = .center
        preview.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        preview.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = preview

        var captured: HotkeyConfig?
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
            let mod = ev.modifierFlags
            let cmd = mod.contains(.command)
            let opt = mod.contains(.option)
            let ctrl = mod.contains(.control)
            let shift = mod.contains(.shift)
            if !cmd && !opt && !ctrl {
                preview.stringValue = "Include ⌘, ⌥, or ⌃!"
                return nil
            }
            let rightCmd = cmd && ((UInt64(mod.rawValue) & NX_DEVICERCMDKEYMASK) != 0)
            var parts: [String] = []
            if ctrl { parts.append("⌃") }
            if opt { parts.append("⌥") }
            if shift { parts.append("⇧") }
            if cmd { parts.append(rightCmd ? "Right ⌘" : "⌘") }
            parts.append(self.formatKeyName(keyCode: ev.keyCode, chars: ev.charactersIgnoringModifiers))
            let lbl = parts.joined(separator: " + ")
            captured = HotkeyConfig(
                keyCode: Int64(ev.keyCode),
                cmd: cmd,
                requireRightCmd: rightCmd,
                opt: opt,
                ctrl: ctrl,
                shift: shift,
                label: lbl
            )
            preview.stringValue = lbl
            return nil
        }

        let response = alert.runModal()
        if let m = monitor { NSEvent.removeMonitor(m) }
        isRecordingHotkey = false

        if response == .alertFirstButtonReturn, let next = captured {
            saveHotkey(next)
        } else if response == .alertSecondButtonReturn {
            saveHotkey(HotkeyConfig())
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

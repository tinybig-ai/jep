import Foundation
import Observation

/// Which screen is up. Two content screens and the gate, as on Android.
public enum Screen: Equatable, Sendable {
    case sessions
    case newChat
    case settings
    case chat(sessionId: String, title: String, workspace: String, harness: String?)
}

/// The New Conversation form: a directory and a harness, fixed from then on.
public struct NewChatState: Equatable, Sendable {
    public var title = ""
    public var harness: String?
    public var workspace: String?
    /// an absolute directory picked by browsing; wins over `workspace`
    public var path: String?
    public var harnesses: [String] = []
    public var defaultHarness: String?
    public var harnessOptions: [HarnessSetting] = []
    public var harnessSettings: [String: Bool] = [:]
    public var loadingHarnessSettings = false
    public var workspaces: [Workspace] = []
    public var browse: BrowseResult?
    public var browsing = false
    public var loadingBrowse = false
    public var creating = false
    public var error: String?
    public init(workspaces: [Workspace] = []) { self.workspaces = workspaces }
    public var target: String? { path ?? workspace }
}

public struct Prefs: Equatable, Sendable {
    public var theme: ThemeMode
    public var textSize: TextSize
    public var terminalEnabled: Bool
    public var backgroundStreaming: Bool
}

/// how long the undo affordance stays up after an archive
public let undoMs: UInt64 = 6_000

/// How the app builds a gateway client; the concrete one lives in Data/.
public typealias RepositoryFactory = @Sendable (_ base: String, _ pairing: PairingStore) -> ChatRepository

public let gatewayFactory: RepositoryFactory = { base, pairing in
    GatewayChatRepository(base: base, token: { pairing.token }, onNextCode: { pairing.rememberCode($0) })
}

@MainActor
@Observable
public final class AppStore {
    public let pairing: PairingStore
    @ObservationIgnored private let settings: AppSettings
    @ObservationIgnored private let read: ReadStore
    @ObservationIgnored public let memory: ConversationMemory
    @ObservationIgnored public let attention: Attention
    @ObservationIgnored private let factory: RepositoryFactory
    @ObservationIgnored private var repo: ChatRepository?
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var undoTask: Task<Void, Never>?
    @ObservationIgnored private var chatStack: [Screen] = []
    @ObservationIgnored private let refreshDelayNs: UInt64

    public private(set) var prefs: Prefs
    public private(set) var gateway: String?
    public private(set) var termAccess: TerminalAccess?
    public private(set) var screen: Screen = .sessions
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var busy = false
    public private(set) var unread: Set<String> = []
    public private(set) var workspaces: [Workspace] = []
    public private(set) var newChat = NewChatState()
    public var notice: String?
    public private(set) var paired = false
    public private(set) var undo: [SessionSummary] = []
    public private(set) var selection: Set<String> = []
    public private(set) var archived: [SessionSummary]?
    public private(set) var importable: [ImportableSession]?

    public init(
        pairing: PairingStore,
        prefs: KeyValueStore,
        memory: ConversationMemory,
        attention: Attention = NoAttention(),
        factory: @escaping RepositoryFactory = gatewayFactory,
        refreshDelayMs: UInt64 = 4_000
    ) {
        self.pairing = pairing
        self.settings = AppSettings(prefs)
        self.read = ReadStore(prefs)
        self.memory = memory
        self.attention = attention
        self.factory = factory
        self.refreshDelayNs = refreshDelayMs * 1_000_000
        self.prefs = Prefs(theme: settings.theme, textSize: settings.textSize, terminalEnabled: settings.terminalEnabled, backgroundStreaming: settings.backgroundStreaming)
        self.gateway = pairing.baseUrl
        if pairing.isPaired {
            paired = true
            _ = connect()
        }
    }

    @discardableResult
    private func connect() -> ChatRepository {
        if let repo { return repo }
        let built = factory(pairing.baseUrl ?? "", pairing)
        repo = built
        refresh()
        return built
    }

    /// every chat opens against the same port
    public func chat() -> ChatRepository { connect() }

    public func makeChatStore(sessionId: String, title: String, workspace: String, harness: String?) -> ChatStore {
        ChatStore(
            repo: chat(), sessionId: sessionId, title: title, workspace: workspace, harness: harness,
            onRead: { [weak self] in self?.markRead(sessionId) },
            memory: memory, attention: attention
        )
    }

    // MARK: preferences

    public func setTheme(_ m: ThemeMode) {
        settings.setTheme(m)
        prefs.theme = m
    }

    public func setTextSize(_ s: TextSize) {
        settings.setTextSize(s)
        prefs.textSize = s
    }

    public func setBackgroundStreaming(_ on: Bool) {
        settings.setBackgroundStreaming(on)
        prefs.backgroundStreaming = on
    }

    /// Turning the terminal on proves the pairing code afresh.
    public func enableTerminal(code: String) async -> Bool {
        let r = repo ?? connect()
        do {
            _ = try await r.unlockTerminal(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            settings.setTerminalEnabled(true)
            prefs.terminalEnabled = true
            termAccess = TerminalAccess(allowed: true, authorized: true)
            return true
        } catch {
            return false
        }
    }

    public func disableTerminal() {
        settings.setTerminalEnabled(false)
        prefs.terminalEnabled = false
        guard let r = repo else { return }
        Task { _ = try? await r.lockTerminal() }
    }

    public func openSettings() {
        screen = .settings
        refreshTerminalAccess()
    }

    public func refreshTerminalAccess() {
        guard let r = repo else { return }
        Task { if let t = try? await r.terminalStatus() { termAccess = t } }
    }

    // MARK: sessions

    private func recomputeUnread() {
        unread = Set(sessions.filter { read.isUnread($0) }.map(\.id))
    }

    /// A refresh asked for while one runs is remembered, not dropped.
    @discardableResult
    public func refresh() -> Task<Void, Never>? {
        guard let r = repo else { return nil }
        if busy {
            refreshQueued = true
            return nil
        }
        busy = true
        return Task {
            var anyActive = false
            do {
                let list = try await r.sessions()
                sessions = list
                recomputeUnread()
                notice = nil
                anyActive = list.contains { $0.active }
            } catch {
                notice = "gateway unreachable: \(describe(error))"
            }
            if let w = try? await r.workspaces() { workspaces = w }
            busy = false
            if refreshQueued {
                refreshQueued = false
                refresh()
            } else if anyActive, screen == .sessions {
                try? await Task.sleep(nanoseconds: refreshDelayNs)
                if screen == .sessions { refresh() }
            }
        }
    }

    public func pair(address: String, code: String) async -> String? {
        guard let base = PairingStore.normalize(address), !code.trimmingCharacters(in: .whitespaces).isEmpty else {
            return "an address and the code are both needed"
        }
        let attempt = factory(base, pairing)
        do {
            let token = try await attempt.pair(baseUrl: base, code: code.trimmingCharacters(in: .whitespaces))
            pairing.save(base: base, token: token)
            repo = nil
            gateway = pairing.baseUrl
            paired = true
            connect()
            return nil
        } catch {
            return describe(error, "pairing failed")
        }
    }

    /// point at a different gateway: a new machine, so a new pairing code
    public func reconnect(address: String, code: String) async -> Bool { await pair(address: address, code: code) == nil }

    public func toggleSelect(_ s: SessionSummary) {
        if selection.contains(s.id) { selection.remove(s.id) } else { selection.insert(s.id) }
    }

    public func clearSelection() { selection = [] }

    public func archive(_ s: SessionSummary) { archiveAll([s]) }

    public func archiveSelected() {
        let chosen = sessions.filter { selection.contains($0.id) }
        selection = []
        archiveAll(chosen)
    }

    public func markSelected(read isRead: Bool) {
        let ids = selection
        if ids.isEmpty { return }
        selection = []
        ids.forEach { isRead ? markRead($0) : markUnread($0) }
    }

    private func archiveAll(_ list: [SessionSummary]) {
        guard let r = repo, !list.isEmpty else { return }
        let ids = Set(list.map(\.id))
        sessions.removeAll { ids.contains($0.id) }
        undo = list
        undoTask?.cancel()
        undoTask = Task {
            try? await Task.sleep(nanoseconds: undoMs * 1_000_000)
            if !Task.isCancelled { undo = [] }
        }
        Task {
            var failed = false
            for s in list {
                do { _ = try await r.archiveSession(sessionId: s.id) } catch { failed = true }
            }
            if failed {
                notice = "couldn't archive something — the list is being reloaded"
                refresh()
            }
        }
    }

    public func undoArchive() {
        let list = undo
        if list.isEmpty { return }
        undoTask?.cancel()
        undo = []
        guard let r = repo else { return }
        Task {
            for s in list { _ = try? await r.unarchiveSession(sessionId: s.id) }
            refresh()
        }
    }

    public func markRead(_ id: String) {
        let at = nowMs()
        read.markRead(id, at: at)
        unread.remove(id)
        guard let r = repo else { return }
        Task { _ = try? await r.seen(sessionId: id, at: at) }
    }

    public func markUnread(_ id: String) {
        read.markUnread(id)
        sessions = sessions.map { s in var s = s; if s.id == id { s.seenAt = 0 }; return s }
        recomputeUnread()
        guard let r = repo else { return }
        Task { _ = try? await r.seen(sessionId: id, at: 0) }
    }

    public func loadArchived() {
        guard let r = repo else { return }
        Task {
            do { archived = try await r.archivedSessions() } catch {
                notice = "couldn't list archived conversations: \(describe(error))"
            }
        }
    }

    public func unarchive(_ s: SessionSummary) {
        guard let r = repo else { return }
        archived?.removeAll { $0.id == s.id }
        Task {
            do {
                _ = try await r.unarchiveSession(sessionId: s.id)
                refresh()
            } catch {
                notice = "couldn't restore it: \(describe(error))"
                loadArchived()
            }
        }
    }

    public func loadImportable() {
        guard let r = repo else { return }
        Task {
            do { importable = try await r.importableSessions() } catch {
                notice = "couldn't list sessions to import: \(describe(error))"
            }
        }
    }

    public func importSession(_ id: String) {
        guard let r = repo else { return }
        Task {
            do {
                _ = try await r.importSession(sessionId: id)
                importable?.removeAll { $0.id == id }
                refresh()
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                refresh()
            } catch {
                notice = "import failed: \(describe(error))"
            }
        }
    }

    /// how a notification tap lands in the chat it was about
    public func openSessionById(_ id: String) {
        if let s = sessions.first(where: { $0.id == id }) { return open(s) }
        guard let r = repo else { return }
        Task {
            guard let list = try? await r.sessions() else { return }
            sessions = list
            recomputeUnread()
            if let s = list.first(where: { $0.id == id }) { open(s) }
        }
    }

    public func open(_ s: SessionSummary) {
        markRead(s.id)
        attention.seen(sessionId: s.id)
        let name = s.adapter ?? String(s.workspace.split(separator: "/").last ?? "")
        let target = Screen.chat(sessionId: s.id, title: s.title, workspace: name, harness: s.harness)
        if case .chat(let current, _, _, _) = screen, current != s.id { chatStack.append(screen) }
        screen = target
    }

    public func back() {
        var parent: Screen?
        if case .chat = screen { parent = chatStack.popLast() }
        screen = parent ?? .sessions
        refresh()
    }

    public func forgetPairing() {
        chatStack = []
        pairing.forget()
        gateway = nil
        repo = nil
        paired = false
        screen = .sessions
        sessions = []
    }

    // MARK: new conversation

    public func openNewChat() {
        let r = repo ?? connect()
        newChat = NewChatState(workspaces: workspaces)
        screen = .newChat
        Task {
            if let h = try? await r.harnesses() {
                let selected = newChat.harness ?? h.defaultId
                newChat.harnesses = h.ids
                newChat.harness = selected
                newChat.defaultHarness = h.defaultId
                if let selected { loadNewHarnessOptions(r, selected) }
            }
            if let w = try? await r.workspaces() {
                workspaces = w
                newChat.workspaces = w
            }
        }
    }

    public func closeNewChat() { screen = .sessions }

    public func setNewTitle(_ v: String) {
        newChat.title = v
        newChat.error = nil
    }

    public func setNewHarness(_ id: String) {
        newChat.harness = id
        newChat.harnessOptions = []
        newChat.harnessSettings = [:]
        newChat.error = nil
        if let r = repo { loadNewHarnessOptions(r, id) }
    }

    public func setNewHarnessSetting(_ id: String, _ on: Bool) { newChat.harnessSettings[id] = on }

    private func loadNewHarnessOptions(_ r: ChatRepository, _ harness: String) {
        newChat.loadingHarnessSettings = true
        Task {
            do {
                let options = try await r.harnessOptions(harness: harness)
                guard newChat.harness == harness else { return }
                var values: [String: Bool] = [:]
                for o in options { values[o.id] = newChat.harnessSettings[o.id] ?? o.defaultValue }
                newChat.harnessOptions = options
                newChat.harnessSettings = values
                newChat.loadingHarnessSettings = false
            } catch {
                if newChat.harness == harness { newChat.loadingHarnessSettings = false }
            }
        }
    }

    /// a served workspace names its harness: picking the row picks both
    public func selectWorkspace(_ name: String, harness: String) {
        newChat.workspace = name
        newChat.path = nil
        newChat.harness = harness
        newChat.harnessOptions = []
        newChat.harnessSettings = [:]
        newChat.error = nil
        if let r = repo { loadNewHarnessOptions(r, harness) }
    }

    public func selectPath(_ p: String) {
        newChat.path = p
        newChat.workspace = nil
        newChat.browsing = false
        newChat.error = nil
    }

    public func openBrowse() {
        newChat.browsing = true
        newChat.error = nil
        loadBrowse(newChat.path)
    }

    public func closeBrowse() { newChat.browsing = false }
    public func browseInto(_ p: String) { loadBrowse(p) }
    public func browseUp() { loadBrowse(newChat.browse?.parent) }

    public func newFolder(_ name: String) {
        guard let r = repo else { return }
        let cwd = newChat.browse?.cwd
        Task {
            do {
                _ = try await r.newFolder(path: cwd, name: name.trimmingCharacters(in: .whitespaces))
                loadBrowse(cwd)
            } catch {
                newChat.error = describe(error, "couldn't create that folder")
            }
        }
    }

    private func loadBrowse(_ p: String?) {
        guard let r = repo else { return }
        newChat.loadingBrowse = true
        newChat.error = nil
        Task {
            do {
                newChat.browse = try await r.browse(path: p)
                newChat.loadingBrowse = false
            } catch {
                newChat.loadingBrowse = false
                newChat.error = browseError(error)
            }
        }
    }

    private func browseError(_ e: Error) -> String {
        let m = describe(e)
        if m.range(of: "respond", options: .caseInsensitive) != nil {
            return "jep can't read that folder. On macOS give the daemon Full Disk Access (System Settings › Privacy & Security), or pick another folder."
        }
        return "couldn't read that folder: \(m)"
    }

    @discardableResult
    public func createConversation() -> Task<Void, Never>? {
        let r = repo ?? connect()
        let st = newChat
        if st.creating { return nil }
        if st.target == nil {
            newChat.error = "pick a workspace or a folder first"
            return nil
        }
        newChat.creating = true
        newChat.error = nil
        return Task {
            do {
                let title = st.title.trimmingCharacters(in: .whitespaces)
                let s = try await r.newSession(title: title.isEmpty ? nil : title, workspace: st.workspace, path: st.path, harness: st.harness, harnessSettings: st.harnessSettings)
                refresh()
                open(s)
            } catch {
                newChat.creating = false
                newChat.error = "couldn't start it: \(describe(error))"
            }
        }
    }

    // MARK: push

    /// hand the device's push token to the gateway; a gateway without push says 503, and that is fine
    public func registerPush(token: String) {
        guard let r = repo else { return }
        Task { _ = try? await r.registerPush(token: token) }
    }
}

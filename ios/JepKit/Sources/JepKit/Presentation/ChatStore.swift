import Foundation
import Observation

/// newest messages loaded up front; older pages come on demand
public let historyWindow = 30
/// the least time between two automatic retries of an unsent message
public let autoRetryMs: Int64 = 30_000

public func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// Has the harness's record settled the message we are streaming? Only a
/// completion (`durationMs`) says so; `time` is set when the message is created.
public func liveRowIsSettled(_ liveMessageId: String?, _ served: [ChatMessage]) -> Bool {
    guard let liveMessageId else { return false }
    return served.contains { $0.id == liveMessageId && $0.durationMs != nil }
}

/// where the file is on this phone, so it shows before the harness ingests it
public struct Attachment: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var localURL: String?
    public var mimeType: String?
    public init(id: String, name: String, localURL: String? = nil, mimeType: String? = nil) {
        self.id = id
        self.name = name
        self.localURL = localURL
        self.mimeType = mimeType
    }
}

/// a message typed while the agent was busy, shown as queued until picked up
public struct Queued: Equatable, Sendable, Identifiable {
    public var id: String
    public var text: String
    public var attachments: [Attachment] = []
    public var mode: SendMode = .steer
    public var quote: String?
    /// served user message ids present when queued, so an older identical message cannot clear it
    public var seen: Set<String> = []
}

/// the turn being written right now: parts in arrival order, keyed by part id
public struct LiveTurn: Equatable, Sendable {
    public var messageId: String
    public private(set) var order: [String] = []
    public private(set) var byId: [String: ChatPart] = [:]
    public init(messageId: String) { self.messageId = messageId }
    public var parts: [ChatPart] { order.compactMap { byId[$0] } }
    public var count: Int { order.count }
    public subscript(key: String) -> ChatPart? {
        get { byId[key] }
        set {
            if byId[key] == nil, newValue != nil { order.append(key) }
            if newValue == nil { order.removeAll { $0 == key } }
            byId[key] = newValue
        }
    }
}

/// a workspace file opened from a link, and what the reader has of it
public struct OpenFile: Equatable, Sendable {
    public var path: String
    public var loading = true
    public var text: String?
    public var error: String?
    public var tooBig = false
    /// an image is shown from its bytes, not read as text
    public var image: Data?
}

public struct ChatState: Equatable, Sendable {
    public var messages: [ChatMessage] = []
    public var live: LiveTurn?
    public var ask: Ask?
    /// when that ask was raised, on the harness's clock where known
    public var askAt: Int64 = 0
    /// the option tapped; set once answered, which leaves the card spent in place
    public var askChoice: String?
    /// the message streaming when the ask arrived
    public var askAfter: String?
    /// every earlier card, spent
    public var pastAsks: [AskEntry] = []
    public var openFile: OpenFile?
    public var failure: String?
    public var sending = false
    public var lost = false
    public var compacting = false
    public var attachments: [Attachment] = []
    public var draft = ""
    public var queued: [Queued] = []
    public var notice: String?
    public var hasMore = false
    public var loadingOlder = false
    public var loadingHistory = false
    public var models: ModelChoices?
    public var agent: String?
    public var agents: [AgentInfo] = []
    public var usage: Usage?
    public var diffs: [FileDiff]?
    public var git: GitSnapshot?
    public var gitLoading = false
    public var gitError: String?
    public var harnessSettings = HarnessSettings()
    public var harnessSettingsLoading = false
    public var subagents: [SessionSummary]?
    public var skills: SkillSet?
    public var mcp: [McpServer]?
    public init() {}

    /// Move the open card into the record, spent.
    public func retireAsk(choice: String? = nil) -> ChatState {
        guard let slot = ask else { return self }
        let picked = choice ?? (askChoice == somethingElse ? nil : askChoice)
        var a = slot
        if a.at == nil, askAt > 0 { a.at = askAt }
        var st = self
        st.ask = nil
        st.askAt = 0
        st.askChoice = nil
        st.askAfter = nil
        st.pastAsks = pastAsks.filter { $0.ask.id != slot.id } + [AskEntry(ask: a, pending: false, choice: picked)]
        return st
    }

    /// An unanswered card stands down when its turn ends; an answered one stays spent.
    public func standDownAsk() -> ChatState { (ask == nil || askChoice != nil) ? self : retireAsk() }

    /// Fold in the gateway's ask record from /history.
    public func withServedAsks(_ served: [AskEntry], now: Int64 = nowMs()) -> ChatState {
        var st = self
        for e in served {
            let slot = st.ask
            if slot?.id == e.ask.id {
                if !e.pending, st.askChoice == nil { st = st.retireAsk(choice: e.choice) }
                continue
            }
            if let known = st.pastAsks.first(where: { $0.ask.id == e.ask.id }) {
                if !e.pending, known.choice == nil, let c = e.choice {
                    st.pastAsks = st.pastAsks.map { p in
                        guard p.ask.id == e.ask.id else { return p }
                        var p = p
                        p.choice = c
                        return p
                    }
                }
                continue
            }
            if !e.pending {
                st.pastAsks.append(e)
            } else if slot == nil || st.askChoice != nil {
                st = st.retireAsk()
                st.ask = e.ask
                st.askAt = e.ask.at ?? now
                st.askChoice = nil
                st.askAfter = nil
            }
        }
        return st
    }
}

/// The open conversation: the authoritative history merged with the live stream.
/// Prompt runs live in the gateway and outlive this store; a reopened chat re-syncs.
@MainActor
@Observable
public final class ChatStore {
    public let sessionId: String
    public let workspace: String
    public let harness: String?
    public private(set) var title: String
    public private(set) var state = ChatState()

    @ObservationIgnored private let repo: ChatRepository
    @ObservationIgnored private let onRead: () -> Void
    @ObservationIgnored private let memory: ConversationMemory
    @ObservationIgnored private let attention: Attention
    @ObservationIgnored private var optimistic: [ChatMessage] = []
    private struct Outgoing {
        var body: String
        var files: [Attachment]
        var quote: String?
    }
    @ObservationIgnored private var outbox: [String: Outgoing] = [:]
    @ObservationIgnored private var roles: [String: Role] = [:]
    /// the turn whose callbacks may still write state
    @ObservationIgnored private var turn = 0
    @ObservationIgnored private var lastAutoRetry: Int64 = 0
    @ObservationIgnored private var restored = false
    @ObservationIgnored private var loops: [Task<Void, Never>] = []
    @ObservationIgnored private var seq: UInt64 = 0
    @ObservationIgnored private let pollNs: UInt64
    @ObservationIgnored private let settleNs: UInt64

    public init(
        repo: ChatRepository,
        sessionId: String,
        title: String,
        workspace: String = "",
        harness: String? = nil,
        onRead: @escaping () -> Void = {},
        memory: ConversationMemory = NoMemory(),
        attention: Attention = NoAttention(),
        live: Bool = true,
        pollMs: UInt64 = 1_200,
        settleMs: UInt64 = 1_500
    ) {
        self.repo = repo
        self.sessionId = sessionId
        self.title = title
        self.workspace = workspace
        self.harness = harness
        self.onRead = onRead
        self.memory = memory
        self.attention = attention
        self.pollNs = pollMs * 1_000_000
        self.settleNs = settleMs * 1_000_000
        restoreFromMemory()
        attention.chatOpened(sessionId: sessionId)
        onRead()
        if live { start() }
    }

    /// the first reads and the two loops that keep the screen current
    public func start() {
        refresh()
        loadModels()
        refreshUsage()
        loadHarnessSettings(quiet: true)
        loops.append(Task { [weak self] in
            while !Task.isCancelled {
                guard let stream = self?.repo.events() else { return }
                for await evt in stream {
                    guard let self else { return }
                    if evt.sessionId == self.sessionId || evt == .lost { self.apply(evt) }
                }
                guard let self else { return }
                self.update { $0.lost = true }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                self.refresh()
            }
        })
        loops.append(Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: self?.pollNs ?? 1_200_000_000)
                guard let self else { return }
                if self.state.sending || self.state.live != nil { self.refresh() }
            }
        })
    }

    /// the screen left: stop following, tell the device
    public func close() {
        loops.forEach { $0.cancel() }
        loops = []
        attention.chatClosed(sessionId: sessionId)
    }

    private func update(_ change: (inout ChatState) -> Void) {
        var next = state
        change(&next)
        if next == state { return }
        let draftChanged = next.draft != state.draft || next.attachments != state.attachments
        state = next
        if restored, draftChanged {
            memory.saveDraft(sessionId: sessionId, draft: SavedDraft(text: next.draft, attachments: next.attachments.map(\.saved)))
        }
    }

    private func nextId(_ prefix: String) -> String {
        seq += 1
        return "\(prefix)-\(DispatchTime.now().uptimeNanoseconds)-\(seq)"
    }

    // MARK: stream

    func apply(_ evt: ChatEvent) {
        switch evt {
        case let .textDelta(_, messageId, partId, partType, text):
            if roles[messageId] == .user { return }
            update { st in
                var live = liveFor(st, messageId)
                let existing = live[partId]
                if partType == "reasoning" {
                    var prior = ""
                    if case .reasoning(let t, _)? = existing { prior = t }
                    live[partId] = .reasoning(prior + text, durationMs: nil)
                } else {
                    live[partId] = .text((existing?.textValue ?? "") + text)
                }
                st.live = live
                st.lost = false
                st.failure = nil
            }
        case let .partChanged(_, messageId, partId, part):
            if roles[messageId] == .user { return }
            update { st in
                var live = liveFor(st, messageId)
                live[partId ?? "extra\(live.count)"] = part
                st.live = live
            }
        case let .asked(_, ask):
            update { st in
                if st.ask?.id == ask.id || st.pastAsks.contains(where: { $0.ask.id == ask.id }) { return }
                let after = st.live?.messageId
                st = st.retireAsk()
                st.ask = ask
                st.askAt = ask.at ?? nowMs()
                st.askChoice = nil
                st.askAfter = after
            }
        case let .askResolved(_, askId):
            update { st in if st.ask?.id == askId { st = st.standDownAsk() } }
        case let .failed(_, error):
            update { st in
                st.failure = error
                st.live = nil
                st.sending = false
                st = st.standDownAsk()
            }
        case .aborted:
            update { st in
                st.failure = nil
                st.live = nil
                st.sending = false
                st.notice = "the turn was stopped"
                st = st.standDownAsk()
            }
        case .quiet:
            onRead()
            refresh()
            refreshUsage()
            update { st in
                st.sending = false
                st.live = nil
                st = st.standDownAsk()
            }
        case .lost:
            update { $0.lost = true }
        case .changed:
            if !state.sending, state.live == nil {
                refresh()
                refreshUsage()
            }
        case let .messageSeen(_, messageId, role):
            if let role { roles[messageId] = role }
            if role == .user, state.live?.messageId == messageId { update { $0.live = nil } }
        }
    }

    private func liveFor(_ st: ChatState, _ messageId: String) -> LiveTurn {
        if let live = st.live, live.messageId == messageId { return live }
        return LiveTurn(messageId: messageId)
    }

    private func textOf(_ m: ChatMessage) -> String {
        m.parts.compactMap(\.textValue).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: history

    @discardableResult
    public func refresh() -> Task<Void, Never> {
        if state.messages.isEmpty { update { $0.loadingHistory = true } }
        return Task {
            do {
                let batch = try await repo.history(sessionId: sessionId, limit: historyWindow)
                var servedUser = batch.messages.filter { $0.role == .user }.map(textOf)
                optimistic.removeAll { o in
                    guard let i = servedUser.firstIndex(of: textOf(o)) else { return false }
                    servedUser.remove(at: i)
                    return true
                }
                let keep = Set(optimistic.map(\.id))
                let before = outbox.count
                outbox = outbox.filter { keep.contains($0.key) }
                if outbox.count != before { persistOutbox() }
                let servedNow = batch.messages.filter { $0.role == .user }
                update { st in
                    let prior = st
                    st.messages = batch.messages + optimistic
                    if liveRowIsSettled(prior.live?.messageId, batch.messages) { st.live = nil }
                    st.hasMore = batch.hasMore
                    st.loadingHistory = false
                    st = st.withServedAsks(batch.asks)
                    st.queued = prior.queued.filter { q in
                        !servedNow.contains { m in !q.seen.contains(m.id) && textOf(m) == q.text }
                    }
                }
                retryOutboxIfDue()
            } catch {
                update { $0.loadingHistory = false }
            }
        }
    }

    @discardableResult
    public func loadOlder() -> Task<Void, Never>? {
        let st = state
        if st.loadingOlder || !st.hasMore { return nil }
        guard let oldest = st.messages.map(\.time).min() else { return nil }
        update { $0.loadingOlder = true }
        return Task {
            do {
                let batch = try await repo.history(sessionId: sessionId, limit: historyWindow, before: oldest, have: st.messages.count)
                update { prev in
                    let prior = Set(prev.messages.map(\.id))
                    prev.messages = batch.messages.filter { !prior.contains($0.id) } + prev.messages
                    prev.hasMore = batch.hasMore
                    prev.loadingOlder = false
                }
            } catch {
                update { $0.loadingOlder = false }
            }
        }
    }

    // MARK: sending

    public func setDraft(_ text: String) {
        if state.draft != text { update { $0.draft = text } }
    }

    /// `quote` is the words this answers: sent beside the text, never inside it
    @discardableResult
    public func send(_ text: String, mode: SendMode = .steer, quote: String? = nil) -> Task<Void, Never>? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = state.attachments
        if trimmed.isEmpty, files.isEmpty { return nil }
        let body = trimmed.isEmpty ? "see the attached file" : trimmed
        update { $0.draft = "" }
        if state.sending { return enqueue(body, files, mode, quote) }
        return sendNow(body, files, quote)
    }

    private func enqueue(_ body: String, _ files: [Attachment], _ mode: SendMode, _ quote: String?) -> Task<Void, Never> {
        let clientID = nextId("q")
        let seen = Set(state.messages.filter { $0.role == .user }.map(\.id))
        let q = Queued(id: clientID, text: body, attachments: files, mode: mode, quote: quote, seen: seen)
        update { st in
            st.queued = mode == .now ? [q] + st.queued : st.queued + [q]
            st.attachments = []
        }
        return Task {
            _ = try? await repo.prompt(sessionId: sessionId, text: body, files: files.map(\.id), clientID: clientID, mode: mode, quote: quote)
            update { st in
                st.queued.removeAll { $0.id == clientID }
                if st.queued.isEmpty { st.sending = false }
            }
            refresh()
        }
    }

    private func sendNow(_ body: String, _ files: [Attachment], _ quote: String?) -> Task<Void, Never> {
        let pending = ChatMessage(id: nextId("local"), role: .user, time: nowMs(), parts: outgoingParts(body, files, quote))
        turn += 1
        let mine = turn
        optimistic.append(pending)
        outbox[pending.id] = Outgoing(body: body, files: files, quote: quote)
        persistOutbox()
        supersedeAsk()
        update { st in
            st.messages.append(pending)
            st.sending = true
            st.live = nil
            st.failure = nil
            st.attachments = []
        }
        return Task {
            do {
                let final = try await repo.prompt(sessionId: sessionId, text: body, files: files.map(\.id), quote: quote)
                guard mine == turn else { return }
                optimistic.removeAll { $0.id == pending.id }
                outbox[pending.id] = nil
                persistOutbox()
                update { st in
                    st.messages = st.messages.filter { $0.id != final.id } + [final]
                    st.sending = false
                    st.live = nil
                }
                refresh()
                Task {
                    try? await Task.sleep(nanoseconds: settleNs)
                    if mine == turn { refresh() }
                }
            } catch {
                guard mine == turn else { return }
                let aborted = error is TurnAborted
                update { st in
                    if !aborted {
                        st.messages = st.messages.map { m in
                            var m = m
                            if m.id == pending.id { m.undelivered = true }
                            return m
                        }
                    }
                    st.sending = !st.queued.isEmpty
                    st.live = nil
                    st.failure = aborted ? nil : describe(error, "the turn failed")
                }
            }
        }
    }

    public func editQueued(id: String, text: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty { return }
        update { st in st.queued = st.queued.map { q in var q = q; if q.id == id { q.text = body }; return q } }
        Task { _ = try? await repo.queueEdit(sessionId: sessionId, clientID: id, text: body) }
    }

    public func cancelQueued(id: String) {
        update { $0.queued.removeAll { $0.id == id } }
        Task { _ = try? await repo.queueCancel(sessionId: sessionId, clientID: id) }
    }

    /// run a queued message next, aborting the running turn so it can
    public func forceSendQueued(id: String) {
        guard let item = state.queued.first(where: { $0.id == id }) else { return }
        if !state.sending {
            update { $0.queued.removeAll { $0.id == id } }
            _ = sendNow(item.text, item.attachments, item.quote)
            return
        }
        var now = item
        now.mode = .now
        update { st in st.queued = [now] + st.queued.filter { $0.id != id } }
        Task { _ = try? await repo.queueForce(sessionId: sessionId, clientID: id) }
    }

    @discardableResult
    public func attach(filename: String, bytes: Data, localURL: String? = nil, mimeType: String? = nil) -> Task<Void, Never> {
        Task {
            do {
                let id = try await repo.attach(sessionId: sessionId, filename: filename, bytes: bytes)
                update { $0.attachments.append(Attachment(id: id, name: filename, localURL: localURL, mimeType: mimeType)) }
            } catch {
                update { $0.notice = "couldn't attach \"\(filename)\": \(describe(error))" }
            }
        }
    }

    public func removeAttachment(id: String) {
        update { $0.attachments.removeAll { $0.id == id } }
    }

    /// Send an undelivered message again: tapping the dimmed bubble.
    @discardableResult
    public func retrySend(id: String) -> Task<Void, Never>? {
        guard let out = outbox[id], state.messages.contains(where: { $0.id == id && $0.undelivered }) else { return nil }
        update { st in
            st.messages = st.messages.map { m in var m = m; if m.id == id { m.undelivered = false }; return m }
            st.failure = nil
            st.sending = true
        }
        turn += 1
        let mine = turn
        return Task {
            do {
                let final = try await repo.prompt(sessionId: sessionId, text: out.body, files: out.files.map(\.id), quote: out.quote)
                guard mine == turn else { return }
                optimistic.removeAll { $0.id == id }
                outbox[id] = nil
                persistOutbox()
                update { st in
                    st.messages = st.messages.filter { $0.id != id && $0.id != final.id } + [final]
                    st.sending = false
                }
                refresh()
            } catch {
                update { st in
                    st.messages = st.messages.map { m in var m = m; if m.id == id { m.undelivered = true }; return m }
                    st.sending = false
                    st.failure = describe(error, "still no connection")
                }
            }
        }
    }

    private func retryOutboxIfDue() {
        if state.sending { return }
        let now = nowMs()
        if now - lastAutoRetry < autoRetryMs { return }
        guard let next = state.messages.first(where: { $0.undelivered && outbox[$0.id] != nil }) else { return }
        lastAutoRetry = now
        retrySend(id: next.id)
    }

    /// Stop takes effect on screen at once; the late reply of the stopped turn is ignored.
    public func stop() {
        turn += 1
        update { st in
            st.sending = false
            st.live = nil
            st.failure = nil
        }
        Task { _ = try? await repo.stop(sessionId: sessionId) }
    }

    public func dismissBanner() {
        update { st in
            st.notice = nil
            st.failure = nil
        }
    }

    @discardableResult
    public func compact() -> Task<Void, Never>? {
        if state.compacting { return nil }
        update { st in
            st.compacting = true
            st.notice = nil
        }
        return Task {
            do {
                _ = try await repo.compact(sessionId: sessionId)
                update { $0.compacting = false }
                refresh()
            } catch {
                update { st in
                    st.compacting = false
                    st.notice = describe(error, "couldn't compact")
                }
            }
        }
    }

    // MARK: asks

    /// The card goes spent only once the harness confirms the answer resolved.
    @discardableResult
    public func respond(askId: String, optionId: String) -> Task<Void, Never>? {
        if state.ask?.id != askId || state.askChoice != nil { return nil }
        return Task {
            do {
                if try await repo.respond(askId: askId, optionId: optionId) {
                    update { st in
                        st.askChoice = optionId
                        st.notice = nil
                    }
                } else {
                    update { $0.notice = "that one didn't land — the ask is still open, try again" }
                }
            } catch {
                update { st in
                    st.askChoice = nil
                    st.notice = "the ask didn't take: \(describe(error))"
                }
            }
        }
    }

    /// "Something else": the choices are spent and the harness told the ask is off.
    public func spendAsk(askId: String) {
        if state.ask?.id != askId || state.askChoice != nil { return }
        update { $0.askChoice = somethingElse }
        Task { _ = try? await repo.reject(askId: askId) }
    }

    private func supersedeAsk() {
        guard let ask = state.ask, state.askChoice == nil else { return }
        update { $0.askChoice = somethingElse }
        Task { _ = try? await repo.reject(askId: ask.id) }
    }

    // MARK: conversation

    @discardableResult
    public func rename(_ newTitle: String) -> Task<Void, Never>? {
        let clean = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return nil }
        return Task {
            do {
                _ = try await repo.rename(sessionId: sessionId, title: clean)
                title = clean
            } catch {
                update { $0.notice = "rename failed: \(describe(error))" }
            }
        }
    }

    public func delete() async -> Bool {
        do {
            _ = try await repo.delete(sessionId: sessionId)
            return true
        } catch {
            update { $0.notice = "couldn't delete: \(describe(error))" }
            return false
        }
    }

    @discardableResult
    public func loadModels() -> Task<Void, Never> {
        Task {
            do {
                let m = try await repo.models(sessionId: sessionId)
                update { $0.models = m }
            } catch {
                update { $0.notice = "couldn't load models: \(describe(error))" }
            }
        }
    }

    public func setModel(_ ref: String?) {
        guard let before = state.models else { return }
        update { $0.models?.current = ref }
        Task {
            do { _ = try await repo.setModel(sessionId: sessionId, ref: ref) } catch {
                update { st in
                    st.models = before
                    st.notice = "couldn't set the model: \(describe(error))"
                }
            }
        }
    }

    @discardableResult
    public func loadAgent() -> Task<Void, Never> {
        Task {
            if let a = try? await repo.agent(sessionId: sessionId) { update { $0.agent = a } }
            if let list = try? await repo.agents(sessionId: sessionId) { update { $0.agents = list } }
        }
    }

    public func setAgent(_ agent: String?) {
        let before = state.agent
        update { $0.agent = agent }
        Task {
            do { _ = try await repo.setAgent(sessionId: sessionId, agent: agent) } catch {
                update { st in
                    st.agent = before
                    st.notice = "couldn't set the agent: \(describe(error))"
                }
            }
        }
    }

    private func refreshUsage() {
        Task { if let u = try? await repo.usage(sessionId: sessionId) { update { $0.usage = u } } }
    }

    public func loadUsage() {
        Task {
            do {
                let u = try await repo.usage(sessionId: sessionId)
                update { $0.usage = u }
            } catch { update { $0.notice = "couldn't load usage: \(describe(error))" } }
        }
    }

    public func loadDiff() {
        Task {
            do {
                let d = try await repo.diff(sessionId: sessionId)
                update { $0.diffs = d }
            } catch { update { $0.notice = "couldn't load changes: \(describe(error))" } }
        }
    }

    public func loadGit() {
        update { st in
            st.gitLoading = true
            st.gitError = nil
        }
        Task {
            do {
                let g = try await repo.git(sessionId: sessionId)
                update { st in
                    st.git = g
                    st.gitLoading = false
                }
            } catch {
                update { st in
                    st.gitLoading = false
                    st.gitError = describe(error, "couldn't load Git history")
                }
            }
        }
    }

    @discardableResult
    public func loadHarnessSettings(quiet: Bool = false) -> Task<Void, Never> {
        update { $0.harnessSettingsLoading = true }
        return Task {
            do {
                let s = try await repo.sessionHarnessSettings(sessionId: sessionId)
                update { st in
                    st.harnessSettings = s
                    st.harnessSettingsLoading = false
                }
            } catch {
                update { st in
                    st.harnessSettingsLoading = false
                    if !quiet { st.notice = describe(error, "couldn't load the options") }
                }
            }
        }
    }

    public func setHarnessSetting(id: String, enabled: Bool) {
        let before = state.harnessSettings
        update { $0.harnessSettings.values[id] = enabled }
        Task {
            do {
                if try await !repo.setSessionHarnessSetting(sessionId: sessionId, key: id, enabled: enabled) {
                    update { st in
                        st.harnessSettings = before
                        st.notice = "couldn't change that setting"
                    }
                }
            } catch {
                update { st in
                    st.harnessSettings = before
                    st.notice = describe(error, "couldn't change that setting")
                }
            }
        }
    }

    public func loadSubagents() {
        Task {
            do {
                let s = try await repo.subagents(sessionId: sessionId)
                update { $0.subagents = s }
            } catch { update { $0.notice = "couldn't load subagents: \(describe(error))" } }
        }
    }

    public func loadSkills() {
        Task {
            do {
                let s = try await repo.skills(sessionId: sessionId)
                update { $0.skills = s }
            } catch { update { $0.notice = "couldn't load skills: \(describe(error))" } }
        }
    }

    public func setSkill(path: String, disabled: Bool) {
        guard let before = state.skills else { return }
        update { st in
            st.skills?.skills = before.skills.map { s in var s = s; if s.path == path { s.disabled = disabled }; return s }
        }
        Task {
            do { _ = try await repo.setSkill(sessionId: sessionId, path: path, disabled: disabled) } catch {
                update { st in
                    st.skills = before
                    st.notice = "couldn't change the skill: \(describe(error))"
                }
            }
        }
    }

    public func loadMcp() {
        Task {
            do {
                let s = try await repo.mcp(sessionId: sessionId)
                update { $0.mcp = s }
            } catch { update { $0.notice = "couldn't load MCP servers: \(describe(error))" } }
        }
    }

    public func setMcp(name: String, enabled: Bool) {
        guard let before = state.mcp else { return }
        update { st in st.mcp = before.map { s in var s = s; if s.name == name { s.enabled = enabled }; return s } }
        Task {
            do { _ = try await repo.setMcp(sessionId: sessionId, name: name, enabled: enabled) } catch {
                update { st in
                    st.mcp = before
                    st.notice = "couldn't change the server: \(describe(error))"
                }
            }
        }
    }

    // MARK: files

    /// a file part's bytes, fetched with the pairing token
    public func fileBytes(_ path: String) async throws -> Data { try await repo.fileBytes(path: path, sessionId: sessionId) }

    /// Open a file the transcript linked to; the daemon resolves and checks roots.
    @discardableResult
    public func openFile(_ path: String) -> Task<Void, Never>? {
        var clean = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix("./") { clean.removeFirst(2) }
        if clean.isEmpty || clean.contains("://") { return nil }
        update { $0.openFile = OpenFile(path: clean) }
        return Task {
            do {
                if fileEngineFor(clean) == .image {
                    let data = try await repo.fileBytes(path: clean, sessionId: sessionId)
                    update { st in
                        guard st.openFile?.path == clean else { return }
                        st.openFile?.loading = false
                        st.openFile?.image = data
                    }
                    return
                }
                let text = try await repo.readFile(sessionId: sessionId, path: clean)
                update { st in
                    guard st.openFile?.path == clean else { return }
                    st.openFile?.loading = false
                    st.openFile?.text = text
                    st.openFile?.tooBig = text.count > 400_000
                }
            } catch {
                update { st in
                    guard st.openFile?.path == clean else { return }
                    st.openFile?.loading = false
                    st.openFile?.error = describe(error, "couldn't read it")
                }
            }
        }
    }

    public func closeFile() { update { $0.openFile = nil } }

    // MARK: terminal

    public func termOpen() async { _ = try? await repo.termOpen(sessionId: sessionId) }
    public func termFrame() async -> String { (try? await repo.termFrame(sessionId: sessionId)) ?? "" }
    public func termInput(_ text: String) async { _ = try? await repo.termInput(sessionId: sessionId, text: text) }
    public func termKey(_ key: String) async { _ = try? await repo.termKey(sessionId: sessionId, key: key) }
    public func termClose() async { _ = try? await repo.termClose(sessionId: sessionId) }

    // MARK: memory

    private func outgoingParts(_ body: String, _ files: [Attachment], _ quote: String?) -> [ChatPart] {
        var parts: [ChatPart] = []
        if let q = quote, !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(.quote(q)) }
        parts.append(.text(body))
        parts += files.map { .file(FilePart(path: $0.name, name: $0.name, mimeType: $0.mimeType, localURL: $0.localURL)) }
        return parts
    }

    private func persistOutbox() {
        let sends = outbox.map { id, e in
            SavedSend(id: id, body: e.body, attachments: e.files.map(\.saved), time: optimistic.first { $0.id == id }?.time ?? 0, quote: e.quote)
        }.sorted { $0.time < $1.time }
        memory.saveOutbox(sessionId: sessionId, sends: sends)
    }

    private func restoreFromMemory() {
        if let d = memory.loadDraft(sessionId: sessionId) {
            update { st in
                st.draft = d.text
                st.attachments = d.attachments.map(Attachment.init(saved:))
            }
        }
        let sends = memory.loadOutbox(sessionId: sessionId)
        if !sends.isEmpty {
            let rows = sends.map { s -> ChatMessage in
                let files = s.attachments.map(Attachment.init(saved:))
                outbox[s.id] = Outgoing(body: s.body, files: files, quote: s.quote)
                return ChatMessage(id: s.id, role: .user, time: s.time, parts: outgoingParts(s.body, files, s.quote), undelivered: true)
            }
            optimistic += rows
            update { $0.messages += rows }
        }
        restored = true
    }
}

extension Attachment {
    var saved: SavedAttachment { SavedAttachment(id: id, name: name, localURL: localURL, mimeType: mimeType) }
    init(saved s: SavedAttachment) { self.init(id: s.id, name: s.name, localURL: s.localURL, mimeType: s.mimeType) }
}

/// an error's own words, or the fallback when it has none worth showing
func describe(_ error: Error, _ fallback: String? = nil) -> String {
    if let e = error as? LocalizedError, let d = e.errorDescription, !d.isEmpty { return d }
    let s = (error as NSError).localizedDescription
    if let fallback, s.isEmpty { return fallback }
    return s.isEmpty ? String(describing: error) : s
}

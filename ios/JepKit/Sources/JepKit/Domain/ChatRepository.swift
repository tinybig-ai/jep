import Foundation

/// one paged slice of a conversation; `hasMore` means older messages exist
public struct HistoryBatch: Equatable, Sendable {
    public var messages: [ChatMessage]
    public var hasMore: Bool
    /// the conversation's asks and how each ended, oldest first
    public var asks: [AskEntry]
    public init(messages: [ChatMessage], hasMore: Bool, asks: [AskEntry] = []) {
        self.messages = messages
        self.hasMore = hasMore
        self.asks = asks
    }
}

/// the models a conversation may run on, the one it is set to (nil = the
/// harness default), and what "default" actually resolves to
public struct ModelChoices: Equatable, Sendable {
    public var all: [Model]
    public var current: String?
    public var defaultRef: String?
    /// the running model's context window, from the gateway; 0 when unknown
    public var contextLimit: Int64
    public init(all: [Model], current: String?, defaultRef: String? = nil, contextLimit: Int64 = 0) {
        self.all = all
        self.current = current
        self.defaultRef = defaultRef
        self.contextLimit = contextLimit
    }
}

/// raised when a turn ends because it was stopped, not because it failed
public struct TurnAborted: Error, Equatable {
    public init() {}
}

/// a failure the gateway answered with, carrying its own words
public struct ApiFailure: Error, LocalizedError, Equatable {
    public var status: Int
    public var message: String
    public init(status: Int, message: String?) {
        self.status = status
        self.message = message ?? "gateway said \(status)"
    }
    public var errorDescription: String? { message }
}

/// Events the push feed forwards, translated out of the wire's vocabulary.
public enum ChatEvent: Equatable, Sendable {
    case textDelta(sessionId: String, messageId: String, partId: String, partType: String, text: String)
    case partChanged(sessionId: String, messageId: String, partId: String?, part: ChatPart)
    case messageSeen(sessionId: String, messageId: String, role: Role?)
    case quiet(sessionId: String)
    /// the record changed outside a turn this client follows: read it again
    case changed(sessionId: String)
    case asked(sessionId: String, ask: Ask)
    /// that ask is over — answered anywhere, withdrawn, or outlived by its turn
    case askResolved(sessionId: String, askId: String)
    case failed(sessionId: String, error: String)
    /// the turn ended because somebody stopped it
    case aborted(sessionId: String)
    case lost

    public var sessionId: String? {
        switch self {
        case .textDelta(let s, _, _, _, _), .partChanged(let s, _, _, _), .messageSeen(let s, _, _),
             .quiet(let s), .changed(let s), .asked(let s, _), .askResolved(let s, _), .failed(let s, _), .aborted(let s):
            return s
        case .lost:
            return nil
        }
    }
}

/// The one port the app knows. The gateway implementation lives in Data/;
/// presentation never learns how a call travels.
public protocol ChatRepository: AnyObject, Sendable {
    func pair(baseUrl: String, code: String) async throws -> String
    func sessions() async throws -> [SessionSummary]
    func workspaces() async throws -> [Workspace]
    func harnesses() async throws -> Harnesses
    func browse(path: String?) async throws -> BrowseResult
    func newFolder(path: String?, name: String) async throws -> String
    func archivedSessions() async throws -> [SessionSummary]
    func newSession(title: String?, workspace: String?, path: String?, harness: String?, harnessSettings: [String: Bool]) async throws -> SessionSummary
    func harnessOptions(harness: String) async throws -> [HarnessSetting]
    func sessionHarnessSettings(sessionId: String) async throws -> HarnessSettings
    func setSessionHarnessSetting(sessionId: String, key: String, enabled: Bool) async throws -> Bool
    func models(sessionId: String) async throws -> ModelChoices
    func setModel(sessionId: String, ref: String?) async throws -> Bool
    func agent(sessionId: String) async throws -> String?
    func agents(sessionId: String) async throws -> [AgentInfo]
    func setAgent(sessionId: String, agent: String?) async throws -> Bool
    func usage(sessionId: String) async throws -> Usage
    func diff(sessionId: String) async throws -> [FileDiff]
    func git(sessionId: String) async throws -> GitSnapshot
    func importableSessions() async throws -> [ImportableSession]
    func importSession(sessionId: String) async throws -> Bool
    func subagents(sessionId: String) async throws -> [SessionSummary]
    func archiveSession(sessionId: String) async throws -> Bool
    func unarchiveSession(sessionId: String) async throws -> Bool
    func skills(sessionId: String) async throws -> SkillSet
    func setSkill(sessionId: String, path: String, disabled: Bool) async throws -> Bool
    func mcp(sessionId: String) async throws -> [McpServer]
    func setMcp(sessionId: String, name: String, enabled: Bool) async throws -> Bool
    func terminalStatus() async throws -> TerminalAccess
    func unlockTerminal(code: String) async throws -> Bool
    func lockTerminal() async throws -> Bool
    func termOpen(sessionId: String) async throws -> Bool
    func termFrame(sessionId: String) async throws -> String
    func termInput(sessionId: String, text: String) async throws -> Bool
    func termKey(sessionId: String, key: String) async throws -> Bool
    func termClose(sessionId: String) async throws -> Bool
    func history(sessionId: String, limit: Int, before: Int64, have: Int) async throws -> HistoryBatch
    func prompt(sessionId: String, text: String, files: [String], clientID: String?, mode: SendMode, quote: String?) async throws -> ChatMessage
    func queueCancel(sessionId: String, clientID: String) async throws -> Bool
    func queueEdit(sessionId: String, clientID: String, text: String) async throws -> Bool
    func queueForce(sessionId: String, clientID: String) async throws -> Bool
    func stop(sessionId: String) async throws -> Bool
    func compact(sessionId: String) async throws -> Bool
    /// a file part's bytes (images, attachments), fetched with the pairing token
    func fileBytes(path: String) async throws -> Data
    func respond(askId: String, optionId: String) async throws -> Bool
    func reject(askId: String) async throws -> Bool
    func readFile(sessionId: String, path: String) async throws -> String
    func rename(sessionId: String, title: String) async throws -> Bool
    /// tell the daemon it was looked at (`at` 0 = mark unread)
    func seen(sessionId: String, at: Int64) async throws -> Bool
    func delete(sessionId: String) async throws -> Bool
    func attach(sessionId: String, filename: String, bytes: Data) async throws -> String
    /// register (or drop) this device's push token with the gateway
    func registerPush(token: String) async throws -> Bool
    func unregisterPush(token: String) async throws -> Bool
    func events() -> AsyncStream<ChatEvent>
}

public extension ChatRepository {
    func history(sessionId: String, limit: Int = 0) async throws -> HistoryBatch {
        try await history(sessionId: sessionId, limit: limit, before: 0, have: 0)
    }

    func prompt(sessionId: String, text: String, files: [String] = [], quote: String? = nil) async throws -> ChatMessage {
        try await prompt(sessionId: sessionId, text: text, files: files, clientID: nil, mode: .steer, quote: quote)
    }

    func newSession(workspace: String?, path: String? = nil, harness: String? = nil, harnessSettings: [String: Bool] = [:]) async throws -> SessionSummary {
        try await newSession(title: nil, workspace: workspace, path: path, harness: harness, harnessSettings: harnessSettings)
    }
}

public struct SavedAttachment: Codable, Equatable, Hashable, Sendable {
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

public struct SavedDraft: Codable, Equatable, Sendable {
    public var text: String
    public var attachments: [SavedAttachment]
    public init(text: String = "", attachments: [SavedAttachment] = []) {
        self.text = text
        self.attachments = attachments
    }
}

public struct SavedSend: Codable, Equatable, Sendable {
    public var id: String
    public var body: String
    public var attachments: [SavedAttachment]
    public var time: Int64
    public var quote: String?
    public init(id: String, body: String, attachments: [SavedAttachment] = [], time: Int64 = 0, quote: String? = nil) {
        self.id = id
        self.body = body
        self.attachments = attachments
        self.time = time
        self.quote = quote
    }
}

/// What a conversation must not lose when the process does: the half-typed
/// message and the sends the daemon never took.
public protocol ConversationMemory: AnyObject {
    func loadDraft(sessionId: String) -> SavedDraft?
    func saveDraft(sessionId: String, draft: SavedDraft)
    func loadOutbox(sessionId: String) -> [SavedSend]
    func saveOutbox(sessionId: String, sends: [SavedSend])
}

/// remembers nothing: previews, tests
public final class NoMemory: ConversationMemory {
    public init() {}
    public func loadDraft(sessionId: String) -> SavedDraft? { nil }
    public func saveDraft(sessionId: String, draft: SavedDraft) {}
    public func loadOutbox(sessionId: String) -> [SavedSend] { [] }
    public func saveOutbox(sessionId: String, sends: [SavedSend]) {}
}

/// What the device needs to hear from the screens to decide whether to
/// interrupt the person. The screens only say what happened.
public protocol Attention: AnyObject {
    /// a conversation is on screen: a finished turn there is not news
    func chatOpened(sessionId: String)
    func chatClosed(sessionId: String)
    /// the person opened it: whatever was announced about it is seen
    func seen(sessionId: String)
}

public final class NoAttention: Attention {
    public init() {}
    public func chatOpened(sessionId: String) {}
    public func chatClosed(sessionId: String) {}
    public func seen(sessionId: String) {}
}

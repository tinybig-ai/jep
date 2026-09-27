import Foundation

/// how a message sent while the agent works joins the turn
public enum SendMode: String, Codable, Sendable, CaseIterable {
    /// folded into the running turn at its next tool call
    case steer
    /// held until the running turn ends, then run as its own
    case afterReply
    /// stops the running turn and runs next
    case now
}

public enum Role: String, Codable, Sendable {
    case user
    case assistant
}

public struct SessionSummary: Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var workspace: String
    public var createdAt: Int64
    public var updatedAt: Int64
    /// the workspace's friendly name
    public var adapter: String?
    /// the engine behind it (opencode/codex/claude) — display-only
    public var harness: String?
    public var subagents: Int
    /// a turn is in flight for it right now
    public var active: Bool
    /// when it was last looked at on any device, as the daemon keeps it (0 = never)
    public var seenAt: Int64

    public init(id: String, title: String, workspace: String = "", createdAt: Int64 = 0, updatedAt: Int64 = 0, adapter: String? = nil, harness: String? = nil, subagents: Int = 0, active: Bool = false, seenAt: Int64 = 0) {
        self.id = id
        self.title = title
        self.workspace = workspace
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.adapter = adapter
        self.harness = harness
        self.subagents = subagents
        self.active = active
        self.seenAt = seenAt
    }
}

/// a workspace the gateway serves, the harness behind it, and the directory it reads
public struct Workspace: Equatable, Hashable, Sendable {
    public var name: String
    public var harness: String
    public var dir: String
    public init(name: String, harness: String, dir: String = "") {
        self.name = name
        self.harness = harness
        self.dir = dir
    }
}

/// the harnesses installed on the machine, and the default
public struct Harnesses: Equatable, Sendable {
    public var ids: [String]
    public var defaultId: String?
    public init(ids: [String], defaultId: String?) {
        self.ids = ids
        self.defaultId = defaultId
    }
}

/// Harness-owned controls rendered by the client without harness-specific UI.
public struct HarnessSetting: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var description: String
    public var defaultValue: Bool
    public var danger: Bool
    public init(id: String, label: String, description: String, defaultValue: Bool = false, danger: Bool = false) {
        self.id = id
        self.label = label
        self.description = description
        self.defaultValue = defaultValue
        self.danger = danger
    }
}

public struct HarnessSettings: Equatable, Sendable {
    public var options: [HarnessSetting]
    public var values: [String: Bool]
    /// the harness can compress this conversation's context (Compact)
    public var canCompact: Bool
    public init(options: [HarnessSetting] = [], values: [String: Bool] = [:], canCompact: Bool = false) {
        self.options = options
        self.values = values
        self.canCompact = canCompact
    }
}

/// a SKILL.md the harness loads; `disabled` hides it from the model
public struct Skill: Equatable, Hashable, Sendable {
    public var name: String
    public var description: String
    public var scope: String
    public var path: String
    public var disabled: Bool
    public init(name: String, description: String, scope: String, path: String, disabled: Bool) {
        self.name = name
        self.description = description
        self.scope = scope
        self.path = path
        self.disabled = disabled
    }
}

public struct SkillSet: Equatable, Sendable {
    public var skills: [Skill]
    public var toggleable: Bool
    public init(skills: [Skill], toggleable: Bool) {
        self.skills = skills
        self.toggleable = toggleable
    }
}

public struct McpServer: Equatable, Hashable, Sendable {
    public var name: String
    public var kind: String
    public var enabled: Bool
    public var detail: String
    public init(name: String, kind: String, enabled: Bool, detail: String) {
        self.name = name
        self.kind = kind
        self.enabled = enabled
        self.detail = detail
    }
}

/// whether this gateway offers a terminal at all, and whether this device may open one
public struct TerminalAccess: Equatable, Sendable {
    public var allowed: Bool
    public var authorized: Bool
    public init(allowed: Bool, authorized: Bool) {
        self.allowed = allowed
        self.authorized = authorized
    }
}

/// a session in the user's own harness that jep doesn't serve, offered to fork in
public struct ImportableSession: Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var directory: String
    public var updatedAt: Int64
    public var harness: String
    public init(id: String, title: String, directory: String, updatedAt: Int64, harness: String = "") {
        self.id = id
        self.title = title
        self.directory = directory
        self.updatedAt = updatedAt
        self.harness = harness
    }
}

public struct DirEntry: Equatable, Hashable, Sendable {
    public var name: String
    public var git: Bool
    public init(name: String, git: Bool) {
        self.name = name
        self.git = git
    }
}

/// where the directory browser stands: `cwd`, the root it may not leave, the
/// parent (nil at the root), and the folders inside `cwd`
public struct BrowseResult: Equatable, Sendable {
    public var cwd: String
    public var root: String
    public var parent: String?
    public var dirs: [DirEntry]
    public init(cwd: String, root: String, parent: String?, dirs: [DirEntry]) {
        self.cwd = cwd
        self.root = root
        self.parent = parent
        self.dirs = dirs
    }
}

public struct Model: Equatable, Hashable, Sendable {
    public var providerID: String
    public var modelID: String
    public var image: Bool
    public var attachment: Bool
    public var contextLimit: Int64
    public var ref: String { "\(providerID)/\(modelID)" }
    public init(providerID: String, modelID: String, image: Bool = false, attachment: Bool = false, contextLimit: Int64 = 0) {
        self.providerID = providerID
        self.modelID = modelID
        self.image = image
        self.attachment = attachment
        self.contextLimit = contextLimit
    }
}

public struct AgentInfo: Equatable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var detail: String?
    public init(id: String, label: String, detail: String? = nil) {
        self.id = id
        self.label = label
        self.detail = detail
    }
}

/// the token breakdown a turn reported; `context` is what it held at its peak
public struct TokenUsage: Equatable, Hashable, Sendable {
    public var input: Int64
    public var output: Int64
    public var reasoning: Int64
    public var cacheRead: Int64
    public var cacheWrite: Int64
    public var total: Int64 { input + output + reasoning + cacheRead + cacheWrite }
    public var context: Int64 { input + cacheRead + cacheWrite }
    public init(input: Int64 = 0, output: Int64 = 0, reasoning: Int64 = 0, cacheRead: Int64 = 0, cacheWrite: Int64 = 0) {
        self.input = input
        self.output = output
        self.reasoning = reasoning
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }
}

public enum ToolStatus: String, Equatable, Hashable, Sendable {
    case pending, running, completed, error
}

public struct ToolCall: Equatable, Hashable, Sendable {
    public var id: String?
    public var name: String
    public var status: ToolStatus?
    public var title: String?
    /// the call's arguments, as compact JSON
    public var input: String?
    /// captured stdout / diff / result — what the collapsed row hides
    public var output: String?
    /// lines this call added / removed, when it edited a file
    public var added: Int?
    public var removed: Int?
    /// the change as a unified hunk ("-old" then "+new"), for the diff view
    public var diff: String?
    public init(id: String?, name: String, status: ToolStatus?, title: String?, input: String? = nil, output: String? = nil, added: Int? = nil, removed: Int? = nil, diff: String? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.title = title
        self.input = input
        self.output = output
        self.added = added
        self.removed = removed
        self.diff = diff
    }
}

public struct FilePart: Equatable, Hashable, Sendable {
    public var path: String
    public var name: String?
    public var mimeType: String?
    /// where the file is on this phone, for one it has just attached
    public var localURL: String?
    public init(path: String, name: String?, mimeType: String?, localURL: String? = nil) {
        self.path = path
        self.name = name
        self.mimeType = mimeType
        self.localURL = localURL
    }
}

public enum ChatPart: Equatable, Hashable, Sendable {
    case text(String)
    /// the words a message answers, drawn above it as a reply is in a chat app
    case quote(String)
    case tool(ToolCall)
    case reasoning(String, durationMs: Int64?)
    /// a file the agent produced or read (images, patches, attachments)
    case file(FilePart)
    /// the harness folded the conversation; renders as a divider, not a bubble
    case compaction
    /// the harness told the model to keep going after a fold; scaffolding, not the user's words
    case autoContinue
    case unsupported(String)

    public var toolCall: ToolCall? {
        if case .tool(let t) = self { return t }
        return nil
    }

    public var textValue: String? {
        if case .text(let t) = self { return t }
        return nil
    }
}

public struct ChatMessage: Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var role: Role
    public var time: Int64
    public var parts: [ChatPart]
    public var error: String?
    /// a local send the harness never accepted — drawn dimmed, retryable
    public var undelivered: Bool
    public var model: String?
    public var cost: Double?
    public var tokens: TokenUsage?
    /// how long the reply took, when the harness recorded a completion time
    public var durationMs: Int64?

    public init(id: String, role: Role, time: Int64, parts: [ChatPart], error: String? = nil, undelivered: Bool = false, model: String? = nil, cost: Double? = nil, tokens: TokenUsage? = nil, durationMs: Int64? = nil) {
        self.id = id
        self.role = role
        self.time = time
        self.parts = parts
        self.error = error
        self.undelivered = undelivered
        self.model = model
        self.cost = cost
        self.tokens = tokens
        self.durationMs = durationMs
    }
}

public struct AskOption: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var danger: Bool
    public init(id: String, label: String, danger: Bool = false) {
        self.id = id
        self.label = label
        self.danger = danger
    }
}

/// One question inside a `question` ask; each keeps its own choices.
public struct AskQuestion: Equatable, Hashable, Sendable {
    public var title: String
    public var detail: String?
    public var multiple: Bool
    public var options: [AskOption]
    public init(title: String, detail: String? = nil, multiple: Bool = false, options: [AskOption] = []) {
        self.title = title
        self.detail = detail
        self.multiple = multiple
        self.options = options
    }
}

public struct Ask: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String?
    public var options: [AskOption]
    public var questions: [AskQuestion]
    /// "permission" or "question"
    public var kind: String?
    public var messageId: String?
    public var callId: String?
    /// when it was raised, on the harness's clock
    public var at: Int64?
    public init(id: String, title: String, detail: String? = nil, options: [AskOption] = [], questions: [AskQuestion] = [], kind: String? = nil, messageId: String? = nil, callId: String? = nil, at: Int64? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
        self.options = options
        self.questions = questions
        self.kind = kind
        self.messageId = messageId
        self.callId = callId
        self.at = at
    }
}

/// An ask as the conversation's record keeps it. `pending` is still waiting on
/// a human; `choice` is the option picked when a client picked one.
public struct AskEntry: Equatable, Hashable, Sendable {
    public var ask: Ask
    public var pending: Bool
    public var choice: String?
    public init(ask: Ask, pending: Bool = false, choice: String? = nil) {
        self.ask = ask
        self.pending = pending
        self.choice = choice
    }
}

/// what a conversation has spent, summed from the harness's own record
public struct Usage: Equatable, Sendable {
    public var input: Int64 = 0
    public var output: Int64 = 0
    public var reasoning: Int64 = 0
    public var cacheRead: Int64 = 0
    public var cacheWrite: Int64 = 0
    public var total: Int64 = 0
    public var cost: Double = 0
    public var priced: Int = 0
    public var unpriced: Int = 0
    public var turns: Int = 0
    public var models: [String] = []
    public init(input: Int64 = 0, output: Int64 = 0, reasoning: Int64 = 0, cacheRead: Int64 = 0, cacheWrite: Int64 = 0, total: Int64 = 0, cost: Double = 0, priced: Int = 0, unpriced: Int = 0, turns: Int = 0, models: [String] = []) {
        self.input = input
        self.output = output
        self.reasoning = reasoning
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.total = total
        self.cost = cost
        self.priced = priced
        self.unpriced = unpriced
        self.turns = turns
        self.models = models
    }
}

public struct FileDiff: Equatable, Hashable, Sendable {
    public var file: String
    public var additions: Int
    public var deletions: Int
    public var status: String?
    public init(file: String, additions: Int, deletions: Int, status: String? = nil) {
        self.file = file
        self.additions = additions
        self.deletions = deletions
        self.status = status
    }
}

public struct GitCommit: Equatable, Hashable, Sendable {
    public var hash: String
    public var shortHash: String
    public var subject: String
    public var author: String
    public var time: Int64
    public init(hash: String, shortHash: String, subject: String, author: String, time: Int64) {
        self.hash = hash
        self.shortHash = shortHash
        self.subject = subject
        self.author = author
        self.time = time
    }
}

public struct GitSnapshot: Equatable, Sendable {
    public var isRepository: Bool
    public var branch: String?
    public var head: GitCommit?
    public var changedFiles: Int
    public var commits: [GitCommit]
    public init(isRepository: Bool, branch: String? = nil, head: GitCommit? = nil, changedFiles: Int = 0, commits: [GitCommit] = []) {
        self.isRepository = isRepository
        self.branch = branch
        self.head = head
        self.changedFiles = changedFiles
        self.commits = commits
    }
}

public enum ThemeMode: String, CaseIterable, Sendable {
    case system = "SYSTEM", light = "LIGHT", dark = "DARK"
}

public enum TextSize: String, CaseIterable, Sendable {
    case extraSmall = "EXTRA_SMALL", small = "SMALL", standard = "DEFAULT", large = "LARGE", extraLarge = "EXTRA_LARGE"

    public var label: String {
        switch self {
        case .extraSmall: "XS"
        case .small: "S"
        case .standard: "M"
        case .large: "L"
        case .extraLarge: "XL"
        }
    }

    public var scale: Double {
        switch self {
        case .extraSmall: 0.80
        case .small: 0.88
        case .standard: 1
        case .large: 1.12
        case .extraLarge: 1.25
        }
    }

    public static func from(_ name: String?) -> TextSize { name.flatMap(TextSize.init(rawValue:)) ?? .standard }
}

import Foundation

// Flat, tolerant DTOs mirroring the gateway JSON (docs/GATEWAY.md). Every
// field has a default so an unknown variant rides through without breaking the
// parser; mapping into domain types is Mappers.swift's job, never the UI's.

struct PairRes: Decodable {
    var token: String
    var nextCode: String?
}

struct SessionDto: Decodable {
    var id: String
    var title: String
    var subagents: Int
    var active: Bool
    var workspace: String
    var createdAt: Int64
    var updatedAt: Int64
    var adapter: String?
    var harness: String?
    var seenAt: Int64
    var pinned: Bool
    var pod: Bool

    enum K: String, CodingKey { case id, title, subagents, active, workspace, createdAt, updatedAt, adapter, harness, seenAt, pinned, pod }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.v(.title, "")
        subagents = c.v(.subagents, 0)
        active = c.v(.active, false)
        workspace = c.v(.workspace, "")
        createdAt = c.v(.createdAt, 0)
        updatedAt = c.v(.updatedAt, 0)
        adapter = c.o(.adapter)
        harness = c.o(.harness)
        seenAt = c.v(.seenAt, 0)
        pinned = c.v(.pinned, false)
        pod = c.v(.pod, false)
    }
}

struct ItemsRes<T: Decodable>: Decodable {
    var items: [T]
    enum K: String, CodingKey { case items }
    init(from d: Decoder) throws { items = try d.container(keyedBy: K.self).v(.items, []) }
}

/// the gateway answers a failure with {error:"…"}; the harness adapters phrase
/// their own as {name,message}. Keep both.
struct ErrorDto: Decodable {
    var name: String?
    var message: String?
    var error: String?
}

struct TokensDto: Decodable {
    var input: Int64, output: Int64, reasoning: Int64, cacheRead: Int64, cacheWrite: Int64
    enum K: String, CodingKey { case input, output, reasoning, cache }
    enum CK: String, CodingKey { case read, write }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        input = c.v(.input, 0)
        output = c.v(.output, 0)
        reasoning = c.v(.reasoning, 0)
        let cache = try? c.nestedContainer(keyedBy: CK.self, forKey: .cache)
        cacheRead = cache?.v(.read, Int64(0)) ?? 0
        cacheWrite = cache?.v(.write, Int64(0)) ?? 0
    }
}

struct PartDto: Decodable {
    var kind: String
    var id: String?
    var text: String?
    var name: String?
    var status: String?
    var title: String?
    var filePath: String?
    var fileName: String?
    var mimeType: String?
    var input: JSONValue?
    var output: JSONValue?
    var durationMs: Int64?
    var nativeType: String?

    enum K: String, CodingKey { case kind, id, text, name, status, title, filePath, fileName, mimeType, input, output, durationMs, nativeType }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        kind = c.v(.kind, "other")
        id = c.o(.id)
        text = c.o(.text)
        name = c.o(.name)
        status = c.o(.status)
        title = c.o(.title)
        filePath = c.o(.filePath)
        fileName = c.o(.fileName)
        mimeType = c.o(.mimeType)
        input = c.o(.input)
        output = c.o(.output)
        durationMs = c.o(.durationMs)
        nativeType = c.o(.nativeType)
    }
}

struct MessageDto: Decodable {
    var id: String
    var role: String
    var time: Int64
    var parts: [PartDto]
    var error: ErrorDto?
    var model: String?
    var cost: Double?
    var tokens: TokensDto?
    var durationMs: Int64?

    enum K: String, CodingKey { case id, role, time, parts, error, model, cost, tokens, durationMs }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        role = c.v(.role, "assistant")
        time = c.v(.time, 0)
        parts = c.v(.parts, [])
        error = c.o(.error)
        model = c.o(.model)
        cost = c.o(.cost)
        tokens = c.o(.tokens)
        durationMs = c.o(.durationMs)
    }
}

struct MessageRes: Decodable {
    var message: MessageDto?
    var aborted: Bool
    var cancelled: Bool
    enum K: String, CodingKey { case message, aborted, cancelled }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        message = c.o(.message)
        aborted = c.v(.aborted, false)
        cancelled = c.v(.cancelled, false)
    }
}

struct MkdirRes: Decodable {
    var path: String
    enum K: String, CodingKey { case path }
    init(from d: Decoder) throws { path = try d.container(keyedBy: K.self).v(.path, "") }
}

struct NextCodeRes: Decodable {
    var nextCode: String?
}

struct HistoryRes: Decodable {
    var messages: [MessageDto]
    var hasMore: Bool
    var asks: [AskDto]
    var etag: String?
    var unchanged: Bool
    enum K: String, CodingKey { case messages, hasMore, asks, etag, unchanged }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        messages = c.v(.messages, [])
        hasMore = c.v(.hasMore, false)
        asks = c.v(.asks, [])
        etag = c.o(.etag)
        unchanged = c.v(.unchanged, false)
    }
}

struct NewSessionRes: Decodable {
    var session: SessionDto
}

struct WorkspaceDto: Decodable {
    var name: String, harness: String, dir: String, pod: Bool
    enum K: String, CodingKey { case name, harness, dir, pod }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        name = c.v(.name, "")
        harness = c.v(.harness, "")
        dir = c.v(.dir, "")
        pod = c.v(.pod, false)
    }
}

struct HarnessesRes: Decodable {
    var harnesses: [String]
    var defaultId: String?
    enum K: String, CodingKey { case harnesses, defaultId = "default" }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        harnesses = c.v(.harnesses, [])
        defaultId = c.o(.defaultId)
    }
}

struct HarnessSettingDto: Decodable {
    var id: String, label: String, description: String, defaultValue: Bool, danger: Bool
    enum K: String, CodingKey { case id, label, description, defaultValue = "default", danger }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = c.v(.id, "")
        label = c.v(.label, "")
        description = c.v(.description, "")
        defaultValue = c.v(.defaultValue, false)
        danger = c.v(.danger, false)
    }
}

struct HarnessSettingsRes: Decodable {
    var options: [HarnessSettingDto]
    var values: [String: Bool]
    var compact: Bool
    enum K: String, CodingKey { case options, values, compact }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        options = c.v(.options, [])
        values = c.v(.values, [:])
        compact = c.v(.compact, false)
    }
}

struct DirEntryDto: Decodable {
    var name: String, git: Bool
    enum K: String, CodingKey { case name, git }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        name = c.v(.name, "")
        git = c.v(.git, false)
    }
}

struct BrowseRes: Decodable {
    var cwd: String, root: String, parent: String?, dirs: [DirEntryDto]
    enum K: String, CodingKey { case cwd, root, parent, dirs }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        cwd = c.v(.cwd, "")
        root = c.v(.root, "")
        parent = c.o(.parent)
        dirs = c.v(.dirs, [])
    }
}

struct ModelDto: Decodable {
    var providerID: String, modelID: String, image: Bool, attachment: Bool, contextLimit: Int64
    enum K: String, CodingKey { case providerID, modelID, image, attachment, contextLimit }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        providerID = c.v(.providerID, "")
        modelID = c.v(.modelID, "")
        image = c.v(.image, false)
        attachment = c.v(.attachment, false)
        contextLimit = c.v(.contextLimit, 0)
    }
}

struct ModelsRes: Decodable {
    var models: [ModelDto], current: String?, defaultRef: String?, contextLimit: Int64
    enum K: String, CodingKey { case models, current, defaultRef = "default", contextLimit }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        models = c.v(.models, [])
        current = c.o(.current)
        defaultRef = c.o(.defaultRef)
        contextLimit = c.v(.contextLimit, 0)
    }
}

struct AgentRes: Decodable {
    var current: String?
}

struct AgentDto: Decodable {
    var id: String, label: String, detail: String?
    enum K: String, CodingKey { case id, label, detail }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = c.v(.id, "")
        label = c.v(.label, "")
        detail = c.o(.detail)
    }
}

struct AgentsRes: Decodable {
    var agents: [AgentDto]
    enum K: String, CodingKey { case agents }
    init(from d: Decoder) throws { agents = try d.container(keyedBy: K.self).v(.agents, []) }
}

struct SkillDto: Decodable {
    var name: String, description: String, scope: String, path: String, disableModelInvocation: Bool
    enum K: String, CodingKey { case name, description, scope, path, disableModelInvocation }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        name = c.v(.name, "")
        description = c.v(.description, "")
        scope = c.v(.scope, "")
        path = c.v(.path, "")
        disableModelInvocation = c.v(.disableModelInvocation, false)
    }
}

struct SkillsRes: Decodable {
    var skills: [SkillDto], toggleable: Bool
    enum K: String, CodingKey { case skills, toggleable }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        skills = c.v(.skills, [])
        toggleable = c.v(.toggleable, false)
    }
}

struct McpDto: Decodable {
    var name: String, kind: String, enabled: Bool, detail: String
    enum K: String, CodingKey { case name, kind, enabled, detail }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        name = c.v(.name, "")
        kind = c.v(.kind, "")
        enabled = c.v(.enabled, false)
        detail = c.v(.detail, "")
    }
}

struct McpRes: Decodable {
    var servers: [McpDto]
    enum K: String, CodingKey { case servers }
    init(from d: Decoder) throws { servers = try d.container(keyedBy: K.self).v(.servers, []) }
}

struct TermStatusRes: Decodable {
    var allowed: Bool, authorized: Bool
    enum K: String, CodingKey { case allowed, authorized }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        allowed = c.v(.allowed, false)
        authorized = c.v(.authorized, false)
    }
}

struct TextRes: Decodable {
    var text: String
    enum K: String, CodingKey { case text }
    init(from d: Decoder) throws { text = try d.container(keyedBy: K.self).v(.text, "") }
}

struct ImportableDto: Decodable {
    var harness: String, id: String, title: String, directory: String, updated: Int64
    enum K: String, CodingKey { case harness, id, title, directory, updated }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        harness = c.v(.harness, "")
        id = c.v(.id, "")
        title = c.v(.title, "")
        directory = c.v(.directory, "")
        updated = c.v(.updated, 0)
    }
}

struct ImportableRes: Decodable {
    var sessions: [ImportableDto]
    enum K: String, CodingKey { case sessions }
    init(from d: Decoder) throws { sessions = try d.container(keyedBy: K.self).v(.sessions, []) }
}

struct UsageDto: Decodable {
    var usage: Usage
    enum K: String, CodingKey { case usage }
    enum U: String, CodingKey { case input, output, reasoning, cacheRead, cacheWrite, total, cost, priced, unpriced, turns, models }
    init(from d: Decoder) throws {
        let outer = try d.container(keyedBy: K.self)
        guard let c = try? outer.nestedContainer(keyedBy: U.self, forKey: .usage) else {
            usage = Usage()
            return
        }
        usage = Usage(
            input: c.v(.input, 0), output: c.v(.output, 0), reasoning: c.v(.reasoning, 0),
            cacheRead: c.v(.cacheRead, 0), cacheWrite: c.v(.cacheWrite, 0), total: c.v(.total, 0),
            cost: c.v(.cost, 0.0), priced: c.v(.priced, 0), unpriced: c.v(.unpriced, 0),
            turns: c.v(.turns, 0), models: c.v(.models, [])
        )
    }
}

struct FileDiffDto: Decodable {
    var file: String, additions: Int, deletions: Int, status: String?
    enum K: String, CodingKey { case file, additions, deletions, status }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        file = c.v(.file, "")
        additions = c.v(.additions, 0)
        deletions = c.v(.deletions, 0)
        status = c.o(.status)
    }
}

struct DiffRes: Decodable {
    var files: [FileDiffDto]
    enum K: String, CodingKey { case files }
    init(from d: Decoder) throws { files = try d.container(keyedBy: K.self).v(.files, []) }
}

struct GitCommitDto: Decodable {
    var hash: String, shortHash: String, subject: String, author: String, time: Int64
    enum K: String, CodingKey { case hash, shortHash, subject, author, time }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        hash = c.v(.hash, "")
        shortHash = c.v(.shortHash, "")
        subject = c.v(.subject, "")
        author = c.v(.author, "")
        time = c.v(.time, 0)
    }
}

struct GitRes: Decodable {
    var isRepository: Bool, branch: String?, head: GitCommitDto?, changedFiles: Int, commits: [GitCommitDto]
    enum K: String, CodingKey { case isRepository, branch, head, changedFiles, commits }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        isRepository = c.v(.isRepository, false)
        branch = c.o(.branch)
        head = c.o(.head)
        changedFiles = c.v(.changedFiles, 0)
        commits = c.v(.commits, [])
    }
}

struct AttachRes: Decodable {
    var id: String
}

struct AskOptionDto: Decodable {
    var id: String, label: String, style: String?
}

struct AskQuestionDto: Decodable {
    var title: String, detail: String?, multiple: Bool, options: [AskOptionDto]
    enum K: String, CodingKey { case title, detail, multiple, options }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        title = c.v(.title, "")
        detail = c.o(.detail)
        multiple = c.v(.multiple, false)
        options = c.v(.options, [])
    }
}

struct AskDto: Decodable {
    var id: String
    var sessionID: String
    var title: String
    var detail: String?
    var options: [AskOptionDto]
    var kind: String?
    var questions: [AskQuestionDto]
    var messageID: String?
    var callID: String?
    var at: Int64?
    /// in /history's ask record: pending, answered or closed
    var state: String?
    /// the option a client picked, when state is answered
    var answer: String?

    enum K: String, CodingKey { case id, sessionID, title, detail, options, kind, questions, messageID, callID, at, state, answer }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        sessionID = c.v(.sessionID, "")
        title = c.v(.title, "")
        detail = c.o(.detail)
        options = c.v(.options, [])
        kind = c.o(.kind)
        questions = c.v(.questions, [])
        messageID = c.o(.messageID)
        callID = c.o(.callID)
        at = c.o(.at)
        state = c.o(.state)
        answer = c.o(.answer)
    }
}

/// one shape for every DomainEvent the gateway forwards
struct EventDto: Decodable {
    var type: String
    var sessionID: String?
    var messageID: String?
    var partID: String?
    var partType: String?
    var text: String?
    var role: String?
    var part: PartDto?
    var ask: AskDto?
    var askID: String?
    var message: String?

    enum K: String, CodingKey { case type, sessionID, messageID, partID, partType, text, role, part, ask, askID, message }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        type = c.v(.type, "other")
        sessionID = c.o(.sessionID)
        messageID = c.o(.messageID)
        partID = c.o(.partID)
        partType = c.o(.partType)
        text = c.o(.text)
        role = c.o(.role)
        part = c.o(.part)
        ask = c.o(.ask)
        askID = c.o(.askID)
        message = c.o(.message)
    }
}

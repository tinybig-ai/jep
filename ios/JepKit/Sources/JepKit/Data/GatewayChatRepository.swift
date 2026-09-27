import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How a request travels. URLSession in the app; a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Int, Data)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Int, Data) {
        try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: request) { data, response, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data()))
                }
            }.resume()
        }
    }
}

// The gateway's protocol, behind the one port the app knows. URLSession lives
// here and nowhere else; domain and presentation stay transport-blind.
public final class GatewayChatRepository: ChatRepository, @unchecked Sendable {
    private let base: String
    private let token: @Sendable () -> String?
    private let http: HTTPTransport
    /// the daemon rotates its pairing code per use; every response that carries
    /// the next one hands it here, so the person never has to read it off the machine
    private let onNextCode: @Sendable (String?) -> Void
    private let decoder = JSONDecoder()
    /// the last newest-page answer per conversation and its tag: while a turn
    /// is polled the page is mostly unchanged, and the tag lets the gateway
    /// answer "unchanged" in a few bytes
    private var lastPage: [String: (String, HistoryBatch)] = [:]
    private let lock = NSLock()

    public init(base: String, token: @escaping @Sendable () -> String?, http: HTTPTransport = URLSessionTransport(), onNextCode: @escaping @Sendable (String?) -> Void = { _ in }) {
        self.base = base.hasSuffix("/") ? String(base.dropLast()) : base
        self.token = token
        self.http = http
        self.onNextCode = onNextCode
    }

    // MARK: plumbing

    private func request(_ url: String, body: Data?, contentType: String = "application/json", authed: Bool = true) throws -> URLRequest {
        guard let u = URL(string: url) else { throw ApiFailure(status: 0, message: "that isn't a gateway address") }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue(contentType, forHTTPHeaderField: "content-type")
        if authed, let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
        req.httpBody = body
        return req
    }

    private func body(_ fields: [String: Any?]) -> Data {
        var clean: [String: Any] = [:]
        for (k, v) in fields { if let v { clean[k] = v } }
        return (try? JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    private func post(_ path: String, _ fields: [String: Any?] = [:]) async throws -> (Int, Data) {
        try await http.send(request(base + path, body: body(fields)))
    }

    private func failure(_ status: Int, _ data: Data, fallback: String? = nil) -> ApiFailure {
        let err = try? decoder.decode(ErrorDto.self, from: data)
        return ApiFailure(status: status, message: err?.message ?? err?.error ?? fallback ?? "gateway said \(status)")
    }

    private func decode<T: Decodable>(_ path: String, _ type: T.Type, _ fields: [String: Any?] = [:]) async throws -> T {
        let (status, data) = try await post(path, fields)
        guard (200..<300).contains(status) else { throw failure(status, data) }
        return try decoder.decode(T.self, from: data)
    }

    private func ok(_ path: String, _ fields: [String: Any?]) async throws -> Bool {
        (200..<300).contains(try await post(path, fields).0)
    }

    // MARK: routes

    public func pair(baseUrl: String, code: String) async throws -> String {
        let (status, data) = try await http.send(request(baseUrl + "/pair", body: body(["code": code]), authed: false))
        guard status == 200 else { throw failure(status, data, fallback: "pairing failed") }
        let res = try decoder.decode(PairRes.self, from: data)
        onNextCode(res.nextCode)
        return res.token
    }

    public func sessions() async throws -> [SessionSummary] {
        try await decode("/sessions", ItemsRes<SessionDto>.self).items.map { $0.toDomain() }
    }

    public func workspaces() async throws -> [Workspace] {
        try await decode("/workspaces", ItemsRes<WorkspaceDto>.self).items.map { $0.toDomain() }
    }

    public func harnesses() async throws -> Harnesses {
        let r = try await decode("/harnesses", HarnessesRes.self)
        return Harnesses(ids: r.harnesses, defaultId: r.defaultId)
    }

    public func browse(path: String?) async throws -> BrowseResult {
        try await decode("/browse", BrowseRes.self, ["path": path]).toDomain()
    }

    public func newFolder(path: String?, name: String) async throws -> String {
        try await decode("/mkdir", MkdirRes.self, ["path": path, "name": name]).path
    }

    public func archivedSessions() async throws -> [SessionSummary] {
        try await decode("/archived", ItemsRes<SessionDto>.self).items.map { $0.toDomain() }
    }

    public func newSession(title: String?, workspace: String?, path: String?, harness: String?, harnessSettings: [String: Bool]) async throws -> SessionSummary {
        try await decode("/new", NewSessionRes.self, [
            "title": title, "workspace": workspace, "path": path, "harness": harness,
            "harnessSettings": harnessSettings.isEmpty ? nil : harnessSettings,
        ]).session.toDomain()
    }

    public func harnessOptions(harness: String) async throws -> [HarnessSetting] {
        try await decode("/harness-settings", HarnessSettingsRes.self, ["harness": harness]).options.map { $0.toDomain() }
    }

    public func sessionHarnessSettings(sessionId: String) async throws -> HarnessSettings {
        try await decode("/harness-settings", HarnessSettingsRes.self, ["id": sessionId]).toDomain()
    }

    public func setSessionHarnessSetting(sessionId: String, key: String, enabled: Bool) async throws -> Bool {
        try await ok("/set-harness-setting", ["id": sessionId, "key": key, "enabled": enabled])
    }

    public func models(sessionId: String) async throws -> ModelChoices {
        let r = try await decode("/models", ModelsRes.self, ["id": sessionId])
        return ModelChoices(all: r.models.map { $0.toDomain() }, current: r.current, defaultRef: r.defaultRef, contextLimit: r.contextLimit)
    }

    public func setModel(sessionId: String, ref: String?) async throws -> Bool {
        try await ok("/setmodel", ["id": sessionId, "model": ref ?? ""])
    }

    public func agent(sessionId: String) async throws -> String? {
        try await decode("/agent", AgentRes.self, ["id": sessionId]).current
    }

    public func agents(sessionId: String) async throws -> [AgentInfo] {
        try await decode("/agents", AgentsRes.self, ["id": sessionId]).agents.map { $0.toDomain() }
    }

    public func setAgent(sessionId: String, agent: String?) async throws -> Bool {
        try await ok("/setagent", ["id": sessionId, "agent": agent ?? ""])
    }

    public func usage(sessionId: String) async throws -> Usage {
        try await decode("/usage", UsageDto.self, ["id": sessionId]).usage
    }

    public func diff(sessionId: String) async throws -> [FileDiff] {
        try await decode("/diff", DiffRes.self, ["id": sessionId]).files.map { $0.toDomain() }
    }

    public func git(sessionId: String) async throws -> GitSnapshot {
        try await decode("/git", GitRes.self, ["id": sessionId]).toDomain()
    }

    public func skills(sessionId: String) async throws -> SkillSet {
        try await decode("/skills", SkillsRes.self, ["id": sessionId]).toDomain()
    }

    public func setSkill(sessionId: String, path: String, disabled: Bool) async throws -> Bool {
        try await ok("/setskill", ["id": sessionId, "path": path, "disabled": disabled])
    }

    public func mcp(sessionId: String) async throws -> [McpServer] {
        try await decode("/mcp", McpRes.self, ["id": sessionId]).servers.map { $0.toDomain() }
    }

    public func setMcp(sessionId: String, name: String, enabled: Bool) async throws -> Bool {
        try await ok("/setmcp", ["id": sessionId, "name": name, "enabled": enabled])
    }

    public func subagents(sessionId: String) async throws -> [SessionSummary] {
        try await decode("/subagents", ItemsRes<SessionDto>.self, ["id": sessionId]).items.map { $0.toDomain() }
    }

    public func importableSessions() async throws -> [ImportableSession] {
        try await decode("/importable", ImportableRes.self).sessions.map { $0.toDomain() }
    }

    public func importSession(sessionId: String) async throws -> Bool { try await ok("/import", ["id": sessionId]) }
    public func archiveSession(sessionId: String) async throws -> Bool { try await ok("/archive", ["id": sessionId]) }
    public func unarchiveSession(sessionId: String) async throws -> Bool { try await ok("/unarchive", ["id": sessionId]) }

    public func terminalStatus() async throws -> TerminalAccess {
        let r = try await decode("/term", TermStatusRes.self)
        return TerminalAccess(allowed: r.allowed, authorized: r.authorized)
    }

    public func unlockTerminal(code: String) async throws -> Bool {
        let (status, data) = try await post("/term/unlock", ["code": code])
        guard (200..<300).contains(status) else { return false }
        onNextCode((try? decoder.decode(NextCodeRes.self, from: data))?.nextCode)
        return true
    }

    public func lockTerminal() async throws -> Bool { try await ok("/term/lock", [:]) }
    public func termOpen(sessionId: String) async throws -> Bool { try await ok("/term/open", ["id": sessionId]) }

    public func termFrame(sessionId: String) async throws -> String {
        try await decode("/term/frame", TextRes.self, ["id": sessionId]).text
    }

    public func termInput(sessionId: String, text: String) async throws -> Bool { try await ok("/term/input", ["id": sessionId, "text": text]) }
    public func termKey(sessionId: String, key: String) async throws -> Bool { try await ok("/term/input", ["id": sessionId, "key": key]) }
    public func termClose(sessionId: String) async throws -> Bool { try await ok("/term/close", ["id": sessionId]) }

    public func history(sessionId: String, limit: Int, before: Int64, have: Int) async throws -> HistoryBatch {
        // only the newest page is polled; an older page is fetched once
        let key: String? = (before <= 0 && have <= 0) ? "\(sessionId)|\(limit)" : nil
        let held: (String, HistoryBatch)? = key.flatMap { k in lock.withLock { lastPage[k] } }
        let res = try await decode("/history", HistoryRes.self, [
            "id": sessionId,
            "limit": limit > 0 ? limit : nil,
            "before": before > 0 ? before : nil,
            "have": have > 0 ? have : nil,
            "etag": held?.0,
        ])
        if res.unchanged, let held, res.etag == held.0 { return held.1 }
        let batch = HistoryBatch(messages: res.messages.map { $0.toDomain() }, hasMore: res.hasMore, asks: res.asks.map { $0.toEntry() })
        if let key, let etag = res.etag { lock.withLock { lastPage[key] = (etag, batch) } }
        return batch
    }

    public func prompt(sessionId: String, text: String, files: [String], clientID: String?, mode: SendMode, quote: String?) async throws -> ChatMessage {
        var fields: [String: Any?] = [
            "id": sessionId,
            "text": text,
            "files": files.isEmpty ? nil : files,
            "clientID": clientID,
            // a jep quote, not markdown in the words: the daemon hands it on
            "quote": (quote?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? quote : nil,
        ]
        // the daemon steers by default; only say so when it should not
        switch mode {
        case .steer: break
        case .afterReply: fields["steer"] = false
        case .now: fields["force"] = true
        }
        let (status, data) = try await post("/prompt", fields)
        guard (200..<300).contains(status) else {
            // 409 is "a turn is already running": say so in words
            if status == 409 { throw ApiFailure(status: 409, message: "the agent is still working on the last reply") }
            throw failure(status, data)
        }
        let dto = try decoder.decode(MessageRes.self, from: data)
        // a stop is not a failure, and a cancel is the queued prompt withdrawn
        if dto.aborted || dto.cancelled { throw TurnAborted() }
        guard let m = dto.message else { throw ApiFailure(status: status, message: "gateway returned no message for the turn") }
        return m.toDomain()
    }

    public func queueCancel(sessionId: String, clientID: String) async throws -> Bool { try await ok("/queue/cancel", ["id": sessionId, "clientID": clientID]) }
    public func queueEdit(sessionId: String, clientID: String, text: String) async throws -> Bool { try await ok("/queue/edit", ["id": sessionId, "clientID": clientID, "text": text]) }
    public func queueForce(sessionId: String, clientID: String) async throws -> Bool { try await ok("/queue/force", ["id": sessionId, "clientID": clientID]) }
    public func seen(sessionId: String, at: Int64) async throws -> Bool { try await ok("/seen", ["id": sessionId, "at": at]) }
    public func rename(sessionId: String, title: String) async throws -> Bool { try await ok("/rename", ["id": sessionId, "title": title]) }
    public func delete(sessionId: String) async throws -> Bool { try await ok("/delete", ["id": sessionId]) }
    public func stop(sessionId: String) async throws -> Bool { try await ok("/stop", ["id": sessionId]) }

    public func attach(sessionId: String, filename: String, bytes: Data) async throws -> String {
        var q = URLComponents()
        q.queryItems = [URLQueryItem(name: "id", value: sessionId), URLQueryItem(name: "name", value: filename)]
        let url = base + "/attach?" + (q.percentEncodedQuery ?? "")
        let (status, data) = try await http.send(request(url, body: bytes, contentType: "application/octet-stream"))
        guard (200..<300).contains(status) else { throw failure(status, data) }
        return try decoder.decode(AttachRes.self, from: data).id
    }

    public func compact(sessionId: String) async throws -> Bool {
        let (status, data) = try await post("/compact", ["id": sessionId])
        if (200..<300).contains(status) { return true }
        // the gateway's error body is the truthful reason
        let reason = (try? decoder.decode(ErrorDto.self, from: data))?.error ?? "couldn't compact (\(status))"
        throw ApiFailure(status: status, message: reason)
    }

    public func fileBytes(path: String) async throws -> Data {
        guard let req = fileRequest(path: path) else { throw ApiFailure(status: 0, message: "bad file path") }
        let (status, data) = try await http.send(req)
        guard (200..<300).contains(status) else { throw failure(status, data) }
        return data
    }

    func fileRequest(path: String) -> URLRequest? {
        let enc = Data(path.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        guard let url = URL(string: "\(base)/file?p=\(enc)") else { return nil }
        var req = URLRequest(url: url)
        // the token rides a header, never the URL, so it can't end up in a log
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
        return req
    }

    public func respond(askId: String, optionId: String) async throws -> Bool { try await ok("/respond", ["askID": askId, "optionID": optionId]) }
    public func reject(askId: String) async throws -> Bool { try await ok("/reject", ["askID": askId]) }

    public func readFile(sessionId: String, path: String) async throws -> String {
        let (status, data) = try await post("/read", ["id": sessionId, "path": path])
        guard (200..<300).contains(status) else { throw failure(status, data, fallback: "the gateway said \(status)") }
        return try decoder.decode(TextRes.self, from: data).text
    }

    public func registerPush(token deviceToken: String) async throws -> Bool { try await ok("/push/register", ["token": deviceToken]) }
    public func unregisterPush(token deviceToken: String) async throws -> Bool { try await ok("/push/unregister", ["token": deviceToken]) }

    public func events() -> AsyncStream<ChatEvent> {
        guard let t = token(), let url = URL(string: base + "/stream") else {
            return AsyncStream { $0.finish() }
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.timeoutInterval = 24 * 3600
        return GatewayEventStream(request: req).open()
    }
}

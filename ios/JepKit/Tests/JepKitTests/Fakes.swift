import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import JepKit

/// A gateway in memory: each route answers from a closure, and every call is recorded.
final class FakeGateway: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable ([String: Any]) async throws -> (Int, String)
    private let lock = NSLock()
    private var routes: [String: Handler] = [:]
    private(set) var calls: [(path: String, body: [String: Any], auth: String?)] = []

    func on(_ path: String, _ handler: @escaping Handler) { lock.withLock { routes[path] = handler } }
    func on(_ path: String, json: String) { on(path) { _ in (200, json) } }
    func bodies(_ path: String) -> [[String: Any]] { lock.withLock { calls.filter { $0.path == path }.map(\.body) } }

    func send(_ request: URLRequest) async throws -> (Int, Data) {
        let path = request.url?.path ?? ""
        let body = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        let handler: Handler? = lock.withLock {
            calls.append((path, body, request.value(forHTTPHeaderField: "authorization")))
            return routes[path]
        }
        guard let handler else { return (404, Data(#"{"error":"no route"}"#.utf8)) }
        let (status, text) = try await handler(body)
        return (status, Data(text.utf8))
    }
}

func msg(_ id: String, _ role: Role = .assistant, _ time: Int64 = 1, _ text: String = "hi", durationMs: Int64? = nil) -> ChatMessage {
    ChatMessage(id: id, role: role, time: time, parts: [.text(text)], durationMs: durationMs)
}

func tool(_ id: String, _ name: String = "read") -> ChatPart {
    .tool(ToolCall(id: id, name: name, status: .completed, title: nil))
}

final class RecordingMemory: ConversationMemory, @unchecked Sendable {
    var drafts: [String: SavedDraft] = [:]
    var outboxes: [String: [SavedSend]] = [:]
    func loadDraft(sessionId: String) -> SavedDraft? { drafts[sessionId] }
    func saveDraft(sessionId: String, draft: SavedDraft) { drafts[sessionId] = draft }
    func loadOutbox(sessionId: String) -> [SavedSend] { outboxes[sessionId] ?? [] }
    func saveOutbox(sessionId: String, sends: [SavedSend]) { outboxes[sessionId] = sends }
}

/// wait for the main actor to settle a condition driven by background tasks
@MainActor
func eventually(_ timeout: TimeInterval = 2, _ check: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if check() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return check()
}

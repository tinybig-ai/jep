import Foundation
#if canImport(Security)
import Security
#endif

/// A small key-value store: UserDefaults on the phone, a dictionary in tests.
public protocol KeyValueStore: AnyObject {
    func string(_ key: String) -> String?
    func set(_ key: String, _ value: String?)
    func all() -> [String: Any]
}

public final class DefaultsStore: KeyValueStore {
    private let defaults: UserDefaults
    public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func string(_ key: String) -> String? { defaults.object(forKey: key) as? String }
    public func set(_ key: String, _ value: String?) {
        if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
    public func all() -> [String: Any] { defaults.dictionaryRepresentation() }
}

public final class MemoryStore: KeyValueStore {
    private var values: [String: String] = [:]
    public init() {}
    public func string(_ key: String) -> String? { values[key] }
    public func set(_ key: String, _ value: String?) { values[key] = value }
    public func all() -> [String: Any] { values }
}

#if canImport(Security)
/// The pairing token lives in the Keychain, readable only on this device once unlocked.
public final class KeychainStore: KeyValueStore {
    private let service: String
    public init(service: String = "dev.jep.client") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    public func string(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ key: String, _ value: String?) {
        SecItemDelete(query(key) as CFDictionary)
        guard let value else { return }
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    public func all() -> [String: Any] { [:] }
}
#endif

/// Where the gateway is and the token it gave this device.
public final class PairingStore: @unchecked Sendable {
    private let prefs: KeyValueStore
    private let secrets: KeyValueStore
    private let lock = NSLock()

    public init(prefs: KeyValueStore, secrets: KeyValueStore) {
        self.prefs = prefs
        self.secrets = secrets
    }

    public var baseUrl: String? { lock.withLock { prefs.string("gateway_base") } }
    public var token: String? { lock.withLock { secrets.string("gateway_token") } }
    /// the code the daemon will accept next, handed over when a pairing or unlock succeeds
    public var nextCode: String? { lock.withLock { secrets.string("gateway_next_code") } }
    public var isPaired: Bool { token != nil && baseUrl?.hasPrefix("http") == true }

    /// "host:port" or "http://host:port" into an http(s) base
    public static func normalize(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        var s = (trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://")) ? trimmed : "http://" + trimmed
        s = s.replacingOccurrences(of: ":\\s+", with: ":", options: .regularExpression)
        guard let c = URLComponents(string: s), let host = c.host, !host.isEmpty, c.scheme == "http" || c.scheme == "https" else { return nil }
        var out = c.string ?? s
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }

    public func save(base: String, token: String) {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        lock.withLock {
            prefs.set("gateway_base", b)
            secrets.set("gateway_token", token)
        }
    }

    public func rememberCode(_ code: String?) {
        guard let code, !code.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        lock.withLock { secrets.set("gateway_next_code", code) }
    }

    public func forget() {
        lock.withLock {
            prefs.set("gateway_base", nil)
            secrets.set("gateway_token", nil)
            secrets.set("gateway_next_code", nil)
        }
    }
}

/// The user's app-wide preferences; per-conversation settings live on the session.
public final class AppSettings {
    private let prefs: KeyValueStore
    public init(_ prefs: KeyValueStore) { self.prefs = prefs }

    public var theme: ThemeMode { prefs.string("app_theme").flatMap(ThemeMode.init(rawValue:)) ?? .system }
    public var textSize: TextSize { TextSize.from(prefs.string("app_text_size")) }
    public var terminalEnabled: Bool { prefs.string("app_terminal_enabled") == "true" }
    /// whether finished turns notify while the app is in the background
    public var backgroundStreaming: Bool { prefs.string("app_background_streaming") != "false" }

    public func setTheme(_ m: ThemeMode) { prefs.set("app_theme", m.rawValue) }
    public func setTextSize(_ s: TextSize) { prefs.set("app_text_size", s.rawValue) }
    public func setTerminalEnabled(_ on: Bool) { prefs.set("app_terminal_enabled", on ? "true" : "false") }
    public func setBackgroundStreaming(_ on: Bool) { prefs.set("app_background_streaming", on ? "true" : "false") }
}

/// Which conversations have been looked at since they last changed. The daemon
/// keeps the mark too (seenAt); this copy answers at once.
public final class ReadStore {
    private let prefs: KeyValueStore
    public init(_ prefs: KeyValueStore) { self.prefs = prefs }
    public func lastRead(_ id: String) -> Int64 { prefs.string("read_" + id).flatMap { Int64($0) } ?? 0 }
    public func markRead(_ id: String, at: Int64 = nowMs()) { prefs.set("read_" + id, String(at)) }
    public func markUnread(_ id: String) { prefs.set("read_" + id, nil) }
    public func isUnread(_ s: SessionSummary) -> Bool { s.updatedAt > max(lastRead(s.id), s.seenAt) }
}

/// ConversationMemory on the device: one JSON value per conversation and kind.
public final class ConversationStore: ConversationMemory {
    private let prefs: KeyValueStore
    public init(_ prefs: KeyValueStore) { self.prefs = prefs }

    private func load<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
        guard let s = prefs.string(key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: Data(s.utf8))
    }

    private func save<T: Encodable>(_ key: String, _ value: T?) {
        guard let value, let data = try? JSONEncoder().encode(value) else { return prefs.set(key, nil) }
        prefs.set(key, String(data: data, encoding: .utf8))
    }

    public func loadDraft(sessionId: String) -> SavedDraft? { load("draft_" + sessionId, SavedDraft.self) }
    public func saveDraft(sessionId: String, draft: SavedDraft) {
        save("draft_" + sessionId, draft.text.isEmpty && draft.attachments.isEmpty ? nil : draft)
    }
    public func loadOutbox(sessionId: String) -> [SavedSend] { load("outbox_" + sessionId, [SavedSend].self) ?? [] }
    public func saveOutbox(sessionId: String, sends: [SavedSend]) { save("outbox_" + sessionId, sends.isEmpty ? nil : sends) }
}

/// What is worth interrupting the person for: the client's call, not the daemon's.
public enum NotificationPolicy {
    public enum Notice: String, Sendable { case finished, asked }

    public static func decide(_ event: ChatEvent, openSessionId: String?, foreground: Bool) -> Notice? {
        if foreground { return nil }
        switch event {
        case .quiet: return .finished
        case .asked: return .asked
        default: return nil
        }
    }
}

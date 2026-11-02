import Foundation

/// What another app handed to jep through the share sheet: some words and/or files.
/// It becomes the first message of a conversation in whichever destination is picked.
public struct SharedContent: Equatable, Sendable {
    public struct File: Equatable, Sendable {
        public var name: String
        public var data: Data
        public var mime: String?
        public init(name: String, data: Data, mime: String? = nil) { self.name = name; self.data = data; self.mime = mime }
    }
    public var text: String?
    public var files: [File]
    public init(text: String? = nil, files: [File] = []) { self.text = text; self.files = files }
    public var isEmpty: Bool { (text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) && files.isEmpty }
}

/// The hand-off between the share extension and the app: a folder both can reach
/// (the app group's container). The extension writes what was shared and ends;
/// the app takes it the next time it comes forward and offers it as a new
/// conversation. The manifest is written last, so a half-written share is never read.
public enum ShareInbox {
    private struct Manifest: Codable {
        var text: String?
        var files: [Entry]
        struct Entry: Codable { var name: String; var mime: String? }
    }

    private static func box(_ dir: URL) -> URL { dir.appendingPathComponent("share-inbox", isDirectory: true) }

    public static func write(_ content: SharedContent, to dir: URL) throws {
        let fm = FileManager.default
        let box = box(dir)
        try? fm.removeItem(at: box)
        try fm.createDirectory(at: box, withIntermediateDirectories: true)
        var entries: [Manifest.Entry] = []
        for (i, f) in content.files.enumerated() {
            let stored = "\(i)-" + f.name.replacingOccurrences(of: "/", with: "_")
            try f.data.write(to: box.appendingPathComponent(stored))
            entries.append(.init(name: f.name, mime: f.mime))
        }
        let manifest = try JSONEncoder().encode(Manifest(text: content.text, files: entries))
        try manifest.write(to: box.appendingPathComponent("manifest.json"), options: .atomic)
    }

    /// what is waiting, taken out of the folder so it is offered once
    public static func take(from dir: URL) -> SharedContent? {
        let fm = FileManager.default
        let box = box(dir)
        defer { try? fm.removeItem(at: box) }
        guard let raw = try? Data(contentsOf: box.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: raw) else { return nil }
        var files: [SharedContent.File] = []
        for (i, e) in manifest.files.enumerated() {
            let stored = "\(i)-" + e.name.replacingOccurrences(of: "/", with: "_")
            if let data = try? Data(contentsOf: box.appendingPathComponent(stored)) {
                files.append(.init(name: e.name, data: data, mime: e.mime))
            }
        }
        let content = SharedContent(text: manifest.text, files: files)
        return content.isEmpty ? nil : content
    }
}

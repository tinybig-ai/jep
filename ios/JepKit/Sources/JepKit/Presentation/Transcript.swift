import Foundation

/// the ask card's own "Something else": spends the card without answering the
/// harness, exactly as saying the answer in chat does
public let somethingElse = "something-else"

/// one row of the transcript: a message, or an ask card
public enum Row: Equatable, Identifiable, Sendable {
    /// `cards`: asks drawn inside the message, right after the tool call they hold up (by call id)
    case msg(ChatMessage, cards: [String: [Row]] = [:])
    case pending(Ask)
    /// an earlier card, spent: kept in place as the record of what was asked
    case pastAsk(AskEntry)
    /// several tool-only messages standing in for one line
    case tools([ToolCall])
    case compaction(ChatMessage)
    case autoContinue(ChatMessage)

    public var id: String {
        switch self {
        case .msg(let m, _): m.id
        case .pending(let a): "ask-\(a.id)"
        case .pastAsk(let e): "ask-\(e.ask.id)"
        case .tools(let t): "tools-\(t.first?.id ?? "run")"
        case .compaction(let m), .autoContinue(let m): m.id
        }
    }
}

public func rowFor(_ m: ChatMessage, cards: [String: [Row]] = [:]) -> Row {
    if m.parts.count == 1, m.parts[0] == .compaction { return .compaction(m) }
    if m.parts.count == 1, m.parts[0] == .autoContinue { return .autoContinue(m) }
    return .msg(m, cards: cards)
}

/// The tool calls of a message that carries nothing else, or nil when it says something.
public func toolOnlyCalls(_ m: ChatMessage) -> [ToolCall]? {
    let tools = m.parts.compactMap(\.toolCall)
    if tools.isEmpty { return nil }
    let only = m.parts.allSatisfy { p in
        if case .tool = p { return true }
        if case .unsupported = p { return true }
        return false
    }
    return only ? tools : nil
}

/// Collapse a run of more than two tool-only messages of the same kind into one row.
public func groupToolRuns(_ rows: [Row]) -> [Row] {
    var out: [Row] = []
    var run: [ChatMessage] = []
    func flush() {
        if run.count > 2 {
            out.append(.tools(run.flatMap { toolOnlyCalls($0) ?? [] }))
        } else {
            out.append(contentsOf: run.map { rowFor($0) })
        }
        run = []
    }
    for row in rows {
        var calls: [ToolCall]?
        var msg: ChatMessage?
        if case .msg(let m, let cards) = row, cards.isEmpty {
            calls = toolOnlyCalls(m)
            msg = m
        }
        if let calls, let msg {
            if let first = run.first, toolOnlyCalls(first)?.first?.name != calls.first?.name { flush() }
            run.append(msg)
        } else {
            flush()
            out.append(row)
        }
    }
    flush()
    return out
}

/// The transcript with ask cards spliced in where they were raised, newest first
/// (index 0 is the bottom of the screen). A card goes directly under the message
/// carrying its tool call, else the message the harness named, else `askAfter`;
/// with no anchor in view it falls back to time on the harness's clock.
public func transcriptRows(
    _ ordered: [ChatMessage],
    ask: Ask?,
    askAt: Int64,
    liveMessageId: String? = nil,
    askAfter: String? = nil,
    past: [AskEntry] = []
) -> [Row] {
    struct Card {
        var row: Row
        var ask: Ask
        var at: Int64
        var after: String?
    }
    var cards: [Card] = past.map { Card(row: .pastAsk($0), ask: $0.ask, at: $0.ask.at ?? 0, after: nil) }
    if let ask { cards.append(Card(row: .pending(ask), ask: ask, at: askAt, after: askAfter)) }
    if cards.isEmpty { return settleCompaction(ordered.map { rowFor($0) }) }

    func hasCall(_ m: ChatMessage, _ call: String) -> Bool { m.parts.contains { $0.toolCall?.id == call } }
    let anchors: [Int?] = cards.map { c in
        if let call = c.ask.callId, let i = ordered.firstIndex(where: { hasCall($0, call) }) { return i }
        if let id = c.ask.messageId, let i = ordered.firstIndex(where: { $0.id == id }) { return i }
        if let id = c.after, let i = ordered.firstIndex(where: { $0.id == id }) { return i }
        return nil
    }
    var placed = Array(repeating: false, count: cards.count)
    var inline: [String: [String: [Row]]] = [:]
    for i in cards.indices.sorted(by: { cards[$0].at < cards[$1].at }) {
        guard let call = cards[i].ask.callId, let host = anchors[i] else { continue }
        let m = ordered[host]
        guard hasCall(m, call) else { continue }
        inline[m.id, default: [:]][call, default: []].append(cards[i].row)
        placed[i] = true
    }
    var out: [Row] = []
    func drop(_ pick: (Int) -> Bool) {
        let chosen = cards.indices.filter { !placed[$0] && pick($0) }.sorted { cards[$0].at > cards[$1].at }
        for i in chosen {
            out.append(cards[i].row)
            placed[i] = true
        }
    }
    for (idx, m) in ordered.enumerated() {
        drop { i in
            if let a = anchors[i] { return a == idx }
            return m.id != liveMessageId && m.time <= cards[i].at
        }
        out.append(rowFor(m, cards: inline[m.id] ?? [:]))
    }
    drop { _ in true }
    return settleCompaction(out)
}

/// A compaction marker arrives before the summary that answers it; it settles
/// right before the next user turn (or at the end), in reading order.
func settleCompaction(_ rows: [Row]) -> [Row] {
    guard rows.contains(where: { if case .compaction = $0 { true } else { false } }) else { return rows }
    var out: [Row] = []
    var held: Row?
    func isUserTurn(_ r: Row) -> Bool {
        if case .autoContinue = r { return true }
        if case .msg(let m, _) = r { return m.role == .user }
        return false
    }
    for row in rows.reversed() {
        if case .compaction = row {
            held = row
            continue
        }
        if let h = held, isUserTurn(row) {
            out.append(h)
            held = nil
        }
        out.append(row)
    }
    if let held { out.append(held) }
    return out.reversed()
}

/// True once the ask has been answered: a tap, "Something else", or a message sent instead.
public func askIsSpent(_ ask: Ask?, _ askChoice: String?) -> Bool { ask != nil && askChoice != nil }

/// An open card takes the send button with it until it is answered or spent.
public func canSend(_ ask: Ask?, _ askChoice: String?) -> Bool { ask == nil || askIsSpent(ask, askChoice) }

/// A draft is worth a full-screen editor once it is four lines tall.
public func isWorthExpanding(lines: Int) -> Bool { lines >= 4 }

/// One row of a message's body: a part, or a run of the same tool folded into one line.
public enum TranscriptRow: Equatable, Sendable {
    /// `sources` are the parts it stands for: itself, or the thinking blocks it merged
    case one(ChatPart, sources: [ChatPart])
    case group([ToolCall])
}

public func collapseTranscript(_ parts: [ChatPart], keep: Set<String> = []) -> [TranscriptRow] {
    var out: [TranscriptRow] = []
    var run: [ToolCall] = []
    func flush() {
        if run.count > 2 { out.append(.group(run)) } else { out.append(contentsOf: run.map { .one(.tool($0), sources: [.tool($0)]) }) }
        run = []
    }
    var thinking: [(String, Int64?)] = []
    func flushThinking() {
        switch thinking.count {
        case 0: break
        case 1:
            let p = ChatPart.reasoning(thinking[0].0, durationMs: thinking[0].1)
            out.append(.one(p, sources: [p]))
        default:
            let took = thinking.compactMap(\.1)
            let merged = ChatPart.reasoning(
                thinking.map { $0.0.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n\n"),
                durationMs: took.count == thinking.count ? took.reduce(0, +) : nil
            )
            out.append(.one(merged, sources: thinking.map { .reasoning($0.0, durationMs: $0.1) }))
        }
        thinking = []
    }
    for part in parts {
        if case .reasoning(let text, let ms) = part {
            flush()
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { thinking.append((text, ms)) }
            continue
        }
        flushThinking()
        if let tool = part.toolCall, !(tool.id.map { keep.contains($0) } ?? false) {
            if let first = run.first, first.name != tool.name { flush() }
            run.append(tool)
        } else {
            flush()
            out.append(.one(part, sources: [part]))
        }
    }
    flushThinking()
    flush()
    return out
}

private let toolVerb: [String: String] = [
    "read": "Read", "edit": "Edited", "write": "Wrote", "bash": "Ran",
    "grep": "Searched", "glob": "Found", "list": "Listed", "patch": "Patched",
    "multiedit": "Edited", "multi-edit": "Edited",
]

/// "Read 17 files", "Edited 6 files", "Ran 3 commands"
public func toolGroupSummary(_ tools: [ToolCall]) -> String {
    let kind = (tools.first?.name ?? "").lowercased()
    let verb = toolVerb[kind] ?? (kind.prefix(1).uppercased() + kind.dropFirst())
    let noun: String
    switch kind {
    case "read", "edit", "write", "patch", "multiedit", "multi-edit": noun = "files"
    case "bash": noun = "commands"
    case "grep": noun = "searches"
    case "glob": noun = "matches"
    default: noun = "calls"
    }
    return "\(verb) \(tools.count) \(noun)"
}

private let toolSubjectKeys = ["command", "filePath", "file_path", "path", "pattern", "query", "description", "url"]

/// the one field a person cares about, when the title is the whole call input as JSON
public func toolTitle(_ tool: ToolCall) -> String? {
    let raw = (tool.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty { return nil }
    if !raw.hasPrefix("{") { return raw }
    guard case .object(let obj)? = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)) else { return nil }
    for k in toolSubjectKeys {
        if let s = obj[k]?.stringValue, !s.trimmingCharacters(in: .whitespaces).isEmpty { return s }
    }
    return nil
}

/// what a tool row opens to: its output, else its input, without opencode's metadata tags
public func toolBody(_ tool: ToolCall) -> String? {
    let out = tool.output.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    let input = tool.input.flatMap { s -> String? in
        let blank = s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (blank || s == "{}" || s == "null") ? nil : s
    }
    guard let raw = out ?? input else { return nil }
    let text = raw
        .replacingOccurrences(of: "</?shell_metadata>", with: "", options: [.regularExpression, .caseInsensitive])
        .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return nil }
    return text.count > 4000 ? String(text.prefix(4000)) + "\n… (\(text.count - 4000) more chars)" : text
}

/// A multi-question answer as the harness takes it: a JSON list of "index:label" ids.
public func parsePicked(_ choiceId: String?) -> [Int: String] {
    guard let raw = choiceId?.trimmingCharacters(in: .whitespaces), raw.hasPrefix("[") else { return [:] }
    guard let re = try? NSRegularExpression(pattern: "\"([^\"]*)\"") else { return [:] }
    var out: [Int: String] = [:]
    for m in re.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)) {
        guard let r = Range(m.range(at: 1), in: raw) else { continue }
        let id = String(raw[r])
        guard let colon = id.firstIndex(of: ":"), let idx = Int(id[..<colon]) else { continue }
        out[idx] = id
    }
    return out
}

public func encodePicked(count: Int, picks: [Int: String]) -> String {
    let ids = (0..<count).compactMap { picks[$0] }.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
    return "[" + ids.joined(separator: ",") + "]"
}

/// A relative link target rewritten to an address only this app answers; anything
/// already addressed passes through, an in-document anchor is left alone (nil).
public func linkDestination(_ raw: String) -> String? {
    let target = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if target.isEmpty { return nil }
    if target.hasPrefix("//") { return target }
    if let colon = target.firstIndex(of: ":") {
        let slash = target.firstIndex(of: "/")
        if colon > target.startIndex, slash == nil || colon < slash! { return target }
    }
    if target.hasPrefix("#") { return nil }
    var path = String(target.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    path = String(path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    if path.hasPrefix("./") { path.removeFirst(2) }
    if path.isEmpty { return nil }
    return "jep://file?path=" + formEncode(path)
}

/// the path a jep://file link names, or nil for any other link
public func localLinkPath(_ url: URL) -> String? {
    guard url.scheme == "jep", url.host == "file" else { return nil }
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
}

/// application/x-www-form-urlencoded, as java.net.URLEncoder writes it
func formEncode(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.*")
    return s.unicodeScalars.map { u -> String in
        if u == " " { return "+" }
        if u.isASCII, allowed.contains(u) { return String(u) }
        return String(u).utf8.map { String(format: "%%%02X", $0) }.joined()
    }.joined()
}

private let linkTarget = try! NSRegularExpression(pattern: #"(!?\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)"#)

/// markdown with every relative link target rewritten by `linkDestination`
public func withLocalLinks(_ markdown: String) -> String {
    let ns = markdown as NSString
    var out = ""
    var last = 0
    for m in linkTarget.matches(in: markdown, range: NSRange(location: 0, length: ns.length)) {
        out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
        let whole = ns.substring(with: m.range)
        if let dest = linkDestination(ns.substring(with: m.range(at: 2))) {
            out += ns.substring(with: m.range(at: 1)) + "(" + dest + ns.substring(with: m.range(at: 3)) + ")"
        } else {
            out += whole
        }
        last = m.range.location + m.range.length
    }
    out += ns.substring(from: last)
    return out
}

public enum FileEngine: Sendable { case markdown, code, text }

private let markdownExt: Set = ["md", "markdown", "mdx"]
private let diffExt: Set = ["diff", "patch"]
private let codeExt: Set = [
    "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "sql", "toml", "yaml",
    "yml", "ini", "gradle", "lua", "pl", "r", "scala", "dart", "ex", "exs", "erl", "hs", "clj",
    "vue", "svelte", "css", "scss", "less", "html", "htm", "xml", "json", "csv", "tsv", "lock",
]

func fileExtension(_ path: String) -> String {
    guard let dot = path.lastIndex(of: ".") else { return "" }
    return path[path.index(after: dot)...].lowercased()
}

public func fileEngineFor(_ path: String) -> FileEngine {
    let ext = fileExtension(path)
    if markdownExt.contains(ext) { return .markdown }
    if diffExt.contains(ext) || codeExt.contains(ext) { return .code }
    return .text
}

private let imageExts: Set = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif", "avif", "svg"]

public func isImagePart(_ part: FilePart) -> Bool {
    if part.mimeType?.lowercased().hasPrefix("image/") == true { return true }
    return imageExts.contains(fileExtension(part.name ?? part.path))
}

/// the live turn as a message, or nil while it has nothing worth a bubble
public func liveAsMessage(_ live: LiveTurn?) -> ChatMessage? {
    guard let live else { return nil }
    let parts = live.parts.filter { p in
        if case .text(let t) = p, t.isEmpty { return false }
        if case .reasoning(let t, _) = p, t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }
    if parts.isEmpty { return nil }
    return ChatMessage(id: live.messageId, role: .assistant, time: 0, parts: parts)
}

/// what the copy button takes: the answer as the user saw it
public func messageText(_ m: ChatMessage) -> String {
    m.parts.compactMap(\.textValue).joined(separator: "\n")
}

/// what a reply carries of the message it answers: six lines, 500 characters at most
public func quoteOf(_ m: ChatMessage) -> String? {
    let text = messageText(m).trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return nil }
    var q = text.components(separatedBy: "\n").prefix(6).joined(separator: "\n")
    if q.count > 500 {
        q = String(q.prefix(500))
        while q.last?.isWhitespace == true { q.removeLast() }
    }
    return q.count < text.count ? q + "…" : q
}

/// what a long-press copies: the whole turn, tool calls and thinking included
public func fullTurnText(_ m: ChatMessage) -> String {
    m.parts.map { p -> String in
        switch p {
        case .text(let t): return t
        case .quote(let t): return t.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
        case .reasoning(let t, _): return "[thinking]\n" + t
        case .tool(let t):
            var s = "[tool: \(t.name)]"
            if let title = t.title, !title.trimmingCharacters(in: .whitespaces).isEmpty { s += " " + title }
            if let o = t.output, !o.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { s += "\n" + o }
            return s
        case .file(let f): return "[file] " + (f.name ?? f.path)
        case .compaction: return "[conversation compacted]"
        case .autoContinue, .unsupported: return ""
        }
    }.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

/// the code a message quotes, fenced blocks then inline spans, for "copy code"
public func codeBlocks(_ text: String) -> [String] {
    func all(_ pattern: String, _ opts: NSRegularExpression.Options = []) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }
    return all("```(?:[\\w.+-]+)?\\n?(.*?)```", [.dotMatchesLineSeparators]) + all("`([^`\\n]+)`")
}

/// A record entry that carries nothing renderable is not drawn as an empty bubble.
public func renderableMessages(_ messages: [ChatMessage]) -> [ChatMessage] {
    messages.filter { !$0.parts.isEmpty }
}

/// Last known status fields; missing is distinct from zero.
public struct StatusSummary: Equatable, Sendable {
    public var model: String?
    public var used: Int64?
    public var limit: Int64?
    public var spend: Double?
    public init(model: String? = nil, used: Int64? = nil, limit: Int64? = nil, spend: Double? = nil) {
        self.model = model
        self.used = used
        self.limit = limit
        self.spend = spend
    }
}

private func lastSegment(_ s: String?) -> String? {
    guard let s else { return nil }
    return s.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init)
}

public func statusSummary(_ state: ChatState) -> StatusSummary {
    let turns = state.messages.filter { $0.role == .assistant }
    let last = turns.last { $0.tokens != nil }
    let model = lastSegment(last?.model) ?? lastSegment(state.models?.current) ?? lastSegment(state.models?.defaultRef)
    let used = last?.tokens.map(\.context).flatMap { $0 > 0 ? $0 : nil }
    var limit: Int64?
    if let c = state.models {
        let ref = c.current ?? c.defaultRef
        if let l = c.all.first(where: { $0.ref == ref })?.contextLimit, l > 0 { limit = l }
        else if c.contextLimit > 0 { limit = c.contextLimit }
    }
    let costs = turns.compactMap(\.cost)
    let sum = costs.reduce(0, +)
    let spend = (state.usage?.cost).flatMap { $0 > 0 ? $0 : nil } ?? ((!costs.isEmpty && sum > 0) ? sum : nil)
    return StatusSummary(model: (model?.isEmpty == false) ? model : nil, used: used, limit: limit, spend: spend)
}

public func retainStatus(_ previous: StatusSummary, _ current: StatusSummary) -> StatusSummary {
    StatusSummary(
        model: current.model ?? previous.model,
        used: current.used ?? previous.used,
        limit: current.limit ?? previous.limit,
        spend: current.spend ?? previous.spend
    )
}

public func statusText(_ status: StatusSummary) -> String {
    var out: [String] = []
    if let m = status.model { out.append(m) }
    let used = status.used ?? 0
    let limit = status.limit ?? 0
    if used > 0, limit >= used {
        out.append("\(fmtTokens(used))/\(fmtTokens(limit))  \(Int((100.0 * Double(used) / Double(limit)).rounded()))%")
    } else if used > 0 {
        out.append("\(fmtTokens(used)) tok")
    }
    if let s = status.spend, s > 0 { out.append(fmtMoney(s)) }
    return out.joined(separator: "  ·  ")
}

private let posix = Locale(identifier: "en_US_POSIX")

public func fmtTokens(_ n: Int64) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", locale: posix, Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", locale: posix, Double(n) / 1_000) }
    return String(n)
}

public func fmtDuration(_ ms: Int64) -> String {
    ms < 60_000 ? String(format: "%.1fs", locale: posix, Double(ms) / 1000) : "\(ms / 60_000)m \((ms / 1000) % 60)s"
}

public func fmtMoney(_ usd: Double) -> String {
    if usd <= 0 { return "" }
    if usd < 0.01 { return String(format: "$%.4f", locale: posix, usd) }
    if usd < 100 { return String(format: "$%.2f", locale: posix, usd) }
    return "$" + String(Int64(usd.rounded()))
}

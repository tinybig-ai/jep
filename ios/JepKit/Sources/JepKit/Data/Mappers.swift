import Foundation

// the JSON→domain boundary. Unknown part kinds and statuses degrade to inert
// renderings here, once, instead of leaking harness vocabulary upward.

extension SessionDto {
    func toDomain() -> SessionSummary {
        SessionSummary(id: id, title: title, workspace: workspace, createdAt: createdAt, updatedAt: updatedAt, adapter: adapter, harness: harness, subagents: subagents, active: active, seenAt: seenAt, pinned: pinned, pod: pod)
    }
}

extension WorkspaceDto {
    func toDomain() -> Workspace { Workspace(name: name, harness: harness, dir: dir, pod: pod) }
}

extension BrowseRes {
    func toDomain() -> BrowseResult {
        BrowseResult(cwd: cwd, root: root, parent: parent, dirs: dirs.map { DirEntry(name: $0.name, git: $0.git) })
    }
}

extension SkillsRes {
    func toDomain() -> SkillSet {
        SkillSet(skills: skills.map { Skill(name: $0.name, description: $0.description, scope: $0.scope, path: $0.path, disabled: $0.disableModelInvocation) }, toggleable: toggleable)
    }
}

extension McpDto {
    func toDomain() -> McpServer { McpServer(name: name, kind: kind, enabled: enabled, detail: detail) }
}

extension ImportableDto {
    func toDomain() -> ImportableSession { ImportableSession(id: id, title: title, directory: directory, updatedAt: updated, harness: harness) }
}

extension ModelDto {
    func toDomain() -> Model { Model(providerID: providerID, modelID: modelID, image: image, attachment: attachment, contextLimit: contextLimit) }
}

extension AgentDto {
    func toDomain() -> AgentInfo { AgentInfo(id: id, label: label, detail: detail) }
}

extension TokensDto {
    func toDomain() -> TokenUsage { TokenUsage(input: input, output: output, reasoning: reasoning, cacheRead: cacheRead, cacheWrite: cacheWrite) }
}

extension FileDiffDto {
    func toDomain() -> FileDiff { FileDiff(file: file, additions: additions, deletions: deletions, status: status) }
}

extension GitCommitDto {
    func toDomain() -> GitCommit { GitCommit(hash: hash, shortHash: shortHash, subject: subject, author: author, time: time) }
}

extension GitRes {
    func toDomain() -> GitSnapshot {
        GitSnapshot(isRepository: isRepository, branch: branch, head: head?.toDomain(), changedFiles: changedFiles, commits: commits.map { $0.toDomain() })
    }
}

extension HarnessSettingDto {
    func toDomain() -> HarnessSetting { HarnessSetting(id: id, label: label, description: description, defaultValue: defaultValue, danger: danger) }
}

extension HarnessSettingsRes {
    func toDomain() -> HarnessSettings { HarnessSettings(options: options.map { $0.toDomain() }, values: values, canCompact: compact) }
}

extension MessageDto {
    func toDomain() -> ChatMessage {
        ChatMessage(
            id: id,
            role: role == "user" ? .user : .assistant,
            time: time,
            parts: parts.compactMap { $0.toDomain() },
            error: error?.message,
            model: model,
            cost: cost,
            tokens: tokens?.toDomain(),
            durationMs: durationMs
        )
    }
}

extension AskOptionDto {
    func toDomain() -> AskOption { AskOption(id: id, label: label, danger: style == "danger") }
}

extension AskDto {
    func toDomain() -> Ask {
        Ask(
            id: id,
            title: title,
            detail: detail,
            options: options.map { $0.toDomain() },
            questions: questions.map { AskQuestion(title: $0.title, detail: $0.detail, multiple: $0.multiple, options: $0.options.map { $0.toDomain() }) },
            kind: kind,
            messageId: messageID,
            callId: callID,
            at: at
        )
    }

    func toEntry() -> AskEntry { AskEntry(ask: toDomain(), pending: state == "pending", choice: answer) }
}

private func lineCount(_ v: JSONValue?) -> Int {
    guard let s = v?.stringValue else { return 0 }
    return s.isEmpty ? 0 : s.filter { $0 == "\n" }.count + 1
}

/// What an edit changed, counted from the call's own arguments: (added, removed).
func lineChange(tool: String, input: JSONValue) -> (added: Int, removed: Int)? {
    guard case .object(let obj) = input else { return nil }
    switch tool.lowercased() {
    case "write":
        guard let content = obj["content"] else { return nil }
        return (lineCount(content), 0)
    case "edit":
        guard obj["oldString"] != nil || obj["newString"] != nil else { return nil }
        return (lineCount(obj["newString"]), lineCount(obj["oldString"]))
    case "multi-edit", "multiedit":
        guard case .array(let edits)? = obj["edits"] else { return nil }
        var add = 0
        var del = 0
        for e in edits {
            guard case .object(let o) = e else { continue }
            del += lineCount(o["oldString"])
            add += lineCount(o["newString"])
        }
        return (add, del)
    default:
        return nil
    }
}

/// The change a tool call made, as a unified hunk with no context lines.
func toolDiff(tool: String, input: JSONValue) -> String? {
    guard case .object(let obj) = input else { return nil }
    func hunk(_ old: String?, _ new: String?) -> [String] {
        let o = (old?.isEmpty == false) ? old!.components(separatedBy: "\n").map { "-" + $0 } : []
        let n = (new?.isEmpty == false) ? new!.components(separatedBy: "\n").map { "+" + $0 } : []
        return o + n
    }
    let lines: [String]
    switch tool.lowercased() {
    case "write":
        lines = hunk(nil, obj["content"]?.stringValue)
    case "edit":
        lines = hunk(obj["oldString"]?.stringValue, obj["newString"]?.stringValue)
    case "multi-edit", "multiedit":
        guard case .array(let edits)? = obj["edits"] else { return nil }
        lines = edits.flatMap { e -> [String] in
            guard case .object(let o) = e else { return [] }
            return hunk(o["oldString"]?.stringValue, o["newString"]?.stringValue)
        }
    default:
        return nil
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
}

/// A tool payload shown as text: a JSON string becomes its contents; anything
/// else becomes its compact JSON form.
func display(_ v: JSONValue) -> String? {
    let s = v.stringValue ?? v.compact
    let blank = s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return (blank || s == "{}" || s == "null") ? nil : s
}

extension PartDto {
    func toDomain() -> ChatPart? {
        switch kind {
        case "text":
            return text.map { .text($0) }
        case "quote":
            guard let t = text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .quote(t)
        case "reasoning":
            guard let t = text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .reasoning(t, durationMs: durationMs)
        case "tool":
            let tool = name ?? ""
            let change = input.flatMap { lineChange(tool: tool, input: $0) }
            return .tool(ToolCall(
                id: id,
                name: tool,
                status: status.flatMap { ToolStatus(rawValue: $0.lowercased()) },
                title: title,
                input: input.flatMap(display),
                output: output.flatMap(display),
                added: change?.added,
                removed: change?.removed,
                diff: input.flatMap { toolDiff(tool: tool, input: $0) }
            ))
        case "file":
            guard let p = filePath, !p.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return .file(FilePart(path: p, name: fileName, mimeType: mimeType))
        case "other":
            switch nativeType {
            case "compaction": return .compaction
            case "compaction-continue": return .autoContinue
            default: return nil
            }
        default:
            return nil
        }
    }
}

extension EventDto {
    func toChatEvent() -> ChatEvent? {
        guard let sid = sessionID else { return nil }
        switch type {
        case "part.delta":
            guard let mid = messageID, let pid = partID else { return nil }
            return .textDelta(sessionId: sid, messageId: mid, partId: pid, partType: partType ?? "", text: text ?? "")
        case "part.updated":
            guard let mid = messageID, let dto = part else { return nil }
            return .partChanged(sessionId: sid, messageId: mid, partId: partID ?? dto.id, part: dto.toDomain() ?? .unsupported(dto.kind))
        case "message.created", "message.updated":
            guard let mid = messageID else { return nil }
            return .messageSeen(sessionId: sid, messageId: mid, role: role.map { $0 == "user" ? .user : .assistant })
        case "session.idle":
            return .quiet(sessionId: sid)
        case "session.changed":
            return .changed(sessionId: sid)
        case "ask.requested":
            guard let a = ask else { return nil }
            return .asked(sessionId: a.sessionID.isEmpty ? sid : a.sessionID, ask: a.toDomain())
        case "ask.resolved":
            return askID.map { .askResolved(sessionId: sid, askId: $0) }
        case "session.error":
            return .failed(sessionId: sid, error: message ?? "the harness failed")
        case "turn.aborted":
            return .aborted(sessionId: sid)
        default:
            return nil
        }
    }
}

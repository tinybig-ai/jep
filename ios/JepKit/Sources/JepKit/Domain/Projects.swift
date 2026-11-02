import Foundation

/// the pseudo-project every pod (a throwaway folder) is filed under
public let podsProject = "jep:pods"

/// the directory a conversation is filed under: its folder, or "Pods"
public func projectDir(_ s: SessionSummary) -> String {
    if s.pod { return podsProject }
    if !s.workspace.isEmpty { return s.workspace }
    return s.adapter ?? "unknown"
}

/// what to call a project: the workspace's friendly name, else its folder name
public func projectName(_ dir: String, _ sessions: [SessionSummary]) -> String {
    if dir == podsProject { return "Pods" }
    if let a = sessions.compactMap({ $0.adapter }).first(where: { !$0.isEmpty }) { return a }
    let last = dir.split(separator: "/").last.map(String.init) ?? ""
    return last.isEmpty ? dir : last
}

/// The projects in the list, each with its conversations. A project's place is
/// its newest conversation's, except that a pinned conversation lifts its whole
/// project, so a pin is not buried a level down. Within a project the sessions
/// keep the daemon's order, which is already pinned first.
public func groupedProjects(_ sessions: [SessionSummary]) -> [(dir: String, sessions: [SessionSummary])] {
    var order: [String] = []
    var byDir: [String: [SessionSummary]] = [:]
    for s in sessions {
        let d = projectDir(s)
        if byDir[d] == nil { order.append(d) }
        byDir[d, default: []].append(s)
    }
    return order.map { (dir: $0, sessions: byDir[$0]!) }
        .sorted { a, b in
            let ap = a.sessions.contains { $0.pinned }, bp = b.sessions.contains { $0.pinned }
            if ap != bp { return ap }
            return a.sessions.map(\.updatedAt).max()! > b.sessions.map(\.updatedAt).max()!
        }
}

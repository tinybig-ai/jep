/// How a conversation keeps going, as the daemon names it. `normal` gives one turn
/// per request. `keep` carries on until the agent says it is done. `relentless`
/// carries on whatever the agent says, until the person stops it. `modes` is the
/// order a tap walks through, as the daemon sends it.
public struct ConversationMode: Equatable, Sendable {
    public var mode: String
    public var modes: [String]

    public init(mode: String = "normal", modes: [String] = ["normal", "keep", "relentless"]) {
        self.mode = mode
        self.modes = modes
    }

    /// the mode one tap moves to: the daemon's order, wrapping round to the start
    public var next: String {
        guard let i = modes.firstIndex(of: mode), !modes.isEmpty else { return modes.first ?? mode }
        return modes[(i + 1) % modes.count]
    }

    /// the words for the mode, shown while a conversation is in one
    public var label: String {
        switch mode {
        case "keep": return "Keep going"
        case "relentless": return "Relentless"
        default: return "Normal"
        }
    }
}

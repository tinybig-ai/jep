/// `POST /conversation-settings` answer: the mode this conversation is in and the order a tap walks.
struct ConversationModeRes: Decodable {
    var mode: String
    var modes: [String]

    enum K: String, CodingKey { case mode, modes }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? "normal"
        modes = (try? c.decodeIfPresent([String].self, forKey: .modes)) ?? []
    }
}

/// `POST /set-conversation-mode` answer: the mode the daemon now holds.
struct ConversationModeSetRes: Decodable {
    var mode: String
}

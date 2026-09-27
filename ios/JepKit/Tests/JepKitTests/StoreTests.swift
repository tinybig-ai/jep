import XCTest
@testable import JepKit

final class StoreTests: XCTestCase {
    func testNormalize() {
        XCTAssertEqual(PairingStore.normalize("host:8931"), "http://host:8931")
        XCTAssertEqual(PairingStore.normalize("host: 8931"), "http://host:8931")
        XCTAssertEqual(PairingStore.normalize("https://h.ts.net/"), "https://h.ts.net")
        XCTAssertNil(PairingStore.normalize("  "))
    }

    func testPairingKeepsTokenInSecrets() {
        let prefs = MemoryStore(), secrets = MemoryStore()
        let p = PairingStore(prefs: prefs, secrets: secrets)
        XCTAssertFalse(p.isPaired)
        p.save(base: "http://h:1/", token: "tok")
        p.rememberCode("  ")
        p.rememberCode("ABCD")
        XCTAssertTrue(p.isPaired)
        XCTAssertEqual(p.baseUrl, "http://h:1")
        XCTAssertNil(prefs.string("gateway_token"))
        XCTAssertEqual(secrets.string("gateway_token"), "tok")
        XCTAssertEqual(p.nextCode, "ABCD")
        p.forget()
        XCTAssertFalse(p.isPaired)
        XCTAssertNil(p.nextCode)
    }

    func testSettingsDefaults() {
        let s = AppSettings(MemoryStore())
        XCTAssertEqual(s.theme, .system)
        XCTAssertEqual(s.textSize, .standard)
        XCTAssertFalse(s.terminalEnabled)
        XCTAssertTrue(s.backgroundStreaming)
        s.setBackgroundStreaming(false)
        s.setTheme(.dark)
        XCTAssertFalse(s.backgroundStreaming)
        XCTAssertEqual(s.theme, .dark)
    }

    func testUnread() {
        let r = ReadStore(MemoryStore())
        let s = SessionSummary(id: "s", title: "t", updatedAt: 100, seenAt: 50)
        XCTAssertTrue(r.isUnread(s))
        r.markRead("s", at: 100)
        XCTAssertFalse(r.isUnread(s))
        XCTAssertFalse(r.isUnread(SessionSummary(id: "x", title: "t", updatedAt: 100, seenAt: 100)))
    }

    func testConversationStoreRoundTrip() {
        let c = ConversationStore(MemoryStore())
        c.saveDraft(sessionId: "s", draft: SavedDraft(text: "half", attachments: [SavedAttachment(id: "f", name: "a.png")]))
        XCTAssertEqual(c.loadDraft(sessionId: "s")?.text, "half")
        c.saveDraft(sessionId: "s", draft: SavedDraft())
        XCTAssertNil(c.loadDraft(sessionId: "s"))
        c.saveOutbox(sessionId: "s", sends: [SavedSend(id: "l1", body: "hello", time: 3)])
        XCTAssertEqual(c.loadOutbox(sessionId: "s").map(\.body), ["hello"])
    }

    func testNotificationPolicy() {
        XCTAssertNil(NotificationPolicy.decide(.quiet(sessionId: "s"), openSessionId: "s", foreground: true))
        XCTAssertNil(NotificationPolicy.decide(.quiet(sessionId: "s"), openSessionId: nil, foreground: true))
        XCTAssertEqual(NotificationPolicy.decide(.quiet(sessionId: "s"), openSessionId: "s", foreground: false), .finished)
        XCTAssertEqual(NotificationPolicy.decide(.asked(sessionId: "s", ask: Ask(id: "a", title: "q")), openSessionId: nil, foreground: false), .asked)
        XCTAssertNil(NotificationPolicy.decide(.failed(sessionId: "s", error: "x"), openSessionId: nil, foreground: false))
    }

    func testSSEParser() {
        var p = SSEParser()
        XCTAssertEqual(p.feed(Data(": ping\n\ndata: {\"a\"".utf8)), [])
        XCTAssertEqual(p.feed(Data(":1}\r\n\r\ndata: x\ndata: y\n\n".utf8)), [#"{"a":1}"#, "x\ny"])
    }
}

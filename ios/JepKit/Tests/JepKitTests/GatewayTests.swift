import XCTest
@testable import JepKit

final class GatewayTests: XCTestCase {
    func testHistoryEtagServesHeldPage() async throws {
        let gw = FakeGateway()
        gw.on("/history") { body in
            if body["etag"] as? String == "t1" { return (200, #"{"unchanged":true,"etag":"t1"}"#) }
            return (200, #"{"messages":[{"id":"m1","role":"assistant","time":1,"parts":[{"kind":"text","text":"hello"},{"kind":"hologram"}]}],"hasMore":false,"asks":[],"etag":"t1","novel":1}"#)
        }
        let repo = GatewayChatRepository(base: "http://gw", token: { "tok" }, http: gw)
        let first = try await repo.history(sessionId: "s1", limit: 30)
        let second = try await repo.history(sessionId: "s1", limit: 30)
        _ = try await repo.history(sessionId: "s1", limit: 30, before: 5, have: 1)
        let sent = gw.bodies("/history")
        XCTAssertNil(sent[0]["etag"])
        XCTAssertEqual(sent[1]["etag"] as? String, "t1")
        XCTAssertNil(sent[2]["etag"])
        XCTAssertEqual(first, second)
        XCTAssertEqual(second.messages.map(\.id), ["m1"])
        XCTAssertEqual(gw.calls.first?.auth, "Bearer tok")
    }

    func testPinRoundTrip() async throws {
        let gw = FakeGateway()
        gw.on("/sessions", json: #"{"items":[{"id":"a","title":"A","pinned":true},{"id":"b","title":"B"}]}"#)
        gw.on("/pin", json: #"{"ok":true,"pinned":true}"#)
        gw.on("/unpin", json: #"{"ok":true,"pinned":false}"#)
        let repo = GatewayChatRepository(base: "http://gw", token: { "tok" }, http: gw)
        let list = try await repo.sessions()
        XCTAssertEqual(list.map(\.pinned), [true, false])
        let pinned = try await repo.pinSession(sessionId: "b")
        let unpinned = try await repo.unpinSession(sessionId: "a")
        XCTAssertTrue(pinned && unpinned)
        XCTAssertEqual(gw.bodies("/pin").first?["id"] as? String, "b")
        XCTAssertEqual(gw.bodies("/unpin").first?["id"] as? String, "a")
    }

    func testPromptModes() async throws {
        let gw = FakeGateway()
        gw.on("/prompt", json: #"{"message":{"id":"a1","role":"assistant","time":2,"parts":[{"kind":"text","text":"ok"}]}}"#)
        let repo = GatewayChatRepository(base: "http://gw", token: { "tok" }, http: gw)
        _ = try await repo.prompt(sessionId: "s", text: "a", files: [], clientID: nil, mode: .afterReply, quote: nil)
        _ = try await repo.prompt(sessionId: "s", text: "b", files: [], clientID: nil, mode: .now, quote: nil)
        let sent = gw.bodies("/prompt")
        XCTAssertEqual(sent[0]["steer"] as? Bool, false)
        XCTAssertEqual(sent[1]["force"] as? Bool, true)
    }

    func testBusyPromptSaysSoInWords() async {
        let gw = FakeGateway()
        gw.on("/prompt") { _ in (409, #"{"error":"busy"}"#) }
        let repo = GatewayChatRepository(base: "http://gw", token: { "tok" }, http: gw)
        do {
            _ = try await repo.prompt(sessionId: "s", text: "a")
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual((error as? ApiFailure)?.status, 409)
        }
    }
}

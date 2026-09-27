import XCTest
@testable import JepKit

@MainActor
final class ChatStoreTests: XCTestCase {
    let reply = #"{"message":{"id":"a1","role":"assistant","time":5,"parts":[{"kind":"text","text":"done"}],"durationMs":10}}"#

    func gateway(history: String = #"{"messages":[],"hasMore":false,"asks":[]}"#) -> FakeGateway {
        let gw = FakeGateway()
        gw.on("/history", json: history)
        gw.on("/stop", json: #"{"ok":true}"#)
        gw.on("/reject", json: #"{"ok":true}"#)
        return gw
    }

    func store(_ gw: FakeGateway, memory: ConversationMemory = NoMemory()) -> ChatStore {
        ChatStore(repo: GatewayChatRepository(base: "http://gw", token: { "t" }, http: gw), sessionId: "s", title: "t", memory: memory, live: false, settleMs: 1)
    }

    func testSendShowsAtOnceThenTheReply() async {
        let gw = gateway()
        let gate = AsyncStream<Void>.makeStream()
        let reply = self.reply
        gw.on("/prompt") { _ in
            for await _ in gate.stream { break }
            return (200, reply)
        }
        let s = store(gw)
        let task = s.send("hello")
        XCTAssertTrue(s.state.sending)
        XCTAssertEqual(s.state.messages.last?.role, .user)
        gate.continuation.yield()
        await task?.value
        XCTAssertFalse(s.state.sending)
        XCTAssertEqual(s.state.messages.last?.id, "a1")
    }

    func testFailedSendStaysUndeliveredAndPersisted() async {
        let gw = gateway()
        gw.on("/prompt") { _ in (500, #"{"error":"boom"}"#) }
        let mem = RecordingMemory()
        let s = store(gw, memory: mem)
        await s.send("hello")?.value
        XCTAssertEqual(s.state.messages.filter(\.undelivered).count, 1)
        XCTAssertEqual(mem.outboxes["s"]?.map(\.body), ["hello"])
        let reopened = store(gw, memory: mem)
        XCTAssertEqual(reopened.state.messages.filter(\.undelivered).map { messageText($0) }, ["hello"])
    }

    func testMessageWhileBusyQueuesWithMode() async {
        let gw = gateway()
        let gate = AsyncStream<Void>.makeStream()
        let reply = self.reply
        gw.on("/prompt") { body in
            if body["clientID"] == nil { for await _ in gate.stream { break } }
            return (200, reply)
        }
        let s = store(gw)
        let first = s.send("one")
        let queued = s.send("two", mode: .afterReply)
        XCTAssertEqual(s.state.queued.map(\.text), ["two"])
        XCTAssertEqual(s.state.queued.first?.mode, .afterReply)
        await queued?.value
        XCTAssertEqual(gw.bodies("/prompt").last?["steer"] as? Bool, false)
        gate.continuation.yield()
        await first?.value
    }

    func testStopIgnoresTheStoppedTurnsLateReply() async {
        let gw = gateway()
        let gate = AsyncStream<Void>.makeStream()
        let reply = self.reply
        gw.on("/prompt") { _ in
            for await _ in gate.stream { break }
            return (200, reply)
        }
        let s = store(gw)
        let task = s.send("hello")
        s.stop()
        XCTAssertFalse(s.state.sending)
        gate.continuation.yield()
        await task?.value
        XCTAssertFalse(s.state.messages.contains { $0.id == "a1" })
    }

    func testDraftSurvivesReopen() {
        let mem = RecordingMemory()
        let s = store(gateway(), memory: mem)
        s.setDraft("half a thought")
        XCTAssertEqual(store(gateway(), memory: mem).state.draft, "half a thought")
    }

    func testStreamBuildsLiveTurnAndAsksStandDown() {
        let s = store(gateway())
        s.apply(.textDelta(sessionId: "s", messageId: "m", partId: "p", partType: "text", text: "he"))
        s.apply(.textDelta(sessionId: "s", messageId: "m", partId: "p", partType: "text", text: "llo"))
        s.apply(.textDelta(sessionId: "s", messageId: "m", partId: "r", partType: "reasoning", text: "hmm"))
        XCTAssertEqual(s.state.live?.parts, [.text("hello"), .reasoning("hmm", durationMs: nil)])
        s.apply(.asked(sessionId: "s", ask: Ask(id: "a", title: "ok?")))
        XCTAssertEqual(s.state.ask?.id, "a")
        XCTAssertEqual(s.state.askAfter, "m")
        s.apply(.aborted(sessionId: "s"))
        XCTAssertNil(s.state.ask)
        XCTAssertEqual(s.state.pastAsks.map(\.ask.id), ["a"])
        XCTAssertNil(s.state.live)
    }

    func testServedAsksOpenAndSettle() {
        var st = ChatState()
        let a = Ask(id: "a", title: "q", at: 7)
        st = st.withServedAsks([AskEntry(ask: a, pending: true)])
        XCTAssertEqual(st.ask?.id, "a")
        XCTAssertEqual(st.askAt, 7)
        st = st.withServedAsks([AskEntry(ask: a, pending: false, choice: "yes")])
        XCTAssertNil(st.ask)
        XCTAssertEqual(st.pastAsks.first?.choice, "yes")
    }

    func testHistoryReconcilesOptimisticAndQueue() async {
        let gw = gateway(history: #"{"messages":[{"id":"u1","role":"user","time":1,"parts":[{"kind":"text","text":"hello"}]}],"hasMore":true,"asks":[]}"#)
        gw.on("/prompt") { _ in (500, #"{"error":"x"}"#) }
        let s = store(gw)
        await s.send("hello")?.value
        await s.refresh().value
        XCTAssertEqual(s.state.messages.map(\.id), ["u1"])
        XCTAssertTrue(s.state.hasMore)
    }

    func testLiveRowSettledOnlyByCompletion() {
        XCTAssertFalse(liveRowIsSettled("m", [msg("m")]))
        XCTAssertTrue(liveRowIsSettled("m", [msg("m", durationMs: 3)]))
        XCTAssertFalse(liveRowIsSettled(nil, [msg("m", durationMs: 3)]))
    }
}

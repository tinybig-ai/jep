import XCTest
@testable import JepKit

final class TranscriptTests: XCTestCase {
    let ask = Ask(id: "a1", title: "external_directory", options: [AskOption(id: "once", label: "Allow once"), AskOption(id: "always", label: "Always allow")])
    func m(_ id: String, _ role: Role, _ time: Int64) -> ChatMessage { ChatMessage(id: id, role: role, time: time, parts: [.text(id)]) }
    func keys(_ rows: [Row]) -> [String] { rows.map(\.id) }

    func testNoAskLeavesTranscript() {
        XCTAssertEqual(keys(transcriptRows([m("m2", .assistant, 20), m("m1", .user, 10)], ask: nil, askAt: 0)), ["m2", "m1"])
    }

    func testCompactionSettlesBeforeNextUserTurn() {
        let marker = ChatMessage(id: "mk", role: .user, time: 30, parts: [.compaction])
        let rows = transcriptRows([m("nu", .user, 50), m("sm", .assistant, 40), marker, m("old", .assistant, 10)], ask: nil, askAt: 0)
        XCTAssertEqual(keys(rows), ["nu", "mk", "sm", "old"])
    }

    func testCompactionWithNoResponseStays() {
        let marker = ChatMessage(id: "mk", role: .user, time: 30, parts: [.compaction])
        XCTAssertEqual(keys(transcriptRows([marker, m("old", .assistant, 10)], ask: nil, askAt: 0)), ["mk", "old"])
    }

    func testAutoContinueAnchorsDivider() {
        let marker = ChatMessage(id: "mk", role: .user, time: 30, parts: [.compaction])
        let auto = ChatMessage(id: "ac", role: .user, time: 45, parts: [.autoContinue])
        let ordered = [m("work2", .assistant, 70), m("work1", .assistant, 60), auto, m("sm", .assistant, 40), marker, m("old", .assistant, 10)]
        XCTAssertEqual(keys(transcriptRows(ordered, ask: nil, askAt: 0)), ["work2", "work1", "ac", "mk", "sm", "old"])
        let short = [m("work", .assistant, 50), auto, marker, m("old", .assistant, 10)]
        XCTAssertEqual(keys(transcriptRows(short, ask: nil, askAt: 0)), ["work", "ac", "mk", "old"])
    }

    func testAskPlacementByTime() {
        let two = [m("m2", .assistant, 20), m("m1", .user, 10)]
        XCTAssertEqual(keys(transcriptRows(two, ask: ask, askAt: 30)), ["ask-a1", "m2", "m1"])
        XCTAssertEqual(keys(transcriptRows(two, ask: ask, askAt: 5)), ["m2", "m1", "ask-a1"])
        let three = [m("m3", .assistant, 40), m("m2", .assistant, 20), m("m1", .user, 10)]
        XCTAssertEqual(keys(transcriptRows(three, ask: ask, askAt: 30)), ["m3", "ask-a1", "m2", "m1"])
        XCTAssertEqual(keys(transcriptRows(three, ask: ask, askAt: 15)), ["m3", "m2", "ask-a1", "m1"])
    }

    func testAskSitsUnderItsAnchor() {
        let ordered = [m("live", .assistant, 0), m("m3", .user, 25), m("m2", .assistant, 20), m("m1", .user, 10)]
        XCTAssertEqual(keys(transcriptRows(ordered, ask: ask, askAt: 30, liveMessageId: "live", askAfter: "live")), ["ask-a1", "live", "m3", "m2", "m1"])
    }

    func testGoneAnchorFallsBackToTime() {
        let ordered = [m("m3", .user, 40), m("m2", .assistant, 20), m("m1", .user, 10)]
        XCTAssertEqual(keys(transcriptRows(ordered, ask: ask, askAt: 30, askAfter: "gone")), ["m3", "ask-a1", "m2", "m1"])
    }

    func testLiveTurnDoesNotParkAskAtBottom() {
        let ordered = [m("live", .assistant, 0), m("m3", .user, 40), m("m2", .assistant, 20), m("m1", .user, 10)]
        XCTAssertEqual(keys(transcriptRows(ordered, ask: ask, askAt: 30, liveMessageId: "live")), ["live", "m3", "ask-a1", "m2", "m1"])
    }

    func testSpentAndSendable() {
        XCTAssertTrue(askIsSpent(ask, "always"))
        XCTAssertFalse(askIsSpent(ask, nil))
        XCTAssertFalse(askIsSpent(nil, nil))
        XCTAssertTrue(canSend(nil, nil))
        XCTAssertFalse(canSend(ask, nil))
        XCTAssertTrue(canSend(ask, "always"))
        XCTAssertTrue(canSend(ask, somethingElse))
        XCTAssertTrue(isWorthExpanding(lines: 4))
        XCTAssertFalse(isWorthExpanding(lines: 3))
    }

    func testPicksRoundTrip() {
        XCTAssertEqual(encodePicked(count: 2, picks: [0: "0:Inline", 1: "1:Maximize above attach"]), #"["0:Inline","1:Maximize above attach"]"#)
        let picks = [0: "0:Inline", 1: "1:Maximize above attach"]
        XCTAssertEqual(parsePicked(encodePicked(count: 2, picks: picks)), picks)
        let skipped = parsePicked(encodePicked(count: 3, picks: [0: "0:A", 2: "2:C"]))
        XCTAssertEqual(skipped[0], "0:A")
        XCTAssertNil(skipped[1])
        XCTAssertEqual(skipped[2], "2:C")
        XCTAssertTrue(parsePicked("0:once").isEmpty)
        XCTAssertTrue(parsePicked(nil).isEmpty)
    }

    func testLinkDestinations() {
        for url in ["https://example.com/x", "http://example.com", "mailto:a@b.com", "tel:+15550100", "//cdn.example.com/a.js"] {
            XCTAssertEqual(linkDestination(url), url)
        }
        XCTAssertEqual(linkDestination("docs/PROCESSES.md"), "jep://file?path=docs%2FPROCESSES.md")
        XCTAssertEqual(linkDestination("./docs/a.md"), "jep://file?path=docs%2Fa.md")
        XCTAssertEqual(linkDestination("todo.md"), "jep://file?path=todo.md")
        XCTAssertEqual(linkDestination("docs/a.md#section"), "jep://file?path=docs%2Fa.md")
        XCTAssertEqual(linkDestination("docs/a.md?v=2"), "jep://file?path=docs%2Fa.md")
        XCTAssertNil(linkDestination("#section"))
        XCTAssertNil(linkDestination(""))
        XCTAssertNil(linkDestination("   "))
        XCTAssertNil(linkDestination("?only=query"))
        XCTAssertEqual(localLinkPath(URL(string: "jep://file?path=docs%2Fa.md")!), "docs/a.md")
    }

    func testLocalLinksInMarkdown() {
        let md = "see [notes](docs/notes.md) and [the site](https://example.com) plus ![shot](img/a.png)"
        XCTAssertEqual(withLocalLinks(md), "see [notes](jep://file?path=docs%2Fnotes.md) and [the site](https://example.com) plus ![shot](jep://file?path=img%2Fa.png)")
        XCTAssertEqual(withLocalLinks(#"[notes](docs/a.md "the notes")"#), #"[notes](jep://file?path=docs%2Fa.md "the notes")"#)
        let plain = "just prose, and `docs/a.md` in a code span, and a bare docs/a.md"
        XCTAssertEqual(withLocalLinks(plain), plain)
    }

    func testWorkMessagesFoldInOrder() {
        let a = ChatMessage(id: "a", role: .assistant, time: 1_000, parts: [.unsupported("step"), tool("t1", "edit")], durationMs: 5_000)
        let b = ChatMessage(id: "b", role: .assistant, time: 10_000, parts: [.reasoning("hm", durationMs: 1_000)])
        let c = ChatMessage(id: "c", role: .assistant, time: 60_000, parts: [tool("t3", "bash")], durationMs: 14_000)
        let say = ChatMessage(id: "s", role: .assistant, time: 80_000, parts: [.text("done")])
        let grouped = groupWorkRuns([rowFor(say), rowFor(c), rowFor(b), rowFor(a)])
        XCTAssertEqual(keys(grouped), ["s", "work-a"])
        guard case .work(_, let parts, let ms) = grouped[1] else { return XCTFail("expected a work fold") }
        XCTAssertEqual(parts.map { $0.toolCall?.id ?? "think" }, ["t1", "think", "t3"])
        XCTAssertEqual(ms, 73_000)
        XCTAssertEqual(workTitle(parts, durationMs: ms), "Worked for 1m 13s · edited 1 file, ran 1 command")
        // one work message stays itself; the held one too; so does anything that says something
        XCTAssertEqual(keys(groupWorkRuns([rowFor(a)])), ["a"])
        XCTAssertEqual(keys(groupWorkRuns([rowFor(c), rowFor(b), rowFor(a)], hold: "c")), ["c", "work-a"])
        let mixed = ChatMessage(id: "d", role: .assistant, time: 4, parts: [.text("looking"), tool("t5", "bash")])
        XCTAssertEqual(keys(groupWorkRuns([rowFor(c), rowFor(mixed), rowFor(a)])), ["c", "d", "a"])
    }

    func testWorkInsideAMessageFolds() {
        let parts: [ChatPart] = [.text("looking"), .reasoning("a", durationMs: nil), tool("t1", "edit"), .unsupported("step"),
                                 .reasoning(" ", durationMs: nil), tool("t2", "read"), .text("done"), tool("t3")]
        let rows = collapseTranscript(parts)
        XCTAssertEqual(rows, [.one(.text("looking")), .group([.reasoning("a", durationMs: nil), tool("t1", "edit"), tool("t2", "read")]), .one(.text("done")), .one(tool("t3"))])
        XCTAssertEqual(collapseTranscript([tool("t1"), tool("t2")], keep: ["t1"]), [.one(tool("t1")), .one(tool("t2"))])
        XCTAssertEqual(workTitle([tool("t1", "edit"), tool("t2", "edit"), tool("t3", "grep"), tool("t4", "grep")]), "Edited 2 files, searched 2 searches")
        XCTAssertEqual(workTitle([.reasoning("a", durationMs: 1_000), .reasoning("b", durationMs: 2_000)]), "Thought for 3s")
        XCTAssertEqual(workTitle([tool("t1", "bash"), tool("t2")], active: true), "Working · ran 1 command, read 1 file")
        XCTAssertEqual(fmtSpan(7_500_000), "2h 5m")
    }

    func testQuoteTruncates() {
        let long = ChatMessage(id: "x", role: .assistant, time: 1, parts: [.text((1...10).map(String.init).joined(separator: "\n"))])
        XCTAssertEqual(quoteOf(long), "1\n2\n3\n4\n5\n6…")
        XCTAssertNil(quoteOf(ChatMessage(id: "e", role: .assistant, time: 1, parts: [.text("  ")])))
    }

    func testFileKinds() {
        XCTAssertEqual(fileEngineFor("README.md"), .markdown)
        XCTAssertEqual(fileEngineFor("a/b.swift"), .code)
        XCTAssertEqual(fileEngineFor("notes.txt"), .text)
        XCTAssertTrue(isImagePart(FilePart(path: "x.png", name: nil, mimeType: nil)))
        XCTAssertTrue(isImagePart(FilePart(path: "x", name: nil, mimeType: "image/jpeg")))
        XCTAssertFalse(isImagePart(FilePart(path: "x.pdf", name: nil, mimeType: "application/pdf")))
    }

    func testTextSize() {
        XCTAssertEqual(TextSize.from(nil), .standard)
        XCTAssertEqual(TextSize.from("LARGE"), .large)
        XCTAssertEqual(TextSize.from("bogus"), .standard)
    }
}

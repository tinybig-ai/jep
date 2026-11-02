import XCTest
@testable import JepKit

final class ShareInboxTests: XCTestCase {
    private func tmp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testWhatIsSharedComesBackOnceWithItsFiles() throws {
        let dir = tmp()
        let sent = SharedContent(text: "look at this", files: [.init(name: "a/b.png", data: Data([1, 2, 3]), mime: "image/png")])
        try ShareInbox.write(sent, to: dir)
        let got = ShareInbox.take(from: dir)
        XCTAssertEqual(got?.text, "look at this")
        XCTAssertEqual(got?.files.first?.data, Data([1, 2, 3]))
        XCTAssertEqual(got?.files.first?.mime, "image/png")
        XCTAssertNil(ShareInbox.take(from: dir), "taken means gone")
    }

    func testAnEmptyShareOffersNothing() throws {
        let dir = tmp()
        try ShareInbox.write(SharedContent(text: "  "), to: dir)
        XCTAssertNil(ShareInbox.take(from: dir))
    }

    func testAHalfWrittenShareIsNotRead() throws {
        let dir = tmp()
        let box = dir.appendingPathComponent("share-inbox")
        try FileManager.default.createDirectory(at: box, withIntermediateDirectories: true)
        try Data([9]).write(to: box.appendingPathComponent("0-x.png"))
        XCTAssertNil(ShareInbox.take(from: dir), "no manifest yet")
    }
}

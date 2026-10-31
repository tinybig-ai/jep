import XCTest
@testable import JepKit

final class SVGPathTests: XCTestCase {
    func testAbsoluteAndRelativeCommandsBecomeAbsoluteSegments() {
        XCTAssertEqual(
            SVGPath.parse("M1 2 l3 4 h-1 v2 z"),
            [.move(1, 2), .line(4, 6), .line(3, 6), .line(3, 8), .close]
        )
    }

    func testImplicitRepeatsAndCompactNumbers() {
        // "M0 0 1 1" draws a line; "-.5.5" is two numbers
        XCTAssertEqual(SVGPath.parse("M0 0 1 1"), [.move(0, 0), .line(1, 1)])
        XCTAssertEqual(SVGPath.parse("M0 0 L-.5.5"), [.move(0, 0), .line(-0.5, 0.5)])
    }

    func testCubicsAndAClosedPathReturnToItsStart() {
        let s = SVGPath.parse("M0 0c1 1 2 2 3 3zl1 1")
        XCTAssertEqual(s, [.move(0, 0), .cubic(1, 1, 2, 2, 3, 3), .close, .line(1, 1)])
    }

    func testEveryServedMarkParses() throws {
        // the daemon's marks use only M L H V C Z in both cases; a parse that stops early is a broken mark
        for d in ["M0 0h10v10H0z", "m1 1c1 0 2 1 2 2l-1 1z"] {
            let s = SVGPath.parse(d)
            XCTAssertEqual(s.last, .close)
            XCTAssertGreaterThan(s.count, 3)
        }
    }
}

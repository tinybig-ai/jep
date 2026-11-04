import XCTest

/// Against demo-gateway.mjs: a message another conversation sent is a card naming it, and its words are there.
final class GuestTests: XCTestCase {
    func testAMessageFromAnotherConversationNamesItsSender() {
        let app = XCUIApplication()
        app.launchArguments = ["-app_theme", "LIGHT"]
        app.launch()
        let address = app.textFields["gateway address"]
        if address.waitForExistence(timeout: 8) {
            func fill(_ field: XCUIElement, _ text: String) {
                field.tap()
                let old = (field.value as? String) ?? ""
                if !old.isEmpty && old != field.placeholderValue {
                    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
                }
                field.typeText(text)
            }
            fill(address, "127.0.0.1:8931")
            fill(app.textFields["pairing code"], "123456")
            app.buttons["Connect"].firstMatch.tap()
        }
        let row = app.staticTexts["Chart the build times"].firstMatch
        for _ in 0..<3 where !row.waitForExistence(timeout: 5) {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() }
        }
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.staticTexts["from Map render blank · goose"].waitForExistence(timeout: 10), "the card names the conversation it came from")
        XCTAssertTrue(app.staticTexts["the build is done, rerun the shot"].exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}

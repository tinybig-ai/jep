import XCTest

/// Against demo-gateway.mjs: a loop is started from the chat menu, shows over the
/// composer with its progress, stops from there, and is dismissed once over.
final class LoopTests: XCTestCase {
    func testStartStopDismiss() {
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
        let row = app.staticTexts["Profile the image pipeline"].firstMatch
        for _ in 0..<3 where !row.waitForExistence(timeout: 5) {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() }
        }
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()

        app.buttons["chat menu"].firstMatch.tap()
        app.buttons["Loop"].firstMatch.tap()
        let goal = app.textFields["loop goal"].firstMatch.exists ? app.textFields["loop goal"].firstMatch : app.textViews["loop goal"].firstMatch
        XCTAssertTrue(goal.waitForExistence(timeout: 5))
        goal.tap()
        goal.typeText("make the tests pass")
        app.buttons["start loop"].firstMatch.tap()

        let bar = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Loop running'")).firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "a running loop shows over the composer")
        app.buttons["Stop"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Loop stopped'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Dismiss"].firstMatch.tap()
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Loop '")).firstMatch.waitForExistence(timeout: 3), "dismissed")
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}

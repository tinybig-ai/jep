import XCTest

/// Against demo-gateway.mjs: the model sits under the message box, and Carry over
/// starts a new conversation on the chosen harness from this one.
final class CarryOverTests: XCTestCase {
    func testModelChipAndCarryOver() {
        let app = XCUIApplication()
        app.launchArguments = ["-app_theme", "LIGHT"]
        app.launch()

        let address = app.textFields["gateway address"]
        if address.waitForExistence(timeout: 8) {
            address.tap()
            address.typeText("127.0.0.1:8931")
            app.textFields["pairing code"].tap()
            app.textFields["pairing code"].typeText("123456")
            app.buttons["Connect"].firstMatch.tap()
        }
        let row = app.staticTexts["Fix flaky login test"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()

        let chip = app.buttons["model"].firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "the model chip is under the message box")
        XCTAssertTrue(chip.label.contains("claude") || chip.label.contains("Default") || chip.staticTexts.count > 0)
        chip.tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 5) || app.staticTexts["Model"].waitForExistence(timeout: 5))
        app.buttons["Done"].firstMatch.tap()

        app.buttons["chat menu"].firstMatch.tap()
        let carry = app.buttons["Carry over"].firstMatch
        XCTAssertTrue(carry.waitForExistence(timeout: 5))
        carry.tap()
        let claude = app.buttons["claude"].firstMatch
        XCTAssertTrue(claude.waitForExistence(timeout: 5))
        claude.tap()
        XCTAssertTrue(
            app.staticTexts["Carried to claude from s1 in api"].waitForExistence(timeout: 10),
            "a new conversation opened, asked for carryover from this one")
    }
}

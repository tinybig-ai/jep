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
            // the form keeps what the last run typed: clear it before typing over it
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
        let row = app.staticTexts["Fix flaky login test"].firstMatch
        // an earlier run may have left the app inside a conversation: back to the list
        if !row.waitForExistence(timeout: 8), app.navigationBars.buttons.element(boundBy: 0).exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
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
        // leave the app on its list, so the next run starts where this one did
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}

/// Pictures a call showed open in a gallery: one swipe to the next, a counter that says where.
final class GalleryTests: XCTestCase {
    func testShownImagesSwipe() {
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
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let call = app.buttons.matching(NSPredicate(format: "label CONTAINS 'jep-show'")).firstMatch
        XCTAssertTrue(call.waitForExistence(timeout: 10))
        call.tap()
        // the pictures themselves carry no name; the icons around them do
        let shown = app.images.matching(NSPredicate(format: "identifier == '' AND label == ''")).firstMatch
        XCTAssertTrue(shown.waitForExistence(timeout: 10))
        shown.tap()
        XCTAssertTrue(app.staticTexts["image 1 of 2"].waitForExistence(timeout: 10), "the gallery opened on the first of two")
        app.swipeLeft()
        XCTAssertTrue(app.staticTexts["image 2 of 2"].waitForExistence(timeout: 5), "one swipe reaches the next picture")
        app.buttons["dismiss"].firstMatch.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}

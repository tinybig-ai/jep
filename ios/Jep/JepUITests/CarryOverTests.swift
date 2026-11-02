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

/// Grouped by project: the list shows folders, a folder opens to its conversations.
final class GroupingTests: XCTestCase {
    func testProjectsOpenToTheirConversations() {
        let app = XCUIApplication()
        app.launchArguments = ["-app_theme", "LIGHT", "-app_group_by_project", "true"]
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
        // the demo has "docs" with two conversations: release notes and the charts
        let project = app.buttons.matching(NSPredicate(format: "label CONTAINS 'docs' AND label CONTAINS '2 conversations'")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 30), "a project row says how many conversations it holds")
        XCTAssertFalse(app.staticTexts["Write release notes for 0.4"].exists, "the conversations are one level down")
        project.tap()
        XCTAssertTrue(app.staticTexts["Write release notes for 0.4"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Chart the build times"].exists)
        app.buttons["back to projects"].firstMatch.tap()
        XCTAssertTrue(project.waitForExistence(timeout: 5))
    }
}

/// Shared in from another app: the form holds the content, a destination is picked,
/// and the content goes out as the new conversation's first message.
///
/// Named to run before ScreenTour: the tour leaves the simulator's app in a state where
/// the app never reports idle after Create, and this test would wait on it for minutes.
final class ASharedContentTests: XCTestCase {
    func testSharedTextBecomesTheFirstMessage() {
        let app = XCUIApplication()
        app.launchArguments = ["-app_theme", "LIGHT", "-uitest_share_text", "look at this build log"]
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
        XCTAssertTrue(app.staticTexts["look at this build log"].waitForExistence(timeout: 30), "the new-conversation form shows what is being shared")
        let create = app.buttons["Create"].firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        // the demo gateway answers /prompt slowly; the message shows at once as the person's own
        XCTAssertTrue(app.staticTexts["look at this build log"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["chat menu"].firstMatch.waitForExistence(timeout: 10), "a conversation opened")
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}

final class PlainCreateTests: XCTestCase {
    func testCreateOpensTheConversation() {
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
        XCTAssertTrue(app.buttons["New conversation"].firstMatch.waitForExistence(timeout: 30))
        app.buttons["New conversation"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Create"].firstMatch.waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quick conversation'")).firstMatch.tap()
        app.buttons["Create"].firstMatch.tap()
        XCTAssertTrue(app.buttons["chat menu"].firstMatch.waitForExistence(timeout: 15), "creating opens the conversation")
    }
}

/// A long draft offers the whole screen to write in, and what is written there is the draft.
final class ExpandTests: XCTestCase {
    func testALongDraftCanBeExpanded() {
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
        let row = app.staticTexts["Fix flaky login test"].firstMatch
        // an earlier test may have left the app inside a conversation: back to the list
        for _ in 0..<3 where !row.waitForExistence(timeout: 5) {
            let back = app.navigationBars.buttons.element(boundBy: 0)
            if back.exists { back.tap() }
        }
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let composer = app.textViews["composer"].firstMatch.exists ? app.textViews["composer"].firstMatch : app.textFields["composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        // a draft is kept per conversation: start from an empty one
        composer.tap()
        let kept = (composer.value as? String) ?? ""
        if !kept.isEmpty && kept != "Message the agent" {
            composer.press(forDuration: 1.2)
            if app.menuItems["Select All"].waitForExistence(timeout: 3) {
                app.menuItems["Select All"].tap()
                composer.typeText(XCUIKeyboardKey.delete.rawValue)
            }
        }
        XCTAssertFalse(app.buttons["expand the composer"].exists, "a short draft has nothing to expand")
        composer.typeText("one\ntwo\nthree\nfour\nfive")
        let expand = app.buttons["expand the composer"].firstMatch
        XCTAssertTrue(expand.waitForExistence(timeout: 5), "five lines is worth the whole screen")
        expand.tap()
        XCTAssertTrue(app.textViews["full composer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["23 chars"].exists)
        app.buttons["shrink the composer"].firstMatch.tap()
        XCTAssertTrue(app.buttons["expand the composer"].waitForExistence(timeout: 5))
        composer.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 3) {
            app.menuItems["Select All"].tap()
            composer.typeText(XCUIKeyboardKey.delete.rawValue)
        }
    }
}

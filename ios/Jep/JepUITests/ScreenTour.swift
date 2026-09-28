import XCTest

/// Walks every screen against demo-gateway.mjs and keeps a screenshot of each.
final class ScreenTour: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
    }

    private func launch(dark: Bool) {
        app.launchArguments = ["-app_terminal_enabled", "true", "-app_theme", dark ? "DARK" : "LIGHT", "-app_text_size", "SMALL"]
        app.launch()
    }

    private func shot(_ name: String) {
        sleep(1)
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    @discardableResult
    private func tap(_ e: XCUIElement, timeout: TimeInterval = 6) -> Bool {
        guard e.waitForExistence(timeout: timeout) else { return false }
        e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        return true
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    private func close() {
        for l in ["Done", "Close", "Cancel"] where app.buttons[l].exists {
            app.buttons[l].firstMatch.tap()
            sleep(1)
            return
        }
    }

    private func back() {
        let b = app.navigationBars.buttons.element(boundBy: 0)
        if b.exists { b.tap() }
        sleep(1)
    }

    func testTour() {
        launch(dark: false)

        let address = app.textFields["gateway address"]
        if address.waitForExistence(timeout: 8) {
            shot("01-pair")
            address.tap()
            address.typeText("127.0.0.1:8931")
            app.textFields["pairing code"].tap()
            app.textFields["pairing code"].typeText("123456")
            shot("02-pair-filled")
            tap(button("Connect"))
        }

        XCTAssertTrue(app.staticTexts["Fix flaky login test"].waitForExistence(timeout: 15))
        shot("03-sessions")

        let notes = app.staticTexts["Write release notes for 0.4"].firstMatch
        if notes.waitForExistence(timeout: 4) {
            notes.press(forDuration: 1.0)
            shot("03a-select")
            if tap(button("Pin")) { sleep(1); shot("03b-pinned") }
        }

        if tap(button("sessions menu")) { shot("04-sessions-menu") }
        if tap(button("Archived")) { shot("05-archived"); close() }
        if tap(button("sessions menu")), tap(button("Import external session")) { shot("06-import"); close() }
        if tap(button("sessions menu")), tap(button("Settings")) {
            shot("07-settings")
            app.swipeUp()
            shot("08-settings-bottom")
            back()
        }

        if tap(button("New conversation")) {
            shot("09-new-chat")
            if tap(button("Browse folders…")) { shot("10-browse"); close() }
            back()
        }

        let row = app.staticTexts["Fix flaky login test"].firstMatch
        if tap(row) {
            sleep(2)
            shot("11-chat")
            app.swipeDown()
            shot("12-chat-top")
            app.swipeUp()
            app.swipeUp()
            shot("13-chat-ask")

            let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Read 3'")).firstMatch
            if fold.waitForExistence(timeout: 2) {
                // bring it clear of the glass toolbar before tapping
                for _ in 0..<6 where fold.frame.minY < app.frame.height * 0.3 {
                    let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
                    top.press(forDuration: 0.05, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 150)))
                }
                shot("13b-work-fold")
                if tap(fold, timeout: 2) {
                    shot("14-work-fold-open")
                    tap(button("hide this work"), timeout: 2)
                }
            }

            let sheets: [(String, String)] = [
                ("Model", "16-model"), ("Agent", "17-agent"), ("Settings", "18-chat-settings"), ("Usage", "19-usage"),
                ("Changes", "20-changes"), ("Git", "21-git"), ("Subagents", "22-subagents"), ("Terminal", "23-terminal"), ("Rename", "24-rename"),
            ]
            for (item, name) in sheets {
                if tap(button("chat menu")) {
                    if item == "Model" { shot("15b-chat-menu") }
                    if tap(button(item)) { shot(name); close() } else { app.tap() }
                }
            }

            if tap(button("chat menu")), tap(button("Changes")) {
                if tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'session.ts'")).firstMatch) {
                    sleep(2)
                    shot("25-file-reader")
                    close()
                }
            }
            let composer = app.textViews["composer"].exists ? app.textViews["composer"] : app.textFields["composer"]
            if tap(composer, timeout: 3) {
                composer.typeText("Also add a regression test")
                shot("25b-composer")
                app.swipeDown()
            }

            back()
        }

        app.terminate()
        launch(dark: true)
        sleep(4)
        shot("26-dark")
        if !app.staticTexts["Fix flaky login test"].exists { back() }
        if app.staticTexts["Fix flaky login test"].waitForExistence(timeout: 10) {
            shot("27-sessions-dark")
            if tap(app.staticTexts["Fix flaky login test"].firstMatch) {
                sleep(2)
                shot("28-chat-dark")
            }
        }
    }
}

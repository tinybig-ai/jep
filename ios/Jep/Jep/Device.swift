import JepKit
import SwiftUI
import UIKit
import UserNotifications

// The phone's side of attention and notifications. What is worth a
// notification is NotificationPolicy's call; this file only carries it out.

@MainActor
final class DeviceAttention: Attention {
    private(set) var openSessionId: String?
    var foreground = true

    nonisolated init() {}

    nonisolated func chatOpened(sessionId: String) {
        Task { @MainActor in self.openSessionId = sessionId }
    }

    nonisolated func chatClosed(sessionId: String) {
        Task { @MainActor in if self.openSessionId == sessionId { self.openSessionId = nil } }
    }

    nonisolated func seen(sessionId: String) {
        Notifier.clear(sessionId: sessionId)
    }
}

enum Notifier {
    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// one notification per conversation and kind, so a newer one replaces it
    static func post(_ notice: NotificationPolicy.Notice, sessionId: String, title: String?) {
        let content = UNMutableNotificationContent()
        switch notice {
        case .finished:
            content.title = title ?? String(localized: "JEP_TURN_FINISHED")
            content.body = String(localized: "JEP_TURN_FINISHED")
        case .asked:
            content.title = title ?? String(localized: "JEP_ASK_TITLE")
            content.body = String(localized: "JEP_ASK_BODY")
        }
        content.sound = .default
        content.threadIdentifier = sessionId
        content.userInfo = ["sessionID": sessionId, "kind": notice.rawValue]
        let request = UNNotificationRequest(identifier: "\(sessionId).\(notice.rawValue)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    static func clear(sessionId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { $0.request.content.threadIdentifier == sessionId }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    static func withdrawAsk(sessionId: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["\(sessionId).asked"])
    }
}

/// iOS gives a backgrounded app a short grace period, not a standing stream.
/// During it the feed keeps playing into local notifications; after it, APNs
/// (when the gateway has it configured) takes over.
@MainActor
final class BackgroundWatch {
    static let shared = BackgroundWatch()
    private var task: Task<Void, Never>?
    private var grant: UIBackgroundTaskIdentifier = .invalid

    func start(_ store: AppStore) {
        stop()
        grant = UIApplication.shared.beginBackgroundTask(withName: "jep.stream") { [weak self] in self?.stop() }
        let repo = store.chat()
        let attention = Composition.attention
        task = Task { @MainActor in
            for await event in repo.events() {
                if Task.isCancelled { break }
                if case .askResolved(let s, _) = event { Notifier.withdrawAsk(sessionId: s) }
                guard let s = event.sessionId,
                      let notice = NotificationPolicy.decide(event, openSessionId: attention.openSessionId, foreground: attention.foreground)
                else { continue }
                // with push on, Apple delivers these; posting too would say it twice
                if Push.registered { continue }
                let title = store.sessions.first { $0.id == s }?.title
                if case .asked(_, let ask) = event { Notifier.post(notice, sessionId: s, title: ask.title) } else { Notifier.post(notice, sessionId: s, title: title) }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        if grant != .invalid {
            UIApplication.shared.endBackgroundTask(grant)
            grant = .invalid
        }
    }
}

/// APNs registration, gated on the "Background updates" setting. The token is
/// handed to the gateway as "apns:<hex>" so it can route it past FCM.
@MainActor
enum Push {
    static var token: String?
    static var registered = false

    static func sync(_ store: AppStore) {
        guard store.paired else { return }
        if store.prefs.backgroundStreaming {
            Task {
                if await Notifier.requestPermission() { UIApplication.shared.registerForRemoteNotifications() }
            }
        } else if let token {
            let repo = store.chat()
            registered = false
            Task { _ = try? await repo.unregisterPush(token: "apns:" + token) }
        }
    }

    static func received(_ deviceToken: Data, _ store: AppStore) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        let repo = store.chat()
        Task { @MainActor in registered = (try? await repo.registerPush(token: "apns:" + hex)) ?? false }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { Push.received(deviceToken, Composition.app) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { Push.registered = false }
    }

    /// a push that lands while the app is open is the open screen's business
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["sessionID"] as? String else { return }
        await MainActor.run { Composition.app.openSessionById(id) }
    }
}

import JepKit
import SwiftUI
import UIKit
import UserNotifications

/// The composition root: the one place the device adapters meet the stores.
@MainActor
enum Composition {
    static let prefs = DefaultsStore()
    static let attention = DeviceAttention()
    static let app = AppStore(
        pairing: PairingStore(prefs: prefs, secrets: KeychainStore()),
        prefs: prefs,
        memory: ConversationStore(prefs),
        attention: attention
    )
}

@main
struct JepApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase
    private let store = Composition.app

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(\.textScale, store.prefs.textSize.scale)
                .preferredColorScheme(store.prefs.theme.colorScheme)
                .onOpenURL { DeepLink.open($0, store) }
        }
        .onChange(of: phase) { _, now in
            Composition.attention.foreground = now == .active
            switch now {
            case .active:
                BackgroundWatch.shared.stop()
                if store.paired { store.refresh() }
                Push.sync(store)
            case .background:
                if store.prefs.backgroundStreaming && store.paired { BackgroundWatch.shared.start(store) }
            default:
                break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            if !store.paired {
                PairView()
            } else {
                NavigationStack {
                    SessionsView()
                        .navigationDestination(isPresented: chatShown) { ChatHost() }
                        .navigationDestination(isPresented: newChatShown) { NewChatView() }
                        .navigationDestination(isPresented: settingsShown) { SettingsView() }
                }
            }
        }
        .animation(.default, value: store.paired)
    }

    private var chatShown: Binding<Bool> {
        Binding(get: { if case .chat = store.screen { true } else { false } }, set: { if !$0 { store.back() } })
    }
    private var newChatShown: Binding<Bool> {
        Binding(get: { store.screen == .newChat }, set: { if !$0 { store.closeNewChat() } })
    }
    private var settingsShown: Binding<Bool> {
        Binding(get: { store.screen == .settings }, set: { if !$0 { store.back() } })
    }
}

/// a fresh ChatStore per opened conversation, closed when it leaves the screen
struct ChatHost: View {
    @Environment(AppStore.self) private var store
    @State private var chat: ChatStore?

    var body: some View {
        Group {
            if let chat { ChatView(chat: chat) } else { ProgressView() }
        }
        .onAppear(perform: bind)
        .onChange(of: store.screen) { _, _ in bind() }
        .onDisappear {
            chat?.close()
            chat = nil
        }
    }

    private func bind() {
        guard case .chat(let id, let title, let workspace, let harness) = store.screen else { return }
        if chat?.sessionId == id { return }
        chat?.close()
        chat = store.makeChatStore(sessionId: id, title: title, workspace: workspace, harness: harness)
    }
}

enum DeepLink {
    /// jep://session?id=… opens that conversation
    @MainActor
    static func open(_ url: URL, _ store: AppStore) {
        guard url.scheme == "jep", url.host == "session",
              let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value
        else { return }
        store.openSessionById(id)
    }
}

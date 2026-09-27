import JepKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var forgetOpen = false
    @State private var gatewayOpen = false
    @State private var terminalOpen = false
    @State private var howOpen = false

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: Binding(get: { store.prefs.theme }, set: { store.setTheme($0) })) {
                    ForEach(ThemeMode.allCases, id: \.self) { Label($0.label, systemImage: $0.icon).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Text size")
                    Picker("Text size", selection: Binding(get: { store.prefs.textSize }, set: { store.setTextSize($0) })) {
                        ForEach(TextSize.allCases, id: \.self) { Text($0.label).tag($0).accessibilityLabel("Text size \($0.label)") }
                    }
                    .pickerStyle(.segmented)
                }
            }
            Section("Features") {
                Toggle(isOn: Binding(get: { store.prefs.terminalEnabled }, set: { on in
                    if on { terminalOpen = true } else { store.disableTerminal() }
                })) {
                    row("In-chat terminal", terminalDetail)
                }
                .disabled(store.termAccess?.allowed == false)
                if store.termAccess?.allowed == false {
                    Button("How to enable") { howOpen.toggle() }.jepFont(13)
                    if howOpen {
                        Text("""
                        On the machine running jep:
                        1. put JEP_TERMINAL=1 in the daemon's EnvironmentVariables
                           (~/Library/LaunchAgents/com.jep.tg.plist)
                        2. launchctl bootout gui/$(id -u)/com.jep.tg
                           launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jep.tg.plist
                        3. reopen Settings and enable it here.
                        """)
                        .jepFont(12, design: .monospaced)
                        .textSelection(.enabled)
                    }
                }
                Toggle(isOn: Binding(get: { store.prefs.backgroundStreaming }, set: {
                    store.setBackgroundStreaming($0)
                    Push.sync(store)
                })) {
                    row(
                        "Background updates",
                        store.prefs.backgroundStreaming
                            ? "notifies you about a finished reply or a question while jep is closed"
                            : "off: no notification, and the app stops listening in the background"
                    )
                }
            }
            Section("Connection") {
                LabeledContent("Gateway", value: store.gateway ?? "—")
                Button("Change gateway") { gatewayOpen = true }
            }
            Section("Pairing") {
                Button(role: .destructive) { forgetOpen = true } label: {
                    row("Forget pairing", "erase the token; you will need a fresh pairing code")
                }
            }
        }
        .navigationTitle("Settings")
        .onAppear { store.refreshTerminalAccess() }
        .alert("Forget pairing?", isPresented: $forgetOpen) {
            Button("Forget", role: .destructive) { store.forgetPairing() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your token is erased. Reconnect with the gateway address and a fresh pairing code.")
        }
        .sheet(isPresented: $gatewayOpen) { GatewaySheet() }
        .sheet(isPresented: $terminalOpen) { TerminalUnlockSheet() }
    }

    private var terminalDetail: String {
        if store.termAccess?.allowed == false { return "not offered by this gateway" }
        return store.prefs.terminalEnabled
            ? "a shell in the conversation's folder, attached to the chat"
            : "enabling asks for the pairing code again"
    }

    private func row(_ name: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).jepFont(15)
            Text(detail).jepFont(12).foregroundStyle(.secondary)
        }
    }
}

struct GatewaySheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Text("Pair again with the gateway's address and its current pairing code.").foregroundStyle(.secondary)
                TextField("host:port", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Pairing code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                if let error { Text(error).foregroundStyle(.red).jepFont(13) }
            }
            .navigationTitle("Change gateway")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Connecting…" : "Connect") {
                        busy = true
                        Task {
                            if let e = await store.pair(address: address, code: code) { error = e } else { dismiss() }
                            busy = false
                        }
                    }
                    .disabled(busy || address.isEmpty || code.isEmpty)
                }
            }
            .onAppear { address = store.gateway ?? "" }
        }
        .presentationDetents([.medium])
    }
}

struct TerminalUnlockSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Text("A terminal is a shell on your machine. Enter the gateway's current pairing code to allow it on this phone.").foregroundStyle(.secondary)
                TextField("Pairing code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                if let error { Text(error).foregroundStyle(.red).jepFont(13) }
            }
            .navigationTitle("Enable terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Checking…" : "Enable") {
                        busy = true
                        Task {
                            if await store.enableTerminal(code: code) { dismiss() } else { error = "That code was not accepted." }
                            busy = false
                        }
                    }
                    .disabled(busy || code.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

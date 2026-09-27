import JepKit
import SwiftUI

struct PairView: View {
    @Environment(AppStore.self) private var store
    @State private var address = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("jep").jepFont(44, .bold, design: .rounded)
            Text("Pair with the gateway running next to your agents.")
                .jepFont(15)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            VStack(spacing: 12) {
                TextField("192.168.1.20:8931", text: $address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .accessibilityLabel("gateway address")
                    .padding(14)
                    .glassCard(14)
                TextField("pairing code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .accessibilityLabel("pairing code")
                    .padding(14)
                    .glassCard(14)
            }
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            if let error {
                Text(error).jepFont(13).foregroundStyle(.red)
            }
            Button {
                connect()
            } label: {
                Text(busy ? "Connecting…" : "Connect").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .glassProminentButton()
            .disabled(busy || address.isEmpty || code.isEmpty)
            Spacer()
        }
        .padding(24)
        .onAppear { if address.isEmpty { address = store.gateway ?? "" } }
    }

    private func connect() {
        busy = true
        error = nil
        Task {
            error = await store.pair(address: address, code: code)
            busy = false
        }
    }
}

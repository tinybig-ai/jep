#if os(macOS)
import AppKit
import CoreImage.CIFilterBuiltins
import JepBarCore
import SwiftUI

@main
struct JepBarApp: App {
    @State private var model = Model()

    init() { NSApplication.shared.setActivationPolicy(.accessory) }

    var body: some Scene {
        MenuBarExtra {
            Panel(model: model)
        } label: {
            Image(nsImage: appleIcon(filled: model.up))
        }
        .menuBarExtraStyle(.window)
    }
}

/// Polls the file the daemon writes and the gateway's /health; nothing else.
@Observable @MainActor
final class Model {
    var pairing: GatewayPairing?
    var up = false
    var hosts: [String] = []
    var host: String?

    private let file = dataHome().appendingPathComponent("pairing-status.json")

    init() {
        Task {
            while true {
                await refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    var link: String? {
        guard up, let p = pairing, let port = p.port, let code = p.code, let host else { return nil }
        return pairLink(host: host, port: port, code: code)
    }

    func refresh() async {
        pairing = (try? Data(contentsOf: file)).flatMap(gatewayPairing)
        hosts = rankHosts(localIPv4())
        if host.map({ !hosts.contains($0) }) ?? true { host = hosts.first }
        guard let port = pairing?.port else { up = false; return }
        var ok = false
        for h in ["127.0.0.1"] + hosts {
            if await healthy(h, port) { ok = true; break }
        }
        up = ok
    }

    private func healthy(_ host: String, _ port: Int) async -> Bool {
        guard let url = URL(string: "http://\(host):\(port)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        guard let (_, res) = try? await URLSession.shared.data(for: req) else { return false }
        return (res as? HTTPURLResponse)?.statusCode == 200
    }
}

struct Panel: View {
    @Bindable var model: Model
    // A shared or recorded screen must not hand out a working pairing. The QR
    // and the code stay hidden until asked for, and hide again on their own.
    @State private var revealed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle().fill(model.up ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text("jep").font(.headline)
                Spacer()
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            if let link = model.link, let code = model.pairing?.code {
                PairingQR(link: link, revealed: $revealed)
                Text("Scan with the phone's camera, or enter:").font(.caption).foregroundStyle(.secondary)
                if model.hosts.count > 1 {
                    Picker("Address", selection: $model.host) {
                        ForEach(model.hosts, id: \.self) { Text(verbatim: "\($0):\(model.pairing?.port ?? 0)").tag(Optional($0)) }
                    }
                    .labelsHidden()
                } else if let h = model.host {
                    Text(verbatim: "\(h):\(model.pairing?.port ?? 0)").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
                Group {
                    if revealed {
                        Text(code).textSelection(.enabled)
                    } else {
                        Text(String(repeating: "•", count: code.count)).foregroundStyle(.secondary)
                    }
                }
                .font(.system(.title2, design: .monospaced).weight(.semibold))
                // a pairing spent on one phone mints the next code; it starts hidden
                .onChange(of: code) { revealed = false }
            } else {
                Text(hint).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Button("Open log") { NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/jep-tg.log")) }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(16)
        .frame(width: 280)
        .onDisappear { revealed = false }
        .task(id: revealed) {
            guard revealed else { return }
            try? await Task.sleep(for: .seconds(60))
            revealed = false
        }
    }

    private var status: String {
        guard model.up, let p = model.pairing else { return "not running" }
        return "running · \(p.devices) paired"
    }

    private var hint: String {
        if model.pairing == nil { return "No daemon state in \(dataHome().path). Start jep (scripts/install.sh)." }
        if model.pairing?.port == nil { return "The daemon is up without the gateway. Set JEP_GW_PORT and restart it." }
        if model.up && model.host == nil { return "No network address to pair over." }
        return "The daemon isn't answering. Check the log."
    }
}

/// The pairing QR, hidden behind a blur until revealed. The blurred one is a
/// decoy for a random code, not the real link: a blur can sometimes be undone,
/// and a decoy has nothing to recover.
struct PairingQR: View {
    let link: String
    @Binding var revealed: Bool
    @State private var decoy = PairingQR.decoyLink()

    var body: some View {
        ZStack {
            QRView(text: revealed ? link : decoy)
                .blur(radius: revealed ? 0 : 9)
                .animation(.easeOut(duration: 0.2), value: revealed)
            if revealed {
                VStack {
                    HStack {
                        Spacer()
                        Button { revealed = false } label: { Image(systemName: "eye.slash") }
                            .buttonStyle(.borderless)
                            .foregroundStyle(.white.opacity(0.8))
                            .help("Hide the pairing code")
                    }
                    Spacer()
                }
                .padding(10)
            } else {
                Button { revealed = true } label: { Label("Show pairing code", systemImage: "eye") }
                    .controlSize(.large)
            }
        }
        .frame(width: 220, height: 220)
        .frame(maxWidth: .infinity)
        .onChange(of: revealed) { if !revealed { decoy = PairingQR.decoyLink() } }
    }

    private static func decoyLink() -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        let code = String((0..<9).map { _ in alphabet.randomElement()! })
        return "jep://pair?address=100.64.0.1:8931&code=\(code)"
    }
}

/// White modules on a clear ground, over a dark glass card: transparent, and
/// still white-on-dark in a light-mode panel, where white on the bare panel
/// would vanish. Phone cameras read an inverted code like a normal one.
struct QRView: View {
    let text: String

    var body: some View {
        if let image {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(16)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.18)))
                .environment(\.colorScheme, .dark)
        }
    }

    private var image: NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let qr = f.outputImage else { return nil }
        let tint = CIFilter.falseColor()
        tint.inputImage = qr
        tint.color0 = CIColor(red: 1, green: 1, blue: 1, alpha: 1)
        tint.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        guard let out = tint.outputImage, let cg = CIContext().createCGImage(out, from: qr.extent) else { return nil }
        return NSImage(cgImage: cg, size: qr.extent.size)
    }
}
#else
@main
enum JepBar {
    static func main() { print("JepBar is a macOS app") }
}
#endif

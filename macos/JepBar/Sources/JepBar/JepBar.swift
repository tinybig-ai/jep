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
            Image(systemName: model.up ? "circle.fill" : "circle.dotted")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle().fill(model.up ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text("jep").font(.headline)
                Spacer()
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            if let link = model.link, let code = model.pairing?.code {
                QRView(text: link).frame(width: 220, height: 220).frame(maxWidth: .infinity)
                Text("Scan with the phone's camera, or enter:").font(.caption).foregroundStyle(.secondary)
                if model.hosts.count > 1 {
                    Picker("Address", selection: $model.host) {
                        ForEach(model.hosts, id: \.self) { Text("\($0):\(model.pairing?.port ?? 0)").tag(Optional($0)) }
                    }
                    .labelsHidden()
                } else if let h = model.host {
                    Text("\(h):\(model.pairing?.port ?? 0)").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
                Text(code).font(.system(.title2, design: .monospaced).weight(.semibold)).textSelection(.enabled)
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

struct QRView: View {
    let text: String

    var body: some View {
        if let image { Image(nsImage: image).interpolation(.none).resizable().scaledToFit().padding(8).background(.white, in: RoundedRectangle(cornerRadius: 8)) }
    }

    private var image: NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return NSImage(cgImage: cg, size: out.extent.size)
    }
}
#else
@main
enum JepBar {
    static func main() { print("JepBar is a macOS app") }
}
#endif

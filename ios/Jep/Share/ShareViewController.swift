import JepKit
import UIKit
import UniformTypeIdentifiers

/// Share anything into jep. The extension cannot talk to the gateway or choose a
/// destination, so it does the one thing it can: it puts what was shared in the
/// app group's inbox and says so. jep offers it as a new conversation the next
/// time it comes forward.
final class ShareViewController: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await handOver() }
    }

    private func handOver() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
        var words: [String] = []
        var files: [SharedContent.File] = []
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || p.hasItemConformingToTypeIdentifier(UTType.image.identifier) || p.hasItemConformingToTypeIdentifier(UTType.data.identifier) && !p.hasItemConformingToTypeIdentifier(UTType.url.identifier) && !p.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                if let file = await file(from: p) { files.append(file); continue }
            }
            if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                words.append(url.absoluteString)
            } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                words.append(text)
            }
        }
        let content = SharedContent(text: words.isEmpty ? nil : words.joined(separator: "\n"), files: files)
        guard !content.isEmpty else { return finish("Nothing here jep can take.") }
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.jep.client") else {
            return finish("jep could not reach its shared folder.")
        }
        do {
            try ShareInbox.write(content, to: dir)
            finish("Saved. Open jep to choose where it goes.")
        } catch {
            finish("Could not save it: \(error.localizedDescription)")
        }
    }

    /// the bytes behind a provider, copied out before the system removes its temporary file
    private func file(from p: NSItemProvider) async -> SharedContent.File? {
        let type = p.registeredTypeIdentifiers.first.flatMap { UTType($0) } ?? .data
        return await withCheckedContinuation { continuation in
            p.loadFileRepresentation(forTypeIdentifier: (p.registeredTypeIdentifiers.first ?? UTType.data.identifier)) { url, _ in
                guard let url, let data = try? Data(contentsOf: url) else { return continuation.resume(returning: nil) }
                continuation.resume(returning: .init(name: p.suggestedName.map { name in
                    (name as NSString).pathExtension.isEmpty ? name + "." + (type.preferredFilenameExtension ?? "bin") : name
                } ?? url.lastPathComponent, data: data, mime: type.preferredMIMEType))
            }
        }
    }

    private func finish(_ message: String) {
        let alert = UIAlertController(title: "jep", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        present(alert, animated: true)
    }
}

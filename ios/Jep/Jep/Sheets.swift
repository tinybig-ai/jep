import JepKit
import SwiftUI
import WebKit

private struct SheetFrame<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .legacySheetMaterial()
    }
}

struct ModelSheet: View {
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame(title: "Model") {
            Group {
                if let m = chat.state.models {
                    List {
                        row(m.defaultRef.map { "Default · " + ($0.split(separator: "/").last.map(String.init) ?? $0) } ?? "Default (harness)", nil, m.current == nil)
                        ForEach(Dictionary(grouping: m.all, by: \.providerID).sorted { $0.key < $1.key }, id: \.key) { provider, models in
                            Section(provider) {
                                ForEach(models, id: \.self) { model in
                                    row(model.modelID, model.ref, m.current == model.ref, detail: model.image ? "accepts images" : nil)
                                }
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .onAppear { chat.loadModels() }
    }

    private func row(_ label: String, _ ref: String?, _ on: Bool, detail: String? = nil) -> some View {
        Button {
            chat.setModel(ref)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(label)
                    if let detail { Text(detail).jepFont(11).foregroundStyle(.secondary) }
                }
                Spacer()
                if on { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("choose model \(label)")
    }
}

struct AgentSheet: View {
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame(title: "Agent") {
            List {
                pick("Default", nil, detail: nil)
                ForEach(chat.state.agents, id: \.self) { a in pick(a.label, a.id, detail: a.detail) }
            }
        }
        .onAppear { chat.loadAgent() }
    }

    private func pick(_ label: String, _ id: String?, detail: String?) -> some View {
        Button {
            chat.setAgent(id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(label)
                    if let detail { Text(detail).jepFont(12).foregroundStyle(.secondary) }
                }
                Spacer()
                if chat.state.agent == id { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
        }
        .buttonStyle(.plain)
    }
}

struct ChatSettingsSheet: View {
    let chat: ChatStore

    var body: some View {
        let st = chat.state
        SheetFrame(title: "Settings") {
            Form {
                HarnessSettingsSection(
                    title: "HARNESS",
                    options: st.harnessSettings.options,
                    values: st.harnessSettings.values,
                    loading: st.harnessSettingsLoading,
                    onToggle: { chat.setHarnessSetting(id: $0, enabled: $1) }
                )
                if let skills = st.skills, !skills.skills.isEmpty {
                    Section("SKILLS") {
                        ForEach(skills.skills, id: \.self) { s in
                            Toggle(isOn: Binding(get: { !s.disabled }, set: { chat.setSkill(path: s.path, disabled: !$0) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.name)
                                    Text([s.scope, s.description].filter { !$0.isEmpty }.joined(separator: " · ")).jepFont(12).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            .disabled(!skills.toggleable)
                        }
                    }
                }
                if let mcp = st.mcp, !mcp.isEmpty {
                    Section("MCP SERVERS") {
                        ForEach(mcp, id: \.self) { m in
                            Toggle(isOn: Binding(get: { m.enabled }, set: { chat.setMcp(name: m.name, enabled: $0) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.name)
                                    Text([m.kind, m.detail].filter { !$0.isEmpty }.joined(separator: " · ")).jepFont(12).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                        }
                    }
                }
            }
        }
        .onAppear {
            chat.loadHarnessSettings()
            chat.loadSkills()
            chat.loadMcp()
        }
    }
}

struct UsageSheet: View {
    let chat: ChatStore

    var body: some View {
        SheetFrame(title: "Usage") {
            Group {
                if let u = chat.state.usage {
                    List {
                        Section("Spend") {
                            LabeledContent("Cost", value: fmtMoney(u.cost))
                            LabeledContent("Turns", value: "\(u.turns)")
                            if u.unpriced > 0 { LabeledContent("Unpriced turns", value: "\(u.unpriced)") }
                        }
                        Section("Tokens") {
                            LabeledContent("Input", value: fmtTokens(u.input))
                            LabeledContent("Output", value: fmtTokens(u.output))
                            LabeledContent("Reasoning", value: fmtTokens(u.reasoning))
                            LabeledContent("Cache read", value: fmtTokens(u.cacheRead))
                            LabeledContent("Cache write", value: fmtTokens(u.cacheWrite))
                            LabeledContent("Total tokens", value: fmtTokens(u.total))
                        }
                        if !u.models.isEmpty {
                            Section("Models") { ForEach(u.models, id: \.self) { Text($0) } }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .onAppear { chat.loadUsage() }
    }
}

struct DiffSheet: View {
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame(title: "Changes") {
            Group {
                if let diffs = chat.state.diffs {
                    if diffs.isEmpty {
                        ContentUnavailableView("No changes", systemImage: "checkmark.circle")
                    } else {
                        List(diffs, id: \.self) { d in
                            Button {
                                dismiss()
                                Task {
                                    try? await Task.sleep(nanoseconds: 450_000_000)
                                    chat.openFile(d.file)
                                }
                            } label: {
                                HStack {
                                    Text(d.file).jepFont(13, design: .monospaced).lineLimit(1).truncationMode(.head)
                                    Spacer()
                                    Text("+\(d.additions)").foregroundStyle(.green).jepFont(12)
                                    Text("-\(d.deletions)").foregroundStyle(.red).jepFont(12)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .onAppear { chat.loadDiff() }
    }
}

struct GitSheet: View {
    let chat: ChatStore

    var body: some View {
        let st = chat.state
        SheetFrame(title: "Git") {
            Group {
                if let e = st.gitError {
                    ContentUnavailableView(e, systemImage: "exclamationmark.triangle")
                } else if let g = st.git {
                    if !g.isRepository {
                        ContentUnavailableView("This workspace isn't a Git repository.", systemImage: "arrow.triangle.branch")
                    } else {
                        List {
                            Section {
                                LabeledContent("Branch", value: g.branch ?? "detached HEAD")
                                LabeledContent("HEAD", value: g.head.map { "\($0.shortHash) \($0.subject)" } ?? "No commits yet")
                                LabeledContent("Changed files", value: "\(g.changedFiles)")
                            }
                            Section("RECENT HISTORY") {
                                ForEach(g.commits, id: \.self) { c in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(c.subject).jepFont(14).lineLimit(2)
                                        Text("\(c.shortHash) · \(c.author) · \(clockTime(c.time))").jepFont(11, design: .monospaced).foregroundStyle(.secondary)
                                    }
                                    .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = c.hash } }
                                }
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .refreshable { chat.loadGit() }
        }
        .onAppear { chat.loadGit() }
    }
}

struct SubagentsSheet: View {
    @Environment(AppStore.self) private var app
    @Environment(\.dismiss) private var dismiss
    let chat: ChatStore

    var body: some View {
        SheetFrame(title: "Subagents") {
            Group {
                if let list = chat.state.subagents {
                    if list.isEmpty {
                        ContentUnavailableView("No subagents — this conversation didn't spawn any.", systemImage: "person.2")
                    } else {
                        List(list) { s in
                            Button {
                                dismiss()
                                app.open(s)
                            } label: {
                                SessionRow(session: s, unread: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .onAppear { chat.loadSubagents() }
    }
}

struct RenameSheet: View {
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""

    var body: some View {
        NavigationStack {
            Form { TextField("Title", text: $title) }
                .navigationTitle("Rename conversation")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            chat.rename(title)
                            dismiss()
                        }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
        }
        .presentationDetents([.height(220)])
        .onAppear { title = chat.title }
    }
}

struct FileReaderView: View {
    let file: OpenFile
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var source = false

    var body: some View {
        let html = fileEngineFor(file.path) == .html
        NavigationStack {
            Group {
                if file.loading {
                    ProgressView()
                } else if let e = file.error {
                    ContentUnavailableView(e, systemImage: "doc.questionmark")
                } else if let data = file.image, let img = UIImage(data: data) {
                    ScrollView([.vertical, .horizontal]) {
                        Image(uiImage: img).resizable().scaledToFit().padding()
                    }
                } else if file.image != nil {
                    ContentUnavailableView("couldn't show this image", systemImage: "photo")
                } else if let text = file.text, html, !source {
                    HTMLView(html: text).ignoresSafeArea(edges: .bottom)
                } else if let text = file.text {
                    ScrollView([.vertical, .horizontal]) {
                        switch fileEngineFor(file.path) {
                        case .markdown:
                            MarkdownView(text: text).padding().frame(maxWidth: 700)
                        case .code, .text, .html, .image:
                            Text(text).jepFont(13, design: .monospaced).textSelection(.enabled).padding().fixedSize()
                        }
                    }
                    .defaultScrollAnchor(.topLeading)
                    .environment(\.openURL, OpenURLAction { url in
                        if let p = localLinkPath(url) {
                            chat.openFile(p)
                            return .handled
                        }
                        return .systemAction
                    })
                }
            }
            .navigationTitle((file.path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if html, file.text != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button(source ? "Page" : "Source", systemImage: source ? "doc.richtext" : "chevron.left.forwardslash.chevron.right") { source.toggle() }
                    }
                }
                if let text = file.text {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: text) { Image(systemName: "square.and.arrow.up") }
                    }
                }
            }
        }
    }
}

/// an HTML file drawn as a page, with no origin and no file access; a tapped
/// link leaves for the browser rather than navigating away from the file
struct HTMLView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator(html: html) }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.navigationDelegate = context.coordinator
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let html: String
        init(html: String) { self.html = html }

        // a page whose web process died (or never started) draws blank; load it again
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.loadHTMLString(html, baseURL: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

struct TerminalView: View {
    let chat: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var frame = ""
    @State private var input = ""

    private let keys: [(String, String)] = [("C-c", "Ctrl-C"), ("Tab", "Tab"), ("Up", "↑"), ("Down", "↓"), ("Escape", "Esc"), ("BSpace", "⌫")]

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                ScrollViewReader { proxy in
                    ScrollView([.vertical, .horizontal]) {
                        Text(frame).jepFont(12, design: .monospaced).foregroundStyle(.green).textSelection(.enabled).padding(8).fixedSize().id("frame")
                    }
                    .background(Color.black, in: RoundedRectangle(cornerRadius: 12))
                    .onChange(of: frame) { _, _ in proxy.scrollTo("frame", anchor: .bottomLeading) }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(keys, id: \.0) { key, label in
                            Button(label) { Task { await chat.termKey(key) } }.glassButton()
                        }
                    }
                }
                HStack {
                    TextField("Input", text: $input)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(.body, design: .monospaced))
                        .onSubmit(submit)
                        .padding(10)
                        .glassCapsule()
                    Button("Enter", action: submit).glassProminentButton()
                }
            }
            .padding()
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task {
            await chat.termOpen()
            while !Task.isCancelled {
                frame = await chat.termFrame()
                try? await Task.sleep(nanoseconds: 700_000_000)
            }
        }
        .onDisappear { Task { await chat.termClose() } }
    }

    private func submit() {
        let text = input
        input = ""
        Task {
            if !text.isEmpty { await chat.termInput(text) }
            await chat.termKey("Enter")
        }
    }
}

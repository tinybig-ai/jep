import JepKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum ChatSheet: String, Identifiable {
    case model, agent, settings, usage, diff, git, subagents, rename, terminal
    var id: String { rawValue }
}

struct ChatView: View {
    @Environment(AppStore.self) private var app
    let chat: ChatStore
    @State private var status = StatusSummary()
    @State private var quote: String?
    @State private var sheet: ChatSheet?
    @State private var deleteOpen = false
    @State private var sendHowOpen = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var photosOpen = false
    @State private var filesOpen = false
    @State private var editing: Queued?
    @State private var editText = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        let st = chat.state
        let rows = displayRows(st)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if st.hasMore {
                        Button {
                            chat.loadOlder()
                        } label: {
                            if st.loadingOlder { ProgressView().accessibilityLabel("loading earlier messages") } else { Text("Load earlier").jepFont(13) }
                        }
                        .frame(maxWidth: .infinity)
                        .onAppear { chat.loadOlder() }
                    }
                    ForEach(rows) { row in
                        RowView(row: row, chat: chat, liveId: st.live?.messageId, onQuote: setQuote)
                            .id(row.id)
                    }
                    Color.clear.frame(height: 1).id("end-sentinel")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await chat.refresh().value }
            .overlay {
                if st.loadingHistory && st.messages.isEmpty { ProgressView().accessibilityLabel("loading conversation") }
            }
            .onChange(of: rows.last?.id) { _, _ in
                withAnimation(.snappy) { proxy.scrollTo("end-sentinel", anchor: .bottom) }
                Task {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    proxy.scrollTo("end-sentinel", anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { banners(st) }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottom(st) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar(st) }
        .environment(\.openURL, OpenURLAction { url in
            if let path = localLinkPath(url) {
                chat.openFile(path)
                return .handled
            }
            return .systemAction
        })
        .onChange(of: statusSummary(st)) { _, now in status = retainStatus(status, now) }
        .onAppear {
            status = retainStatus(status, statusSummary(st))
            chat.loadModels()
            chat.loadHarnessSettings(quiet: true)
        }
        .sheet(item: $sheet) { s in sheetView(s) }
        .sheet(item: Binding(get: { chat.state.openFile.map { IdentifiedFile(file: $0) } }, set: { if $0 == nil { chat.closeFile() } })) { f in
            FileReaderView(file: f.file, chat: chat)
        }
        .alert("Delete this conversation?", isPresented: $deleteOpen) {
            Button("Delete", role: .destructive) {
                Task { if await chat.delete() { app.back(); app.refresh() } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Send how?", isPresented: $sendHowOpen, titleVisibility: .visible) {
            Button("Steer in") { send(.steer) }
            Button("After this reply") { send(.afterReply) }
            Button("Send now", role: .destructive) { send(.now) }
        } message: {
            Text("The agent is busy. Steer in lands at its next tool call; Send now stops the running reply and sends next.")
        }
        .alert("Edit queued message", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            TextField("Message", text: $editText)
            Button("Save") {
                if let q = editing { chat.editQueued(id: q.id, text: editText) }
                editing = nil
            }
            Button("Cancel", role: .cancel) { editing = nil }
        }
        .photosPicker(isPresented: $photosOpen, selection: $photos, maxSelectionCount: 6, matching: .images)
        .onChange(of: photos) { _, items in attachPhotos(items) }
        .fileImporter(isPresented: $filesOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            attachFiles((try? result.get()) ?? [])
        }
    }

    // MARK: transcript

    private func displayRows(_ st: ChatState) -> [Row] {
        let served = renderableMessages(st.messages)
        var rendered = served
        if let live = liveAsMessage(st.live) {
            if let i = served.firstIndex(where: { $0.id == live.id }) { rendered[i] = live } else { rendered.append(live) }
        }
        let rows = groupToolRuns(transcriptRows(rendered.reversed(), ask: st.ask, askAt: st.askAt, liveMessageId: st.live?.messageId, askAfter: st.askAfter, past: st.pastAsks))
        return rows.reversed()
    }

    private func setQuote(_ q: String) {
        quote = q
        composerFocused = true
    }

    // MARK: chrome

    @ToolbarContentBuilder
    private func toolbar(_ st: ChatState) -> some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Button { sheet = .rename } label: {
                VStack(spacing: 1) {
                    Text(chat.title.isEmpty ? "Untitled" : chat.title).jepFont(15, .semibold).lineLimit(1)
                    let line = statusText(status)
                    if !line.isEmpty { Text(line).jepFont(11).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
            .buttonStyle(.plain)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Model", systemImage: "cpu") { sheet = .model }
                Button("Agent", systemImage: "person.crop.circle") { sheet = .agent }
                Button("Settings", systemImage: "slider.horizontal.3") { sheet = .settings }
                Button("Usage", systemImage: "chart.bar") { sheet = .usage }
                Button("Changes", systemImage: "plusminus") { sheet = .diff }
                Button("Git", systemImage: "arrow.triangle.branch") { sheet = .git }
                Button("Subagents", systemImage: "person.2") { sheet = .subagents }
                if app.prefs.terminalEnabled {
                    Button("Terminal", systemImage: "apple.terminal") { sheet = .terminal }
                }
                Divider()
                if st.harnessSettings.canCompact {
                    Button("Compact", systemImage: "arrow.down.right.and.arrow.up.left") { chat.compact() }.disabled(st.sending || st.compacting)
                }
                Button("Rename", systemImage: "pencil") { sheet = .rename }
                Button("Copy session id", systemImage: "number") { UIPasteboard.general.string = chat.sessionId }
                Button("Delete conversation", systemImage: "trash", role: .destructive) { deleteOpen = true }
            } label: {
                Image(systemName: "ellipsis.circle").accessibilityLabel("chat menu")
            }
        }
    }

    @ViewBuilder
    private func banners(_ st: ChatState) -> some View {
        VStack(spacing: 6) {
            if st.lost {
                Label("Reconnecting…", systemImage: "wifi.exclamationmark").jepFont(13).padding(.horizontal, 14).padding(.vertical, 8).glassCapsule()
            }
            if st.compacting {
                Label("Compacting…", systemImage: "arrow.down.right.and.arrow.up.left").jepFont(13).padding(.horizontal, 14).padding(.vertical, 8).glassCapsule()
            }
            if let text = st.failure ?? st.notice {
                HStack(alignment: .top) {
                    Text(text).jepFont(13).foregroundStyle(st.failure != nil ? .red : .primary)
                    Spacer()
                    Button { chat.dismissBanner() } label: { Image(systemName: "xmark") }.accessibilityLabel("dismiss")
                }
                .padding(12)
                .glassCard(14)
            }
        }
        .padding(.horizontal)
        .animation(.snappy, value: st.lost)
    }

    @ViewBuilder
    private func bottom(_ st: ChatState) -> some View {
        VStack(spacing: 8) {
            ForEach(st.queued, id: \.id) { q in
                HStack(spacing: 8) {
                    Image(systemName: q.mode == .afterReply ? "clock" : "arrow.turn.down.right").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Queued · " + (q.mode == .afterReply ? "after this reply" : q.mode == .now ? "now" : "steer")).jepFont(11).foregroundStyle(.secondary)
                        Text(q.text).jepFont(14).lineLimit(2)
                    }
                    Spacer()
                    Menu {
                        Button("Edit", systemImage: "pencil") { editText = q.text; editing = q }
                        Button("Send now", systemImage: "bolt") { chat.forceSendQueued(id: q.id) }
                        Button("Cancel it", systemImage: "xmark", role: .destructive) { chat.cancelQueued(id: q.id) }
                    } label: {
                        Image(systemName: "ellipsis").padding(6)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .glassCard(14)
            }
            if !st.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(st.attachments, id: \.id) { a in
                            HStack(spacing: 6) {
                                AttachmentThumb(attachment: a)
                                Text(a.name).jepFont(12).lineLimit(1)
                                Button { chat.removeAttachment(id: a.id) } label: { Image(systemName: "xmark.circle.fill") }
                            }
                            .padding(6)
                            .glassCapsule()
                        }
                    }
                }
            }
            if let quote {
                HStack {
                    QuoteChip(text: quote)
                    Button { self.quote = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("cancel reply")
                }
            }
            composer(st)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private func composer(_ st: ChatState) -> some View {
        let sendable = canSend(st.ask, st.askChoice)
        let hasText = !st.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !st.attachments.isEmpty
        return HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button("Photo", systemImage: "photo") { photosOpen = true }
                Button("File", systemImage: "doc") { filesOpen = true }
            } label: {
                Image(systemName: "plus").font(.system(size: 18, weight: .semibold)).frame(width: 40, height: 40).glass(Circle())
            }
            .accessibilityLabel("attach")
            TextField(st.ask != nil && !sendable ? "Waiting for your answer" : "Message the agent", text: Binding(get: { chat.state.draft }, set: { chat.setDraft($0) }), axis: .vertical)
                .lineLimit(1...8)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassCard(20)
                .accessibilityLabel("composer")
            if (st.sending || st.live != nil) && !hasText {
                Button { chat.stop() } label: {
                    Image(systemName: "stop.fill").frame(width: 40, height: 40).glass(Circle())
                }
                .accessibilityLabel("stop")
            } else {
                Button {
                    if st.sending { sendHowOpen = true } else { send(.steer) }
                } label: {
                    Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 40, height: 40).background(Circle().fill(hasText && sendable ? Color.accentColor : Color.gray))
                }
                .disabled(!hasText || !sendable)
                .accessibilityLabel("send")
            }
        }
    }

    private func send(_ mode: SendMode) {
        chat.send(chat.state.draft, mode: mode, quote: quote)
        quote = nil
    }

    // MARK: attachments

    private func attachPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        for item in items {
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                let type = item.supportedContentTypes.first ?? .jpeg
                let name = "photo-\(UUID().uuidString.prefix(8)).\(type.preferredFilenameExtension ?? "jpg")"
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                try? data.write(to: url)
                chat.attach(filename: name, bytes: data, localURL: url.absoluteString, mimeType: type.preferredMIMEType)
            }
        }
    }

    private func attachFiles(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            chat.attach(filename: url.lastPathComponent, bytes: data, localURL: nil, mimeType: mime)
        }
    }

    // MARK: sheets

    @ViewBuilder
    private func sheetView(_ s: ChatSheet) -> some View {
        switch s {
        case .model: ModelSheet(chat: chat)
        case .agent: AgentSheet(chat: chat)
        case .settings: ChatSettingsSheet(chat: chat)
        case .usage: UsageSheet(chat: chat)
        case .diff: DiffSheet(chat: chat)
        case .git: GitSheet(chat: chat)
        case .subagents: SubagentsSheet(chat: chat)
        case .rename: RenameSheet(chat: chat)
        case .terminal: TerminalView(chat: chat)
        }
    }
}

struct IdentifiedFile: Identifiable {
    let file: OpenFile
    var id: String { file.path }
}

struct AttachmentThumb: View {
    let attachment: Attachment
    var body: some View {
        if let s = attachment.localURL, let url = URL(string: s), let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
            Image(uiImage: img).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: "doc").frame(width: 28, height: 28)
        }
    }
}

// MARK: rows

struct RowView: View {
    let row: Row
    let chat: ChatStore
    var liveId: String?
    var onQuote: (String) -> Void

    var body: some View {
        switch row {
        case .msg(let m, let cards):
            MessageRow(message: m, chat: chat, streaming: m.id == liveId, cards: cards, onQuote: onQuote)
        case .pending(let ask):
            AskCard(ask: ask, chat: chat, spent: askIsSpent(chat.state.ask, chat.state.askChoice) && chat.state.ask?.id == ask.id, choice: chat.state.ask?.id == ask.id ? chat.state.askChoice : nil)
        case .pastAsk(let entry):
            AskCard(ask: entry.ask, chat: chat, spent: true, choice: entry.choice)
        case .tools(let calls):
            ToolGroupView(tools: calls, chat: chat)
        case .compaction:
            Divider().overlay(Text("compaction complete").jepFont(11).foregroundStyle(.secondary).padding(.horizontal, 8).background(.background))
                .padding(.vertical, 8)
        case .autoContinue:
            Label("continued automatically", systemImage: "arrow.forward.circle").jepFont(11).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }
    }
}

struct AskCard: View {
    let ask: Ask
    let chat: ChatStore
    let spent: Bool
    let choice: String?
    @State private var picks: [Int: String] = [:]

    var body: some View {
        let multi = ask.questions.count > 1
        let chosen = spent ? parsePicked(choice) : picks
        VStack(alignment: .leading, spacing: 10) {
            Label(ask.kind == "question" ? "Waiting for your answer" : "Waiting for your approval", systemImage: "questionmark.bubble")
                .jepFont(11)
                .foregroundStyle(.secondary)
            Text(ask.title).jepFont(15, .semibold)
            if !multi, let d = ask.detail { Text(d).jepFont(13, design: .monospaced).foregroundStyle(.secondary) }
            if multi {
                ForEach(Array(ask.questions.enumerated()), id: \.offset) { qi, q in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(q.title).jepFont(14)
                        if let d = q.detail { Text(d).jepFont(12, design: .monospaced).foregroundStyle(.secondary) }
                        choices(q.options, chosen[qi]) { pick(qi, $0) }
                    }
                }
            } else {
                choices(ask.options, choice) { chat.respond(askId: ask.id, optionId: $0.id) }
            }
            if ask.kind == "question" {
                Button("Something else") { chat.spendAsk(askId: ask.id) }
                    .glassButton()
                    .disabled(spent)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .opacity(spent ? 0.7 : 1)
    }

    private func pick(_ qi: Int, _ option: AskOption) {
        guard !spent else { return }
        picks[qi] = option.id
        if ask.questions.indices.allSatisfy({ picks[$0] != nil }) {
            chat.respond(askId: ask.id, optionId: encodePicked(count: ask.questions.count, picks: picks))
        }
    }

    private func choices(_ options: [AskOption], _ picked: String?, _ tap: @escaping (AskOption) -> Void) -> some View {
        FlowLayout(spacing: 8) {
            ForEach(options) { o in
                let on = picked == o.id
                Button {
                    tap(o)
                } label: {
                    HStack(spacing: 4) {
                        if on { Image(systemName: "checkmark") }
                        Text(o.label)
                    }
                    .jepFont(14)
                    .foregroundStyle(o.danger ? .red : .primary)
                }
                .glassButton()
                .tint(on ? .accentColor : nil)
                .disabled(spent && !on)
            }
        }
    }
}

/// wraps its children onto as many lines as they need
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            line = max(line, size.height)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

import JepKit
import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    let chat: ChatStore
    var streaming = false
    var cards: [String: [Row]] = [:]
    var onQuote: (String) -> Void
    @State private var drag: CGFloat = 0

    var body: some View {
        Group {
            if message.role == .user { user } else { assistant }
        }
        .offset(x: drag)
        .gesture(
            DragGesture(minimumDistance: 20)
                .onChanged { v in if v.translation.width > 0 && abs(v.translation.height) < 30 { drag = min(v.translation.width, 80) } }
                .onEnded { _ in
                    if drag > 60, let q = quoteOf(message) { onQuote(q) }
                    withAnimation(.snappy) { drag = 0 }
                }
        )
        .contextMenu { menu }
    }

    @ViewBuilder
    private var menu: some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = messageText(message) }
        if message.role == .assistant {
            Button("Copy response", systemImage: "doc.on.clipboard") { UIPasteboard.general.string = fullTurnText(message) }
            ForEach(Array(codeBlocks(messageText(message)).enumerated()), id: \.offset) { i, code in
                Button("Copy code \(i + 1)", systemImage: "curlybraces") { UIPasteboard.general.string = code }
            }
        }
        if let q = quoteOf(message) {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { onQuote(q) }
        }
    }

    private var user: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                    switch part {
                    case .quote(let q):
                        QuoteChip(text: q)
                    case .file(let f):
                        FileView(file: f, chat: chat)
                    case .text(let t):
                        MarkdownView(text: t, flat: true)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    default:
                        EmptyView()
                    }
                }
                if message.undelivered {
                    Button {
                        chat.retrySend(id: message.id)
                    } label: {
                        Label("Not sent — tap to retry", systemImage: "exclamationmark.circle").jepFont(12)
                    }
                    .foregroundStyle(.red)
                }
            }
        }
    }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 8) {
            let last = message.parts.last { if case .unsupported = $0 { false } else { true } }
            ForEach(Array(collapseTranscript(message.parts, keep: Set(cards.keys)).enumerated()), id: \.offset) { _, row in
                switch row {
                case .group(let parts):
                    WorkView(parts: parts, chat: chat, active: streaming && parts.last == last)
                case .one(let part):
                    PartView(part: part, chat: chat, streaming: streaming, cards: cards)
                }
            }
            if let e = message.error {
                Label(e, systemImage: "exclamationmark.triangle").jepFont(13).foregroundStyle(.red)
            }
            if !streaming, let d = message.durationMs, d > 0 {
                Text([message.model?.split(separator: "/").last.map(String.init), "Took \(fmtDuration(d))", message.cost.map(fmtMoney)].compactMap { $0 }.joined(separator: " · "))
                    .jepFont(11)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PartView: View {
    let part: ChatPart
    let chat: ChatStore
    var streaming = false
    var cards: [String: [Row]] = [:]

    var body: some View {
        switch part {
        case .text(let t):
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text: t)
                let images = linkedImages(t)
                if !images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(images, id: \.self) { p in
                                FileView(file: FilePart(path: p, name: (p as NSString).lastPathComponent, mimeType: nil), chat: chat)
                            }
                        }
                    }
                }
            }
        case .quote(let q):
            QuoteChip(text: q)
        case .reasoning(let t, let ms):
            ReasoningView(text: t, durationMs: ms, streaming: streaming)
        case .tool(let call):
            VStack(alignment: .leading, spacing: 6) {
                ToolView(tool: call, chat: chat)
                if let id = call.id, let rows = cards[id] {
                    ForEach(rows) { RowView(row: $0, chat: chat, onQuote: { _ in }) }
                }
            }
        case .file(let f):
            FileView(file: f, chat: chat)
        case .compaction, .autoContinue, .loopTurn, .unsupported:
            EmptyView()
        }
    }
}

struct QuoteChip: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 3)
            Text(text).jepFont(13).foregroundStyle(.secondary).lineLimit(6)
        }
        .padding(8)
        .glassCard(12)
    }
}

struct ReasoningView: View {
    let text: String
    let durationMs: Int64?
    var streaming = false
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Text(text).jepFont(14).foregroundStyle(.secondary).textSelection(.enabled)
                .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } }
        } label: {
            Label(label, systemImage: "brain").jepFont(13).foregroundStyle(.secondary)
        }
    }

    private var label: String {
        if let ms = durationMs, ms > 0 { return "Thought for \(max(1, ms / 1000))s" }
        return streaming ? "Thinking" : "Thought"
    }
}

struct ToolView: View {
    let tool: ToolCall
    let chat: ChatStore
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(toolTitle(tool) ?? tool.name).jepFont(13, design: .monospaced).lineLimit(1).truncationMode(.middle)
                    if let a = tool.added, let r = tool.removed, a + r > 0 {
                        Text("+\(a)").jepFont(12).foregroundStyle(.green)
                        Text("-\(r)").jepFont(12).foregroundStyle(.red)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            if open {
                if !toolShownImages(tool).isEmpty {
                    let shown = toolShownImages(tool)
                    ForEach(shown, id: \.self) { image in
                        FileView(file: FilePart(path: image, name: (image as NSString).lastPathComponent, mimeType: nil), chat: chat, siblings: shown)
                    }
                } else if let image = toolImagePath(tool) {
                    FileView(file: FilePart(path: image, name: (image as NSString).lastPathComponent, mimeType: nil), chat: chat)
                } else if let diff = tool.diff, !diff.isEmpty {
                    DiffText(diff: diff)
                } else if let body = toolBody(tool) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(body).jepFont(12, design: .monospaced).textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
                    }
                    .frame(maxHeight: 320)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .glassCard(12)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch tool.status {
        case .running, .pending: ProgressView().controlSize(.mini)
        case .error: Image(systemName: "xmark.circle").foregroundStyle(.red)
        default: Image(systemName: "wrench.and.screwdriver").foregroundStyle(.secondary)
        }
    }
}

/// The pictures a call showed the person (jep-show, the jep_show tool): the gateway names them
/// in `shown`, so the app reads no command line and no harness's tool name.
private func toolShownImages(_ tool: ToolCall) -> [String] {
    guard tool.status != .error else { return [] }
    return tool.shown.filter { isImagePart(FilePart(path: $0, name: ($0 as NSString).lastPathComponent, mimeType: nil)) }
}

/// A read of an image is the image, not "Read image successfully": FileView
/// fetches it through the same authenticated path as any other file part.
private func toolImagePath(_ tool: ToolCall) -> String? {
    guard tool.name.lowercased() == "read", tool.status != .error else { return nil }
    var path: String?
    if let input = tool.input, let data = input.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        for key in ["filePath", "file_path", "path"] {
            if let value = obj[key] as? String, !value.isEmpty { path = value; break }
        }
    }
    if path == nil, let title = toolTitle(tool), !title.hasPrefix("{") { path = title }
    guard let p = path else { return nil }
    let part = FilePart(path: p, name: (p as NSString).lastPathComponent, mimeType: nil)
    return isImagePart(part) ? p : nil
}

struct WorkView: View {
    let parts: [ChatPart]
    var durationMs: Int64?
    let chat: ChatStore
    var active = false
    @State private var open = false

    var body: some View {
        let tools = parts.compactMap(\.toolCall)
        let added = tools.reduce(0) { $0 + ($1.added ?? 0) }
        let removed = tools.reduce(0) { $0 + ($1.removed ?? 0) }
        let running = active || tools.contains { $0.status == .running || $0.status == .pending }
        let failed = tools.contains { $0.status == .error }
        let title = workTitle(parts, durationMs: durationMs, active: running)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text(title).jepFont(13).lineLimit(1)
                        .foregroundStyle(failed ? AnyShapeStyle(.red) : running ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    if added > 0 { Text("+\(added)").jepFont(12, design: .monospaced).foregroundStyle(.green) }
                    if removed > 0 { Text("-\(removed)").jepFont(12, design: .monospaced).foregroundStyle(.red) }
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(open ? "hide this work" : title)
            if open {
                WorkWindow(follow: running, count: parts.count) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in PartView(part: p, chat: chat) }
                }
            }
        }
    }
}

/// a window of limited height over an opened stretch of work; the steps scroll
/// inside it and fade out towards its edges
struct WorkWindow<Content: View>: View {
    var follow: Bool
    var count: Int
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 0
    private let limit: CGFloat = 280
    private let fade: CGFloat = 20

    var body: some View {
        let clipped = height > limit
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    content
                    Color.clear.frame(height: 0).id("work-end")
                }
                .padding(.vertical, clipped ? fade : 0)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(height, limit))
            .mask {
                if clipped {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black, location: fade / limit),
                            .init(color: .black, location: 1 - fade / limit),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                } else {
                    Rectangle()
                }
            }
            .onChange(of: count, initial: true) {
                if follow { proxy.scrollTo("work-end", anchor: .bottom) }
            }
        }
    }
}

struct DiffText: View {
    let diff: String
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .jepFont(12, design: .monospaced)
                        .foregroundStyle(line.hasPrefix("+") ? .green : line.hasPrefix("-") ? .red : line.hasPrefix("@@") ? .blue : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.hasPrefix("+") ? Color.green.opacity(0.08) : line.hasPrefix("-") ? Color.red.opacity(0.08) : .clear)
                }
            }
            .fixedSize()
        }
        .frame(maxHeight: 360)
    }
}

/// images fetched through the port, so the token rides in a header
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()
    func image(_ path: String) -> UIImage? { cache.object(forKey: path as NSString) }
    func put(_ path: String, _ image: UIImage) { cache.setObject(image, forKey: path as NSString) }
}

struct FileView: View {
    let file: FilePart
    let chat: ChatStore
    /// the other pictures shown with this one: tapping opens them all, swipeable
    var siblings: [String] = []
    @State private var image: UIImage?
    @State private var failed = false
    @State private var zoomed = false

    var body: some View {
        if isImagePart(file) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                        .onTapGesture { zoomed = true }
                } else if failed {
                    Label(file.name ?? file.path, systemImage: "photo").foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(width: 120, height: 90)
                }
            }
            .frame(maxWidth: 260, maxHeight: 320)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .task(id: file.path) { await load() }
            .fullScreenCover(isPresented: $zoomed) {
                if siblings.count > 1 { ImageGallery(paths: siblings, start: siblings.firstIndex(of: file.path) ?? 0, chat: chat) }
                else { ImageViewer(image: image) }
            }
        } else {
            Button {
                chat.openFile(file.path)
            } label: {
                Label(file.name ?? (file.path as NSString).lastPathComponent, systemImage: "doc")
                    .jepFont(14)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .glassCapsule()
            }
            .buttonStyle(.plain)
        }
    }

    private func load() async {
        if let local = file.localURL, let url = URL(string: local), let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
            image = img
            return
        }
        // a relative path names a file in this conversation's workspace
        let key = file.path.hasPrefix("/") ? file.path : chat.sessionId + ":" + file.path
        if let cached = ImageCache.shared.image(key) {
            image = cached
            return
        }
        do {
            let data = try await chat.fileBytes(file.path)
            if let img = UIImage(data: data) {
                ImageCache.shared.put(key, img)
                image = img
            } else {
                failed = true
            }
        } catch {
            failed = true
        }
    }
}

struct ImageViewer: View {
    let image: UIImage?
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .scaleEffect(scale)
                    .offset(offset)
                    .onTapGesture(count: 2) { withAnimation { zoom(to: scale > 1 ? 1 : 2.5) } }
                    .gesture(MagnifyGesture()
                        .onChanged { scale = max(1, settledScale * $0.magnification) }
                        .onEnded { _ in withAnimation { zoom(to: min(scale, 5)) } })
                    // a drag pans only a zoomed picture; at normal size it is left
                    // for whatever pages around it (the gallery's swipe)
                    .gesture(DragGesture()
                        .onChanged { d in
                            offset = CGSize(width: settledOffset.width + d.translation.width,
                                            height: settledOffset.height + d.translation.height)
                        }
                        .onEnded { _ in settledOffset = offset },
                        including: scale > 1 ? .all : .none)
            }
            Button { dismiss() } label: { Image(systemName: "xmark").padding(12).glass(Circle()) }
                .padding()
                .accessibilityLabel("dismiss")
        }
    }

    private func zoom(to s: CGFloat) {
        scale = s
        settledScale = s
        if s == 1 {
            offset = .zero
            settledOffset = .zero
        }
    }
}

/// Pictures you can swipe between and pinch into, full screen. Each page is the
/// same zoomable viewer; a drag pans only a zoomed one, so at normal size a
/// swipe goes to the next picture.
struct ImageGallery: View {
    let paths: [String]
    let chat: ChatStore
    @State private var page: Int
    @State private var images: [String: UIImage] = [:]

    init(paths: [String], start: Int, chat: ChatStore) {
        self.paths = paths
        self.chat = chat
        _page = State(initialValue: min(max(0, start), max(0, paths.count - 1)))
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $page) {
                ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                    ImageViewer(image: images[path]).tag(index)
                        .task(id: path) { await load(path) }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            Text("\(page + 1) / \(paths.count)")
                .jepFont(13).foregroundStyle(.white.opacity(0.8)).padding(.bottom, 28)
                .accessibilityLabel("image \(page + 1) of \(paths.count)")
        }
        .background(Color.black.ignoresSafeArea())
    }

    private func load(_ path: String) async {
        let key = path.hasPrefix("/") ? path : chat.sessionId + ":" + path
        if let cached = ImageCache.shared.image(key) {
            images[path] = cached
            return
        }
        if let data = try? await chat.fileBytes(path), let img = UIImage(data: data) {
            ImageCache.shared.put(key, img)
            images[path] = img
        }
    }
}

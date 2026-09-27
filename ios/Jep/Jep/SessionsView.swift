import JepKit
import SwiftUI

struct SessionsView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var archivedOpen = false
    @State private var importOpen = false

    private var shown: [SessionSummary] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return store.sessions }
        return store.sessions.filter {
            $0.title.lowercased().contains(q) || $0.workspace.lowercased().contains(q) || ($0.harness ?? "").lowercased().contains(q)
        }
    }

    var body: some View {
        List {
            ForEach(shown) { s in
                SessionRow(session: s, unread: store.unread.contains(s.id), selected: store.selection.contains(s.id))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if store.selection.isEmpty { store.open(s) } else { store.toggleSelect(s) }
                    }
                    .onLongPressGesture { store.toggleSelect(s) }
                    .swipeActions(edge: .trailing) {
                        Button("Archive", systemImage: "archivebox") { store.archive(s) }.tint(.indigo)
                    }
                    .swipeActions(edge: .leading) {
                        if store.unread.contains(s.id) {
                            Button("Read", systemImage: "envelope.open") { store.markRead(s.id) }.tint(.blue)
                        } else {
                            Button("Unread", systemImage: "envelope.badge") { store.markUnread(s.id) }.tint(.blue)
                        }
                    }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.sessions.isEmpty {
                if store.busy { ProgressView().accessibilityLabel("loading conversations") } else { ContentUnavailableView("No conversations yet", systemImage: "bubble.left.and.bubble.right") }
            }
        }
        .searchable(text: $query)
        .refreshable { await store.refresh()?.value }
        .navigationTitle(store.selection.isEmpty ? "Jep" : "\(store.selection.count) selected")
        .toolbar { toolbar }
        .safeAreaInset(edge: .bottom) { bottomBar }
        .sheet(isPresented: $archivedOpen) { ArchivedSheet() }
        .sheet(isPresented: $importOpen) { ImportSheet() }
        .alert(store.notice ?? "", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if store.selection.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Archived", systemImage: "archivebox") { archivedOpen = true }
                    Button("Import external session", systemImage: "square.and.arrow.down") { importOpen = true }
                    Button("Settings", systemImage: "gearshape") { store.openSettings() }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        } else {
            ToolbarItem(placement: .topBarLeading) { Button("Cancel") { store.clearSelection() } }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Mark read", systemImage: "envelope.open") { store.markSelected(read: true) }
                Button("Mark unread", systemImage: "envelope.badge") { store.markSelected(read: false) }
                Button("Archive", systemImage: "archivebox") { store.archiveSelected() }
            }
        }
    }

    @ViewBuilder
    private var bottomBar: some View {
        VStack(spacing: 10) {
            if !store.undo.isEmpty {
                HStack {
                    Text(store.undo.count == 1 ? "Archived" : "Archived \(store.undo.count)").jepFont(14)
                    Spacer()
                    Button("Undo") { store.undoArchive() }.bold()
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassCapsule()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if store.selection.isEmpty {
                Button {
                    store.openNewChat()
                } label: {
                    Label("New conversation", systemImage: "plus").padding(.horizontal, 8).padding(.vertical, 6)
                }
                .glassProminentButton()
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 8)
        .animation(.snappy, value: store.undo.count)
    }
}

struct SessionRow: View {
    let session: SessionSummary
    let unread: Bool
    var selected = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                HarnessAvatar(harness: session.harness)
                if selected {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint).background(Circle().fill(.background))
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.title.isEmpty ? "Untitled" : session.title)
                        .jepFont(16, unread ? .semibold : .regular)
                        .lineLimit(1)
                    if session.active { LiveDot().accessibilityLabel("running") }
                    Spacer()
                    Text(relativeTime(session.updatedAt)).jepFont(12).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Text(subtitle).jepFont(13).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    if unread { Circle().fill(.tint).frame(width: 8, height: 8) }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        let place = session.adapter ?? session.workspace.split(separator: "/").last.map(String.init)
        var parts = [place, session.harness].compactMap { $0 }.filter { !$0.isEmpty }
        if session.subagents > 0 { parts.append("\(session.subagents) subagents") }
        return parts.joined(separator: " · ")
    }
}

struct LiveDot: View {
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(.green)
            .frame(width: 8, height: 8)
            .scaleEffect(pulse ? 1.25 : 0.8)
            .opacity(pulse ? 1 : 0.6)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
            }
    }
}

struct ArchivedSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let list = store.archived {
                    if list.isEmpty {
                        ContentUnavailableView("Nothing archived", systemImage: "archivebox")
                    } else {
                        List(list) { s in
                            SessionRow(session: s, unread: false)
                                .swipeActions { Button("Restore", systemImage: "tray.and.arrow.up") { store.unarchive(s) }.tint(.green) }
                                .contextMenu { Button("Restore", systemImage: "tray.and.arrow.up") { store.unarchive(s) } }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Archived")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
        .onAppear { store.loadArchived() }
    }
}

struct ImportSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var fork: ImportableSession?

    var body: some View {
        NavigationStack {
            Group {
                if let list = store.importable {
                    if list.isEmpty {
                        ContentUnavailableView("Nothing to import", systemImage: "square.and.arrow.down")
                    } else {
                        List(list) { s in
                            Button { fork = s } label: {
                                HStack(spacing: 12) {
                                    HarnessAvatar(harness: s.harness)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(s.title.isEmpty ? s.id : s.title).jepFont(15).lineLimit(1)
                                        Text("\(s.directory) · \(relativeTime(s.updatedAt))").jepFont(12).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } else {
                    VStack(spacing: 8) { ProgressView(); Text("Looking…").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Import external session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
            .alert("Fork to jep?", isPresented: Binding(get: { fork != nil }, set: { if !$0 { fork = nil } }), presenting: fork) { s in
                Button("Fork") {
                    store.importSession(s.id)
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: { s in
                Text("\(s.title) becomes a jep conversation; the original stays where it is.")
            }
        }
        .onAppear { store.loadImportable() }
    }
}

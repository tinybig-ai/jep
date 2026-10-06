import JepKit
import SwiftUI

struct NewChatView: View {
    @Environment(AppStore.self) private var store
    @State private var folderName = ""
    @State private var folderOpen = false

    var body: some View {
        let st = store.newChat
        Form {
            Section {
                TextField("Title (optional)", text: Binding(get: { st.title }, set: { store.setNewTitle($0) }))
            }
            if st.harnesses.count > 1 {
                Section("Harness") {
                    Picker("Harness", selection: Binding(get: { st.harness ?? st.defaultHarness ?? "" }, set: { store.setNewHarness($0) })) {
                        ForEach(st.harnesses, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
            }
            Section("Workspace") {
                Button {
                    store.selectPod()
                } label: {
                    HStack {
                        Image(systemName: "bolt.fill")
                            .frame(width: 24)
                        VStack(alignment: .leading) {
                            Text("Quick conversation").jepFont(15)
                            Text("a throwaway folder — just pick a harness").jepFont(12).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if st.pod { Image(systemName: "checkmark").foregroundStyle(.tint) }
                    }
                }
                .buttonStyle(.plain)
                ForEach(st.workspaces, id: \.self) { w in
                    Button {
                        store.selectWorkspace(w.name, harness: w.harness)
                    } label: {
                        HStack {
                            HarnessAvatar(harness: w.harness)
                            VStack(alignment: .leading) {
                                Text(w.name).jepFont(15)
                                Text(w.pod ? "throwaway" : w.dir).jepFont(12).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            if !st.pod && st.path == nil && st.workspace == w.name { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    store.openBrowse()
                } label: {
                    HStack {
                        Label("Browse folders…", systemImage: "folder")
                        Spacer()
                        if !st.pod, let p = st.path { Text(p).jepFont(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head) }
                    }
                }
            }
            HarnessSettingsSection(
                title: "\((st.harness ?? st.defaultHarness ?? "harness").uppercased()) SETTINGS",
                options: st.harnessOptions,
                values: st.harnessSettings,
                loading: st.loadingHarnessSettings,
                onToggle: { store.setNewHarnessSetting($0, $1) }
            )
            if let e = st.error {
                Section { Text(e).foregroundStyle(.red) }
            }
        }
        .navigationTitle("New conversation")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(st.creating ? "Creating…" : "Create") { store.createConversation() }
                    .disabled(st.creating || st.target == nil)
            }
        }
        .sheet(isPresented: Binding(get: { st.browsing }, set: { if !$0 { store.closeBrowse() } })) {
            BrowseSheet(folderName: $folderName, folderOpen: $folderOpen)
        }
    }
}

struct HarnessSettingsSection: View {
    let title: String
    let options: [HarnessSetting]
    let values: [String: Bool]
    let loading: Bool
    let onToggle: (String, Bool) -> Void

    var body: some View {
        if loading && options.isEmpty {
            Section(title) { HStack { ProgressView(); Text("Loading options…").foregroundStyle(.secondary) } }
        } else if !options.isEmpty {
            Section(title) {
                ForEach(options) { o in
                    Toggle(isOn: Binding(get: { values[o.id] ?? o.defaultValue }, set: { onToggle(o.id, $0) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(o.label).foregroundStyle(o.danger ? .red : .primary)
                            if !o.description.isEmpty { Text(o.description).jepFont(12).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
        }
    }
}

struct BrowseSheet: View {
    @Environment(AppStore.self) private var store
    @Binding var folderName: String
    @Binding var folderOpen: Bool

    var body: some View {
        let st = store.newChat
        NavigationStack {
            List {
                if let b = st.browse {
                    Section {
                        Text(b.cwd).jepFont(12, design: .monospaced).foregroundStyle(.secondary)
                        if b.parent != nil {
                            Button { store.browseUp() } label: { Label("Up", systemImage: "arrow.up") }
                        }
                    }
                    Section {
                        if b.dirs.isEmpty { Text("(no sub-folders here)").foregroundStyle(.secondary) }
                        ForEach(b.dirs, id: \.self) { d in
                            Button {
                                store.browseInto(b.cwd.hasSuffix("/") ? b.cwd + d.name : b.cwd + "/" + d.name)
                            } label: {
                                Label(d.name, systemImage: d.git ? "folder.badge.gearshape" : "folder")
                            }
                        }
                    }
                } else {
                    ProgressView().accessibilityLabel("loading folders")
                }
            }
            .overlay { if st.loadingBrowse && st.browse != nil { ProgressView() } }
            .navigationTitle("Browse folders…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { store.closeBrowse() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("New folder", systemImage: "folder.badge.plus") { folderOpen = true }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button("Use this folder") {
                        if let cwd = st.browse?.cwd { store.selectPath(cwd) }
                    }
                    .glassProminentButton()
                    .disabled(st.browse == nil)
                }
            }
            .alert("New folder", isPresented: $folderOpen) {
                TextField("Folder name", text: $folderName).accessibilityLabel("folder name")
                Button("Create") {
                    store.newFolder(folderName)
                    folderName = ""
                }
                Button("Cancel", role: .cancel) { folderName = "" }
            }
        }
    }
}

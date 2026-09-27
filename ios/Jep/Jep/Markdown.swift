import JepKit
import SwiftUI

// A small block-level Markdown renderer: fences, headings, lists, quotes,
// rules and tables become their own views; everything inline is left to
// Foundation's AttributedString parser. Links to local files arrive already
// rewritten to jep://file by withLocalLinks.

enum MdBlock: Equatable {
    case paragraph(String)
    case heading(Int, String)
    case bullet(String, depth: Int, marker: String)
    case quote(String)
    case code(String, lang: String?)
    case table([String])
    case rule
}

func parseMarkdown(_ source: String) -> [MdBlock] {
    var out: [MdBlock] = []
    var para: [String] = []
    var lines = source.components(separatedBy: "\n")[...]
    func flush() {
        if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))) }
        para = []
    }
    while let line = lines.popFirst() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            flush()
            let fence = String(trimmed.prefix(3))
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var body: [String] = []
            while let l = lines.popFirst() {
                if l.trimmingCharacters(in: .whitespaces).hasPrefix(fence) { break }
                body.append(l)
            }
            out.append(.code(body.joined(separator: "\n"), lang: lang.isEmpty ? nil : lang))
        } else if trimmed.isEmpty {
            flush()
        } else if let level = headingLevel(trimmed) {
            flush()
            out.append(.heading(level, String(trimmed.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces)))
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flush()
            out.append(.rule)
        } else if trimmed.hasPrefix(">") {
            flush()
            var body = [String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)]
            while let next = lines.first, next.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                body.append(String(next.trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                lines = lines.dropFirst()
            }
            out.append(.quote(body.joined(separator: "\n")))
        } else if trimmed.hasPrefix("|") {
            flush()
            var rows = [trimmed]
            while let next = lines.first, next.trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                rows.append(next.trimmingCharacters(in: .whitespaces))
                lines = lines.dropFirst()
            }
            out.append(.table(rows))
        } else if let (marker, rest) = listItem(trimmed) {
            flush()
            let indent = line.prefix { $0 == " " }.count
            out.append(.bullet(rest, depth: indent / 2, marker: marker))
        } else {
            para.append(line)
        }
    }
    flush()
    return out
}

private func headingLevel(_ s: String) -> Int? {
    let hashes = s.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), s.dropFirst(hashes).first == " " else { return nil }
    return hashes
}

private func listItem(_ s: String) -> (String, String)? {
    for m in ["- [ ] ", "- [x] ", "- ", "* ", "+ "] where s.hasPrefix(m) {
        let marker = m.hasPrefix("- [x]") ? "☑" : m.hasPrefix("- [ ]") ? "☐" : "•"
        return (marker, String(s.dropFirst(m.count)))
    }
    if let dot = s.firstIndex(where: { $0 == "." || $0 == ")" }), s[s.startIndex..<dot].allSatisfy(\.isNumber),
       !s[s.startIndex..<dot].isEmpty, s[s.index(after: dot)...].hasPrefix(" ") {
        return (String(s[...dot]), String(s[s.index(dot, offsetBy: 2)...]))
    }
    return nil
}

func inline(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

struct MarkdownView: View {
    let text: String
    var size: CGFloat = 16

    var body: some View {
        let blocks = parseMarkdown(withLocalLinks(text))
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(block)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(_ block: MdBlock) -> some View {
        switch block {
        case .paragraph(let s):
            Text(inline(s)).jepFont(size)
        case .heading(let level, let s):
            Text(inline(s)).jepFont(size + CGFloat(max(0, 4 - level)) * 2 + 1, .semibold)
        case .bullet(let s, let depth, let marker):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).jepFont(size).foregroundStyle(.secondary)
                Text(inline(s)).jepFont(size)
            }
            .padding(.leading, CGFloat(depth) * 14)
        case .quote(let s):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(.tertiary).frame(width: 3)
                Text(inline(s)).jepFont(size).foregroundStyle(.secondary)
            }
        case .code(let s, let lang):
            CodeBlock(code: s, lang: lang)
        case .table(let rows):
            TableBlock(rows: rows)
        case .rule:
            Divider()
        }
    }
}

struct CodeBlock: View {
    let code: String
    var lang: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(lang ?? "code").jepFont(11).foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                } label: {
                    Image(systemName: "doc.on.doc").font(.caption)
                }
                .accessibilityLabel("Copy code")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).jepFont(13, design: .monospaced).fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TableBlock: View {
    let rows: [String]

    var body: some View {
        let cells = rows
            .filter { !$0.replacingOccurrences(of: "|", with: "").allSatisfy { "-: ".contains($0) } }
            .map { row in
                row.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(inline(cell)).jepFont(14, i == 0 ? .semibold : .regular)
                        }
                    }
                    if i == 0 { Divider() }
                }
            }
            .padding(10)
        }
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

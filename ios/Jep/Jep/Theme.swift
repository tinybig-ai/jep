import JepKit
import SwiftUI

// One look for the whole app: Liquid Glass where the OS has it (iOS 26),
// the system's ultra-thin material everywhere else.

extension View {
    @ViewBuilder
    func glass<S: Shape>(_ shape: S) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
        }
        #else
        self.background(.ultraThinMaterial, in: shape)
        #endif
    }

    func glassCapsule() -> some View { glass(Capsule()) }
    func glassCard(_ radius: CGFloat = 18) -> some View { glass(RoundedRectangle(cornerRadius: radius, style: .continuous)) }

    @ViewBuilder
    func glassButton() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
        #else
        self.buttonStyle(.bordered)
        #endif
    }

    @ViewBuilder
    func glassProminentButton() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
        #else
        self.buttonStyle(.borderedProminent)
        #endif
    }
}

/// the person's text-size choice, applied on top of Dynamic Type
private struct TextScaleKey: EnvironmentKey { static let defaultValue: Double = 1 }

extension EnvironmentValues {
    var textScale: Double {
        get { self[TextScaleKey.self] }
        set { self[TextScaleKey.self] = newValue }
    }
}

private struct Scaled: ViewModifier {
    @Environment(\.textScale) private var scale
    let size: CGFloat
    let weight: Font.Weight
    let design: Font.Design
    func body(content: Content) -> some View {
        content.font(.system(size: size * scale, weight: weight, design: design))
    }
}

extension View {
    func jepFont(_ size: CGFloat, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(Scaled(size: size, weight: weight, design: design))
    }
}

extension ThemeMode {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
    var icon: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }
}

struct HarnessAvatar: View {
    let harness: String?
    var body: some View {
        mark
            .foregroundStyle(.secondary)
            .frame(width: 36, height: 36)
            .glass(Circle())
            .accessibilityLabel(harness ?? "harness")
    }

    @ViewBuilder private var mark: some View {
        switch harness {
        case "opencode", "codex", "claude":
            Image("harness-\(harness ?? "")").resizable().scaledToFit().frame(width: 19, height: 19)
        default:
            Image(systemName: "cpu").font(.system(size: 16, weight: .semibold))
        }
    }
}

func relativeTime(_ ms: Int64) -> String {
    guard ms > 0 else { return "" }
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
}

func clockTime(_ ms: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    return Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
}

import AppKit

// The menu-bar mark: an apple, filled while the gateway answers and outlined
// while it does not. Drawn rather than taken from SF Symbols, whose apple.logo
// may not stand in for an app and has no outline form. A template image, so
// the menu bar tints it for light and dark.
private func applePaths() -> (body: NSBezierPath, stem: NSBezierPath, leaf: NSBezierPath) {
    let b = NSBezierPath()
    b.move(to: NSPoint(x: 9, y: 5.6))
    b.curve(to: NSPoint(x: 15.6, y: 6.4), controlPoint1: NSPoint(x: 10.6, y: 4.2), controlPoint2: NSPoint(x: 14.2, y: 3.9))
    b.curve(to: NSPoint(x: 14.2, y: 14.9), controlPoint1: NSPoint(x: 16.9, y: 8.8), controlPoint2: NSPoint(x: 16.2, y: 12.6))
    b.curve(to: NSPoint(x: 10.3, y: 16.2), controlPoint1: NSPoint(x: 12.9, y: 16.4), controlPoint2: NSPoint(x: 11.4, y: 16.9))
    b.curve(to: NSPoint(x: 7.7, y: 16.2), controlPoint1: NSPoint(x: 9.5, y: 15.8), controlPoint2: NSPoint(x: 8.5, y: 15.8))
    b.curve(to: NSPoint(x: 3.8, y: 14.9), controlPoint1: NSPoint(x: 6.6, y: 16.9), controlPoint2: NSPoint(x: 5.1, y: 16.4))
    b.curve(to: NSPoint(x: 2.4, y: 6.4), controlPoint1: NSPoint(x: 1.8, y: 12.6), controlPoint2: NSPoint(x: 1.1, y: 8.8))
    b.curve(to: NSPoint(x: 9, y: 5.6), controlPoint1: NSPoint(x: 3.8, y: 3.9), controlPoint2: NSPoint(x: 7.4, y: 4.2))
    b.close()
    let s = NSBezierPath()
    s.move(to: NSPoint(x: 9, y: 5.6)); s.line(to: NSPoint(x: 9.5, y: 2.4))
    let l = NSBezierPath()
    l.move(to: NSPoint(x: 10.2, y: 3.8))
    l.curve(to: NSPoint(x: 14.2, y: 1.3), controlPoint1: NSPoint(x: 10.9, y: 1.8), controlPoint2: NSPoint(x: 12.9, y: 1.0))
    l.curve(to: NSPoint(x: 10.2, y: 3.8), controlPoint1: NSPoint(x: 13.6, y: 3.0), controlPoint2: NSPoint(x: 12.0, y: 4.1))
    l.close()
    return (b, s, l)
}

func appleIcon(filled: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
        let (body, stem, leaf) = applePaths()
        NSColor.black.set()
        stem.lineWidth = 1.3
        stem.lineCapStyle = .round
        stem.stroke()
        if filled {
            body.fill()
            leaf.fill()
        } else {
            body.lineWidth = 1.3
            body.stroke()
            leaf.lineWidth = 1.1
            leaf.stroke()
        }
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = filled ? "jep: running" : "jep: not running"
    return image
}

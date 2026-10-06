import AppKit

// The menu-bar mark: an apple, filled while the gateway answers and outlined
// while it does not. Drawn rather than taken from SF Symbols, whose apple.logo
// may not stand in for an app and has no outline form. A template image, so
// the menu bar tints it for light and dark. The same mark as the launcher
// icon: wider than a real apple, with a deeper top cleft — squat reads as
// sturdy at 18 points.
private func applePaths() -> (body: NSBezierPath, stem: NSBezierPath, leaf: NSBezierPath) {
    let b = NSBezierPath()
    b.move(to: NSPoint(x: 9, y: 6.01))
    b.curve(to: NSPoint(x: 16.1, y: 6.29), controlPoint1: NSPoint(x: 10.72, y: 4.0), controlPoint2: NSPoint(x: 14.6, y: 3.69))
    b.curve(to: NSPoint(x: 14.6, y: 15.13), controlPoint1: NSPoint(x: 17.5, y: 8.78), controlPoint2: NSPoint(x: 16.74, y: 12.74))
    b.curve(to: NSPoint(x: 10.4, y: 16.69), controlPoint1: NSPoint(x: 13.19, y: 16.69), controlPoint2: NSPoint(x: 11.58, y: 17.21))
    b.curve(to: NSPoint(x: 7.6, y: 16.69), controlPoint1: NSPoint(x: 9.54, y: 16.06), controlPoint2: NSPoint(x: 8.46, y: 16.06))
    b.curve(to: NSPoint(x: 3.4, y: 15.13), controlPoint1: NSPoint(x: 6.42, y: 17.21), controlPoint2: NSPoint(x: 4.81, y: 16.69))
    b.curve(to: NSPoint(x: 1.9, y: 6.29), controlPoint1: NSPoint(x: 1.26, y: 12.74), controlPoint2: NSPoint(x: 0.5, y: 8.78))
    b.curve(to: NSPoint(x: 9, y: 6.01), controlPoint1: NSPoint(x: 3.4, y: 3.69), controlPoint2: NSPoint(x: 7.28, y: 4.0))
    b.close()
    let s = NSBezierPath()
    s.move(to: NSPoint(x: 9.16, y: 5.35)); s.line(to: NSPoint(x: 9.59, y: 1.61))
    let l = NSBezierPath()
    l.move(to: NSPoint(x: 10.29, y: 3.58))
    l.curve(to: NSPoint(x: 14.59, y: 0.98), controlPoint1: NSPoint(x: 11.04, y: 1.5), controlPoint2: NSPoint(x: 13.2, y: 0.67))
    l.curve(to: NSPoint(x: 10.29, y: 3.58), controlPoint1: NSPoint(x: 13.95, y: 2.75), controlPoint2: NSPoint(x: 12.23, y: 3.9))
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

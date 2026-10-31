import Foundation

/// One drawing step of an SVG path, in absolute coordinates.
public enum PathSegment: Equatable, Sendable {
    case move(Double, Double)
    case line(Double, Double)
    case cubic(Double, Double, Double, Double, Double, Double)
    case quad(Double, Double, Double, Double)
    case close
}

/// A harness's brand mark as the daemon serves it: one filled SVG path in a `box` × `box` square.
public struct HarnessMark: Equatable, Sendable {
    public var box: Double
    public var path: String
    public init(box: Double, path: String) {
        self.box = box
        self.path = path
    }
    public var segments: [PathSegment] { SVGPath.parse(path) }
}

/// Reads the `d` attribute of an SVG path (M L H V C S Q T Z, upper and lower case) into absolute
/// segments. An arc is drawn as a straight line to its end: the marks jep serves use none.
public enum SVGPath {
    public static func parse(_ d: String) -> [PathSegment] {
        var out: [PathSegment] = []
        let chars = Array(d.unicodeScalars)
        var i = 0
        var cmd: Character = " "
        var cur = (x: 0.0, y: 0.0), start = (x: 0.0, y: 0.0)
        var lastC: (x: Double, y: Double)? = nil  // last cubic/quad control, for S and T
        var lastCmd: Character = " "

        func skipSeparators() {
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" || chars[i] == "\r" { i += 1 }
        }
        func number() -> Double? {
            skipSeparators()
            let begin = i
            if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 }
            var digits = false, dot = false
            while i < chars.count {
                let c = chars[i]
                if c.properties.numericType != nil, c.value >= 48, c.value <= 57 { digits = true; i += 1 }
                else if c == ".", !dot { dot = true; i += 1 }
                else { break }
            }
            if digits, i < chars.count, chars[i] == "e" || chars[i] == "E" {
                var j = i + 1
                if j < chars.count, chars[j] == "-" || chars[j] == "+" { j += 1 }
                if j < chars.count, chars[j].value >= 48, chars[j].value <= 57 {
                    while j < chars.count, chars[j].value >= 48, chars[j].value <= 57 { j += 1 }
                    i = j
                }
            }
            guard digits else { i = begin; return nil }
            return Double(String(String.UnicodeScalarView(chars[begin..<i])))
        }
        func numbers(_ n: Int) -> [Double]? {
            var v: [Double] = []
            for _ in 0..<n { guard let x = number() else { return nil }; v.append(x) }
            return v
        }

        while true {
            skipSeparators()
            guard i < chars.count else { break }
            let c = Character(chars[i])
            if c.isLetter { cmd = c; i += 1 } else if cmd == " " { break }
            let rel = cmd.isLowercase
            let ox = rel ? cur.x : 0, oy = rel ? cur.y : 0
            switch cmd.uppercased().first! {
            case "M":
                guard let v = numbers(2) else { return out }
                cur = (v[0] + ox, v[1] + oy); start = cur
                out.append(.move(cur.x, cur.y))
                cmd = rel ? "l" : "L"  // further pairs after a move are lines
                lastC = nil
            case "L":
                guard let v = numbers(2) else { return out }
                cur = (v[0] + ox, v[1] + oy); out.append(.line(cur.x, cur.y)); lastC = nil
            case "H":
                guard let v = numbers(1) else { return out }
                cur.x = v[0] + ox; out.append(.line(cur.x, cur.y)); lastC = nil
            case "V":
                guard let v = numbers(1) else { return out }
                cur.y = v[0] + oy; out.append(.line(cur.x, cur.y)); lastC = nil
            case "C":
                guard let v = numbers(6) else { return out }
                out.append(.cubic(v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy, v[4] + ox, v[5] + oy))
                lastC = (v[2] + ox, v[3] + oy); cur = (v[4] + ox, v[5] + oy)
            case "S":
                guard let v = numbers(4) else { return out }
                let r = "CS".contains(lastCmd.uppercased()) ? lastC : nil
                let c1 = r.map { (2 * cur.x - $0.x, 2 * cur.y - $0.y) } ?? (cur.x, cur.y)
                out.append(.cubic(c1.0, c1.1, v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy))
                lastC = (v[0] + ox, v[1] + oy); cur = (v[2] + ox, v[3] + oy)
            case "Q":
                guard let v = numbers(4) else { return out }
                out.append(.quad(v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy))
                lastC = (v[0] + ox, v[1] + oy); cur = (v[2] + ox, v[3] + oy)
            case "T":
                guard let v = numbers(2) else { return out }
                let r = "QT".contains(lastCmd.uppercased()) ? lastC : nil
                let c1 = r.map { (2 * cur.x - $0.x, 2 * cur.y - $0.y) } ?? (cur.x, cur.y)
                out.append(.quad(c1.0, c1.1, v[0] + ox, v[1] + oy))
                lastC = c1; cur = (v[0] + ox, v[1] + oy)
            case "A":
                guard let v = numbers(7) else { return out }
                cur = (v[5] + ox, v[6] + oy); out.append(.line(cur.x, cur.y)); lastC = nil
            case "Z":
                out.append(.close); cur = start; lastC = nil
            default:
                return out
            }
            lastCmd = cmd
            if cmd.uppercased() == "Z" { cmd = " " }
        }
        return out
    }
}

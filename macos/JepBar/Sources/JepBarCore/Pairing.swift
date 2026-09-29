import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// The gateway's row of the daemon's pairing-status.json.
public struct GatewayPairing: Decodable, Equatable {
    public var client: String
    public var code: String?
    public var devices: Int
    public var port: Int?
}

/// Same default as the daemon's launchd install and `npm run pair`.
public func dataHome(_ env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
    if let d = env["JEP_DATA_HOME"], !d.isEmpty { return URL(fileURLWithPath: d) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/jep-tg")
}

public func gatewayPairing(_ json: Data) -> GatewayPairing? {
    (try? JSONDecoder().decode([GatewayPairing].self, from: json))?.first { $0.client == "gateway" }
}

/// What the QR carries: the phone apps open it and pair in one step.
public func pairLink(host: String, port: Int, code: String) -> String? {
    var c = URLComponents()
    c.scheme = "jep"
    c.host = "pair"
    c.queryItems = [URLQueryItem(name: "address", value: "\(host):\(port)"), URLQueryItem(name: "code", value: code)]
    return c.string
}

/// Tailscale first (reachable away from home), then the LAN, never loopback or link-local.
public func rankHosts(_ hosts: [String]) -> [String] {
    func rank(_ h: String) -> Int? {
        let o = h.split(separator: ".").compactMap { Int($0) }
        guard o.count == 4 else { return nil }
        if o[0] == 127 || (o[0] == 169 && o[1] == 254) { return nil }
        if o[0] == 100 && (64...127).contains(o[1]) { return 0 }
        if o[0] == 192 && o[1] == 168 { return 1 }
        if o[0] == 10 || (o[0] == 172 && (16...31).contains(o[1])) { return 2 }
        return 3
    }
    var seen = Set<String>()
    return hosts.compactMap { h in rank(h).map { (h, $0) } }
        .filter { seen.insert($0.0).inserted }
        .enumerated()
        .sorted { ($0.element.1, $0.offset) < ($1.element.1, $1.offset) }
        .map { $0.element.0 }
}

/// This machine's IPv4 addresses.
public func localIPv4() -> [String] {
    var out: [String] = []
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0 else { return out }
    defer { freeifaddrs(head) }
    var p = head
    while let ifa = p {
        if let sa = ifa.pointee.ifa_addr, Int32(sa.pointee.sa_family) == AF_INET {
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(MemoryLayout<sockaddr_in>.size), &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                out.append(String(cString: buf))
            }
        }
        p = ifa.pointee.ifa_next
    }
    return out
}

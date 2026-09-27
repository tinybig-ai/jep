import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Splits a text/event-stream byte feed into the `data:` payload of each event.
public struct SSEParser {
    private var buffer = Data()
    private var data: [String] = []

    public init() {}

    /// feed more bytes; returns the payloads of every event they completed
    public mutating func feed(_ chunk: Data) -> [String] {
        buffer.append(chunk)
        var out: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            var lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if lineData.last == 0x0D { lineData = lineData.dropLast() }
            let line = String(decoding: lineData, as: UTF8.self)
            if line.isEmpty {
                if !data.isEmpty { out.append(data.joined(separator: "\n")) }
                data = []
            } else if line.hasPrefix(":") {
                continue
            } else if line.hasPrefix("data:") {
                var v = line.dropFirst(5)
                if v.first == " " { v = v.dropFirst() }
                data.append(String(v))
            }
        }
        return out
    }
}

/// One long-lived /stream connection. Ends with `.lost` on any close or
/// failure so the screen shows staleness instead of pretending.
final class GatewayEventStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private var parser = SSEParser()
    private var continuation: AsyncStream<ChatEvent>.Continuation?
    private var session: URLSession?
    private let lock = NSLock()

    init(request: URLRequest) {
        self.request = request
    }

    func open() -> AsyncStream<ChatEvent> {
        AsyncStream { continuation in
            self.continuation = continuation
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 24 * 3600
            config.timeoutIntervalForResource = 7 * 24 * 3600
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session
            let task = session.dataTask(with: self.request)
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let payloads = parser.feed(data)
        lock.unlock()
        let decoder = JSONDecoder()
        for p in payloads where !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let evt = (try? decoder.decode(EventDto.self, from: Data(p.utf8)))?.toChatEvent() {
                continuation?.yield(evt)
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        continuation?.yield(.lost)
        continuation?.finish()
        session.finishTasksAndInvalidate()
    }
}

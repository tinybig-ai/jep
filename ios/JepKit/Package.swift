// swift-tools-version:5.9
import PackageDescription

// Everything the iOS app knows that is not a screen: the domain, the gateway
// protocol, and the presentation state. Foundation only, so it builds and its
// tests run on Linux as well as on a Mac.
let package = Package(
    name: "JepKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "JepKit", targets: ["JepKit"])],
    targets: [
        .target(name: "JepKit"),
        .testTarget(name: "JepKitTests", dependencies: ["JepKit"]),
    ]
)

// swift-tools-version:5.9
import PackageDescription

// A menu-bar window for the daemon on this Mac: is it up, and a QR to pair a
// phone. JepBarCore is Foundation-only so its tests run on Linux too.
let package = Package(
    name: "JepBar",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "JepBarCore"),
        .executableTarget(name: "JepBar", dependencies: ["JepBarCore"]),
        .testTarget(name: "JepBarCoreTests", dependencies: ["JepBarCore"]),
    ]
)

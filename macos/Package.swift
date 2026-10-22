// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "blackjack-macos",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        // The shared JavaScript engine (../engine, ../agent/env.js) run in JavaScriptCore.
        .library(name: "BlackjackCore", targets: ["BlackjackCore"]),
        // SwiftUI table on top of BlackjackCore.
        .executable(name: "BlackjackApp", targets: ["BlackjackApp"]),
        // Headless self-play: invariant checks and the Swift/Node cross-check.
        .executable(name: "blackjack-selfplay", targets: ["blackjack-selfplay"]),
    ],
    targets: [
        .target(
            name: "BlackjackCore",
            linkerSettings: [.linkedFramework("JavaScriptCore")]
        ),
        .executableTarget(
            name: "BlackjackApp",
            dependencies: ["BlackjackCore"]
        ),
        .executableTarget(
            name: "blackjack-selfplay",
            dependencies: ["BlackjackCore"]
        ),
        .testTarget(
            name: "BlackjackCoreTests",
            dependencies: ["BlackjackCore"]
        ),
    ]
)

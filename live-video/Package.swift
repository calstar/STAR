// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HiDesMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HiDesKit", targets: ["HiDesKit"]),
        .executable(name: "hides", targets: ["hides"]),
        .executable(name: "HiDesViewer", targets: ["HiDesViewer"]),
        .executable(name: "hides-latency", targets: ["hides-latency"]),
    ],
    targets: [
        .systemLibrary(name: "CLibUSB", pkgConfig: "libusb-1.0", providers: [.brew(["libusb"])]),
        .target(
            name: "CIT930x",
            path: "Sources/CIT930x",
            exclude: ["vendor/README.md"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("shim"),
                .headerSearchPath("vendor"),
                .unsafeFlags(["-w", "-std=gnu89", "-include", "linux/kernel.h"]),
            ]
        ),
        .target(name: "HiDesKit", dependencies: ["CIT930x", "CLibUSB"]),
        .executableTarget(name: "hides", dependencies: ["HiDesKit"]),
        .executableTarget(name: "HiDesViewer", dependencies: ["HiDesKit"]),
        .executableTarget(name: "hides-latency", dependencies: ["HiDesKit"]),
        .testTarget(name: "HiDesKitTests", dependencies: ["HiDesKit"]),
    ]
)

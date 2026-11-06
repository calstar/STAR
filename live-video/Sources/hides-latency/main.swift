import AppKit
import CoreVideo
import HiDesKit
import VideoToolbox

// Measures Mac HDMI out -> HV-320 -> RF -> UT-130 -> decoded frame, on one clock.
// Excludes the receiver's final display step, and includes macOS compositing and HDMI scanout.
// Usage: hides-latency --freq KHZ --bw KHZ [--seconds N] [--keep-windows]

private let patternPeriod: TimeInterval = 0.1

func option(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    exit(1)
}

/// Shared between the pattern timer on the main thread and the decoder callback.
final class Timeline {
    private let lock = NSLock()
    private var sent: [Int: CFTimeInterval] = [:]
    private var seen = Set<Int>()
    private var samples: [Double] = []
    private(set) var rejected = 0

    func recordSent(id: Int, at time: CFTimeInterval) {
        lock.withLock {
            sent[id] = time
            seen.remove(id)
        }
    }

    func recordDecoded(id: Int?, at time: CFTimeInterval) {
        lock.withLock {
            guard let id else {
                rejected += 1
                return
            }
            guard let start = sent[id], !seen.contains(id), time > start else { return }
            seen.insert(id)
            samples.append((time - start) * 1000)
        }
    }

    func drain() -> (samples: [Double], rejected: Int) {
        lock.withLock {
            defer {
                samples = []
                rejected = 0
            }
            return (samples, rejected)
        }
    }
}

final class FrameReader {
    private var session: VTDecompressionSession?
    private var format: CMFormatDescription?
    private let timeline: Timeline

    init(timeline: Timeline) {
        self.timeline = timeline
    }

    func decode(_ sample: CMSampleBuffer) {
        guard let description = CMSampleBufferGetFormatDescription(sample) else { return }
        if session == nil || format.map({ !CMFormatDescriptionEqual($0, otherFormatDescription: description) }) ?? true {
            makeSession(description)
        }
        guard let session else { return }
        let timeline = timeline
        VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [._EnableAsynchronousDecompression], infoFlagsOut: nil) { status, _, image, _, _ in
            let now = CACurrentMediaTime()
            guard status == noErr, let image else { return }
            CVPixelBufferLockBaseAddress(image, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddressOfPlane(image, 0) else { return }
            let id = LatencyPattern.decode(
                luma: base.assumingMemoryBound(to: UInt8.self),
                width: CVPixelBufferGetWidthOfPlane(image, 0),
                height: CVPixelBufferGetHeightOfPlane(image, 0),
                bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(image, 0)
            )
            timeline.recordDecoded(id: id, at: now)
        }
    }

    private func makeSession(_ description: CMFormatDescription) {
        if let session { VTDecompressionSessionInvalidate(session) }
        session = nil
        format = description
        let attributes = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange] as CFDictionary
        var created: VTDecompressionSession?
        guard VTDecompressionSessionCreate(allocator: nil, formatDescription: description, decoderSpecification: nil, imageBufferAttributes: attributes, outputCallback: nil, decompressionSessionOut: &created) == noErr else { return }
        session = created
    }
}

final class PatternWindow {
    private let window: NSWindow
    private var cells: [CALayer] = []

    init(screen: NSScreen) {
        window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.level = .screenSaver
        window.backgroundColor = .black
        window.setFrame(screen.frame, display: true)
        let root = CALayer()
        root.backgroundColor = NSColor.black.cgColor
        let view = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        view.layer = root
        view.wantsLayer = true
        window.contentView = view
        let width = screen.frame.width / CGFloat(LatencyPattern.gridSize)
        let height = screen.frame.height / CGFloat(LatencyPattern.gridSize)
        for index in 0..<16 {
            let cell = CALayer()
            let row = CGFloat(LatencyPattern.gridSize - 1 - index / LatencyPattern.gridSize)
            cell.frame = CGRect(x: CGFloat(index % LatencyPattern.gridSize) * width, y: row * height, width: width, height: height)
            cell.actions = ["backgroundColor": NSNull()]
            root.addSublayer(cell)
            cells.append(cell)
        }
        window.orderFrontRegardless()
    }

    func show(id: Int) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (cell, on) in zip(cells, LatencyPattern.cells(id: id)) {
            cell.backgroundColor = on ? NSColor.white.cgColor : NSColor.black.cgColor
        }
        CATransaction.commit()
        CATransaction.flush()
    }
}

guard let frequency = option("--freq").flatMap(UInt32.init), let bandwidth = option("--bw").flatMap(UInt16.init) else {
    fail("usage: hides-latency --freq KHZ --bw KHZ [--seconds N]")
}
let duration = option("--seconds").flatMap(Int.init) ?? 20

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let external = NSScreen.screens.filter { $0 != NSScreen.main && $0.localizedName != "Color LCD" && !$0.localizedName.contains("Built-in") }
guard let screen = external.first else {
    fail("no external display found. Connect the Mac's HDMI output to the HV-320 and use Extended (not Mirrored) mode.")
}
print("Pattern display: \(screen.localizedName), \(Int(screen.frame.width))x\(Int(screen.frame.height)) at \(screen.maximumFramesPerSecond) Hz")

let timeline = Timeline()
let reader = FrameReader(timeline: timeline)
let pipeline = LivePipeline()
pipeline.audioEnabled = false
pipeline.onVideoSample = { reader.decode($0) }

let receiver: UT130Receiver
do {
    receiver = try UT130Receiver()
    try receiver.initialize()
    try receiver.tune(frequencyKHz: frequency, bandwidthKHz: bandwidth)
    try receiver.startStreaming { pipeline.ingest($0) }
} catch {
    fail("\(error)")
}

let pattern = PatternWindow(screen: screen)
var nextID = 0
var allSamples: [Double] = []
let started = CACurrentMediaTime()

func percentile(_ sorted: [Double], _ fraction: Double) -> Double {
    sorted[min(sorted.count - 1, Int(Double(sorted.count) * fraction))]
}

Timer.scheduledTimer(withTimeInterval: patternPeriod, repeats: true) { _ in
    let id = nextID
    nextID = (nextID + 1) % LatencyPattern.idCount
    pattern.show(id: id)
    timeline.recordSent(id: id, at: CACurrentMediaTime())
}

Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    let (samples, rejected) = timeline.drain()
    let status = try? receiver.status()
    let lock = status?.mpegLocked == true ? "locked" : "NO LOCK"
    let stats = pipeline.stats
    if samples.isEmpty {
        print("\(lock): no readable pattern yet, \(rejected) frames rejected, \(stats.packets) packets")
    } else {
        allSamples += samples
        let sorted = samples.sorted()
        print(String(format: "%@: median %.0f ms, range %.0f to %.0f ms, %d readings, %d rejected", lock, percentile(sorted, 0.5), sorted[0], sorted[sorted.count - 1], samples.count, rejected))
    }
    if CACurrentMediaTime() - started >= Double(duration) {
        receiver.stopStreaming()
        if allSamples.isEmpty {
            print("No readings. Check that the HDMI output reaches the HV-320 and the pattern fills the picture.")
        } else {
            let sorted = allSamples.sorted()
            print(String(format: "RESULT: median %.0f ms, p5 %.0f, p95 %.0f, %d readings", percentile(sorted, 0.5), percentile(sorted, 0.05), percentile(sorted, 0.95), sorted.count))
        }
        exit(0)
    }
}

app.run()

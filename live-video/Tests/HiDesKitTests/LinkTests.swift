import Foundation
import Testing
@testable import HiDesKit

// MARK: Capacity and stream tables

@Test func capacityMatchesStandardTable() {
    // EN 300 744 table A.1, 8 MHz, in Mbit/s.
    let cases: [(LinkModulation, Double)] = [
        (LinkModulation(fft: .k2, constellation: .qam16, guardInterval: .g1_32, codeRate: .r2_3), 16.09),
        (LinkModulation(fft: .k8, constellation: .qpsk, guardInterval: .g1_4, codeRate: .r1_2), 4.98),
        (LinkModulation(fft: .k8, constellation: .qam64, guardInterval: .g1_32, codeRate: .r7_8), 31.67),
    ]
    for (modulation, expected) in cases {
        #expect(abs(modulation.capacityBitsPerSecond(bandwidthKHz: 8000) / 1e6 - expected) < 0.01)
    }
    // Capacity scales with bandwidth.
    let narrow = cases[0].0.capacityBitsPerSecond(bandwidthKHz: 4000)
    #expect(abs(narrow / 1e6 - 16.09 / 2) < 0.01)
}

/// The table captured over the air from the user's HV-320.
let capturedSourceTable: [UInt8] = [
    0x00, 0x77, 0xB0, 0x15, 0xFF, 0xFF, 0xC1, 0x00, 0x00,
    0xCF, 0x05, 0x00, 0x02, 0xD0, 0x00, 0x08, 0xF0, 0x00, 0x00, 0xBB, 0x80, 0x71, 0xB7, 0x03, 0xED,
]

func packet(pid: UInt16, unitStart: Bool, counter: UInt8, payload: [UInt8]) -> [UInt8] {
    var bytes: [UInt8] = [TS.syncByte, (unitStart ? 0x40 : 0) | UInt8(pid >> 8), UInt8(pid & 0xFF), 0x10 | counter] + payload
    bytes += [UInt8](repeating: 0xFF, count: TS.packetSize - bytes.count)
    return bytes
}

@Test func sourceTableGivesInputFormat() {
    let demuxer = TSDemuxer()
    var seen: [SourceInfo] = []
    demuxer.onSourceInfo = { seen.append($0) }
    for counter in 0..<3 {
        packet(pid: 0x77, unitStart: true, counter: UInt8(counter), payload: capturedSourceTable).withUnsafeBufferPointer { demuxer.consume($0) }
    }
    packet(pid: 0x1FFF, unitStart: false, counter: 0, payload: []).withUnsafeBufferPointer { demuxer.consume($0) }
    #expect(seen.count == 1)
    #expect(seen.first == SourceInfo(sectionBody: Array(capturedSourceTable[9..<21])))
    #expect(seen.first?.width == 1280 && seen.first?.height == 720 && seen.first?.audioSampleRate == 48000)
    #expect(demuxer.nullPackets == 1 && demuxer.packetCount == 4)
}

@Test func ratesSeparatePaddingFromPayload() {
    var old = LivePipeline.Stats()
    old.packets = 1000
    old.nullPackets = 400
    var new = old
    new.packets += 10_000
    new.nullPackets += 6_000
    new.videoFrames = 30
    let rates = StreamRates(from: old, to: new, seconds: 1)
    #expect(rates.tsBitsPerSecond == 10_000 * 188 * 8)
    #expect(rates.payloadBitsPerSecond == 4_000 * 188 * 8)
    #expect(rates.framesPerSecond == 30)
}

// MARK: Link monitor

private func locked(_ mpeg: Bool = true) -> ReceiverStatus {
    ReceiverStatus(tpsLocked: true, mpegLocked: mpeg, strengthPercent: 80, qualityPercent: 90, strengthDBm: -50)
}

private let unlocked = ReceiverStatus(tpsLocked: false, mpegLocked: false, strengthPercent: 0, qualityPercent: 0, strengthDBm: -90)

/// Drives a monitor one second at a time, with bytes and frames flowing when `flowing` is true.
private struct MonitorDriver {
    var monitor = LinkMonitor()
    var time: TimeInterval = 0
    var bytes: UInt64 = 0
    var frames: UInt64 = 0

    mutating func step(_ status: ReceiverStatus?, bytesFlowing: Bool = true, framesFlowing: Bool = true, usbFailed: Bool = false) -> LinkAction? {
        time += 1
        if bytesFlowing { bytes += 100_000 }
        if framesFlowing { frames += 30 }
        return monitor.update(LinkSample(time: time, status: status, usbBytes: bytes, usbFailed: usbFailed, videoFrames: frames))
    }
}

@Test func monitorClassifiesEachFailure() {
    var driver = MonitorDriver()
    _ = driver.step(locked())
    #expect(driver.monitor.state == .healthy)
    _ = driver.step(unlocked)
    #expect(driver.monitor.state == .noSignal)
    _ = driver.step(locked(false))
    #expect(driver.monitor.state == .weakSignal)
    _ = driver.step(nil)
    #expect(driver.monitor.state == .noDevice)
    _ = driver.step(locked(), usbFailed: true)
    #expect(driver.monitor.state == .noDevice)

    var stalled = MonitorDriver()
    _ = stalled.step(locked())
    _ = stalled.step(locked(), bytesFlowing: false, framesFlowing: false)
    #expect(stalled.monitor.state == .healthy) // One quiet second is within the stall timeout.
    _ = stalled.step(locked(), bytesFlowing: false, framesFlowing: false)
    #expect(stalled.monitor.state == .noData)

    var noVideo = MonitorDriver()
    _ = noVideo.step(locked())
    _ = noVideo.step(locked(), framesFlowing: false)
    _ = noVideo.step(locked(), framesFlowing: false)
    #expect(noVideo.monitor.state == .noVideo)
}

@Test func transmitterRestartRelocksWithoutRecovery() {
    var driver = MonitorDriver()
    _ = driver.step(locked())
    var actions: [LinkAction] = []
    // Typical HV-320 boot: several seconds of nothing, then lock.
    for _ in 0..<6 { if let action = driver.step(unlocked, bytesFlowing: false, framesFlowing: false) { actions.append(action) } }
    for _ in 0..<3 { if let action = driver.step(locked()) { actions.append(action) } }
    #expect(actions.isEmpty)
    #expect(driver.monitor.state == .healthy)
}

@Test func lostSignalRetunesOnASchedule() {
    var driver = MonitorDriver()
    var retunes: [TimeInterval] = []
    for _ in 0..<40 {
        if driver.step(unlocked, bytesFlowing: false, framesFlowing: false) == .retune { retunes.append(driver.time) }
    }
    // State starts at t=1, so retunes at 1+8, then every 15 s.
    #expect(retunes == [9, 24, 39])
}

@Test func missingDeviceReopensWithBackoff() {
    var driver = MonitorDriver()
    var reopens: [TimeInterval] = []
    for _ in 0..<30 {
        if driver.step(nil) == .reopenDevice { reopens.append(driver.time) }
    }
    // Backoff 1, 2, 4, 8, then capped at 10 s.
    #expect(reopens == [2, 4, 8, 16, 26])
}

@Test func silentPortEscalatesToReopen() {
    var driver = MonitorDriver()
    _ = driver.step(locked())
    var actions: [LinkAction] = []
    for _ in 0..<45 {
        if let action = driver.step(locked(), bytesFlowing: false, framesFlowing: false) {
            actions.append(action)
        }
    }
    #expect(actions.prefix(4) == [.restartStreaming, .restartStreaming, .restartStreaming, .reopenDevice])
}

@Test func missingVideoResynchronizesFirst() {
    var driver = MonitorDriver()
    _ = driver.step(locked())
    var actions: [LinkAction] = []
    for _ in 0..<15 {
        if let action = driver.step(locked(), framesFlowing: false) {
            actions.append(action)
        }
    }
    #expect(actions.first == .resynchronize)
    #expect(actions.dropFirst().allSatisfy { $0 == .restartStreaming })
}

// MARK: Link session against a simulated receiver

private final class FakeReceiver: ReceiverDevice {
    var currentStatus = locked()
    var failStatus = false
    var tunes: [UInt32] = []
    var streams = 0
    var onData: ((UnsafeBufferPointer<UInt8>) -> Void)?
    var diagnostics = UT130Receiver.StreamDiagnostics()

    func initialize() throws {}
    func tune(frequencyKHz: UInt32, bandwidthKHz: UInt16) throws { tunes.append(frequencyKHz) }
    func status() throws -> ReceiverStatus {
        if failStatus { throw HiDesError.usb("gone") }
        return currentStatus
    }
    func modulation() throws -> LinkModulation? { LinkModulation(fft: .k2, constellation: .qam16, guardInterval: .g1_32, codeRate: .r2_3) }
    func startStreaming(onData: @escaping (UnsafeBufferPointer<UInt8>) -> Void) throws {
        streams += 1
        self.onData = onData
    }
    func stopStreaming() { onData = nil }
    var streamDiagnostics: UT130Receiver.StreamDiagnostics { diagnostics }

    /// Sends TS that counts as traffic, with the given number of padding packets.
    func deliver(nullPackets: Int) {
        diagnostics.bytes += UInt64(nullPackets * TS.packetSize)
        let bytes = (0..<nullPackets).flatMap { packet(pid: 0x1FFF, unitStart: false, counter: UInt8($0 & 0xF), payload: []) }
        bytes.withUnsafeBufferPointer { onData?($0) }
    }
}

@Test func sessionReopensAfterUSBDropout() {
    var now: TimeInterval = 0
    var opened: [FakeReceiver] = []
    let pipeline = LivePipeline()
    let session = LinkSession(pipeline: pipeline, frequencyKHz: 1_280_000, bandwidthKHz: 8000, clock: { now }) {
        let device = FakeReceiver()
        opened.append(device)
        return device
    }
    var snapshots: [LinkSnapshot] = []
    session.onSnapshot = { snapshots.append($0) }
    session.connect()
    #expect(opened.count == 1 && opened[0].tunes == [1_280_000] && opened[0].streams == 1)

    now = 1
    opened[0].deliver(nullPackets: 100)
    session.poll()
    #expect(snapshots.last?.modulation != nil)
    #expect(abs((snapshots.last?.capacityBitsPerSecond ?? 0) / 1e6 - 16.09) < 0.01)

    // The cable is pulled: status reads fail and the read loop reports a fatal error.
    opened[0].failStatus = true
    opened[0].diagnostics.fatalError = "LIBUSB_ERROR_NO_DEVICE"
    for second in 2...4 {
        now = TimeInterval(second)
        session.poll()
    }
    #expect(snapshots.contains { $0.state == .noDevice })
    #expect(opened.count == 2)
    #expect(opened[1].tunes == [1_280_000] && opened[1].streams == 1)
    #expect(snapshots.contains { $0.action == .reopenDevice })
}

@Test func sessionRetunesWhenSignalStaysLost() {
    var now: TimeInterval = 0
    let device = FakeReceiver()
    let session = LinkSession(pipeline: LivePipeline(), frequencyKHz: 1_280_000, bandwidthKHz: 8000, clock: { now }) { device }
    session.connect()
    device.currentStatus = unlocked
    for second in 1...10 {
        now = TimeInterval(second)
        session.poll()
    }
    #expect(device.tunes == [1_280_000, 1_280_000])
}

@Test func scanRecordsEachStep() throws {
    let device = FakeReceiver()
    let frequencies = BandScanner.frequencies(fromKHz: 1_270_000, toKHz: 1_290_000, stepKHz: 5000)
    #expect(frequencies == [1_270_000, 1_275_000, 1_280_000, 1_285_000, 1_290_000])
    let points = try BandScanner.scan(device, frequencies: frequencies, bandwidthKHz: 8000, dwell: 0)
    #expect(device.tunes == frequencies)
    #expect(points.map(\.frequencyKHz) == frequencies)
}

@Test func logRowQuotesAndOmitsUnlockedFields() {
    var snapshot = LinkSnapshot()
    snapshot.time = Date(timeIntervalSince1970: 0)
    snapshot.state = .noSignal
    snapshot.status = unlocked
    snapshot.error = "tune failed, retrying"
    let row = LinkLogger.row(snapshot, timeFormat: ISO8601DateFormatter())
    #expect(row.hasPrefix("1970-01-01T00:00:00Z,noSignal,-90,0,0,,,,"))
    #expect(row.hasSuffix(",\"tune failed, retrying\""))
    #expect(row.split(separator: ",", omittingEmptySubsequences: false).count == LinkLogger.header.split(separator: ",").count + 1)
}

@Test func countersRestartingAfterReopenCountAsTraffic() {
    var monitor = LinkMonitor()
    _ = monitor.update(LinkSample(time: 1, status: locked(), usbBytes: 5_000_000, usbFailed: false, videoFrames: 900))
    _ = monitor.update(LinkSample(time: 2, status: nil, usbBytes: 0, usbFailed: false, videoFrames: 900))
    // The new device's counters start again from zero.
    for second in 3...6 {
        _ = monitor.update(LinkSample(time: TimeInterval(second), status: locked(), usbBytes: UInt64(second - 2) * 100_000,
                                      usbFailed: false, videoFrames: 900 + UInt64(second - 2) * 30))
    }
    #expect(monitor.state == .healthy)
}

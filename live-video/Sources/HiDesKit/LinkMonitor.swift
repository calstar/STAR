import Foundation

/// Where the receive chain is failing, from the antenna inwards.
public enum LinkState: String, CaseIterable {
    case connecting
    /// The UT-130 is unplugged, or USB failed.
    case noDevice
    /// No DVB-T signal found: transmitter off, wrong frequency or bandwidth, or out of range.
    case noSignal
    /// A DVB-T signal is present but too weak or noisy to decode.
    case weakSignal
    /// The demod is locked but no TS is arriving over USB.
    case noData
    /// TS arrives but no video frames come out of it.
    case noVideo
    case healthy

    public var title: String {
        switch self {
        case .connecting: return "Connecting"
        case .noDevice: return "No receiver"
        case .noSignal: return "No signal"
        case .weakSignal: return "Signal, can't decode"
        case .noData: return "Locked, no data"
        case .noVideo: return "Locked, no video"
        case .healthy: return "Receiving"
        }
    }
}

/// A recovery step for the link session to carry out.
public enum LinkAction: String {
    /// Close and reopen the USB device, then init, tune and stream again.
    case reopenDevice
    /// Retune the demod to the same channel, which makes it acquire again.
    case retune
    /// Stop and restart the TS port and the USB read loop.
    case restartStreaming
    /// Drop partial TS data in the demuxer and flush the display.
    case resynchronize
}

/// One poll of the receive chain. Counters are running totals; a decrease means they were reset.
public struct LinkSample {
    public var time: TimeInterval
    /// Nil when the device is not open or the status read failed.
    public var status: ReceiverStatus?
    public var usbBytes: UInt64
    public var usbFailed: Bool
    public var videoFrames: UInt64

    public init(time: TimeInterval, status: ReceiverStatus?, usbBytes: UInt64, usbFailed: Bool, videoFrames: UInt64) {
        self.time = time
        self.status = status
        self.usbBytes = usbBytes
        self.usbFailed = usbFailed
        self.videoFrames = videoFrames
    }
}

/// Classifies the link from samples and decides when to try recovering it.
///
/// Pure logic with an injected clock, so every failure path is testable without hardware.
public struct LinkMonitor {
    /// How long data or video may be missing before the link counts as stalled.
    public var stallTimeout: TimeInterval = 2
    /// Time without lock before retuning. A transmitter restart normally relocks well inside this.
    public var retuneAfter: TimeInterval = 8
    public var retuneInterval: TimeInterval = 15
    public var streamRestartAfter: TimeInterval = 3
    public var streamRestartInterval: TimeInterval = 10
    public var maxReopenBackoff: TimeInterval = 10

    public private(set) var state: LinkState = .connecting
    public private(set) var recoveries = 0

    private var lastBytes: UInt64 = 0
    private var lastFrames: UInt64 = 0
    private var lastByteTime: TimeInterval?
    private var lastFrameTime: TimeInterval?
    private var stateSince: TimeInterval = 0
    private var lastActionTime: TimeInterval?
    private var attempts = 0

    public init() {}

    /// Updates the state and returns an action to take now, if any.
    public mutating func update(_ sample: LinkSample) -> LinkAction? {
        let now = sample.time
        // A drop means the counters restarted with a reopened device, so any count is new traffic.
        let bytesMoved = sample.usbBytes > lastBytes || (sample.usbBytes < lastBytes && sample.usbBytes > 0)
        let framesMoved = sample.videoFrames > lastFrames || (sample.videoFrames < lastFrames && sample.videoFrames > 0)
        lastBytes = sample.usbBytes
        lastFrames = sample.videoFrames
        // Stall clocks only run while the demod is locked, when data is expected.
        let expectingData = sample.status?.mpegLocked == true && !sample.usbFailed
        if !expectingData || bytesMoved || lastByteTime == nil { lastByteTime = now }
        if !expectingData || framesMoved || lastFrameTime == nil { lastFrameTime = now }

        let next = classify(sample, now: now)
        if next != state {
            state = next
            stateSince = now
            // Each new failure starts its own escalation.
            attempts = 0
            lastActionTime = nil
        }
        return action(now: now)
    }

    private func classify(_ sample: LinkSample, now: TimeInterval) -> LinkState {
        guard let status = sample.status, !sample.usbFailed else { return .noDevice }
        guard status.tpsLocked else { return .noSignal }
        guard status.mpegLocked else { return .weakSignal }
        if now - (lastByteTime ?? now) >= stallTimeout { return .noData }
        if now - (lastFrameTime ?? now) >= stallTimeout { return .noVideo }
        return .healthy
    }

    private mutating func action(now: TimeInterval) -> LinkAction? {
        let elapsed = now - stateSince
        let sinceAction = lastActionTime.map { now - $0 }
        let chosen: LinkAction?
        switch state {
        case .connecting, .healthy:
            chosen = nil
        case .noDevice:
            let backoff = min(pow(2, Double(attempts)), maxReopenBackoff)
            chosen = (sinceAction ?? elapsed) >= backoff ? .reopenDevice : nil
        case .noSignal, .weakSignal:
            chosen = Self.due(elapsed: elapsed, sinceAction: sinceAction, first: retuneAfter, every: retuneInterval) ? .retune : nil
        case .noData:
            guard Self.due(elapsed: elapsed, sinceAction: sinceAction, first: streamRestartAfter, every: streamRestartInterval) else { return nil }
            // A port that stays silent after repeated restarts usually means the bridge needs a full init.
            chosen = attempts >= 3 ? .reopenDevice : .restartStreaming
        case .noVideo:
            guard Self.due(elapsed: elapsed, sinceAction: sinceAction, first: 0, every: streamRestartInterval) else { return nil }
            chosen = attempts == 0 ? .resynchronize : .restartStreaming
        }
        if chosen != nil {
            attempts += 1
            recoveries += 1
            lastActionTime = now
        }
        return chosen
    }

    private static func due(elapsed: TimeInterval, sinceAction: TimeInterval?, first: TimeInterval, every: TimeInterval) -> Bool {
        if let sinceAction { return sinceAction >= every }
        return elapsed >= first
    }
}

import Foundation

/// Rates over the last poll interval.
public struct StreamRates: Equatable {
    /// Everything the channel carried, null packets included.
    public var tsBitsPerSecond: Double = 0
    /// Packets with content, which is what the encoder actually used.
    public var payloadBitsPerSecond: Double = 0
    public var framesPerSecond: Double = 0

    public init() {}

    public init(from old: LivePipeline.Stats, to new: LivePipeline.Stats, seconds: TimeInterval) {
        guard seconds > 0, new.packets >= old.packets else { return }
        let bitsPerPacket = Double(TS.packetSize * 8)
        let packets = Double(new.packets - old.packets)
        let nulls = Double(new.nullPackets &- old.nullPackets)
        tsBitsPerSecond = packets * bitsPerPacket / seconds
        payloadBitsPerSecond = max(0, packets - nulls) * bitsPerPacket / seconds
        framesPerSecond = Double(new.videoFrames &- old.videoFrames) / seconds
    }
}

/// Everything the dashboard shows, from the receiver alone.
public struct LinkSnapshot {
    public var time = Date()
    public var state: LinkState = .connecting
    public var status: ReceiverStatus?
    public var modulation: LinkModulation?
    public var bandwidthKHz: Int = 0
    public var rates = StreamRates()
    public var stats = LivePipeline.Stats()
    public var serviceName: String?
    public var sourceInfo: SourceInfo?
    public var recoveries = 0
    /// The recovery step taken in this poll, if any.
    public var action: LinkAction?
    public var lastAction: LinkAction?
    public var lastActionTime: Date?
    public var error: String?

    public init() {}

    public var capacityBitsPerSecond: Double? {
        modulation.map { $0.capacityBitsPerSecond(bandwidthKHz: bandwidthKHz) }
    }

    /// Capacity the encoder leaves unused, which bounds how much the video bitrate could rise.
    public var headroomBitsPerSecond: Double? {
        capacityBitsPerSecond.map { max(0, $0 - rates.payloadBitsPerSecond) }
    }
}

/// Runs the receiver: opens, tunes, streams, polls once a second and recovers from failures.
///
/// All device calls happen on one private queue, never the main thread.
public final class LinkSession {
    public let frequencyKHz: UInt32
    public let bandwidthKHz: UInt16
    /// Called on the session queue after every poll.
    public var onSnapshot: ((LinkSnapshot) -> Void)?
    /// Called on the session queue after a recovery step, before streaming resumes.
    public var onRecovery: ((LinkAction) -> Void)?

    private let pipeline: LivePipeline
    private let openDevice: () throws -> ReceiverDevice
    private let queue = DispatchQueue(label: "HiDes link session", qos: .userInitiated)
    private let clock: () -> TimeInterval
    private var timer: DispatchSourceTimer?
    private var device: ReceiverDevice?
    private var monitor = LinkMonitor()
    private var snapshot = LinkSnapshot()
    private var lastStats = LivePipeline.Stats()
    private var lastPoll: TimeInterval?
    private var lastModulationRead: TimeInterval?
    private let namesLock = NSLock()
    private var serviceName: String?
    private var sourceInfo: SourceInfo?

    public init(pipeline: LivePipeline, frequencyKHz: UInt32, bandwidthKHz: UInt16,
                clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                openDevice: @escaping () throws -> ReceiverDevice = { try UT130Receiver() }) {
        self.pipeline = pipeline
        self.frequencyKHz = frequencyKHz
        self.bandwidthKHz = bandwidthKHz
        self.clock = clock
        self.openDevice = openDevice
        snapshot.bandwidthKHz = Int(bandwidthKHz)
        pipeline.onServiceName = { [weak self] name in self?.namesLock.withLock { self?.serviceName = name } }
        pipeline.onSourceInfo = { [weak self] info in self?.namesLock.withLock { self?.sourceInfo = info } }
    }

    deinit {
        timer?.cancel()
    }

    public func start() {
        queue.async { [self] in
            connect()
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(50))
            timer.setEventHandler { [weak self] in self?.poll() }
            self.timer = timer
            timer.resume()
        }
    }

    /// Blocks until the device is closed, so a new session can open it straight away.
    public func stop() {
        queue.sync {
            timer?.cancel()
            timer = nil
            closeDevice()
        }
    }

    /// Opens and starts the device. Failures are left for the monitor to retry.
    func connect() {
        closeDevice()
        do {
            let device = try openDevice()
            self.device = device
            try device.initialize()
            try device.tune(frequencyKHz: frequencyKHz, bandwidthKHz: bandwidthKHz)
            let pipeline = pipeline
            pipeline.resynchronize()
            try device.startStreaming { pipeline.ingest($0) }
            snapshot.error = nil
        } catch {
            closeDevice()
            snapshot.error = "\(error)"
        }
    }

    func poll() {
        let now = clock()
        var status: ReceiverStatus?
        var usbFailed = false
        var usbBytes: UInt64 = 0
        if let device {
            do {
                status = try device.status()
            } catch {
                snapshot.error = "\(error)"
            }
            let diagnostics = device.streamDiagnostics
            usbBytes = diagnostics.bytes
            if let fatal = diagnostics.fatalError {
                usbFailed = true
                snapshot.error = "USB: \(fatal)"
            }
        }
        let stats = pipeline.stats
        let action = monitor.update(LinkSample(time: now, status: status, usbBytes: usbBytes, usbFailed: usbFailed, videoFrames: stats.videoFrames))

        if let status, status.tpsLocked {
            if snapshot.modulation == nil || now - (lastModulationRead ?? 0) >= 5 {
                snapshot.modulation = (try? device?.modulation()) ?? snapshot.modulation
                lastModulationRead = now
            }
        } else {
            snapshot.modulation = nil
        }
        if let lastPoll { snapshot.rates = StreamRates(from: lastStats, to: stats, seconds: now - lastPoll) }
        lastPoll = now
        lastStats = stats
        snapshot.time = Date()
        snapshot.state = monitor.state
        snapshot.status = status
        snapshot.stats = stats
        namesLock.withLock {
            snapshot.serviceName = serviceName
            snapshot.sourceInfo = sourceInfo
        }
        if monitor.state == .healthy { snapshot.error = nil }

        snapshot.action = action
        if let action {
            perform(action)
            snapshot.lastAction = action
            snapshot.lastActionTime = Date()
        }
        snapshot.recoveries = monitor.recoveries
        onSnapshot?(snapshot)
    }

    private func perform(_ action: LinkAction) {
        switch action {
        case .reopenDevice:
            onRecovery?(action)
            connect()
        case .retune:
            do {
                try device?.tune(frequencyKHz: frequencyKHz, bandwidthKHz: bandwidthKHz)
            } catch {
                snapshot.error = "\(error)"
            }
        case .restartStreaming:
            guard let device else { return }
            device.stopStreaming()
            pipeline.resynchronize()
            onRecovery?(action)
            do {
                let pipeline = pipeline
                try device.startStreaming { pipeline.ingest($0) }
            } catch {
                snapshot.error = "\(error)"
            }
        case .resynchronize:
            pipeline.resynchronize()
            onRecovery?(action)
        }
    }

    private func closeDevice() {
        device?.stopStreaming()
        // UT130Receiver keeps global vendor state, so the old one must be gone before reopening.
        device = nil
    }
}

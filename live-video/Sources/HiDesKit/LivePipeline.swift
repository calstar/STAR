import AVFoundation
import Foundation

/// Takes raw TS bytes from any source and drives display, audio and UDP output.
public final class LivePipeline {
    private var aligner = TSAligner()
    private let demuxer = TSDemuxer()
    private let packetizer = H264Packetizer()
    private let audio = AudioPlayer()
    private let lock = NSLock()
    private var output: UDPOutput?
    private var videoFrames: UInt64 = 0

    /// Called on the streaming thread with each decodable video sample.
    public var onVideoSample: ((CMSampleBuffer) -> Void)?
    public var audioEnabled = true
    /// Called on the streaming thread with the name decoded from the broadcast.
    public var onServiceName: ((String) -> Void)? {
        didSet { demuxer.onServiceName = onServiceName }
    }

    /// Called on the streaming thread when the transmitter's source table is first seen or changes.
    public var onSourceInfo: ((SourceInfo) -> Void)? {
        didSet { demuxer.onSourceInfo = onSourceInfo }
    }

    public init() {
        demuxer.onUnit = { [weak self] unit in self?.handle(unit) }
    }

    /// Running totals since the pipeline was created.
    public struct Stats: Equatable {
        public var packets: UInt64 = 0
        public var nullPackets: UInt64 = 0
        public var continuityErrors: UInt64 = 0
        public var transportErrors: UInt64 = 0
        public var videoFrames: UInt64 = 0

        public init() {}
    }

    public var stats: Stats {
        lock.withLock {
            var stats = Stats()
            stats.packets = demuxer.packetCount
            stats.nullPackets = demuxer.nullPackets
            stats.continuityErrors = demuxer.continuityErrors
            stats.transportErrors = demuxer.transportErrors
            stats.videoFrames = videoFrames
            return stats
        }
    }

    /// Drops partial data after an interruption, so the first frames afterwards are not corrupt.
    public func resynchronize() {
        lock.withLock {
            aligner = TSAligner()
            demuxer.resynchronize()
        }
    }

    public func setOutput(_ output: UDPOutput?) {
        lock.withLock { self.output = output }
    }

    public func ingest(_ bytes: UnsafeBufferPointer<UInt8>) {
        lock.withLock {
            aligner.append(bytes) { packet in
                output?.send(packet: packet)
                demuxer.consume(packet)
            }
        }
    }

    private func handle(_ unit: PESUnit) {
        switch unit.kind {
        case .h264:
            videoFrames += 1
            if let sample = packetizer.sampleBuffer(annexB: unit.data, presentationTime: unit.presentationTime) {
                Self.markForImmediateDisplay(sample)
                onVideoSample?(sample)
            }
        case .aac, .mpegAudio:
            if audioEnabled { audio.play(unit) }
        case .other:
            break
        }
    }

    /// Shows frames as they arrive instead of buffering to PTS, which is what keeps latency low.
    private static func markForImmediateDisplay(_ sample: CMSampleBuffer) {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
              CFArrayGetCount(attachments) > 0 else { return }
        let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
        CFDictionarySetValue(
            dictionary,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
            Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
        )
    }
}

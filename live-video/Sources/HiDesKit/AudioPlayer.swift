import AudioToolbox
import Foundation

/// Plays AAC (ADTS) or MPEG audio, which the HV-320 can produce, using AudioFileStream and AudioQueue.
public final class AudioPlayer {
    private static let bufferCount = 8

    private var stream: AudioFileStreamID?
    private var queue: AudioQueueRef?
    private var started = false
    private var kind: ElementaryStreamKind?

    public init() {}

    deinit { stop() }

    public func play(_ unit: PESUnit) {
        guard unit.kind == .aac || unit.kind == .mpegAudio else { return }
        if kind != unit.kind {
            stop()
            kind = unit.kind
            let hint = unit.kind == .aac ? kAudioFileAAC_ADTSType : kAudioFileMP2Type
            let context = Unmanaged.passUnretained(self).toOpaque()
            AudioFileStreamOpen(context, Self.propertyCallback, Self.packetsCallback, hint, &stream)
        }
        guard let stream else { return }
        unit.data.withUnsafeBytes {
            _ = AudioFileStreamParseBytes(stream, UInt32($0.count), $0.baseAddress, [])
        }
    }

    public func stop() {
        if let queue { AudioQueueDispose(queue, true) }
        if let stream { AudioFileStreamClose(stream) }
        queue = nil
        stream = nil
        started = false
        kind = nil
    }

    private func makeQueue() {
        guard let stream else { return }
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout.size(ofValue: format))
        guard AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &format) == noErr else { return }
        AudioQueueNewOutput(&format, { _, queue, buffer in
            AudioQueueFreeBuffer(queue, buffer)
        }, nil, nil, nil, 0, &queue)
    }

    private func enqueue(bytes: UnsafeRawPointer, byteCount: UInt32, packetCount: UInt32, descriptions: UnsafePointer<AudioStreamPacketDescription>?) {
        guard let queue else { return }
        var buffer: AudioQueueBufferRef?
        guard AudioQueueAllocateBufferWithPacketDescriptions(queue, byteCount, packetCount, &buffer) == noErr, let buffer else { return }
        memcpy(buffer.pointee.mAudioData, bytes, Int(byteCount))
        buffer.pointee.mAudioDataByteSize = byteCount
        if let descriptions, let target = buffer.pointee.mPacketDescriptions {
            target.update(from: descriptions, count: Int(packetCount))
            buffer.pointee.mPacketDescriptionCount = packetCount
        }
        AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
        if !started {
            started = AudioQueueStart(queue, nil) == noErr
        }
    }

    private static let propertyCallback: AudioFileStream_PropertyListenerProc = { context, _, property, _ in
        guard property == kAudioFileStreamProperty_ReadyToProducePackets else { return }
        Unmanaged<AudioPlayer>.fromOpaque(context).takeUnretainedValue().makeQueue()
    }

    private static let packetsCallback: AudioFileStream_PacketsProc = { context, byteCount, packetCount, bytes, descriptions in
        Unmanaged<AudioPlayer>.fromOpaque(context).takeUnretainedValue()
            .enqueue(bytes: bytes, byteCount: byteCount, packetCount: packetCount, descriptions: descriptions)
    }
}

import CoreMedia
import Foundation
import Testing
import VideoToolbox
@testable import HiDesKit

/// Needs a sample stream, created with:
/// ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine -t 3 -c:v libx264 -bf 0 -c:a aac -f mpegts FILE
/// Set HIDES_TEST_TS to its path. Skipped otherwise.
@Test(.enabled(if: ProcessInfo.processInfo.environment["HIDES_TEST_TS"] != nil))
func realStreamDemuxesAndHardwareDecodes() throws {
    let path = try #require(ProcessInfo.processInfo.environment["HIDES_TEST_TS"])
    let data = try Data(contentsOf: URL(fileURLWithPath: path))

    let pipeline = LivePipeline()
    pipeline.audioEnabled = false
    var samples: [CMSampleBuffer] = []
    pipeline.onVideoSample = { samples.append($0) }
    data.withUnsafeBytes { raw in
        let bytes = raw.bindMemory(to: UInt8.self)
        // Odd chunk sizes exercise the realignment path.
        var offset = 0
        while offset < bytes.count {
            let end = min(offset + 1013, bytes.count)
            pipeline.ingest(UnsafeBufferPointer(rebasing: bytes[offset..<end]))
            offset = end
        }
    }
    #expect(pipeline.stats.continuityErrors == 0)
    #expect(samples.count >= 85)

    let format = try #require(samples.first.flatMap(CMSampleBufferGetFormatDescription))
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    #expect(dimensions.width == 1280 && dimensions.height == 720)

    var session: VTDecompressionSession?
    #expect(VTDecompressionSessionCreate(allocator: nil, formatDescription: format, decoderSpecification: nil, imageBufferAttributes: nil, outputCallback: nil, decompressionSessionOut: &session) == noErr)
    let decoder = try #require(session)
    var decoded = 0
    for sample in samples {
        VTDecompressionSessionDecodeFrame(decoder, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, _, image, _, _ in
            if status == noErr, image != nil { decoded += 1 }
        }
    }
    VTDecompressionSessionWaitForAsynchronousFrames(decoder)
    #expect(decoded == samples.count)
}

/// Set HIDES_TEST_RX to a capture from the receiver. Early flushing must not split or lose frames.
@Test(.enabled(if: ProcessInfo.processInfo.environment["HIDES_TEST_RX"] != nil))
func liveCaptureFlushesWholeFramesEarly() throws {
    let path = try #require(ProcessInfo.processInfo.environment["HIDES_TEST_RX"])
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let demuxer = TSDemuxer()
    var units: [PESUnit] = []
    demuxer.onUnit = { units.append($0) }
    data.withUnsafeBytes { raw in
        let bytes = raw.bindMemory(to: UInt8.self)
        for start in stride(from: 0, to: bytes.count - TS.packetSize + 1, by: TS.packetSize) {
            demuxer.consume(UnsafeBufferPointer(rebasing: bytes[start..<(start + TS.packetSize)]))
        }
    }
    let video = units.filter { $0.kind == .h264 }
    #expect(video.count > 300)
    // Each unit must begin with a start code and an access unit delimiter.
    #expect(video.allSatisfy { Array($0.data.prefix(5)) == [0, 0, 0, 1, 0x09] || Array($0.data.prefix(4)) == [0, 0, 1, 0x09] })
    #expect(video.allSatisfy { $0.presentationTime != nil })
}

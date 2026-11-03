import CoreMedia
import Foundation

/// Converts Annex B access units into CMSampleBuffers for hardware decode.
public final class H264Packetizer {
    private var sps: Data?
    private var pps: Data?
    private var format: CMVideoFormatDescription?

    public init() {}

    public var formatDescription: CMVideoFormatDescription? { format }

    /// Returns nil until SPS and PPS have been seen.
    public func sampleBuffer(annexB: Data, presentationTime: UInt64?) -> CMSampleBuffer? {
        let units = Self.nalUnits(annexB)
        var parameterSetsChanged = false
        var slices = Data()
        for unit in units {
            guard let header = unit.first else { continue }
            switch header & 0x1F {
            case 7:
                if sps != unit { sps = unit; parameterSetsChanged = true }
            case 8:
                if pps != unit { pps = unit; parameterSetsChanged = true }
            case 1, 5:
                var length = UInt32(unit.count).bigEndian
                withUnsafeBytes(of: &length) { slices.append(contentsOf: $0) }
                slices.append(unit)
            default:
                break
            }
        }
        if parameterSetsChanged { rebuildFormat() }
        guard let format, !slices.isEmpty else { return nil }
        return makeSample(slices, format: format, presentationTime: presentationTime)
    }

    private func rebuildFormat() {
        guard let sps, let pps else { return }
        format = sps.withUnsafeBytes { spsBytes in
            pps.withUnsafeBytes { ppsBytes -> CMVideoFormatDescription? in
                let pointers = [
                    spsBytes.bindMemory(to: UInt8.self).baseAddress!,
                    ppsBytes.bindMemory(to: UInt8.self).baseAddress!,
                ]
                let sizes = [sps.count, pps.count]
                var description: CMVideoFormatDescription?
                let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers,
                    parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &description
                )
                return status == noErr ? description : nil
            }
        }
    }

    private func makeSample(_ data: Data, format: CMVideoFormatDescription, presentationTime: UInt64?) -> CMSampleBuffer? {
        var block: CMBlockBuffer?
        let size = data.count
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: nil, memoryBlock: nil, blockLength: size, blockAllocator: nil, customBlockSource: nil,
            offsetToData: 0, dataLength: size, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
        ) == noErr, let block else { return nil }
        let copied = data.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: size)
        }
        guard copied == noErr else { return nil }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: presentationTime.map { CMTime(value: Int64($0), timescale: 90000) } ?? .invalid,
            decodeTimeStamp: .invalid
        )
        var sampleSize = size
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample
        ) == noErr else { return nil }
        return sample
    }

    /// Splits on 00 00 01 start codes, trimming the zero byte of 4-byte start codes.
    static func nalUnits(_ data: Data) -> [Data] {
        var units: [Data] = []
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let bytes = raw.bindMemory(to: UInt8.self)
            var unitStart: Int?
            var index = 0
            while index + 2 < bytes.count {
                if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
                    if let start = unitStart {
                        let end = index > start && bytes[index - 1] == 0 ? index - 1 : index
                        units.append(Data(bytes[start..<end]))
                    }
                    unitStart = index + 3
                    index += 3
                } else {
                    index += 1
                }
            }
            if let start = unitStart, start < bytes.count {
                units.append(Data(bytes[start...]))
            }
        }
        return units
    }
}

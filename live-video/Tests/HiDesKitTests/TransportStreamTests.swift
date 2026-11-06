import Foundation
import Testing
@testable import HiDesKit

@Test func alignerRecoversFromGarbageAndSplitReads() {
    var stream = [UInt8](repeating: 0x11, count: 50)
    for index in 0..<4 {
        var packet = [UInt8](repeating: UInt8(index), count: TS.packetSize)
        packet[0] = TS.syncByte
        stream += packet
    }
    var aligner = TSAligner()
    var seen: [UInt8] = []
    for chunk in [stream[0..<100], stream[100..<333], stream[333...]] {
        Array(chunk).withUnsafeBufferPointer { buffer in
            aligner.append(buffer) { seen.append($0[1]) }
        }
    }
    // The final packet is held back until the next one confirms sync, or stream end.
    #expect(seen.starts(with: [0, 1, 2]))
}

@Test func nalSplitterHandlesBothStartCodes() {
    let data = Data([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4])
    #expect(H264Packetizer.nalUnits(data) == [Data([0x67, 1, 2]), Data([0x68, 3]), Data([0x65, 4])])
}

@Test func serviceNameComesFromSDT() {
    // table 0x42, one service, descriptor 0x48: type 1, provider "ITE", name "KO6PSD".
    let descriptor: [UInt8] = [0x48, 12, 0x01, 3, 0x49, 0x54, 0x45, 6, 0x4B, 0x4F, 0x36, 0x50, 0x53, 0x44]
    var body: [UInt8] = [0x42, 0xF0, 0, 0, 1, 0xC1, 0, 0, 0, 1, 0xFF, 0, 1, 0xFC, 0x80, UInt8(descriptor.count)]
    body += descriptor + [0, 0, 0, 0]
    body[2] = UInt8(body.count - 3)
    var packet: [UInt8] = [TS.syncByte, 0x40, 0x11, 0x10, 0x00] + body
    packet += [UInt8](repeating: 0xFF, count: TS.packetSize - packet.count)

    let demuxer = TSDemuxer()
    var names: [String] = []
    demuxer.onServiceName = { names.append($0) }
    packet.withUnsafeBufferPointer { demuxer.consume($0) }
    packet.withUnsafeBufferPointer { demuxer.consume($0) }
    #expect(names == ["KO6PSD"])
}

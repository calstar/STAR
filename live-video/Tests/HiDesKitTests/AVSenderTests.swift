import Testing
@testable import HiDesKit

@Test func getCommandMatchesVendorFraming() {
    // Cmd_generalGet: 23 04 seq cmd 00 sum 0D, summing bytes 1 through 4.
    let bytes = AVSenderFrame(sequence: 1, command: AVSenderCommand.getSystemInfo).encoded()
    #expect(bytes == [0x23, 0x04, 0x01, 0x04, 0x00, 0x09, 0x0D])
}

@Test func parserHandlesSplitFramesAndNoise() {
    let frame = AVSenderFrame(sequence: 9, command: 0x80, payload: [1, 2, 3])
    var parser = AVSenderFrameParser()
    let bytes = [0xFF, 0x00] + frame.encoded()
    #expect(parser.append(Array(bytes.prefix(5))).isEmpty)
    #expect(parser.append(Array(bytes.dropFirst(5))) == [frame])
}

@Test func parserRejectsBadChecksumAndRecovers() {
    let good = AVSenderFrame(sequence: 2, command: 0x81, payload: [7]).encoded()
    var bad = good
    bad[bad.count - 2] &+= 1
    var parser = AVSenderFrameParser()
    #expect(parser.append(bad + good) == [AVSenderFrame(sequence: 2, command: 0x81, payload: [7])])
}

@Test func transmissionConfigMatchesVendorLayout() throws {
    // Field order from Cmd_setTransmissionConfig.
    var payload = [UInt8](repeating: 0xAA, count: TransmissionConfig.payloadSize)
    payload[0] = 8
    payload[1...4] = [0x00, 0x13, 0x50, 0x88] // 1265800 kHz.
    payload[5] = 2
    payload[6] = 1
    payload[7] = 4
    payload[8] = 0
    payload[9] = 0xFB // -5 dB.
    payload[14] = 0
    var config = try #require(TransmissionConfig(payload: payload))
    #expect(config.bandwidthKHz == 8000)
    #expect(config.frequencyKHz == 1_265_800)
    #expect(config.constellation == .qam64)
    #expect(config.fft == .k8)
    #expect(config.codeRate == .r7_8)
    #expect(config.guardInterval == .g1_32)
    #expect(config.attenuationDB == -5)
    #expect(config.isDVBT)

    config.frequencyKHz = 1_280_000
    config.bandwidthKHz = 2500
    #expect(config.raw[0] == 25)
    #expect(config.frequencyKHz == 1_280_000)
    // Unexposed bytes survive a read-modify-write.
    #expect(config.raw[10] == 0xAA)
    #expect(config.raw[31] == 0xAA)
}

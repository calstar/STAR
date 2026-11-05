import Testing
@testable import HiDesKit

@Test func namesRoundTripWithoutTouchingOtherFields() throws {
    let original = [UInt8](repeating: 0xAA, count: TSInfoConfig.payloadSize)
    var config = try #require(TSInfoConfig(payload: original))
    config.serviceName = "KO6PSD"
    #expect(config.serviceName == "KO6PSD")
    #expect(Array(config.raw[43..<47]) == [0x4B, 0, 0x4F, 0])
    #expect(Array(config.raw[55..<75]) == [UInt8](repeating: 0, count: 20))
    #expect(config.raw[42] == 0xAA)
    #expect(config.raw[75] == 0xAA)
}

@Test func namesAreLimitedToTheField() throws {
    var config = try #require(TSInfoConfig(payload: [UInt8](repeating: 0, count: TSInfoConfig.payloadSize)))
    config.providerName = "ABCDEFGHIJKLMNOPQRST"
    #expect(config.providerName == "ABCDEFGHIJKLMNOP")
    #expect(config.raw[107] == 0)
}

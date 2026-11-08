import Darwin
import Testing
@testable import HiDesKit

// MARK: UDP target

private func dotted(_ address: in_addr) -> String {
    var copy = address
    var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    inet_ntop(AF_INET, &copy, &buffer, socklen_t(INET_ADDRSTRLEN))
    return String(cString: buffer)
}

@Test func udpTargetTakesAnIPv4Address() throws {
    #expect(dotted(try UDPOutput.resolveIPv4("192.168.2.20")) == "192.168.2.20")
}

@Test func udpTargetLooksUpAName() throws {
    // HiDes Viewer used to refuse any name ("Invalid IPv4 address star-rfs.local").
    #expect(dotted(try UDPOutput.resolveIPv4("localhost")) == "127.0.0.1")
}

@Test func udpTargetNamesAHostItCannotFind() {
    #expect(throws: HiDesError.self) { try UDPOutput.resolveIPv4("no-such-host.invalid") }
}

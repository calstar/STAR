import Darwin
import Foundation

/// Sends MPEG-TS over UDP in the usual 7-packet datagrams, for VLC, OBS and ffmpeg.
public final class UDPOutput {
    private static let packetsPerDatagram = 7
    private let socketDescriptor: Int32
    private var address: sockaddr_in
    private var pending = [UInt8]()

    public init(host: String, port: UInt16) throws {
        socketDescriptor = socket(AF_INET, SOCK_DGRAM, 0)
        guard socketDescriptor >= 0 else { throw HiDesError.system("Creating UDP socket", errno) }
        address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else {
            close(socketDescriptor)
            throw HiDesError.usb("Invalid IPv4 address \(host)")
        }
        pending.reserveCapacity(Self.packetsPerDatagram * TS.packetSize)
    }

    deinit { close(socketDescriptor) }

    /// Drops rather than blocks if the send fails, since this runs on the live path.
    public func send(packet: UnsafeBufferPointer<UInt8>) {
        pending.append(contentsOf: packet)
        guard pending.count >= Self.packetsPerDatagram * TS.packetSize else { return }
        withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                _ = sendto(socketDescriptor, pending, pending.count, 0, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        pending.removeAll(keepingCapacity: true)
    }
}

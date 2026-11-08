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
        do {
            address.sin_addr = try Self.resolveIPv4(host)
        } catch {
            close(socketDescriptor)
            throw error
        }
        pending.reserveCapacity(Self.packetsPerDatagram * TS.packetSize)
    }

    /// An IPv4 address, or a name to look up (`star-rfs.local`, `localhost`): the gateway is
    /// known by its name, and its address can change. Looked up once, when the output starts.
    public static func resolveIPv4(_ host: String) throws -> in_addr {
        var literal = in_addr()
        if inet_pton(AF_INET, host, &literal) == 1 { return literal }
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_DGRAM
        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, nil, &hints, &result)
        defer { if let result { freeaddrinfo(result) } }
        guard status == 0, let first = result, let socketAddress = first.pointee.ai_addr else {
            let why = status == 0 ? "no IPv4 address" : String(cString: gai_strerror(status))
            throw HiDesError.udpTarget("cannot find \(host) (\(why))")
        }
        return socketAddress.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
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

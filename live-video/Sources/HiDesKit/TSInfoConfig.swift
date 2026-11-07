import Foundation

/// The HV-320 stream identity settings.
///
/// Only the names are exposed. Everything else stays in `raw`, so a read-modify-write
/// leaves the PIDs and network IDs untouched.
public struct TSInfoConfig: Equatable {
    public static let payloadSize = 138
    public static let maxNameCharacters = 16

    private static let nameSize = 32
    private static let serviceNameOffset = 43
    private static let providerNameOffset = 75

    public private(set) var raw: [UInt8]

    public init?(payload: [UInt8]) {
        guard payload.count >= Self.payloadSize else { return nil }
        raw = Array(payload.prefix(Self.payloadSize))
    }

    public var serviceName: String {
        get { name(at: Self.serviceNameOffset) }
        set { setName(newValue, at: Self.serviceNameOffset) }
    }

    public var providerName: String {
        get { name(at: Self.providerNameOffset) }
        set { setName(newValue, at: Self.providerNameOffset) }
    }

    /// Stored as UTF-16LE and zero padded, as the vendor tool does with Encoding.Unicode.
    private func name(at offset: Int) -> String {
        let bytes = raw[offset..<(offset + Self.nameSize)]
        let decoded = String(data: Data(bytes), encoding: .utf16LittleEndian) ?? ""
        return decoded.split(separator: "\0", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    }

    private mutating func setName(_ value: String, at offset: Int) {
        var bytes = Array(value.prefix(Self.maxNameCharacters).data(using: .utf16LittleEndian) ?? Data())
        bytes = Array(bytes.prefix(Self.nameSize))
        bytes += [UInt8](repeating: 0, count: Self.nameSize - bytes.count)
        raw.replaceSubrange(offset..<(offset + Self.nameSize), with: bytes)
    }
}

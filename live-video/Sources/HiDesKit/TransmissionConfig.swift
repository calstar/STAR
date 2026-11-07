import Foundation

/// The HV-320 transmission settings.
///
/// Only fields whose meaning is confirmed from the vendor tool are exposed. Everything
/// else stays in `raw`, so a read-modify-write leaves it untouched.
public struct TransmissionConfig: Equatable {
    public enum Constellation: UInt8, CaseIterable { case qpsk = 0, qam16, qam64 }
    public enum FFT: UInt8, CaseIterable { case k2 = 0, k8, k4 }
    public enum CodeRate: UInt8, CaseIterable { case r1_2 = 0, r2_3, r3_4, r5_6, r7_8 }
    public enum GuardInterval: UInt8, CaseIterable { case g1_32 = 0, g1_16, g1_8, g1_4 }

    public static let payloadSize = 32

    private static let bandwidthOffset = 0
    private static let frequencyOffset = 1
    private static let constellationOffset = 5
    private static let fftOffset = 6
    private static let codeRateOffset = 7
    private static let guardOffset = 8
    private static let attenuationOffset = 9
    private static let channelOffset = 12
    private static let channelTableOffset = 13
    private static let standardOffset = 14

    public private(set) var raw: [UInt8]

    public init?(payload: [UInt8]) {
        guard payload.count >= Self.payloadSize else { return nil }
        raw = Array(payload.prefix(Self.payloadSize))
    }

    /// Bandwidth in kHz. The wire value is MHz, except 15 and 25 for 1.5 and 2.5 MHz.
    public var bandwidthKHz: Int {
        get {
            switch raw[Self.bandwidthOffset] {
            case 15: return 1500
            case 25: return 2500
            case let megahertz: return Int(megahertz) * 1000
            }
        }
        set {
            switch newValue {
            case 1500: raw[Self.bandwidthOffset] = 15
            case 2500: raw[Self.bandwidthOffset] = 25
            default: raw[Self.bandwidthOffset] = UInt8(clamping: newValue / 1000)
            }
        }
    }

    public var frequencyKHz: UInt32 {
        get {
            raw[Self.frequencyOffset..<(Self.frequencyOffset + 4)].reduce(0) { $0 << 8 | UInt32($1) }
        }
        set {
            for index in 0..<4 {
                raw[Self.frequencyOffset + index] = UInt8(truncatingIfNeeded: newValue >> (24 - 8 * UInt32(index)))
            }
        }
    }

    public var constellation: Constellation? {
        get { Constellation(rawValue: raw[Self.constellationOffset]) }
        set { if let newValue { raw[Self.constellationOffset] = newValue.rawValue } }
    }

    public var fft: FFT? {
        get { FFT(rawValue: raw[Self.fftOffset]) }
        set { if let newValue { raw[Self.fftOffset] = newValue.rawValue } }
    }

    public var codeRate: CodeRate? {
        get { CodeRate(rawValue: raw[Self.codeRateOffset]) }
        set { if let newValue { raw[Self.codeRateOffset] = newValue.rawValue } }
    }

    public var guardInterval: GuardInterval? {
        get { GuardInterval(rawValue: raw[Self.guardOffset]) }
        set { if let newValue { raw[Self.guardOffset] = newValue.rawValue } }
    }

    /// RF attenuation in dB, signed on the wire.
    public var attenuationDB: Int8 {
        get { Int8(bitPattern: raw[Self.attenuationOffset]) }
        set { raw[Self.attenuationOffset] = UInt8(bitPattern: newValue) }
    }

    /// Channel 0 means frequency and bandwidth come from this config rather than a table.
    public var channel: UInt8 {
        get { raw[Self.channelOffset] }
        set { raw[Self.channelOffset] = newValue }
    }

    public var isDVBT: Bool { raw[Self.standardOffset] == 0 }

    public var modulationSummary: String {
        func name<Value>(_ value: Value?) -> String {
            guard let value else { return "?" }
            return String(describing: value)
        }
        let standard = isDVBT ? "DVB-T" : "ISDB-T"
        return "\(standard), \(name(constellation)), \(name(fft)), \(name(codeRate)), \(name(guardInterval))"
    }
}

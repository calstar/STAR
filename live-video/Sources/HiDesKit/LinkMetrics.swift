import CIT930x
import Foundation

/// DVB-T parameters read from the TPS carriers, so they need no connection to the transmitter.
public struct LinkModulation: Equatable {
    public var fft: TransmissionConfig.FFT
    public var constellation: TransmissionConfig.Constellation
    public var guardInterval: TransmissionConfig.GuardInterval
    public var codeRate: TransmissionConfig.CodeRate
    public var hierarchical: Bool

    public init(fft: TransmissionConfig.FFT, constellation: TransmissionConfig.Constellation,
                guardInterval: TransmissionConfig.GuardInterval, codeRate: TransmissionConfig.CodeRate, hierarchical: Bool = false) {
        self.fft = fft
        self.constellation = constellation
        self.guardInterval = guardInterval
        self.codeRate = codeRate
        self.hierarchical = hierarchical
    }

    init?(raw: hides_rx_modulation) {
        guard let fft = TransmissionConfig.FFT(rawValue: raw.fft_mode),
              let constellation = TransmissionConfig.Constellation(rawValue: raw.constellation),
              let guardInterval = TransmissionConfig.GuardInterval(rawValue: raw.guard_interval),
              let codeRate = TransmissionConfig.CodeRate(rawValue: raw.code_rate) else { return nil }
        self.init(fft: fft, constellation: constellation, guardInterval: guardInterval, codeRate: codeRate, hierarchical: raw.hierarchy != 0)
    }

    public var summary: String {
        let constellationName = ["QPSK", "16QAM", "64QAM"][Int(constellation.rawValue)]
        let fftName = ["2K", "8K", "4K"][Int(fft.rawValue)]
        let rateName = ["1/2", "2/3", "3/4", "5/6", "7/8"][Int(codeRate.rawValue)]
        let guardName = ["1/32", "1/16", "1/8", "1/4"][Int(guardInterval.rawValue)]
        return "\(constellationName), \(fftName), FEC \(rateName), GI \(guardName)" + (hierarchical ? ", hierarchical" : "")
    }

    /// Net TS bitrate the channel carries, null packets included (ETSI EN 300 744 table A.1).
    /// Hierarchical modes split the capacity between two streams, which this does not model.
    public func capacityBitsPerSecond(bandwidthKHz: Int) -> Double {
        let dataCarriers: Double
        let fftSize: Double
        switch fft {
        case .k2: dataCarriers = 1512; fftSize = 2048
        case .k4: dataCarriers = 3024; fftSize = 4096
        case .k8: dataCarriers = 6048; fftSize = 8192
        }
        let bitsPerCarrier: Double = [2, 4, 6][Int(constellation.rawValue)]
        let rate: Double = [1.0 / 2, 2.0 / 3, 3.0 / 4, 5.0 / 6, 7.0 / 8][Int(codeRate.rawValue)]
        let guardFraction: Double = [1.0 / 32, 1.0 / 16, 1.0 / 8, 1.0 / 4][Int(guardInterval.rawValue)]
        // The elementary period is 7/64 µs in an 8 MHz channel and scales inversely with bandwidth.
        let usefulSymbol = fftSize * 7.0 / (8.0 * Double(bandwidthKHz) / 1000) * 1e-6
        let symbol = usefulSymbol * (1 + guardFraction)
        return dataCarriers * bitsPerCarrier * rate * (188.0 / 204.0) / symbol
    }
}

/// The HV-320's own table on PID 0x77, table 0x77. The field layout is inferred from one
/// unit sending 1280x720 with 48 kHz audio, so only those fields are decoded.
public struct SourceInfo: Equatable {
    public static let pid: UInt16 = 0x77
    public var width: Int
    public var height: Int
    public var audioSampleRate: Int

    /// Body is the section after the 8-byte long header, without CRC.
    init?(sectionBody body: [UInt8]) {
        guard body.count >= 12 else { return nil }
        width = Int(body[1]) << 8 | Int(body[2])
        height = Int(body[3]) << 8 | Int(body[4])
        audioSampleRate = body[8..<12].reduce(0) { $0 << 8 | Int($1) }
        guard width > 0, height > 0 else { return nil }
    }
}

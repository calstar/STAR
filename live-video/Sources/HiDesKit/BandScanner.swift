import Foundation

public struct ScanPoint: Equatable {
    public var frequencyKHz: UInt32
    public var strengthDBm: Int
    public var strengthPercent: Int
    public var tpsLocked: Bool
    public var mpegLocked: Bool
}

/// Steps the receiver across a range and records signal strength at each frequency.
///
/// Unverified: whether the demod reports strength for non-DVB-T signals such as a CW carrier.
/// If it only reports once locked, a scan can still find active transmitters but not other signals.
public enum BandScanner {
    public static func frequencies(fromKHz start: UInt32, toKHz end: UInt32, stepKHz step: UInt32) -> [UInt32] {
        guard step > 0, end >= start else { return [] }
        return Array(stride(from: start, through: end, by: Int(step)))
    }

    /// The device must be initialized and not streaming. `dwell` is the settle time per step.
    public static func scan(_ device: ReceiverDevice, frequencies: [UInt32], bandwidthKHz: UInt16,
                            dwell: TimeInterval = 0.4, onPoint: (ScanPoint) -> Void = { _ in }) throws -> [ScanPoint] {
        var points: [ScanPoint] = []
        for frequency in frequencies {
            try device.tune(frequencyKHz: frequency, bandwidthKHz: bandwidthKHz)
            if dwell > 0 { Thread.sleep(forTimeInterval: dwell) }
            let status = try device.status()
            let point = ScanPoint(frequencyKHz: frequency, strengthDBm: status.strengthDBm, strengthPercent: status.strengthPercent,
                                  tpsLocked: status.tpsLocked, mpegLocked: status.mpegLocked)
            points.append(point)
            onPoint(point)
        }
        return points
    }
}

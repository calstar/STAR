import Foundation

/// Appends one CSV row per link snapshot, for reviewing a session afterwards.
public final class LinkLogger {
    public let url: URL
    private let handle: FileHandle
    private let timeFormat = ISO8601DateFormatter()

    static let header = "time,state,strength_dbm,strength_pct,quality_pct,snr_db,post_viterbi_ber,uncorrected_packets,"
        + "ts_mbps,payload_mbps,capacity_mbps,fps,cc_errors,tei_errors,recoveries,action,service,error"

    /// Creates a new file named by start time in `directory`.
    public init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = DateFormatter.fileStamp.string(from: Date())
        url = directory.appendingPathComponent("link-\(name).csv")
        FileManager.default.createFile(atPath: url.path, contents: Data((Self.header + "\n").utf8))
        handle = try FileHandle(forWritingTo: url)
        handle.seekToEndOfFile()
        timeFormat.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    deinit {
        try? handle.close()
    }

    /// ~/Library/Logs/HiDesViewer, where Console.app can also find it.
    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/HiDesViewer", isDirectory: true)
    }

    public func append(_ snapshot: LinkSnapshot) {
        handle.write(Data((Self.row(snapshot, timeFormat: timeFormat) + "\n").utf8))
    }

    static func row(_ snapshot: LinkSnapshot, timeFormat: ISO8601DateFormatter) -> String {
        let status = snapshot.status
        let locked = status?.tpsLocked == true
        func megabits(_ value: Double?) -> String { value.map { String(format: "%.3f", $0 / 1e6) } ?? "" }
        let fields: [String] = [
            timeFormat.string(from: snapshot.time),
            snapshot.state.rawValue,
            status.map { String($0.strengthDBm) } ?? "",
            status.map { String($0.strengthPercent) } ?? "",
            status.map { String($0.qualityPercent) } ?? "",
            locked ? String(status!.snrDB) : "",
            status?.postViterbiBER.map { String(format: "%.2e", $0) } ?? "",
            locked ? String(status!.uncorrectedPackets) : "",
            megabits(snapshot.rates.tsBitsPerSecond),
            megabits(snapshot.rates.payloadBitsPerSecond),
            megabits(snapshot.capacityBitsPerSecond),
            String(format: "%.1f", snapshot.rates.framesPerSecond),
            String(snapshot.stats.continuityErrors),
            String(snapshot.stats.transportErrors),
            String(snapshot.recoveries),
            snapshot.action?.rawValue ?? "",
            snapshot.serviceName ?? "",
            snapshot.error ?? "",
        ]
        return fields.map(csvField).joined(separator: ",")
    }

    private static func csvField(_ value: String) -> String {
        guard value.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" }) else { return value }
        return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}

extension DateFormatter {
    static let fileStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()
}

import Foundation
import HiDesKit

let usage = """
hides: HV-320 transmitter and UT-130 receiver tool

  hides ports                                 List candidate serial ports
  hides tx-get PORT                           Show transmitter RF settings
  hides tx-set PORT --freq KHZ [--bw KHZ] [--attenuation DB]
                                              Change settings, keeping the others
  hides tx-name PORT [--service NAME] [--provider NAME]
                                              Show or set the broadcast names (16 characters max)
  hides tx-raw PORT COMMAND                   Send a get command, print the payload as hex
  hides rx-info                               Read the receiver EEPROM (safe, first step)
  hides rx-init                               Load firmware and init the demod and mixer
  hides rx-stream --freq KHZ --bw KHZ --udp HOST:PORT [--seconds N]
                                              Tune and forward TS over UDP
  hides rx-watch --freq KHZ --bw KHZ [--seconds N] [--csv]
                                              Receive-only link dashboard with automatic recovery
  hides rx-scan --from KHZ --to KHZ [--step KHZ] [--bw KHZ] [--dwell MS]
                                              Step across a range and print signal strength
  hides file-stream FILE --udp HOST:PORT      Send a TS file at a fixed rate (no hardware)
"""

func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func parseUDP(_ value: String) throws -> UDPOutput {
    let parts = value.split(separator: ":")
    guard parts.count == 2, let port = UInt16(parts[1]) else {
        throw HiDesError.udpTarget("expected HOST:PORT, got \(value)")
    }
    return try UDPOutput(host: String(parts[0]), port: port)
}

func describe(_ config: TransmissionConfig) -> String {
    """
    Standard:     \(config.isDVBT ? "DVB-T" : "ISDB-T")
    Channel:      \(config.channel)
    Frequency:    \(config.frequencyKHz) kHz
    Bandwidth:    \(config.bandwidthKHz) kHz
    Modulation:   \(config.modulationSummary)
    Attenuation:  \(config.attenuationDB) dB
    """
}

func describe(_ snapshot: LinkSnapshot) -> String {
    var parts = [snapshot.state.title]
    if let status = snapshot.status {
        parts.append("\(status.strengthDBm) dBm, quality \(status.qualityPercent)%")
        if status.tpsLocked { parts.append("SNR \(status.snrDB) dB") }
        if let ber = status.postViterbiBER { parts.append(String(format: "BER %.1e", ber)) }
    }
    if let modulation = snapshot.modulation { parts.append(modulation.summary) }
    let rates = snapshot.rates
    var throughput = String(format: "TS %.2f / payload %.2f Mbps", rates.tsBitsPerSecond / 1e6, rates.payloadBitsPerSecond / 1e6)
    if let capacity = snapshot.capacityBitsPerSecond { throughput += String(format: " of %.2f", capacity / 1e6) }
    parts.append(throughput)
    parts.append(String(format: "%.1f fps", rates.framesPerSecond))
    parts.append("CC \(snapshot.stats.continuityErrors) TEI \(snapshot.stats.transportErrors)")
    if let name = snapshot.serviceName { parts.append(name) }
    if let source = snapshot.sourceInfo { parts.append("source \(source.width)x\(source.height)") }
    if let action = snapshot.action { parts.append("RECOVERY: \(action.rawValue)") }
    if let error = snapshot.error, snapshot.state != .healthy { parts.append(error) }
    return parts.joined(separator: " | ")
}

func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        print(usage)
        return
    }
    let rest = Array(arguments.dropFirst())
    switch command {
    case "ports":
        SerialPort.availablePorts().forEach { print($0) }
    case "tx-get":
        guard let path = rest.first else { print(usage); return }
        let (client, baudRate) = try AVSenderClient.connect(path: path)
        print("Connected at \(baudRate) baud")
        print(describe(try client.transmissionConfig()))
    case "tx-set":
        guard let path = rest.first else { print(usage); return }
        let (client, _) = try AVSenderClient.connect(path: path)
        var config = try client.transmissionConfig()
        if let frequency = option("--freq", in: rest).flatMap(UInt32.init) {
            config.frequencyKHz = frequency
            config.channel = 0 // Channel 0 makes the box use this frequency, not a table entry.
        }
        if let bandwidth = option("--bw", in: rest).flatMap(Int.init) { config.bandwidthKHz = bandwidth }
        if let attenuation = option("--attenuation", in: rest).flatMap(Int8.init) { config.attenuationDB = attenuation }
        try client.setTransmissionConfig(config)
        print(describe(try client.transmissionConfig()))
    case "tx-name":
        guard let path = rest.first else { print(usage); return }
        let (client, _) = try AVSenderClient.connect(path: path)
        var config = try client.tsInfoConfig()
        let service = option("--service", in: rest)
        let provider = option("--provider", in: rest)
        if service != nil || provider != nil {
            if let service { config.serviceName = service }
            if let provider { config.providerName = provider }
            try client.setTSInfoConfig(config)
            config = try client.tsInfoConfig()
        }
        print("Service:  \(config.serviceName)")
        print("Provider: \(config.providerName)")
    case "tx-raw":
        guard rest.count == 2, let id = UInt8(rest[1]) else { print(usage); return }
        guard id < 0x40 else { throw HiDesError.malformedReply("tx-raw only sends get commands") }
        let (client, _) = try AVSenderClient.connect(path: rest[0])
        let payload = try client.request(id)
        print(payload.map { String(format: "%02X", $0) }.joined(separator: " "))
    case "rx-info":
        let receiver = try UT130Receiver()
        let info = try receiver.readInfo()
        let raw = info.raw
        print("Bridge chip:   0x" + String(raw.bridge_chip, radix: 16))
        print("EEPROM valid:  \(raw.eeprom_valid)")
        print("Board ID:      0x" + String(raw.board_id, radix: 16))
        print("Receivers:     \(raw.receiver_count)")
        print("Chip type:     \(raw.chip_type)")
        print("Tuner script:  0x" + String(raw.tuner_id, radix: 16))
        print("Mixer:         \(info.mixerName)")
        print("LO1:           \(raw.lo1_khz) kHz")
        print("LO2:           \(raw.lo2_khz) kHz")
        print(receiver.endpointSummary())
    case "rx-init":
        let receiver = try UT130Receiver()
        try receiver.initialize()
        print("Init OK")
        print("Mixer readback: 0x" + String(receiver.mixerReadback, radix: 16) + " (wrote 0x4064)")
    case "rx-stream":
        guard let frequency = option("--freq", in: rest).flatMap(UInt32.init),
              let bandwidth = option("--bw", in: rest).flatMap(UInt16.init),
              let target = option("--udp", in: rest) else { print(usage); return }
        let output = try parseUDP(target)
        let receiver = try UT130Receiver()
        try receiver.initialize()
        try receiver.tune(frequencyKHz: frequency, bandwidthKHz: bandwidth)
        var aligner = TSAligner()
        try receiver.startStreaming { bytes in
            aligner.append(bytes) { output.send(packet: $0) }
        }
        let seconds = option("--seconds", in: rest).flatMap(Int.init) ?? Int.max
        for _ in 0..<seconds {
            sleep(1)
            let status = try receiver.status()
            print("TPS \(status.tpsLocked) MPEG \(status.mpegLocked) strength \(status.strengthPercent)% (\(status.strengthDBm) dBm) quality \(status.qualityPercent)%")
            let usb = receiver.streamDiagnostics
            let head = usb.firstBytes.map { String(format: "%02X", $0) }.joined(separator: " ")
            print("  USB bytes \(usb.bytes), timeouts \(usb.timeouts), first [\(head)]" + (usb.fatalError.map { ", error \($0)" } ?? ""))
        }
        receiver.stopStreaming()
    case "rx-watch":
        guard let frequency = option("--freq", in: rest).flatMap(UInt32.init),
              let bandwidth = option("--bw", in: rest).flatMap(UInt16.init) else { print(usage); return }
        let pipeline = LivePipeline()
        pipeline.audioEnabled = false
        let session = LinkSession(pipeline: pipeline, frequencyKHz: frequency, bandwidthKHz: bandwidth)
        let logger = rest.contains("--csv") ? try LinkLogger(directory: LinkLogger.defaultDirectory) : nil
        if let logger { print("Logging to \(logger.url.path)") }
        session.onSnapshot = { snapshot in
            print(describe(snapshot))
            logger?.append(snapshot)
        }
        session.start()
        let seconds = option("--seconds", in: rest).flatMap(Int.init) ?? Int.max
        for _ in 0..<seconds { sleep(1) }
        session.stop()
    case "rx-scan":
        guard let start = option("--from", in: rest).flatMap(UInt32.init),
              let end = option("--to", in: rest).flatMap(UInt32.init) else { print(usage); return }
        let step = option("--step", in: rest).flatMap(UInt32.init) ?? 2000
        let bandwidth = option("--bw", in: rest).flatMap(UInt16.init) ?? 8000
        let dwell = (option("--dwell", in: rest).flatMap(Double.init) ?? 400) / 1000
        let receiver = try UT130Receiver()
        try receiver.initialize()
        let frequencies = BandScanner.frequencies(fromKHz: start, toKHz: end, stepKHz: step)
        let points = try BandScanner.scan(receiver, frequencies: frequencies, bandwidthKHz: bandwidth, dwell: dwell) { point in
            let lock = point.mpegLocked ? "LOCK" : point.tpsLocked ? "tps" : ""
            print(String(format: "%9.3f MHz  %4d dBm  %3d%%  %@", Double(point.frequencyKHz) / 1000, point.strengthDBm, point.strengthPercent, lock))
        }
        if let peak = points.max(by: { $0.strengthDBm < $1.strengthDBm }) {
            print(String(format: "Strongest: %.3f MHz at %d dBm", Double(peak.frequencyKHz) / 1000, peak.strengthDBm))
        }
    case "file-stream":
        guard let path = rest.first, let target = option("--udp", in: rest) else { print(usage); return }
        let output = try parseUDP(target)
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        var sent = 0
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for start in stride(from: 0, to: bytes.count - TS.packetSize + 1, by: TS.packetSize) {
                output.send(packet: UnsafeBufferPointer(rebasing: bytes[start..<(start + TS.packetSize)]))
                sent += 1
                if sent % 50 == 0 { usleep(5000) }
            }
        }
        print("Sent \(sent) packets")
    default:
        print(usage)
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("Error: \(error)\n".utf8))
    exit(1)
}

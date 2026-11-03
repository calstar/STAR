import Foundation

/// Request/reply access to the HV-320 config port. Not thread safe.
public final class AVSenderClient {
    public static let supportedBaudRates = [38400, 57600]
    // Set commands can take several seconds to confirm.
    private static let replyTimeout: TimeInterval = 20
    // The IT9919 loses bytes on longer bursts, so the vendor tool paces writes like this.
    private static let writeChunkSize = 64
    private static let writeChunkPauseMicroseconds: UInt32 = 200_000

    private let port: SerialPort
    private var parser = AVSenderFrameParser()
    private var sequence: UInt8 = 0

    public init(port: SerialPort) {
        self.port = port
    }

    /// Tries each baud rate the box can be configured for, as the vendor tool's Auto mode does.
    public static func connect(path: String) throws -> (client: AVSenderClient, baudRate: Int) {
        var lastError: Error = HiDesError.timeout("a reply from the transmitter")
        for baudRate in supportedBaudRates {
            let client = AVSenderClient(port: try SerialPort(path: path, baudRate: baudRate))
            do {
                _ = try client.request(AVSenderCommand.getSystemInfo)
                return (client, baudRate)
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// Sends a command and returns its payload. Status replies carry no payload.
    @discardableResult
    public func request(_ command: UInt8, payload: [UInt8] = []) throws -> [UInt8] {
        sequence &+= 1
        let frame = AVSenderFrame(sequence: sequence, command: command, payload: payload)
        let bytes = frame.encoded()
        for start in stride(from: 0, to: bytes.count, by: Self.writeChunkSize) {
            if start > 0 { usleep(Self.writeChunkPauseMicroseconds) }
            try port.write(Array(bytes[start..<min(start + Self.writeChunkSize, bytes.count)]))
        }

        let expected = command | AVSenderFrame.replyFlag
        let deadline = Date().addingTimeInterval(Self.replyTimeout)
        while Date() < deadline {
            let incoming = try port.read(timeoutMilliseconds: 100)
            for reply in parser.append(incoming) where reply.command == expected {
                guard reply.status == 0 else {
                    throw HiDesError.deviceReply(command: command, status: reply.status)
                }
                return reply.payload
            }
        }
        throw HiDesError.timeout("reply to command \(command)")
    }

    public func transmissionConfig() throws -> TransmissionConfig {
        let payload = try request(AVSenderCommand.getTransmission)
        guard let config = TransmissionConfig(payload: payload) else {
            throw HiDesError.malformedReply("transmission config of \(payload.count) bytes")
        }
        return config
    }

    public func setTransmissionConfig(_ config: TransmissionConfig) throws {
        try request(AVSenderCommand.setTransmission, payload: config.raw)
    }

    public func tsInfoConfig() throws -> TSInfoConfig {
        let payload = try request(AVSenderCommand.getTSInfo)
        guard let config = TSInfoConfig(payload: payload) else {
            throw HiDesError.malformedReply("TS info of \(payload.count) bytes")
        }
        return config
    }

    public func setTSInfoConfig(_ config: TSInfoConfig) throws {
        try request(AVSenderCommand.setTSInfo, payload: config.raw)
    }

    public func reboot() throws {
        try request(AVSenderCommand.reboot, payload: [0])
    }
}

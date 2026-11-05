import Foundation

/// Serial frame used by the HV-320 config UART.
///
/// Layout: `0x23, length, sequence, command, status, payload..., checksum, 0x0D`.
/// `length` is the frame size minus 3. The checksum is the low byte of the sum of
/// every byte from `length` up to the end of the payload.
public struct AVSenderFrame: Equatable {
    public static let startByte: UInt8 = 0x23
    public static let endByte: UInt8 = 0x0D
    public static let replyFlag: UInt8 = 0x80

    public var sequence: UInt8
    public var command: UInt8
    public var status: UInt8
    public var payload: [UInt8]

    public init(sequence: UInt8, command: UInt8, status: UInt8 = 0, payload: [UInt8] = []) {
        self.sequence = sequence
        self.command = command
        self.status = status
        self.payload = payload
    }

    public func encoded() -> [UInt8] {
        var bytes: [UInt8] = [Self.startByte, UInt8(payload.count + 4), sequence, command, status]
        bytes += payload
        bytes.append(Self.checksum(bytes[1...]))
        bytes.append(Self.endByte)
        return bytes
    }

    static func checksum(_ bytes: ArraySlice<UInt8>) -> UInt8 {
        bytes.reduce(0) { $0 &+ $1 }
    }
}

/// Reassembles frames from a serial byte stream, resynchronising on bad data.
public struct AVSenderFrameParser {
    private var buffer: [UInt8] = []

    public init() {}

    public mutating func append(_ bytes: [UInt8]) -> [AVSenderFrame] {
        buffer += bytes
        var frames: [AVSenderFrame] = []
        while true {
            guard let start = buffer.firstIndex(of: AVSenderFrame.startByte) else {
                buffer.removeAll()
                return frames
            }
            buffer.removeFirst(start)
            guard buffer.count >= 2 else { return frames }
            let total = Int(buffer[1]) + 3
            guard total >= 7 else {
                buffer.removeFirst()
                continue
            }
            guard buffer.count >= total else { return frames }
            let valid = buffer[total - 1] == AVSenderFrame.endByte
                && AVSenderFrame.checksum(buffer[1..<(total - 2)]) == buffer[total - 2]
            guard valid else {
                buffer.removeFirst()
                continue
            }
            frames.append(AVSenderFrame(
                sequence: buffer[2],
                command: buffer[3],
                status: buffer[4],
                payload: Array(buffer[5..<(total - 2)])
            ))
            buffer.removeFirst(total)
        }
    }
}

/// Command IDs from the vendor tool. A set command is its get command plus 0x40.
public enum AVSenderCommand {
    public static let getTransmission: UInt8 = 0
    public static let getMedia: UInt8 = 1
    public static let getTSInfo: UInt8 = 2
    public static let getSystemInfo: UInt8 = 4
    public static let getSourceInfo: UInt8 = 5
    public static let getEncryption: UInt8 = 11
    public static let setTransmission: UInt8 = 64
    public static let setMedia: UInt8 = 65
    public static let setTSInfo: UInt8 = 66
    public static let reboot: UInt8 = 69
}

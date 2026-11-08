import Darwin
import Foundation

public enum HiDesError: Error, CustomStringConvertible {
    case system(String, Int32)
    case timeout(String)
    case deviceReply(command: UInt8, status: UInt8)
    case malformedReply(String)
    case usb(String)
    case driver(String, UInt32)
    case deviceNotFound
    case udpTarget(String)

    public var description: String {
        switch self {
        case let .system(what, code): return "\(what): \(String(cString: strerror(code)))"
        case let .timeout(what): return "Timed out waiting for \(what)"
        case let .deviceReply(command, status): return "Device rejected command \(command), status \(status)"
        case let .malformedReply(what): return "Malformed reply: \(what)"
        case let .usb(what): return "USB error: \(what)"
        case let .driver(what, code): return "\(what) failed: \(hiDesDriverErrorName(code))"
        case .deviceNotFound: return "No UT-130 found on USB"
        case let .udpTarget(what): return "UDP target: \(what)"
        }
    }
}

/// A raw 8N1 serial port opened through termios.
public final class SerialPort {
    private let descriptor: Int32

    public init(path: String, baudRate: Int) throws {
        descriptor = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard descriptor >= 0 else { throw HiDesError.system("Opening \(path)", errno) }
        var settings = termios()
        tcgetattr(descriptor, &settings)
        cfmakeraw(&settings)
        settings.c_cflag |= tcflag_t(CLOCAL | CREAD)
        settings.c_cflag &= ~tcflag_t(PARENB | CSTOPB | CRTSCTS)
        cfsetspeed(&settings, speed_t(baudRate))
        guard tcsetattr(descriptor, TCSANOW, &settings) == 0 else {
            let code = errno
            close(descriptor)
            throw HiDesError.system("Configuring \(path)", code)
        }
        tcflush(descriptor, TCIOFLUSH)
    }

    deinit { close(descriptor) }

    public func write(_ bytes: [UInt8]) throws {
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
            if written < 0 {
                if errno == EAGAIN { usleep(1000); continue }
                throw HiDesError.system("Writing to serial port", errno)
            }
            offset += written
        }
    }

    /// Returns whatever arrives within the timeout; empty means none did.
    public func read(timeoutMilliseconds: Int32) throws -> [UInt8] {
        var poller = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let ready = poll(&poller, 1, timeoutMilliseconds)
        if ready < 0 { throw HiDesError.system("Polling serial port", errno) }
        if ready == 0 { return [] }
        var buffer = [UInt8](repeating: 0, count: 512)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 {
            if errno == EAGAIN { return [] }
            throw HiDesError.system("Reading serial port", errno)
        }
        return Array(buffer.prefix(count))
    }

    /// Serial devices worth offering, excluding Bluetooth and system debug ports.
    public static func availablePorts() -> [String] {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: "/dev")) ?? []
        return entries
            .filter { $0.hasPrefix("cu.") && ($0.contains("usb") || $0.contains("PL2303")) }
            .sorted()
            .map { "/dev/" + $0 }
    }
}

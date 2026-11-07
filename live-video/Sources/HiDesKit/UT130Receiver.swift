import CIT930x
import CLibUSB
import Foundation

public func hiDesDriverErrorName(_ code: UInt32) -> String {
    switch code {
    case HIDES_ERR_UNSUPPORTED_MIXER:
        return "this board's mixer is not implemented, so frequencies above 950 MHz cannot be tuned"
    case HIDES_ERR_NARROW_BW:
        return "bandwidths under 5 MHz are not implemented for this board"
    case HIDES_ERR_MIXER_NO_RESPONSE:
        return "the RFFC2071 mixer did not respond on its 3-wire bus"
    case HIDES_ERR_NO_LO:
        return "the receiver EEPROM has no local oscillator frequency for this band"
    default:
        return "vendor error 0x" + String(code, radix: 16)
    }
}

public struct ReceiverInfo {
    public var raw: hides_rx_info

    public var mixerName: String {
        switch raw.mixer {
        case HIDES_MIXER_ADRF6655: return "ADRF6655"
        case HIDES_MIXER_RFFC2072: return "RFFC2072"
        case HIDES_MIXER_RFFC2071: return "RFFC2071"
        default: return "none"
        }
    }
}

public struct ReceiverStatus {
    public var tpsLocked: Bool
    public var mpegLocked: Bool
    public var strengthPercent: Int
    public var qualityPercent: Int
    public var strengthDBm: Int
    public var snrDB: Int = 0
    public var postViterbiErrors: UInt32 = 0
    public var postViterbiBits: UInt32 = 0
    public var uncorrectedPackets: Int = 0

    public init(tpsLocked: Bool, mpegLocked: Bool, strengthPercent: Int, qualityPercent: Int, strengthDBm: Int) {
        self.tpsLocked = tpsLocked
        self.mpegLocked = mpegLocked
        self.strengthPercent = strengthPercent
        self.qualityPercent = qualityPercent
        self.strengthDBm = strengthDBm
    }

    /// Bit error ratio after Viterbi, or nil when the demod had no measurement window.
    public var postViterbiBER: Double? {
        postViterbiBits > 0 ? Double(postViterbiErrors) / Double(postViterbiBits) : nil
    }
}

/// What the link session needs from a receiver, so recovery can be tested without hardware.
public protocol ReceiverDevice: AnyObject {
    func initialize() throws
    func tune(frequencyKHz: UInt32, bandwidthKHz: UInt16) throws
    func status() throws -> ReceiverStatus
    func modulation() throws -> LinkModulation?
    func startStreaming(onData: @escaping (UnsafeBufferPointer<UInt8>) -> Void) throws
    func stopStreaming()
    var streamDiagnostics: UT130Receiver.StreamDiagnostics { get }
}

/// The UT-130 over libusb. Only one instance can be open, because the vendor API keeps global state.
public final class UT130Receiver: ReceiverDevice {
    /// USB IDs from IT9300BDA.inf.
    public static let knownDevices: [(vendor: UInt16, product: UInt16)] = [
        (0x048D, 0x9306), (0x048D, 0x9305), (0x048D, 0x9307), (0x048D, 0x9302), (0x1D19, 0x0100), (0x07CA, 0x0891),
    ]
    // A multiple of the 512-byte endpoint size, so reads end on packet boundaries.
    private static let streamBufferSize = 512 * 16

    private var context: OpaquePointer?
    private var handle: OpaquePointer?
    private var streamThread: Thread?
    private let stopLock = NSLock()
    private var stopRequested = false

    public private(set) var info: ReceiverInfo?

    /// Raw transfer counters, for telling "no data from USB" apart from "data with no TS sync".
    public struct StreamDiagnostics {
        public var bytes: UInt64 = 0
        public var timeouts: UInt64 = 0
        public var firstBytes: [UInt8] = []
        public var fatalError: String?

        public init() {}
    }
    private var diagnostics = StreamDiagnostics()
    public var streamDiagnostics: StreamDiagnostics { stopLock.withLock { diagnostics } }

    /// Bulk and interrupt endpoints of the active configuration, for checking the USB layout.
    public func endpointSummary() -> String {
        guard let handle, let device = libusb_get_device(handle) else { return "" }
        var config: UnsafeMutablePointer<libusb_config_descriptor>?
        guard libusb_get_active_config_descriptor(device, &config) == 0, let config else { return "" }
        defer { libusb_free_config_descriptor(config) }
        var lines: [String] = []
        for i in 0..<Int(config.pointee.bNumInterfaces) {
            let interface = config.pointee.interface[i]
            for a in 0..<Int(interface.num_altsetting) {
                let alt = interface.altsetting[a]
                for e in 0..<Int(alt.bNumEndpoints) {
                    let ep = alt.endpoint[e]
                    lines.append("if \(i) alt \(a) ep 0x" + String(ep.bEndpointAddress, radix: 16) + " attr \(ep.bmAttributes) max \(ep.wMaxPacketSize)")
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    public init() throws {
        guard libusb_init(&context) == 0 else { throw HiDesError.usb("libusb_init failed") }
        for device in Self.knownDevices {
            handle = libusb_open_device_with_vid_pid(context, device.vendor, device.product)
            if handle != nil { break }
        }
        // A throwing class init still runs deinit, which releases everything acquired here.
        guard let handle else { throw HiDesError.deviceNotFound }
        let claim = libusb_claim_interface(handle, 0)
        guard claim == 0 else {
            throw HiDesError.usb("Claiming interface: " + String(cString: libusb_error_name(claim)))
        }
        hides_rx_set_transport({ ctx, endpoint, buffer, length, timeout in
            let device = OpaquePointer(ctx)
            var transferred: Int32 = 0
            let result = libusb_bulk_transfer(device, endpoint, buffer, Int32(length), &transferred, timeout)
            return result == 0 && UInt32(transferred) == length ? 0 : 1
        }, UnsafeMutableRawPointer(handle))
    }

    deinit {
        stopStreaming()
        if let handle {
            libusb_release_interface(handle, 0)
            libusb_close(handle)
        }
        if let context { libusb_exit(context) }
    }

    @discardableResult
    public func readInfo() throws -> ReceiverInfo {
        var raw = hides_rx_info()
        try check("Reading device info", hides_rx_read_info(&raw))
        let result = ReceiverInfo(raw: raw)
        info = result
        return result
    }

    public func initialize() throws {
        if info == nil { try readInfo() }
        try check("Initializing receiver", hides_rx_init())
    }

    /// Register 1 read back from the RFFC2071 after init. 0x4064 was written.
    public var mixerReadback: UInt16 { hides_rx_mixer_readback() }

    public func tune(frequencyKHz: UInt32, bandwidthKHz: UInt16) throws {
        try check("Tuning", hides_rx_tune(frequencyKHz, bandwidthKHz))
    }

    public func status() throws -> ReceiverStatus {
        var raw = hides_rx_status()
        try check("Reading status", hides_rx_get_status(&raw))
        var status = ReceiverStatus(
            tpsLocked: raw.tps_locked != 0,
            mpegLocked: raw.mpeg_locked != 0,
            strengthPercent: Int(raw.strength_percent),
            qualityPercent: Int(raw.quality_percent),
            strengthDBm: Int(raw.strength_dbm)
        )
        status.snrDB = Int(raw.snr_db)
        status.postViterbiErrors = raw.post_viterbi_errors
        status.postViterbiBits = raw.post_viterbi_bits
        status.uncorrectedPackets = Int(raw.uncorrected_packets)
        return status
    }

    /// The modulation the transmitter signals. Call only while TPS is locked.
    public func modulation() throws -> LinkModulation? {
        var raw = hides_rx_modulation()
        try check("Reading modulation", hides_rx_get_modulation(&raw))
        return LinkModulation(raw: raw)
    }

    /// Delivers raw TS bytes on a dedicated high-priority thread until stopped.
    public func startStreaming(onData: @escaping (UnsafeBufferPointer<UInt8>) -> Void) throws {
        guard let handle else { return }
        try check("Enabling TS port", hides_rx_set_streaming(1))
        stopLock.withLock { stopRequested = false; diagnostics = StreamDiagnostics() }
        let bufferSize = Self.streamBufferSize
        let thread = Thread { [weak self] in
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            while let self, !self.stopLock.withLock({ self.stopRequested }) {
                var transferred: Int32 = 0
                let result = libusb_bulk_transfer(handle, UInt8(HIDES_EP_TS_IN), &buffer, Int32(bufferSize), &transferred, 500)
                let timedOut = result == LIBUSB_ERROR_TIMEOUT.rawValue
                if getenv("HIDES_STREAM_LOG") != nil { fputs("bulk result \(result) transferred \(transferred)\n", stderr) }
                self.stopLock.withLock {
                    self.diagnostics.bytes += UInt64(transferred)
                    if timedOut { self.diagnostics.timeouts += 1 }
                    if self.diagnostics.firstBytes.isEmpty, transferred > 0 {
                        self.diagnostics.firstBytes = Array(buffer.prefix(min(Int(transferred), 16)))
                    }
                    if result != 0, !timedOut {
                        self.diagnostics.fatalError = String(cString: libusb_error_name(result))
                    }
                }
                if (result == 0 || timedOut), transferred > 0 {
                    buffer.withUnsafeBufferPointer { onData(UnsafeBufferPointer(rebasing: $0[0..<Int(transferred)])) }
                } else if result != 0, !timedOut {
                    return
                }
            }
        }
        thread.qualityOfService = .userInteractive
        thread.name = "UT-130 TS"
        streamThread = thread
        thread.start()
    }

    public func stopStreaming() {
        guard let thread = streamThread else { return }
        stopLock.withLock { stopRequested = true }
        while !thread.isFinished { usleep(1000) }
        streamThread = nil
        _ = hides_rx_set_streaming(0)
    }

    private func check(_ what: String, _ code: UInt32) throws {
        if code != 0 { throw HiDesError.driver(what, code) }
    }
}

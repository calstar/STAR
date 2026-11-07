import Foundation

public enum TS {
    public static let packetSize = 188
    public static let syncByte: UInt8 = 0x47
    static let patPID: UInt16 = 0
    static let sdtPID: UInt16 = 0x11
}

/// Splits an arbitrary byte stream into 188-byte packets, recovering sync after loss.
public struct TSAligner {
    private var pending: [UInt8] = []

    public init() {}

    public mutating func append(_ bytes: UnsafeBufferPointer<UInt8>, emit: (UnsafeBufferPointer<UInt8>) -> Void) {
        // The common case is already aligned, which allows skipping the copy.
        if pending.isEmpty, bytes.count % TS.packetSize == 0, isAligned(bytes) {
            emitPackets(bytes, emit: emit)
            return
        }
        pending.append(contentsOf: bytes)
        var start = 0
        let total = pending.count
        pending.withUnsafeBufferPointer { buffer in
            while total - start >= TS.packetSize {
                if buffer[start] == TS.syncByte {
                    let next = start + TS.packetSize
                    if next >= total || buffer[next] == TS.syncByte {
                        emit(UnsafeBufferPointer(rebasing: buffer[start..<next]))
                        start = next
                        continue
                    }
                }
                start += 1
            }
        }
        pending.removeFirst(start)
    }

    private func isAligned(_ bytes: UnsafeBufferPointer<UInt8>) -> Bool {
        stride(from: 0, to: bytes.count, by: TS.packetSize).allSatisfy { bytes[$0] == TS.syncByte }
    }

    private func emitPackets(_ bytes: UnsafeBufferPointer<UInt8>, emit: (UnsafeBufferPointer<UInt8>) -> Void) {
        for start in stride(from: 0, to: bytes.count, by: TS.packetSize) {
            emit(UnsafeBufferPointer(rebasing: bytes[start..<(start + TS.packetSize)]))
        }
    }
}

public enum ElementaryStreamKind: Equatable {
    case h264
    case aac
    case mpegAudio
    case other(UInt8)

    init(streamType: UInt8) {
        switch streamType {
        case 0x1B: self = .h264
        case 0x0F, 0x11: self = .aac
        case 0x03, 0x04: self = .mpegAudio
        default: self = .other(streamType)
        }
    }
}

/// A complete PES payload. Timestamps are in 90 kHz ticks.
public struct PESUnit {
    public var kind: ElementaryStreamKind
    public var presentationTime: UInt64?
    public var data: Data
}

/// Finds the first program via PAT/PMT and reassembles its video and audio.
public final class TSDemuxer {
    public var onUnit: ((PESUnit) -> Void)?
    /// Called when the broadcast service name is first seen or changes.
    public var onServiceName: ((String) -> Void)?
    /// Called when the HV-320 source table is first seen or changes.
    public var onSourceInfo: ((SourceInfo) -> Void)?
    public private(set) var packetCount: UInt64 = 0
    /// Padding packets, which show how much channel capacity the encoder leaves unused.
    public private(set) var nullPackets: UInt64 = 0
    public private(set) var continuityErrors: UInt64 = 0
    public private(set) var transportErrors: UInt64 = 0

    private struct Assembly {
        var kind: ElementaryStreamKind
        var buffer = Data()
        var presentationTime: UInt64?
        /// False until a unit start is seen, so a stream joined mid-unit is not misread.
        var started = false
    }

    private var pmtPID: UInt16?
    private var serviceName: String?
    private var sourceInfo: SourceInfo?
    private var assemblies: [UInt16: Assembly] = [:]
    private var continuity: [UInt16: UInt8] = [:]

    public init() {}

    /// Forgets partial units and continuity, keeping counters. For use after the stream was interrupted.
    public func resynchronize() {
        assemblies = assemblies.mapValues { Assembly(kind: $0.kind) }
        continuity.removeAll()
    }

    public func consume(_ packet: UnsafeBufferPointer<UInt8>) {
        guard packet.count == TS.packetSize, packet[0] == TS.syncByte else { return }
        packetCount += 1
        if packet[1] & 0x80 != 0 {
            transportErrors += 1
            return
        }
        let unitStart = packet[1] & 0x40 != 0
        let pid = UInt16(packet[1] & 0x1F) << 8 | UInt16(packet[2])
        if pid == 0x1FFF {
            nullPackets += 1
            return
        }
        let adaptation = (packet[3] >> 4) & 0x3
        let counter = packet[3] & 0xF
        var offset = 4
        if adaptation & 0x2 != 0 { offset += 1 + Int(packet[4]) }
        guard adaptation & 0x1 != 0, offset < TS.packetSize else { return }

        trackContinuity(pid: pid, counter: counter, discontinuity: adaptation & 0x2 != 0 && packet[4] > 0 && packet[5] & 0x80 != 0)
        let endsUnit = !unitStart && Self.hasStuffing(packet, adaptation: adaptation)
        let payload = UnsafeBufferPointer(rebasing: packet[offset...])

        if pid == TS.patPID {
            if unitStart { parsePAT(payload) }
        } else if pid == TS.sdtPID {
            if unitStart { parseSDT(payload) }
        } else if pid == SourceInfo.pid {
            if unitStart { parseSourceInfo(payload) }
        } else if pid == pmtPID {
            if unitStart { parsePMT(payload) }
        } else if assemblies[pid] != nil {
            appendPES(pid: pid, unitStart: unitStart, payload: payload)
            // The HV-320 leaves the PES length at zero but stuffs the last packet of each frame.
            // Flushing here saves waiting one frame time for the next unit to start.
            if endsUnit, var assembly = assemblies[pid] {
                flush(&assembly)
                assemblies[pid] = assembly
            }
        }
    }

    /// True if the adaptation field holds stuffing rather than only a PCR.
    private static func hasStuffing(_ packet: UnsafeBufferPointer<UInt8>, adaptation: UInt8) -> Bool {
        guard adaptation == 0x3, packet[4] > 0 else { return false }
        let hasPCR = packet[5] & 0x10 != 0
        return Int(packet[4]) > (hasPCR ? 7 : 0)
    }

    private func trackContinuity(pid: UInt16, counter: UInt8, discontinuity: Bool) {
        if let last = continuity[pid], !discontinuity, counter != last, counter != (last &+ 1) & 0xF {
            continuityErrors += 1
        }
        continuity[pid] = counter
    }

    /// Section body after the pointer field, or nil if it does not fit one packet.
    private func section(_ payload: UnsafeBufferPointer<UInt8>) -> UnsafeBufferPointer<UInt8>? {
        let start = 1 + Int(payload[0])
        guard start + 3 <= payload.count else { return nil }
        let length = Int(payload[start + 1] & 0x0F) << 8 | Int(payload[start + 2])
        guard start + 3 + length <= payload.count else { return nil }
        return UnsafeBufferPointer(rebasing: payload[start..<(start + 3 + length)])
    }

    private func parsePAT(_ payload: UnsafeBufferPointer<UInt8>) {
        guard let table = section(payload), table.count >= 12, table[0] == 0x00 else { return }
        for entry in stride(from: 8, to: table.count - 4 - 3, by: 4) {
            let program = UInt16(table[entry]) << 8 | UInt16(table[entry + 1])
            if program != 0 {
                pmtPID = UInt16(table[entry + 2] & 0x1F) << 8 | UInt16(table[entry + 3])
                return
            }
        }
    }

    private func parseSDT(_ payload: UnsafeBufferPointer<UInt8>) {
        guard let table = section(payload), table.count >= 20, table[0] == 0x42 else { return }
        let descriptorLength = Int(table[14] & 0x0F) << 8 | Int(table[15])
        var index = 16
        let end = min(index + descriptorLength, table.count - 4)
        while index + 2 <= end {
            let tag = table[index]
            let length = Int(table[index + 1])
            guard index + 2 + length <= end else { return }
            if tag == 0x48, let name = Self.serviceName(descriptor: table[(index + 2)..<(index + 2 + length)]) {
                if name != serviceName {
                    serviceName = name
                    onServiceName?(name)
                }
                return
            }
            index += 2 + length
        }
    }

    private func parseSourceInfo(_ payload: UnsafeBufferPointer<UInt8>) {
        guard let table = section(payload), table.count >= 12, table[0] == 0x77,
              let info = SourceInfo(sectionBody: Array(table[8..<(table.count - 4)])), info != sourceInfo else { return }
        sourceInfo = info
        onSourceInfo?(info)
    }

    /// Descriptor body: type, provider length, provider, name length, name.
    private static func serviceName(descriptor: Slice<UnsafeBufferPointer<UInt8>>) -> String? {
        let bytes = Array(descriptor)
        guard bytes.count >= 3 else { return nil }
        let nameLengthIndex = 2 + Int(bytes[1])
        guard nameLengthIndex < bytes.count else { return nil }
        let nameStart = nameLengthIndex + 1
        let nameEnd = nameStart + Int(bytes[nameLengthIndex])
        guard nameEnd <= bytes.count else { return nil }
        // A leading byte below 0x20 selects a DVB character table, and is not part of the text.
        let nameBytes = bytes[nameStart..<nameEnd].drop { $0 < 0x20 }
        let name = String(decoding: nameBytes, as: UTF8.self)
        return name.isEmpty ? nil : name
    }

    private func parsePMT(_ payload: UnsafeBufferPointer<UInt8>) {
        guard let table = section(payload), table.count >= 16, table[0] == 0x02 else { return }
        let programInfoLength = Int(table[10] & 0x0F) << 8 | Int(table[11])
        var index = 12 + programInfoLength
        let end = table.count - 4
        var found: [UInt16: ElementaryStreamKind] = [:]
        while index + 5 <= end {
            let kind = ElementaryStreamKind(streamType: table[index])
            let pid = UInt16(table[index + 1] & 0x1F) << 8 | UInt16(table[index + 2])
            found[pid] = kind
            index += 5 + (Int(table[index + 3] & 0x0F) << 8 | Int(table[index + 4]))
        }
        for (pid, kind) in found where kind == .h264 || kind == .aac || kind == .mpegAudio {
            if assemblies[pid]?.kind != kind { assemblies[pid] = Assembly(kind: kind) }
        }
        for pid in assemblies.keys where found[pid] == nil { assemblies[pid] = nil }
    }

    private func appendPES(pid: UInt16, unitStart: Bool, payload: UnsafeBufferPointer<UInt8>) {
        guard var assembly = assemblies[pid] else { return }
        if unitStart {
            flush(&assembly)
            guard payload.count >= 9, payload[0] == 0, payload[1] == 0, payload[2] == 1 else {
                assemblies[pid] = assembly
                return
            }
            assembly.started = true
            let headerLength = Int(payload[8])
            if payload[7] & 0x80 != 0, payload.count >= 14 {
                assembly.presentationTime = Self.timestamp(payload, at: 9)
            }
            let start = 9 + headerLength
            if start < payload.count { assembly.buffer.append(contentsOf: payload[start...]) }
        } else if assembly.started {
            assembly.buffer.append(contentsOf: payload)
        }
        assemblies[pid] = assembly
    }

    private func flush(_ assembly: inout Assembly) {
        guard !assembly.buffer.isEmpty else { return }
        onUnit?(PESUnit(kind: assembly.kind, presentationTime: assembly.presentationTime, data: assembly.buffer))
        assembly.buffer = Data()
        assembly.presentationTime = nil
    }

    private static func timestamp(_ bytes: UnsafeBufferPointer<UInt8>, at offset: Int) -> UInt64 {
        var value = UInt64(bytes[offset] >> 1 & 0x07) << 30
        value |= UInt64(bytes[offset + 1]) << 22
        value |= UInt64(bytes[offset + 2] >> 1) << 15
        value |= UInt64(bytes[offset + 3]) << 7
        value |= UInt64(bytes[offset + 4] >> 1)
        return value
    }
}

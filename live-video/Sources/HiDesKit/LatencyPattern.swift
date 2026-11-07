import Foundation

/// A frame ID drawn as large black and white blocks, chosen to survive H.264 compression.
///
/// The grid carries 12 ID bits and a 4-bit check, so a frame caught mid-change is rejected.
public enum LatencyPattern {
    public static let gridSize = 4
    public static let idCount = 4096

    private static func check(_ id: Int) -> Int {
        (id ^ (id >> 4) ^ (id >> 8) ^ 0x5) & 0xF
    }

    /// The 16 cell states, row by row, most significant bit first.
    public static func cells(id: Int) -> [Bool] {
        let word = (id & 0xFFF) << 4 | check(id & 0xFFF)
        return (0..<16).map { word >> (15 - $0) & 1 == 1 }
    }

    /// Reads an ID from an 8-bit luma plane, or nil if any cell is ambiguous or the check fails.
    public static func decode(luma: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int) -> Int? {
        var word = 0
        for index in 0..<16 {
            let x = (index % gridSize) * width / gridSize + width / (gridSize * 2)
            let y = (index / gridSize) * height / gridSize + height / (gridSize * 2)
            let value = Int(luma[y * bytesPerRow + x])
            guard value < 80 || value > 170 else { return nil }
            word = word << 1 | (value > 170 ? 1 : 0)
        }
        let id = word >> 4
        return word & 0xF == check(id) ? id : nil
    }
}

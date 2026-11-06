import Testing
@testable import HiDesKit

private func render(_ cells: [Bool], width: Int = 1280, height: Int = 720) -> [UInt8] {
    var luma = [UInt8](repeating: 0, count: width * height)
    for y in 0..<height {
        for x in 0..<width {
            let index = y * 4 / height * 4 + x * 4 / width
            luma[y * width + x] = cells[index] ? 235 : 16
        }
    }
    return luma
}

@Test func patternRoundTripsEveryKindOfID() {
    for id in [0, 1, 255, 1024, 4095] {
        let luma = render(LatencyPattern.cells(id: id))
        #expect(LatencyPattern.decode(luma: luma, width: 1280, height: 720, bytesPerRow: 1280) == id)
    }
}

@Test func patternRejectsOrdinaryPictures() {
    let black = [UInt8](repeating: 16, count: 1280 * 720)
    #expect(LatencyPattern.decode(luma: black, width: 1280, height: 720, bytesPerRow: 1280) == nil)
    let gray = [UInt8](repeating: 128, count: 1280 * 720)
    #expect(LatencyPattern.decode(luma: gray, width: 1280, height: 720, bytesPerRow: 1280) == nil)
    // One flipped cell fails the check.
    var cells = LatencyPattern.cells(id: 77)
    cells[3].toggle()
    let flipped = render(cells)
    #expect(LatencyPattern.decode(luma: flipped, width: 1280, height: 720, bytesPerRow: 1280) == nil)
}

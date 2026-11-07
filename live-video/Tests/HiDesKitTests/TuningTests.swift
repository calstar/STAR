import CIT930x
import Testing

private func plan(_ mixer: hides_mixer, rf: UInt32, lo1: UInt32 = 1_800_000, lo2: UInt32 = 1_900_000) -> (UInt32, hides_tune_plan) {
    var result = hides_tune_plan()
    let code = hides_rx_plan_tune(mixer, lo1, lo2, rf, &result)
    return (code, result)
}

@Test func directPathAtOrBelow950MHz() {
    let (code, result) = plan(HIDES_MIXER_ADRF6655, rf: 950_000)
    #expect(code == 0)
    #expect(result.if_khz == 950_000)
    #expect(result.use_mixer == 0)
}

@Test func lowerBandUsesLO1AndAbsoluteDifference() {
    let (code, result) = plan(HIDES_MIXER_ADRF6655, rf: 1_265_000)
    #expect(code == 0)
    #expect(result.use_mixer == 1)
    #expect(result.use_lo1_path == 1)
    #expect(result.lo_khz == 1_800_000)
    #expect(result.if_khz == 535_000)
}

@Test func upperBandUsesLO2() {
    let (code, result) = plan(HIDES_MIXER_ADRF6655, rf: 2_400_000)
    #expect(code == 0)
    #expect(result.use_lo1_path == 0)
    #expect(result.if_khz == 500_000)
}

@Test func unimplementedMixersAndMissingLOFailClearly() {
    #expect(plan(HIDES_MIXER_RFFC2072, rf: 1_265_000).0 == HIDES_ERR_UNSUPPORTED_MIXER)
    #expect(plan(HIDES_MIXER_NONE, rf: 1_265_000).0 == HIDES_ERR_UNSUPPORTED_MIXER)
    #expect(plan(HIDES_MIXER_ADRF6655, rf: 1_265_000, lo1: 0).0 == HIDES_ERR_NO_LO)
    #expect(plan(HIDES_MIXER_RFFC2072, rf: 666_000).0 == 0)
}

@Test func rffc2071TunesThisBoardsLowerBand() {
    // The values rx-info reports for this UT-130: LO1 1.8 GHz, LO2 1.05 GHz.
    let (code, result) = plan(HIDES_MIXER_RFFC2071, rf: 1_265_000, lo1: 1_800_000, lo2: 1_050_000)
    #expect(code == 0)
    #expect(result.use_mixer == 1)
    #expect(result.use_lo1_path == 1)
    #expect(result.if_khz == 535_000)
}

@Test func rffc2071LOForEEPROMDefault() {
    // Worked by hand from the driver: VCO 3.6 GHz, prescaler 4, divider 2, N 34, fraction 0.6153.
    var registers: [UInt16] = [0, 0, 0]
    hides_rffc2071_lo_registers(1_800_000, &registers)
    #expect(registers == [0x111A, 0x9D84, 0x4D00])
    let n = Double(registers[0] >> 7)
    let fraction = (Double(registers[1]) * 256 + Double(registers[2] >> 8)) / 16_777_216
    let lo = 26.0 * 4 * (n + fraction) / 2
    #expect(abs(lo - 1800) < 0.01)
}

//! LoRa link arithmetic for the Config tab.
//!
//! Time on air: Semtech SX1261/2 datasheet Rev 2.2, §6.1.4 "LoRa Time-on-Air".
//! Sensitivity: the usual estimate -174 + 10 log10(BW) + NF + SNR_limit(SF),
//! with NF = 6 dB and the demodulator SNR limits of the datasheet's §6.1.1.1
//! table; it lands within ~1 dB of the datasheet's sensitivity table at 125 kHz
//! (SF7 -124 dBm, SF12 -137 dBm). An estimate, labelled as one in the app.

pub const NOISE_FIGURE_DB: f64 = 6.0;
/// Low-data-rate optimisation required at or above this symbol time (datasheet §6.1.1.4).
pub const LDRO_SYMBOL_MS: f64 = 16.38;

pub fn snr_limit_db(sf: i64) -> f64 {
    // -2.5 dB per SF step from SF5 (-2.5) to SF12 (-20)
    -2.5 * (sf - 4) as f64
}

#[derive(Clone, Copy, Debug)]
pub struct LinkFigures {
    pub symbol_ms: f64,
    pub ldro: bool,
    pub time_on_air_ms: f64,
    pub bitrate_bps: f64,
    pub sensitivity_dbm: f64,
    pub max_packets_per_s: f64,
}

fn symbol_ms(sf: i64, bw_hz: i64) -> f64 {
    (1u64 << sf) as f64 / bw_hz as f64 * 1000.0
}

/// `cr` is the denominator (5..8 for 4/5..4/8). Explicit header, CRC on.
pub fn time_on_air_ms(sf: i64, bw_hz: i64, cr: i64, preamble: i64, payload: i64) -> f64 {
    let tsym = symbol_ms(sf, bw_hz);
    let ldro = tsym >= LDRO_SYMBOL_MS;
    let (ih, crc_bits) = (0, 16); // explicit header, CRC on
    let cr_idx = cr - 4;
    let ceil_div = |a: i64, b: i64| -> i64 { (a as f64 / b as f64).ceil() as i64 };
    let (n_payload, n_preamble) = if sf < 7 {
        // SF5/SF6: different preamble and no LDRO term
        let num = 8 * payload + crc_bits - 4 * sf + 8 - 20 * ih;
        (8 + (ceil_div(num, 4 * sf) * (cr_idx + 4)).max(0), preamble as f64 + 6.25)
    } else {
        let de = if ldro { 2 } else { 0 };
        let num = 8 * payload + crc_bits - 4 * sf + 28 - 20 * ih;
        (8 + (ceil_div(num, 4 * (sf - de)) * (cr_idx + 4)).max(0), preamble as f64 + 4.25)
    };
    (n_preamble + n_payload as f64) * tsym
}

pub fn figures(sf: i64, bw_hz: i64, cr: i64, preamble: i64, payload: i64) -> LinkFigures {
    let tsym = symbol_ms(sf, bw_hz);
    let toa = time_on_air_ms(sf, bw_hz, cr, preamble, payload);
    LinkFigures {
        symbol_ms: tsym,
        ldro: tsym >= LDRO_SYMBOL_MS,
        time_on_air_ms: toa,
        bitrate_bps: sf as f64 * (4.0 / cr as f64) * bw_hz as f64 / (1u64 << sf) as f64,
        sensitivity_dbm: -174.0 + 10.0 * (bw_hz as f64).log10() + NOISE_FIGURE_DB + snr_limit_db(sf),
        max_packets_per_s: 1000.0 / toa,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_on_air_against_published_values() {
        // The Things Network airtime calculator (Semtech formula): explicit header,
        // CRC on, 8-symbol preamble, CR 4/5, BW 125 kHz.
        //   SF7, 10 B: 41.2 ms     SF12, 23 B: 1482.8 ms (LDRO on)
        assert!((time_on_air_ms(7, 125_000, 5, 8, 10) - 41.216).abs() < 0.01);
        assert!((time_on_air_ms(12, 125_000, 5, 8, 23) - 1482.75).abs() < 0.01);
    }

    #[test]
    fn sensitivity_estimate_near_datasheet() {
        // SX1261/2 datasheet: SF7/125 kHz about -124 dBm, SF12/125 kHz about -137 dBm.
        assert!((figures(7, 125_000, 5, 8, 10).sensitivity_dbm + 124.0).abs() < 1.5);
        assert!((figures(12, 125_000, 5, 8, 10).sensitivity_dbm + 137.0).abs() < 1.5);
        assert_eq!(snr_limit_db(5), -2.5);
        assert_eq!(snr_limit_db(12), -20.0);
    }

    #[test]
    fn ldro_threshold() {
        assert!(figures(11, 125_000, 5, 8, 10).ldro); // 16.38 ms symbols
        assert!(!figures(10, 125_000, 5, 8, 10).ldro);
        assert!(!figures(12, 500_000, 5, 8, 10).ldro);
    }
}

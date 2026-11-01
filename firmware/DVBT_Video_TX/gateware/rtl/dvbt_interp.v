// 4x interpolation, 48/7 -> 192/7 MS/s: gain/IQ trim, then two half-band
// stages (scripts/gen_halfband.py): 55 taps, 68 dB image rejection
// (images of the 2.854 MHz-wide signal start at 4.003 MHz), then 15 taps,
// 74 dB. Passband ripple under 0.003 dB. No multipliers in the filters.
// The even phase of each stage passes samples through exactly, so every
// fourth output is the (trimmed) input itself.
`default_nettype none

module dvbt_interp (
    input  wire               clk,
    input  wire               rst,
    input  wire        [15:0] gain_i,
    input  wire        [15:0] gain_q,
    input  wire signed [15:0] phase,
    input  wire signed [17:0] s_i,
    input  wire signed [17:0] s_q,
    input  wire               s_valid,
    output wire               s_ready,
    output wire signed [17:0] m_i,
    output wire signed [17:0] m_q,
    output wire               m_valid,
    input  wire               m_ready
);
    wire signed [17:0] a_i, a_q, b_i, b_q;
    wire               a_v, a_r, b_v, b_r;

    dvbt_iq_corr u_corr (
        .clk(clk), .rst(rst), .gain_i(gain_i), .gain_q(gain_q), .phase(phase),
        .s_i(s_i), .s_q(s_q), .s_valid(s_valid), .s_ready(s_ready),
        .m_i(a_i), .m_q(a_q), .m_valid(a_v), .m_ready(a_r)
    );

    // Coefficients centre pair outwards, packed with g_0 in the low bits.
    dvbt_halfband #(
        .K(14),
        .COEF({-18'sd48, 18'sd116, -18'sd247, 18'sd465, -18'sd804, 18'sd1309, -18'sd2034,
               18'sd3057, -18'sd4495, 18'sd6559, -18'sd9687, 18'sd15023, -18'sd26786, 18'sd83108})
    ) u_hb1 (
        .clk(clk), .rst(rst), .s_i(a_i), .s_q(a_q), .s_valid(a_v), .s_ready(a_r),
        .m_i(b_i), .m_q(b_q), .m_valid(b_v), .m_ready(b_r)
    );

    dvbt_halfband #(
        .K(4),
        .COEF({-18'sd688, 18'sd4574, -18'sd17916, 18'sd79566})
    ) u_hb2 (
        .clk(clk), .rst(rst), .s_i(b_i), .s_q(b_q), .s_valid(b_v), .s_ready(b_r),
        .m_i(m_i), .m_q(m_q), .m_valid(m_valid), .m_ready(m_ready)
    );
endmodule

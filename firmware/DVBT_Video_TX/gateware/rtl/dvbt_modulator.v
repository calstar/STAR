// The whole DVB-T modulator core: TS bytes in, baseband OFDM out.
//   dvbt_carrier_chain -> dvbt_ifft_in -> dvbt_fft2048 (as IFFT) -> dvbt_gi_insert
// Output: complex samples at the 6 MHz channel's 48/7 MS/s rate (once paced),
// each OFDM symbol 2048 + Ng samples, m_sos on its first. Scale: carriers
// at 1.0 = 8192 come out as sum(c_k e^(+j2pi kt/2048)) * 8192 / 32 (RMS
// about 10k, peaks under 40k of the 18-bit range). The interpolator and the
// DAC's gain trim follow.
// err_align: any stage saw a symbol boundary where it didn't expect one.
`default_nettype none

module dvbt_modulator (
    input  wire               clk,
    input  wire               rst,
    input  wire         [2:0] cfg_rate,
    input  wire         [1:0] cfg_mod,
    input  wire         [1:0] cfg_guard,
    input  wire         [7:0] s_data,
    input  wire               s_sop,
    input  wire               s_valid,
    output wire               s_ready,
    output wire signed [17:0] m_i,
    output wire signed [17:0] m_q,
    output wire               m_sos,
    output wire               m_valid,
    input  wire               m_ready,
    output wire               err_align
);
    wire signed [15:0] c_i, c_q;
    wire               c_sos, c_sof, c_valid, c_ready, c_err;
    wire signed [17:0] b_re, b_im, f_re, f_im;
    wire               b_first, b_valid, b_ready, b_err;
    wire               f_first, f_valid, f_ready, g_err;

    dvbt_carrier_chain u_car (
        .clk(clk), .rst(rst), .cfg_rate(cfg_rate), .cfg_mod(cfg_mod), .cfg_guard(cfg_guard),
        .s_data(s_data), .s_sop(s_sop), .s_valid(s_valid), .s_ready(s_ready),
        .m_i(c_i), .m_q(c_q), .m_sos(c_sos), .m_sof(c_sof), .m_valid(c_valid),
        .m_ready(c_ready), .err_align(c_err)
    );

    dvbt_ifft_in u_in (
        .clk(clk), .rst(rst),
        .s_i(c_i), .s_q(c_q), .s_sos(c_sos), .s_valid(c_valid), .s_ready(c_ready),
        .m_re(b_re), .m_im(b_im), .m_first(b_first), .m_valid(b_valid), .m_ready(b_ready),
        .err_align(b_err)
    );

    // b_first is implied: the FFT counts its own blocks from reset.
    dvbt_fft2048 u_fft (
        .clk(clk), .rst(rst),
        .s_re(b_re), .s_im(b_im), .s_valid(b_valid), .s_ready(b_ready),
        .m_re(f_re), .m_im(f_im), .m_first(f_first), .m_valid(f_valid), .m_ready(f_ready)
    );

    dvbt_gi_insert u_gi (
        .clk(clk), .rst(rst), .cfg_guard(cfg_guard),
        .s_re(f_re), .s_im(f_im), .s_first(f_first), .s_valid(f_valid), .s_ready(f_ready),
        .m_i(m_i), .m_q(m_q), .m_sos(m_sos), .m_valid(m_valid), .m_ready(m_ready),
        .err_align(g_err)
    );

    assign err_align = c_err | b_err | g_err;

    /* verilator lint_off UNUSEDSIGNAL */
    wire unused = c_sof ^ b_first;
    /* verilator lint_on UNUSEDSIGNAL */
endmodule

`default_nettype wire

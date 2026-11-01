// TS bytes in, OFDM carriers out: dvbt_fec_chain -> mapper -> frame builder.
// Each OFDM symbol leaves as carriers k = 0..1704 (m_sos on k = 0, m_sof on
// the first symbol of a frame), 1.0 = 8192. The IFFT goes after this.
`default_nettype none

module dvbt_carrier_chain (
    input  wire               clk,
    input  wire               rst,
    input  wire         [2:0] cfg_rate,
    input  wire         [1:0] cfg_mod,
    input  wire         [1:0] cfg_guard,
    input  wire         [7:0] s_data,
    input  wire               s_sop,
    input  wire               s_valid,
    output wire               s_ready,
    output wire signed [15:0] m_i,
    output wire signed [15:0] m_q,
    output wire               m_sos,
    output wire               m_sof,
    output wire               m_valid,
    input  wire               m_ready,
    output wire               err_align
);
    wire        [5:0] fc_sym;
    wire              fc_sos, fc_valid, fc_ready;
    wire signed [15:0] mp_i, mp_q;
    wire              mp_sos, mp_valid, mp_ready;

    dvbt_fec_chain u_fec (
        .clk(clk), .rst(rst), .cfg_rate(cfg_rate), .cfg_mod(cfg_mod),
        .s_data(s_data), .s_sop(s_sop), .s_valid(s_valid), .s_ready(s_ready),
        .m_sym(fc_sym), .m_valid(fc_valid), .m_sos(fc_sos), .m_ready(fc_ready)
    );

    dvbt_mapper u_map (
        .clk(clk), .rst(rst), .cfg_mod(cfg_mod),
        .s_sym(fc_sym), .s_sos(fc_sos), .s_valid(fc_valid), .s_ready(fc_ready),
        .m_i(mp_i), .m_q(mp_q), .m_sos(mp_sos), .m_valid(mp_valid), .m_ready(mp_ready)
    );

    dvbt_frame_builder u_frame (
        .clk(clk), .rst(rst), .cfg_mod(cfg_mod), .cfg_rate(cfg_rate), .cfg_guard(cfg_guard),
        .s_i(mp_i), .s_q(mp_q), .s_sos(mp_sos), .s_valid(mp_valid), .s_ready(mp_ready),
        .m_i(m_i), .m_q(m_q), .m_sos(m_sos), .m_sof(m_sof), .m_valid(m_valid),
        .m_ready(m_ready), .err_align(err_align)
    );
endmodule

`default_nettype wire

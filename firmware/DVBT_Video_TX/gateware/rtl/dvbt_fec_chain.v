// The data path of the modulator up to the mapper, EN 300 744 §4.3.1-4.3.4:
// energy dispersal -> RS(204,188) -> outer interleaver -> inner coder ->
// bit interleaver -> symbol interleaver.
// TS packets in (s_sop on each sync byte); out, the 1512 data-carrier symbols
// of each OFDM symbol in carrier order (m_sos on the first), v bits each.
`default_nettype none

module dvbt_fec_chain (
    input  wire       clk,
    input  wire       rst,
    input  wire [2:0] cfg_rate,
    input  wire [1:0] cfg_mod,
    input  wire [7:0] s_data,
    input  wire       s_sop,
    input  wire       s_valid,
    output wire       s_ready,
    output wire [5:0] m_sym,
    output wire       m_valid,
    output wire       m_sos,
    input  wire       m_ready
);
    wire [5:0] ic_sym, bi_sym;
    wire       ic_valid, ic_ready, bi_valid, bi_ready;
    wire [7:0] ed_data, rs_data, oi_data;
    wire       ed_sop, ed_valid, ed_ready;
    wire       rs_valid, rs_ready;
    /* verilator lint_off UNUSEDSIGNAL */
    wire       rs_sop;  // not needed downstream, see below
    /* verilator lint_on UNUSEDSIGNAL */
    wire       oi_valid, oi_ready;

    dvbt_energy_dispersal u_ed (
        .clk(clk), .rst(rst),
        .s_data(s_data), .s_sop(s_sop), .s_valid(s_valid), .s_ready(s_ready),
        .m_data(ed_data), .m_sop(ed_sop), .m_valid(ed_valid), .m_ready(ed_ready)
    );

    dvbt_rs_encoder u_rs (
        .clk(clk), .rst(rst),
        .s_data(ed_data), .s_sop(ed_sop), .s_valid(ed_valid), .s_ready(ed_ready),
        .m_data(rs_data), .m_sop(rs_sop), .m_valid(rs_valid), .m_ready(rs_ready)
    );

    // rs_sop is not needed: the interleaver's commutator stays aligned to
    // 204-byte packets once started on the first one.
    dvbt_outer_interleaver u_oi (
        .clk(clk), .rst(rst),
        .s_data(rs_data), .s_valid(rs_valid), .s_ready(rs_ready),
        .m_data(oi_data), .m_valid(oi_valid), .m_ready(oi_ready)
    );

    dvbt_inner_coder u_ic (
        .clk(clk), .rst(rst), .cfg_rate(cfg_rate), .cfg_mod(cfg_mod),
        .s_data(oi_data), .s_valid(oi_valid), .s_ready(oi_ready),
        .m_sym(ic_sym), .m_valid(ic_valid), .m_ready(ic_ready)
    );

    dvbt_bit_interleaver u_bi (
        .clk(clk), .rst(rst), .cfg_mod(cfg_mod),
        .s_sym(ic_sym), .s_valid(ic_valid), .s_ready(ic_ready),
        .m_sym(bi_sym), .m_valid(bi_valid), .m_ready(bi_ready)
    );

    dvbt_symbol_interleaver u_si (
        .clk(clk), .rst(rst),
        .s_sym(bi_sym), .s_valid(bi_valid), .s_ready(bi_ready),
        .m_sym(m_sym), .m_valid(m_valid), .m_sos(m_sos), .m_ready(m_ready)
    );
endmodule

`default_nettype wire

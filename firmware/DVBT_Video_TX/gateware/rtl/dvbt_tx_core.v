// The transmitter, pins to pins (less the PLL and the clock forwarding):
//   ESP32-P4 SPI -> dvbt_host (registers, TS FIFO, null packets)
//     -> dvbt_modulator (TS -> OFDM at 48/7 MS/s)
//     -> sample FIFO (512) -> dvbt_interp (trims, 4x) -> dvbt_dac_out (AD9116)
// Everything runs on the one 27.43 MHz clock, paced by the DAC: it takes a
// sample every clock, the interpolator one every 4, and backpressure
// carries that pace up to the TS FIFO, whose DREQ paces the ESP32.
//
// tx_en low resets the modulator, the sample FIFO and the interpolator (the
// DAC holds mid-scale). After tx_en rises the DAC starts when the sample
// FIFO is half full, so the modulator's burstiness (it works a symbol at a
// time) never reaches the DAC.
`default_nettype none

module dvbt_tx_core (
    input  wire        clk,
    input  wire        rst,
    input  wire        spi_sck,
    input  wire        spi_cs_n,
    input  wire        spi_mosi,
    output wire        spi_miso,
    output wire        dreq,
    output wire [11:0] dac_d,
    output wire        sm_sclk,
    output wire        sm_sdo,
    output wire        sm_sdo_oe,
    input  wire        sm_sdio_in,
    input  wire        sm_miso,
    output wire  [1:0] sm_cs_n,
    output wire  [3:0] gpio,
    output wire        tx_on
);
    wire        tx_en, cfg_obin, cfg_swap;
    wire  [1:0] cfg_mod, cfg_guard;
    wire  [2:0] cfg_rate;
    wire [15:0] gain_i, gain_q, phase;
    wire [11:0] off_i, off_q;
    wire  [7:0] ts_data;
    wire        ts_sop, ts_valid, ts_ready;
    wire        underflow, err_align;

    // Datapath reset: system reset or transmitter off.
    reg dp_rst;
    always @(posedge clk) dp_rst <= rst || !tx_en;
    assign tx_on = !dp_rst;

    dvbt_host u_host (
        .clk(clk), .rst(rst),
        .spi_sck(spi_sck), .spi_cs_n(spi_cs_n), .spi_mosi(spi_mosi), .spi_miso(spi_miso),
        .dreq(dreq),
        .ts_data(ts_data), .ts_sop(ts_sop), .ts_valid(ts_valid), .ts_ready(ts_ready),
        .ts_rst(dp_rst),
        .tx_en(tx_en), .cfg_mod(cfg_mod), .cfg_rate(cfg_rate), .cfg_guard(cfg_guard),
        .cfg_obin(cfg_obin), .cfg_swap(cfg_swap), .gain_i(gain_i), .gain_q(gain_q),
        .phase(phase), .off_i(off_i), .off_q(off_q),
        .st_underflow(underflow), .st_align(err_align),
        .sm_sclk(sm_sclk), .sm_sdo(sm_sdo), .sm_sdo_oe(sm_sdo_oe), .sm_sdio_in(sm_sdio_in),
        .sm_miso(sm_miso), .sm_cs_n(sm_cs_n), .gpio(gpio)
    );

    wire signed [17:0] o_i, o_q;
    wire               o_valid, o_ready, o_sos;
    dvbt_modulator u_mod (
        .clk(clk), .rst(dp_rst), .cfg_rate(cfg_rate), .cfg_mod(cfg_mod), .cfg_guard(cfg_guard),
        .s_data(ts_data), .s_sop(ts_sop), .s_valid(ts_valid), .s_ready(ts_ready),
        .m_i(o_i), .m_q(o_q), .m_sos(o_sos), .m_valid(o_valid), .m_ready(o_ready),
        .err_align(err_align)
    );

    wire [35:0] q_data;
    wire        q_valid, q_ready;
    wire  [9:0] q_level, q_free;
    reg         primed;
    dvbt_fifo #(.W(36), .AW(9)) u_sq (
        .clk(clk), .rst(dp_rst), .s_data({o_i, o_q}), .s_valid(o_valid), .s_ready(o_ready),
        .w_commit(1'b1), .w_abort(1'b0),
        .m_data(q_data), .m_valid(q_valid), .m_ready(q_ready && primed),
        .level(q_level), .free(q_free)
    );

    always @(posedge clk)
        if (dp_rst) primed <= 1'b0;
        else if (q_level >= 10'd256) primed <= 1'b1;

    wire signed [17:0] u_i, u_q;
    wire               u_valid, u_ready;
    dvbt_interp u_int (
        .clk(clk), .rst(dp_rst), .gain_i(gain_i), .gain_q(gain_q), .phase(phase),
        .s_i(q_data[35:18]), .s_q(q_data[17:0]), .s_valid(q_valid && primed), .s_ready(q_ready),
        .m_i(u_i), .m_q(u_q), .m_valid(u_valid), .m_ready(u_ready)
    );

    wire signed [11:0] d_i, d_q;
    dvbt_dac_out u_dac (
        .clk(clk), .rst(dp_rst), .tx_en(tx_en), .cfg_off_i(off_i), .cfg_off_q(off_q),
        .cfg_obin(cfg_obin), .cfg_swap(cfg_swap),
        .s_i(u_i), .s_q(u_q), .s_valid(u_valid), .s_ready(u_ready),
        .o_i(d_i), .o_q(d_q), .dac_d(dac_d), .err_underflow(underflow)
    );

    wire unused = &{1'b0, o_sos, q_free, d_i, d_q};
endmodule

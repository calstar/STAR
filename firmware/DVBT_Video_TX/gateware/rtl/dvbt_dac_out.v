// The AD9116 data port: 12 bits, I and Q interleaved on the two edges of
// the 27.43 MHz clock (ECP5 ODDRX1F per pin: D0 out while clk is high, D1
// while low).
//
// Each 18-bit sample is rounded to 12 bits (/64, half up), offset by the
// DC trims (cancel the quadrature modulator's LO leakage), saturated to
// -2047..2047, and sent as two's complement or offset binary (cfg_obin,
// MSB inverted). cfg_swap puts Q on D0. AD9116 datasheet to confirm: which
// edge carries I, and the power-up data format.
//
// The DAC takes a sample every clock: s_ready is always 1. Until the first
// sample arrives, and whenever tx_en is low, it holds mid-scale. After the
// first sample a clock without one is an underflow: mid-scale again, and
// err_underflow latches (cleared by reset).
`default_nettype none
/* verilator lint_off BLKSEQ */       // r, v: temporaries inside a function
/* verilator lint_off UNUSEDSIGNAL */ // r[5:0]: rounded away

module dvbt_dac_out (
    input  wire               clk,
    input  wire               rst,
    input  wire               tx_en,
    input  wire signed [11:0] cfg_off_i,
    input  wire signed [11:0] cfg_off_q,
    input  wire               cfg_obin,
    input  wire               cfg_swap,
    input  wire signed [17:0] s_i,
    input  wire signed [17:0] s_q,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [11:0] o_i,      // the sample on the pins (for test and status)
    output reg  signed [11:0] o_q,
    output wire        [11:0] dac_d,
    output reg                err_underflow
);
    assign s_ready = 1'b1;

    function signed [11:0] to12(input signed [17:0] x, input signed [11:0] off);
        reg signed [18:0] r;
        reg signed [13:0] v;
        begin
            r = {x[17], x} + 19'sd32;
            v = {r[18], r[18:6]} + {{2{off[11]}}, off};
            to12 = (v > 14'sd2047) ? 12'sd2047 : (v < -14'sd2047) ? -12'sd2047 : v[11:0];
        end
    endfunction

    reg armed;
    always @(posedge clk) begin
        if (rst) begin
            armed <= 1'b0;
            err_underflow <= 1'b0;
            o_i <= 12'sd0;
            o_q <= 12'sd0;
        end else begin
            if (s_valid) armed <= 1'b1;
            if (armed && !s_valid && tx_en) err_underflow <= 1'b1;
            if (s_valid && tx_en) begin
                o_i <= to12(s_i, cfg_off_i);
                o_q <= to12(s_q, cfg_off_q);
            end else begin
                o_i <= 12'sd0;
                o_q <= 12'sd0;
            end
        end
    end

    wire [11:0] fmt = {cfg_obin, 11'd0};
    wire [11:0] d0 = (cfg_swap ? o_q : o_i) ^ fmt;
    wire [11:0] d1 = (cfg_swap ? o_i : o_q) ^ fmt;
    genvar b;
    generate
        for (b = 0; b < 12; b = b + 1) begin : g_ddr
            ODDRX1F u_oddr (.SCLK(clk), .RST(rst), .D0(d0[b]), .D1(d1[b]), .Q(dac_d[b]));
        end
    endgenerate
endmodule

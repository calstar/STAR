// EN 300 744 §4.4-4.6 frame structure, 2K mode: puts the 1512 data cells of
// each OFDM symbol on carriers 0..1704 with the reference signals.
//
// Per carrier k of symbol l (0..67) of frame f (0..3):
//   continual pilot  (45 fixed k, Table 7)      Re = 4/3 * 2(1/2 - w_k)
//   scattered pilot  k = 3 (l mod 4) + 12 p      Re = 4/3 * 2(1/2 - w_k)
//   TPS              (17 fixed k, Table 8)      Re = +-2(1/2 - w_k), DBPSK
//   anything else    the next data cell, in order
// w_k is the PRBS x^11 + x^2 + 1 (all ones at k = 0), one bit per carrier.
// The TPS differential modulation restarts at the first symbol of every frame
// (value 2(1/2 - w_k)); in symbol l it is flipped by s_1 ^ ... ^ s_l.
//
// TPS block (68 bits, §4.6): s0 reference, s1-s16 sync word (inverted on odd f),
// s17-s22 length 23, s23-s24 frame number, s25-s26 constellation, s27-s29
// hierarchy (none), s30-s32 HP code rate, s33-s35 LP code rate (= HP here, as
// configured in the golden model), s36-s37 guard, s38-s39 2K, s40-s53 zero (no
// cell id, no DVB-H), s54-s67 BCH(67,53) parity.
//
// Output: carriers k = 0..1704 in order, m_sos on k = 0, m_sof on k = 0 of
// l = 0. Scale 1.0 = 8192, as the mapper. All counters start at reset, as
// gr-dtv's do, and so do the upstream interleavers, so data cells and carriers
// line up from the first symbol. s_sos is only checked: err_align goes high
// (sticky until reset) if a symbol's first data cell is not marked s_sos or a
// marked one arrives anywhere else.
`default_nettype none

module dvbt_frame_builder (
    input  wire               clk,
    input  wire               rst,
    input  wire         [1:0] cfg_mod,    // TPS constellation field
    input  wire         [2:0] cfg_rate,   // TPS code rate fields
    input  wire         [1:0] cfg_guard,  // 0 1/32, 1 1/16, 2 1/8, 3 1/4
    input  wire signed [15:0] s_i,
    input  wire signed [15:0] s_q,
    input  wire               s_sos,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [15:0] m_i,
    output reg  signed [15:0] m_q,
    output reg                m_sos,
    output reg                m_sof,
    output reg                m_valid,
    input  wire               m_ready,
    output reg                err_align
);
    localparam signed [15:0] PILOT = 16'sd10923;  // 4/3
    localparam signed [15:0] TPSV = 16'sd8192;    // 1

    function [10:0] cp_pos(input [5:0] n);  // continual pilots, Table 7 (2K)
        case (n)
            0: cp_pos = 0;      1: cp_pos = 48;     2: cp_pos = 54;     3: cp_pos = 87;
            4: cp_pos = 141;    5: cp_pos = 156;    6: cp_pos = 192;    7: cp_pos = 201;
            8: cp_pos = 255;    9: cp_pos = 279;   10: cp_pos = 282;   11: cp_pos = 333;
           12: cp_pos = 432;   13: cp_pos = 450;   14: cp_pos = 483;   15: cp_pos = 525;
           16: cp_pos = 531;   17: cp_pos = 618;   18: cp_pos = 636;   19: cp_pos = 714;
           20: cp_pos = 759;   21: cp_pos = 765;   22: cp_pos = 780;   23: cp_pos = 804;
           24: cp_pos = 873;   25: cp_pos = 888;   26: cp_pos = 918;   27: cp_pos = 939;
           28: cp_pos = 942;   29: cp_pos = 969;   30: cp_pos = 984;   31: cp_pos = 1050;
           32: cp_pos = 1101;  33: cp_pos = 1107;  34: cp_pos = 1110;  35: cp_pos = 1137;
           36: cp_pos = 1140;  37: cp_pos = 1146;  38: cp_pos = 1206;  39: cp_pos = 1269;
           40: cp_pos = 1323;  41: cp_pos = 1377;  42: cp_pos = 1491;  43: cp_pos = 1683;
           44: cp_pos = 1704;  default: cp_pos = 11'h7ff;
        endcase
    endfunction

    function [10:0] tps_pos(input [4:0] n);  // TPS carriers, Table 8 (2K)
        case (n)
            0: tps_pos = 34;     1: tps_pos = 50;     2: tps_pos = 209;    3: tps_pos = 346;
            4: tps_pos = 413;    5: tps_pos = 569;    6: tps_pos = 595;    7: tps_pos = 688;
            8: tps_pos = 790;    9: tps_pos = 901;   10: tps_pos = 1073;  11: tps_pos = 1219;
           12: tps_pos = 1262;  13: tps_pos = 1286;  14: tps_pos = 1469;  15: tps_pos = 1594;
           16: tps_pos = 1687;  default: tps_pos = 11'h7ff;
        endcase
    endfunction

    // TPS bits s1..s67 of frame f, s1 in bit 66 (MSB first).
    /* verilator lint_off BLKSEQ */
    function [66:0] tps_block(input [1:0] f, input [1:0] md, input [2:0] cr, input [1:0] gi);
        reg [52:0] d;
        reg [13:0] r;
        reg        fb;
        integer n;
        begin
            d = {(f[0] ? 16'b1100101000010001 : 16'b0011010111101110),  // s1-s16
                 6'b010111,                                             // s17-s22
                 f, md, 3'b000, cr, cr, gi, 2'b00,                      // s23-s39
                 14'd0};                                                // s40-s53
            // BCH(67,53): remainder of d(x) x^14 mod
            // g(x) = x^14 + x^9 + x^8 + x^6 + x^5 + x^4 + x^2 + x + 1.
            r = 14'd0;
            for (n = 52; n >= 0; n = n - 1) begin
                fb = r[13] ^ d[n];
                r = {r[12:0], 1'b0} ^ (fb ? 14'b00_0011_0111_0111 : 14'd0);
            end
            tps_block = {d, r};
        end
    endfunction
    /* verilator lint_on BLKSEQ */

    reg [10:0] k;       // carrier
    reg  [6:0] l;       // symbol in frame
    reg  [1:0] f;       // frame in superframe
    reg  [3:0] m12;     // k mod 12
    reg  [5:0] cp_n;    // next continual pilot index
    reg  [4:0] tps_n;   // next TPS carrier index
    reg [10:0] w;       // PRBS, w[10] is the output bit for carrier k
    reg        tps_d;   // DBPSK state for this symbol
    reg        first;   // next data cell is the symbol's first

    wire [66:0] tps = tps_block(f, cfg_mod, cfg_rate, cfg_guard);
    // s_(l+1): the bit that sets the next symbol's differential flip.
    wire        s_next = (l < 7'd67) ? tps[7'd66 - l] : 1'b0;

    wire is_cp = (k == cp_pos(cp_n));
    wire is_tps = (k == tps_pos(tps_n));
    wire is_sp = ({1'b0, m12} == {2'b00, l[1:0], 1'b0} + {3'b000, l[1:0]});  // 3 (l mod 4)
    wire is_pilot = is_cp || is_sp;
    wire is_data = !is_pilot && !is_tps;
    wire wbit = w[10];

    wire out_free = !m_valid || m_ready;
    assign s_ready = out_free && is_data;
    wire go = out_free && (!is_data || s_valid);

    always @(posedge clk) begin
        if (rst) begin
            k       <= 11'd0;
            l       <= 7'd0;
            f       <= 2'd0;
            m12     <= 4'd0;
            cp_n    <= 6'd0;
            tps_n   <= 5'd0;
            w       <= 11'h7ff;
            tps_d   <= 1'b0;
            first   <= 1'b1;
            err_align <= 1'b0;
            m_valid <= 1'b0;
            m_i     <= 16'sd0;
            m_q     <= 16'sd0;
            m_sos   <= 1'b0;
            m_sof   <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (go) begin
                m_valid <= 1'b1;
                if (is_data) begin
                    first <= 1'b0;
                    if (s_sos != first) err_align <= 1'b1;
                end
                m_sos   <= (k == 11'd0);
                m_sof   <= (k == 11'd0) && (l == 7'd0);
                if (is_pilot) begin
                    m_i <= wbit ? -PILOT : PILOT;
                    m_q <= 16'sd0;
                end else if (is_tps) begin
                    m_i <= (wbit ^ tps_d) ? -TPSV : TPSV;
                    m_q <= 16'sd0;
                end else begin
                    m_i <= s_i;
                    m_q <= s_q;
                end
                if (is_cp) cp_n <= cp_n + 6'd1;
                if (is_tps) tps_n <= tps_n + 5'd1;
                w   <= {w[9:0], w[10] ^ w[8]};
                m12 <= (m12 == 4'd11) ? 4'd0 : m12 + 4'd1;
                k   <= k + 11'd1;
                if (k == 11'd1704) begin  // end of symbol
                    k     <= 11'd0;
                    m12   <= 4'd0;
                    cp_n  <= 6'd0;
                    tps_n <= 5'd0;
                    w     <= 11'h7ff;
                    first <= 1'b1;
                    if (l == 7'd67) begin
                        l     <= 7'd0;
                        f     <= f + 2'd1;
                        tps_d <= 1'b0;
                    end else begin
                        l     <= l + 7'd1;
                        tps_d <= tps_d ^ s_next;
                    end
                end
            end
        end
    end
endmodule

`default_nettype wire

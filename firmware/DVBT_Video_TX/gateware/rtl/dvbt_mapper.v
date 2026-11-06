// EN 300 744 §4.3.5 signal constellations and mapping (non-hierarchical).
//
// Input symbol bits y0..y(v-1), y0 in the MSB of the v-bit symbol (as the
// interleavers emit them). Gray mapping: y0 sets the sign of I, y1 the sign
// of Q; y2(,y4) pick I's magnitude and y3(,y5) Q's:
//   16QAM  y2 (y3):    0 -> 3, 1 -> 1
//   64QAM  y2 y4 (y3 y5): 00 -> 7, 01 -> 5, 11 -> 3, 10 -> 1
// Normalised to unit average power (/sqrt 2, /sqrt 10, /sqrt 42), as gr-dtv
// does, then scaled so 1.0 = 8192 (signed 16-bit, room for the 4/3 pilots).
`default_nettype none

module dvbt_mapper (
    input  wire              clk,
    input  wire              rst,
    input  wire        [1:0] cfg_mod,   // 0 QPSK, 1 16QAM, 2 64QAM
    input  wire        [5:0] s_sym,
    input  wire              s_sos,
    input  wire              s_valid,
    output wire              s_ready,
    output reg signed [15:0] m_i,
    output reg signed [15:0] m_q,
    output reg               m_sos,
    output reg               m_valid,
    input  wire              m_ready
);
    // round(8192 * level / sqrt(norm)) from scripts/gen_mapper_levels.py
    localparam signed [15:0] QPSK_1 = 16'sd5793;
    localparam signed [15:0] QAM16_1 = 16'sd2591, QAM16_3 = 16'sd7772;
    localparam signed [15:0] QAM64_1 = 16'sd1264, QAM64_3 = 16'sd3792;
    localparam signed [15:0] QAM64_5 = 16'sd6320, QAM64_7 = 16'sd8848;

    // Magnitude for one axis from its magnitude bits (a = y2/y3, b = y4/y5).
    function signed [15:0] mag(input [1:0] md, input a, input b);
        case (md)
            2'd1:    mag = a ? QAM16_1 : QAM16_3;
            2'd2:    case ({a, b})
                         2'b00:   mag = QAM64_7;
                         2'b01:   mag = QAM64_5;
                         2'b11:   mag = QAM64_3;
                         default: mag = QAM64_1;
                     endcase
            default: mag = QPSK_1;
        endcase
    endfunction

    // y0..y5 from the packed symbol.
    reg [5:0] y;  // y[0] = y0
    always @* begin
        case (cfg_mod)
            2'd2:    y = {s_sym[0], s_sym[1], s_sym[2], s_sym[3], s_sym[4], s_sym[5]};
            2'd1:    y = {2'b00, s_sym[0], s_sym[1], s_sym[2], s_sym[3]};
            default: y = {4'b0000, s_sym[0], s_sym[1]};
        endcase
    end

    wire signed [15:0] mi = mag(cfg_mod, y[2], y[4]);
    wire signed [15:0] mq = mag(cfg_mod, y[3], y[5]);

    assign s_ready = !m_valid || m_ready;

    always @(posedge clk) begin
        if (rst) begin
            m_valid <= 1'b0;
            m_i     <= 16'sd0;
            m_q     <= 16'sd0;
            m_sos   <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (s_valid && s_ready) begin
                m_valid <= 1'b1;
                m_sos   <= s_sos;
                m_i     <= y[0] ? -mi : mi;
                m_q     <= y[1] ? -mq : mq;
            end
        end
    end
endmodule

`default_nettype wire

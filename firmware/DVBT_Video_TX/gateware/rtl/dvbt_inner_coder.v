// EN 300 744 §4.3.4 inner code: K = 7 convolutional code, G1 = 171o (X),
// G2 = 133o (Y), punctured to the configured rate, then packed into
// constellation-sized symbols.
//
// Bytes enter MSB first. Per input bit the encoder emits X then Y; the
// puncturing pattern (Table 2) keeps some of them. The surviving bits are
// grouped v at a time (v = 2, 4, 6 for QPSK, 16QAM, 64QAM), the first bit in
// the symbol's MSB -- the same packing as gr-dtv's dvbt_inner_coder, so the
// bit interleaver downstream can be checked against gr-dtv stage by stage.
//
// The encoder state and the puncturing phase start at zero on reset and never
// restart: the code is continuous across packets, as in the standard.
//
// cfg_rate: 0 = 1/2, 1 = 2/3, 2 = 3/4, 3 = 5/6, 4 = 7/8.
// cfg_mod:  0 = QPSK, 1 = 16QAM, 2 = 64QAM.
// Change them only while in reset.
`default_nettype none

module dvbt_inner_coder (
    input  wire       clk,
    input  wire       rst,
    input  wire [2:0] cfg_rate,
    input  wire [1:0] cfg_mod,
    input  wire [7:0] s_data,
    input  wire       s_valid,
    output wire       s_ready,
    output reg  [5:0] m_sym,
    output reg        m_valid,
    input  wire       m_ready
);
    // Puncturing patterns, bit p = input bit p of the period (Table 2).
    reg [2:0] period;
    reg [6:0] keep_x, keep_y;
    always @* begin
        case (cfg_rate)
            3'd1:    begin period = 3'd2; keep_x = 7'b0000001; keep_y = 7'b0000011; end  // 2/3: X 10, Y 11
            3'd2:    begin period = 3'd3; keep_x = 7'b0000101; keep_y = 7'b0000011; end  // 3/4: X 101, Y 110
            3'd3:    begin period = 3'd5; keep_x = 7'b0010101; keep_y = 7'b0001011; end  // 5/6: X 10101, Y 11010
            3'd4:    begin period = 3'd7; keep_x = 7'b1010001; keep_y = 7'b0101111; end  // 7/8: X 1000101, Y 1111010
            default: begin period = 3'd1; keep_x = 7'b0000001; keep_y = 7'b0000001; end  // 1/2
        endcase
    end

    wire [2:0] v = (cfg_mod == 2'd2) ? 3'd6 : (cfg_mod == 2'd1) ? 3'd4 : 3'd2;

    reg [7:0] byte_sr;    // remaining bits of the current byte, MSB next
    reg [3:0] bits_left;  // 0 = need a new byte
    reg [5:0] sr;         // encoder memory, sr[0] = previous input bit
    reg [2:0] phase;      // puncturing position
    reg [7:0] acc;        // collected output bits, newest in the LSB
    reg [3:0] acc_n;      // how many of acc's low bits are pending

    assign s_ready = (bits_left == 4'd0);

    wire       b  = byte_sr[7];
    wire       gx = b ^ sr[0] ^ sr[1] ^ sr[2] ^ sr[5];  // 171o: taps 0,1,2,3,6
    wire       gy = b ^ sr[1] ^ sr[2] ^ sr[4] ^ sr[5];  // 133o: taps 0,2,3,5,6
    wire       kx = keep_x[phase];
    wire       ky = keep_y[phase];
    wire       encode = (bits_left != 4'd0) && (acc_n < {1'b0, v});
    wire       emit = (acc_n >= {1'b0, v}) && (!m_valid || m_ready);

    /* verilator lint_off UNUSEDSIGNAL */
    wire [7:0] sym_bits = acc >> (acc_n - {1'b0, v});  // low v bits used
    /* verilator lint_on UNUSEDSIGNAL */

    always @(posedge clk) begin
        if (rst) begin
            bits_left <= 4'd0;
            byte_sr   <= 8'd0;
            sr        <= 6'd0;
            phase     <= 3'd0;
            acc       <= 8'd0;
            acc_n     <= 4'd0;
            m_valid   <= 1'b0;
            m_sym     <= 6'd0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;

            if (s_valid && s_ready) begin
                byte_sr   <= s_data;
                bits_left <= 4'd8;
            end

            if (encode) begin
                byte_sr   <= {byte_sr[6:0], 1'b0};
                bits_left <= bits_left - 4'd1;
                sr        <= {sr[4:0], b};
                phase     <= (phase == period - 3'd1) ? 3'd0 : phase + 3'd1;
                case ({kx, ky})
                    2'b11: begin acc <= {acc[5:0], gx, gy}; acc_n <= acc_n + 4'd2; end
                    2'b10: begin acc <= {acc[6:0], gx};     acc_n <= acc_n + 4'd1; end
                    2'b01: begin acc <= {acc[6:0], gy};     acc_n <= acc_n + 4'd1; end
                    default: ;
                endcase
            end else if (emit) begin
                m_valid <= 1'b1;
                case (v)
                    3'd6:    m_sym <= sym_bits[5:0];
                    3'd4:    m_sym <= {2'b00, sym_bits[3:0]};
                    default: m_sym <= {4'b0000, sym_bits[1:0]};
                endcase
                acc_n <= acc_n - {1'b0, v};
            end
        end
    end
endmodule

`default_nettype wire

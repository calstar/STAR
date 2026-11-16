// EN 300 744 §4.3.4.1 bit-wise inner interleaver, non-hierarchical.
//
// Each input symbol carries v bits (v = 2, 4, 6), first bit in the MSB, as
// dvbt_inner_coder emits them. The bits are demultiplexed into v substreams
// (Table 3: QPSK x0->b0 x1->b1; 16QAM x0 x1 x2 x3 -> b0 b2 b1 b3;
// 64QAM x0..x5 -> b0 b2 b4 b1 b3 b5). Substream e is interleaved in blocks of
// 126 bits by H_e(w) = (w + off_e) mod 126, off = 0, 63, 105, 42, 21, 84.
// Output symbol w = (a_0,w ... a_v-1,w), a_0 in the MSB -- gr-dtv's packing.
//
// Two 126-symbol banks: one fills while the other drains. Each substream has
// its own small RAM so all v bits of an output symbol read in one clock.
`default_nettype none

module dvbt_bit_interleaver (
    input  wire       clk,
    input  wire       rst,
    input  wire [1:0] cfg_mod,   // 0 QPSK, 1 16QAM, 2 64QAM; change only in reset
    input  wire [5:0] s_sym,
    input  wire       s_valid,
    output wire       s_ready,
    output reg  [5:0] m_sym,
    output reg        m_valid,
    input  wire       m_ready
);
    localparam N = 126;

    wire [2:0] v = (cfg_mod == 2'd2) ? 3'd6 : (cfg_mod == 2'd1) ? 3'd4 : 3'd2;

    // Substream RAMs, address = bank * 126 + k.
    reg mem0[0:2*N-1], mem1[0:2*N-1], mem2[0:2*N-1];
    reg mem3[0:2*N-1], mem4[0:2*N-1], mem5[0:2*N-1];

    reg  [1:0] full;
    reg        wbank, rbank;
    reg  [6:0] wk, rw;

    // Demultiplex the input symbol into substream bits b[e].
    reg [5:0] b;
    always @* begin
        b = 6'd0;
        case (cfg_mod)
            2'd2: begin  // x0..x5 = s_sym[5..0] -> b0 b2 b4 b1 b3 b5
                b[0] = s_sym[5]; b[2] = s_sym[4]; b[4] = s_sym[3];
                b[1] = s_sym[2]; b[3] = s_sym[1]; b[5] = s_sym[0];
            end
            2'd1: begin  // x0..x3 = s_sym[3..0] -> b0 b2 b1 b3
                b[0] = s_sym[3]; b[2] = s_sym[2]; b[1] = s_sym[1]; b[3] = s_sym[0];
            end
            default: begin
                b[0] = s_sym[1]; b[1] = s_sym[0];
            end
        endcase
    end

    function [7:0] raddr(input bank, input [6:0] w, input [6:0] off);
        reg [7:0] t;
        begin
            t = {1'b0, w} + {1'b0, off};
            if (t >= N) t = t - N;
            raddr = (bank ? N : 0) + t;
        end
    endfunction

    wire [7:0] wa = (wbank ? N : 0) + {1'b0, wk};
    wire [7:0] ra0 = raddr(rbank, rw, 7'd0);
    wire [7:0] ra1 = raddr(rbank, rw, 7'd63);
    wire [7:0] ra2 = raddr(rbank, rw, 7'd105);
    wire [7:0] ra3 = raddr(rbank, rw, 7'd42);
    wire [7:0] ra4 = raddr(rbank, rw, 7'd21);
    wire [7:0] ra5 = raddr(rbank, rw, 7'd84);
    wire a0 = mem0[ra0], a1 = mem1[ra1], a2 = mem2[ra2];
    wire a3 = mem3[ra3], a4 = mem4[ra4], a5 = mem5[ra5];

    assign s_ready = !full[wbank];
    wire take = s_valid && s_ready;
    wire give = full[rbank] && (!m_valid || m_ready);
    wire wdone = take && (wk == N - 1);
    wire rdone = give && (rw == N - 1);

    always @(posedge clk) begin
        if (take) begin
            mem0[wa] <= b[0]; mem1[wa] <= b[1]; mem2[wa] <= b[2];
            mem3[wa] <= b[3]; mem4[wa] <= b[4]; mem5[wa] <= b[5];
        end
    end

    always @(posedge clk) begin
        if (rst) begin
            full    <= 2'b00;
            wbank   <= 1'b0;
            rbank   <= 1'b0;
            wk      <= 7'd0;
            rw      <= 7'd0;
            m_valid <= 1'b0;
            m_sym   <= 6'd0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (take) wk <= wdone ? 7'd0 : wk + 7'd1;
            if (wdone) wbank <= ~wbank;
            if (give) begin
                m_valid <= 1'b1;
                case (v)
                    3'd6:    m_sym <= {a0, a1, a2, a3, a4, a5};
                    3'd4:    m_sym <= {2'b00, a0, a1, a2, a3};
                    default: m_sym <= {4'b0000, a0, a1};
                endcase
                rw <= rdone ? 7'd0 : rw + 7'd1;
            end
            if (rdone) rbank <= ~rbank;
            // A bank fills when its last symbol is written and empties when
            // its last symbol is read; the two never name the same bank.
            full[0] <= (full[0] | (wdone && !wbank)) & ~(rdone && !rbank);
            full[1] <= (full[1] | (wdone && wbank)) & ~(rdone && rbank);
        end
    end
endmodule

`default_nettype wire

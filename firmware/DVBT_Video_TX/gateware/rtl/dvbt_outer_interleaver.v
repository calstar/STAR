// EN 300 744 §4.3.3 outer interleaver: Forney convolutional, I = 12, M = 17.
//
// Byte k goes to branch j = k mod 12, a FIFO of j*17 bytes (branch 0 is a
// wire). The commutator starts on the first byte after reset; fed RS packets
// starting with a sync byte, it stays aligned (204 = 12 * 17), so every sync
// byte takes branch 0 as the standard requires.
//
// All 12 FIFOs share one 1122-byte RAM (17 * (0 + 1 + ... + 11)); branch j
// occupies [17*j*(j-1)/2, 17*j*(j+1)/2). The RAM powers up zeroed, matching
// gr-dtv's start-up output. A reset clears the pointers but not the RAM, so
// after a reset the first 1122 interleaved bytes are stale -- a receiver
// treats that as a burst error and locks after it.
//
// Two clocks per byte (synchronous RAM read, then write), so up to half the
// clock rate in bytes, about 26 times what QPSK 1/2 at 6 MHz needs.
`default_nettype none

module dvbt_outer_interleaver (
    input  wire       clk,
    input  wire       rst,
    input  wire [7:0] s_data,
    input  wire       s_valid,
    output wire       s_ready,
    output reg  [7:0] m_data,
    output reg        m_valid,
    input  wire       m_ready
);
    localparam I = 12;
    localparam M = 17;
    localparam DEPTH = M * I * (I - 1) / 2;  // 1122

    reg [7:0] mem[0:DEPTH-1];
    integer n;
    initial for (n = 0; n < DEPTH; n = n + 1) mem[n] = 8'd0;

    reg  [3:0] branch;
    reg  [7:0] ptr[0:I-1];   // position in each branch's FIFO (max 186)
    reg        busy;         // second clock of a byte: RAM data is valid
    reg  [7:0] hold;         // the byte being interleaved
    reg [10:0] addr_q;
    reg  [7:0] rdata;

    // Branch base addresses, 17 * j * (j - 1) / 2, as a table so synthesis
    // doesn't build a multiplier for them.
    function [10:0] base(input [3:0] j);
        case (j)
            4'd2:  base = 11'd17;   4'd3:  base = 11'd51;   4'd4:  base = 11'd102;
            4'd5:  base = 11'd170;  4'd6:  base = 11'd255;  4'd7:  base = 11'd357;
            4'd8:  base = 11'd476;  4'd9:  base = 11'd612;  4'd10: base = 11'd765;
            4'd11: base = 11'd935;  default: base = 11'd0;
        endcase
    endfunction

    // Branch FIFO lengths minus one, 17 * j - 1.
    function [7:0] last(input [3:0] j);
        case (j)
            4'd1: last = 8'd16;   4'd2: last = 8'd33;   4'd3: last = 8'd50;
            4'd4: last = 8'd67;   4'd5: last = 8'd84;   4'd6: last = 8'd101;
            4'd7: last = 8'd118;  4'd8: last = 8'd135;  4'd9: last = 8'd152;
            4'd10: last = 8'd169; 4'd11: last = 8'd186; default: last = 8'd0;
        endcase
    endfunction

    wire [10:0] addr = base(branch) + {3'd0, ptr[branch]};

    assign s_ready = !busy && (!m_valid || m_ready);

    integer i;
    always @(posedge clk) begin
        rdata <= mem[addr];   // synchronous read, sampled on the take clock
        if (rst) begin
            branch  <= 4'd0;
            busy    <= 1'b0;
            m_valid <= 1'b0;
            m_data  <= 8'd0;
            for (i = 0; i < I; i = i + 1) ptr[i] <= 8'd0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (busy) begin
                // rdata holds the oldest byte of the branch: send it, store ours.
                busy    <= 1'b0;
                m_valid <= 1'b1;
                m_data  <= rdata;
                mem[addr_q] <= hold;
            end else if (s_valid && s_ready) begin
                branch <= (branch == I - 1) ? 4'd0 : branch + 4'd1;
                if (branch == 4'd0) begin
                    m_valid <= 1'b1;
                    m_data  <= s_data;
                end else begin
                    busy   <= 1'b1;
                    hold   <= s_data;
                    addr_q <= addr;
                    ptr[branch] <= (ptr[branch] == last(branch)) ? 8'd0 : ptr[branch] + 8'd1;
                end
            end
        end
    end
endmodule

`default_nettype wire

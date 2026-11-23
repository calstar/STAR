// Synchronous FIFO in block RAM, valid/ready on both sides, full throughput.
//
// Writes are speculative until committed: w_commit makes everything written
// so far (including a write in the same clock) visible to the reader;
// w_abort throws away everything written since the last commit. Tie
// w_commit high for an ordinary FIFO. (The TS input uses this to accept a
// packet only when all 188 bytes have arrived.)
//
// Read side: the RAM's one-clock read feeds a two-entry output queue, and a
// read is issued only when the queue will have room for it.
`default_nettype none

module dvbt_fifo #(
    parameter integer W = 8,
    parameter integer AW = 11              // depth 2^AW
) (
    input  wire          clk,
    input  wire          rst,
    input  wire  [W-1:0] s_data,
    input  wire          s_valid,
    output wire          s_ready,
    input  wire          w_commit,
    input  wire          w_abort,
    output reg   [W-1:0] m_data,
    output reg           m_valid,
    input  wire          m_ready,
    output wire   [AW:0] level,            // committed entries not yet read out
    output wire   [AW:0] free              // room for writes, speculative ones counted
);
    reg [W-1:0] mem [0:(1<<AW)-1];
    reg  [AW:0] wp, cp, rp;                // write, committed, read pointers
    reg [W-1:0] rdata, q1;
    reg         rd_pend, q1_v;

    assign free  = (1 << AW) - (wp - rp);
    assign level = cp - rp;
    assign s_ready = (free != 0);
    wire push = s_valid && s_ready;

    wire pop   = m_valid && m_ready;
    wire [1:0] occ = {1'b0, m_valid} + {1'b0, q1_v} + {1'b0, rd_pend} - {1'b0, pop};
    wire issue = (level != 0) && (occ < 2'd2);

    always @(posedge clk) begin
        if (push) mem[wp[AW-1:0]] <= s_data;
        if (issue) rdata <= mem[rp[AW-1:0]];
    end

    always @(posedge clk) begin
        if (rst) begin
            wp <= 0; cp <= 0; rp <= 0;
            rd_pend <= 1'b0; q1_v <= 1'b0; m_valid <= 1'b0;
        end else begin
            if (w_abort)          wp <= cp;
            else begin
                if (push)         wp <= wp + 1'b1;
                if (w_commit)     cp <= wp + {{AW{1'b0}}, push};
            end
            if (issue)            rp <= rp + 1'b1;
            rd_pend <= issue;

            if (!m_valid || pop) begin
                if (q1_v) begin
                    m_data <= q1;
                    m_valid <= 1'b1;
                    q1 <= rdata;
                    q1_v <= rd_pend;
                end else begin
                    m_data <= rdata;
                    m_valid <= rd_pend;
                end
            end else if (rd_pend) begin
                q1 <= rdata;
                q1_v <= 1'b1;
            end
        end
    end
endmodule

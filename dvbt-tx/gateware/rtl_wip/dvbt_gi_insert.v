// FFT output to OFDM symbols with guard interval.
//
// Input: the IFFT's 2048 samples per symbol in bit-reversed order (s_first on
// the first), re/im still swapped from the IFFT trick. Output: the symbol in
// time order, preceded by its last Ng samples (the cyclic prefix),
// Ng = 2048 * guard = 64, 128, 256, 512 for cfg_guard 0..3 (1/32 .. 1/4);
// m_sos marks the first prefix sample. Re and im are swapped back here.
// Two banks: one fills while the other plays out 2048 + Ng samples.
`default_nettype none

module dvbt_gi_insert (
    input  wire               clk,
    input  wire               rst,
    input  wire         [1:0] cfg_guard,
    input  wire signed [17:0] s_re,
    input  wire signed [17:0] s_im,
    input  wire               s_first,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [17:0] m_i,
    output reg  signed [17:0] m_q,
    output reg                m_sos,
    output reg                m_valid,
    input  wire               m_ready,
    output reg                err_align
);
    reg [35:0] mem[0:4095];

    reg  [1:0] full;
    reg        wbank, rbank;
    reg [10:0] wn;     // input index (bit-reversed bin order)
    reg [11:0] j;      // output index, 0 .. Ng + 2047

    wire [11:0] ng = 12'd64 << cfg_guard;
    wire [11:0] last = ng + 12'd2047;

    function [10:0] bitrev(input [10:0] x);
        integer b;
        for (b = 0; b < 11; b = b + 1) bitrev[b] = x[10 - b];
    endfunction

    assign s_ready = !full[wbank];
    wire take = s_valid && s_ready;
    wire give = full[rbank] && (!m_valid || m_ready);
    wire wdone = take && (wn == 11'd2047);
    wire rdone = give && (j == last);

    // Time index of output j: the prefix replays the symbol's tail.
    wire [11:0] t = (j < ng) ? (12'd2048 - ng + j) : (j - ng);
    wire [35:0] rword = mem[{rbank, t[10:0]}];

    always @(posedge clk) begin
        if (take) mem[{wbank, bitrev(wn)}] <= {s_re, s_im};
        if (give) begin
            m_i <= rword[17:0];   // swap back: I = FFT im
            m_q <= rword[35:18];  //            Q = FFT re
        end
    end

    always @(posedge clk) begin
        if (rst) begin
            full      <= 2'b00;
            wbank     <= 1'b0;
            rbank     <= 1'b0;
            wn        <= 11'd0;
            j         <= 12'd0;
            m_valid   <= 1'b0;
            m_sos     <= 1'b0;
            err_align <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (take) begin
                wn <= wn + 11'd1;
                if (s_first != (wn == 11'd0)) err_align <= 1'b1;
            end
            if (wdone) wbank <= ~wbank;
            if (give) begin
                m_valid <= 1'b1;
                m_sos   <= (j == 12'd0);
                j       <= rdone ? 12'd0 : j + 12'd1;
            end
            if (rdone) rbank <= ~rbank;
            full[0] <= (full[0] | (wdone && !wbank)) & ~(rdone && !rbank);
            full[1] <= (full[1] | (wdone && wbank)) & ~(rdone && rbank);
        end
    end
endmodule

`default_nettype wire

// Carriers to IFFT bins. The frame builder emits carriers k = 0..1704; the
// IFFT wants bins 0..2047 with carrier k in bin (k - 852) mod 2048, so the
// centre carrier sits at DC (gr-dtv's placement, checked in model/golden.py).
// The 343 bins outside the band are never written and stay zero from
// power-up. Two banks: one fills while the other is read out in bin order.
// 1.0 = 8192 in, sign-extended to the FFT's 18 bits; re and im are swapped
// on the way out (and back after the FFT) to make the forward FFT an IFFT.
`default_nettype none

module dvbt_ifft_in (
    input  wire               clk,
    input  wire               rst,
    input  wire signed [15:0] s_i,
    input  wire signed [15:0] s_q,
    input  wire               s_sos,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [17:0] m_re,     // = carrier Q (swapped)
    output reg  signed [17:0] m_im,     // = carrier I
    output reg                m_first,  // bin 0
    output reg                m_valid,
    input  wire               m_ready,
    output reg                err_align
);
    reg [31:0] mem[0:4095];
    integer n;
    initial for (n = 0; n < 4096; n = n + 1) mem[n] = 32'd0;

    reg  [1:0] full;
    reg        wbank, rbank;
    reg [10:0] wk, rb;

    assign s_ready = !full[wbank];
    wire take = s_valid && s_ready;
    wire give = full[rbank] && (!m_valid || m_ready);
    wire wdone = take && (wk == 11'd1704);
    wire rdone = give && (rb == 11'd2047);

    wire [10:0] bin = wk + 11'd1196;  // (k - 852) mod 2048
    wire [31:0] rword = mem[{rbank, rb}];

    always @(posedge clk) begin
        if (take) mem[{wbank, bin}] <= {s_i, s_q};
        // Synchronous read straight into the output register.
        if (give) begin
            m_re <= {{2{rword[15]}}, rword[15:0]};   // Q
            m_im <= {{2{rword[31]}}, rword[31:16]};  // I
        end
    end

    always @(posedge clk) begin
        if (rst) begin
            full      <= 2'b00;
            wbank     <= 1'b0;
            rbank     <= 1'b0;
            wk        <= 11'd0;
            rb        <= 11'd0;
            m_valid   <= 1'b0;
            m_first   <= 1'b0;
            err_align <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (take) begin
                wk <= wdone ? 11'd0 : wk + 11'd1;
                if (s_sos != (wk == 11'd0)) err_align <= 1'b1;
            end
            if (wdone) wbank <= ~wbank;
            if (give) begin
                m_valid <= 1'b1;
                m_first <= (rb == 11'd0);
                rb      <= rdone ? 11'd0 : rb + 11'd1;
            end
            if (rdone) rbank <= ~rbank;
            full[0] <= (full[0] | (wdone && !wbank)) & ~(rdone && !rbank);
            full[1] <= (full[1] | (wdone && wbank)) & ~(rdone && rbank);
        end
    end
endmodule

`default_nettype wire

// 2048-point FFT, radix-2^2 single-path delay feedback (R2^2SDF), decimation
// in frequency: natural-order input, bit-reversed output, one sample per
// accepted input. Structure (checked against numpy in model/r22sdf.py):
//
//   for M = 2048, 512, 128, 32, 8 (L = M/2):
//       stage A: butterfly of span L, bottom outputs in their second quarter
//                multiplied by -j; stage B: butterfly of span L/2;
//       multiplier W_M^(n2 (h + 2b)), n2 = position mod L/2,
//                h = half of A's block, b = half of B's block
//   last: butterfly of span 1.
//
// Five complex multipliers (20 MULT18X18D). 18-bit signed data; every
// stage A (5 of 11 butterflies) halves its outputs with rounding, so the
// output is sum(x) e^(-j..) / 32: for the OFDM symbols here the output RMS is
// about 1.4x the input's and peaks stay under a quarter of full scale.
// Butterflies and multipliers saturate rather than wrap.
//
// Dataflow: every register in the pipe advances only when a sample is
// accepted (en), and each stage tracks validity with its own token, so the
// pipeline latency is in samples, not clocks; it primes over the first 2047
// samples and is continuous after. It drains only when fed: stop the input
// and the last symbol stays inside.
//
// For an IFFT, swap re and im on the way in and on the way out.
`default_nettype none
/* verilator lint_off WIDTHEXPAND */
/* verilator lint_off WIDTHTRUNC */
// Function temporaries: blocking and partly used by design.
/* verilator lint_off BLKSEQ */
/* verilator lint_off UNUSEDSIGNAL */

// Folder holding rom/tw_<M>.hex (scripts/gen_twiddles.py), relative to where
// the simulator or synthesis runs; the test runner passes an absolute path.
`ifndef DVBT_ROM_DIR
`define DVBT_ROM_DIR "rtl/rom"
`endif

// One SDF butterfly stage of span L >= 2 (delay line in RAM).
module dvbt_fft_bf #(
    parameter integer L = 1024,
    parameter integer ROT = 0,     // stage A of a pair: -j on the 2nd quarter of the bottoms
    parameter integer SHIFT = 0    // halve outputs (rounded)
) (
    input  wire               clk,
    input  wire               rst,
    input  wire               en,
    input  wire               in_v,
    input  wire signed [17:0] in_re,
    input  wire signed [17:0] in_im,
    output reg                out_v,
    output reg  signed [17:0] out_re,
    output reg  signed [17:0] out_im
);
    localparam integer AW = (L <= 2) ? 1 : $clog2(L);

    reg [35:0] dl[0:L-1];
    integer n;
    initial for (n = 0; n < L; n = n + 1) dl[n] = 36'd0;

    reg [AW:0]   ic;      // position in the 2L block of the next input
    reg [AW-1:0] ptr;     // delay-line slot of the next input
    reg          filled;  // one whole block seen: bottoms are real

    // Phase 2 registers: the previous input and the delay-line word read for it.
    reg               p_v;
    reg        [AW:0] p_ic;
    reg      [AW-1:0] p_ptr;
    reg signed [17:0] p_re, p_im;
    reg        [35:0] rd;

    wire signed [17:0] d_re = rd[35:18];
    wire signed [17:0] d_im = rd[17:0];
    wire signed [18:0] s_re = d_re + p_re, s_im = d_im + p_im;
    wire signed [18:0] f_re = d_re - p_re, f_im = d_im - p_im;

    function signed [17:0] scale(input signed [18:0] v);
        reg signed [19:0] r;
        begin
            if (SHIFT != 0) begin
                // round half to even: unbiased (round-half-up and
                // truncation each leave ~0.5 LSB of DC at the output)
                r = {v[18], v} + {19'd0, v[1]};
                scale = ($signed(r[19:1]) > 19'sd131071) ? 18'sd131071 : r[18:1];
            end else if (v > 19'sd131071) scale = 18'sd131071;
            else if (v < -19'sd131071) scale = -18'sd131071;
            else scale = v[17:0];
        end
    endfunction

    wire first_half = (p_ic < L);
    wire rot_now = (ROT != 0) && first_half && (p_ic >= L / 2);

    always @(posedge clk) begin
        if (rst) begin
            ic     <= 0;
            ptr    <= 0;
            filled <= 1'b0;
            p_v    <= 1'b0;
            out_v  <= 1'b0;
            out_re <= 18'sd0;
            out_im <= 18'sd0;
        end else if (en) begin
            // Phase 1: the new input reads its delay-line slot.
            rd    <= dl[ptr];
            p_v   <= in_v;
            p_ic  <= ic;
            p_ptr <= ptr;
            p_re  <= in_re;
            p_im  <= in_im;
            if (in_v) begin
                ic  <= (ic == 2 * L - 1) ? 0 : ic + 1;
                ptr <= (ptr == L - 1) ? 0 : ptr + 1;
            end
            // Phase 2: the previous input completes.
            out_v <= p_v && (!first_half || filled);
            if (p_v) begin
                if (first_half) begin
                    // Out goes the stored bottom; the input waits for its pair.
                    dl[p_ptr] <= {p_re, p_im};
                    if (rot_now) begin  // -j (a + jb) = b - ja
                        out_re <= d_im;
                        out_im <= -d_re;
                    end else begin
                        out_re <= d_re;
                        out_im <= d_im;
                    end
                end else begin
                    out_re <= scale(s_re);
                    out_im <= scale(s_im);
                    dl[p_ptr] <= {scale(f_re), scale(f_im)};
                    if (p_ic == 2 * L - 1) filled <= 1'b1;
                end
            end
        end
    end
endmodule

// The last butterfly, span 1: registers instead of a delay line.
module dvbt_fft_bf1 (
    input  wire               clk,
    input  wire               rst,
    input  wire               en,
    input  wire               in_v,
    input  wire signed [17:0] in_re,
    input  wire signed [17:0] in_im,
    output reg                out_v,
    output reg  signed [17:0] out_re,
    output reg  signed [17:0] out_im
);
    reg               odd, filled;
    reg signed [17:0] h_re, h_im, b_re, b_im;
    wire signed [18:0] s_re = h_re + in_re, s_im = h_im + in_im;
    wire signed [18:0] f_re = h_re - in_re, f_im = h_im - in_im;

    function signed [17:0] sat(input signed [18:0] v);
        if (v > 19'sd131071) sat = 18'sd131071;
        else if (v < -19'sd131071) sat = -18'sd131071;
        else sat = v[17:0];
    endfunction

    always @(posedge clk) begin
        if (rst) begin
            odd    <= 1'b0;
            filled <= 1'b0;
            out_v  <= 1'b0;
            out_re <= 18'sd0;
            out_im <= 18'sd0;
        end else if (en) begin
            out_v <= in_v && (odd || filled);
            if (in_v) begin
                odd <= ~odd;
                if (!odd) begin
                    h_re   <= in_re;
                    h_im   <= in_im;
                    out_re <= b_re;
                    out_im <= b_im;
                end else begin
                    out_re <= sat(s_re);
                    out_im <= sat(s_im);
                    b_re   <= sat(f_re);
                    b_im   <= sat(f_im);
                    filled <= 1'b1;
                end
            end
        end
    end
endmodule

// Twiddle multiplier after a stage pair of sub-FFT size M: W_M^(n2 (h + 2b)).
module dvbt_fft_tw #(
    parameter integer M = 2048
) (
    input  wire               clk,
    input  wire               rst,
    input  wire               en,
    input  wire               in_v,
    input  wire signed [17:0] in_re,
    input  wire signed [17:0] in_im,
    output reg                out_v,
    output reg  signed [17:0] out_re,
    output reg  signed [17:0] out_im
);
    localparam integer QW = $clog2(M);
    localparam integer DEPTH = 3 * M / 4;

    reg [35:0] rom[0:DEPTH-1];
    generate
        if (M == 2048) begin : r2048
            initial $readmemh({`DVBT_ROM_DIR, "/tw_2048.hex"}, rom);
        end else if (M == 512) begin : r512
            initial $readmemh({`DVBT_ROM_DIR, "/tw_512.hex"}, rom);
        end else if (M == 128) begin : r128
            initial $readmemh({`DVBT_ROM_DIR, "/tw_128.hex"}, rom);
        end else if (M == 32) begin : r32
            initial $readmemh({`DVBT_ROM_DIR, "/tw_32.hex"}, rom);
        end else begin : r8
            initial $readmemh({`DVBT_ROM_DIR, "/tw_8.hex"}, rom);
        end
    endgenerate

    reg [QW-1:0] q;  // position of the next input in the M block
    wire         h = q[QW-1];
    wire         b = q[QW-2];
    wire [QW-1:0] n2 = {2'b00, q[QW-3:0]};
    wire [QW-1:0] e = (h ? n2 : 0) + (b ? {n2[QW-2:0], 1'b0} : 0);  // n2 (h + 2b)

    // Stage 1: ROM read, data held. Stage 2: products. Stage 3: sum, round.
    reg               v1, v2;
    reg signed [17:0] x_re, x_im;
    reg        [35:0] w;
    reg signed [35:0] p_rr, p_ii, p_ri, p_ir;

    wire signed [17:0] w_re = w[35:18];
    wire signed [17:0] w_im = w[17:0];
    wire signed [36:0] y_re = p_rr - p_ii + 37'sd32768;  // + half LSB of >> 16
    wire signed [36:0] y_im = p_ri + p_ir + 37'sd32768;

    function signed [17:0] sat(input signed [36:0] v);  // v >> 16, saturated
        reg signed [20:0] sh;
        begin
            sh = v[36:16];
            if (sh > 21'sd131071) sat = 18'sd131071;
            else if (sh < -21'sd131071) sat = -18'sd131071;
            else sat = sh[17:0];
        end
    endfunction

    always @(posedge clk) begin
        if (rst) begin
            q     <= 0;
            v1    <= 1'b0;
            v2    <= 1'b0;
            out_v <= 1'b0;
        end else if (en) begin
            v1   <= in_v;
            w    <= rom[e];
            x_re <= in_re;
            x_im <= in_im;
            if (in_v) q <= q + 1'b1;

            v2   <= v1;
            p_rr <= x_re * w_re;
            p_ii <= x_im * w_im;
            p_ri <= x_re * w_im;
            p_ir <= x_im * w_re;

            out_v  <= v2;
            out_re <= sat(y_re);
            out_im <= sat(y_im);
        end
    end
endmodule

module dvbt_fft2048 (
    input  wire               clk,
    input  wire               rst,
    input  wire signed [17:0] s_re,
    input  wire signed [17:0] s_im,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [17:0] m_re,
    output reg  signed [17:0] m_im,
    output reg                m_first,   // bin-reversed index 0 of a block
    output reg                m_valid,
    input  wire               m_ready
);
    assign s_ready = !m_valid || m_ready;
    wire en = s_valid && s_ready;

    // 16 stages: per pair A, B, twiddle; then the last butterfly.
    wire               v[0:16];
    wire signed [17:0] re[0:16];
    wire signed [17:0] im[0:16];
    assign v[0]  = 1'b1;
    assign re[0] = s_re;
    assign im[0] = s_im;

    genvar p;
    generate
        for (p = 0; p < 5; p = p + 1) begin : pair
            localparam integer MM = 2048 >> (2 * p);
            dvbt_fft_bf #(.L(MM / 2), .ROT(1), .SHIFT(1)) a (
                .clk(clk), .rst(rst), .en(en),
                .in_v(v[3*p]), .in_re(re[3*p]), .in_im(im[3*p]),
                .out_v(v[3*p+1]), .out_re(re[3*p+1]), .out_im(im[3*p+1])
            );
            dvbt_fft_bf #(.L(MM / 4), .ROT(0), .SHIFT(0)) b (
                .clk(clk), .rst(rst), .en(en),
                .in_v(v[3*p+1]), .in_re(re[3*p+1]), .in_im(im[3*p+1]),
                .out_v(v[3*p+2]), .out_re(re[3*p+2]), .out_im(im[3*p+2])
            );
            dvbt_fft_tw #(.M(MM)) t (
                .clk(clk), .rst(rst), .en(en),
                .in_v(v[3*p+2]), .in_re(re[3*p+2]), .in_im(im[3*p+2]),
                .out_v(v[3*p+3]), .out_re(re[3*p+3]), .out_im(im[3*p+3])
            );
        end
    endgenerate

    wire               lv;
    wire signed [17:0] lre, lim;
    dvbt_fft_bf1 last (
        .clk(clk), .rst(rst), .en(en),
        .in_v(v[15]), .in_re(re[15]), .in_im(im[15]),
        .out_v(lv), .out_re(lre), .out_im(lim)
    );

    reg [10:0] oc;  // output index within the block (bit-reversed bin)
    always @(posedge clk) begin
        if (rst) begin
            oc      <= 11'd0;
            m_valid <= 1'b0;
            m_first <= 1'b0;
            m_re    <= 18'sd0;
            m_im    <= 18'sd0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (en && lv) begin
                m_valid <= 1'b1;
                m_re    <= lre;
                m_im    <= lim;
                m_first <= (oc == 11'd0);
                oc      <= oc + 11'd1;
            end
        end
    end
endmodule

/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on BLKSEQ */
/* verilator lint_on WIDTHTRUNC */
/* verilator lint_on WIDTHEXPAND */
`default_nettype wire

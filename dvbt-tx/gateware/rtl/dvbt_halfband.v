// 2x half-band interpolator for complex samples (one input per 2+ clocks,
// up to one output per clock).
//
// A half-band filter's taps are zero at even offsets from the centre except
// the centre itself (0.5), so with gain 2 for the zero-stuffing:
//   even output = the input sample itself, delayed K
//   odd output  = sum_k g_k * (d[K-1-k] + d[K+k])    (the point halfway
//                 between d[K] and d[K-1]; d[0] is the newest input)
// The K odd-phase coefficients g_k (centre pair outwards, 1.0 = 2^17,
// scripts/gen_halfband.py) are constants: each product is a shift-and-add
// over the coefficient's canonical signed digits, so no multipliers. I and
// Q share that arithmetic: the odd sum is computed for I, then for Q, from
// two delay lines, which is why an input is taken at most every 2 clocks.
//
// Pipeline (all of it stalls together on en): issue -> pre-add (pa) ->
// products (pr) -> group sums of 4 (gs) -> total (tot) -> round/saturate
// (od). Token A carries I's odd sum and the even pair, token B Q's odd sum;
// when B leaves, two complex outputs go into a 2-entry output queue.
`default_nettype none
// The shift-and-add chains look circular to Verilator (one array, chained
// entries); widths are deliberate sign extensions; s is a loop temporary.
/* verilator lint_off UNOPTFLAT */
/* verilator lint_off WIDTHEXPAND */
/* verilator lint_off BLKSEQ */
/* verilator lint_off GENUNNAMED */

module dvbt_halfband #(
    parameter integer K = 4,
    parameter [18*K-1:0] COEF = {18'sd0, 18'sd0, 18'sd0, 18'sd0}
) (
    input  wire               clk,
    input  wire               rst,
    input  wire signed [17:0] s_i,
    input  wire signed [17:0] s_q,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [17:0] m_i,
    output reg  signed [17:0] m_q,
    output reg                m_valid,
    input  wire               m_ready
);
    localparam integer N = 2 * K;           // delay line length
    localparam integer G = (K + 3) / 4;     // groups of 4 products
    localparam integer AW = 40;             // accumulator width

    // k-th coefficient (signed 18-bit) and its i-th canonical signed digit.
    function integer coef(input integer k);
        coef = $signed(COEF[18*k +: 18]);
    endfunction
    function integer csd_dig(input integer v_in, input integer pos);
        integer v, j, d;
        begin
            v = v_in;
            d = 0;
            for (j = 0; j <= pos; j = j + 1) begin
                if (v % 2 != 0) begin
                    d = ((v & 3) == 1) ? 1 : -1;
                    v = v - d;
                end else begin
                    d = 0;
                end
                v = v / 2;
            end
            csd_dig = d;
        end
    endfunction

    // ---- delay lines and issue ------------------------------------------
    reg signed [17:0] di [0:N-1];
    reg signed [17:0] dq [0:N-1];
    reg         [1:0] iss;                  // 0 idle, 1 issue A next, 2 issue B next

    // last stage's token: valid, is-B, odd value, even pair (A only)
    reg               od_v, od_b;
    reg signed [17:0] od_x, od_ei, od_eq;
    reg               pend_v;
    reg signed [17:0] pend_i, pend_q;
    wire pop  = m_valid && m_ready;
    wire [1:0] cnt = {1'b0, m_valid} + {1'b0, pend_v};
    // B leaving pushes two outputs: the queue must be empty after this pop.
    wire en   = !(od_v && od_b && (cnt - {1'b0, pop}) != 2'd0);
    assign s_ready = en && (iss != 2'd1);
    wire take = s_valid && s_ready;

    integer j;
    always @(posedge clk) begin
        if (rst) begin
            for (j = 0; j < N; j = j + 1) begin
                di[j] <= 18'sd0;
                dq[j] <= 18'sd0;
            end
            iss <= 2'd0;
        end else if (en) begin
            if (take) begin
                di[0] <= s_i;
                dq[0] <= s_q;
                for (j = 1; j < N; j = j + 1) begin
                    di[j] <= di[j-1];
                    dq[j] <= dq[j-1];
                end
            end
            case (iss)
                2'd1:    iss <= 2'd2;
                default: iss <= take ? 2'd1 : 2'd0;
            endcase
        end
    end

    // ---- pre-add: pa[k] = d[K-1-k] + d[K+k] of the channel being issued --
    reg signed [18:0] pa [0:K-1];
    reg               pa_v, pa_b;
    reg signed [17:0] pa_ei, pa_eq;
    wire issue_b = (iss == 2'd2);
    always @(posedge clk) begin
        if (rst) begin
            pa_v <= 1'b0;
        end else if (en) begin
            pa_v  <= (iss != 2'd0);
            pa_b  <= issue_b;
            pa_ei <= di[K];
            pa_eq <= dq[K];
            for (j = 0; j < K; j = j + 1)
                pa[j] <= issue_b ? ({dq[K-1-j][17], dq[K-1-j]} + {dq[K+j][17], dq[K+j]})
                                 : ({di[K-1-j][17], di[K-1-j]} + {di[K+j][17], di[K+j]});
        end
    end

    // ---- products: shift-and-add over each coefficient's signed digits ---
    reg signed [AW-1:0] pr [0:K-1];
    genvar gk, gb;
    generate
        for (gk = 0; gk < K; gk = gk + 1) begin : g_mul
            wire signed [AW-1:0] x = pa[gk];          // sign-extended
            wire signed [AW-1:0] acc [0:19];
            assign acc[0] = 0;
            for (gb = 0; gb < 19; gb = gb + 1) begin : g_dig
                localparam integer D = csd_dig(coef(gk), gb);
                if (D > 0)      assign acc[gb+1] = acc[gb] + (x <<< gb);
                else if (D < 0) assign acc[gb+1] = acc[gb] - (x <<< gb);
                else            assign acc[gb+1] = acc[gb];
            end
            always @(posedge clk)
                if (en) pr[gk] <= acc[19];
        end
    endgenerate
    reg               pr_v, pr_b;
    reg signed [17:0] pr_ei, pr_eq;
    always @(posedge clk) begin
        if (rst) pr_v <= 1'b0;
        else if (en) begin
            pr_v <= pa_v; pr_b <= pa_b; pr_ei <= pa_ei; pr_eq <= pa_eq;
        end
    end

    // ---- group sums, total, round/saturate --------------------------------
    reg signed [AW-1:0] gs [0:G-1];
    reg signed [AW-1:0] tot, s;
    reg               gs_v, gs_b, tot_v, tot_b;
    reg signed [17:0] gs_ei, gs_eq, tot_ei, tot_eq;
    integer g;
    wire signed [AW-1:0] rnd = tot + (1 <<< 16);
    wire signed [AW-18:0] hi = rnd[AW-1:17];
    wire unused_rnd = &{1'b0, rnd[16:0]};
    always @(posedge clk) begin
        if (rst) begin
            gs_v <= 1'b0; tot_v <= 1'b0; od_v <= 1'b0;
        end else if (en) begin
            for (g = 0; g < G; g = g + 1) begin
                s = 0;
                for (j = 4 * g; j < 4 * g + 4; j = j + 1)
                    if (j < K) s = s + pr[j];
                gs[g] <= s;
            end
            gs_v <= pr_v; gs_b <= pr_b; gs_ei <= pr_ei; gs_eq <= pr_eq;

            s = 0;
            for (g = 0; g < G; g = g + 1) s = s + gs[g];
            tot <= s;
            tot_v <= gs_v; tot_b <= gs_b; tot_ei <= gs_ei; tot_eq <= gs_eq;

            od_x  <= (hi > 131071) ? 18'sd131071 : (hi < -131071) ? -18'sd131071 : hi[17:0];
            od_v  <= tot_v; od_b <= tot_b; od_ei <= tot_ei; od_eq <= tot_eq;
        end
    end

    // ---- output queue ------------------------------------------------------
    reg signed [17:0] h_oi, h_ei, h_eq;     // token A's results, waiting for B
    always @(posedge clk) begin
        if (rst) begin
            m_valid <= 1'b0;
            pend_v  <= 1'b0;
        end else begin
            if (en && od_v && !od_b) begin
                h_oi <= od_x; h_ei <= od_ei; h_eq <= od_eq;
            end
            if (en && od_v && od_b) begin   // queue is empty after the pop
                m_i <= h_ei;  m_q <= h_eq;  m_valid <= 1'b1;
                pend_i <= h_oi; pend_q <= od_x; pend_v <= 1'b1;
            end else if (pop || !m_valid) begin
                m_valid <= pend_v;
                m_i <= pend_i; m_q <= pend_q;
                pend_v <= 1'b0;
            end
        end
    end
endmodule

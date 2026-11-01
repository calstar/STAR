// Digital gain and I/Q imbalance correction ahead of the interpolator.
//
//   i' = sat(gain_i * i)
//   q' = sat(gain_q * q + phase * i)
// gain_* unsigned Q2.14 (16384 = 1.0, up to 3.99994); phase signed Q2.14
// (cancels the quadrature modulator's phase error: a small fraction of I
// added to Q). Products round half up, saturate to +-131071. Three
// multipliers; they run at the 48/7 MS/s input rate. Linear, so doing this
// before the interpolator is the same as after it (the DC offsets, which
// are not, are added at the DAC: dvbt_dac_out).
`default_nettype none
/* verilator lint_off BLKSEQ */  // r: a temporary inside a function

module dvbt_iq_corr (
    input  wire               clk,
    input  wire               rst,
    input  wire        [15:0] gain_i,
    input  wire        [15:0] gain_q,
    input  wire signed [15:0] phase,
    input  wire signed [17:0] s_i,
    input  wire signed [17:0] s_q,
    input  wire               s_valid,
    output wire               s_ready,
    output reg  signed [17:0] m_i,
    output reg  signed [17:0] m_q,
    output reg                m_valid,
    input  wire               m_ready
);
    wire en = !m_valid || m_ready;
    assign s_ready = en;

    reg signed [35:0] p_i, p_q, p_x;
    reg               p_v;
    always @(posedge clk) begin
        if (rst) p_v <= 1'b0;
        else if (en) begin
            p_v <= s_valid;
            p_i <= s_i * $signed({2'b00, gain_i});
            p_q <= s_q * $signed({2'b00, gain_q});
            p_x <= s_i * $signed({{2{phase[15]}}, phase});
        end
    end

    function signed [17:0] sat(input signed [36:0] v);
        reg signed [36:0] r;
        begin
            r = (v + 37'sd8192) >>> 14;
            sat = (r > 37'sd131071) ? 18'sd131071 : (r < -37'sd131071) ? -18'sd131071 : r[17:0];
        end
    endfunction

    always @(posedge clk) begin
        if (rst) m_valid <= 1'b0;
        else if (en) begin
            m_valid <= p_v;
            m_i <= sat({p_i[35], p_i});
            m_q <= sat({p_q[35], p_q} + {p_x[35], p_x});
        end
    end
endmodule

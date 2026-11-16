// EN 300 744 §4.3.2 outer code: RS(204,188, t = 8), shortened from RS(255,239).
//
// Field GF(2^8), p(x) = x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
// Generator g(x) = (x + a^0)(x + a^1)...(x + a^15), a = 0x02.
// Shortening: the 51 leading zero bytes leave a systematic LFSR encoder's
// state at zero, so they are simply not sent.
//
// Input: 188-byte packets (s_sop on the first byte). Output: the same 188 bytes
// followed by 16 parity bytes, m_sop on the first. s_ready drops while parity
// is being sent. Bytes before the first s_sop are dropped.
`default_nettype none

module dvbt_rs_encoder (
    input  wire       clk,
    input  wire       rst,
    input  wire [7:0] s_data,
    input  wire       s_sop,
    input  wire       s_valid,
    output wire       s_ready,
    output reg  [7:0] m_data,
    output reg        m_sop,
    output reg        m_valid,
    input  wire       m_ready
);
    // g(x) coefficients g0..g15 (g16 = 1), from scripts/gen_rs_generator.py.
    function [7:0] gcoef(input integer i);
        case (i)
            0: gcoef = 8'h3b;  1: gcoef = 8'h24;  2: gcoef = 8'h32;  3: gcoef = 8'h62;
            4: gcoef = 8'he5;  5: gcoef = 8'h29;  6: gcoef = 8'h41;  7: gcoef = 8'ha3;
            8: gcoef = 8'h08;  9: gcoef = 8'h1e; 10: gcoef = 8'hd1; 11: gcoef = 8'h44;
           12: gcoef = 8'hbd; 13: gcoef = 8'h68; 14: gcoef = 8'h0d; 15: gcoef = 8'h3b;
           default: gcoef = 8'h00;
        endcase
    endfunction

    // GF(2^8) multiply; with b constant, synthesis reduces it to XORs.
    // (Blocking assignments are local to the function.)
    /* verilator lint_off BLKSEQ */
    function [7:0] gf_mul(input [7:0] a, input [7:0] b);
        integer k;
        reg [7:0] x, r;
        begin
            x = a;
            r = 8'd0;
            for (k = 0; k < 8; k = k + 1) begin
                if (b[k]) r = r ^ x;
                x = {x[6:0], 1'b0} ^ (x[7] ? 8'h1d : 8'h00);
            end
            gf_mul = r;
        end
    endfunction
    /* verilator lint_on BLKSEQ */

    reg [7:0] par[0:15];
    reg [7:0] cnt;        // data byte index (0..187) or parity index (0..15)
    reg       in_parity;  // sending parity bytes
    reg       started;

    wire out_free = !m_valid || m_ready;
    assign s_ready = out_free && !in_parity;
    wire take = s_valid && s_ready && (started || s_sop);

    wire [7:0] fb = s_data ^ (s_sop ? 8'd0 : par[15]);  // a new packet starts from zero state

    integer i;
    always @(posedge clk) begin
        if (rst) begin
            cnt       <= 8'd0;
            in_parity <= 1'b0;
            started   <= 1'b0;
            m_valid   <= 1'b0;
            m_sop     <= 1'b0;
            m_data    <= 8'd0;
            for (i = 0; i < 16; i = i + 1) par[i] <= 8'd0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (in_parity) begin
                if (out_free) begin
                    m_valid <= 1'b1;
                    m_sop   <= 1'b0;
                    m_data  <= par[15];
                    for (i = 15; i > 0; i = i - 1) par[i] <= par[i-1];
                    par[0] <= 8'd0;
                    cnt <= cnt + 8'd1;
                    if (cnt == 8'd15) begin
                        in_parity <= 1'b0;
                        cnt       <= 8'd0;
                    end
                end
            end else if (take) begin
                started <= 1'b1;
                m_valid <= 1'b1;
                m_sop   <= s_sop;
                m_data  <= s_data;
                // A sync byte always restarts the packet, even if the last
                // one was short (lost bytes upstream).
                for (i = 15; i > 0; i = i - 1)
                    par[i] <= (s_sop ? 8'd0 : par[i-1]) ^ gf_mul(fb, gcoef(i));
                par[0] <= gf_mul(fb, gcoef(0));
                if (s_sop) cnt <= 8'd1;
                else cnt <= cnt + 8'd1;
                if ((s_sop ? 8'd0 : cnt) == 8'd187) begin
                    in_parity <= 1'b1;
                    cnt       <= 8'd0;
                end
            end
        end
    end
endmodule

`default_nettype wire

// EN 300 744 §4.3.4.2 symbol interleaver, 2K mode (Nmax = 1512).
//
// Blocks of 1512 data symbols, one per OFDM symbol. With H(q) the permutation
// below, even OFDM symbols are written y[H(q)] = y'[q] (scattered write,
// sequential read) and odd ones read y[q] = y'[H(q)] (sequential write,
// scattered read). Symbol parity counts from 0 at reset, as gr-dtv's does;
// a frame has 68 symbols, so the parity also holds across frames.
//
// H(q): 10-bit LFSR R'_i (R'_i[9] = R'_i-1[0] ^ R'_i-1[3]; R'_0 = R'_1 = 0,
// R'_2 = 1), bit-permuted to R_i (Table 6, 2K), H = (i mod 2) * 1024 + R_i,
// values >= 1512 skipped. dvbt_symbol_hgen produces it one value at a time;
// writer and reader each own one because both may need H in the same clock.
//
// Two banks of 1512 x 6 bits (inferred as block RAM): one fills while the
// other drains.
`default_nettype none

module dvbt_symbol_hgen (
    input  wire        clk,
    input  wire        restart,  // back to q = 0 (takes effect next clock)
    input  wire        next,     // consume h; ignored unless h_valid
    output wire [10:0] h,
    output wire        h_valid
);
    reg [10:0] i;
    reg  [9:0] rp;

    wire [9:0] r = {rp[2], rp[5], rp[8], rp[3], rp[7], rp[0], rp[1], rp[4], rp[6], rp[9]};
    // r[9..0] = R_i bits: R[9]=R'2 R[8]=R'5 R[7]=R'8 R[6]=R'3 R[5]=R'7
    //                     R[4]=R'0 R[3]=R'1 R[2]=R'4 R[1]=R'6 R[0]=R'9
    assign h = {i[0], r};
    assign h_valid = (h < 11'd1512);

    always @(posedge clk) begin
        if (restart) begin
            i  <= 11'd0;
            rp <= 10'd0;
        end else if (!h_valid || next) begin
            i <= i + 11'd1;
            if (i == 11'd1) rp <= 10'd1;
            else if (i >= 11'd2) rp <= {rp[0] ^ rp[3], rp[9:1]};
        end
    end
endmodule

module dvbt_symbol_interleaver (
    input  wire       clk,
    input  wire       rst,
    input  wire [5:0] s_sym,
    input  wire       s_valid,
    output wire       s_ready,
    output reg  [5:0] m_sym,
    output reg        m_valid,
    output reg        m_sos,     // first data symbol of an OFDM symbol
    input  wire       m_ready
);
    localparam N = 1512;

    reg [5:0] mem[0:2*N-1];

    reg  [1:0] full;
    reg        wbank, rbank;
    reg        wodd, rodd;      // OFDM symbol parity of the block being written / read
    reg [10:0] wq, rq;

    wire [10:0] hw, hr;
    wire        hw_ok, hr_ok;

    assign s_ready = !full[wbank] && (wodd || hw_ok);
    wire take = s_valid && s_ready;
    wire give = full[rbank] && (!m_valid || m_ready) && (!rodd || hr_ok);
    wire wdone = take && (wq == N - 1);
    wire rdone = give && (rq == N - 1);

    dvbt_symbol_hgen u_hw (
        .clk(clk), .restart(rst || wdone), .next(take && !wodd), .h(hw), .h_valid(hw_ok)
    );
    dvbt_symbol_hgen u_hr (
        .clk(clk), .restart(rst || rdone), .next(give && rodd), .h(hr), .h_valid(hr_ok)
    );

    wire [11:0] wa = (wbank ? N : 0) + {1'b0, wodd ? wq : hw};
    wire [11:0] ra = (rbank ? N : 0) + {1'b0, rodd ? hr : rq};

    always @(posedge clk) begin
        if (take) mem[wa] <= s_sym;
        if (give) m_sym <= mem[ra];
    end

    always @(posedge clk) begin
        if (rst) begin
            full    <= 2'b00;
            wbank   <= 1'b0;
            rbank   <= 1'b0;
            wodd    <= 1'b0;
            rodd    <= 1'b0;
            wq      <= 11'd0;
            rq      <= 11'd0;
            m_valid <= 1'b0;
            m_sos   <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (take) wq <= wdone ? 11'd0 : wq + 11'd1;
            if (wdone) begin
                wbank <= ~wbank;
                wodd  <= ~wodd;
            end
            if (give) begin
                m_valid <= 1'b1;
                m_sos   <= (rq == 11'd0);
                rq      <= rdone ? 11'd0 : rq + 11'd1;
            end
            if (rdone) begin
                rbank <= ~rbank;
                rodd  <= ~rodd;
            end
            full[0] <= (full[0] | (wdone && !wbank)) & ~(rdone && !rbank);
            full[1] <= (full[1] | (wdone && wbank)) & ~(rdone && rbank);
        end
    end
endmodule

`default_nettype wire

// EN 300 744 §4.3.1 transport multiplex adaptation and energy dispersal.
//
// Input: 188-byte MPEG-TS packets, s_sop high on each packet's sync byte.
// Bytes before the first s_sop are dropped.
//
// Packets are taken in groups of eight. The first packet's sync byte is sent
// inverted (0x47 -> 0xB8) and the PRBS (1 + x^14 + x^15, loaded with
// 100101010000000) restarts on the byte after it. The PRBS keeps running over
// the other seven sync bytes but is not applied to them. Data bytes are XORed
// with the PRBS, MSB first. The period is 8 * 188 - 1 = 1503 bytes.
//
// Throughput: one byte per clock. Valid/ready on both sides.
`default_nettype none

module dvbt_energy_dispersal (
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
    // prbs[0] is register stage 1, prbs[14] is stage 15.
    localparam [14:0] PRBS_INIT = 15'b000_0000_1010_1001;  // stages 1..15 = 100101010000000

    reg [14:0] prbs;
    reg  [2:0] pkt;      // packet index within the group of 8
    reg        started;  // seen the first sync byte

    // Advance the PRBS 8 steps; returns {next_state, byte} with the first
    // generated bit in the MSB.
    function [22:0] prbs_byte(input [14:0] st);
        integer i;
        reg [14:0] s;
        reg  [7:0] b;
        reg        o;
        begin
            s = st;
            for (i = 7; i >= 0; i = i - 1) begin
                o    = s[13] ^ s[14];
                b[i] = o;
                s    = {s[13:0], o};
            end
            prbs_byte = {s, b};
        end
    endfunction

    wire [22:0] step = prbs_byte(prbs);
    wire [14:0] prbs_next = step[22:8];
    wire  [7:0] prbs_out = step[7:0];

    assign s_ready = !m_valid || m_ready;
    wire take = s_valid && s_ready;

    always @(posedge clk) begin
        if (rst) begin
            prbs    <= PRBS_INIT;
            pkt     <= 3'd0;
            started <= 1'b0;
            m_valid <= 1'b0;
            m_data  <= 8'd0;
            m_sop   <= 1'b0;
        end else begin
            if (m_valid && m_ready) m_valid <= 1'b0;
            if (take && (started || s_sop)) begin
                m_valid <= 1'b1;
                m_sop   <= s_sop;
                if (s_sop) begin
                    started <= 1'b1;
                    // pkt is the index of the packet this sync byte opens.
                    pkt     <= (started ? pkt + 3'd1 : 3'd0);
                    if (!started || pkt == 3'd7) begin
                        m_data <= ~s_data;  // first packet of a group
                        prbs   <= PRBS_INIT;
                    end else begin
                        m_data <= s_data;   // PRBS runs, not applied
                        prbs   <= prbs_next;
                    end
                end else begin
                    m_data <= s_data ^ prbs_out;
                    prbs   <= prbs_next;
                end
            end
        end
    end
endmodule

`default_nettype wire

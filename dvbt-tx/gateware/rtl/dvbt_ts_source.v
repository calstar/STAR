// TS packets from the input FIFO to the modulator, with null packets in the
// gaps. The FIFO holds only whole packets (the host interface commits a
// packet when its 188th byte arrives), so at each packet boundary: if the
// FIFO has a byte, a whole packet follows; if not, send a null packet
// (PID 0x1FFF: 47 1F FF 10 FF...) so the modulator never starves -- DVB-T
// is a constant-rate stream and the DAC cannot wait. null_pkt pulses for
// each one inserted.
`default_nettype none

module dvbt_ts_source (
    input  wire       clk,
    input  wire       rst,
    input  wire [7:0] f_data,
    input  wire       f_valid,
    output wire       f_ready,
    output reg  [7:0] m_data,
    output reg        m_sop,
    output reg        m_valid,
    input  wire       m_ready,
    output reg        null_pkt
);
    reg [7:0] cnt;                      // byte index in the packet
    reg       is_null;
    wire en = !m_valid || m_ready;
    wire boundary = (cnt == 8'd0);
    assign f_ready = en && (boundary || !is_null);

    function [7:0] null_byte(input [7:0] k);
        case (k)
            8'd0:    null_byte = 8'h47;
            8'd1:    null_byte = 8'h1F;
            8'd2:    null_byte = 8'hFF;
            8'd3:    null_byte = 8'h10;
            default: null_byte = 8'hFF;
        endcase
    endfunction

    always @(posedge clk) begin
        if (rst) begin
            cnt <= 8'd0;
            is_null <= 1'b0;
            m_valid <= 1'b0;
            null_pkt <= 1'b0;
        end else begin
            null_pkt <= 1'b0;
            if (en) begin
                if (boundary) begin
                    is_null  <= !f_valid;
                    null_pkt <= !f_valid;
                    m_data   <= f_valid ? f_data : 8'h47;
                    m_sop    <= 1'b1;
                    m_valid  <= 1'b1;
                    cnt      <= 8'd1;
                end else if (is_null || f_valid) begin
                    m_data  <= is_null ? null_byte(cnt) : f_data;
                    m_sop   <= 1'b0;
                    m_valid <= 1'b1;
                    cnt     <= (cnt == 8'd187) ? 8'd0 : cnt + 8'd1;
                end else begin
                    m_valid <= 1'b0;
                end
            end
        end
    end
endmodule

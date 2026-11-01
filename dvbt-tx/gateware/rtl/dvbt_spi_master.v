// SPI master for the AD9116 and ADRF6755 setup registers. Mode 0, MSB
// first, 1..32 bits per transaction (tx left-aligned: bit 31 goes first),
// SCLK = clk / (2 (div + 1)). One chip select per device. Bits on SDI are
// captured on the rising edges and returned right-aligned in rx (a device
// in 3-wire mode needs its 4-wire SDO mode set first to be read back).
`default_nettype none

module dvbt_spi_master (
    input  wire        clk,
    input  wire        rst,
    input  wire        start,
    input  wire [31:0] tx,
    input  wire  [4:0] nbits_m1,   // bits - 1
    input  wire        dev,        // 0: cs_n[0], 1: cs_n[1]
    input  wire  [7:0] div,
    output reg  [31:0] rx,
    output reg         busy,
    output reg         sclk,
    output wire        mosi,
    input  wire        miso,
    output reg   [1:0] cs_n
);
    reg [31:0] sh;
    reg  [4:0] left;
    reg  [7:0] tick;
    reg        tail;               // CS hold after the last falling edge
    assign mosi = sh[31];

    always @(posedge clk) begin
        if (rst) begin
            busy <= 1'b0;
            sclk <= 1'b0;
            cs_n <= 2'b11;
            tail <= 1'b0;
        end else if (!busy) begin
            if (start) begin
                busy <= 1'b1;
                sh   <= tx;
                left <= nbits_m1;
                rx   <= 32'd0;
                tick <= div;
                tail <= 1'b0;
                cs_n <= dev ? 2'b01 : 2'b10;
            end
        end else if (tick != 8'd0) begin
            tick <= tick - 8'd1;
        end else begin
            tick <= div;
            if (tail) begin
                cs_n <= 2'b11;
                busy <= 1'b0;
            end else if (!sclk) begin
                sclk <= 1'b1;
                rx   <= {rx[30:0], miso};
            end else begin
                sclk <= 1'b0;
                sh   <= {sh[30:0], 1'b0};
                if (left == 5'd0) tail <= 1'b1;
                else left <= left - 5'd1;
            end
        end
    end
endmodule

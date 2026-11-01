// Generic SPI master for the setup buses (AD9116, ADRF6755, anything else
// on the board): the FPGA knows no device, the ESP32 sends each device's
// own instruction and data bits through it.
//
// Mode 0 (SCLK idle low, data out on the falling edge, sampled on the
// rising edge), MSB first, 1..32 bits per transaction (tx left-aligned:
// bit 31 goes first), SCLK = clk / (2 (div + 1)), one chip select per
// device.
//   4-wire (three_wire = 0): sdo drives all the time, bits come back on
//     miso.
//   3-wire (three_wire = 1): sdo drives the first wr_bits bits, then is
//     released (sdo_oe low) at the falling edge after the last of them --
//     where a 3-wire device starts driving -- and the rest come back on the
//     same line (sdio_in). An AD9116 register read is 8 instruction bits,
//     then 8 per data byte: nbits = 8 + 8n, wr_bits = 8. For a write, set
//     wr_bits to the total (or use 4-wire framing).
// Bits clocked in are returned right-aligned in rx.
//   cs_only: no clock, no data: chip select low for 2 (div + 1) clocks,
//     then high as usual (the ADRF6755 selects and locks SPI mode on the
//     third such pulse; datasheet Rev. B, Figure 67).
`default_nettype none

module dvbt_spi_master (
    input  wire        clk,
    input  wire        rst,
    input  wire        start,
    input  wire [31:0] tx,
    input  wire  [4:0] nbits_m1,   // bits - 1
    input  wire        dev,        // 0: cs_n[0], 1: cs_n[1]
    input  wire  [7:0] div,
    input  wire        three_wire,
    input  wire  [5:0] wr_bits,    // 3-wire: bits driven before the turnaround
    input  wire        cs_only,    // pulse chip select only
    output reg  [31:0] rx,
    output reg         busy,
    output reg         sclk,
    output wire        sdo,
    output reg         sdo_oe,
    input  wire        sdio_in,
    input  wire        miso,
    output reg   [1:0] cs_n
);
    reg [31:0] sh;
    reg  [4:0] left;
    reg  [5:0] sent;               // bits completed (falling edges)
    reg  [7:0] tick;
    reg        tail;               // CS hold after the last falling edge
    reg        tw;
    reg  [5:0] wb;
    reg        co;
    assign sdo = sh[31];
    wire sdi = tw ? sdio_in : miso;

    always @(posedge clk) begin
        if (rst) begin
            busy   <= 1'b0;
            sclk   <= 1'b0;
            cs_n   <= 2'b11;
            tail   <= 1'b0;
            sdo_oe <= 1'b1;
        end else if (!busy) begin
            sdo_oe <= 1'b1;
            if (start) begin
                busy <= 1'b1;
                sh   <= tx;
                left <= nbits_m1;
                sent <= 6'd0;
                rx   <= 32'd0;
                tick <= div;
                tail <= 1'b0;
                tw   <= three_wire;
                wb   <= wr_bits;
                co   <= cs_only;
                sdo_oe <= !(three_wire && wr_bits == 6'd0);
                cs_n <= dev ? 2'b01 : 2'b10;
            end
        end else if (tick != 8'd0) begin
            tick <= tick - 8'd1;
        end else begin
            tick <= div;
            if (tail) begin
                cs_n <= 2'b11;
                busy <= 1'b0;
            end else if (co) begin
                tail <= 1'b1;          // one tick low, then the tail raises CS
            end else if (!sclk) begin
                sclk <= 1'b1;
                rx   <= {rx[30:0], sdi};
            end else begin
                sclk <= 1'b0;
                sh   <= {sh[30:0], 1'b0};
                sent <= sent + 6'd1;
                if (tw && sent + 6'd1 >= wb) sdo_oe <= 1'b0;
                if (left == 5'd0) tail <= 1'b1;
                else left <= left - 5'd1;
            end
        end
    end
endmodule

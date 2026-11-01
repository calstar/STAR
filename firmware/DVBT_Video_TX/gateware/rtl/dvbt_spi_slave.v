// SPI slave for the ESP32-P4 (mode 0: sample MOSI on SCK rising, MISO
// changes on SCK falling; MSB first; CS active low). SCK clocks its own
// little domain, so SCK may run up to ~20 MHz independent of the 27.43 MHz
// system clock (it needs 8 SCK periods > ~5 system clocks per byte).
//
// SCK domain: shift register, bit and byte counters (reset while CS is
// high). Each completed byte is parked in rx_buf with a "first byte of the
// frame" flag, and rx_tog flips. The system domain synchronises rx_tog
// (rx_buf is stable for the next 8 SCK periods) and pulses rx_valid.
// frame_end pulses when CS rises, synchronised more deeply than rx_tog so
// it always lands after the frame's last byte.
//
// MISO: byte 0 of every frame carries stat (frozen by the system while a
// frame is open); bytes 2..5 carry rd_word, MSB first (byte 1 is the
// turnaround the system needs to load rd_word after a read command).
`default_nettype none

module dvbt_spi_slave (
    input  wire        clk,
    input  wire        rst,
    input  wire        spi_sck,
    input  wire        spi_cs_n,
    input  wire        spi_mosi,
    output wire        spi_miso,
    input  wire  [7:0] stat,
    input  wire [31:0] rd_word,
    output reg   [7:0] rx_byte,
    output reg         rx_first,
    output reg         rx_valid,
    output reg         frame_end,
    output wire        frame_open
);
    // ---- SCK domain ---------------------------------------------------------
    reg [2:0] bitcnt, bytecnt;
    reg [6:0] sr;
    reg [7:0] rx_buf;
    reg       rx_buf_first;
    reg       rx_tog = 1'b0;
    always @(posedge spi_sck or posedge spi_cs_n) begin
        if (spi_cs_n) begin
            bitcnt  <= 3'd0;
            bytecnt <= 3'd0;
        end else begin
            sr     <= {sr[5:0], spi_mosi};
            bitcnt <= bitcnt + 3'd1;
            if (bitcnt == 3'd7 && bytecnt != 3'd7) bytecnt <= bytecnt + 3'd1;
        end
    end
    always @(posedge spi_sck) begin
        if (!spi_cs_n && bitcnt == 3'd7) begin
            rx_buf       <= {sr, spi_mosi};
            rx_buf_first <= (bytecnt == 3'd0);
            rx_tog       <= ~rx_tog;
        end
    end

    // MISO: the bit for (bytecnt, bitcnt), registered on the falling edge;
    // until the first falling edge of a frame, stat's MSB.
    reg       miso_r, started;
    wire [4:0] widx = {bytecnt[1:0] - 2'd2, 3'd0} + {2'b00, bitcnt};
    wire       nbit = (bytecnt == 3'd0) ? stat[3'd7 - bitcnt]
                    : (bytecnt >= 3'd2 && bytecnt <= 3'd5) ? rd_word[5'd31 - widx]
                    : 1'b0;
    always @(negedge spi_sck or posedge spi_cs_n) begin
        if (spi_cs_n) begin
            started <= 1'b0;
            miso_r  <= 1'b0;
        end else begin
            started <= 1'b1;
            miso_r  <= nbit;
        end
    end
    assign spi_miso = started ? miso_r : stat[7];

    // ---- system domain ------------------------------------------------------
    reg [2:0] tog_s;
    reg [4:0] cs_s;
    always @(posedge clk) begin
        if (rst) begin
            tog_s <= {3{rx_tog}};
            cs_s  <= 5'h1F;
            rx_valid  <= 1'b0;
            frame_end <= 1'b0;
        end else begin
            tog_s <= {tog_s[1:0], rx_tog};
            cs_s  <= {cs_s[3:0], spi_cs_n};
            rx_valid  <= tog_s[2] ^ tog_s[1];
            rx_byte   <= rx_buf;
            rx_first  <= rx_buf_first;
            frame_end <= cs_s[3] & ~cs_s[4];
        end
    end
    assign frame_open = !cs_s[1] || !cs_s[4];
endmodule

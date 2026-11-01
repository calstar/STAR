// Board top for the LFE5U-25F-7TG144C: the transmitter core, the PLL, the
// power-on reset and the forwarded DAC clock. Pins: board/dvbt_tx.lpf.
//
// Clocking: the Si5351A's 27.428571 MHz (programmed over I2C by the
// ESP32-P4 at boot; until then there is no clock and nothing runs) enters
// the PLL, which gives the system clock in phase with it and a copy
// shifted 90 degrees. The DAC data clock is forwarded from the shifted
// copy through an ODDRX1F, so its edges fall mid-way through each DDR data
// bit (I while it is high, Q while low).
`default_nettype none

module dvbt_tx_top (
    input  wire        clk_in,
    input  wire        spi_sck,
    input  wire        spi_cs_n,
    input  wire        spi_mosi,
    output wire        spi_miso,
    output wire        dreq,
    output wire [11:0] dac_d,
    output wire        dac_dclk,
    output wire        sm_sclk,
    output wire        sm_mosi,
    input  wire        sm_miso,
    output wire        dac_cs_n,
    output wire        syn_cs_n,
    output wire        led_tx
);
    wire clk, clk90, locked;
    dvbt_pll u_pll (.clkin(clk_in), .clk(clk), .clk90(clk90), .locked(locked));

    // Reset until the PLL has been locked for 2^10 clocks.
    reg [10:0] por = 11'd0;
    reg        rst = 1'b1;
    always @(posedge clk) begin
        if (!locked) por <= 11'd0;
        else if (!por[10]) por <= por + 11'd1;
        rst <= !por[10];
    end

    wire [1:0] sm_cs;
    dvbt_tx_core u_core (
        .clk(clk), .rst(rst),
        .spi_sck(spi_sck), .spi_cs_n(spi_cs_n), .spi_mosi(spi_mosi), .spi_miso(spi_miso),
        .dreq(dreq), .dac_d(dac_d),
        .sm_sclk(sm_sclk), .sm_mosi(sm_mosi), .sm_miso(sm_miso), .sm_cs_n(sm_cs),
        .tx_on(led_tx)
    );
    assign dac_cs_n = sm_cs[0];
    assign syn_cs_n = sm_cs[1];

    ODDRX1F u_dclk (.SCLK(clk90), .RST(1'b0), .D0(1'b1), .D1(1'b0), .Q(dac_dclk));
endmodule

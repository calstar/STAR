// Board top for the LFE5U-25F-7TG144C: the transmitter core, the PLL, the
// power-on reset and the forwarded DAC clock. Pins: board/dvbt_tx.lpf.
//
// Clocking: the Si5351A's 27.428571 MHz (programmed over I2C by the
// ESP32-P4 at boot; until then there is no clock and nothing runs) enters
// the PLL, which gives the system clock in phase with it and a copy
// shifted 90 degrees. The DAC data clock is forwarded from the shifted
// copy through an ODDRX1F, so its edges fall mid-way through each DDR data
// bit (I while it is high, Q while low). AD9116 datasheet Rev. F: DCLKIO
// is the data clock input (DCI_EN = 1 by default), IRISING = 1 latches I
// on its rising edge, IFIRST = 1 pairs I first; setup -0.2 ns, hold 1.6 ns
// at 3.3 V I/O, so a quarter period (9.1 ns) each side is ample. CLKIN
// (the sampling clock) comes straight from the Si5351A; the DAC's retimer
// finds the DCLKIO-to-CLKIN phase itself (CLKMODE 0x14 Searching = 0 when
// done).
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
    inout  wire        sm_sdio,     // AD9116 SDIO (3-wire); MOSI for 4-wire devices
    input  wire        sm_miso,     // 4-wire devices' data out (ADRF6755)
    output wire        dac_cs_n,
    output wire        syn_cs_n,
    output wire        dac_reset,   // AD9116 RESET/PINMD: needs a pull-down on the board
    output wire  [2:0] gpio_aux,
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
    wire       sm_sdo, sm_sdo_oe;
    wire [3:0] gpio;
    assign sm_sdio = sm_sdo_oe ? sm_sdo : 1'bz;
    assign dac_reset = gpio[0];
    assign gpio_aux  = gpio[3:1];
    dvbt_tx_core u_core (
        .clk(clk), .rst(rst),
        .spi_sck(spi_sck), .spi_cs_n(spi_cs_n), .spi_mosi(spi_mosi), .spi_miso(spi_miso),
        .dreq(dreq), .dac_d(dac_d),
        .sm_sclk(sm_sclk), .sm_sdo(sm_sdo), .sm_sdo_oe(sm_sdo_oe), .sm_sdio_in(sm_sdio),
        .sm_miso(sm_miso), .sm_cs_n(sm_cs), .gpio(gpio),
        .tx_on(led_tx)
    );
    assign dac_cs_n = sm_cs[0];
    assign syn_cs_n = sm_cs[1];

    ODDRX1F u_dclk (.SCLK(clk90), .RST(1'b0), .D0(1'b1), .D1(1'b0), .Q(dac_dclk));
endmodule

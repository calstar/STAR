// Simulation model of the ECP5 PLL for the end-to-end test (Verilator, no
// timing): CLKOP follows CLKI (the board's PLL is 1:1), and the harness
// drives clkos_sim itself a quarter period after each CLKI edge -- the 90
// degree output -- since a zero-delay model cannot shift a clock. LOCK
// rises after 64 CLKI cycles, as the real PLL's lock takes time.
`default_nettype none
/* verilator lint_off UNUSEDPARAM */
/* verilator lint_off UNUSEDSIGNAL */
module EHXPLLL #(
    parameter PLLRST_ENA = "DISABLED", parameter INTFB_WAKE = "DISABLED",
    parameter STDBY_ENABLE = "DISABLED", parameter DPHASE_SOURCE = "DISABLED",
    parameter OUTDIVIDER_MUXA = "DIVA", parameter OUTDIVIDER_MUXB = "DIVB",
    parameter OUTDIVIDER_MUXC = "DIVC", parameter OUTDIVIDER_MUXD = "DIVD",
    parameter integer CLKI_DIV = 1, parameter CLKOP_ENABLE = "ENABLED",
    parameter integer CLKOP_DIV = 8, parameter integer CLKOP_CPHASE = 0,
    parameter integer CLKOP_FPHASE = 0, parameter CLKOS_ENABLE = "DISABLED",
    parameter integer CLKOS_DIV = 8, parameter integer CLKOS_CPHASE = 0,
    parameter integer CLKOS_FPHASE = 0, parameter FEEDBK_PATH = "CLKOP",
    parameter integer CLKFB_DIV = 1
) (
    input  wire CLKI, CLKFB, RST, STDBY, PHASESEL0, PHASESEL1, PHASEDIR, PHASESTEP,
    input  wire PHASELOADREG, PLLWAKESYNC, ENCLKOP,
    output wire CLKOP, CLKOS, LOCK, CLKINTFB
);
    reg clkos_sim /*verilator public_flat_rw*/ = 1'b0;
    reg [6:0] n = 7'd0;
    always @(posedge CLKI) if (!n[6]) n <= n + 7'd1;
    assign CLKOP = CLKI;
    assign CLKOS = clkos_sim;
    assign LOCK = n[6];
    assign CLKINTFB = 1'b0;
endmodule

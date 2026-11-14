// Simulation model of the ECP5 ODDRX1F (Lattice TN1265): D0 and D1 are
// registered on the rising edge of SCLK; Q shows D0 while SCLK is high and
// D1 while it is low, one cycle later. For simulation only; synthesis uses
// the real primitive.
`default_nettype none
module ODDRX1F (input wire SCLK, input wire RST, input wire D0, input wire D1, output wire Q);
    reg r0 = 1'b0, r1 = 1'b0, q1 = 1'b0;
    always @(posedge SCLK) begin
        if (RST) begin r0 <= 1'b0; r1 <= 1'b0; end
        else begin r0 <= D0; r1 <= D1; end
    end
    always @(negedge SCLK) q1 <= r1;
    assign Q = SCLK ? r0 : q1;
endmodule

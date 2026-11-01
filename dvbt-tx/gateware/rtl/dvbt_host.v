// The ESP32-P4's side of the FPGA: one SPI bus carrying the transport
// stream and the register commands, DREQ for flow control.
//
// Frames (CS low ... CS high), first byte the command:
//   00, then TS bytes       whole 188-byte packets, sync byte 0x47 first
//   80|a, b3 b2 b1 b0       write register a (32 bits, MSB first)
//   40|a, xx, b3 b2 b1 b0   read register a (xx: turnaround byte)
// MISO during the command byte is the status byte:
//   {dreq, tx_en, underflow, err_align, ts_bad, ts_overflow, spi_busy, 0}
//
// TS: a packet enters the FIFO only when all 188 bytes have arrived with
// 0x47 first; a packet cut short by CS, with a bad sync byte, or that found
// the FIFO full is discarded whole (and flagged), so the stream behind the
// FIFO is always packet-aligned. DREQ is high while the FIFO has room for
// two more packets: check it before each packet. Behind the FIFO,
// dvbt_ts_source fills any gap with null packets.
//
// Registers (32-bit):
//   0 CTRL    [0] tx_en  [2:1] mod  [5:3] rate  [7:6] guard
//             [8] DAC offset-binary  [9] DAC I/Q edge swap    reset 0x00000080
//   1 GAIN    [31:16] gain_i  [15:0] gain_q  (Q2.14)          reset 2.5, 2.5
//   2 PHASE   [15:0] I-into-Q phase trim (signed Q2.14)       reset 0
//   3 DCOFF   [27:16] DC offset I  [11:0] DC offset Q (signed DAC LSBs)
//   4 SPIDATA write: start an SPI transaction with these bits (MSB first);
//             read: the bits clocked in by the last one (right-aligned)
//   5 SPICFG  [4:0] bits-1  [8] device (0 AD9116, 1 ADRF6755)  [23:16] clock
//             divider; read [31] busy                          reset 23 bits, div 4
//   6 STATUS  [0] DAC underflow [1] err_align [2] ts_bad [3] ts_overflow
//             (sticky; write 1 to clear)  [31:16] null packets inserted
//             (saturating; write bit 31 to clear)
//   7 ID      0xD7B70001
// tx_en low holds the whole modulator in reset and the DAC at mid-scale;
// set the configuration, then raise tx_en. The TS FIFO keeps filling while
// tx_en is low, so the stream can be primed first.
`default_nettype none
/* verilator lint_off SYNCASYNCNET */  // spi_cs_n: async reset of the SCK domain, synchronised for the system

module dvbt_host (
    input  wire        clk,
    input  wire        rst,
    // ESP32-P4
    input  wire        spi_sck,
    input  wire        spi_cs_n,
    input  wire        spi_mosi,
    output wire        spi_miso,
    output reg         dreq,
    // TS out (to the modulator)
    output wire  [7:0] ts_data,
    output wire        ts_sop,
    output wire        ts_valid,
    input  wire        ts_ready,
    input  wire        ts_rst,          // the modulator's reset (tx_en low)
    // configuration
    output wire        tx_en,
    output wire  [1:0] cfg_mod,
    output wire  [2:0] cfg_rate,
    output wire  [1:0] cfg_guard,
    output wire        cfg_obin,
    output wire        cfg_swap,
    output wire [15:0] gain_i,
    output wire [15:0] gain_q,
    output wire [15:0] phase,
    output wire [11:0] off_i,
    output wire [11:0] off_q,
    // status in
    input  wire        st_underflow,
    input  wire        st_align,
    // setup SPI to the DAC and the synthesizer
    output wire        sm_sclk,
    output wire        sm_mosi,
    input  wire        sm_miso,
    output wire  [1:0] sm_cs_n
);
    localparam [31:0] ID = 32'hD7B7_0001;

    // ---- registers ----------------------------------------------------------
    reg [31:0] r_ctrl, r_gain, r_phase, r_dcoff, r_spidata, r_spicfg;
    reg  [3:0] flags;               // underflow, align, ts_bad, ts_overflow
    reg [15:0] nulls;
    wire [31:0] sm_rx;
    wire        sm_busy;
    reg         sm_start;

    assign tx_en     = r_ctrl[0];
    assign cfg_mod   = r_ctrl[2:1];
    assign cfg_rate  = r_ctrl[5:3];
    assign cfg_guard = r_ctrl[7:6];
    assign cfg_obin  = r_ctrl[8];
    assign cfg_swap  = r_ctrl[9];
    assign gain_i    = r_gain[31:16];
    assign gain_q    = r_gain[15:0];
    assign phase     = r_phase[15:0];
    assign off_i     = r_dcoff[27:16];
    assign off_q     = r_dcoff[11:0];

    function [31:0] rd(input [2:0] a);
        case (a)
            3'd0: rd = r_ctrl;
            3'd1: rd = r_gain;
            3'd2: rd = r_phase;
            3'd3: rd = r_dcoff;
            3'd4: rd = sm_rx;
            3'd5: rd = {sm_busy, r_spicfg[30:0]};
            3'd6: rd = {nulls, 12'd0, flags};
            default: rd = ID;
        endcase
    endfunction

    // ---- SPI slave ----------------------------------------------------------
    wire [7:0] rx_byte;
    wire       rx_first, rx_valid, frame_end, frame_open;
    reg  [7:0] stat;
    reg [31:0] rd_word;
    dvbt_spi_slave u_slave (
        .clk(clk), .rst(rst), .spi_sck(spi_sck), .spi_cs_n(spi_cs_n),
        .spi_mosi(spi_mosi), .spi_miso(spi_miso), .stat(stat), .rd_word(rd_word),
        .rx_byte(rx_byte), .rx_first(rx_first), .rx_valid(rx_valid),
        .frame_end(frame_end), .frame_open(frame_open)
    );

    // ---- TS FIFO --------------------------------------------------------------
    wire  [7:0] f_data;
    wire        f_valid, f_ready, f_sready;
    wire [11:0] f_free;
    wire [11:0] f_level;            // unused: DREQ works from free space
    wire        unused = &{1'b0, f_level, r_spicfg[31]};
    reg         f_push, f_commit, f_abort;
    reg   [7:0] f_wdata;
    dvbt_fifo #(.W(8), .AW(11)) u_fifo (
        .clk(clk), .rst(rst), .s_data(f_wdata), .s_valid(f_push), .s_ready(f_sready),
        .w_commit(f_commit), .w_abort(f_abort),
        .m_data(f_data), .m_valid(f_valid), .m_ready(f_ready), .level(f_level), .free(f_free)
    );

    wire null_pkt;
    dvbt_ts_source u_src (
        .clk(clk), .rst(ts_rst), .f_data(f_data), .f_valid(f_valid), .f_ready(f_ready),
        .m_data(ts_data), .m_sop(ts_sop), .m_valid(ts_valid), .m_ready(ts_ready),
        .null_pkt(null_pkt)
    );

    dvbt_spi_master u_sm (
        .clk(clk), .rst(rst), .start(sm_start), .tx(r_spidata), .nbits_m1(r_spicfg[4:0]),
        .dev(r_spicfg[8]), .div(r_spicfg[23:16]), .rx(sm_rx), .busy(sm_busy),
        .sclk(sm_sclk), .mosi(sm_mosi), .miso(sm_miso), .cs_n(sm_cs_n)
    );

    // ---- command decoding -----------------------------------------------------
    localparam [1:0] C_NONE = 2'd0, C_TS = 2'd1, C_WR = 2'd2;
    reg  [1:0] mode;
    reg  [2:0] addr;
    reg  [2:0] nb;                  // register-write bytes so far
    reg [23:0] wsh;
    reg  [7:0] pc;                  // byte index in the current TS packet
    reg        bad;                 // current packet will be discarded

    always @(posedge clk) begin
        if (rst) begin
            r_ctrl    <= 32'h0000_0080;
            r_gain    <= {16'd40960, 16'd40960};
            r_phase   <= 32'd0;
            r_dcoff   <= 32'd0;
            r_spidata <= 32'd0;
            r_spicfg  <= 32'h0004_0017;
            flags     <= 4'd0;
            nulls     <= 16'd0;
            mode      <= C_NONE;
            f_push    <= 1'b0;
            f_commit  <= 1'b0;
            f_abort   <= 1'b0;
            sm_start  <= 1'b0;
            dreq      <= 1'b0;
            stat      <= 8'd0;
            pc        <= 8'd0;
        end else begin
            f_push   <= 1'b0;
            f_commit <= 1'b0;
            f_abort  <= 1'b0;
            sm_start <= 1'b0;
            dreq     <= (f_free >= 12'd376);
            if (!frame_open)
                stat <= {dreq, r_ctrl[0], flags[0], flags[1], flags[2], flags[3], sm_busy, 1'b0};
            if (st_underflow) flags[0] <= 1'b1;
            if (st_align)     flags[1] <= 1'b1;
            if (null_pkt && nulls != 16'hFFFF) nulls <= nulls + 16'd1;

            if (rx_valid && rx_first) begin
                // command byte
                nb <= 3'd0;
                addr <= rx_byte[2:0];
                pc <= 8'd0;
                bad <= 1'b0;
                if (rx_byte == 8'h00)           mode <= C_TS;
                else if (rx_byte[7])            mode <= C_WR;
                else begin
                    mode <= C_NONE;
                    if (rx_byte[7:6] == 2'b01) rd_word <= rd(rx_byte[2:0]);
                end
            end else if (rx_valid && mode == C_TS) begin
                // A byte the FIFO can't take spoils its packet. (Writes are
                // a clock behind rx_valid, bytes many clocks apart, so
                // f_sready already counts the previous byte.)
                f_push  <= 1'b1;
                f_wdata <= rx_byte;
                if ((pc == 8'd0 && rx_byte != 8'h47) || !f_sready || bad) begin
                    bad <= 1'b1;
                    if (pc == 8'd0 && rx_byte != 8'h47) flags[2] <= 1'b1;
                    if (!f_sready) flags[3] <= 1'b1;
                end
                if (pc == 8'd187) begin
                    pc <= 8'd0;
                    bad <= 1'b0;
                    if ((pc == 8'd0 && rx_byte != 8'h47) || !f_sready || bad) f_abort <= 1'b1;
                    else f_commit <= 1'b1;
                end else begin
                    pc <= pc + 8'd1;
                end
            end else if (rx_valid && mode == C_WR) begin
                if (nb != 3'd4) nb <= nb + 3'd1;
                if (nb < 3'd3) wsh <= {wsh[15:0], rx_byte};
                if (nb == 3'd3) begin
                    case (addr)
                        3'd0: r_ctrl  <= {wsh, rx_byte};
                        3'd1: r_gain  <= {wsh, rx_byte};
                        3'd2: r_phase <= {wsh, rx_byte};
                        3'd3: r_dcoff <= {wsh, rx_byte};
                        3'd4: begin
                            r_spidata <= {wsh, rx_byte};
                            sm_start  <= !sm_busy;
                        end
                        3'd5: r_spicfg <= {wsh, rx_byte};
                        3'd6: begin
                            flags <= flags & ~rx_byte[3:0];
                            if (wsh[23]) nulls <= 16'd0;
                        end
                        default: ;
                    endcase
                end
            end
            if (frame_end) begin
                mode <= C_NONE;
                if (mode == C_TS && pc != 8'd0) f_abort <= 1'b1;   // cut short
            end
        end
    end
endmodule

#define _POSIX_C_SOURCE 200809L
/* Simulated Prop Receiver: runs the real prop_core.c behind a UDP socket on localhost.
 * Models the analog side too: DAC code -> loop current -> feedback voltage across a sense resistor.
 * Usage: sim_udp [port]   (default 5005). Prints "READY <port>" when listening. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/select.h>
#include "prop_core.h"

#ifndef SIM_SENSE_OHMS
#define SIM_SENSE_OHMS (1000.0f / FB_MA_PER_V)   /* consistent with pins.h feedback scaling */
#endif

static uint16_t dac[PROP_NUM_CH];
static bool     od_en[PROP_NUM_CH];
static prop_t   core;

static int64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int  h_dac(int ch, uint16_t code) { dac[ch] = code; return 0; }
static void h_od(int ch, bool en) { od_en[ch] = en; }
static int  h_cal(const float *g, const float *o) { (void)g; (void)o; return 0; }
static const prop_hal_t HAL = { h_dac, h_od, h_cal, now_ms, NULL, NULL };

static void update_feedback(void)
{
    int mv[PROP_NUM_CH];
    for (int i = 0; i < PROP_NUM_CH; i++) {
        float v = dac[i] / 65535.0f * DAC_FULL_SCALE_V;
        float i_a = od_en[i] ? v * XTR111_GAIN / LOOP_RS_OHMS : 0.0f;
        float vfb = i_a * SIM_SENSE_OHMS;
        if (vfb > 3.6f) vfb = 3.6f;                       /* Zener clamp */
        mv[i] = (int)(vfb * 1000.0f + 0.5f);
    }
    prop_set_feedback(&core, mv);
}

int main(int argc, char **argv)
{
    int port = argc > 1 ? atoi(argv[1]) : 5005;
    prop_init(&core, &HAL, 0x01);
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); return 1; }
    printf("READY %d\n", port); fflush(stdout);
    for (;;) {
        fd_set fds; FD_ZERO(&fds); FD_SET(s, &fds);
        struct timeval tv = { 0, 20000 };
        int r = select(s + 1, &fds, NULL, NULL, &tv);
        if (r > 0) {
            uint8_t rx[512], out[96]; struct sockaddr_in src; socklen_t sl = sizeof src; size_t ol = 0;
            int n = recvfrom(s, rx, sizeof rx, 0, (struct sockaddr *)&src, &sl);
            if (n > 0 && prop_process_frame(&core, rx, (size_t)n, out, sizeof out, &ol) && ol)
                sendto(s, out, ol, 0, (struct sockaddr *)&src, sl);
        }
        update_feedback();
        prop_failsafe_poll(&core);
    }
}

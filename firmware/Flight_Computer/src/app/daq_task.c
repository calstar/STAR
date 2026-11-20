#include "daq_task.h"

#include <string.h>

#include "board.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "daq_network.h"

static daq_config_t config;
static osMessageQueueId_t samples;
static w5500_udp_t chip;
static daq_peer_t peer;
static uint32_t deadline;
static uint8_t packet[DAQ_PACKET_MAX];

__attribute__((weak)) void daq_board_config(daq_config_t* out) {
    /* Proposal from #180, deliberately disabled until team sign-off. */
    *out = (daq_config_t){
        .discover_server = true,
        .board_id = 81,
        .network = {.ip = {192, 168, 2, 81},
                    .subnet = {255, 255, 255, 0},
                    .port = 5005},
        .server_ip = {192, 168, 2, 20},
        .server_port = 5006,
    };
    uint32_t uid[3];
    board_uid(uid);
    daq_mac_from_uid(uid, out->network.mac);
}

/* One VDM frame, with a common absolute budget across all register calls
 * in a service operation. Always release CS and the SPI2 mutex on failure. */
static bool transfer(void* ctx, uint16_t address, uint8_t block, bool write,
                     uint8_t* bytes, uint16_t length) {
    (void)ctx;
    uint8_t hdr[3] = {(uint8_t)(address >> 8), (uint8_t)address,
                      (uint8_t)((block << 3) | (write ? 4U : 0U))};
    if (board_spi_lock(BOARD_SPI_ETH, deadline) != BOARD_SPI_OK)
        return false;
    board_spi_select(BOARD_SPI_ETH);
    board_spi_status_t st =
        board_spi_shift(BOARD_SPI_ETH, hdr, NULL, 3, deadline);
    if (st == BOARD_SPI_OK)
        st = board_spi_shift(BOARD_SPI_ETH, write ? bytes : NULL,
                             write ? NULL : bytes, length, deadline);
    board_spi_deselect(BOARD_SPI_ETH);
    board_spi_unlock(BOARD_SPI_ETH);
    return st == BOARD_SPI_OK;
}

static bool unicast(const uint8_t ip[4]) {
    return ip[0] != 0 && ip[0] < 224 && ip[0] != 127 && ip[3] != 0 &&
           ip[3] != 255;
}

static void network_task(void* argument) {
    (void)argument;
    bool opened = false, pending = false;
    uint32_t retry_at = board_now_ms(), pending_at = 0,
             last_heartbeat = board_now_ms() - 1000U, sent_at = 0;
    size_t pending_len = 0;
    for (;;) {
        uint32_t now = board_now_ms();
        daq_peer_expire(&peer, now);
        deadline = now + 20U;
        if (!opened) {
            if ((int32_t)(now - retry_at) >= 0) {
                opened = w5500_udp_open(&chip, (w5500_bus_t){transfer, NULL},
                                        &config.network) == 1;
                retry_at = now + 1000U;
            }
            /* Disconnected data is disposable; do not replay a growing backlog.
             */
            osMessageQueueReset(samples);
            osDelay(10);
            continue;
        }
        int link = w5500_udp_link(&chip);
        if (link != 1)
            goto reconnect;
        if (chip.sending) {
            int sent = w5500_udp_sent(&chip);
            if (sent < 0 || (sent == 0 && now - sent_at >= 1000U))
                goto reconnect;
        }
        /* Learn only from a valid server packet, then pin until expiry. */
        uint8_t from[4], incoming[64];
        uint16_t port;
        size_t length;
        int received = w5500_udp_receive(&chip, from, &port, incoming,
                                         sizeof(incoming), &length);
        if (received < 0)
            goto reconnect;
        if (received == 1) {
            daq_peer_t next = peer;
            uint16_t supported = 0;
            for (unsigned i = 0; i < DAQ_CHANNELS; ++i)
                if (config.sources[i] != DAQ_NONE)
                    supported |= (uint16_t)(1U << i);
            if (daq_server_receive(&next, config.server_ip, from,
                                   config.discover_server, supported, incoming,
                                   length, now)) {
                if (next.channels != peer.channels) {
                    pending = false;
                    osMessageQueueReset(samples);
                }
                peer = next;
            }
        }
        /* Configuration and heartbeats may come from separate DAQ sockets,
         * hence the source port is deliberately not used as a filter. */
        (void)port;
        if (chip.sending) {
            osDelay(1);
            continue;
        }
        if (pending && now - pending_at >= 1000U)
            goto reconnect;
        if (!peer.configured) {
            pending = false;
            osMessageQueueReset(samples);
        }
        if (!pending && now - last_heartbeat >= 1000U) {
            pending_len = daq_encode_heartbeat(&peer, config.board_id,
                                               config.firmware_hash, now,
                                               packet, sizeof(packet));
            last_heartbeat = now;
            pending = true;
            pending_at = now;
        } else if (!pending && peer.configured) {
            daq_sample_t sample;
            if (osMessageQueueGet(samples, &sample, NULL, 0) == osOK &&
                now - sample.timestamp_ms < 1000U) {
                pending_len = daq_encode_sample(&sample, peer.channels, packet,
                                                sizeof(packet));
                pending = pending_len != 0;
                pending_at = now;
            }
        }
        if (pending) {
            int sent =
                w5500_udp_send(&chip,
                               daq_server_destination(&peer, config.server_ip,
                                                      config.discover_server),
                               config.server_port, packet, pending_len);
            if (sent < 0)
                goto reconnect;
            if (sent == 1) {
                pending = false;
                sent_at = now;
            }
        }
        osDelay(1);
        continue;
    reconnect:
        opened = false;
        pending = false;
        peer = (daq_peer_t){0};
        retry_at = now + 1000U;
        osMessageQueueReset(samples);
        osDelay(10);
    }
}

bool daq_task_start(void) {
    daq_board_config(&config);
    if (!config.enabled)
        return true;
    for (unsigned i = 0; i < DAQ_CHANNELS; ++i)
        if ((unsigned)config.sources[i] >= DAQ_SOURCE_COUNT)
            return false;
    bool mac_nonzero = false;
    for (unsigned i = 0; i < 6; ++i)
        mac_nonzero |= config.network.mac[i] != 0;
    if (!config.board_id || !config.network.port || !config.server_port ||
        !unicast(config.network.ip) || !unicast(config.server_ip) ||
        !mac_nonzero || (config.network.mac[0] & 1U) ||
        !board_spi_routed(BOARD_SPI_ETH) ||
        board_spi_mode(BOARD_SPI_ETH) != 0 ||
        board_spi_clock_hz(BOARD_SPI_ETH) > 80000000U)
        return false;
    samples = osMessageQueueNew(16, sizeof(daq_sample_t), NULL);
    if (!samples)
        return false;
    static const osThreadAttr_t attr = {
        .name = "daq_eth",
        .stack_size = 2048,
        .priority = osPriorityBelowNormal,
    };
    if (osThreadNew(network_task, NULL, &attr))
        return true;
    osMessageQueueDelete(samples);
    samples = NULL;
    return false;
}

bool daq_publish(const daq_sample_t* sample) {
    return samples && daq_sample_valid(sample) &&
           osMessageQueuePut(samples, sample, 0, 0) == osOK;
}

void daq_record(uint8_t type, const void* data, uint8_t length) {
    if (!samples)
        return;
    daq_sample_t sample;
    if (daq_map_record(config.sources, type, data, length, board_now_ms(),
                       &sample))
        (void)daq_publish(&sample);
}

#include "daq_link.h"

#include <stdio.h>
#include <string.h>
#include "board.h"
#include "daq_config.h"
#include "diablo_proto.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static const char *TAG = "daq";

// ---- shared state ----
static int s_sock = -1;
static struct sockaddr_in s_server;
static uint8_t s_fw_hash[DIABLO_FW_HASH_LEN];

static volatile daq_state_t s_state = DAQ_STATE_WAITING_FOR_SERVER;
static volatile uint8_t s_engine_state = 0;   // EngineState::SAFE until the server says otherwise

static SemaphoreHandle_t s_lock;               // guards everything below
static diablo_sensor_config_t s_cfg;           // last SENSOR_CONFIG
static uint8_t s_active_ids[DIABLO_MAX_SENSORS];   // config ids that exist on CapFill (1..4)
static uint8_t s_active_n;

static diablo_chunk_t s_chunks[DAQ_CHUNKS_PER_PACKET];
static uint8_t s_nchunks;
static bool s_fresh[FDC1004_NUM_CH];
static int32_t s_latest_counts[FDC1004_NUM_CH];

// Latest sample per channel, for the self test
static fdc1004_sample_t s_last[FDC1004_NUM_CH];
static int64_t s_last_us[FDC1004_NUM_CH];
static bool s_sensor_ok;

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

daq_state_t daq_link_state(void) { return s_state; }
uint8_t daq_link_engine_state(void) { return s_engine_state; }

static void set_state(daq_state_t st)
{
    if (s_state != st) {
        ESP_LOGW(TAG, "state %d -> %d", s_state, st);   // WARN so it shows even with printing off
        s_state = st;
    }
}

static void send_to(const struct sockaddr_in *dst, const uint8_t *buf, size_t len)
{
    if (s_sock < 0 || len == 0) return;
    if (sendto(s_sock, buf, len, 0, (const struct sockaddr *)dst, sizeof(*dst)) < 0) {
        ESP_LOGD(TAG, "sendto failed: errno %d", errno);
    }
}

static void controller_addr(struct sockaddr_in *out)
{
    memset(out, 0, sizeof(*out));
    out->sin_family = AF_INET;
    out->sin_port = htons(DAQ_SERVER_PORT);   // club core sends abort data to controller on 5006
    memcpy(&out->sin_addr.s_addr, s_cfg.controller_ip, 4);   // octets already in network order
}

static bool controller_set(void)
{
    return s_cfg.necessary_for_abort &&
           (s_cfg.controller_ip[0] | s_cfg.controller_ip[1] | s_cfg.controller_ip[2] | s_cfg.controller_ip[3]);
}

// ---------------------------------------------------------------------------------------
// Sensor data: one chunk per FDC1004 measurement cycle (~25 Hz at 100 S/s over 4 channels),
// DAQ_CHUNKS_PER_PACKET chunks per packet (~2.8 packets/s). Values are raw FDC1004 counts
// including the CAPDAC offset: pF = (int32)data / 524288.
// ---------------------------------------------------------------------------------------
void daq_link_on_samples(const fdc1004_sample_t s[FDC1004_NUM_CH], bool sensor_ok)
{
    if (!s_lock) return;
    uint8_t pkt[DIABLO_MAX_PACKET_SIZE];
    size_t pkt_len = 0;
    bool to_controller = false;
    struct sockaddr_in ctrl;

    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_sensor_ok = sensor_ok;
    int64_t now = esp_timer_get_time();
    for (int ch = 0; ch < FDC1004_NUM_CH; ch++) {
        if (!s[ch].fresh) continue;
        s_last[ch] = s[ch];
        s_last_us[ch] = now;
        s_latest_counts[ch] = s[ch].counts;
        s_fresh[ch] = true;
    }

    daq_state_t st = s_state;
    if ((st == DAQ_STATE_ACTIVE || st == DAQ_STATE_STANDALONE_ABORT) && s_active_n > 0) {
        bool all_fresh = true;
        for (int i = 0; i < s_active_n; i++) all_fresh &= s_fresh[s_active_ids[i] - 1];

        if (all_fresh) {
            diablo_chunk_t *c = &s_chunks[s_nchunks++];
            c->timestamp_ms = now_ms();
            for (int i = 0; i < s_active_n; i++) {
                uint8_t id = s_active_ids[i];
                c->points[i].sensor_id = id;
                c->points[i].data = (uint32_t)s_latest_counts[id - 1];
            }
            memset(s_fresh, 0, sizeof(s_fresh));

            if (s_nchunks >= DAQ_CHUNKS_PER_PACKET) {
                pkt_len = diablo_build_sensor_data(pkt, sizeof(pkt), now_ms(), s_chunks, s_nchunks, s_active_n);
                s_nchunks = 0;
                if (st == DAQ_STATE_STANDALONE_ABORT && controller_set()) {
                    to_controller = true;
                    controller_addr(&ctrl);
                }
            }
        }
    }
    xSemaphoreGive(s_lock);

    if (pkt_len) {
        send_to(&s_server, pkt, pkt_len);
        if (to_controller) send_to(&ctrl, pkt, pkt_len);
        ESP_LOGD(TAG, "sent sensor_data %u bytes", (unsigned)pkt_len);
    }
}

// ---------------------------------------------------------------------------------------
// Incoming packets
// ---------------------------------------------------------------------------------------
static void apply_sensor_config(const diablo_sensor_config_t *cfg)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_cfg = *cfg;
    s_active_n = 0;
    for (int i = 0; i < cfg->num_sensors; i++) {
        uint8_t id = cfg->sensor_ids[i];
        bool dup = false;
        for (int j = 0; j < s_active_n; j++) dup |= (s_active_ids[j] == id);
        if (id >= 1 && id <= CAPFILL_NUM_CHANNELS && !dup) {
            s_active_ids[s_active_n++] = id;
        } else {
            ESP_LOGW(TAG, "SENSOR_CONFIG: ignoring sensor id %u (CapFill has connectors 1-%d)",
                     id, CAPFILL_NUM_CHANNELS);
        }
    }
    s_nchunks = 0;                       // channel list may have changed; drop partial packet
    memset(s_fresh, 0, sizeof(s_fresh));
    xSemaphoreGive(s_lock);

    // enable_serial_printing: 0 = quiet (warnings/errors only), nonzero = normal logs
    esp_log_level_set("*", cfg->enable_serial_printing ? ESP_LOG_INFO : ESP_LOG_WARN);

    ESP_LOGW(TAG, "SENSOR_CONFIG: %u ids requested, %u used, ref_v=%u (ignored on CapFill), "
             "abort=%d ctrl=%u.%u.%u.%u serial=%u",
             cfg->num_sensors, s_active_n, cfg->reference_voltage, cfg->necessary_for_abort,
             cfg->controller_ip[0], cfg->controller_ip[1], cfg->controller_ip[2], cfg->controller_ip[3],
             cfg->enable_serial_printing);
}

static void handle_packet(const uint8_t *buf, size_t len)
{
    diablo_header_t hdr;
    if (!diablo_parse_header(buf, len, &hdr)) return;

    switch (hdr.type) {
    case PKT_SERVER_HEARTBEAT: {
        uint8_t es;
        if (diablo_parse_server_heartbeat(buf, len, &es)) s_engine_state = es;
        break;
    }
    case PKT_SENSOR_CONFIG: {
        diablo_sensor_config_t cfg;
        if (!diablo_parse_sensor_config(buf, len, &cfg)) {
            ESP_LOGE(TAG, "SENSOR_CONFIG parse failed (len %u)", (unsigned)len);
            break;
        }
        apply_sensor_config(&cfg);
        if (s_state == DAQ_STATE_WAITING_FOR_SERVER) set_state(DAQ_STATE_SELF_TEST);
        break;
    }
    case PKT_NO_CONNECTION_ABORT:
        if (s_state == DAQ_STATE_ACTIVE && s_cfg.necessary_for_abort) set_state(DAQ_STATE_STANDALONE_ABORT);
        break;
    case PKT_CLEAR_ABORT:
        if (s_state == DAQ_STATE_STANDALONE_ABORT) set_state(DAQ_STATE_ACTIVE);
        break;
    default:
        // ABORT and actuator packets don't apply to a sensor board.
        ESP_LOGD(TAG, "ignoring packet type %u", hdr.type);
        break;
    }
}

// ---------------------------------------------------------------------------------------
// Self test: adc_good = FDC1004 answering; per channel = recent, unsaturated reading
// (and >= SELFTEST_MIN_PF if that's set).
// ---------------------------------------------------------------------------------------
static void run_self_test(void)
{
    // Give the sensor a moment to produce fresh samples on every channel.
    vTaskDelay(pdMS_TO_TICKS(300));

    diablo_self_test_result_t res[DIABLO_MAX_SENSORS];
    uint8_t n = 0, adc_good;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    adc_good = s_sensor_ok ? 1 : 0;
    int64_t now = esp_timer_get_time();
    // Report on every id the server asked for, including ones CapFill doesn't have (they fail).
    for (int i = 0; i < s_cfg.num_sensors; i++) {
        uint8_t id = s_cfg.sensor_ids[i];
        uint8_t ok = 0;
        if (adc_good && id >= 1 && id <= CAPFILL_NUM_CHANNELS) {
            const fdc1004_sample_t *x = &s_last[id - 1];
            bool recent = s_last_us[id - 1] && (now - s_last_us[id - 1]) < 500000;
            ok = recent && !x->saturated && (SELFTEST_MIN_PF <= 0.0f || x->pf >= SELFTEST_MIN_PF);
            ESP_LOGW(TAG, "self test CIN%u: %.3f pF%s -> %s", id, x->pf, x->saturated ? " (saturated)" : "",
                     ok ? "PASS" : "FAIL");
        } else {
            ESP_LOGW(TAG, "self test id %u -> FAIL (%s)", id, adc_good ? "no such connector" : "sensor down");
        }
        res[n++] = (diablo_self_test_result_t){ .sensor_id = id, .result = ok };
    }
    xSemaphoreGive(s_lock);

    uint8_t pkt[DIABLO_MAX_PACKET_SIZE];
    size_t len = diablo_build_self_test(pkt, sizeof(pkt), now_ms(), adc_good, res, n);
    send_to(&s_server, pkt, len);
    ESP_LOGW(TAG, "self test sent: sensor %s, %u channels", adc_good ? "OK" : "FAIL", n);
}

static void send_heartbeat(void)
{
    uint8_t pkt[64];
    // Board state byte = our state number, which matches Diablo::BoardState.
    size_t len = diablo_build_board_heartbeat(pkt, sizeof(pkt), now_ms(), s_fw_hash, BOARD_ID,
                                              s_engine_state, (uint8_t)s_state);
    send_to(&s_server, pkt, len);
    if (s_state == DAQ_STATE_STANDALONE_ABORT && controller_set()) {
        struct sockaddr_in ctrl;
        controller_addr(&ctrl);
        send_to(&ctrl, pkt, len);
    }
}

static void link_task(void *arg)
{
    uint8_t buf[DIABLO_MAX_PACKET_SIZE];
    uint32_t last_hb = 0;
    for (;;) {
        struct sockaddr_in from;
        socklen_t fromlen = sizeof(from);
        int n = recvfrom(s_sock, buf, sizeof(buf), 0, (struct sockaddr *)&from, &fromlen);
        if (n > 0) {
            ESP_LOGI(TAG, "rx type %u len %d from %s", buf[0], n, inet_ntoa(from.sin_addr));
            handle_packet(buf, (size_t)n);
        }

        if (s_state == DAQ_STATE_SELF_TEST) {
            send_heartbeat();   // let the server see SELF_TEST state
            run_self_test();
            set_state(DAQ_STATE_ACTIVE);
        }

        uint32_t t = now_ms();
        if (t - last_hb >= DAQ_HEARTBEAT_INTERVAL_MS) {
            last_hb = t;
            send_heartbeat();
        }
    }
}

esp_err_t daq_link_start(void)
{
    s_lock = xSemaphoreCreateMutex();

    const esp_partition_t *running = esp_ota_get_running_partition();
    if (!running || esp_partition_get_sha256(running, s_fw_hash) != ESP_OK) {
        ESP_LOGE(TAG, "could not hash running firmware; heartbeat will send zeros");
    } else {
        char hex[65];
        for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", s_fw_hash[i]);
        ESP_LOGI(TAG, "firmware hash %s", hex);
    }

    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) {
        ESP_LOGE(TAG, "socket() failed: errno %d", errno);
        return ESP_FAIL;
    }
    struct sockaddr_in local = {
        .sin_family = AF_INET,
        .sin_port = htons(DAQ_BOARD_LISTEN_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(s_sock, (struct sockaddr *)&local, sizeof(local)) < 0) {
        ESP_LOGE(TAG, "bind(%d) failed: errno %d", DAQ_BOARD_LISTEN_PORT, errno);
        close(s_sock);
        s_sock = -1;
        return ESP_FAIL;
    }
    // Short receive timeout so the same task can send heartbeats on time.
    struct timeval tv = { .tv_sec = 0, .tv_usec = 50 * 1000 };
    setsockopt(s_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    memset(&s_server, 0, sizeof(s_server));
    s_server.sin_family = AF_INET;
    s_server.sin_port = htons(DAQ_SERVER_PORT);
    uint8_t srv[4] = { DAQ_NET_OCTET_1, DAQ_NET_OCTET_2, DAQ_NET_OCTET_3, DAQ_SERVER_IP_OCTET_4 };
    memcpy(&s_server.sin_addr.s_addr, srv, 4);

    xTaskCreate(link_task, "daq_link", 6144, NULL, 6, NULL);
    ESP_LOGI(TAG, "listening on UDP %d, server %u.%u.%u.%u:%d, waiting for SENSOR_CONFIG",
             DAQ_BOARD_LISTEN_PORT, srv[0], srv[1], srv[2], srv[3], DAQ_SERVER_PORT);
    return ESP_OK;
}

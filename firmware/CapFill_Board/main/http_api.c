#include "http_api.h"

#include <stdio.h>
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "readings.h"
#include "daq_config.h"
#include "daq_link.h"

static const char *TAG = "http";

static const char INDEX_HTML[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'><title>CapFill</title>"
    "<style>body{font:16px system-ui;margin:24px}td,th{padding:6px 14px;text-align:right}"
    "th:first-child,td:first-child{text-align:left}.bad{color:#b00}</style></head><body>"
    "<h2>CapFill</h2><table><thead><tr><th>Channel</th><th>pF</th><th>avg pF</th>"
    "<th>CAPDAC</th><th>status</th></tr></thead><tbody id=t></tbody></table>"
    "<p id=s></p><p id=d></p><script>"
    "async function f(){try{const r=await fetch('/readings');const j=await r.json();"
    "document.getElementById('t').innerHTML=j.channels.map(c=>`<tr><td>CIN${c.ch}</td>"
    "<td>${c.valid?c.pf.toFixed(3):'-'}</td><td>${c.valid?c.pf_avg.toFixed(3):'-'}</td>"
    "<td>${c.capdac}</td><td class=${c.saturated||!c.valid?'bad':''}>"
    "${!c.valid?'no data':c.saturated?'saturated':'ok'}</td></tr>`).join('');"
    "document.getElementById('s').textContent=j.sensor_ok?'':'Sensor not responding';"
    "document.getElementById('d').textContent=`Board ${j.board_id} | DAQ state ${j.daq_state} | engine state ${j.engine_state}`;"
    "}catch(e){}}setInterval(f,500);f();</script></body></html>";

static esp_err_t index_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t readings_get_handler(httpd_req_t *req)
{
    readings_t r;
    readings_get(&r);
    int64_t now = esp_timer_get_time();

    char buf[1024];
    int n = snprintf(buf, sizeof(buf),
                     "{\"board_id\":%d,\"daq_state\":%d,\"engine_state\":%u,\"uptime_ms\":%lld,"
                     "\"sensor_ok\":%s,\"channels\":[",
                     BOARD_ID, (int)daq_link_state(), daq_link_engine_state(),
                     (long long)(now / 1000), r.sensor_ok ? "true" : "false");
    for (int i = 0; i < CAPFILL_NUM_CHANNELS && n < (int)sizeof(buf); i++) {
        const channel_reading_t *c = &r.ch[i];
        long long age_ms = c->valid ? (long long)((now - c->updated_us) / 1000) : -1;
        n += snprintf(buf + n, sizeof(buf) - n,
                      "%s{\"ch\":%d,\"pf\":%.4f,\"pf_avg\":%.4f,\"capdac\":%u,"
                      "\"saturated\":%s,\"valid\":%s,\"samples\":%lu,\"age_ms\":%lld}",
                      i ? "," : "", i + 1, c->pf, c->pf_avg, c->capdac,
                      c->saturated ? "true" : "false", c->valid ? "true" : "false",
                      (unsigned long)c->samples, age_ms);
    }
    if (n < (int)sizeof(buf)) n += snprintf(buf + n, sizeof(buf) - n, "]}");
    if (n >= (int)sizeof(buf)) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "buffer");
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, buf, n);
}

esp_err_t http_api_start(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    httpd_handle_t server = NULL;
    esp_err_t err = httpd_start(&server, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }
    const httpd_uri_t routes[] = {
        { .uri = "/",         .method = HTTP_GET, .handler = index_get },
        { .uri = "/readings", .method = HTTP_GET, .handler = readings_get_handler },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "HTTP server on port %d", cfg.server_port);
    return ESP_OK;
}

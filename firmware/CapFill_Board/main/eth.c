#include "eth.h"

#include <stdio.h>
#include "board.h"
#include "daq_config.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"

static const char *TAG = "eth";

static volatile bool s_link_up;
static volatile bool s_has_ip;
static char s_ip[16] = "0.0.0.0";

static void on_eth_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    switch (id) {
    case ETHERNET_EVENT_CONNECTED:
        s_link_up = true;
        ESP_LOGI(TAG, "link up");
        break;
    case ETHERNET_EVENT_DISCONNECTED:
        s_link_up = false;
        s_has_ip = false;
        ESP_LOGW(TAG, "link down");
        break;
    default:
        break;
    }
}

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&ev->ip_info.ip));
    s_has_ip = true;
    ESP_LOGI(TAG, "IP %s up  (bench page: http://%s/)", s_ip, s_ip);
}

esp_err_t eth_start(void)
{
    // W5500 driver uses a GPIO interrupt on INT (IO37).
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    spi_bus_config_t buscfg = {
        .mosi_io_num = PIN_ETH_MOSI,
        .miso_io_num = PIN_ETH_MISO,
        .sclk_io_num = PIN_ETH_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(ETH_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t devcfg = {
        .mode = 0,
        .clock_speed_hz = ETH_SPI_CLOCK_MHZ * 1000 * 1000,
        .spics_io_num = PIN_ETH_CS,
        .queue_size = 20,
    };

    eth_w5500_config_t w5500_cfg = ETH_W5500_DEFAULT_CONFIG(ETH_SPI_HOST, &devcfg);
    w5500_cfg.int_gpio_num = PIN_ETH_INT;

    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.reset_gpio_num = PIN_ETH_RST;

    esp_eth_mac_t *mac = esp_eth_mac_new_w5500(&w5500_cfg, &mac_cfg);
    esp_eth_phy_t *phy = esp_eth_phy_new_w5500(&phy_cfg);
    if (!mac || !phy) {
        ESP_LOGE(TAG, "failed to create W5500 MAC/PHY");
        return ESP_FAIL;
    }

    esp_eth_config_t eth_cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    err = esp_eth_driver_install(&eth_cfg, &eth);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "W5500 not responding on SPI (%s) - check breakout power and wiring",
                 esp_err_to_name(err));
        return err;
    }

    // The W5500 has no factory MAC; use the ESP32-S3's Ethernet MAC from eFuse.
    uint8_t mac_addr[6];
    ESP_ERROR_CHECK(esp_read_mac(mac_addr, ESP_MAC_ETH));
    ESP_ERROR_CHECK(esp_eth_ioctl(eth, ETH_CMD_S_MAC_ADDR, mac_addr));

    esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&netif_cfg);
    esp_netif_set_hostname(netif, "capfill");

    // Static IP 192.168.2.<BOARD_ID>/24, no gateway - same scheme as the club's hotfire boards.
    // BOARD_ID is set in daq_config.h (TODO(BOARD_ID): it's a placeholder until assigned).
    ESP_ERROR_CHECK(esp_netif_attach(netif, esp_eth_new_netif_glue(eth)));
    esp_err_t e = esp_netif_dhcpc_stop(netif);
    if (e != ESP_OK && e != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) {
        ESP_LOGE(TAG, "dhcpc_stop: %s", esp_err_to_name(e));
    }
    esp_netif_ip_info_t ip = { 0 };
    esp_netif_set_ip4_addr(&ip.ip, DAQ_NET_OCTET_1, DAQ_NET_OCTET_2, DAQ_NET_OCTET_3, BOARD_ID);
    ip.netmask.addr = esp_ip4addr_aton(DAQ_NETMASK);
    ip.gw.addr = 0;
    ESP_ERROR_CHECK(esp_netif_set_ip_info(netif, &ip));

    ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_eth_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_got_ip, NULL));

    ESP_ERROR_CHECK(esp_eth_start(eth));
    ESP_LOGI(TAG, "W5500 started, MAC " MACSTR, MAC2STR(mac_addr));
    return ESP_OK;
}

bool eth_link_up(void) { return s_link_up; }
bool eth_has_ip(void) { return s_has_ip; }
const char *eth_ip_str(void) { return s_ip; }

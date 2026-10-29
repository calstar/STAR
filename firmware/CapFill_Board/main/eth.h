#pragma once

#include <stdbool.h>
#include "esp_err.h"

// Brings up the W5500 with static IP 192.168.2.<BOARD_ID>. Needs esp_netif_init() and the default event loop first.
esp_err_t eth_start(void);

bool eth_link_up(void);
bool eth_has_ip(void);
const char *eth_ip_str(void);   // "0.0.0.0" until the link is up

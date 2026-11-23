#pragma once

#include "esp_err.h"

// GET /          -> small live page
// GET /readings  -> JSON snapshot of all channels
esp_err_t http_api_start(void);

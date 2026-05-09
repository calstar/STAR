#pragma once

// Environmental data transmit rate
#define ENV_SEND_RATE_HZ          5
#define ENV_SEND_INTERVAL_MS      (1000 / ENV_SEND_RATE_HZ)   // 200 ms

// Board heartbeat rate (matches hotfire standard)
#define ENV_HEARTBEAT_INTERVAL_MS 1000

// BME280 I2C address: 0x76 (SDO low) or 0x77 (SDO high)
#define BME280_I2C_ADDR           0x76

// Board identity — sets static IP to 192.168.2.ENV_BOARD_ID
#define ENV_BOARD_ID              25

// Network
#define ENV_SERVER_IP_OCTET_4     20       // server = 192.168.2.20
#define ENV_SERVER_PORT           5006
#define ENV_LOCAL_PORT            5005
#define ENV_OTA_PORT              3232

// Ethernet init delays — match hotfire board values
#define ENV_ETH_SPI_DELAY_MS      1000
#define ENV_ETH_INIT_DELAY_MS     1000
#define ENV_ETH_BEGIN_DELAY_MS    1000

/* USER CODE BEGIN Header */
/**
 ******************************************************************************
 * @file           : usbd_cdc_if.c
 * @version        : v1.0_Cube
 * @brief          : Usb device for Virtual Com Port.
 ******************************************************************************
 * @attention
 *
 * Copyright (c) 2026 STMicroelectronics.
 * All rights reserved.
 *
 * This software is licensed under terms that can be found in the LICENSE file
 * in the root directory of this software component.
 * If no LICENSE file comes with this software, it is provided AS-IS.
 *
 ******************************************************************************
 */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "usbd_cdc_if.h"

/* USER CODE BEGIN INCLUDE */
#include <stdbool.h>
#include <string.h>

#include "mode.h"
#include "stm32h7xx.h"
/* USER CODE END INCLUDE */

/* Private typedef -----------------------------------------------------------*/
/* Private define ------------------------------------------------------------*/
/* Private macro -------------------------------------------------------------*/

/* USER CODE BEGIN PV */
/* Global status flag to check if a PC serial terminal is actively open */
volatile bool g_usb_terminal_connected = false;
static uint8_t line_coding[7] = {0x00, 0xC2, 0x01, 0x00,
                                 0,    0,    8}; /* 115200 8N1 */
/* USER CODE END PV */

/** @addtogroup STM32_USB_OTG_DEVICE_LIBRARY
 * @brief Usb device library.
 * @{
 */

/** @addtogroup USBD_CDC_IF
 * @{
 */

/** @defgroup USBD_CDC_IF_Private_TypesDefinitions
 * USBD_CDC_IF_Private_TypesDefinitions
 * @brief Private types.
 * @{
 */

/* USER CODE BEGIN PRIVATE_TYPES */

/* USER CODE END PRIVATE_TYPES */

/**
 * @}
 */

/** @defgroup USBD_CDC_IF_Private_Defines USBD_CDC_IF_Private_Defines
 * @brief Private defines.
 * @{
 */

/* USER CODE BEGIN PRIVATE_DEFINES */
/* ST's H723 example; confirm in AN2606 */
#define BOOTLOADER_ADDR 0x1FF09800UL
#define BOOTLOADER_MAGIC 0xB007100DUL /* RTC->BKP0R, survives the reset */
/* USER CODE END PRIVATE_DEFINES */

/**
 * @}
 */

/** @defgroup USBD_CDC_IF_Private_Macros USBD_CDC_IF_Private_Macros
 * @brief Private macros.
 * @{
 */

/* USER CODE BEGIN PRIVATE_MACRO */

/* USER CODE END PRIVATE_MACRO */

/**
 * @}
 */

/** @defgroup USBD_CDC_IF_Private_Variables USBD_CDC_IF_Private_Variables
 * @brief Private variables.
 * @{
 */

/* Create buffer for reception and transmission           */
/* It's up to user to redefine and/or remove those define */
/** Received data over USB are stored in this buffer      */
uint8_t UserRxBufferHS[APP_RX_DATA_SIZE];

/** Data to send over USB CDC are stored in this buffer   */
uint8_t UserTxBufferHS[APP_TX_DATA_SIZE];

/* USER CODE BEGIN PRIVATE_VARIABLES */

/* USER CODE END PRIVATE_VARIABLES */

/**
 * @}
 */

/** @defgroup USBD_CDC_IF_Exported_Variables USBD_CDC_IF_Exported_Variables
 * @brief Public variables.
 * @{
 */

extern USBD_HandleTypeDef hUsbDeviceHS;

/* USER CODE BEGIN EXPORTED_VARIABLES */

/* USER CODE END EXPORTED_VARIABLES */

/**
 * @}
 */

/** @defgroup USBD_CDC_IF_Private_FunctionPrototypes
 * USBD_CDC_IF_Private_FunctionPrototypes
 * @brief Private functions declaration.
 * @{
 */

static int8_t CDC_Init_HS(void);
static int8_t CDC_DeInit_HS(void);
static int8_t CDC_Control_HS(uint8_t cmd, uint8_t *pbuf, uint16_t length);
static int8_t CDC_Receive_HS(uint8_t *pbuf, uint32_t *Len);
static int8_t CDC_TransmitCplt_HS(uint8_t *pbuf, uint32_t *Len, uint8_t epnum);

/* USER CODE BEGIN PRIVATE_FUNCTIONS_DECLARATION */
static bool is_bootloader_cmd(const uint8_t *b, uint32_t n);
/* USER CODE END PRIVATE_FUNCTIONS_DECLARATION */

/**
 * @}
 */

USBD_CDC_ItfTypeDef USBD_Interface_fops_HS = {CDC_Init_HS, CDC_DeInit_HS,
                                              CDC_Control_HS, CDC_Receive_HS,
                                              CDC_TransmitCplt_HS};

/* Private functions ---------------------------------------------------------*/

/**
 * @brief  Initializes the CDC media low layer over the USB HS IP
 * @retval USBD_OK if all operations are OK else USBD_FAIL
 */
static int8_t CDC_Init_HS(void) {
    /* USER CODE BEGIN 8 */
    /* Set Application Buffers */
    USBD_CDC_SetTxBuffer(&hUsbDeviceHS, UserTxBufferHS, 0);
    USBD_CDC_SetRxBuffer(&hUsbDeviceHS, UserRxBufferHS);
    return (USBD_OK);
    /* USER CODE END 8 */
}

/**
 * @brief  DeInitializes the CDC media low layer
 * @param  None
 * @retval USBD_OK if all operations are OK else USBD_FAIL
 */
static int8_t CDC_DeInit_HS(void) {
    /* USER CODE BEGIN 9 */
    g_usb_terminal_connected = false;
    return (USBD_OK);
    /* USER CODE END 9 */
}

/**
 * @brief  Manage the CDC class requests
 * @param  cmd: Command code
 * @param  pbuf: Buffer containing command data (request parameters)
 * @param  length: Number of data to be sent (in bytes)
 * @retval Result of the operation: USBD_OK if all operations are OK else
 * USBD_FAIL
 */
static int8_t CDC_Control_HS(uint8_t cmd, uint8_t *pbuf, uint16_t length) {
    /* USER CODE BEGIN 10 */
    switch (cmd) {
        case CDC_SEND_ENCAPSULATED_COMMAND:

            break;

        case CDC_GET_ENCAPSULATED_RESPONSE:

            break;

        case CDC_SET_COMM_FEATURE:

            break;

        case CDC_GET_COMM_FEATURE:

            break;

        case CDC_CLEAR_COMM_FEATURE:

            break;

        case CDC_SET_LINE_CODING:
            memcpy(line_coding, pbuf, sizeof line_coding);
            break;

        case CDC_GET_LINE_CODING:
            memcpy(pbuf, line_coding, sizeof line_coding);
            break;

        case CDC_SET_CONTROL_LINE_STATE: {
            /* Level 3: Check DTR bit (Bit 0) to verify if host serial terminal
             * is open */
            USBD_SetupReqTypedef *req = (USBD_SetupReqTypedef *)pbuf;
            g_usb_terminal_connected = (req->wValue & 0x0001) ? true : false;
        } break;

        case CDC_SEND_BREAK:

            break;

        default:
            break;
    }

    return (USBD_OK);
    /* USER CODE END 10 */
}

/**
 * @brief Data received over USB OUT endpoint are sent over CDC interface
 *         through this function.
 *
 *         @note
 *         This function will issue a NAK packet on any OUT packet received on
 *         USB endpoint until exiting this function. If you exit this function
 *         before transfer is complete on CDC interface (ie. using DMA
 * controller) it will result in receiving more data while previous ones are
 * still not sent.
 *
 * @param  Buf: Buffer of data to be received
 * @param  Len: Number of data received (in bytes)
 * @retval Result of the operation: USBD_OK if all operations are OK else
 * USBD_FAILL
 */
static int8_t CDC_Receive_HS(uint8_t *Buf, uint32_t *Len) {
    /* USER CODE BEGIN 11 */
    USBD_CDC_SetRxBuffer(&hUsbDeviceHS, &Buf[0]);
    USBD_CDC_ReceivePacket(&hUsbDeviceHS);

    /* Only in IDLE. Reset, and main() jumps before anything else starts. */
    if (app_state() == FLIGHT_IDLE && is_bootloader_cmd(Buf, *Len)) {
        HAL_PWR_EnableBkUpAccess();
        RTC->BKP0R = BOOTLOADER_MAGIC;
        NVIC_SystemReset();
    }

    return (USBD_OK);
    /* USER CODE END 11 */
}

/**
 * @brief  Data to send over USB IN endpoint are sent over CDC interface
 *         through this function.
 * @param  Buf: Buffer of data to be sent
 * @param  Len: Number of data to be sent (in bytes)
 * @retval Result of the operation: USBD_OK if all operations are OK else
 * USBD_FAIL or USBD_BUSY
 */
uint8_t CDC_Transmit_HS(uint8_t *Buf, uint16_t Len) {
    uint8_t result = USBD_OK;
    /* USER CODE BEGIN 12 */
    USBD_CDC_HandleTypeDef *hcdc =
        (USBD_CDC_HandleTypeDef *)hUsbDeviceHS.pClassData;
    if (!usb_terminal_open() || hcdc == NULL) {
        return USBD_FAIL;
    }
    if (hcdc->TxState != 0) {
        return USBD_BUSY;
    }
    USBD_CDC_SetTxBuffer(&hUsbDeviceHS, Buf, Len);
    result = USBD_CDC_TransmitPacket(&hUsbDeviceHS);
    /* USER CODE END 12 */
    return result;
}

/**
 * @brief  CDC_TransmitCplt_HS
 *         Data transmitted callback
 *
 *         @note
 *         This function is IN transfer complete callback used to inform user
 * that the submitted Data is successfully sent over USB.
 *
 * @param  Buf: Buffer of data to be received
 * @param  Len: Number of data received (in bytes)
 * @retval Result of the operation: USBD_OK if all operations are OK else
 * USBD_FAIL
 */
static int8_t CDC_TransmitCplt_HS(uint8_t *Buf, uint32_t *Len, uint8_t epnum) {
    uint8_t result = USBD_OK;
    /* USER CODE BEGIN 14 */
    UNUSED(Buf);
    UNUSED(Len);
    UNUSED(epnum);
    /* USER CODE END 14 */
    return result;
}

/* USER CODE BEGIN PRIVATE_FUNCTIONS_IMPLEMENTATION */
bool usb_configured(void) {
    return hUsbDeviceHS.dev_state ==
           USBD_STATE_CONFIGURED; /* unplug reads as suspended */
}

bool usb_terminal_open(void) {
    return g_usb_terminal_connected && usb_configured();
}

/* "BOOTLOADER" exactly, with an optional line ending. */
static bool is_bootloader_cmd(const uint8_t *b, uint32_t n) {
    while (n > 0 && (b[n - 1] == '\r' || b[n - 1] == '\n'))
        n--;
    return n == 10 && memcmp(b, "BOOTLOADER", 10) == 0;
}

/* First thing in main(): straight from reset, so nothing needs undoing. */
void usb_bootloader_check(void) {
    __HAL_RCC_RTC_CLK_ENABLE();
    if (RTC->BKP0R != BOOTLOADER_MAGIC)
        return;
    HAL_PWR_EnableBkUpAccess();
    RTC->BKP0R = 0;
    __set_MSP(*(volatile uint32_t *)BOOTLOADER_ADDR);
    ((void (*)(void))(*(volatile uint32_t *)(BOOTLOADER_ADDR + 4)))();
}
/* USER CODE END PRIVATE_FUNCTIONS_IMPLEMENTATION */

/**
 * @}
 */

/**
 * @}
 */

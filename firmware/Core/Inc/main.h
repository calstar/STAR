/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.h
  * @brief          : Header for main.c file.
  *                   This file contains the common defines of the application.
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

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32h7xx_hal.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */

/* USER CODE END Includes */

/* Exported types ------------------------------------------------------------*/
/* USER CODE BEGIN ET */

/* USER CODE END ET */

/* Exported constants --------------------------------------------------------*/
/* USER CODE BEGIN EC */

/* USER CODE END EC */

/* Exported macro ------------------------------------------------------------*/
/* USER CODE BEGIN EM */

/* USER CODE END EM */

void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);

/* Exported functions prototypes ---------------------------------------------*/
void Error_Handler(void);
void MX_USB_OTG_HS_HCD_Init(void);

/* USER CODE BEGIN EFP */

/* USER CODE END EFP */

/* Private defines -----------------------------------------------------------*/
#define NAND_SPI4_CLK_Pin GPIO_PIN_2
#define NAND_SPI4_CLK_GPIO_Port GPIOE
#define NAND_CS_Pin GPIO_PIN_4
#define NAND_CS_GPIO_Port GPIOE
#define NAND_SPI4_MISO_Pin GPIO_PIN_5
#define NAND_SPI4_MISO_GPIO_Port GPIOE
#define NAND_SPI4_MOSI_Pin GPIO_PIN_6
#define NAND_SPI4_MOSI_GPIO_Port GPIOE
#define EMMC_RST_Pin GPIO_PIN_13
#define EMMC_RST_GPIO_Port GPIOC
#define ALT_CURR_SENSE_ADC_Pin GPIO_PIN_0
#define ALT_CURR_SENSE_ADC_GPIO_Port GPIOC
#define CURR_SENSE_ADC_Pin GPIO_PIN_1
#define CURR_SENSE_ADC_GPIO_Port GPIOC
#define ETH_SPI2_MISO_Pin GPIO_PIN_2
#define ETH_SPI2_MISO_GPIO_Port GPIOC
#define ETH_SPI2_MOSI_Pin GPIO_PIN_3
#define ETH_SPI2_MOSI_GPIO_Port GPIOC
#define VBAT_ADC_Pin GPIO_PIN_0
#define VBAT_ADC_GPIO_Port GPIOA
#define EXT_SENSE_ADC_Pin GPIO_PIN_1
#define EXT_SENSE_ADC_GPIO_Port GPIOA
#define PYRO_1_CONT_ADC_Pin GPIO_PIN_2
#define PYRO_1_CONT_ADC_GPIO_Port GPIOA
#define PYRO_2_CONT_ADC_Pin GPIO_PIN_3
#define PYRO_2_CONT_ADC_GPIO_Port GPIOA
#define SPI1_CLK_Pin GPIO_PIN_5
#define SPI1_CLK_GPIO_Port GPIOA
#define SPI_MISO_Pin GPIO_PIN_6
#define SPI_MISO_GPIO_Port GPIOA
#define SPI1_MOSI_Pin GPIO_PIN_7
#define SPI1_MOSI_GPIO_Port GPIOA
#define ACCEL_CS_Pin GPIO_PIN_4
#define ACCEL_CS_GPIO_Port GPIOC
#define CS_BARO_Pin GPIO_PIN_5
#define CS_BARO_GPIO_Port GPIOC
#define IMU_CS_Pin GPIO_PIN_0
#define IMU_CS_GPIO_Port GPIOB
#define IMU_INT1_Pin GPIO_PIN_1
#define IMU_INT1_GPIO_Port GPIOB
#define IMU_INT2_Pin GPIO_PIN_2
#define IMU_INT2_GPIO_Port GPIOB
#define ACCEL_INT1_Pin GPIO_PIN_7
#define ACCEL_INT1_GPIO_Port GPIOE
#define ACCEL_INT2_Pin GPIO_PIN_9
#define ACCEL_INT2_GPIO_Port GPIOE
#define SW_ST_Pin GPIO_PIN_10
#define SW_ST_GPIO_Port GPIOE
#define REG_3V6_EN_Pin GPIO_PIN_11
#define REG_3V6_EN_GPIO_Port GPIOE
#define ETH_RST_Pin GPIO_PIN_13
#define ETH_RST_GPIO_Port GPIOE
#define ETH_CS_Pin GPIO_PIN_14
#define ETH_CS_GPIO_Port GPIOE
#define ETH_INT_Pin GPIO_PIN_15
#define ETH_INT_GPIO_Port GPIOE
#define ETH_SPI2_CLK_Pin GPIO_PIN_10
#define ETH_SPI2_CLK_GPIO_Port GPIOB
#define TIMEPULSE_Pin GPIO_PIN_11
#define TIMEPULSE_GPIO_Port GPIOB
#define ALT_ARM_RESET_Pin GPIO_PIN_12
#define ALT_ARM_RESET_GPIO_Port GPIOB
#define GPS_RST_Pin GPIO_PIN_13
#define GPS_RST_GPIO_Port GPIOB
#define USART1_TX_Pin GPIO_PIN_14
#define USART1_TX_GPIO_Port GPIOB
#define USART2_RX_Pin GPIO_PIN_15
#define USART2_RX_GPIO_Port GPIOB
#define GPS_ANT_STATUS_Pin GPIO_PIN_8
#define GPS_ANT_STATUS_GPIO_Port GPIOD
#define PYRO_EN_2_Pin GPIO_PIN_9
#define PYRO_EN_2_GPIO_Port GPIOD
#define PYRO_EN_1_Pin GPIO_PIN_10
#define PYRO_EN_1_GPIO_Port GPIOD
#define ALT_ARM_SET_Pin GPIO_PIN_11
#define ALT_ARM_SET_GPIO_Port GPIOD
#define PYRO_2_CTRL_Pin GPIO_PIN_12
#define PYRO_2_CTRL_GPIO_Port GPIOD
#define PYRO_1_CTRL_Pin GPIO_PIN_13
#define PYRO_1_CTRL_GPIO_Port GPIOD
#define PYRO_2_PG_Pin GPIO_PIN_14
#define PYRO_2_PG_GPIO_Port GPIOD
#define PYRO_1_PG_Pin GPIO_PIN_15
#define PYRO_1_PG_GPIO_Port GPIOD
#define PWM1_Pin GPIO_PIN_6
#define PWM1_GPIO_Port GPIOC
#define PWM2_Pin GPIO_PIN_7
#define PWM2_GPIO_Port GPIOC
#define EMMC_D0_Pin GPIO_PIN_8
#define EMMC_D0_GPIO_Port GPIOC
#define EMMC_D1_Pin GPIO_PIN_9
#define EMMC_D1_GPIO_Port GPIOC
#define USB_OTG_HS_ID_Pin GPIO_PIN_10
#define USB_OTG_HS_ID_GPIO_Port GPIOA
#define USB_D_N_Pin GPIO_PIN_11
#define USB_D_N_GPIO_Port GPIOA
#define USB_D_P_Pin GPIO_PIN_12
#define USB_D_P_GPIO_Port GPIOA
#define SWDIO_DEBUG_Pin GPIO_PIN_13
#define SWDIO_DEBUG_GPIO_Port GPIOA
#define SWCLK_DEBUG_Pin GPIO_PIN_14
#define SWCLK_DEBUG_GPIO_Port GPIOA
#define JTDI_DEBUG_Pin GPIO_PIN_15
#define JTDI_DEBUG_GPIO_Port GPIOA
#define EMMC_D2_Pin GPIO_PIN_10
#define EMMC_D2_GPIO_Port GPIOC
#define EMMC_D3_Pin GPIO_PIN_11
#define EMMC_D3_GPIO_Port GPIOC
#define EMMC_CLK_Pin GPIO_PIN_12
#define EMMC_CLK_GPIO_Port GPIOC
#define EMMC_CMD_Pin GPIO_PIN_2
#define EMMC_CMD_GPIO_Port GPIOD
#define RADIO_RF_SW_Pin GPIO_PIN_4
#define RADIO_RF_SW_GPIO_Port GPIOD
#define RADIO_BUSY_Pin GPIO_PIN_5
#define RADIO_BUSY_GPIO_Port GPIOD
#define RADIO_SPI3_MOSI_Pin GPIO_PIN_6
#define RADIO_SPI3_MOSI_GPIO_Port GPIOD
#define RADIO_CS_Pin GPIO_PIN_7
#define RADIO_CS_GPIO_Port GPIOD
#define RADIO_SPI3_CLK_Pin GPIO_PIN_3
#define RADIO_SPI3_CLK_GPIO_Port GPIOB
#define RADIO_SPI3_MISO_Pin GPIO_PIN_4
#define RADIO_SPI3_MISO_GPIO_Port GPIOB
#define RADIO_DIO1_Pin GPIO_PIN_5
#define RADIO_DIO1_GPIO_Port GPIOB
#define RADIO_NRST_Pin GPIO_PIN_6
#define RADIO_NRST_GPIO_Port GPIOB
#define LED1_Pin GPIO_PIN_9
#define LED1_GPIO_Port GPIOB
#define LED2_Pin GPIO_PIN_0
#define LED2_GPIO_Port GPIOE

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */

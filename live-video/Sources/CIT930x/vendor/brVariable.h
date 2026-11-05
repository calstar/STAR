#ifndef __BR_VARIABLE_H__
#define __BR_VARIABLE_H__

// ----- LL variables -----



#define OVA_BASE						0x4C00							// omega variable address base

//#define OVA_PRECHIP_VERSION_7_0
#define OVA_LINK_VERSION				(OVA_BASE-4)			//0x4BFC	4 byte
#define OVA_LINK_VERSION_31_24			(OVA_LINK_VERSION+0)	
#define OVA_LINK_VERSION_23_16			(OVA_LINK_VERSION+1)
#define OVA_LINK_VERSION_15_8			(OVA_LINK_VERSION+2)
#define OVA_LINK_VERSION_7_0			(OVA_LINK_VERSION+3)
#define OVA_SECOND_DEMOD_I2C_ADDR		(OVA_BASE-5)			//0x4BFB

#define OVA_IR_TABLE                    (OVA_BASE-361)      	//0x4A97 	7 * 50 + 6 bytes
#define OVA_HID_TABLE					(OVA_IR_TABLE)                     // 7 * 50 bytes
#define OVA_IR_TOGGLE_MASK				(OVA_HID_TABLE+7*50)             // 2 bytes
#define OVA_IR_nKEYS					(OVA_IR_TOGGLE_MASK+2)           // 1 byte
#define OVA_IR_FN_EXPIRE_TIME			(OVA_IR_nKEYS+1)                 // 1 byte
#define OVA_IR_REPEAT_PERIOD			(OVA_IR_FN_EXPIRE_TIME+1)        // 1 byte
#define OVA_IR_RESERVED_PARAM			(OVA_IR_REPEAT_PERIOD+1)         // 1 byte

#define OVA_IR_TABLE_ADDR				(OVA_BASE-363)			//0x4A95 	2 bytes pointer point to IR_TABLE
#define OVA_IR_TABLE_ADDR_15_18			(OVA_IR_TABLE_ADDR+0)
#define OVA_IR_TABLE_ADDR_7_0			(OVA_IR_TABLE_ADDR+1)
#define OVA_HOST_REQ_IR_MODE			(OVA_BASE-364)			//0x4A94	
#define OVA_EEPROM_CFG					(OVA_BASE-620)			//0x4994	256bytes
#define OVA_XC4000_PKTCNT				(OVA_BASE-621)			//0x4993
#define OVA_XC4000_CLKCNT1				(OVA_BASE-623)			//0x4991	2 bytes
#define OVA_XC4000_CLKCNT2				(OVA_BASE-625)			//0x498F	2 bytes
#define OVA_I2C_NO_STOPBIT_PKTCNT		(OVA_BASE-626)			//0x498E
#define OVA_CLK_STRETCH					(OVA_BASE-643)			//0x497D	11 byte
#define OVA_DUMMY0XX					(OVA_BASE-644)			//0x497C
#define OVA_HW_VERSION					(OVA_BASE-645)			//0x497B
#define OVA_TMP_HW_VERSION				(OVA_BASE-646)			//0x497A
#define OVA_EEPROM_CFG_VALID			(OVA_BASE-647) 			//0x4979
#define OVA_THIRD_DEMOD_I2C_ADDR		(OVA_BASE-648)			//0x4978
#define OVA_FOURTH_DEMOD_I2C_ADDR		(OVA_BASE-649)			//0x4977
#define OVA_SECOND_DEMOD_I2C_BUS		(OVA_BASE-650)			//0x4976
#define OVA_NEXT_LEVEL_FIRST_I2C_ADDR	(OVA_BASE-651)			//0x4975
#define OVA_NEXT_LEVEL_SECOND_I2C_ADDR	(OVA_BASE-652)			//0x4974
#define OVA_NEXT_LEVEL_THIRD_I2C_ADDR	(OVA_BASE-653)			//0x4973
#define OVA_NEXT_LEVEL_FOURTH_I2C_ADDR	(OVA_BASE-654)			//0x4972
#define OVA_NEXT_LEVEL_FIRST_I2C_BUS	(OVA_BASE-655)			//0x4971
#define OVA_NEXT_LEVEL_SECOND_I2C_BUS	(OVA_BASE-656)			//0x4970
#define OVA_NEXT_LEVEL_THIRD_I2C_BUS	(OVA_BASE-657)			//0x496F
#define OVA_NEXT_LEVEL_FOURTH_I2C_BUS	(OVA_BASE-658)			//0x496E
#define OVA_EEPROM_I2C_ADD				(OVA_BASE-659)			//0x496D
#define OVA_EEPROM_TYPE					(OVA_BASE-660)			//0x496C
#define OVA_UART_RX_LENGTH				(OVA_BASE-661)			//0x496B
#define OVA_UART_RX_READY				(OVA_BASE-662)			//0x496A
#define OVA_NEXT_LEVEL_FIRST_FW_INDEX	(OVA_BASE-663)			//0x4969
#define OVA_NEXT_LEVEL_SECOND_FW_INDEX	(OVA_BASE-664)			//0x4968
#define OVA_NEXT_LEVEL_THIRD_FW_INDEX	(OVA_BASE-665)			//0x4967
#define OVA_NEXT_LEVEL_FOURTH_FW_INDEX	(OVA_BASE-666)			//0x4966
#define OVA_UART_REALSEND				(OVA_BASE-667)			//0x4965
//////////////////////////////////////////////////////////////////////////////////
#define OVA_NEXT_LEVEL_FIFTH_I2C_ADDR	(OVA_BASE-668)			//0x4964
#define OVA_NEXT_LEVEL_FIFTH_I2C_BUS	(OVA_BASE-669)			//0x4963
#define OVA_UART_MODE					(OVA_BASE-670)			//0x4962
#define OVA_CM_ERROR_CODE				(OVA_BASE-671)			//0x4961
#define OVA_CM_START_TRIES				(OVA_BASE-672)			//0x4960
#define OVA_CM_CHIP_SELECT				(OVA_BASE-673)			//0x495F
#define OVA_GPIOI2C_STATUS				(OVA_BASE-674)			//0x495E
#define OVA_EXTI2C_STATUS				(OVA_BASE-675)			//0x495D
#define OVA_SMS_ENABLE					(OVA_BASE-676)			//0x495C
#define OVA_SMS_REQUEST					(OVA_BASE-677)			//0x495B
#define OVA_SMS_REQUEST_LEN				(OVA_BASE-678)			//0x495A
#define OVA_SMS_RESPONSE				(OVA_BASE-679)			//0x4959
#define OVA_SMS_RESPONSE_LEN			(OVA_BASE-680)			//0x4958
#define OVA_UART_EXTEND_RX_LENGTH		(OVA_BASE-682)			//0x4956	2 bytes

#define OVA_USE_MXL69x					(OVA_BASE-752)			//0x4910

	
#define OVA_EEPROM_BOOT_FW_OFFSET		(OVA_BASE-763)			//0x4905	2 bytes
#define OVA_EEPROM_BOOT_FW_SIZE			(OVA_BASE-765)			//0x4903	2 bytes
#define OVA_EEPROM_BOOT_FW_SEGMENT_NUM	(OVA_BASE-766)			//0x4902
#define OVA_EEPROM_BOOT_ERROR_CODE		(OVA_BASE-767)			//0x4901
#define OVA_TEST						(OVA_BASE-768)			//0x4900


// For API: just renaming
#define second_i2c_address				OVA_SECOND_DEMOD_I2C_ADDR		//0x4BFB
#define third_i2c_address				OVA_THIRD_DEMOD_I2C_ADDR		//0x4978
#define fourth_i2c_address				OVA_FOURTH_DEMOD_I2C_ADDR		//0x4977
#define second_i2c_bus					OVA_SECOND_DEMOD_I2C_BUS		//0x4976
#define next_level_first_i2c_address	OVA_NEXT_LEVEL_FIRST_I2C_ADDR	//0x4975	
#define next_level_second_i2c_address	OVA_NEXT_LEVEL_SECOND_I2C_ADDR	//0x4974
#define next_level_third_i2c_address	OVA_NEXT_LEVEL_THIRD_I2C_ADDR	//0x4973
#define next_level_fourth_i2c_address	OVA_NEXT_LEVEL_FOURTH_I2C_ADDR	//0x4972
#define next_level_first_i2c_bus		OVA_NEXT_LEVEL_FIRST_I2C_BUS	//0x4971	
#define next_level_second_i2c_bus		OVA_NEXT_LEVEL_SECOND_I2C_BUS	//0x4970
#define next_level_third_i2c_bus		OVA_NEXT_LEVEL_THIRD_I2C_BUS	//0x496F
#define next_level_fourth_i2c_bus		OVA_NEXT_LEVEL_FOURTH_I2C_BUS	//0x496E

#define ir_table_start_15_8				OVA_IR_TABLE_ADDR_15_18
#define ir_table_start_7_0				OVA_IR_TABLE_ADDR_7_0
#define link_version_31_24				OVA_LINK_VERSION_31_24
#define link_version_23_16				OVA_LINK_VERSION_23_16
#define link_version_15_8				OVA_LINK_VERSION_15_8
#define link_version_7_0				OVA_LINK_VERSION_7_0

// More for API...
#define prechip_version_7_0				0x384F
#define chip_version_7_0				0x1222


#endif


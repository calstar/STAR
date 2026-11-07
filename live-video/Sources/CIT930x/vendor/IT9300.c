#include <linux/kernel.h>    // Jacky Han Inserted

#include "IT9300.h"
#include "brCmd.h"
#include "brUser.h"
#include "brfirmware.h"
#include "brTiming.h"

#define BR_BIT_LEN 8
const Byte BR_BIT_MASK[BR_BIT_LEN] = {
	0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF
};

Dword _IT9300_sendCommand (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    OUT Word            command,    
    IN  Dword           writeBufferLength,
    IN  Byte*           writeBuffer,
    IN  Dword           readBufferLength,
    OUT Byte*           readBuffer
) {
    Dword error = BR_ERR_NO_ERROR;
        
    chip = (Byte)chip;

    error = BrCmd_sendCommand ((Bridge *)endeavour, command, (Byte)chip, writeBufferLength, writeBuffer, readBufferLength, readBuffer);
    return (error);
}

Dword _IT9300_writeRegisters (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            bufferLength,
    IN  Byte*           buffer
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte    registerAddressLength;  

    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }

    error = BrCmd_writeRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, bufferLength, buffer);

    return (error);
}


Dword _IT9300_writeRegister (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            value
) {
    return (_IT9300_writeRegisters (endeavour, (Byte)chip, registerAddress, 1, &value));
}


Dword _IT9300_readRegisters (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            bufferLength,
    OUT Byte*           buffer
) {
    Dword   error = BR_ERR_NO_ERROR;   
    Byte    registerAddressLength;  
    //Dword   i;
    
    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }    

    //for (i = 0; i < IT9300User_RETRY_MAX_LIMIT; i++) {
        error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, bufferLength, buffer);
        if(error==0) goto exit;
    //}

exit:
    return (error);
}


Dword _IT9300_readRegister (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    OUT Byte*           value
) {
    return (_IT9300_readRegisters (endeavour, (Byte)chip, registerAddress, 1, value));
}

Dword _IT9300_loadFirmware (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte*           firmwareCodes,
    IN  BrSegment*      firmwareSegments,
    IN  Word*           firmwarePartitions
) {
    Dword error = BR_ERR_NO_ERROR;
    Dword beginPartition = 0;
    Dword endPartition = 0;
    Dword version;
    Dword firmwareLength;
    Byte* firmwareCodesPointer;
    Word  command;
    Dword i;
    Byte  writeBuffer[1];
    Byte  readBuffer[4];
    
    /** Set I2C master clock speed. */
    error = _IT9300_writeRegister (endeavour, chip, p_br_reg_one_cycle_counter_tuner, IT9300User_I2C_SPEED);
    if (error) goto exit;

    firmwareCodesPointer = firmwareCodes;

    beginPartition = 0;
    endPartition = firmwarePartitions[0];

    for (i = beginPartition; i < endPartition; i++) {
        firmwareLength = firmwareSegments[i].segmentLength;
        if (firmwareSegments[i].segmentType == 0) {
            /** Dwonload firmware */
            error = BrCmd_sendCommand ((Bridge *)endeavour, Command_FW_DOWNLOAD_BEGIN, chip, 0, NULL, 0, NULL);
            if (error) goto exit;

            error = BrCmd_loadFirmware ((Bridge *)endeavour, chip,firmwareLength, firmwareCodesPointer);
            if (error) goto exit;

            error = BrCmd_sendCommand ((Bridge *)endeavour, Command_FW_DOWNLOAD_END, chip, 0, NULL, 0, NULL);
            if (error) goto exit;
        } else if (firmwareSegments[i].segmentType == 1) {
            /** Copy firmware */
            error = BrCmd_sendCommand ((Bridge *)endeavour, Command_SCATTER_WRITE, chip, firmwareLength, firmwareCodesPointer, 0, NULL);
            if (error) goto exit;
        } else {
            /** Direct write firmware */
            command = (Word) (firmwareCodesPointer[0] << 8) + (Word) firmwareCodesPointer[1];
            error = BrCmd_sendCommand ((Bridge *)endeavour, command, chip, firmwareLength - 2, firmwareCodesPointer + 2, 0, NULL);
            if (error) goto exit;
        }
        firmwareCodesPointer += firmwareLength;
    }

    /** Boot */
    error = BrCmd_sendCommand ((Bridge *)endeavour, Command_BOOT, chip, 0, NULL, 0, NULL);
    if (error) goto exit;

    BrUser_delay ((Bridge *)endeavour, 20);

    /** Check if firmware is running */
    version = 0;
    error = BrCmd_sendCommand ((Bridge *)endeavour, Command_QUERYINFO, chip, 1, writeBuffer, 4, readBuffer);
    if (error) goto exit;
    version = (Dword) (((Dword) readBuffer[0] << 24) + ((Dword) readBuffer[1] << 16) + ((Dword) readBuffer[2] << 8) + (Dword) readBuffer[3]);  
    
    if (version == 0)
        error = BR_ERR_BOOT_FAIL;

exit :
    return (error);
}


Dword _IT9300_loadScript (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Word*           scriptSets,
    IN  BrValueSet*     scripts
) {
    Dword   error = BR_ERR_NO_ERROR;
    Word    beginScript;
    Word    endScript;
    Byte    i;
    Word    j;
    Byte    value1 = 0;
    Byte    value2 = 0;
    Byte    chipNumber   = 0;
    Byte    bufferLens   = 1;   
    Byte    buffer[20];
    Dword   tunerAddr;
    Dword   tunerAddrTemp;

//	printk("(Jacky)(_IT9300_loadScript)\n");

    if ((scriptSets[0] != 0) && (scripts != NULL)) {
        beginScript = 0;
        endScript = scriptSets[0];

        for (i = 0; i < chipNumber; i++) {
            /** Load OFSM init script */
            for (j = beginScript; j < endScript; j++) {
                tunerAddr = tunerAddrTemp = scripts[j].address;
                buffer[0] = scripts[j].value;

                while (j < endScript && bufferLens < 20) {
                    tunerAddrTemp += 1;
                    if (tunerAddrTemp != scripts[j+1].address)
                        break;

                    buffer[bufferLens] = scripts[j+1].value;
                    bufferLens ++;
                    j ++;
                }

                error = _IT9300_writeRegisters (endeavour, chip, tunerAddr, bufferLens, buffer);
                if (error) goto exit;
                bufferLens = 1;
            }
        }
    }

    /** Distinguish chip type */
    error = _IT9300_readRegister (endeavour, chip, chip_version_7_0, &value1);
    if (error) goto exit;

    error = _IT9300_readRegister (endeavour, chip, prechip_version_7_0, &value2);
    if (error) goto exit;
    
exit :
    return (error);
}

/** end of local functions */

Dword IT9300_writeRegisters (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            bufferLength,
    IN  Byte*           buffer
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte    registerAddressLength;  

//	printk("(Jacky)(IT9300_writeRegisters)\n");
//    printk("(Jacky)(IT9300_writeRegisters) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_writeRegisters) bufferLength : %d\n",bufferLength);

    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }

    error = BrCmd_writeRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, bufferLength, buffer);
    return (error);
}


Dword IT9300_writeRegister (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            value
) {

//	printk("(Jacky)(IT9300_writeRegister)\n");
//    printk("(Jacky)(IT9300_writeRegister) registerAddress : 0x%x\n",registerAddress);

    return (IT9300_writeRegisters (endeavour, (Byte)chip, registerAddress, 1, &value));
}


Dword IT9300_writeEepromValues (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Word            registerAddress,
    IN  Byte            bufferLength,
    IN  Byte*           buffer
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte    eepromAddress;
    Byte    registerAddressLength;  
    Byte    val;    

//	printk("(Jacky)(IT9300_writeEepromValues)\n");
//    printk("(Jacky)(IT9300_writeEepromValues) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_writeEepromValues) bufferLength : %d\n",bufferLength);

    error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, OVA_EEPROM_I2C_ADD, 2, 1, &val);
	if(error) return error;

    if((val & 0x0F) < 0x08)
        registerAddressLength = 0x01;
    else
        registerAddressLength = 0x02;

    eepromAddress = 0x01;

    error = BrCmd_writeEepromValues ((Bridge *)endeavour, /*0*/(Byte)chip, eepromAddress, registerAddress, registerAddressLength, bufferLength, buffer);

    return (error);
}


Dword IT9300_writeRegisterBits (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            position,
    IN  Byte            length,
    IN  Byte            value
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte    registerAddressLength;  
    Byte    temp;

//	printk("(Jacky)(IT9300_writeRegisterBits)\n");
//    printk("(Jacky)(IT9300_writeRegisterBits) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_writeRegisterBits) position : %d\n",position);
//    printk("(Jacky)(IT9300_writeRegisterBits) length : %d\n",length);
//    printk("(Jacky)(IT9300_writeRegisterBits) value : 0x%x\n",value);

    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }

    if (length == 8) {
        error = BrCmd_writeRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, 1, &value);
		if (error) goto exit;
    } else {

        error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, 1, &temp);
        if (error) goto exit;

        temp = (Byte)BR_REG_CREATE (value, temp, position, length);

        error = BrCmd_writeRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, 1, &temp);
        if (error) goto exit;

    }

exit:
    return (error);
}


Dword IT9300_readRegisters (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            bufferLength,
    OUT Byte*           buffer
) {
    Dword   error = BR_ERR_NO_ERROR;   
    Byte    registerAddressLength;  
    
//	printk("(Jacky)(IT9300_readRegisters)\n");
//    printk("(Jacky)(IT9300_readRegisters) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_readRegisters) bufferLength : %d\n",bufferLength);

    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }
    
    error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, bufferLength, buffer);
    if(error==0) goto exit;

exit:
    return (error);
}


Dword IT9300_readRegister (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    OUT Byte*           value
) {

//	printk("(Jacky)(IT9300_readRegister)\n");
//    printk("(Jacky)(IT9300_readRegister) registerAddress : 0x%x\n",registerAddress);

    return (IT9300_readRegisters (endeavour, (Byte)chip, registerAddress, 1, value));
}


Dword IT9300_readEepromValues (
    IN  Endeavour*  endeavour,
    IN  Byte        chip,
    IN  Word        registerAddress,
    IN  Byte        bufferLength,
    OUT Byte*       buffer
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte    eepromAddress;
    Byte    registerAddressLength;  
	Byte    val;    

//	printk("(Jacky)(IT9300_readEepromValues)\n");
//    printk("(Jacky)(IT9300_readEepromValues) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_readEepromValues) bufferLength : %d\n",bufferLength);

	error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, OVA_EEPROM_I2C_ADD, 2, 1, &val);
	if (error) return error;
    if((val & 0x0F) < 0x08)
        registerAddressLength = 0x01;
    else
        registerAddressLength = 0x02;
    //registerAddressLength = 0x02;
    eepromAddress = 0x01;

    error = BrCmd_readEepromValues ((Bridge *)endeavour, /*0*/(Byte)chip, (Byte)eepromAddress, registerAddress, registerAddressLength, bufferLength, buffer);
    return (error);
}


Dword IT9300_readRegisterBits (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Dword           registerAddress,
    IN  Byte            position,
    IN  Byte            length,
    OUT Byte*           value
) {
    Dword error = BR_ERR_NO_ERROR;
    Byte  temp  = 0;
    Byte  registerAddressLength;
    
//	printk("(Jacky)(IT9300_readRegisterBits)\n");
//    printk("(Jacky)(IT9300_readRegisterBits) registerAddress : 0x%x\n",registerAddress);
//    printk("(Jacky)(IT9300_readRegisterBits) position : %d\n",position);
//    printk("(Jacky)(IT9300_readRegisterBits) length : %d\n",length);
        
    if (registerAddress > 0x000000FF) {
        registerAddressLength = 2;
    } else {
        registerAddressLength = 1;
    }
    
    error = BrCmd_readRegisters ((Bridge *)endeavour, (Byte)chip, registerAddress, registerAddressLength, 1, &temp);
    if (error) goto exit;

    if (length == 8) {
        *value = temp;
    } else {
        temp = BR_REG_GET (temp, position, length);
        *value = temp;
    }

exit:
    return (error);
}


Dword IT9300_getFirmwareVersion (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {
    Dword   error          = BR_ERR_NO_ERROR;
    Byte    writeBuffer[1];
    Byte    readBuffer[4];
    Byte    value          = 0; 

//	printk("(Jacky)(IT9300_getFirmwareVersion)\n");

    /** Check chip version */
    error = IT9300_readRegister (endeavour, chip, chip_version_7_0, &value);
    if (error) goto exit;

    writeBuffer[0] = 1;
    error = BrCmd_sendCommand ((Bridge *)endeavour, Command_QUERYINFO, chip, 1, writeBuffer, 4, readBuffer);
    if (error) goto exit;
    
    endeavour->firmwareVersion = (Dword) (((Dword) readBuffer[0] << 24) + ((Dword) readBuffer[1] << 16) + ((Dword) readBuffer[2] << 8) + (Dword) readBuffer[3]);

exit :
    return (error);
}


Dword IT9300_configOutput (
    IN  Endeavour*    endeavour,
    IN  Byte          chip
) {
    Dword   error = BR_ERR_NO_ERROR;
    Word    frameSize;
    Byte    packetSize;
    Byte    buffer[2];  

//	printk("(Jacky)(IT9300_configOutput)\n");
            
    frameSize  = endeavour->it9300user_usb20_frame_size_dw;
    packetSize = (Byte) (IT9300User_USB20_MAX_PACKET_SIZE / 4);

    if (endeavour->ctrlBus== BUS_USB11) {
        frameSize  = IT9300User_USB11_FRAME_SIZE_DW;
        packetSize = (Byte) (IT9300User_USB11_MAX_PACKET_SIZE / 4);
    }

    /** Reset EP4 */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_mp2_sw_rst, br_reg_mp2_sw_rst_pos, br_reg_mp2_sw_rst_len, 1);
    if (error) goto exit;

    /** Disable EP4 */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_ep4_tx_en, br_reg_ep4_tx_en_pos, br_reg_ep4_tx_en_len, 0);
    if (error) goto exit;

    /** Disable EP4 NAK */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_ep4_tx_nak, br_reg_ep4_tx_nak_pos, br_reg_ep4_tx_nak_len, 0);
    if (error) goto exit;

    /** Enable EP4 */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_ep4_tx_en, br_reg_ep4_tx_en_pos, br_reg_ep4_tx_en_len, 1);
    if (error) goto exit;

    /** Set EP4 transfer length */
    buffer[p_br_reg_ep4_tx_len_7_0 - p_br_reg_ep4_tx_len_7_0] = (Byte) frameSize;
    buffer[p_br_reg_ep4_tx_len_15_8 - p_br_reg_ep4_tx_len_7_0] = (Byte) (frameSize >> 8);
    error = IT9300_writeRegisters (endeavour, chip, p_br_reg_ep4_tx_len_7_0, 2, buffer);
	if (error) goto exit;
    /** Set EP4 packet size */  
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ep4_max_pkt, packetSize);
    if (error) goto exit;

    /** Disable 15 SER/PAR mode */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_ser_mode, br_mp2if_mpeg_ser_mode_pos, br_mp2if_mpeg_ser_mode_len, 0);
    if (error) goto exit;
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_par_mode, br_mp2if_mpeg_par_mode_pos, br_mp2if_mpeg_par_mode_len, 0);
    if (error) goto exit;

    if(chip !=0 || endeavour->ctrlBus==BUS_I2C)
    {
        error = IT9300_writeRegister (endeavour, chip, p_br_reg_clk_sel_fix, 0);// set out_clock  0:40MHz	1:20MHz     2:10MHz		3:5MHz
        if (error) goto exit;

        if(endeavour->gator[chip].outDataType == OUT_DATA_TS_PARALLEL){
            /** Enable tsip */      
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_mpeg_ser_mode, 0);
            if (error) goto exit;
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_mpeg_par_mode, 1);
            if (error) goto exit;
        }else if(endeavour->gator[chip].outDataType == OUT_DATA_TS_SERIAL){
            /** Enable tsis */
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_mpeg_ser_mode, 1);
            if (error) goto exit;       
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_mpeg_par_mode, 0);
            if (error) goto exit;
        }
    }

    /** Negate EP4 reset */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_mp2_sw_rst, br_reg_mp2_sw_rst_pos, br_reg_mp2_sw_rst_len, 0);
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_host_reverse, 0);
    if (error) goto exit;

exit:
    return (error);
}


Dword IT9300_initialize (
    IN  Endeavour*  endeavour,
    IN  Byte        chip
) {
    Dword   error   = BR_ERR_NO_ERROR;

//	printk("(Jacky)(IT9300_initialize)\n");
//	printk("(Jacky)(IT9300_initialize) chip ; %d\n",chip);
            
	if(endeavour->gator[chip].initialized== True){
        error = BR_ERR_ALREADY_INIT;
		goto exit;
	}

    if (endeavour->ctrlBus == 0xFFFF) {
        error = BR_ERR_CONTROL_BUS_FAIL;
        goto exit;
    }
    
    error = IT9300_getFirmwareVersion (endeavour, chip);
    if (error) goto exit;
    if (endeavour->firmwareVersion != 0) {
        endeavour->gator[chip].booted = True;
    } else {
        endeavour->gator[chip].booted = False;  
    }
 
    endeavour->firmwareCodes      = brFirmware_codes;
    endeavour->firmwareSegments   = brFirmware_segments;
    endeavour->firmwarePartitions = brFirmware_partitions;
    endeavour->scriptSets         = brFirmware_scriptSets;
    endeavour->scripts            = brFirmware_scripts;
    
    /** clear i2c address and bus settings in fw */
    error = IT9300_writeRegister (endeavour, chip, second_i2c_bus, 0x00);
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, second_i2c_address, 0x00);
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, third_i2c_address, 0x00);
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, fourth_i2c_address, 0x00);
    if (error) goto exit;
    //error = IT9300_writeRegister (endeavour, chip, fourth_i2c_address, 0x00);
    //if (error) goto exit;
    

	if (endeavour->bypassBoot == False)
	{
		// Load firmware 
		if (endeavour->firmwareCodes != NULL) 
		{
			if (endeavour->gator[chip].booted == False) 
			{
				error = _IT9300_loadFirmware (endeavour, chip, endeavour->firmwareCodes, endeavour->firmwareSegments, endeavour->firmwarePartitions);
				if (error) goto exit;
				endeavour->gator[chip].booted = True;
			}
		}	
	}

    /** Set I2C master bus 2 clock speed.  Fw will overwrite 0xF103 with value of 0xF6A7 */
    //error = IT9300_writeRegister (endeavour, chip, p_br_reg_lnk2ofdm_data_63_56, 0x1a);//100k
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_lnk2ofdm_data_63_56, 0x07);//300k
    if (error) goto exit;
    
    /** Set I2C master bus 1,3 clock 300k in order to support tuner I2C. */
    //error = IT9300_writeRegister (endeavour, chip, p_br_reg_one_cycle_counter_tuner, 0x1a);//100k
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_one_cycle_counter_tuner, 0x7);//300k
    if (error) goto exit;

	if(endeavour->bypassScript == False)
	{
		// Load script
		if(endeavour->scripts != NULL) 
		{
			error = _IT9300_loadScript(endeavour, chip, endeavour->scriptSets, endeavour->scripts);
			if(error) goto exit;
		}
	}



	//****************************************************
    //************* Jacky Han Insertion Start ************
	//****************************************************
	unsigned short VendorId;
	unsigned short ProductId;


    #define IT9300_EEPROM_VENDOR_ID     (OVA_EEPROM_CFG + 0x08)                               // Jacky Han Added
    #define IT9300_EEPROM_PRODUCT_ID    (OVA_EEPROM_CFG + 0x0A)                               // Jacky Han Added


	// Read Vendor ID
    IT9300_readRegisters(endeavour, 0, IT9300_EEPROM_VENDOR_ID, 2, (Byte*)&VendorId);

    JackyIT930xDriverDebug("(Jacky)(IT9300_initialize) VendorId : 0x%x\n",VendorId);

	// Read Product ID
	IT9300_readRegisters(endeavour, 0, IT9300_EEPROM_PRODUCT_ID, 2, (Byte*)&ProductId);

    JackyIT930xDriverDebug("(Jacky)(IT9300_initialize) ProductId : 0x%x\n",ProductId);
	//****************************************************
    //************** Jacky Han Insertion End *************
	//****************************************************



    if(chip == 0 && endeavour->ctrlBus == BUS_USB && endeavour->gator[1].existed == True)
    {
	    //****************************************************
        //*********** Jacky Han Modification Start ***********
		//****************************************************

        #define IT9300_USB_VID_DIGITALWARRIOR                          0x0511         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXW3U4                   0x083F         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXW3PE4                  0x023F         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXW3PE5                  0x073F         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXQ3U4                   0x084A         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE4                  0x024A         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE5                  0x074A         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT5PE                 0x024E         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT5U                  0x084E         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE3                0x0252         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE5                0x0253         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UT                 0x0051         /* Jacky Han */
        #define IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UTS                0x0050         /* Jacky Han */

		if(VendorId == IT9300_USB_VID_DIGITALWARRIOR && 
		   (ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3U4 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE4 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE5 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3U4 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE4 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE5 ||
			ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5PE ||
        	ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5U ||
        	ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE3 ||
        	ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE5 ||
        	ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UT ||
        	ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UTS))
		{
           // DO NOTHING
		}
		else
		{
           //Reset 
	       error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_en, 0x01);
	       if (error) goto exit;
	       error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_on, 0x01);
	       if (error) goto exit;
	       //error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_o, 0x1);
	       //if (error) goto exit;
	       error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_o, 0x0);
	       if (error) goto exit;

	       BrUser_delay((Bridge*)endeavour, 200);
	       error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_o, 0x1);
		   if (error) goto exit;
	       //if (error) goto exit;
	       //BrUser_delay((Bridge*)endeavour, 200);

	       //BrUser_delay((Bridge*)endeavour, 100);        
	       //error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_o, 0x0);
	       //BrUser_delay((Bridge*)endeavour, 100);        
	       //error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh10_o, 0x1);
		}
		//****************************************************
		//************ Jacky Han Modification End ************
		//****************************************************
    }

    if(endeavour->gator[chip].outDataType == OUT_DATA_601_640x480)
    {   
        endeavour->timing = Entiming640x480;
        error = IT9300_load601Timing(endeavour,chip);	
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ccir601_en, 0x21);
		if (error) goto exit;
    }

    if(endeavour->gator[chip].outDataType == OUT_DATA_601_720x576)
    {   
        endeavour->timing = Entiming720x576;
        error = IT9300_load601Timing(endeavour,chip);			
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ccir601_en, 0x21);
		if (error) goto exit;
    }
    
    if(endeavour->gator[chip].outDataType == OUT_DATA_601_320x240)
    {   
        endeavour->timing = Entiming320x240;
        error = IT9300_load601Timing(endeavour,chip);			
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ccir601_en, 0x21);
		if (error) goto exit;
    }
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ignore_sync_byte, 0);
    if (error) goto exit;
    
    /** Set the desired stream type */
    error = IT9300_setOutTsType (endeavour, chip);
    if (error) goto exit;

    /** Set the desired architecture type */
    error = IT9300_configOutput (endeavour, chip);
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_padmiscdrsr, 1);
    if (error) goto exit;

    /** Set registers for driving power 0xD830 **/
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_padmiscdr2, 0);
    if (error) goto exit;

    /** Set registers for driving power 0xD831 **/
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_padmiscdr4, 1);
    if (error) goto exit;

    /** Set registers for driving power 0xD832 **/
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_padmiscdr8, 0);
    if (error) goto exit;

         
	//Set Slave IT9300 I2C Addr & Bus
	if(chip == 0 && endeavour->ctrlBus == BUS_USB)
	{
		if(endeavour->gator[1].existed == True)
		{
			error = IT9300_writeRegister (endeavour, chip, second_i2c_address, endeavour->gator[1].i2cAddr);
			if (error) goto exit;
		}
		if(endeavour->gator[2].existed == True)
		{
			error = IT9300_writeRegister (endeavour, chip, third_i2c_address, endeavour->gator[2].i2cAddr);
			if (error) goto exit;
		}
		if(endeavour->gator[3].existed == True)
		{
			error = IT9300_writeRegister (endeavour, chip, fourth_i2c_address, endeavour->gator[3].i2cAddr);
			if (error) goto exit;
		}

		error = IT9300_writeRegister (endeavour, chip, second_i2c_bus, 0x01);
		if (error) goto exit;
	}
    
    
	//Set Next Level Chip I2C Addr & Bus	
	if (endeavour->tsSource[chip][0].existed == True)
	{
		error = IT9300_writeRegister (endeavour, chip, next_level_first_i2c_address, endeavour->tsSource[chip][0].i2cAddr);
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, next_level_first_i2c_bus, endeavour->tsSource[chip][0].i2cBus);
		if (error) goto exit;
	}
	if (endeavour->tsSource[chip][1].existed == True)
	{
		error = IT9300_writeRegister (endeavour, chip, next_level_second_i2c_address, endeavour->tsSource[chip][1].i2cAddr);
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, next_level_second_i2c_bus, endeavour->tsSource[chip][1].i2cBus);
		if (error) goto exit;
	}
	if (endeavour->tsSource[chip][2].existed == True)
	{
		error = IT9300_writeRegister (endeavour, chip, next_level_third_i2c_address, endeavour->tsSource[chip][2].i2cAddr);
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, next_level_third_i2c_bus, endeavour->tsSource[chip][2].i2cBus);
		if (error) goto exit;
	}
	if (endeavour->tsSource[chip][3].existed == True)
	{
		error = IT9300_writeRegister (endeavour, chip, next_level_fourth_i2c_address, endeavour->tsSource[chip][3].i2cAddr);
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, next_level_fourth_i2c_bus, endeavour->tsSource[chip][3].i2cBus);
		if (error) goto exit;
	}
	if (endeavour->tsSource[chip][4].existed == True)
	{
		error = IT9300_writeRegister (endeavour, chip, OVA_NEXT_LEVEL_FIFTH_I2C_ADDR, endeavour->tsSource[chip][4].i2cAddr);
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, OVA_NEXT_LEVEL_FIFTH_I2C_BUS, endeavour->tsSource[chip][4].i2cBus);
		if (error) goto exit;
	}

	//****************************************************
    //*********** Jacky Han Modification Start ***********
	//****************************************************
	if(VendorId == IT9300_USB_VID_DIGITALWARRIOR && 
	   (ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3U4 ||
	    ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE5 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3U4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE5 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5PE ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5U ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE3 ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE5 ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UT ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UTS))
	{
       // DO NOTHING
	}
	else
	{
/*
	   //suspend gpio1 for TS-C
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh1_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh1_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh1_o, 0x0);
	   if (error) goto exit;
	
	   //suspend gpio7 for TS-D
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh7_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh7_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh7_o, 0x0);
	   if (error) goto exit;
	
	   //suspend gpio13 for TS-B
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh13_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh13_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh13_o, 0x0);
	   if (error) goto exit;
	
	   //suspend gpio14 for TS-E
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_o, 0x0);
	   if (error) goto exit;
	
	   //suspend gpio15 for TS-A
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh15_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh15_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh15_o, 0x0);
	   if (error) goto exit;
*/
	}
    //****************************************************
	//************ Jacky Han Modification End ************
	//****************************************************


	//****************************************************
    //*********** Jacky Han Modification Start ***********
	//****************************************************
	if(VendorId == IT9300_USB_VID_DIGITALWARRIOR && 
	   (ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3U4 ||
	    ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXW3PE5 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3U4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE4 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXQ3PE5 ||
		ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5PE ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT5U ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE3 ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8PE5 ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UT ||
        ProductId == IT9300_USB_PID_DIGITALWARRIOR_PXMLT8UTS))
	{
       // DO NOTHING
	}
	else
	{
#if 1
       //set gpio11  Low
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh11_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh11_on, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh11_o, 0x1);
	   if (error) goto exit;
#endif

	   //Reset 
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh2_en, 0x01);
	   if (error) goto exit;
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh2_on, 0x01);
	   if (error) goto exit;
	   //error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh2_o, 0x1);
	   //if (error) goto exit;

	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh2_o, 0x0);
	   if (error) goto exit;
	   BrUser_delay((Bridge*)endeavour, 500);
	
	   error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh2_o, 0x1);
	   if (error) goto exit;
	   BrUser_delay((Bridge*)endeavour, 500);
	}
    //****************************************************
	//************ Jacky Han Modification End ************
	//****************************************************


    endeavour->gator[chip].initialized = True;

    

exit:
    return (error);
}


Dword IT9300_setOutTsPktLen(
    IN  Endeavour*      endeavour,
    IN  Byte            chip
    )
{
    Dword error = BR_ERR_NO_ERROR;

//	printk("(Jacky)(IT9300_setOutTsPktLen)\n");
            
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts_tag_len, (Byte)(endeavour->gator[chip].outTsPktLen));
    if (error) goto exit;
    
exit:
    return (error); 
}

Dword IT9300_setOutTsType (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {
    Dword error = BR_ERR_NO_ERROR; 

//	printk("(Jacky)(IT9300_setOutTsType)\n");
            
    /** Enable DVB-T interrupt if next stream type is StreamType_DVBT_DATAGRAM */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_dvbt_inten, br_reg_dvbt_inten_pos, br_reg_dvbt_inten_len, 1);
    if (error) goto exit;
    
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_mpeg_full_speed, br_reg_mpeg_full_speed_pos, br_reg_mpeg_full_speed_len, 0);
    if (error) goto exit;   

    /** Enable DVB-T mode */
    error = IT9300_writeRegisterBits (endeavour, chip, p_br_reg_dvbt_en, br_reg_dvbt_en_pos, br_reg_dvbt_en_len, 1);
    if (error) goto exit;

    if (endeavour->gator[chip].outDataType == OUT_DATA_TS_SERIAL)
    {
        error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_ser_mode, br_mp2if_mpeg_ser_mode_pos, br_mp2if_mpeg_ser_mode_len, 1);
        if (error) goto exit;
        error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_par_mode, br_mp2if_mpeg_par_mode_pos, br_mp2if_mpeg_par_mode_len, 0);
        if (error) goto exit;
    }
    else if (endeavour->gator[chip].outDataType == OUT_DATA_TS_PARALLEL)
    {
        error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_ser_mode, br_mp2if_mpeg_ser_mode_pos, br_mp2if_mpeg_ser_mode_len, 0);
        if (error) goto exit;
        error = IT9300_writeRegisterBits (endeavour, chip, p_br_mp2if_mpeg_par_mode, br_mp2if_mpeg_par_mode_pos, br_mp2if_mpeg_par_mode_len, 1);
        if (error) goto exit;
    }
    
exit:
    return (error);
}

Dword IT9300_load601Timing (
    IN  Endeavour*    endeavour,
    IN  Byte          chip
) {
    Dword       error = BR_ERR_NO_ERROR;
    Word        beginScript;
    Word        endScript;
    Word        j;
    Byte        value;
    Dword       addr;
    BrValueSet* pvalueSet;

    pvalueSet = endeavour->timing;

    beginScript = 0;
    endScript   = 68;

    for (j = beginScript; j < endScript; j++) {
        addr  = pvalueSet->address;
        value = pvalueSet->value;

        error = IT9300_writeRegister (endeavour, chip, addr, value);
        if (error) goto exit;

        pvalueSet++;
    }

exit:
    return (error);
}

Dword IT9300_setInTsPktLen(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword  error = BR_ERR_NO_ERROR;
    TsPort tsPort;

    tsPort = endeavour->tsSource[chip][tsSrcIdx].tsPort;

    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_tag_len + tsPort,
                (endeavour->tsSource[chip][tsSrcIdx]).tsPktLen);
    if (error) goto exit;
    
exit:
    return (error); 
}

Dword IT9300_setSyncByteMode(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort = (TsPort)ptsSource->tsPort;
    
    //enable Sync-Byte      
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 1);
    if (error) goto exit;   
                
    //set Sync-Byte value       
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_sync_byte + tsPort, ptsSource->syncByte);
    if (error) goto exit;

exit:
    return (error);
};

Dword IT9300_setTagMode(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    //set aggre
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 0);//0:tag 1:sync  2:remap
    if (error) goto exit;

    //set Tag Byte-0    
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_tag_value0 + 4*tsPort, endeavour->tsSource[chip][tsSrcIdx].tag[0]);
    if (error) goto exit;
    //set Tag Byte-1    
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_tag_value1 + 4*tsPort, endeavour->tsSource[chip][tsSrcIdx].tag[1]);
    if (error) goto exit;
    //set Tag Byte-2    
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_tag_value2 + 4*tsPort, endeavour->tsSource[chip][tsSrcIdx].tag[2]);
    if (error) goto exit;
    //set Tag Byte-3    
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_tag_value3 + 4*tsPort, endeavour->tsSource[chip][tsSrcIdx].tag[3]);
    if (error) goto exit;

exit:
    return (error);
};

Dword IT9300_setPidRemapMode(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    int         i;
    Byte        old_h;
    Byte        old_l;
    Byte        new_h;
    Byte        new_l;  
    Byte        offset_h;
    Byte        offset_l;
    Word        tsIndex[5];
    Word        tsRemapIndex[5];
    Word        remapMode[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndex[0]      = p_br_mp2if_ts0_pid_index;
    tsIndex[1]      = p_br_mp2if_ts1_pid_index;
    tsIndex[2]      = p_br_mp2if_ts2_pid_index;
    tsIndex[3]      = p_br_mp2if_ts3_pid_index;
    tsIndex[4]      = p_br_mp2if_ts4_pid_index;

    tsRemapIndex[0] = p_br_mp2if_ts0_map_index;
    tsRemapIndex[1] = p_br_mp2if_ts1_map_index;
    tsRemapIndex[2] = p_br_mp2if_ts2_map_index;
    tsRemapIndex[3] = p_br_mp2if_ts3_map_index;
    tsRemapIndex[4] = p_br_mp2if_ts4_map_index;

    remapMode[0]    = p_br_mp2if_ts0_remap_mode;
    remapMode[1]    = p_br_mp2if_ts1_remap_mode;
    remapMode[2]    = p_br_mp2if_ts2_remap_mode;
    remapMode[3]    = p_br_mp2if_ts3_remap_mode;
    remapMode[4]    = p_br_mp2if_ts4_remap_mode;

    offset_h = (Byte)((ptsSource->offset & 0xff00)>>8);
    offset_l = (Byte)((ptsSource->offset & 0x00ff));
    
    //set old pid table
    for(i = 0;i < 64; i++)
    {   
        old_h = (Byte)(*(ptsSource->orgPidTable + i) >> 8);
        old_l = (Byte)(*(ptsSource->orgPidTable + i)     );

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, old_h);       
        if (error) goto exit;

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, old_l);       
        if (error) goto exit;   

        if(i < ptsSource->tableLen)
        {
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 1);     
            if (error) goto exit;
        }
        else
        {
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 0);     
            if (error) goto exit;
        }

        error = IT9300_writeRegister (endeavour, chip, tsIndex[tsPort], (Byte)(i));     
        if (error) goto exit;
    }

    //set new pid table
    for(i = 0; i < 64; i++)
    {   
        new_h =(Byte)(*(ptsSource->newPidTable + i) >> 8);
        new_l =(Byte)(*(ptsSource->newPidTable + i)     );

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, new_h);       
        if (error) goto exit;

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, new_l);       
        if (error) goto exit;   

        error = IT9300_writeRegister (endeavour, chip, tsRemapIndex[tsPort], (Byte)(i));        
        if (error) goto exit;
    }

    error = IT9300_writeRegister (endeavour, chip, remapMode[tsPort], (Byte)ptsSource->pidRemapMode);       
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2*tsPort, offset_h);
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2*tsPort, offset_l);     
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 2);
    if (error) goto exit;

exit:
    return (error);
};

Dword IT9300_enableTsPort(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;

//	printk("(Jacky)(IT9300_enableTsPort)\n");
            
    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;
	if(ptsSource->existed)
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_en + tsPort, 1);
	else
		error = BR_ERR_NOT_SUPPORT;
    return (error); 
}

Dword IT9300_disableTsPort(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;

//	printk("(Jacky)(IT9300_disableTsPort)\n");
            
    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;
	if(ptsSource->existed)
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_en + tsPort, 0);
	else
		error = BR_ERR_NOT_SUPPORT;
		
    return (error); 
}

Dword IT9300_setInTsType(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    if(tsPort > TS_PORT_1) goto exit;       

    if(ptsSource->tsType == TS_SERIAL)
    {           
        error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts_in_src + tsPort, 0);
        if (error) goto exit;
    }
    else
    {       
        error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts_in_src + tsPort, 1);
        if (error) goto exit;           
    }

    exit:
    return (error); 
}

Dword IT9300_enPidFilterAT(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
    IN  Byte            tableindex
    )
{
    Dword       error    = BR_ERR_NO_ERROR;
    //Byte        i        = 0;
    Byte        old_h    = 0;
    Byte        old_l    = 0;
    Byte        new_h    = 0;
    Byte        new_l    = 0;   
    Byte        offset_h = 0;
    Byte        offset_l = 0;
    Word        tsIndex[5];
    Word        tsRemapIndex[5];
    Word        remapMode[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndex[0]      = p_br_mp2if_ts0_pid_index;
    tsIndex[1]      = p_br_mp2if_ts1_pid_index;
    tsIndex[2]      = p_br_mp2if_ts2_pid_index;
    tsIndex[3]      = p_br_mp2if_ts3_pid_index;
    tsIndex[4]      = p_br_mp2if_ts4_pid_index;

    tsRemapIndex[0] = p_br_mp2if_ts0_map_index;
    tsRemapIndex[1] = p_br_mp2if_ts1_map_index;
    tsRemapIndex[2] = p_br_mp2if_ts2_map_index;
    tsRemapIndex[3] = p_br_mp2if_ts3_map_index;
    tsRemapIndex[4] = p_br_mp2if_ts4_map_index;

    remapMode[0]    = p_br_mp2if_ts0_remap_mode;
    remapMode[1]    = p_br_mp2if_ts1_remap_mode;
    remapMode[2]    = p_br_mp2if_ts2_remap_mode;
    remapMode[3]    = p_br_mp2if_ts3_remap_mode;
    remapMode[4]    = p_br_mp2if_ts4_remap_mode;  

    //set old pid table
     
    old_h = (Byte)(*(ptsSource->orgPidTable + tableindex)>>8);
    old_l = (Byte)(*(ptsSource->orgPidTable + tableindex)   );

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, old_h);       
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, old_l);       
    if (error) goto exit;   

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 1);     
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, tsIndex[tsPort], tableindex);     
    if (error) goto exit;


    //set new pid table
    new_h = (Byte)(*(ptsSource->newPidTable + tableindex)>>8);
    new_l = (Byte)(*(ptsSource->newPidTable + tableindex)   );

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, new_h);       
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, new_l);       
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, tsRemapIndex[tsPort], tableindex);        
    if (error) goto exit;


    error = IT9300_writeRegister (endeavour, chip, remapMode[tsPort], REMAP_OFFSET_PASS);       
    if (error) goto exit;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2*tsPort, offset_h);        
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2*tsPort, offset_l);     
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 3);        
    if (error) goto exit;           
    
exit:
    return (error); 

}

Dword IT9300_disPidFilterAT(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
    IN  Byte            tableindex
    )
{
    Dword       error    = BR_ERR_NO_ERROR;
    //Byte        i        = 0;
    //Byte        old_h    = 0;
    //Byte        old_l    = 0;
    //Byte        new_h    = 0;
    //Byte        new_l    = 0;   
    Byte        offset_h = 0;
    Byte        offset_l = 0;
    Word        tsIndex[5];
    Word        tsRemapIndex[5];
    Word        remapMode[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndex[0]      = p_br_mp2if_ts0_pid_index;
    tsIndex[1]      = p_br_mp2if_ts1_pid_index;
    tsIndex[2]      = p_br_mp2if_ts2_pid_index;
    tsIndex[3]      = p_br_mp2if_ts3_pid_index;
    tsIndex[4]      = p_br_mp2if_ts4_pid_index;

    tsRemapIndex[0] = p_br_mp2if_ts0_map_index;
    tsRemapIndex[1] = p_br_mp2if_ts1_map_index;
    tsRemapIndex[2] = p_br_mp2if_ts2_map_index;
    tsRemapIndex[3] = p_br_mp2if_ts3_map_index;
    tsRemapIndex[4] = p_br_mp2if_ts4_map_index;

    remapMode[0]    = p_br_mp2if_ts0_remap_mode;
    remapMode[1]    = p_br_mp2if_ts1_remap_mode;
    remapMode[2]    = p_br_mp2if_ts2_remap_mode;
    remapMode[3]    = p_br_mp2if_ts3_remap_mode;
    remapMode[4]    = p_br_mp2if_ts4_remap_mode;  

    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 0);     
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, tsIndex[tsPort], tableindex);     
    if (error) goto exit;

    error = IT9300_writeRegister (endeavour, chip, remapMode[tsPort], REMAP_OFFSET_PASS);       
    if (error) goto exit;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2*tsPort, offset_h);        
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2*tsPort, offset_l);     
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 3);        
    if (error) goto exit;           
    
exit:
    return (error); 

}

Dword IT9300_enPidFilter(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
    )
{
    Dword       error    = BR_ERR_NO_ERROR;
    Byte        i        = 0;
    Byte        old_h    = 0;
    Byte        old_l    = 0;
    Byte        new_h    = 0;
    Byte        new_l    = 0;   
    Byte        offset_h = 0;
    Byte        offset_l = 0;
    Word        tsIndex[5];
    Word        tsRemapIndex[5];
    Word        remapMode[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndex[0]      = p_br_mp2if_ts0_pid_index;
    tsIndex[1]      = p_br_mp2if_ts1_pid_index;
    tsIndex[2]      = p_br_mp2if_ts2_pid_index;
    tsIndex[3]      = p_br_mp2if_ts3_pid_index;
    tsIndex[4]      = p_br_mp2if_ts4_pid_index;

    tsRemapIndex[0] = p_br_mp2if_ts0_map_index;
    tsRemapIndex[1] = p_br_mp2if_ts1_map_index;
    tsRemapIndex[2] = p_br_mp2if_ts2_map_index;
    tsRemapIndex[3] = p_br_mp2if_ts3_map_index;
    tsRemapIndex[4] = p_br_mp2if_ts4_map_index;

    remapMode[0]    = p_br_mp2if_ts0_remap_mode;
    remapMode[1]    = p_br_mp2if_ts1_remap_mode;
    remapMode[2]    = p_br_mp2if_ts2_remap_mode;
    remapMode[3]    = p_br_mp2if_ts3_remap_mode;
    remapMode[4]    = p_br_mp2if_ts4_remap_mode;        
    
    //set old pid table
    for(i =0;i<64;i++)
    {   
        old_h = (Byte)(*(ptsSource->orgPidTable + i)>>8);
        old_l = (Byte)(*(ptsSource->orgPidTable + i)   );

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, old_h);       
        if (error) goto exit;

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, old_l);       
        if (error) goto exit;   

        if(i<ptsSource->tableLen)
        {
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 1);     
            if (error) goto exit;
        }
        else
        {
            error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 0);     
            if (error) goto exit;
        }

        error = IT9300_writeRegister (endeavour, chip, tsIndex[tsPort], (i));     
        if (error) goto exit;

    }

    //set new pid table
    for(i =0;i<64;i++)
    {   
        new_h = (Byte)(*(ptsSource->newPidTable + i)>>8);
        new_l = (Byte)(*(ptsSource->newPidTable + i)   );

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, new_h);       
        if (error) goto exit;

        error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, new_l);       
        if (error) goto exit;

        error = IT9300_writeRegister (endeavour, chip, tsRemapIndex[tsPort], (i));        
        if (error) goto exit;
    }

    error = IT9300_writeRegister (endeavour, chip, remapMode[tsPort], REMAP_OFFSET_PASS);       
    if (error) goto exit;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2*tsPort, offset_h);        
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2*tsPort, offset_l);     
    if (error) goto exit;
            
    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 3);        
    if (error) goto exit;           
    
exit:
    return (error); 
}

Dword IT9300_setExternalclock (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Bool            bvalue
) {
	if(bvalue)
    return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_mpclk_out_sel, 1));
	else
    return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_mpclk_out_sel, 0));
}

Dword IT9300_setNullpacket (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Bool            bvalue
) {
	if(bvalue)
    return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_null_mode, 1));
	else
    return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_null_mode, 0));
}


Dword IT9300_modigyTEIerror (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Bool            bvalue
) {
    Dword       error    = BR_ERR_NO_ERROR;
	if(bvalue)
    {        
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts0_tei_modify, 1);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts1_tei_modify, 1);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts2_tei_modify, 1);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts3_tei_modify, 1);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts4_tei_modify, 1);     
        if (error) goto exit;           
    }
	else
    {
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts0_tei_modify, 0);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts1_tei_modify, 0);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts2_tei_modify, 0);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts3_tei_modify, 0);     
        if (error) goto exit;           
        error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_ts4_tei_modify, 0);     
        if (error) goto exit;           
    }
    exit:
    return (error); 

    
}

Dword IT9300_setIgnoreFail (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Bool            bvalue
) {
	if(bvalue)
    	return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_ts_fail_ignore, 0x1F));
	else
    	return (IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_ts_fail_ignore, 0));
}

Dword IT9300_setOutputTsType (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  TsType			tsoutType
) {
    Dword       error    = BR_ERR_NO_ERROR;

	switch(tsoutType)
	{
		case OUT_DATA_TS_PARALLEL:
		{
			error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_mpeg_ser_mode, 0);
			if (error) return error;
			error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_mpeg_par_mode, 1);
			if (error) return error;
			break;
		}
		case OUT_DATA_TS_SERIAL:
		{
			error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_mpeg_ser_mode, 1);
			if (error) return error;
			error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_mp2if_mpeg_par_mode, 0);
			if (error) return error;
			break;
		}		
	}
	return error;
}

Dword IT9300_setOutputclock(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte     		value
) {
    Dword       error    = BR_ERR_NO_ERROR;
	error = IT9300_writeRegister (endeavour, (Byte)chip, p_br_reg_clk_sel_fix, value);
	return error;
}

Dword IT9300_settestmode(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
    IN  Byte     		mode
) {
    Dword       error    = BR_ERR_NO_ERROR;	
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;
	error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_testmode+tsPort, mode);
	return error;
}

Dword IT9300_setDataRate(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
    IN  Byte     		value
) {
    Dword       error    = BR_ERR_NO_ERROR;	
    TsSource*   ptsSource;
    TsPort      tsPort;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;
	error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_trate+tsPort, value);
	return error;
}

Dword IT9300_writeGenericRegisters(
     IN  Endeavour*      endeavour,
     IN  Byte            chip,
     IN  Byte            bus,
     IN  Byte            slaveAddress,
     IN  Byte            bufferLength,
     IN  Byte*           buffer
) {
     Dword   error = BR_ERR_NO_ERROR;
     Byte writeBuffer[256];
     Byte i;

     writeBuffer[0] = bufferLength;
     writeBuffer[1] = bus;
     writeBuffer[2] = slaveAddress;
     for (i = 0; i < bufferLength; i++) 
           writeBuffer[3 + i] = buffer[i]; 
     error = _IT9300_sendCommand (endeavour, chip, Command_GENERIC_WRITE, bufferLength + 3, writeBuffer, 0, NULL);
     return error;
}


Dword IT9300_readGenericRegisters (
     IN  Endeavour*      endeavour,
     IN  Byte            chip,
     IN  Byte            bus,
     IN  Byte            slaveAddress,
     IN  Byte            bufferLength,
     OUT Byte*           buffer
) {
     Dword   error = BR_ERR_NO_ERROR;
     Byte writeBuffer[3];

     writeBuffer[0] = bufferLength;
     writeBuffer[1] = bus;
     writeBuffer[2] = slaveAddress;
     error = _IT9300_sendCommand (endeavour, chip, Command_GENERIC_READ, 3, writeBuffer, bufferLength, buffer);
     return error;
}

Dword IT9300_getIrCode (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    OUT Dword*          code
) {	
	Dword	error = BR_ERR_NO_ERROR;
	Byte	readBuffer[4];

	error = _IT9300_sendCommand (endeavour, chip, Command_IR_GET, 0, NULL, 4, readBuffer);
	if (error) goto exit;

	*code = (Dword) ((readBuffer[0] << 24) + (readBuffer[1] << 16) + (readBuffer[2] << 8) + readBuffer[3]);

exit :
	return (error);
}

Dword IT9300_reboot (
    IN  Endeavour*  endeavour,
    IN  Byte        chip
)  {
	Dword error = Error_NO_ERROR;
	Dword version;
	Byte i;

	error = IT9300_getFirmwareVersion(endeavour, chip);
	
	if (error) goto exit;
	if (endeavour->firmwareVersion == 0xFFFFFFFF) goto exit;       /** I2M and I2U */
	if (endeavour->firmwareVersion != 0) 
	{
		error = BrCmd_reboot((Bridge *)endeavour, chip);		
		BrUser_delay((Bridge *)endeavour, 10);
		version = 1;
		for (i = 0; i < 30; i++) 
		{				
			error = IT9300_getFirmwareVersion(endeavour, chip);
			if (error == BR_ERR_NO_ERROR) break;
			BrUser_delay ((Bridge *)endeavour, 10);
		}
		if (error) 
			goto exit;
		
		if (version != 0)
			error = BR_ERR_REBOOT_FAIL;
	}
	endeavour->gator[chip].booted = False;

exit :
	return (error);
}

Dword IT9300_setUARTBaudrate (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
	IN  UartBaudRate	baudrate
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;
	switch(baudrate)
	{
	case UART_BAUDRATE_9600 :
		temp = 0;
		break;

	case UART_BAUDRATE_19200 :
		temp = 1;
		break;

	case UART_BAUDRATE_38400 :
		temp = 2;			
		break;

	case UART_BAUDRATE_57600 :
		temp = 245;
		break;

	case UART_BAUDRATE_115200 :
		temp = 250;
		break;

	default :
		return BR_ERR_BAUDRATE_NOT_SUPPORT;
	}
	
	error = _IT9300_sendCommand(endeavour, chip, Command_UART_SET_BAUDRATE, 1, &temp, 0, NULL);
	return error;
}

Dword IT9300_sentUARTData (
    IN  Endeavour*      endeavour,
    IN  Byte			chip,
	IN  Dword			bufferLength,
	IN  Byte*           buffer
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte i;
	Dword writeLength;
	Dword bufferindex = 0;
	Byte writebuffer[49];

	if(bufferLength == 0) goto exit;

	//****************************************************
    //*********** Jacky Han Modification Start ***********
	//****************************************************
#if 0
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_en, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_on, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_o, 1); 
	if (error) goto exit;
#endif
	//****************************************************
    //************ Jacky Han Modification End ************
	//****************************************************

	writeLength = bufferLength;
	while(writeLength != 0)
	{
		for(i = 0; i < 48; i++)
			writebuffer[i + 1] = buffer[bufferindex + i];

		if(writeLength > 48)
		{
			writebuffer[0] = 48;
			error = _IT9300_sendCommand (endeavour, chip, Command_UART_WRITE, 49, writebuffer, 0, NULL);
			if (error) goto exit;
			bufferindex += 48;
			writeLength -= 48;
		}
		else
		{
			writebuffer[0] = (Byte)(writeLength);
			error = _IT9300_sendCommand (endeavour, chip, Command_UART_WRITE, writeLength + 1, writebuffer, 0, NULL);
			if (error) goto exit;
			bufferindex = bufferindex + writeLength;
			writeLength = 0;
		}
	}	
	
	//****************************************************
    //*********** Jacky Han Modification Start ***********
	//****************************************************
#if 0
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_o, 0); 
#endif
	//****************************************************
    //************ Jacky Han Modification End ************
	//****************************************************

	if (error) goto exit;
exit:
	return error;
}


Dword IT9300_bcasInit (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasInit)\n");

	temp = 1;
	error = _IT9300_sendCommand(endeavour, chip, Command_UART_SET_MODE, 1, &temp, 0, NULL);
	return error;
}


Dword IT9300_bcasResetCard (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {	
	Dword error = BR_ERR_NO_ERROR;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasResetCard)\n");

	//****************************************************
    //*********** Jacky Han Modification Start ***********
	//****************************************************
#if 0
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_en, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_on, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_o, 0); 
	if (error) goto exit;

	error = _IT9300_writeRegister(endeavour, chip, 0x7904, 2);	//uart_status
	if (error) goto exit;

	error = IT9300_setUARTBaudrate(endeavour, chip, UART_BAUDRATE_9600);
	if (error) goto exit;

	BrUser_delay((Bridge *)endeavour, 5);

	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh3_o, 1); 
	if (error) goto exit;
#else
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_en, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_on, 0x01);
	if (error) goto exit;
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_o, 0); 
	if (error) goto exit;

	error = _IT9300_writeRegister(endeavour, chip, 0x7904, 2);	//uart_status
	if (error) goto exit;

	error = IT9300_setUARTBaudrate(endeavour, chip, UART_BAUDRATE_9600);
	if (error) goto exit;

	BrUser_delay((Bridge *)endeavour, 5);

	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh14_o, 1); 
	if (error) goto exit;
#endif
	//****************************************************
    //************ Jacky Han Modification End ************
	//****************************************************

exit:	
	return error;
}


Dword IT9300_bcasCheckReady (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
	IN  Bool*           ready
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasCheckReady)\n");

	error = IT9300_readRegister(endeavour, chip, OVA_UART_RX_READY, &temp);
	if (error) goto exit;
	if(temp)
		*ready = True;
	else
		*ready = False;
	
exit:
	return error;
}


Dword IT9300_bcasGetData (
    IN  Endeavour*		endeavour,
    IN  Byte            chip,
	IN  Byte*           bufferLength,
	IN  Byte*           buffer
) {
	Dword error = BR_ERR_NO_ERROR;

	Byte len = 32;
	Byte temp = 32;
	Byte index = 0;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasGetData)\n");
	
	if(*bufferLength > 32)
	{		
		while(len != 0)
		{
			error = IT9300_readRegister (endeavour, chip, OVA_UART_RX_LENGTH, &temp);
			if(error) goto exit;
			if(temp > 32)
				len = 32;
			else
				len = temp;
			if(len == 0)
				break;
			temp =len;
			error = _IT9300_sendCommand (endeavour, chip, Command_UART_READ, 1, &temp, (Dword)len, buffer + index);
			if(error) goto exit;
			index = index + len;
			if(*bufferLength == index)	
				break;			
		}
		*bufferLength = index;
	}
	else
	{
		error = IT9300_readRegister (endeavour, chip, OVA_UART_RX_LENGTH, &temp);
		if (error) goto exit;

		len = temp;
		*bufferLength = len;
		if(len == 0)	
			goto exit;
		temp = len;
		error = _IT9300_sendCommand (endeavour, chip, Command_UART_READ, 1, &temp, (Dword)len, buffer);
		return error;
	}

exit:
	return error;
}


Dword IT9300_bcasSendData (
    IN  Endeavour*		endeavour,
    IN  Byte            chip,
	IN  Byte            bufferLength,
	IN  Byte*           buffer
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte k;
	Byte writeLength;
	Byte bufferindex = 0;
	Byte writebuffer[49];

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasSendData)\n");

	if(bufferLength == 0) 
		goto exit;

	if(bufferLength > 255)
	{
		error = BR_ERR_INVALID_DATA_LENGTH;
		goto exit;
	}

	writeLength = bufferLength;
	while(writeLength != 0)
	{
		for (k = 0; k < 48; k++)
			writebuffer[k + 1] = buffer[bufferindex + k];
			
		if(writeLength > 48)
		{
			writebuffer[0] = 48;
			error = _IT9300_sendCommand (endeavour, chip, Command_UART_WRITE, 49, writebuffer, 0, NULL);
			if (error) goto exit;
			bufferindex += 48;
			writeLength -= 48;
		}
		else
		{
			error = IT9300_writeRegister (endeavour, chip, OVA_UART_REALSEND, 1);
			if (error) goto exit;
			writebuffer[0] = writeLength;
			error = _IT9300_sendCommand (endeavour, chip, Command_UART_WRITE, writeLength + 1, writebuffer, 0, NULL);
			if (error) goto exit;
			bufferindex = bufferindex + writeLength;
			writeLength = 0;
		}
	}	
	
exit:
	return error;
}


Dword IT9300_bcasDetectCard (
    IN  Endeavour*		endeavour,
    IN  Byte            chip,
	IN  Bool*           cardDetect
) {

	Dword error = BR_ERR_NO_ERROR;
	Byte temp;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasDetectCard)\n");

	error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_gpioh6_on, 1);
	if(error) goto exit;
	error = IT9300_writeRegister (endeavour, chip, p_br_reg_top_gpioh6_en, 0);
	if(error) goto exit;
	error = IT9300_readRegister (endeavour, chip, r_br_reg_top_gpioh6_i, &temp);
	if(error) goto exit;
	
	if(temp == 1)
		*cardDetect = False;
	else
		*cardDetect = True;
		
exit:
	return error;
}


Dword IT9300_bcasSetBaudrate (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
	IN  UartBaudRate	baudrate
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;

	JackyIT930xDriverDebug("(Jacky)(IT9300_bcasSetBaudrate)\n");

	switch(baudrate)
	{
	case UART_BAUDRATE_9600 :
		temp = 0;
		break;

	case UART_BAUDRATE_19200 :
		temp = 1;
		break;

	default :
		return BR_ERR_BAUDRATE_NOT_SUPPORT;
	}
	
	error = _IT9300_sendCommand(endeavour, chip, Command_UART_SET_BAUDRATE, 1, &temp, 0, NULL);
	return error;
}

Dword IT9300_SetSuspend (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;
    Byte Val;

	error = _IT9300_readRegister(endeavour,chip,0xF491,&Val);
    temp = Val ;
    Val = temp|0x64;
    error = _IT9300_writeRegister(endeavour,chip,0xF491,Val);
	return error;
}

Dword IT9300_SetSuspendback (
    IN  Endeavour*      endeavour,
    IN  Byte            chip
) {
	Dword error = BR_ERR_NO_ERROR;
	Byte temp;
    Byte Val;

	error = _IT9300_readRegister(endeavour,chip,0xF491,&Val);
    temp = Val ;
    Val = temp&0x9B;
    error = _IT9300_writeRegister(endeavour,chip,0xF491,Val);
	return error;
}

Dword IT9300_readGenericRegistersExtend (
     IN  Endeavour*      endeavour,
     IN  Byte            chip,
     IN  Byte            bus,
     IN  Byte            slaveAddress,
	 IN	 Byte			 repeatStartEnable,
     IN  Byte            wBufferLength,
     IN	 Byte*           wBuffer,
     IN  Byte            rBufferLength,
     OUT Byte*           rBuffer
 ) {
     Dword  error = BR_ERR_NO_ERROR;

	 //Write part
	 if(repeatStartEnable == 1)
	 {
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_repeat_start, 1);
		if(error) return error;
	 }
	 error = IT9300_writeGenericRegisters(endeavour, chip, bus, slaveAddress, wBufferLength, wBuffer);
	 if(error) return error;
	 if(repeatStartEnable == 1)
	 {
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_repeat_start, 0);
		if(error) return error;
	 }

	 //Read part
     error = IT9300_readGenericRegisters(endeavour, chip, bus, slaveAddress, rBufferLength, rBuffer);
     return error;
}


Dword IT9300_setTsEncryptKey (
     IN  Endeavour*		endeavour,
     IN  Byte           chip,
     IN  Byte*          buffer
) {
    Dword   error = BR_ERR_NO_ERROR;
    Byte i;

	for(i = 0; i < 16; i++)	 
	{
		error = IT9300_writeRegister(endeavour, chip, (p_br_reg_ts_enc_key0_7_0 + i), buffer[i]);
		if (error) return error;
	}
    return error;
}


Dword IT9300_setTsEncrypt (
     IN  Endeavour*		endeavour,
     IN  Byte           chip,
     IN  Bool           benable
) {
     Dword		error = BR_ERR_NO_ERROR;


	if(benable == 1)
	{
		error = IT9300_writeRegister(endeavour, chip,p_br_reg_ts_enc_one_word_en, 1);
		if (error) return error;
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_ts_enc_bypass, 0);
		if (error) return error;
	}
	else
	{
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_ts_enc_bypass, 1);
		if (error) return error;
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_ts_enc_one_word_en, 0);
		if (error) return error;
	}
     
	return error;
}


Dword IT9300_simplePidFilter_AddPid (
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
	IN	Word			pid,
	IN	Byte			index
) {
    Dword       error    = BR_ERR_NO_ERROR;
    Word        tsIndexAdd[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

	if(index > 63)
		return BR_ERR_SIMPLE_PID_FILTER_INVALID_INDEX;
	if(pid > 0x1FFF)
		return BR_ERR_SIMPLE_PID_FILTER_INVALID_PID;


    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndexAdd[0]      = p_br_mp2if_ts0_pid_index;
    tsIndexAdd[1]      = p_br_mp2if_ts1_pid_index;
    tsIndexAdd[2]      = p_br_mp2if_ts2_pid_index;
    tsIndexAdd[3]      = p_br_mp2if_ts3_pid_index;
    tsIndexAdd[4]      = p_br_mp2if_ts4_pid_index;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, (pid >> 8));       
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, (pid & 0xFF));       
    if (error) goto exit;   
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 1);     
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, tsIndexAdd[tsPort], index);     
    if (error) goto exit;
     
exit:
    return (error); 
}

Dword IT9300_simplePidFilter_RemovePid(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
	IN	Byte			index
) {
    Dword       error    = BR_ERR_NO_ERROR;
    Word        tsIndexAdd[5];
    TsSource*   ptsSource;
    TsPort      tsPort;

	if(index > 63)
		return BR_ERR_SIMPLE_PID_FILTER_INVALID_INDEX;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndexAdd[0] = p_br_mp2if_ts0_pid_index;
    tsIndexAdd[1] = p_br_mp2if_ts1_pid_index;
    tsIndexAdd[2] = p_br_mp2if_ts2_pid_index;
    tsIndexAdd[3] = p_br_mp2if_ts3_pid_index;
    tsIndexAdd[4] = p_br_mp2if_ts4_pid_index;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 0);     
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, tsIndexAdd[tsPort], index);     
    if (error) goto exit;
     
exit:
    return (error); 
}

Dword IT9300_simplePidFilter_ResetPidTable(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx
) {
    Dword       error    = BR_ERR_NO_ERROR;
    Word        tsIndexAdd[5];    
    TsSource*   ptsSource;
    TsPort      tsPort;
	Byte		i;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    tsIndexAdd[0] = p_br_mp2if_ts0_pid_index;
    tsIndexAdd[1] = p_br_mp2if_ts1_pid_index;
    tsIndexAdd[2] = p_br_mp2if_ts2_pid_index;
    tsIndexAdd[3] = p_br_mp2if_ts3_pid_index;
    tsIndexAdd[4] = p_br_mp2if_ts4_pid_index;
    
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_index_en, 0);     
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_h, 0x1F);       
    if (error) goto exit;
    error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_pid_dat_l, 0xFF);       
    if (error) goto exit;   
	for(i = 0; i < 64; i++)
	{
		error = IT9300_writeRegister (endeavour, chip, tsIndexAdd[tsPort], i);     
		if (error) goto exit;
	}
     
exit:
    return (error); 
}

Dword IT9300_simplePidFilter_DumpPidTable(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
	OUT	SimplePidTable*	pidTable
) {
    Dword       error    = BR_ERR_NO_ERROR;
    TsSource*   ptsSource;
    TsPort      tsPort;
	Word        remapModeAdd[5];
	Word		pidTableAdd_H[5], pidTableAdd_L[5];
	Word		pidIndexAdd[5];
	Byte		mode;
	Byte		i;
	Byte		enable;
	Byte		pid_H, pid_L;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;


    remapModeAdd[0] = p_br_mp2if_ts0_remap_mode;
    remapModeAdd[1] = p_br_mp2if_ts1_remap_mode;
    remapModeAdd[2] = p_br_mp2if_ts2_remap_mode;
    remapModeAdd[3] = p_br_mp2if_ts3_remap_mode;
    remapModeAdd[4] = p_br_mp2if_ts4_remap_mode;   
	pidTableAdd_H[0] = r_br_mp2if_ts0_pid_rdat_12_8;
	pidTableAdd_L[0] = r_br_mp2if_ts0_pid_rdat_7_0;
	pidTableAdd_H[1] = r_br_mp2if_ts1_pid_rdat_12_8;
	pidTableAdd_L[1] = r_br_mp2if_ts1_pid_rdat_7_0;
	pidTableAdd_H[2] = r_br_mp2if_ts2_pid_rdat_12_8;
	pidTableAdd_L[2] = r_br_mp2if_ts2_pid_rdat_7_0;
	pidTableAdd_H[3] = r_br_mp2if_ts3_pid_rdat_12_8;
	pidTableAdd_L[3] = r_br_mp2if_ts3_pid_rdat_7_0;
	pidTableAdd_H[4] = r_br_mp2if_ts4_pid_rdat_12_8;
	pidTableAdd_L[4] = r_br_mp2if_ts4_pid_rdat_7_0;
	pidIndexAdd[0] = p_br_mp2if_ts0_pid_rd_idx;
	pidIndexAdd[1] = p_br_mp2if_ts1_pid_rd_idx;
	pidIndexAdd[2] = p_br_mp2if_ts2_pid_rd_idx;
	pidIndexAdd[3] = p_br_mp2if_ts3_pid_rd_idx;
	pidIndexAdd[4] = p_br_mp2if_ts4_pid_rd_idx;


	error = IT9300_readRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, &mode);//0:tag 1:sync  2:remap
	if (error) goto exit;
	if (mode < 2)
		pidTable->pidMode = PID_FILTER_MODE_DISABLE;
	else
	{
		error = IT9300_readRegister (endeavour, chip, remapModeAdd[tsPort], &mode);       
		if (error) goto exit;
		if (mode == REMAP_OFFSET_PASS)
			pidTable->pidMode = PID_FILTER_MODE_BLOCK;
		else if (mode == REMAP_OFFSET_BLOCK)
			pidTable->pidMode = PID_FILTER_MODE_PASS;
		else
			return BR_ERR_SIMPLE_PID_FILTER_INVALID_MODE;
	}

	for(i = 0; i < 64; i++)
	{			
		error = IT9300_writeRegister(endeavour, chip, pidIndexAdd[tsPort], i);
		if (error) goto exit;
		error = IT9300_readRegister(endeavour, chip, r_br_mp2if_ts0_pid_rvld + tsPort, &enable);
		if (error) goto exit;
        error = IT9300_readRegister(endeavour, chip, pidTableAdd_H[tsPort], &pid_H);
		if (error) goto exit;
        error = IT9300_readRegister(endeavour, chip, pidTableAdd_L[tsPort], &pid_L);
		if (error) goto exit;

		pidTable->enable[i] = enable;
		pidTable->pid[i] = pid_H * 256 + pid_L;
	}
exit:
    return (error); 
}

Dword IT9300_simplePidFilter_SetMode(
    IN  Endeavour*      endeavour,
    IN  Byte            chip,
    IN  Byte            tsSrcIdx,
	IN	PID_FILTER_MODE	pidMode
) {
    Dword       error    = BR_ERR_NO_ERROR;
    Word        remapModeAdd[5];
    TsSource*   ptsSource;
    TsPort      tsPort;
	Byte		tmp;

	if(pidMode > PID_FILTER_MODE_BLOCK)
		return BR_ERR_SIMPLE_PID_FILTER_INVALID_MODE;

    ptsSource = &(endeavour->tsSource[chip][tsSrcIdx]);
    tsPort    = ptsSource->tsPort;

    remapModeAdd[0] = p_br_mp2if_ts0_remap_mode;
    remapModeAdd[1] = p_br_mp2if_ts1_remap_mode;
    remapModeAdd[2] = p_br_mp2if_ts2_remap_mode;
    remapModeAdd[3] = p_br_mp2if_ts3_remap_mode;
    remapModeAdd[4] = p_br_mp2if_ts4_remap_mode;        
    

	if(pidMode == PID_FILTER_MODE_DISABLE)
	{
		error = IT9300_writeRegister (endeavour, chip, remapModeAdd[tsPort], REMAP_OFFSET_PASS);       
		if (error) goto exit;
		error = IT9300_readRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, &tmp);//0:tag 1:sync  2:remap
		if (error) goto exit;
		tmp = tmp & 0x01;
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, tmp);
		if (error) goto exit;
	}
	else if(pidMode == PID_FILTER_MODE_PASS)
	{
		error = IT9300_writeRegister (endeavour, chip, remapModeAdd[tsPort], REMAP_OFFSET_BLOCK);       
		if (error) goto exit;
		error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 3);        
		if (error) goto exit; 
		error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2 * tsPort, 0);        
		if (error) goto exit;            
		error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2 * tsPort, 0);     
		if (error) goto exit;
	}
	else if(pidMode == PID_FILTER_MODE_BLOCK)
	{
		error = IT9300_writeRegister (endeavour, chip, remapModeAdd[tsPort], REMAP_OFFSET_PASS);       
		if (error) goto exit;
	    error = IT9300_writeRegister (endeavour, chip, p_br_reg_ts0_aggre_mode + tsPort, 3);        
		if (error) goto exit; 
		error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_12_8 + 2 * tsPort, 0);        
		if (error) goto exit;            
		error = IT9300_writeRegister (endeavour, chip, p_br_mp2if_ts0_pid_offset_7_0 + 2 * tsPort, 0);     
		if (error) goto exit;
	}          
    
exit:
    return (error); 
}

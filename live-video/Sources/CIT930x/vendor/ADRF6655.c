#include "ADRF6655.h"

//---------- default setting 666000KHz
Dword ADRF6655_Reg0 = 0x00000308;
Dword ADRF6655_Reg1 = 0x00001901;
Dword ADRF6655_Reg2 = 0x00000002;
Dword ADRF6655_Reg3 = 0x0060000B;
Dword ADRF6655_Reg4 = 0x000AA7A4;
Dword ADRF6655_Reg5 = 0x000000E5;
Dword ADRF6655_Reg6 = 0x001E7D06;//org: 0x001E7D06 ??
Dword ADRF6655_Reg7 = 0x00000007;

#define PFD	20	//PFD = 20MHz

Dword ADRF6655_Set6655SPIdata(
     IN  Endeavour*     endeavour,
     IN  Byte           chip,
     IN  Byte           data0,
     IN  Byte           data1,
     IN  Byte           data2
);

Dword ADRF6655_init (Endeavour*    endeavour) {
    Dword error = BR_ERR_NO_ERROR;	

	//Turn off UART 1 is necessary!!!!
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_uart1_sel, 0);
	if(error) goto exit;

	//Init GPIO
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh9_o, 0x0);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh9_en, 0x1);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh9_on, 0x1);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh8_o, 0x0);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh8_en, 0x1);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh8_on, 0x1);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh4_o, 0x0);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh4_en, 0x1);
	if (error) goto exit; 
	error = IT9300_writeRegister(endeavour, 0, p_br_reg_top_gpioh4_on, 0x1);
	if (error) goto exit; 

	ADRF6655_Reg5 = (ADRF6655_Reg5 & 0x00FFFFBF);		//turn off PLL
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg5);
	if (error) goto exit;
	BrUser_delay((Bridge *)endeavour, 200);
	ADRF6655_Reg5 = (ADRF6655_Reg5 | 0x00000040);		//turn on PLL
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg5);
	if (error) goto exit;


	error = ADRF6655_writeData(endeavour, ADRF6655_Reg7);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg6);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg4);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg3);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg2);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg1);
	if (error) goto exit;
	
	BrUser_delay((Bridge *)endeavour, 2);
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg0);

exit:
	return error;
}


Dword ADRF6655_writeData (
		Endeavour*		endeavour,
		Dword			data
) {
   
	return (ADRF6655_Set6655SPIdata(endeavour, 0, (Byte)(data>>16), (Byte)(data>>8), (Byte)data));

}



Dword ADRF6655_setLoFrequency (
		Endeavour*		endeavour,
		Dword			freq_KHz	//KHz
) {
    Dword error = BR_ERR_NO_ERROR;
	Byte RS = 1; //Div
	Dword Fpfd_KHz = 20000; //20M
	Dword INT;
	Word MOD = 2000;
	Dword FRAC;
	Dword loFreq;
	Byte is_Divide2_mode = 1;	//1:divide by 2		0:devide by 3;


	if(freq_KHz > 2300000) 
	{
		error = BR_ERR_FREQ_OUT_OF_RANGE;
		goto exit;
	}
	else if(freq_KHz >= 1530000) 
	{
		RS = 1; //1*REFIN
		Fpfd_KHz = 20000;
		is_Divide2_mode = 1;
		loFreq = freq_KHz;
	}
	else if(freq_KHz >= 1050000) 
	{
		RS = 1; //1*REFIN
		Fpfd_KHz = 20000;
		is_Divide2_mode = 0;
		loFreq = freq_KHz * 3 / 2;
	}
	else
	{		
		error = BR_ERR_FREQ_OUT_OF_RANGE;
		goto exit;
	}

	INT = loFreq / Fpfd_KHz;
	FRAC = (loFreq - INT * Fpfd_KHz) / (Fpfd_KHz / MOD);


	ADRF6655_Reg0 = (ADRF6655_Reg0 & 0x00FFFC03) | (INT << 3);
	ADRF6655_Reg1 = (ADRF6655_Reg1 & 0x00000003) | (MOD << 3);
	ADRF6655_Reg2 = (ADRF6655_Reg2 & 0x00000003) | (FRAC << 3);
	ADRF6655_Reg4 = (ADRF6655_Reg4 & 0x00E7FFFF) | (RS << 19);		
	ADRF6655_Reg5 =	(ADRF6655_Reg5 & 0x00FFFFDF) | (is_Divide2_mode << 5);
	

	error = ADRF6655_writeData(endeavour, ADRF6655_Reg7);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg6);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg5);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg4);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg3);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg2);
	if (error) goto exit;
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg1);
	if (error) goto exit;
	
	BrUser_delay((Bridge *)endeavour, 2);
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg0);

//for debug
/*
	printf("ADRF6655_Reg7 = 0x%08x\n",ADRF6655_Reg7);
	printf("ADRF6655_Reg6 = 0x%08x\n",ADRF6655_Reg6);
	printf("ADRF6655_Reg5 = 0x%08x\n",ADRF6655_Reg5);
	printf("ADRF6655_Reg4 = 0x%08x\n",ADRF6655_Reg4);
	printf("ADRF6655_Reg3 = 0x%08x\n",ADRF6655_Reg3);
	printf("ADRF6655_Reg2 = 0x%08x\n",ADRF6655_Reg2);
	printf("ADRF6655_Reg1 = 0x%08x\n",ADRF6655_Reg1);
	printf("ADRF6655_Reg0 = 0x%08x\n",ADRF6655_Reg0);
*/

exit:
	return error;
}

Dword ADRF6655_setCpRefSource (
		Endeavour*		endeavour,
		Bool			isExternal
){
	
	Dword error = BR_ERR_NO_ERROR;

	ADRF6655_Reg4 = ADRF6655_Reg4 & 0x00FBFFFF;
	if(isExternal){
		ADRF6655_Reg4 = ADRF6655_Reg4 | 0x00040000;

	}
	error = ADRF6655_writeData(endeavour, ADRF6655_Reg4);
	
	return error;

}


Dword ADRF6655_setPhaseOffseMultiplier (
		Endeavour*		endeavour,
		Byte			multiplier
){
	
	Dword error = 0xFF;
	Dword temp =  multiplier<<12;

	if(multiplier<32){
		ADRF6655_Reg4 = ADRF6655_Reg4 & 0x00FE0FFF;;
		ADRF6655_Reg4 = ADRF6655_Reg4 | (temp);

		error = ADRF6655_writeData(endeavour, ADRF6655_Reg4);	
	}
	return error;

}


Dword ADRF6655_setCpCurrentMultiplier (
		Endeavour*		endeavour,
		Byte			multiplier
){
	
	Dword error = 0xFE;
	Dword temp =  multiplier<<10;

	if(multiplier<4){
		ADRF6655_Reg4 = ADRF6655_Reg4 & 0x00FFF3FF;;
		ADRF6655_Reg4 = ADRF6655_Reg4 | (temp);

		error = ADRF6655_writeData(endeavour, ADRF6655_Reg4);	
	}
	return error;

}

Dword ADRF6655_Set6655SPIdata(
     IN  Endeavour*     endeavour,
     IN  Byte           chip,
     IN  Byte           data0,
     IN  Byte           data1,
     IN  Byte           data2
) {
     Dword   error = BR_ERR_NO_ERROR;

	 //GPIO 9 : DATA	default:low
	 //GPIO 8 : CLK		default:low
	 //GPIO 4 : CS		default:high
	 Byte temp_data = 0;
	 
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh4_o, 0x0);
	if (error) goto exit; 

	temp_data =(Byte) ( (data0>>7)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);	

	temp_data =(Byte) ( (data0>>6)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0>>5)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0>>4)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0>>3)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0>>2)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0>>1)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data0)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);
	//error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);


	///////////////////////////
	temp_data =(Byte) ( (data1>>7)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);	

	temp_data =(Byte) ( (data1>>6)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1>>5)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1>>4)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1>>3)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1>>2)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1>>1)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data1)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);
	//error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	///////////////////////////

	
	temp_data =(Byte) ( (data2>>7)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);	

	temp_data =(Byte) ( (data2>>6)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2>>5)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2>>4)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2>>3)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2>>2)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2>>1)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);

	temp_data =(Byte) ( (data2)&0x1);
	if(temp_data)
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x01);
	else
		error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x01);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh8_o, 0x00);
	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh9_o, 0x00);

	error = IT9300_writeRegister(endeavour, chip, p_br_reg_top_gpioh4_o, 0x1);
	if (error) goto exit; 
	BrUser_delay((Bridge *)endeavour, 1);
	exit:
    return (error);
}
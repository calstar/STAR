#include "user.h"
#include "brUser.h"
#include <linux/delay.h>

/**
 * Variable of critical section
 */

Dword User_memoryCopy (
    IN  Demodulator*    demodulator,
    IN  void*           dest,
    IN  void*           src,
    IN  Dword           count
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  memcpy(dest, src, (size_t)count);
     *  return (0);
     */
    return (Error_NO_ERROR);
}

Dword User_delay (
    IN  Demodulator*    demodulator,
    IN  Dword           dwMs
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  delay(dwMs);
     *  return (0);
     */
    //mdelay(dwMs); // for Linux
    msleep(dwMs);
    return (Error_NO_ERROR);
}


Dword User_enterCriticalSection (
    IN  Demodulator*    demodulator
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  return (0);
     */
    return (Error_NO_ERROR);
}


Dword User_leaveCriticalSection (
    IN  Demodulator*    demodulator
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  return (0);
     */
    return (Error_NO_ERROR);
}


Dword User_mpegConfig (
    IN  Demodulator*    demodulator
) {
    /*
     *  ToDo:  Add code here
     *
     */
    return (Error_NO_ERROR);
}


Dword User_busTx (
    IN  Demodulator*    demodulator,
    IN  Dword           bufferLength,
    IN  Byte*           buffer
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  short i;
     *
     *  start();
     *  write_i2c(uc2WireAddr);
     *  ack();
     *  for (i = 0; i < bufferLength; i++) {
     *      write_i2c(*(ucpBuffer + i));
     *      ack();
     *  }
     *  stop();
     *
     *  // If no error happened return 0, else return error code.
     *  return (0);
     */
    Dword                   error = Error_NO_ERROR;
    Byte        			command;
	Byte					i2cAddr;
    DefaultDemodulator*     pit9133 = (DefaultDemodulator *)demodulator;
    Endeavour*  			pendeavour = (Endeavour *)pit9133->pendeavour;
    Word                    checkSum;

	if (pendeavour->ctrlBus == BUS_USB)
	{
        if(pit9133->tsSrcIdx==4)// support 5st source
		    command = ((pit9133->br_idx + 4)<< 4) + (15);
        else
		    command = ((pit9133->br_idx + 4)<< 4) + (1<<pit9133->tsSrcIdx);
	}
    else
    {
		command = (4 << 4) + (1<<pit9133->tsSrcIdx);
    }
    buffer[1] += command;
    checkSum   = (Word)(buffer[bufferLength-2] << 8) + (Word)(buffer[bufferLength-1]);
    checkSum   = ~checkSum;
    checkSum  += (command << 8);
    checkSum   = ~checkSum;
    buffer[bufferLength - 2] = (Byte) ((checkSum & 0xFF00) >> 8);
    buffer[bufferLength - 1] = (Byte) ((checkSum & 0x00FF));

    i2cAddr = pendeavour->gator[pit9133->br_idx].i2cAddr;

    error = BrUser_busTx((Bridge *)pendeavour, i2cAddr, bufferLength, buffer);
    return (error);
}


Dword User_busRx (
    IN  Demodulator*    demodulator,
    IN  Dword           bufferLength,
    OUT Byte*           buffer
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  short i;
     *
     *  start();
     *  write_i2c(uc2WireAddr | 0x01);
     *  ack();
     *  for (i = 0; i < bufferLength - 1; i++) {
     *      read_i2c(*(ucpBuffer + i));
     *      ack();
     *  }
     *  read_i2c(*(ucpBuffer + bufferLength - 1));
     *  nack();
     *  stop();
     *
     *  // If no error happened return 0, else return error code.
     *  return (0);
     */
    Dword               error = Error_NO_ERROR;
    Byte				i2cAddr;
    DefaultDemodulator* pit9133    = (DefaultDemodulator *)demodulator;
    Endeavour*  		pendeavour = (Endeavour *)pit9133->pendeavour;
    i2cAddr = pendeavour->gator[pit9133->br_idx].i2cAddr;
    error = BrUser_busRx((Bridge *)pendeavour, i2cAddr, bufferLength, buffer);
    return (error);
}


Dword User_busRxData (
    IN  Demodulator*    demodulator,
    IN  Dword           bufferLength,
    OUT Byte*           buffer
) {
    return (Error_NO_ERROR);
}

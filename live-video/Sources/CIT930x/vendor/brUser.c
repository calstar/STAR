#include "brUser.h"
#include "usb2impl.h"
#include <linux/delay.h>
#include <linux/time.h>
#include <linux/slab.h>

/**
 * Variable of critical section
 */

Dword BrUser_delay (
    IN  Bridge*         bridge,
    IN  Dword           dwMs
) {
    /*
        *  ToDo:  Add code here
        *
        *  //Pseudo code
        *  delay(dwMs);
        *  return (0);
        */
     
    msleep(dwMs);
    return (BR_ERR_NO_ERROR);
}

Dword BrUser_createCriticalSection (
    void
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  return (0);
     */  
   
    return (BR_ERR_NO_ERROR);
}

Dword BrUser_deleteCriticalSection (
    void
) {
    /*
     *  ToDo:  Add code here
     *
     *  //Pseudo code
     *  return (0);
     */    
    return (BR_ERR_NO_ERROR);
}

Dword BrUser_enterCriticalSection (
    IN  Bridge*         bridge
) {
    /*
        *  ToDo:  Add code here
        *
        *  //Pseudo code
        *  return (0);
        */
      
    return (BR_ERR_NO_ERROR);
}


Dword BrUser_leaveCriticalSection (
    IN  Bridge*         bridge
) {
    /*
        *  ToDo:  Add code here
        *
        *  //Pseudo code
        *  return (0);
        */
      
    return (BR_ERR_NO_ERROR);
}

Dword BrUser_busTx (
    IN  Bridge*         bridge,
    IN  Byte			i2cAddr,
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
    Dword                   error = BR_ERR_NO_ERROR;        
    Endeavour* pendeavour = (Endeavour *)bridge;
	Dword       i;
    //if (pendeavour->ctrlBus == BUS_I2C)
    //    error = I2c_writeControlBus(bridge, i2cAddr, bufferLength, buffer);
    //else if (pendeavour->ctrlBus == BUS_USB)
		 for (i = 0; i < IT9300User_RETRY_USB_MAX_LIMIT; i++) 
		 {
			error = Usb2_writeControlBus(bridge, bufferLength, buffer);
			if (error == 0) return error;
			BrUser_delay (bridge, 1);
		}
    
    return (error);
}


Dword BrUser_busRx (
    IN  Bridge*         bridge,
    IN  Byte			i2cAddr,
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
    Dword                   error = BR_ERR_NO_ERROR;        
    Endeavour* pendeavour = (Endeavour *)bridge;
	Dword       i;
    //if (pendeavour->ctrlBus == BUS_I2C)
    //    error = I2c_readControlBus(bridge, i2cAddr, bufferLength, buffer);
    //else if (pendeavour->ctrlBus == BUS_USB)
    //    error = Usb2_readControlBus(bridge, bufferLength, buffer);

		 for (i = 0; i < IT9300User_RETRY_USB_MAX_LIMIT; i++) 
		 {
			error = Usb2_readControlBus(bridge, bufferLength, buffer);
			if (error == 0) return error;
			BrUser_delay (bridge, 1);
		}
    return (error);
}

Dword GetTickCount(void)
{
#if 0
    struct timeval currTick;
    Dword ulRet;

    do_gettimeofday(&currTick);
    ulRet = currTick.tv_sec;
    ulRet *= 1000;
    ulRet += (currTick.tv_usec + 500) / 1000;

    // JackyIT930xDriverDebug("(Jacky)(GetTickCount) GetTickCount = %ld \n", ulRet);

    return ulRet;
#endif
#if 1
	static struct timeval curr_time;
	Dword ulRet;
	do_gettimeofday(&curr_time);
	ulRet = curr_time.tv_sec*1000 + curr_time.tv_usec/1000;

	// JackyIT930xDriverDebug("(Jacky)(GetTickCount) GetTickCount = %ld \n", ulRet);

	return ulRet;
#endif
}

Dword BrUser_time (
	OUT Dword*			time
) {
	*time = GetTickCount();
	return (BR_ERR_NO_ERROR);
}

#if 0
Dword BrUser_busRxData (
    IN  Bridge*         bridge,
    IN  Dword           bufferLength,
    OUT Byte*           buffer
) {
    return (BR_ERR_NO_ERROR);
}
#endif


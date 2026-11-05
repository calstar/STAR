#ifndef __USB2IMPL_H__
#define __USB2IMPL_H__

#ifndef UNDER_CE
#endif

#define _GNU_SOURCE

#include "brType.h"
//#include "brError.h"
//#include "brUser.h"
//#include "iocontrol.h"

Dword Usb2_getDriver (
	IN  Bridge*	bridge,
	OUT Handle*			handle
);


Dword Usb2_exitDriver (
    IN  Bridge*    bridge
);


Dword Usb2_writeControlBus (
	IN  Bridge*	bridge,
	IN  Dword			bufferLength,
	IN  Byte*			buffer
);


Dword Usb2_readControlBus (
	IN  Bridge*	bridge,
	IN  Dword			bufferLength,
	OUT Byte*			buffer
);


Dword Usb2_readDataBus (
	IN  Bridge*	bridge,
	IN  Dword			bufferLength,
	OUT Byte*			buffer
);

#endif


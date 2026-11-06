#ifndef __ADRF6755_H_
#define __ADRF6755_H_

#include "IT9300.h"

Dword ADRF6655_init (Endeavour*    endeavour);
Dword ADRF6655_writeData (
		Endeavour*  endeavour,
		Dword		data	
);

Dword ADRF6655_setLoFrequency (
		Endeavour*  endeavour,
		Dword		freq_KHz	//KHz
);

Dword ADRF6655_setCpRefSource (
		Endeavour*	endeavour,
		Bool		isExternal
);

Dword ADRF6655_setPhaseOffseMultiplier (
		Endeavour*	endeavour,
		Byte		multiplier
);

Dword ADRF6655_setCpCurrentMultiplier (
		Endeavour*	endeavour,
		Byte		multiplier
);


#endif
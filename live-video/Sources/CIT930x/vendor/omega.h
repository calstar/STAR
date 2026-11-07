#ifndef _OMEGA_H_
#define _OMEGA_H_

#define OMEGA_IQIK_M_CAL_MAX	64
#define OMEGA_IQIK_M_CAL_MID	32
#define OMEGA_TUNER_INIT_POLL_INTERVAL	2
#define OMEGA_TUNER_INIT_POLL_COUNTS	50

#define __OMAGADEMOD_H__
#include "standard.h"
/*----- for patch to wait for tuner init done -----*/
#include "error.h"
#include "user.h"

typedef enum
{
	OMEGA_GAIN,		/*return OMEGA_LNA_GAIN, OMEGA_PGC_GAIN, OMEGA_PGA1_GAIN, and OMEGA_PGA2_GAIN*/
	OMEGA_LNA_GAIN,
	OMEGA_PGC_GAIN,
	OMEGA_PGA1_GAIN,
	OMEGA_PGA2_GAIN,
	OMEGA_RF_BACKOFF,
	OMEGA_BB_BACKOFF,
	OMEGA_DCC,		/*return OMEGA_DCC_I and OMEGA_DCC_Q*/
	OMEGA_DCC_I,
	OMEGA_DCC_Q,
	OMEGA_RF_GMAX,
	OMEGA_TOTAL_GMAX,
	OMEGA_P_INBAND_SHIFT,
	OMEGA_P_ALL,	/*return OMEGA_P_RSSI, OMEGA_P_TOTAL, and OMEGA_P_INBAND*/
} OMEGA_Param;

//extern Demodulator* Afatech_OMEGA_demodulator;

unsigned long omega_init(IN  Demodulator* demodulator);
unsigned long omega_setfreq(Demodulator*	demodulator,unsigned int bw_kHz, unsigned int rf_freq_kHz);
unsigned long omega_rmr(Demodulator*	demodulator,unsigned long mem_addr, unsigned char len, unsigned char *buf);
unsigned long omega_wmr(Demodulator*	demodulator,unsigned long mem_addr, unsigned char len, unsigned char *val);

unsigned int omega_get_cal_freq_iqik(Demodulator*	demodulator,unsigned int rf_freq_kHz, unsigned char iqik_m_cal);
unsigned int omega_get_freq_code(Demodulator*	demodulator,unsigned int rf_freq_kHz, unsigned int *nc, unsigned int *nv, unsigned int *mv);
unsigned int omega_get_nc(Demodulator*	demodulator,unsigned int rf_freq_kHz);
unsigned int omega_get_nv(unsigned int nc);
unsigned char omega_get_lna_cap_sel(unsigned int rf_freq_kHz);
unsigned int omega_get_lo_freq(Demodulator*	 demodulator,unsigned int rf_freq_kHz);
unsigned char omega_get_lpf_bw(unsigned int bw_kHz);

unsigned long omega_get_param(OMEGA_Param param, int *buf);
unsigned long omega_set_param(OMEGA_Param param, int *val);

#endif

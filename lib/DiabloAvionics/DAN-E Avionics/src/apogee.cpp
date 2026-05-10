#include "apogee.h"

#include "config.h"

namespace {

float s_alt[ALT_BUF_N];
unsigned s_pos = 0;
unsigned s_writes = 0;
unsigned s_confirm = 0;

} // namespace

void apogeeReset() {
	s_pos = 0;
	s_writes = 0;
	s_confirm = 0;
}

void apogeePushAltitude(float alt_m) {
	s_alt[s_pos] = alt_m;
	s_pos = (s_pos + 1U) % ALT_BUF_N;
	s_writes++;
	if (s_writes < ALT_BUF_N)
		return;

	float older = 0.f;
	float recent = 0.f;
	for (unsigned i = 0; i < ALT_BUF_N / 2U; i++)
		older += s_alt[(s_pos + i) % ALT_BUF_N];
	for (unsigned i = 0; i < ALT_BUF_N / 2U; i++)
		recent += s_alt[(s_pos + ALT_BUF_N / 2U + i) % ALT_BUF_N];
	older /= static_cast<float>(ALT_BUF_N / 2U);
	recent /= static_cast<float>(ALT_BUF_N / 2U);
	const float trend = recent - older;

	if (trend < -ALT_TREND_THRESHOLD_M)
		s_confirm++;
	else
		s_confirm = 0;
}

bool apogeeShouldConfirm() {
	return s_confirm >= ALT_TREND_CONFIRM_COUNT;
}

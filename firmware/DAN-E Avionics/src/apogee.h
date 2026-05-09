#pragma once

#include <Arduino.h>

void apogeeReset();
void apogeePushAltitude(float alt_m);
bool apogeeShouldConfirm();

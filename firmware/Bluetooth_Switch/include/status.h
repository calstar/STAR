#pragma once

// The status packet is defined once, in the shared DAQ protocol library, so the
// environmental board's relay and the DAQ bridge read the same bytes this
// firmware writes. This header only brings the names into the switch's scope.
#include "../../../lib/daq-protocol/src/SwitchStatus.h"

using daq::bt_switch::Sense;
using daq::bt_switch::StatusFlags;
using daq::bt_switch::FLAG_INA_OK;
using daq::bt_switch::FLAG_READING_VALID;
using daq::bt_switch::FLAG_RESTORED;
using daq::bt_switch::FLAG_NO_BATTERY;
using daq::bt_switch::STATUS_VERSION;
using daq::bt_switch::StatusPacket;

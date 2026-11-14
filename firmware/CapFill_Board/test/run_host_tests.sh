#!/usr/bin/env bash
# Host-side tests for CapFill firmware (no board needed). Linux/macOS with gcc, g++, python3, git.
#   1. Packet bytes vs. the club's DAQv2-Comms library (compiled from source)
#   2. Real daq_link.c vs. a fake DAQ server that decodes with the club GUI's parser
#   3. Real fdc1004.c vs. a simulated FDC1004
#   4. Real ota.c vs. the club's ota_upload.py, sending build/capfill-fw.bin (if built)
set -e
cd "$(dirname "$0")"
FW=../main
H=host
mkdir -p $H/out
export REF=${REF:-$PWD/.ref}
if [ ! -d "$REF/DAQv2-Comms" ]; then
  mkdir -p "$REF"
  git clone -q --depth 1 https://github.com/calstar/DAQv2-Comms.git "$REF/DAQv2-Comms"
  git clone -q --depth 1 https://github.com/calstar/DiabloAvionics.git "$REF/DiabloAvionics"
fi
CFLAGS="-std=gnu11 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function"

echo "== 1. Packet compatibility with DAQv2-Comms"
gcc -c -I$FW $FW/diablo_proto.c -o $H/out/proto.o
g++ -std=gnu++17 -I "$REF/DAQv2-Comms/src" -I$FW $H/packet_compat.cpp "$REF/DAQv2-Comms/src/DiabloPacketUtils.cpp" $H/out/proto.o -o $H/out/packet_compat
(cd $H/out && ./packet_compat)

echo; echo "== 2. DAQ link vs fake server (uses 127.0.2.x loopback addresses)"
gcc $CFLAGS -I $H/stubs -I $FW $H/harness.c $FW/daq_link.c $FW/diablo_proto.c -lpthread -o $H/out/daq_host
python3 $H/fake_server.py

echo; echo "== 3. FDC1004 driver vs simulated chip"
gcc $CFLAGS -I $H/stubs2 -I $FW $H/fdc_test.c $H/fdc_sim.c $FW/fdc1004.c -lm -o $H/out/fdc_test
$H/out/fdc_test

if [ -f ../build/capfill-fw.bin ]; then
  echo; echo "== 4. OTA with the club's ota_upload.py"
  gcc $CFLAGS -I $H/stubs3 -I $FW $H/ota_harness.c $FW/ota.c -lpthread -o $H/out/ota_host
  rm -f $H/out/ota_received.bin
  (cd $H/out && ./ota_host 2>ota.log) & sleep 0.5
  python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('ota', '$REF/DiabloAvionics/Ethernet OTA Testing/ota_upload.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.upload_firmware('../build/capfill-fw.bin', '127.0.0.1', 3232)" | tail -1
  sleep 0.5
  cmp $H/out/ota_received.bin ../build/capfill-fw.bin && echo "  [PASS] received image identical to build/capfill-fw.bin"
fi

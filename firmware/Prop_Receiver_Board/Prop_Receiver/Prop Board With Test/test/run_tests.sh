#!/bin/sh
# Runs every hardware-free test. Usage:  ./run_tests.sh
# Against a real board afterwards:      BOARD_IP=<ip> python3 test_protocol.py -v
set -e
cd "$(dirname "$0")"
make test

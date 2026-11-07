#!/bin/bash
# The flight computer's gate (build, unit suites, end-to-end pipeline,
# canary; --board adds the hardware checks). Same as running
# firmware/Flight_Computer/flight_test from that folder.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/firmware/Flight_Computer/flight_test" "$@"

# Host-side tests. Needs only gcc + make + python3. No ESP-IDF, no hardware.
CC      ?= gcc
CFLAGS  ?= -std=c11 -Wall -Wextra -Wno-unused-function -g -O0 -fsanitize=address,undefined -I../main
BUILD   ?= build

all: test

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/test_core: host/test_core.c ../main/prop_core.c ../main/prop_core.h ../main/pins.h | $(BUILD)
	$(CC) $(CFLAGS) host/test_core.c ../main/prop_core.c -o $@ -lm

$(BUILD)/test_pins: host/test_pins.c ../main/pins.h | $(BUILD)
	$(CC) $(CFLAGS) host/test_pins.c -o $@

$(BUILD)/sim_udp: host/sim_udp.c ../main/prop_core.c ../main/prop_core.h ../main/pins.h | $(BUILD)
	$(CC) $(CFLAGS) host/sim_udp.c ../main/prop_core.c -o $@ -lm

test: $(BUILD)/test_core $(BUILD)/test_pins $(BUILD)/sim_udp
	$(BUILD)/test_core
	$(BUILD)/test_pins
	PROP_BUILD=$(BUILD) python3 test_protocol.py -v

clean:
	rm -rf $(BUILD)

.PHONY: all test clean

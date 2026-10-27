CC ?= gcc
CFLAGS ?= -Wall -Wextra -Wpedantic -O2 -Iinclude -std=c99
LDFLAGS ?= -lm

SRC = src/ism330dhcx.c
OBJ = $(SRC:.c=.o)
DEMO_SRC = examples/main_avionics_firmware.c
DEMO_BIN = bin/avionics_imu_demo

.PHONY: all clean run

all: $(DEMO_BIN)

$(DEMO_BIN): $(DEMO_SRC) $(SRC)
	@mkdir -p bin
	$(CC) $(CFLAGS) $(DEMO_SRC) $(SRC) -o $@ $(LDFLAGS)

run: $(DEMO_BIN)
	@./$(DEMO_BIN)

clean:
	rm -rf bin *.o src/*.o

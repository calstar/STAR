#include "rs485_link.h"

#include <driver/gpio.h>

Rs485Link::Rs485Link(int uart_num, int tx_pin, int rx_pin, int de_pin,
                     int re_n_pin)
    : serial_(uart_num),
      tx_pin_(tx_pin),
      rx_pin_(rx_pin),
      de_pin_(de_pin),
      re_n_pin_(re_n_pin) {
}

void Rs485Link::beginPinsSafe() {
    // Set the level before switching to output so the pin never glitches
    // HIGH. Until this runs (power-up, reset, flashing) DE is floating; the
    // schematic review recommends a 10 k pull-down on DRIVER_EN for that.
    digitalWrite(de_pin_, LOW);
    pinMode(de_pin_, OUTPUT);
    digitalWrite(re_n_pin_, LOW);
    pinMode(re_n_pin_, OUTPUT);
}

void Rs485Link::begin(uint32_t baud) {
    beginPinsSafe();
    serial_.begin(baud, SERIAL_8N1, rx_pin_, tx_pin_);
    // While we transmit, /RE is HIGH and the MAX3485's RO pin floats. The
    // internal pull-up holds RX at idle (HIGH) so the UART doesn't read noise.
    gpio_pullup_en(static_cast<gpio_num_t>(rx_pin_));
    listenMode();
}

void Rs485Link::listenMode() {
    digitalWrite(de_pin_, LOW);    // driver off: release the bus
    digitalWrite(re_n_pin_, LOW);  // receiver on (active low)
}

void Rs485Link::transmitMode() {
    digitalWrite(re_n_pin_, HIGH);  // receiver off: don't hear our own echo
    digitalWrite(de_pin_, HIGH);    // driver on: take the bus
    // The MAX3485's driver is ready within ~90 ns (datasheet tPZH/tPZL max),
    // so no extra delay is needed before the start bit.
}

void Rs485Link::send(const uint8_t* data, size_t len) {
    transmitMode();
    serial_.write(data, len);
    // flush() returns only after the UART's shift register is empty, i.e.
    // the stop bit of the last byte is on the wire.
    serial_.flush();
    listenMode();
    frames_sent_++;
}

bool Rs485Link::poll() {
    while (serial_.available() > 0) {
        if (parser_.feed(static_cast<uint8_t>(serial_.read())))
            return true;  // leave the rest for the next call
    }
    return false;
}

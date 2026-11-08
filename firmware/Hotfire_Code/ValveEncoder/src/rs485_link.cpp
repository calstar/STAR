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
    // Level before direction so DE never glitches HIGH. Before this runs
    // (reset, ROM boot log, flashing) DE floats: rev A needs a pull-down.
    digitalWrite(de_pin_, LOW);
    pinMode(de_pin_, OUTPUT);
    digitalWrite(re_n_pin_, LOW);
    pinMode(re_n_pin_, OUTPUT);
}

void Rs485Link::begin(uint32_t baud) {
    beginPinsSafe();
    serial_.begin(baud, SERIAL_8N1, rx_pin_, tx_pin_);
    // RO floats while /RE is HIGH; hold RX idle so the UART doesn't read noise.
    gpio_pullup_en(static_cast<gpio_num_t>(rx_pin_));
    listenMode();
}

void Rs485Link::listenMode() {
    digitalWrite(de_pin_, LOW);
    digitalWrite(re_n_pin_, LOW);
}

void Rs485Link::transmitMode() {
    digitalWrite(re_n_pin_, HIGH);
    digitalWrite(de_pin_, HIGH);
}

void Rs485Link::send(const uint8_t* data, size_t len) {
    transmitMode();
    serial_.write(data, len);
    // Waits for the shift register, not just the FIFO: dropping DE early
    // cuts off the end of the frame.
    serial_.flush();
    listenMode();
    frames_sent_++;
}

bool Rs485Link::poll() {
    while (serial_.available() > 0) {
        if (parser_.feed(static_cast<uint8_t>(serial_.read())))
            return true;
    }
    return false;
}

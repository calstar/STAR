#include "board_uart9.h"

#include "main.h"

extern UART_HandleTypeDef huart9;

/* Single producer (the UART ISR) / single consumer (the GNSS task) ring.
 * 1 KB = ~89 ms at 115200 baud; the task drains it every NAV-PVT. */
#define RING_SIZE 1024U
static uint8_t ring[RING_SIZE];
static volatile uint32_t head, tail; /* free-running; head: ISR, tail: task */
static uint8_t chunk[64];            /* HAL receive buffer */
static volatile uint32_t overflows, errors;
static osThreadId_t volatile owner;
static uint32_t owner_flag;

static void arm(void) {
    if (HAL_UARTEx_ReceiveToIdle_IT(&huart9, chunk, sizeof(chunk)) != HAL_OK) {
        errors = errors + 1U;
    }
}

bool board_uart9_apply_baud(uint32_t baud) {
    huart9.Init.BaudRate = baud;
    /* HAL_UART_Init rewrites CR1 and clears FIFOEN, but leaves the handle's
     * FifoMode at "enabled". Receive then waits for the RX FIFO threshold
     * interrupt, which can't fire with the FIFO off: bytes overrun the
     * single data register and only the one waiting at line idle arrives.
     * So re-apply MX_UART9_Init's FIFO setup (keep in step with the .ioc). */
    return HAL_UART_Init(&huart9) == HAL_OK &&
           HAL_UARTEx_SetTxFifoThreshold(&huart9, UART_TXFIFO_THRESHOLD_1_8) ==
               HAL_OK &&
           HAL_UARTEx_SetRxFifoThreshold(&huart9, UART_RXFIFO_THRESHOLD_1_2) ==
               HAL_OK &&
           HAL_UARTEx_EnableFifoMode(&huart9) == HAL_OK;
}

bool board_uart9_start(osThreadId_t thread, uint32_t flag) {
    owner_flag = flag;
    owner = thread;
    arm();
    return true;
}

size_t board_uart9_read(uint8_t* out, size_t cap) {
    size_t n = 0;
    uint32_t h = head;
    while (tail != h && n < cap) {
        out[n++] = ring[tail % RING_SIZE];
        tail = tail + 1U;
    }
    return n;
}

void board_uart9_send(const uint8_t* bytes, uint16_t len) {
    (void)HAL_UART_Transmit(&huart9, (uint8_t*)bytes, len, 100);
}

void board_uart9_set_baud(uint32_t baud) {
    (void)HAL_UART_AbortReceive_IT(&huart9);
    if (!board_uart9_apply_baud(baud)) {
        errors = errors + 1U;
    }
    arm();
}

uint32_t board_uart9_rx_bytes(void) {
    return head;
}
uint32_t board_uart9_overflows(void) {
    return overflows;
}
uint32_t board_uart9_errors(void) {
    return errors;
}

/* HAL weak override: a burst ended (line idle) or the chunk filled. */
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef* huart, uint16_t size) {
    if (huart != &huart9) {
        return;
    }
    for (uint16_t i = 0; i < size; ++i) {
        if (head - tail >= RING_SIZE) {
            overflows = overflows + 1U;
            continue;
        }
        ring[head % RING_SIZE] = chunk[i];
        head = head + 1U;
    }
    arm(); /* the UART FIFO holds bytes arriving meanwhile */
    osThreadId_t t = owner;
    if (t) {
        (void)osThreadFlagsSet(t, owner_flag);
    }
}

/* HAL weak override: overrun/framing/noise (e.g. during a baud change). */
void HAL_UART_ErrorCallback(UART_HandleTypeDef* huart) {
    if (huart == &huart9) {
        errors = errors + 1U;
        /* An overrun ends the reception (HAL aborts it): start again. A
         * framing/noise/parity error keeps it running, so re-arming then
         * would only fail as busy. */
        if (huart->RxState == HAL_UART_STATE_READY) {
            arm();
        }
    }
}

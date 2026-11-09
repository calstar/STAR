#include "ground_task.h"

#include "radio_task.h"
#include "usb_link.h"

bool ground_start(void) {
    bool ok = radio_task_start();
    radio_task_on_frame(usb_link_radio_rx);
    radio_task_start_continuous_rx();
    return ok;
}

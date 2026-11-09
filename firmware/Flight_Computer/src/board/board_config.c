#include "board_config.h"

#include <string.h>

#include "FreeRTOS.h"
#include "main.h"
#include "task.h"

#define SECTOR_ADDR 0x08060000UL
#define SECTOR_SIZE (128UL * 1024UL)
#define SECTOR_NUM FLASH_SECTOR_3

static fc_config_t active, saved;
static bool have_saved, from_defaults, storage_ok;
static uint32_t sequence;
static size_t next_slot;

/* Reading a flash word whose write was torn by a power cut can be a double
 * ECC error, which faults the read (RM0468 4.7). Read each slot with bus
 * faults ignored (BFHFNMIGN under FAULTMASK) and skip one that faulted,
 * instead of crashing at every boot. */
static bool slot_ok(size_t slot) {
    const volatile uint32_t* p =
        (const volatile uint32_t*)(SECTOR_ADDR + slot * FC_CONFIG_RECORD);
    uint32_t ccr = SCB->CCR;
    __disable_fault_irq();
    SCB->CCR = ccr | SCB_CCR_BFHFNMIGN_Msk;
    SCB->CFSR = SCB_CFSR_BUSFAULTSR_Msk; /* write 1 to clear */
    __DSB();
    __ISB();
    for (size_t i = 0; i < FC_CONFIG_RECORD / 4U; ++i) {
        (void)p[i];
    }
    __DSB();
    bool ok = (SCB->CFSR & SCB_CFSR_BUSFAULTSR_Msk) == 0U;
    SCB->CFSR = SCB_CFSR_BUSFAULTSR_Msk;
    SCB->CCR = ccr;
    __DSB();
    __ISB();
    __enable_fault_irq();
    FLASH->CCR1 = FLASH_CCR_CLR_SNECCERR | FLASH_CCR_CLR_DBECCERR;
    return ok;
}

static void scan(void) {
    have_saved = fc_config_find((const uint8_t*)SECTOR_ADDR, SECTOR_SIZE,
                                slot_ok, &saved, &sequence, &next_slot);
}

void board_config_init(void) {
    /* Never touch the sector if the program image reached it (the gate
     * keeps flash under 50 %, so it does not today). */
    extern uint32_t _sidata, _sdata, _edata;
    uintptr_t image_end =
        (uintptr_t)&_sidata + ((uintptr_t)&_edata - (uintptr_t)&_sdata);
    storage_ok = image_end <= SECTOR_ADDR;
    if (storage_ok) {
        scan();
    }
    from_defaults = !have_saved;
    active = have_saved ? saved : fc_config_defaults();
}

fc_config_t board_config_get(void) {
    taskENTER_CRITICAL();
    fc_config_t c = active;
    taskEXIT_CRITICAL();
    return c;
}

bool board_config_saved(fc_config_t* out) {
    if (have_saved) {
        *out = saved;
    }
    return have_saved;
}

bool board_config_unsaved(void) {
    fc_config_t c = board_config_get();
    return !have_saved || !fc_config_equal(&c, &saved);
}

bool board_config_from_defaults(void) {
    return from_defaults;
}

void board_config_set(const fc_config_t* c) {
    taskENTER_CRITICAL();
    active = *c;
    taskEXIT_CRITICAL();
}

static bool program(uint32_t addr, const uint8_t* rec) {
    /* Two 32-byte flash words; the source must be 4-byte aligned. */
    static uint32_t words[FC_CONFIG_RECORD / 4U];
    memcpy(words, rec, FC_CONFIG_RECORD);
    bool ok = true;
    for (uint32_t i = 0; ok && i < FC_CONFIG_RECORD; i += 32U) {
        ok = HAL_FLASH_Program(FLASH_TYPEPROGRAM_FLASHWORD, addr + i,
                               (uint32_t)&words[i / 4U]) == HAL_OK;
    }
    return ok;
}

bool board_config_save(bool erase_ok) {
    size_t slots = SECTOR_SIZE / FC_CONFIG_RECORD;
    if (!storage_ok || (next_slot >= slots && !erase_ok)) {
        return false;
    }
    uint8_t rec[FC_CONFIG_RECORD];
    fc_config_t c = board_config_get();
    fc_config_record(&c, sequence + 1U, rec);
    bool ok = HAL_FLASH_Unlock() == HAL_OK;
    if (ok && next_slot >= slots) { /* full: erase, then write this first */
        FLASH_EraseInitTypeDef e = {
            .TypeErase = FLASH_TYPEERASE_SECTORS,
            .Banks = FLASH_BANK_1,
            .Sector = SECTOR_NUM,
            .NbSectors = 1,
            .VoltageRange = FLASH_VOLTAGE_RANGE_3,
        };
        uint32_t bad = 0;
        ok = HAL_FLASHEx_Erase(&e, &bad) == HAL_OK;
        next_slot = 0;
    }
    if (ok) {
        ok = program(SECTOR_ADDR + next_slot * FC_CONFIG_RECORD, rec);
    }
    (void)HAL_FLASH_Lock();
    scan(); /* read back: saved is what flash now holds */
    return ok && have_saved && fc_config_equal(&saved, &c);
}

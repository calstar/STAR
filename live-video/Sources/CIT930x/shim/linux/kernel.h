// Minimal stand-ins for the Linux kernel APIs used by the ITE vendor code.
#ifndef SHIM_LINUX_KERNEL_H
#define SHIM_LINUX_KERNEL_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#define printk(...) ((void)0)
#define KERN_ERR ""
#define KERN_INFO ""
#define KERN_DEBUG ""
#define GFP_KERNEL 0
#define kmalloc(size, flags) malloc(size)
#define kfree(ptr) free(ptr)
#define msleep(ms) usleep((useconds_t)(ms) * 1000)
#define mdelay(ms) usleep((useconds_t)(ms) * 1000)
#define udelay(us) usleep((useconds_t)(us))
#endif

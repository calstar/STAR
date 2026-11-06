#include <linux/kernel.h>
#include <sys/time.h>
#define do_gettimeofday(tv) gettimeofday((tv), NULL)

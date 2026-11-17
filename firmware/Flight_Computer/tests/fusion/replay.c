#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "fusion.h"

int main(int argc, char** argv) {
    if (argc != 5 && argc != 8) {
        fprintf(stderr,
                "usage: fusion_replay INPUT OUTPUT ACCEL_FS_G GYRO_FS_DPS "
                "[AXIS_X AXIS_Y AXIS_Z]\n");
        return 2;
    }
    long values[5] = {0};
    for (int i = 3; i < argc; ++i) {
        char* end;
        errno = 0;
        values[i - 3] = strtol(argv[i], &end, 10);
        if (errno || end == argv[i] || *end) {
            fprintf(stderr, "invalid integer argument\n");
            return 2;
        }
    }
    long accel = values[0], gyro = values[1];
    if ((accel != 2 && accel != 4 && accel != 8 && accel != 16) ||
        (gyro != 125 && gyro != 250 && gyro != 500 && gyro != 1000 &&
         gyro != 2000 && gyro != 4000)) {
        fprintf(stderr, "unsupported sensor range\n");
        return 2;
    }
    fusion_t f;
    fusion_init(&f, (uint8_t)accel, (uint16_t)gyro);
    int8_t axes[3] = {0};
    for (int i = 0; i < 3; ++i) {
        if (values[i + 2] < -3 || values[i + 2] > 3) {
            fprintf(stderr, "axis must be +/-1, +/-2 or +/-3\n");
            return 2;
        }
        axes[i] = (int8_t)values[i + 2];
    }
    bool aligned = fusion_set_highg_axes(&f, axes);
    if (argc == 8 && !aligned) {
        fprintf(stderr, "axes must be a signed permutation of 1, 2, 3\n");
        return 2;
    }
    fprintf(stderr, "high-g mapping: %d %d %d (%s)\n", axes[0], axes[1],
            axes[2], aligned ? "enabled" : "disabled: unverified mounting");
    FILE* in = fopen(argv[1], "rb");
    FILE* out = fopen(argv[2], "wb");
    if (!in || !out) {
        perror("open replay");
        if (in)
            fclose(in);
        if (out)
            fclose(out);
        return 2;
    }
    uint8_t header[2], data[255];
    rec_fusion_t r;
    unsigned records = 0, outputs = 0;
    int status = 0;
    clock_t begin = clock();
    for (;;) {
        size_t n = fread(header, 1, 2, in);
        if (n == 0 && feof(in))
            break;
        if (n != 2 || fread(data, 1, header[1], in) != header[1]) {
            fprintf(stderr, "truncated input\n");
            status = 1;
            break;
        }
        ++records;
        if (fusion_feed(&f, header[0], data, header[1], &r)) {
            if (fwrite(&r, sizeof r, 1, out) != 1) {
                status = 1;
                break;
            }
            ++outputs;
        }
    }
    double seconds = (double)(clock() - begin) / CLOCKS_PER_SEC;
    fprintf(stderr,
            "%u inputs, %u outputs; state %zu bytes; %.3f s host CPU (includes "
            "file I/O)\n",
            records, outputs, sizeof f, seconds);
    if (ferror(in) || ferror(out))
        status = 1;
    fclose(in);
    if (fclose(out) != 0)
        status = 1;
    return status;
}

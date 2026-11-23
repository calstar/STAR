#pragma once
// Host stand-in for lwIP sockets. TEST ONLY: reroutes 192.168.2.N -> 127.0.2.N (loopback)
// so the unmodified firmware can talk to a local fake server.
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
static inline ssize_t test_sendto(int fd, const void *b, size_t n, int fl, const struct sockaddr *a, socklen_t l)
{
    struct sockaddr_in d; memcpy(&d, a, sizeof d);
    uint8_t *o = (uint8_t *)&d.sin_addr.s_addr;
    if (o[0] == 192 && o[1] == 168 && o[2] == 2) { o[0] = 127; o[1] = 0; o[2] = 2; }
    return sendto(fd, b, n, fl, (struct sockaddr *)&d, l);
}
#define sendto test_sendto

#include "net/TcpCommandServer.hpp"

#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <functional>
#include <iostream>
#include <memory>
#include <thread>
#include <vector>

namespace fsw::net {

void serveTcpClients(int listen_fd, const std::atomic<bool>& running, const TcpServeOptions& opts,
                     const std::function<void(int)>& on_client) {
    // Connections are tracked rather than detached, so every thread is joined before `svc` — a
    // stack object these threads hold a reference to — goes out of scope at the end of main().
    struct Conn {
        std::thread th;
        int fd{-1};
        std::atomic<bool> done{false};
    };
    std::vector<std::unique_ptr<Conn>> conns;

    auto reap_finished = [&conns]() {
        for (auto it = conns.begin(); it != conns.end();) {
            if ((*it)->done.load()) {
                if ((*it)->th.joinable())
                    (*it)->th.join();
                it = conns.erase(it);
            } else {
                ++it;
            }
        }
    };

    while (running) {
        reap_finished();

        // select() with 10 ms timeout — keeps g_running check while staying low-latency
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(listen_fd, &rd);
        struct timeval tv{.tv_sec = 0, .tv_usec = 10000};
        if (select(listen_fd + 1, &rd, nullptr, nullptr, &tv) <= 0)
            continue;

        int client_fd = accept(listen_fd, nullptr, nullptr);
        if (client_fd < 0)
            continue;

        // Reap again before testing the cap: a burst of short-lived connections arriving inside
        // one select() iteration would otherwise be counted against the limit even though those
        // threads have already finished.
        reap_finished();
        if (conns.size() >= opts.max_clients) {
            // Say why, rather than closing cold — a bare close() reaches the client as a TCP
            // reset, which is indistinguishable from the service having crashed.
            static const char kBusy[] = "ERR:too many connections\n";
            send(client_fd, kBusy, sizeof(kBusy) - 1, MSG_NOSIGNAL);
            std::cerr << opts.busy_log_prefix << "client limit (" << opts.max_clients
                      << ") reached — refusing connection" << std::endl;
            close(client_fd);
            continue;
        }

        auto conn = std::make_unique<Conn>();
        conn->fd = client_fd;
        Conn* raw = conn.get();
        conn->th = std::thread([raw, &on_client]() {
            on_client(raw->fd);
            raw->done = true;
        });
        conns.push_back(std::move(conn));
    }

    // Wake any thread parked in recv() so shutdown does not wait out its 5 s timeout, then join
    // them all. Joining before returning is what keeps `svc` alive until nothing references it.
    for (const auto& c : conns)
        shutdown(c->fd, SHUT_RDWR);
    for (const auto& c : conns)
        if (c->th.joinable())
            c->th.join();
}

}  // namespace fsw::net

#include "routing/FrameToElodinMapper.hpp"

#include <chrono>

namespace daq_comms {
namespace routing {

FrameToElodinMapper::FrameToElodinMapper(elodin::ElodinClient& elodin_client, SensorRouter& router)
    : elodin_client_(elodin_client), router_(router) {
    stats_ = Stats{};
}

size_t FrameToElodinMapper::map_and_publish(const protocol::SensorBatch& batch) {
    if (!batch.is_valid) {
        return 0;
    }

    stats_.batches_processed++;
    size_t published = 0;
    
    uint64_t timestamp_ns = get_monotonic_timestamp_ns();
    if (batch.frame_timestamp_ns > 0) {
        timestamp_ns = batch.frame_timestamp_ns;
    }

    // Route and publish PT samples
    auto pt_messages = router_.route_pt_samples(batch, timestamp_ns);
    static size_t debug_publish_count = 0;
    for (const auto& [table_id, msg] : pt_messages) {
        if (debug_publish_count++ < 3) {
            std::cout << "[Mapper] Publishing PT: packet_id=[" << std::hex << (int)table_id[0] << ", " << (int)table_id[1] << std::dec << "]\n";
        }
        if (elodin_client_.publish(table_id, msg)) {
            published++;
        } else {
            stats_.publish_failures++;
            if (debug_publish_count <= 3) {
                std::cerr << "[Mapper] FAILED to publish PT message\n";
            }
        }
    }

    // Route and publish TC samples
    auto tc_messages = router_.route_tc_samples(batch, timestamp_ns);
    for (const auto& [table_id, msg] : tc_messages) {
        if (elodin_client_.publish(table_id, msg)) {
            published++;
        } else {
            stats_.publish_failures++;
        }
    }

    // Route and publish RTD samples
    auto rtd_messages = router_.route_rtd_samples(batch, timestamp_ns);
    for (const auto& [table_id, msg] : rtd_messages) {
        if (elodin_client_.publish(table_id, msg)) {
            published++;
        } else {
            stats_.publish_failures++;
        }
    }

    // Route and publish LC samples
    auto lc_messages = router_.route_lc_samples(batch, timestamp_ns);
    for (const auto& [table_id, msg] : lc_messages) {
        if (elodin_client_.publish(table_id, msg)) {
            published++;
        } else {
            stats_.publish_failures++;
        }
    }

    stats_.messages_published += published;
    return published;
}

uint64_t FrameToElodinMapper::get_monotonic_timestamp_ns() const {
    auto now = std::chrono::steady_clock::now();
    auto duration = now.time_since_epoch();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(duration).count();
}

} // namespace routing
} // namespace daq_comms


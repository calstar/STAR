#ifndef DAQ_FRAME_TO_ELODIN_MAPPER_HPP
#define DAQ_FRAME_TO_ELODIN_MAPPER_HPP

#include <chrono>
#include <cstdint>

#include "../../daq_comms/include/protocol/EncryptedFrame.hpp"
#include "elodin/ElodinClient.hpp"
#include "routing/SensorRouter.hpp"

namespace fsw {
namespace routing {

/**
 * @brief Maps decoded sensor frames to Elodin messages and publishes them
 *
 * This is the translation layer that takes SensorBatch objects
 * and publishes them to Elodin via the ElodinClient.
 */
class FrameToElodinMapper {
public:
    FrameToElodinMapper(elodin::ElodinClient& elodin_client, SensorRouter& router);
    ~FrameToElodinMapper() = default;

    /**
     * @brief Process a sensor batch and publish to Elodin
     * @param batch Decoded sensor batch
     * @return Number of messages published
     */
    size_t map_and_publish(const daq_comms::protocol::SensorBatch& batch);

    /**
     * @brief Get statistics
     */
    struct Stats {
        size_t batches_processed;
        size_t messages_published;
        size_t publish_failures;
    };

    Stats get_stats() const {
        return stats_;
    }
    void reset_stats() {
        stats_ = Stats{};
    }

private:
    elodin::ElodinClient& elodin_client_;
    SensorRouter& router_;
    Stats stats_;

    uint64_t get_monotonic_timestamp_ns() const;
};

}  // namespace routing
}  // namespace fsw

#endif  // DAQ_FRAME_TO_ELODIN_MAPPER_HPP

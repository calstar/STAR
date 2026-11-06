extern "C" {
#include "daq_wire.h"
}
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "daq-protocol.h"
#define CHECK(x)                                                 \
    do {                                                         \
        if (!(x)) {                                              \
            std::fprintf(stderr, "line %d: %s\n", __LINE__, #x); \
            std::abort();                                        \
        }                                                        \
    } while (0)
int main() {
    std::array<uint8_t, 512> actual{}, expected{};
    daq_sample_t s{};
    s.timestamp_ms = 0xfedcba98;
    s.count = 3;
    s.values[0] = {1, 0xffffffff};
    s.values[1] = {3, 0x12345678};
    s.values[2] = {10, 101325};
    auto n = daq_encode_sample(&s, 0x3ff, actual.data(), actual.size());
    daq::SensorDataChunkCollection c(s.timestamp_ms, 3);
    for (unsigned i = 0; i < s.count; ++i)
        c.add_datapoint(s.values[i].id, s.values[i].value);
    auto ref = daq::create_sensor_data_packet({c}, 3, s.timestamp_ms,
                                              expected.data(), expected.size());
    CHECK(n == ref && std::memcmp(actual.data(), expected.data(), n) == 0);
    daq::PacketHeader header{};
    std::vector<daq::SensorDataChunkCollection> chunks;
    CHECK(daq::parse_sensor_data_packet(actual.data(), n, header, chunks));
    CHECK(chunks.size() == 1 && chunks[0].datapoints[1].data == 0x12345678);
    CHECK(daq_encode_sample(&s, 1, actual.data(), actual.size()) == 17);
    CHECK(daq_encode_sample(&s, 0, actual.data(), actual.size()) == 0);
    CHECK(daq_encode_sample(&s, 0x3ff, actual.data(), n - 1) == 0);
    s.values[2].id = 1;
    CHECK(!daq_sample_valid(&s));
    s.values[2].id = 11;
    CHECK(!daq_sample_valid(&s));
    daq_peer_t p{};
    daq::BoardHeartbeatPacket hb{};
    hb.board_id = 99;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = daq::BoardState::SETUP;
    for (unsigned i = 0; i < 32; ++i)
        hb.firmware_hash[i] = (uint8_t)i;
    n = daq_encode_heartbeat(&p, 99, hb.firmware_hash, 123, actual.data(),
                             actual.size());
    ref = daq::create_board_heartbeat_packet(hb, 123, expected.data(),
                                             expected.size());
    CHECK(n == ref && std::memcmp(actual.data(), expected.data(), n) == 0);
    n = daq::create_sensor_config_packet({1, 3, 10}, 0, false, 0, 0, 0,
                                         expected.data(), expected.size());
    CHECK(daq_peer_receive(&p, expected.data(), n, UINT32_MAX - 1000));
    CHECK(p.configured && p.channels == 0x205);
    daq_peer_expire(&p, 3998);
    CHECK(p.configured);
    daq_peer_expire(&p, 3999);
    CHECK(!p.configured && !p.channels);
    for (size_t len = 0; len < n; ++len)
        CHECK(!daq_peer_receive(&p, expected.data(), len, 0));
    expected[1] = 1;
    CHECK(!daq_peer_receive(&p, expected.data(), n, 0));
    expected[1] = 0;
    expected[8] = 1;
    CHECK(!daq_peer_receive(&p, expected.data(), n, 0));
    n = daq::create_sensor_config_packet({1}, 0, true, 0, 0, 0, expected.data(),
                                         expected.size());
    CHECK(!daq_peer_receive(&p, expected.data(), n, 0));
    expected = {2, 0, 50, 0, 0, 0, 3};
    n = 7;
    CHECK(daq_peer_receive(&p, expected.data(), n, 50) && p.engine_state == 3 &&
          !p.configured);
    expected[0] = 4;
    CHECK(!daq_peer_receive(&p, expected.data(), n, 60));
    CHECK(p.last_server_ms == 50);
    std::puts("DAQv2 shared-library wire compatibility checks passed");
}

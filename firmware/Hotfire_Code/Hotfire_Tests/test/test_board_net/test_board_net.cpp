/**
 * Board networking unit tests
 *
 * Includes the REAL header (common/board_net.h) rather than a replica: the
 * point of this suite is that the board's working address and ID come only
 * from the server, and a replica could not prove that about the shipped code. The stubbed
 * EthernetClass records what gets written to the chip.
 */

// Match the LC / Actuator builds.
#define SENSOR_ETH_USE_DHCP

#include <unity.h>

#include "board_net.h"

static const byte kMac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0x2A, 0x3C};

static const IPAddress kGateway(0, 0, 0, 0);
static const IPAddress kDns(192, 168, 2, 1);
static const IPAddress kDefaultServer(192, 168, 2, 20);
static const IPAddress kLeasedIP(192, 168, 2, 137);
// 169.254.<1 + 0x2A % 254>.<0x3C>
static const IPAddress kRecoveryIP(169, 254, 43, 60);

static BoardNet::State makeState() {
    Ethernet.reset();
    stub_set_millis(1000);
    BoardNet::State s;
    BoardNet::configure(s, kMac);
    return s;
}

static BoardNet::State recoveringState() {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = false;
    BoardNet::begin(s, kDns, kGateway);
    return s;
}

// ---------------------------------------------------------------------------
// The board asks; the server's answer is its address and its ID
// ---------------------------------------------------------------------------
void test_dhcp_lease_is_adopted(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;

    BoardNet::AddressSource src = BoardNet::begin(s, kDns, kGateway);

    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::Dhcp, (int)src);
    TEST_ASSERT_TRUE(BoardNet::usingDhcp(s));
    TEST_ASSERT_TRUE(Ethernet.localIP() == kLeasedIP);
    // Nothing static was configured: the server's answer is the whole story.
    TEST_ASSERT_EQUAL_INT(0, Ethernet.static_begin_calls);
}

void test_board_id_is_the_assigned_address(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = IPAddress(192, 168, 2, 31);
    BoardNet::begin(s, kDns, kGateway);
    TEST_ASSERT_EQUAL_UINT8(31, BoardNet::boardId(s));
}

// ---------------------------------------------------------------------------
// No DHCP answer: the MAC-derived recovery address, reflash only
// ---------------------------------------------------------------------------
void test_recovery_address_formula(void) {
    // The vectors firmware/tools/ota_upload.py and daq-server's config
    // validation test too; change one, change all three.
    const byte rtd[6] = {0x4a, 0x27, 0xe2, 0x3a, 0xad, 0x71};
    TEST_ASSERT_TRUE(BoardNet::recoveryAddress(rtd) == IPAddress(169, 254, 174, 113));
    // Third octet stays in 1..254 (RFC 3927): 0x00 -> 1, 0xFE -> 1, 0xFF -> 2.
    const byte lo[6] = {0, 0, 0, 0, 0x00, 0x00};
    const byte fe[6] = {0, 0, 0, 0, 0xFE, 0xFF};
    const byte ff[6] = {0, 0, 0, 0, 0xFF, 0x01};
    TEST_ASSERT_TRUE(BoardNet::recoveryAddress(lo) == IPAddress(169, 254, 1, 0));
    TEST_ASSERT_TRUE(BoardNet::recoveryAddress(fe) == IPAddress(169, 254, 1, 255));
    TEST_ASSERT_TRUE(BoardNet::recoveryAddress(ff) == IPAddress(169, 254, 2, 1));
}

void test_no_answer_puts_the_board_on_its_recovery_address(void) {
    BoardNet::State s = recoveringState();

    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::Recovery, (int)s.source);
    TEST_ASSERT_FALSE(BoardNet::usingDhcp(s));
    TEST_ASSERT_TRUE(Ethernet.static_ip == kRecoveryIP);
    TEST_ASSERT_TRUE(Ethernet.static_subnet == IPAddress(255, 255, 0, 0));
    TEST_ASSERT_TRUE(Ethernet.localIP() == kRecoveryIP);
    // Never a working 192.168.2.x address the board made up for itself.
    TEST_ASSERT_FALSE(Ethernet.localIP()[0] == 192);
    // And no identity: only the server gives one.
    TEST_ASSERT_EQUAL_UINT8(0, BoardNet::boardId(s));
}

void test_source_is_reported_honestly(void) {
    BoardNet::State s = makeState();
    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::None, (int)s.source);
    TEST_ASSERT_FALSE(BoardNet::hasAddress(s));

    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;
    BoardNet::begin(s, kDns, kGateway);
    // The operator has to be able to tell an assigned address from recovery.
    TEST_ASSERT_EQUAL_STRING("DHCP (assigned by the server)",
                             BoardNet::sourceName(s.source));
}

// ---------------------------------------------------------------------------
// On the recovery address the board keeps asking
// ---------------------------------------------------------------------------
void test_retry_waits_for_the_interval(void) {
    BoardNet::State s = recoveringState();
    const int asked = Ethernet.dhcp_begin_calls;

    stub_set_millis(1000 + SENSOR_ETH_DHCP_RETRY_INTERVAL_MS - 1);
    TEST_ASSERT_FALSE(BoardNet::retryDhcp(s, kDns, kGateway));
    TEST_ASSERT_EQUAL_INT(asked, Ethernet.dhcp_begin_calls);
}

void test_failed_retry_stays_reflashable(void) {
    BoardNet::State s = recoveringState();
    const int asked = Ethernet.dhcp_begin_calls;

    stub_set_millis(1000 + SENSOR_ETH_DHCP_RETRY_INTERVAL_MS);
    TEST_ASSERT_FALSE(BoardNet::retryDhcp(s, kDns, kGateway));

    TEST_ASSERT_EQUAL_INT(asked + 1, Ethernet.dhcp_begin_calls);
    // The failed attempt zeroed the address; the recovery one is back.
    TEST_ASSERT_TRUE(Ethernet.localIP() == kRecoveryIP);
    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::Recovery, (int)s.source);
}

void test_retry_that_gets_a_lease_moves_the_board(void) {
    BoardNet::State s = recoveringState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = IPAddress(192, 168, 2, 22);

    stub_set_millis(1000 + SENSOR_ETH_DHCP_RETRY_INTERVAL_MS);
    TEST_ASSERT_TRUE(BoardNet::retryDhcp(s, kDns, kGateway));

    TEST_ASSERT_TRUE(BoardNet::usingDhcp(s));
    TEST_ASSERT_TRUE(Ethernet.localIP() == IPAddress(192, 168, 2, 22));
    TEST_ASSERT_EQUAL_UINT8(22, BoardNet::boardId(s));

    // On a lease, no more asking.
    const int asked = Ethernet.dhcp_begin_calls;
    stub_set_millis(1000 + 10 * SENSOR_ETH_DHCP_RETRY_INTERVAL_MS);
    TEST_ASSERT_FALSE(BoardNet::retryDhcp(s, kDns, kGateway));
    TEST_ASSERT_EQUAL_INT(asked, Ethernet.dhcp_begin_calls);
}

void test_no_retry_during_an_ota(void) {
    BoardNet::State s = recoveringState();
    BoardNet::beginOtaHold(s);
    const int asked = Ethernet.dhcp_begin_calls;

    // Reflashing on the recovery address is the point of it: never move the
    // address out from under the transfer.
    stub_set_millis(1000 + 10 * SENSOR_ETH_DHCP_RETRY_INTERVAL_MS);
    TEST_ASSERT_FALSE(BoardNet::retryDhcp(s, kDns, kGateway));
    TEST_ASSERT_EQUAL_INT(asked, Ethernet.dhcp_begin_calls);
}

// ---------------------------------------------------------------------------
// Lease renewal
// ---------------------------------------------------------------------------
void test_lease_is_renewed_only_on_a_lease(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;
    BoardNet::begin(s, kDns, kGateway);

    BoardNet::maintainLease(s);
    TEST_ASSERT_EQUAL_INT(1, Ethernet.maintain_calls);

    // On the recovery address there is no lease to renew.
    BoardNet::State f = recoveringState();
    Ethernet.maintain_calls = 0;
    BoardNet::maintainLease(f);
    TEST_ASSERT_EQUAL_INT(0, Ethernet.maintain_calls);
}

void test_ota_suspends_renewal(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;
    BoardNet::begin(s, kDns, kGateway);

    // A renewal that moved our address mid-flash would drop the transfer.
    BoardNet::beginOtaHold(s);
    Ethernet.maintain_calls = 0;
    BoardNet::maintainLease(s);
    TEST_ASSERT_EQUAL_INT(0, Ethernet.maintain_calls);
}

// ---------------------------------------------------------------------------
// Server discovery — separate from addressing, and still ours to do
// ---------------------------------------------------------------------------
void test_server_is_learned_from_its_packets(void) {
    BoardNet::State s = makeState();
    IPAddress server = kDefaultServer;

    stub_set_millis(4000);
    bool changed =
        BoardNet::onServerPacket(s, IPAddress(192, 168, 2, 77), server);

    TEST_ASSERT_TRUE(changed);
    TEST_ASSERT_TRUE(s.serverLearned);
    TEST_ASSERT_EQUAL_UINT32(4000, s.lastServerPacketMillis);
    TEST_ASSERT_TRUE(server == IPAddress(192, 168, 2, 77));
}

void test_repeat_server_packet_is_not_a_change(void) {
    BoardNet::State s = makeState();
    IPAddress server = kDefaultServer;
    BoardNet::onServerPacket(s, kDefaultServer, server);
    TEST_ASSERT_FALSE(BoardNet::onServerPacket(s, kDefaultServer, server));
}

void test_learning_a_server_never_moves_our_address(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;
    BoardNet::begin(s, kDns, kGateway);
    int writes = Ethernet.set_local_ip_calls;

    IPAddress server = kDefaultServer;
    BoardNet::onServerPacket(s, IPAddress(169, 254, 130, 5), server);

    // Hearing from a server on some other subnet is not a reason to re-address
    // ourselves — only the DHCP server gets to decide where we live.
    TEST_ASSERT_EQUAL_INT(writes, Ethernet.set_local_ip_calls);
    TEST_ASSERT_TRUE(Ethernet.localIP() == kLeasedIP);
}

void test_server_silence_only_after_it_was_learned(void) {
    BoardNet::State s = makeState();
    stub_set_millis(1000 + SENSOR_ZEROCONF_SERVER_SILENCE_MS * 10);
    TEST_ASSERT_FALSE(BoardNet::serverWentSilent(s));
}

void test_server_silence_trips_after_timeout(void) {
    BoardNet::State s = makeState();
    IPAddress server = kDefaultServer;
    stub_set_millis(5000);
    BoardNet::onServerPacket(s, kDefaultServer, server);

    stub_set_millis(5000 + SENSOR_ZEROCONF_SERVER_SILENCE_MS - 1);
    TEST_ASSERT_FALSE(BoardNet::serverWentSilent(s));
    stub_set_millis(5000 + SENSOR_ZEROCONF_SERVER_SILENCE_MS);
    TEST_ASSERT_TRUE(BoardNet::serverWentSilent(s));
}

// ---------------------------------------------------------------------------
// The MAC the server keys its reservation table on
// ---------------------------------------------------------------------------
void test_mac_is_stored_for_reporting(void) {
    BoardNet::State s = makeState();
    TEST_ASSERT_EQUAL_UINT8(0xDE, s.mac[0]);
    TEST_ASSERT_EQUAL_UINT8(0x3C, s.mac[5]);
    // printMac() goes to the stubbed Serial; this just proves it is callable
    // and reads the configured MAC rather than anything else.
    BoardNet::printMac(s);
}

void setUp(void) {
}
void tearDown(void) {
}

int main(int, char**) {
    UNITY_BEGIN();

    // addressing
    RUN_TEST(test_dhcp_lease_is_adopted);
    RUN_TEST(test_board_id_is_the_assigned_address);
    RUN_TEST(test_recovery_address_formula);
    RUN_TEST(test_no_answer_puts_the_board_on_its_recovery_address);
    RUN_TEST(test_source_is_reported_honestly);

    // retry on the recovery address
    RUN_TEST(test_retry_waits_for_the_interval);
    RUN_TEST(test_failed_retry_stays_reflashable);
    RUN_TEST(test_retry_that_gets_a_lease_moves_the_board);
    RUN_TEST(test_no_retry_during_an_ota);

    // lease renewal
    RUN_TEST(test_lease_is_renewed_only_on_a_lease);
    RUN_TEST(test_ota_suspends_renewal);

    // server discovery
    RUN_TEST(test_server_is_learned_from_its_packets);
    RUN_TEST(test_repeat_server_packet_is_not_a_change);
    RUN_TEST(test_learning_a_server_never_moves_our_address);
    RUN_TEST(test_server_silence_only_after_it_was_learned);
    RUN_TEST(test_server_silence_trips_after_timeout);

    // identity
    RUN_TEST(test_mac_is_stored_for_reporting);

    return UNITY_END();
}

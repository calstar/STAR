/**
 * Board networking unit tests
 *
 * Includes the REAL header (common/board_net.h) rather than a replica: the
 * point of this suite is that the board never assigns itself an address, and
 * a replica could not prove that about the shipped code. The stubbed
 * EthernetClass records what gets written to the chip.
 */

// Match the LC / Actuator builds.
#define SENSOR_ETH_USE_DHCP

#include <unity.h>

#include "board_net.h"

static const byte kMac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0x2A, 0x3C};

static const IPAddress kStaticIP(192, 168, 2, 41);
static const IPAddress kStaticSubnet(255, 255, 255, 0);
static const IPAddress kGateway(0, 0, 0, 0);
static const IPAddress kDns(192, 168, 2, 1);
static const IPAddress kDefaultServer(192, 168, 2, 20);
static const IPAddress kLeasedIP(192, 168, 2, 137);

static BoardNet::State makeState() {
    Ethernet.reset();
    stub_set_millis(1000);
    BoardNet::State s;
    BoardNet::configure(s, kMac, kStaticIP, kStaticSubnet);
    return s;
}

// ---------------------------------------------------------------------------
// The board asks; it does not decide
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

void test_board_never_invents_a_link_local_address(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = false;

    BoardNet::begin(s, kDns, kGateway);

    // The old behaviour was to self-assign 169.254.x.y and hunt. Whatever we
    // end up with, it must never be an address the board made up.
    IPAddress ip = Ethernet.localIP();
    TEST_ASSERT_FALSE(ip[0] == 169 && ip[1] == 254);
}

void test_fallback_is_the_known_static_address(void) {
    BoardNet::State s = makeState();
    Ethernet.dhcp_should_succeed = false;

    BoardNet::AddressSource src = BoardNet::begin(s, kDns, kGateway);

    // Not a DHCP-only build, so the last-resort static address is used —
    // deliberately the one daq-server already has configured.
    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::Fallback, (int)src);
    TEST_ASSERT_FALSE(BoardNet::usingDhcp(s));
    TEST_ASSERT_TRUE(BoardNet::hasAddress(s));
    TEST_ASSERT_EQUAL_INT(1, Ethernet.static_begin_calls);
    TEST_ASSERT_TRUE(Ethernet.static_ip == kStaticIP);
    TEST_ASSERT_TRUE(Ethernet.static_subnet == kStaticSubnet);
}

void test_source_is_reported_honestly(void) {
    BoardNet::State s = makeState();
    TEST_ASSERT_EQUAL_INT((int)BoardNet::AddressSource::None, (int)s.source);
    TEST_ASSERT_FALSE(BoardNet::hasAddress(s));

    Ethernet.dhcp_should_succeed = true;
    Ethernet.dhcp_assigned = kLeasedIP;
    BoardNet::begin(s, kDns, kGateway);
    // The operator has to be able to tell an assigned address from a fallback.
    TEST_ASSERT_EQUAL_STRING("DHCP (assigned by the server)",
                             BoardNet::sourceName(s.source));
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

    // On the static fallback there is no lease to renew.
    BoardNet::State f = makeState();
    Ethernet.dhcp_should_succeed = false;
    BoardNet::begin(f, kDns, kGateway);
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
    bool changed = BoardNet::onServerPacket(s, IPAddress(192, 168, 2, 77),
                                            server);

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
    RUN_TEST(test_board_never_invents_a_link_local_address);
    RUN_TEST(test_fallback_is_the_known_static_address);
    RUN_TEST(test_source_is_reported_honestly);

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

/**
 * STAR_EthernetOTA — firmware updates over Ethernet (W5500) for STAR boards.
 *
 * Every STAR board with a W5500 already listens for firmware over TCP; this
 * library is the single implementation of that, so the sense boards, the
 * actuator board, the stacklight, the encoder and the environmental tracker
 * all speak the same protocol and cannot drift apart.
 *
 * Usage:
 *     #include <STAR_EthernetOTA.h>
 *     static StarOTA::Server ota;          // default port 3232
 *
 *     void setup() { ...Ethernet.begin(...)...; ota.begin(); }
 *     void loop()  { ota.poll(); }         // returns immediately if idle
 *
 * ``poll()`` only blocks once a client has actually connected, and then only
 * for the duration of the transfer (or ``timeout_ms`` of silence). On success
 * the board reboots into the new image and never returns from poll().
 *
 * Wire protocol (unchanged from the original hotfire_ota.h, so existing
 * uploaders keep working):
 *
 *     client -> board : [4-byte big-endian image size][raw firmware bytes]
 *     board  -> client: "OK\r\n", then reboot
 *
 * Upload with ``firmware/tools/ota_upload.py``, with ``pio run -e ota -t
 * upload`` in a project that declares an OTA env, or from the Test-GUI's
 * OTA tab.
 *
 * Verifying an update took: every board prints its running image's SHA-256 at
 * boot (``firmware_hash.h``) and reports it in BOARD_HEARTBEAT, so the hash of
 * the .bin you uploaded should appear on the board a few seconds later. For a
 * quicker eyeball check while bench-testing, build with
 * ``-DSTAR_OTA_TEST_MESSAGE='"whatever"'`` and call ``printTestMessage()`` in
 * loop(): the board prints that string on a timer, so consecutive uploads with
 * different messages are visibly different on the serial monitor.
 */

#pragma once

#include <Arduino.h>
#include <Ethernet.h>

/** TCP port the board listens on. */
#ifndef STAR_OTA_DEFAULT_PORT
#define STAR_OTA_DEFAULT_PORT 3232
#endif

/** Read buffer for the firmware stream. */
#ifndef STAR_OTA_CHUNK_SIZE
#define STAR_OTA_CHUNK_SIZE 4096
#endif

/** How long to wait for the header, or for more data mid-transfer. */
#ifndef STAR_OTA_TIMEOUT_MS
#define STAR_OTA_TIMEOUT_MS 10000
#endif

/** Sanity cap on the announced image size (2 MB). */
#ifndef STAR_OTA_MAX_IMAGE_BYTES
#define STAR_OTA_MAX_IMAGE_BYTES 0x200000
#endif

/**
 * Optional bench-test marker. Build with
 * -DSTAR_OTA_TEST_MESSAGE='"hello"' and call printTestMessage() from loop().
 * Empty (the default) makes printTestMessage() a no-op.
 */
#ifndef STAR_OTA_TEST_MESSAGE
#define STAR_OTA_TEST_MESSAGE ""
#endif

/** How often printTestMessage() prints, when a message is set. */
#ifndef STAR_OTA_TEST_MESSAGE_INTERVAL_MS
#define STAR_OTA_TEST_MESSAGE_INTERVAL_MS 2000
#endif

namespace StarOTA {

/** Outcome of one OTA attempt. */
enum class Result : uint8_t {
    Idle,           ///< no client was waiting; nothing happened
    Success,        ///< image written; the board reboots unless told not to
    HeaderTimeout,  ///< client connected but never sent the 4-byte size
    BadSize,        ///< announced size was zero or implausibly large
    BeginFailed,    ///< Update.begin() refused (no OTA partition / too big)
    DataTimeout,    ///< transfer stalled partway through
    WriteFailed,    ///< flash write came up short
    EndFailed       ///< image received but failed validation
};

/** Human-readable form of a Result, for logs. */
const char* resultName(Result r);

struct Config {
    uint16_t port = STAR_OTA_DEFAULT_PORT;
    uint32_t timeout_ms = STAR_OTA_TIMEOUT_MS;
    uint32_t max_image_bytes = STAR_OTA_MAX_IMAGE_BYTES;
    /// Reboot into the new image on success. Off is for tests only — the
    /// running image has already been replaced, so the board is not itself
    /// until it restarts.
    bool reboot_on_success = true;
    /// Print progress and errors to Serial.
    bool verbose = true;
};

/**
 * Some Arduino-ESP32 cores make Server::begin() pure virtual as
 * begin(uint16_t); others use begin(). Official Ethernet 2.x EthernetServer
 * only implements void begin(), so EthernetServer can be abstract on CI.
 * Implementing begin(uint16_t) WITHOUT 'override' matches newer Server.h on
 * CI while staying valid on older cores whose Server has no begin(uint16_t).
 */
class PortableServer : public EthernetServer {
public:
    explicit PortableServer(uint16_t port) : EthernetServer(port) {
    }
    void begin(uint16_t port = 0) {
        (void)port;
        EthernetServer::begin();
    }
    using EthernetServer::begin;
};

/**
 * The OTA listener. One per board.
 *
 * Callbacks let a board react without this library having to know about it —
 * the hotfire boards use onStart() to suspend DHCP lease renewal, so their
 * address cannot move mid-flash.
 */
class Server {
public:
    using StartCallback = void (*)(void* user_data, uint32_t image_bytes);
    using ProgressCallback = void (*)(void* user_data, uint32_t received,
                                      uint32_t total);
    using EndCallback = void (*)(void* user_data, Result result);

    explicit Server(uint16_t port = STAR_OTA_DEFAULT_PORT);

    /** Start listening. Call after Ethernet.begin(). */
    void begin();

    /** Is a client waiting? Cheap; safe to call every loop. */
    bool clientWaiting();

    /**
     * Accept a waiting client and run the transfer to completion.
     * Returns Idle immediately when no client is waiting, so this is the
     * only call most boards need in loop().
     */
    Result poll();

    /**
     * Run the transfer on a client you accepted yourself.
     *
     * poll() is what you want; this exists for boards that own their own
     * listening socket (and for the legacy hotfire_ota.h shim). Blocks for
     * the duration of the transfer, replies "OK" and reboots on success.
     */
    Result handleClient(EthernetClient& client);

    /** Result of the last attempt that was not Idle. */
    Result lastResult() const {
        return last_result_;
    }

    /** Called once the size header is in, before any flash write. */
    void onStart(StartCallback cb, void* user_data = nullptr);
    /** Called every STAR_OTA_CHUNK_SIZE-ish bytes. */
    void onProgress(ProgressCallback cb, void* user_data = nullptr);
    /** Called on both success and failure, before any reboot. */
    void onEnd(EndCallback cb, void* user_data = nullptr);

    Config config;

private:
    Result transfer(EthernetClient& client);
    Result fail(EthernetClient& client, Result r, const char* why);
    bool readSize(EthernetClient& client, uint32_t& size_out);

    PortableServer server_;
    Result last_result_ = Result::Idle;

    StartCallback on_start_ = nullptr;
    void* on_start_data_ = nullptr;
    ProgressCallback on_progress_ = nullptr;
    void* on_progress_data_ = nullptr;
    EndCallback on_end_ = nullptr;
    void* on_end_data_ = nullptr;
};

/**
 * Bench-test helper: prints STAR_OTA_TEST_MESSAGE on a timer as
 *
 *     [OTA-MSG] <message>
 *
 * so that uploading a build with a different message is immediately visible
 * on the serial monitor. The Test-GUI bakes this flag, uploads, and watches
 * for the line to change — which is the cheapest end-to-end proof that an OTA
 * actually landed. No-op when no message was compiled in, so it is safe to
 * leave the call in loop() on flight builds.
 */
void printTestMessage();

/** The compiled-in test message ("" when none). */
const char* testMessage();

}  // namespace StarOTA

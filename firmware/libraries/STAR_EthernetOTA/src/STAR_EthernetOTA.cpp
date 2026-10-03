#include "STAR_EthernetOTA.h"

#include <Update.h>

namespace StarOTA {

namespace {

// Serial output is gated on config.verbose, but errors are worth printing
// even on a quiet board: an OTA that silently fails is the worst outcome.
void logf(bool verbose, const char* fmt, ...) {
    if (!verbose)
        return;
    char buf[128];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    Serial.print(buf);
}

}  // namespace

const char* resultName(Result r) {
    switch (r) {
        case Result::Idle:
            return "idle";
        case Result::Success:
            return "success";
        case Result::HeaderTimeout:
            return "timed out waiting for size header";
        case Result::BadSize:
            return "implausible image size";
        case Result::BeginFailed:
            return "Update.begin() failed";
        case Result::DataTimeout:
            return "timed out waiting for firmware data";
        case Result::WriteFailed:
            return "flash write size mismatch";
        case Result::EndFailed:
            return "Update.end() failed";
    }
    return "unknown";
}

Server::Server(uint16_t port) : server_(port) {
    config.port = port;
}

void Server::begin() {
    // Pass the port explicitly. A bare begin() is ambiguous on cores where
    // EthernetServer exposes both begin() and begin(uint16_t) — see
    // PortableServer's note — and which shape you get varies by core version.
    server_.begin(config.port);
    Serial.print("[OTA] listening on TCP port ");
    Serial.println(config.port);
    Serial.flush();
}

void Server::onStart(StartCallback cb, void* user_data) {
    on_start_ = cb;
    on_start_data_ = user_data;
}

void Server::onProgress(ProgressCallback cb, void* user_data) {
    on_progress_ = cb;
    on_progress_data_ = user_data;
}

void Server::onEnd(EndCallback cb, void* user_data) {
    on_end_ = cb;
    on_end_data_ = user_data;
}

bool Server::clientWaiting() {
    EthernetClient c = server_.available();
    return static_cast<bool>(c);
}

Result Server::poll() {
    EthernetClient client = server_.available();
    if (!client)
        return Result::Idle;
    return handleClient(client);
}

Result Server::handleClient(EthernetClient& client) {
    Result r = transfer(client);
    last_result_ = r;
    if (on_end_)
        on_end_(on_end_data_, r);

    if (r == Result::Success) {
        Serial.println("[OTA] update successful");
        Serial.flush();
        client.println("OK");
        client.flush();
        client.stop();
        if (config.reboot_on_success) {
            Serial.println("[OTA] rebooting into the new image");
            Serial.flush();
            delay(500);
            ESP.restart();
        }
    }
    return r;
}

Result Server::fail(EthernetClient& client, Result r, const char* why) {
    // Always printed: a silent OTA failure is worse than a noisy one.
    Serial.print("[OTA] ERROR: ");
    Serial.println(why);
    Serial.flush();
    client.stop();
    return r;
}

bool Server::readSize(EthernetClient& client, uint32_t& size_out) {
    unsigned long start = millis();
    while (client.available() < 4) {
        if (millis() - start > config.timeout_ms)
            return false;
        delay(1);
    }
    size_out = 0;
    size_out |= static_cast<uint32_t>(client.read()) << 24;
    size_out |= static_cast<uint32_t>(client.read()) << 16;
    size_out |= static_cast<uint32_t>(client.read()) << 8;
    size_out |= static_cast<uint32_t>(client.read());
    return true;
}

Result Server::transfer(EthernetClient& client) {
    logf(config.verbose, "[OTA] client connected -- starting transfer\n");

    uint32_t image_bytes = 0;
    if (!readSize(client, image_bytes))
        return fail(client, Result::HeaderTimeout,
                    "timed out waiting for the 4-byte size header");

    if (image_bytes == 0 || image_bytes > config.max_image_bytes) {
        Serial.print("[OTA] announced size: ");
        Serial.println(image_bytes);
        return fail(client, Result::BadSize, "implausible image size");
    }
    logf(config.verbose, "[OTA] image size: %u bytes\n",
         static_cast<unsigned>(image_bytes));

    // Tell the board before touching flash — the hotfire boards use this to
    // freeze their address so they cannot re-address mid-flash.
    if (on_start_)
        on_start_(on_start_data_, image_bytes);

    if (!Update.begin(image_bytes)) {
        Update.printError(Serial);
        return fail(client, Result::BeginFailed, "Update.begin() refused");
    }

    uint8_t buf[STAR_OTA_CHUNK_SIZE];
    uint32_t received = 0;
    int last_percent_bucket = -1;
    unsigned long last_data_ms = millis();

    while (received < image_bytes) {
        int available = client.available();
        if (available <= 0) {
            if (millis() - last_data_ms > config.timeout_ms) {
                Update.abort();
                return fail(client, Result::DataTimeout,
                            "transfer stalled partway through");
            }
            delay(1);
            continue;
        }

        int to_read = available < static_cast<int>(sizeof(buf))
                          ? available
                          : static_cast<int>(sizeof(buf));
        const uint32_t remaining = image_bytes - received;
        if (static_cast<uint32_t>(to_read) > remaining)
            to_read = static_cast<int>(remaining);

        int bytes_read = client.read(buf, to_read);
        if (bytes_read <= 0)
            continue;

        if (Update.write(buf, bytes_read) != static_cast<size_t>(bytes_read)) {
            Update.printError(Serial);
            Update.abort();
            return fail(client, Result::WriteFailed,
                        "flash write came up short");
        }

        received += bytes_read;
        last_data_ms = millis();

        if (on_progress_)
            on_progress_(on_progress_data_, received, image_bytes);

        int percent = static_cast<int>((received * 100UL) / image_bytes);
        if (percent / 5 != last_percent_bucket) {
            last_percent_bucket = percent / 5;
            logf(config.verbose, "[OTA] progress: %d%% (%u / %u bytes)\n",
                 percent, static_cast<unsigned>(received),
                 static_cast<unsigned>(image_bytes));
        }
    }

    logf(config.verbose, "[OTA] all bytes received -- finalizing\n");
    if (!Update.end(true)) {
        Update.printError(Serial);
        return fail(client, Result::EndFailed, "image failed validation");
    }
    return Result::Success;
}

//-----------------------------------------------------------------------------
// Bench-test marker
//-----------------------------------------------------------------------------
const char* testMessage() {
    return STAR_OTA_TEST_MESSAGE;
}

void printTestMessage() {
    static const char* message = STAR_OTA_TEST_MESSAGE;
    if (message[0] == '\0')
        return;  // no message compiled in — nothing to do on a flight build

    static unsigned long last_ms = 0;
    unsigned long now = millis();
    // Print immediately on the first call, then on the interval, so the new
    // message shows up the moment the board comes back from an OTA.
    if (last_ms != 0 && now - last_ms < STAR_OTA_TEST_MESSAGE_INTERVAL_MS)
        return;
    last_ms = now;
    Serial.print("[OTA-MSG] ");
    Serial.println(message);
    Serial.flush();
}

}  // namespace StarOTA

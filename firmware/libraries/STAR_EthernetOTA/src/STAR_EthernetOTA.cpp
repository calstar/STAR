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
        case Result::InProgress:
            return "transfer in progress";
        case Result::Refused:
            return "refused: not allowed in the current state";
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
    Result r = service();
    while (r == Result::InProgress) {
        delay(1);
        r = service();
    }
    return r;
}

Result Server::handleClient(EthernetClient& client) {
    if (phase_ != Phase::Listening)
        return Result::InProgress;  // already busy with another client
    client_ = client;
    phase_ = Phase::Header;
    header_len_ = 0;
    last_activity_ms_ = millis();
    logf(config.verbose, "[OTA] client connected -- starting transfer\n");
    Result r = service();
    while (r == Result::InProgress) {
        delay(1);
        r = service();
    }
    return r;
}

Result Server::service(bool allowed) {
    if (phase_ == Phase::Listening) {
        EthernetClient c = server_.available();
        if (!c)
            return Result::Idle;
        client_ = c;
        if (!allowed) {
            Serial.println("[OTA] refused: board is not in a state that allows "
                           "updates");
            Serial.flush();
            client_.stop();
            last_result_ = Result::Refused;
            return Result::Refused;
        }
        phase_ = Phase::Header;
        header_len_ = 0;
        last_activity_ms_ = millis();
        logf(config.verbose, "[OTA] client connected -- starting transfer\n");
    }

    if (!allowed) {
        if (phase_ == Phase::Receiving)
            Update.abort();
        return finish(Result::Refused,
                      "aborted: board left the state that allows updates");
    }

    return phase_ == Phase::Header ? stepHeader() : stepReceive();
}

Result Server::stepHeader() {
    while (header_len_ < sizeof(header_) && client_.available() > 0) {
        int b = client_.read();
        if (b < 0)
            break;
        header_[header_len_++] = static_cast<uint8_t>(b);
        last_activity_ms_ = millis();
    }
    if (header_len_ < sizeof(header_)) {
        if (millis() - last_activity_ms_ > config.timeout_ms)
            return finish(Result::HeaderTimeout,
                          "timed out waiting for the 4-byte size header");
        return Result::InProgress;
    }

    image_bytes_ = (static_cast<uint32_t>(header_[0]) << 24) |
                   (static_cast<uint32_t>(header_[1]) << 16) |
                   (static_cast<uint32_t>(header_[2]) << 8) |
                   static_cast<uint32_t>(header_[3]);
    if (image_bytes_ == 0 || image_bytes_ > config.max_image_bytes) {
        Serial.print("[OTA] announced size: ");
        Serial.println(image_bytes_);
        return finish(Result::BadSize, "implausible image size");
    }
    logf(config.verbose, "[OTA] image size: %u bytes\n",
         static_cast<unsigned>(image_bytes_));

    // Tell the board before touching flash -- the hotfire boards use this to
    // freeze their address so they cannot re-address mid-flash.
    if (on_start_)
        on_start_(on_start_data_, image_bytes_);

    if (!Update.begin(image_bytes_)) {
        Update.printError(Serial);
        return finish(Result::BeginFailed, "Update.begin() refused");
    }
    received_ = 0;
    last_percent_bucket_ = -1;
    last_activity_ms_ = millis();
    phase_ = Phase::Receiving;
    return Result::InProgress;
}

Result Server::stepReceive() {
    int available = client_.available();
    if (available <= 0) {
        if (millis() - last_activity_ms_ > config.timeout_ms) {
            Update.abort();
            return finish(Result::DataTimeout,
                          "transfer stalled partway through");
        }
        return Result::InProgress;
    }

    int to_read = available < static_cast<int>(sizeof(buf_))
                      ? available
                      : static_cast<int>(sizeof(buf_));
    const uint32_t remaining = image_bytes_ - received_;
    if (static_cast<uint32_t>(to_read) > remaining)
        to_read = static_cast<int>(remaining);

    int bytes_read = client_.read(buf_, to_read);
    if (bytes_read <= 0)
        return Result::InProgress;

    if (Update.write(buf_, bytes_read) != static_cast<size_t>(bytes_read)) {
        Update.printError(Serial);
        Update.abort();
        return finish(Result::WriteFailed, "flash write came up short");
    }

    received_ += bytes_read;
    last_activity_ms_ = millis();

    if (on_progress_)
        on_progress_(on_progress_data_, received_, image_bytes_);

    int percent = static_cast<int>((received_ * 100UL) / image_bytes_);
    if (percent / 5 != last_percent_bucket_) {
        last_percent_bucket_ = percent / 5;
        logf(config.verbose, "[OTA] progress: %d%% (%u / %u bytes)\n",
             percent, static_cast<unsigned>(received_),
             static_cast<unsigned>(image_bytes_));
    }

    if (received_ < image_bytes_)
        return Result::InProgress;

    logf(config.verbose, "[OTA] all bytes received -- finalizing\n");
    if (!Update.end(true)) {
        Update.printError(Serial);
        return finish(Result::EndFailed, "image failed validation");
    }
    return finish(Result::Success, nullptr);
}

Result Server::finish(Result r, const char* why) {
    phase_ = Phase::Listening;
    last_result_ = r;
    if (on_end_)
        on_end_(on_end_data_, r);

    if (r != Result::Success) {
        // Always printed: a silent OTA failure is worse than a noisy one.
        Serial.print("[OTA] ERROR: ");
        Serial.println(why);
        Serial.flush();
        client_.stop();
        return r;
    }

    Serial.println("[OTA] update successful");
    Serial.flush();
    client_.println("OK");
    client_.flush();
    client_.stop();
    if (config.reboot_on_success) {
        Serial.println("[OTA] rebooting into the new image");
        Serial.flush();
        delay(500);
        ESP.restart();
    }
    return r;
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

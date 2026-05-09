#ifndef DAQ_MESSAGE_FACTORY_HPP
#define DAQ_MESSAGE_FACTORY_HPP

#include <array>
#include <cstdint>
#include <cstring>
#include <tuple>
#include <type_traits>
#include <utility>

namespace comms {

// Forward declaration
template <typename T>
struct MessageSizeHelper;

/**
 * @brief CommsMessage - Template-based message serialization
 *
 * Standalone implementation for DAQ system.
 * Provides type-safe message definition and serialization.
 */
template <typename... Fields>
struct CommsMessage {
    std::tuple<Fields...> fields;

    // Default constructor
    CommsMessage() : fields(std::make_tuple(Fields()...)) {
    }

    // Variadic constructor
    CommsMessage(Fields... args) : fields(std::make_tuple(std::forward<Fields>(args)...)) {
    }

    template <std::size_t Index>
    auto& getField() {
        return std::get<Index>(fields);
    }

    template <std::size_t Index>
    const auto& getField() const {
        return std::get<Index>(fields);
    }

    template <std::size_t Index, typename ValueType>
    void setField(ValueType&& value) {
        std::get<Index>(fields) = std::forward<ValueType>(value);
    }

    constexpr std::size_t get_size() const {
        return std::tuple_size<std::tuple<Fields...>>::value;
    }

    // Serialize the tuple to a raw buffer with packed layout
    // Handles nested CommsMessage structures recursively
    // CRITICAL: Match FSW's Serializer::write() behavior exactly - flatten nested structures
    void serialize(uint8_t* buffer) const {
        std::size_t offset = 0;
        std::apply(
            [&](const auto&... field_vals) {
                ((serialize_field(buffer, offset, field_vals)), ...);
            },
            fields);
    }

    // Deserialize the tuple from a raw buffer with packed layout
    void deserialize(const uint8_t* buffer) {
        std::size_t offset = 0;
        std::apply(
            [&](auto&... field_vals) {
                ((std::memcpy(&field_vals, buffer + offset, sizeof(field_vals)),
                  offset += sizeof(field_vals)),
                 ...);
            },
            fields);
    }

    // Compute the serialized size of this message
    static constexpr std::size_t nbytes() {
        return (MessageSizeHelper<Fields>::value + ... + 0);
    }

private:
    // Helper to serialize a single field (handles nested CommsMessage and std::array)
    // CRITICAL: Match FSW's Serializer::write() behavior exactly
    template <typename T>
    void serialize_field(uint8_t* buffer, std::size_t& offset, const T& field) const {
        if constexpr (is_comms_message_v<T>) {
            // Nested CommsMessage - flatten by writing each field individually (matching FSW's
            // Serializer::write)
            std::apply(
                [&](const auto&... nested_fields) {
                    ((serialize_field(buffer, offset, nested_fields)), ...);
                },
                field.fields);
        } else if constexpr (is_std_array_v<T>) {
            // std::array - write each element individually (matching FSW's Serializer::write for
            // std::array)
            for (const auto& item : field) {
                serialize_field(buffer, offset, item);
            }
        } else {
            // Primitive type - memcpy directly (matching FSW's Serializer::write for
            // TrivialSerializable)
            std::memcpy(buffer + offset, &field, sizeof(field));
            offset += sizeof(field);
        }
    }

    // Type trait to detect std::array
    template <typename T>
    struct is_std_array : std::false_type {};

    template <typename T, std::size_t N>
    struct is_std_array<std::array<T, N>> : std::true_type {};

    template <typename T>
    static constexpr bool is_std_array_v = is_std_array<T>::value;

    // Type trait to detect CommsMessage
    template <typename T>
    struct is_comms_message : std::false_type {};

    template <typename... Ts>
    struct is_comms_message<CommsMessage<Ts...>> : std::true_type {};

    template <typename T>
    static constexpr bool is_comms_message_v = is_comms_message<T>::value;

    // Helper to calculate size of a type (handles nested CommsMessage)
    template <typename T>
    struct MessageSizeHelper {
        static constexpr std::size_t value = sizeof(T);
    };

    template <typename... Ts>
    struct MessageSizeHelper<CommsMessage<Ts...>> {
        static constexpr std::size_t value = (MessageSizeHelper<Ts>::value + ... + 0);
    };
};

}  // namespace comms

// Helper to get message size at compile time (outside namespace for convenience)
// Handles nested CommsMessage structures recursively
template <typename T>
struct MessageSize;

template <typename... Ts>
struct MessageSize<comms::CommsMessage<Ts...>> {
    static constexpr std::size_t value = (MessageSize<Ts>::value + ... + 0);
};

// Base template for non-CommsMessage types (use sizeof)
template <typename T>
struct MessageSize {
    static constexpr std::size_t value = sizeof(T);
};

#endif  // DAQ_MESSAGE_FACTORY_HPP

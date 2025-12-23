#ifndef MESSAGE_FACTORY_HPP
#define MESSAGE_FACTORY_HPP

#include <tuple>
#include <utility>
#include <array>
#include <cstring>


/* (MAX_SIZE - 1) - DESIRED_INDEX  Deals with the reverse indexing */ 

template <typename... Fields>
struct MessageFactory {
    std::tuple<Fields...> fields;

    // default constructor -- avoids direct initialization
    MessageFactory() : fields(std::make_tuple(Fields()...)) {}

    // variadic constructor
    MessageFactory(Fields... args)
        : fields(std::make_tuple(std::forward<Fields>(args)...)) {}

    template <std::size_t Index>
    auto& getField() {
        return std::get<Index>(fields);
    }

    // const-interface to get()
    template <std::size_t Index>
    const auto& getField() const {
        return std::get<Index>(fields);
    }

    template <std::size_t Index, typename ValueType>
    void setField(ValueType&& value) {
        // perfect forwarding/move semantics invoked
        std::get<Index>(fields) = std::forward<ValueType>(value);
    }

    constexpr std::size_t get_size() const {
        return std::tuple_size<std::tuple<Fields...>>::value;
    }

    // Serialize the tuple to a raw buffer with packed layout
    void serialize(uint8_t* buffer) const {
        std::size_t offset = 0;
        std::apply([&](const auto&... fields) {
            ((std::memcpy(buffer + offset, &fields, sizeof(fields)), offset += sizeof(fields)), ...);
        }, fields);
    }

    // Deserialize the tuple from a raw buffer with packed layout
    void deserialize(const uint8_t* buffer) {
        std::size_t offset = 0;
        std::apply([&](auto&... fields) {
            ((std::memcpy(&fields, buffer + offset), offset += sizeof(fields)), ...);
        }, fields);
    }

};

template <typename T>
struct MessageSize;

template <typename... Ts>
struct MessageSize<MessageFactory<Ts...>> {
    static constexpr std::size_t value = (sizeof(Ts) + ... + 0);
};

#endif  // MESSAGE_FACTORY_HPP

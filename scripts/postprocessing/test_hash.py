def fnv1a_64(s):
    hash = 0xCBF29CE484222325
    for c in s[:63]:  # Elodin code caps at 64 chars (index 63)
        hash ^= ord(c)
        hash &= 0xFFFFFFFFFFFFFFFF
        hash *= 0x00000100000001B3
        hash &= 0xFFFFFFFFFFFFFFFF
    return hash & ~(1 << 63)


test_names = [
    "PT.Fuel_Tank.timestamp_ns",
    "PT.Fuel_Tank.channel_id",
    "PT.Fuel_Tank.raw_adc_counts",
    "PT.Fuel_Tank.sample_ts_ms",
    "PT.Fuel_Tank.status",
]

for name in test_names:
    print(f"{name}: {fnv1a_64(name)}")

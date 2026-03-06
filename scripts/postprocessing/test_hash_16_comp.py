def fnv1a_32(s):
    h = 0x811C9DC5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def fnv1a_16_xor(s):
    h = fnv1a_32(s)
    return (h >> 16) ^ (h & 0xFFFF)


test_names = [
    "PT.GN2_Regulated.timestamp_ns",
    "PT.GN2_Regulated.channel_id",
    "PT.GN2_Regulated.raw_adc_counts",
    "PT.GN2_Regulated.sample_ts_ms",
    "PT.GN2_Regulated.status",
]
for name in test_names:
    print(f"{name}: {fnv1a_16_xor(name)}")

def fnv1a_32(s):
    h = 0x811C9DC5
    for c in s:
        h ^= ord(c)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def fnv1a_16_xor(s):
    h = fnv1a_32(s)
    return (h >> 16) ^ (h & 0xFFFF)


print(fnv1a_16_xor("_metadata"))

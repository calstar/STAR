"""Keep build paths out of the ELF SHA-256 that ESP-IDF images carry.

PlatformIO extra script for `framework = arduino, espidf` projects, after the
framework has set its flags:

    extra_scripts = post:../tools/stripped_elf_image.py

esptool's elf2image writes the SHA-256 of the whole ELF into the image's app
description whenever the app has one (every IDF build does), with or without
`--elf-sha256-offset`. The ELF carries debug info, and IDF's own components keep
their build paths in it, so the same source built in two checkouts gave images
that differed only in those 32 bytes -- and so had different digests (see
reproducible_build.py for why that matters).

So the image is made from a copy of the ELF with symbols and debug info
stripped. The loadable sections, and so the code that runs, are the same bytes;
only the hash in the app description changes, to one that names the code rather
than the checkout. firmware.elf itself is untouched, for debugging.
"""

import os

Import("env")  # noqa: F821  (injected by PlatformIO/SCons)

_objcopy = os.path.join(
    os.path.dirname(env.WhereIs(env.subst("$CC")) or ""),  # noqa: F821
    env.subst("$CC").replace("gcc", "objcopy"),  # noqa: F821
)
env.Replace(  # noqa: F821
    ELF2BINCMD=(
        f'"{_objcopy}" --strip-all $SOURCES ${{TARGET}}.stripped.elf && '
        '"$PYTHONEXE" "$OBJCOPY" $ELF2BINFLAGS -o $TARGET ${TARGET}.stripped.elf'
    )
)
print(f"[stripped_elf_image] image built from a stripped ELF ({os.path.basename(_objcopy)})")

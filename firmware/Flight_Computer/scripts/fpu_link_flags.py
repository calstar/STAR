# PlatformIO extra script for env:flight.
#
# The STM32H723 has a double-precision FPU, and CubeMX builds with the
# hard-float ABI (-mfpu=fpv5-d16 -mfloat-abi=hard). build_flags only reach the
# compiler, so the linker would pick the soft-float C library and the link
# would fail on mixed ABIs. This passes the same flags to the assembler and the
# linker, as CubeMX's cmake/gcc-arm-none-eabi.cmake does. It also links
# newlib-nano (--specs=nano.specs) like that file: the full newlib's printf
# family alone is ~29 KB of flash.
Import("env")  # noqa: F821  (provided by PlatformIO/SCons)

FPU = ["-mfpu=fpv5-d16", "-mfloat-abi=hard"]

env.Append(
    ASFLAGS=FPU,
    LINKFLAGS=FPU + ["--specs=nano.specs", "-Wl,--print-memory-usage"],
)  # noqa: F821

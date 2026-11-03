# Vendor code

Unmodified copies of ITE's IT930x bridge / IT913x demodulator API and firmware headers, from
[`soralis0912/it930x_driver_native`](https://github.com/soralis0912/it930x_driver_native) at commit
`64fd4f3fd04cd8c19855250ebd88278734d4eba6`:

- everything here except `inttype.h`, `type.h`, `usb2impl.h`, `user.c`, `user.h` and `userdef.h` is from `api/`;
- those six are from `src/`.

ITE wrote this code and the firmware it contains. That repository has no licence file, so these
files carry no licence from this project. Do not edit them: changes belong in `../hides_rx.c` or `../shim/`,
which adapt them to a user-space libusb transport.

# Zigbee Adapter

Zigbee device adapter for WebThings Gateway.

## Compatibility

This adapter is compatible with the following USB dongles:

* Digi XStick2 (XU-Z11)

* RaspBee module plugged into a Raspberry Pi
  * RaspBee module needs to be connected with UART PL011, not the mini UART, and
    be accesssible on /dev/ttyAMA0.
  * In `/boot/config.txt` add `dtoverlay=pi3-miniuart-bt` in section `[all]`
  * In `/boot/cmdline.txt` remove `console=tty1` to disable console on tty1
  * Notes on the UART config: [UART Configuration - Raspberry Pi Documentation](https://www.raspberrypi.org/documentation/configuration/uart.md)

* ConBee Zigbee USB stick

* ConBee II Zigbee USB stick

* TI CC253x-based dongles

  * These must be flashed with the firmware in the `firmware` directory of
    this repository, following [these instructions](https://www.zigbee2mqtt.io/getting_started/flashing_the_cc2531.html),
    or using [Raspberry Pi](https://lemariva.com/blog/2019/07/zigbee-flashing-cc2531-using-raspberry-pi-without-cc-debugger)
  * Last time [ITEAD](https://www.itead.cc/cc2531-usb-dongle.html) sells them
    preprogrammed with some ZNP firmware - probably working with this plugin.

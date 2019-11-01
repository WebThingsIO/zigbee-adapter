## Overview

Zigbee devices each have a unique 64-bit ID, which is used by the
adapter to identify devices. Once a network is setup, each device
gets dynamically assigned a 16-bit network address. This 16-bit network
address is what's used for sending/receiving packets. The 16-bit address
can change over time.

Each device has a collection of clusters, and each cluster has a collection
of attributes. Usually the type of device can be deduced by looking at
the supported clusters, but often more detailed information is needed
(to say differentiate between a colored light and a simple on/off light).

## Basic Flow

The serial prober probes all of the USB serial ports looking for a
Zigbee dongle. When one is found, the appropriate driver is instantiated.

The driver initializes the dongle, and then once completed, calls
adapterInitialized, which starts the stack proper.

The zigbee adapter then initializes known nodes from the zb-XXXXXX.json file
(where XXXXXX is the 64-bit ID of the zigbee dongle), and does a scan
of immediate neighbors.

If there is still information to be collected from a device, then messages
will be sent to continue that process.

The information collected from each device consists of the following:
- A list of active endpoints
- For each endpoint, a simple descriptor, which contains a list
  of input and output clusters. Input clusters are what the gateway
  normally uses to control a device. Output clusters are used by devices
  like the IKEA motion sensor when it wants to control a light.
- Once the input and output clusters are known, the adpapter looks for
  various cluster attributes which the classifier needs in order to
  figure out the type of device it is. This includes the lighting color
  control (used for most lights) and IAS zone information (used by many
  alarm style sensors.)

All of the information needed by the classifier should be persisted in
the zb-XXXX.json file, so that we don't need to re-query each time the
gateway starts up. This is especially important for battery powered
devices which may only checkin once every couple of hours.

Once all of the classifier attributes have been collected, the classifier
is called.

The classifier then looks at the information collected so far and determines
what type of device it is, and which properties it should have.

Generally speaking, each property will map to a single attribute. Sometimes
a property will map to multiple attributes (like hue and saturation).

Zigbee uses a process called binding and reporting to cause attribute
updates to be reported back to the gateway. When adding properties,
configReport information can be specified (how much change should cause a
a report to be generated). ConfigReporting, in turn,
causes bindings to be setup (the binding determines where the reports
go). Many devices have limited resources to store the ConfigReporting
information and will often send reports as a group of attributes. So far
I've only noticed this being a real issue with the thermostats. This is
why not every attribute has configReporting enabled.

## Notes

The population of cluster attribute information takes place through
ZigbeeAdapter::populateNodeInfo and populateXxxx

These functions have a few important semantics.
1 - You should be able to call populateNodeInfo and it should only
    do something if something needs to be done. i.e. it should retain
    enough state to determine whether it still has work to do.
2 - Every call to read some data should have a callback and usually a
    timeoutFunc.
    The callback will be called when the readRsp completes and generally
    should wind up calling the populateXxx method again.
3 - The populateXxx methods need to protect themselves from issuing the
    same read over and over again. So for example looking at
    populateClassifierAttributes reading the zoneType.
    - if node.readingZoneType is set, then it should just return
    - Otherwise it should issue a read for the zoneType
      - the callback should clear readingZoneType and wind up
        calling back into populateClassifierAttributes (which it does
        indirectly through addIfReady)
      - the timeoutFunc should clear readingZoneType. This means that
        the node didn't respond, but when we hear from it again,
        populateNodeInfo will get called again and we'll requery the zoneType.

## ToDo

Currently, there is only a single queue of outgoing commands, and
sometimes this causes problems. The way the command queue works, there
are often waits for a particular response is received before the next
command can be sent. What can happen is that a single device which has
decided to go quiet can "hang" the queue for a while until things timeout.

It would be better if there were a queue for each device. Then a
non-responding device wouldn't hang up other devices.

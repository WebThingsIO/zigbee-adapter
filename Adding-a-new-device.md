## Adding a new device

Use the cli (described in the zwave adding a new device document).

You can then use the discover command on the cli to trigger attribute
discovery. The output will be visible in the gateway log.

For example, with a sylvania 2-button switch:

```
cli https://192.168.1.20:4443 zb-8418260000e8f328> discover 1 0402
```
will cause the following to be displayed in the log:
```
2019-10-30 16:53:44.790 INFO   : zigbee: discover: **** Starting discovery for node: zb-8418260000e8f328 endpointNum: 1 clusterId: 0402 *****
2019-10-30 16:53:44.791 INFO   : zigbee: discover:   ModelId: 3130
2019-10-30 16:53:45.045 INFO   : zigbee: discover:       AttrId: tolerance ( 3) dataType: uint16 (33) data: 200
2019-10-30 16:53:45.046 INFO   : zigbee: discover:   Endpoint 1 ProfileID: 0104
2019-10-30 16:53:45.046 INFO   : zigbee: discover:   Endpoint 1 DeviceID: 0001
2019-10-30 16:53:45.046 INFO   : zigbee: discover:   Endpoint 1 DeviceVersion: 0
2019-10-30 16:53:45.046 INFO   : zigbee: discover:   Input clusters for endpoint 1
2019-10-30 16:53:45.047 INFO   : zigbee: discover:     0402 - msTemperatureMeasurement
2019-10-30 16:53:46.013 INFO   : zigbee: discover:       AttrId: measuredValue ( 0) dataType: int16 (41) data: 12430
2019-10-30 16:53:46.522 INFO   : zigbee: discover:       AttrId: minMeasuredValue ( 1) dataType: int16 (41) data: -4000
2019-10-30 16:53:47.019 INFO   : zigbee: discover:       AttrId: maxMeasuredValue ( 2) dataType: int16 (41) data: 12500
2019-10-30 16:53:47.514 INFO   : zigbee: discover:       AttrId: tolerance ( 3) dataType: uint16 (33) data: 200
2019-10-30 16:53:47.515 INFO   : zigbee: discover:   Output clusters for endpoint 1
2019-10-30 16:53:47.515 INFO   : zigbee: discover: ***** Discovery done for node: zb-8418260000e8f328 *****
```

Note that since the device is battery powered you may need to do the
discovery very quickly after interacting with the device (while it's still
awake) otherwise the device won't see the discover request.

The output of the discovery should show which attrbutes are supported for
a particular cluster.

The clusterId member of https://github.com/dhylands/zcl-id/blob/master/definitions/common.json
has the mapping of names to numbers for all of the "known" clusters.

https://github.com/dhylands/zcl-id/blob/master/definitions/cluster_defs.json
typically contains all of the attributes available for each cluster.
I've had to modify these files, which is why we're using a fork.

Any given device will only support a subset of the available attributes.
Some devices don't respond to discovery for some clusters and do for other
clusters.

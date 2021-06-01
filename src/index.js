/**
 *
 * index.js - Loads the Zigbee adapter.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const { Database } = require('gateway-addon');
const { PACKAGE_ID } = require('./constants');
const SerialProber = require('serial-prober');
const { Zigbee2MqttDriver } = require('./zigbee2mqtt/zigbee2mqtt-driver');
const SerialPort = require('serialport');

const XBEE_FTDI_FILTER = {
  // Devices like the UartSBee, use a generic FTDI chip and with
  // an XBee S2 programmed with the right firmware can act like
  // a Zigbee coordinator.
  vendorId: '0403',
  productId: '6001',
  manufacturer: 'FTDI',
};

const xbeeSerialProber = new SerialProber({
  name: 'XBee',
  allowAMASerial: false,
  baudRate: 9600,
  // XBee Get API Mode Command
  probeCmd: [
    0x7e, // Start of frame
    0x00,
    0x04, // Payload Length
    0x08, // AT Command Request
    0x01, // Frame ID
    0x41,
    0x50, // AP - API Enable
    0x65, // Checksum
  ],
  probeRsp: [
    0x7e, // Start of frame
    0x00,
    0x06, // Payload length
    0x88, // AT Command Response
    0x01, // Frame ID
    0x41,
    0x50, // AP
    // This would normally be followed by the current API mode, and a
    // checksum, but since we don't know those will be, we only match on
    // the first part of the response.
  ],
  filter: [
    {
      // The green Zigbee dongle from Digi has a manufacturer of 'Digi'
      // even though it uses the FTDI vendorId.
      vendorId: /0403/i,
      productId: /6001/i,
      manufacturer: 'Digi',
    },
  ],
});

const conbeeSerialProber = new SerialProber({
  name: 'conbee',
  allowAMASerial: false,
  baudRate: 38400,
  // conbee VERSION Command
  probeCmd: [
    0xc0, // END - SLIP Framing
    0x0d, // VERSION Command
    0x01, // Sequence number
    0x00, // Reserved - set to zero
    0x05,
    0x00, // Frame length
    0xed,
    0xff, // CRC
    0xc0, // END - SLIP framing
  ],
  probeRsp: [
    0xc0, // END - SLIP framing
    0x0d, // VERSION Command
    0x01, // Sequence NUmber
    0x00, // Reserved
    0x09,
    0x00, // Frame length
    // This would normally be followed a 4 byte version code, CRC, and END
    // but since we don't know what those will be we only match on the first
    // part of the response.
  ],
  filter: [
    {
      vendorId: /0403/i,
      productId: /6015/i,
    },
    {
      vendorId: /1cf1/i,
      productId: /0030/i,
    },
  ],
});

// cloned from conbeeSerialProber, just changing the probeCmd sequence
// Assumes that if both probes could succeed, the first will have taken
// ownership of the serial port before the 2nd is instantiated
const conbeeNewerFirmwareSerialProber = new SerialProber({
  name: 'conbee',
  allowAMASerial: false,
  baudRate: 38400,
  // conbee VERSION Command
  probeCmd: [
    0xc0, // END - SLIP Framing
    0x0d, // VERSION Command
    0x01, // Sequence number
    0x00, // Reserved - set to zero
    0x09,
    0x00, // Frame length
    0x00,
    0x00,
    0x00,
    0x00, // additional VERSION payload / padding
    0xe9,
    0xff, // CRC
    0xc0, // END - SLIP framing
  ],
  probeRsp: [
    0xc0, // END - SLIP framing
    0x0d, // VERSION Command
    0x01, // Sequence NUmber
    0x00, // Reserved
    0x09,
    0x00, // Frame length
    // This would normally be followed a 4 byte version code, CRC, and END
    // but since we don't know what those will be we only match on the first
    // part of the response.
  ],
  filter: [
    {
      vendorId: /0403/i,
      productId: /6015/i,
    },
    {
      vendorId: /1cf1/i,
      productId: /0030/i,
    },
  ],
});

const cc2531SerialProber = new SerialProber({
  name: 'cc2531',
  baudRate: 115200,
  allowAMASerial: false,
  probeCmd: [
    0xfe, // SOF
    0x00, // length
    0x21,
    0x01, // CMD: PING REQ
    0x20, // FCS
  ],

  probeRsp: [
    0xfe,
    0x02,
    0x61,
    0x01,
    // CAPABILITIES
  ],

  filter: [
    {
      vendorId: /0451/i,
      productId: /16a8/i,
    },
  ],
});

const PROBERS = [
  xbeeSerialProber,
  conbeeSerialProber,
  cc2531SerialProber,
  conbeeNewerFirmwareSerialProber,
];

// Scan the serial ports looking for an XBee adapter.
async function loadZigbeeAdapters(addonManager, _, errorCallback) {
  let allowFTDISerial = false;
  let allowAMASerial = false;

  let config = {};
  // Attempt to move to new config format
  const db = new Database(PACKAGE_ID);
  await db
    .open()
    .then(() => {
      return db.loadConfig();
    })
    .then((cfg) => {
      config = cfg;

      if (config.hasOwnProperty('discoverAttributes')) {
        delete config.discoverAttributes;
      }

      if (config.hasOwnProperty('scanChannels') && typeof config.scanChannels === 'string') {
        config.scanChannels = parseInt(config.scanChannels, 16);
      }
      allowFTDISerial = config.allowFTDISerial;
      allowAMASerial = config.allowAMASerial;

      if (config.hasOwnProperty('debug')) {
        console.log(`DEBUG config = '${config.debug}'`);
        require('./zb-debug').set(config.debug);
      }

      return db.saveConfig(config);
    });

  let zigbee2mqttConfigured = false;

  if (
    config.zigbee2mqtt &&
    config.zigbee2mqtt.zigbee2mqttAdapters &&
    config.zigbee2mqtt.zigbee2mqttAdapters.length > 0
  ) {
    zigbee2mqttConfigured = true;
  }

  for (const stick of config.sticks || []) {
    console.log(`Creating ${stick.type} driver for ${stick.port}`);

    switch (stick.type) {
      case 'xbee': {
        const XBeeDriver = require('./driver/xbee');
        const serialPort = new SerialPort(stick.port, {
          baudRate: 9600,
          lock: true,
        });
        new XBeeDriver(addonManager, config, stick.port, serialPort);
        break;
      }
      case 'conbee': {
        const ConBeeDriver = require('./driver/conbee');
        const serialPort = new SerialPort(stick.port, {
          baudRate: 38400,
          lock: true,
        });
        new ConBeeDriver(addonManager, config, stick.port, serialPort);
        break;
      }
      case 'zstack': {
        const ZStackDriver = require('./driver/zstack');
        const serialPort = new SerialPort(stick.port, {
          baudRate: 115200,
          lock: true,
        });
        new ZStackDriver(addonManager, config, stick.port, serialPort);
        break;
      }
    }
  }

  if (!config.deactivateProbing) {
    console.log('Probing serial ports');

    const { DEBUG_serialProber } = require('./zb-debug').default;
    SerialProber.debug(DEBUG_serialProber);
    if (allowFTDISerial) {
      xbeeSerialProber.param.filter.push(XBEE_FTDI_FILTER);
    }
    if (allowAMASerial) {
      conbeeSerialProber.param.allowAMASerial = true;
    }
    SerialProber.probeAll(PROBERS)
      .then((matches) => {
        if (matches.length == 0) {
          SerialProber.listAll()
            .then(() => {
              if (!zigbee2mqttConfigured) {
                errorCallback(PACKAGE_ID, 'No Zigbee dongle found');
              } else {
                console.debug('No Zigbee dongle found');
              }
            })
            .catch((err) => {
              if (!zigbee2mqttConfigured) {
                errorCallback(PACKAGE_ID, err);
              } else {
                console.debug(`Could not probe serial ports: ${err}`);
              }
            });
          return;
        }
        // We put the driver requires here rather than at the top of
        // the file so that the debug config gets initialized before we
        // import the driver class.
        const XBeeDriver = require('./driver/xbee');
        const ConBeeDriver = require('./driver/conbee');
        const ZStackDriver = require('./driver/zstack');
        const driver = {
          [xbeeSerialProber.param.name]: XBeeDriver,
          [conbeeSerialProber.param.name]: ConBeeDriver,
          [cc2531SerialProber.param.name]: ZStackDriver,
          [conbeeNewerFirmwareSerialProber.param.name]: ConBeeDriver,
        };
        for (const match of matches) {
          new driver[match.prober.param.name](
            addonManager,
            config,
            match.port.path,
            match.serialPort
          );
        }
      })
      .catch((err) => {
        if (!zigbee2mqttConfigured) {
          errorCallback(PACKAGE_ID, err);
        } else {
          console.debug(`Could not load serial drivers: ${err}`);
        }
      });
  }

  new Zigbee2MqttDriver(addonManager, config);
}

module.exports = loadZigbeeAdapters;

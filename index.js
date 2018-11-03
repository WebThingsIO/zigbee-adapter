/**
 *
 * index.js - Loads the Zigbee adapter.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const {Database} = require('gateway-addon');
const SerialProber = require('serial-prober');

const XBEE_FTDI_FILTER = {
  // Devices like the UartSBee, use a generic FTDI chip and with
  // an XBee S2 programmed with the right firmware can act like
  // a Zigbee coordinator.
  vendorId: '0403',
  productId: '6001',
  manufacturer: 'Digi',
};

const xbeeSerialProber = new SerialProber({
  name: 'XBee',
  baudRate: 9600,
  // XBee Get API Mode Command
  probeCmd: [
    0x7e,       // Start of frame
    0x00, 0x04, // Payload Length
    0x08,       // AT Command Request
    0x01,       // Frame ID
    0x41, 0x50, // AP - API Enable
    0x65,       // Checksum
  ],
  probeRsp: [
    0x7e,       // Start of frame
    0x00, 0x06, // Payload length
    0x88,       // AT Command Response
    0x01,       // Frame ID
    0x41, 0x50, // AP
    // This would normally be followed by the current API mode, and a
    // checksum, but since we don't know those will be, we only match on
    // the first part of the response.
  ],
  filter: [
    {
      // The green Zigbee dongle from Digi has a manufacturer of 'Digi'
      // even though it uses the FTDI vendorId.
      vendorId: '0403',
      productId: '6001',
      manufacturer: 'Digi',
    },
  ],
});

const deconzSerialProber = new SerialProber({
  name: 'deConz',
  baudRate: 38400,
  // deConz VERSION Command
  probeCmd: [
    0xc0,       // END - SLIP Framing
    0x0d,       // VERSION Command
    0x01,       // Sequence number
    0x00,       // Reserved - set to zero
    0x05, 0x00, // Frame length
    0xed, 0xff, // CRC
    0xc0,       // END - SLIP framing
  ],
  probeRsp: [
    0xc0,       // END - SLIP framing
    0x0d,       // VERSION Command
    0x01,       // Sequence NUmber
    0x00,       // Reserved
    0x09, 0x00, // Frame length
    // This would normally be followed a 4 byte version code, CRC, and END
    // but since we don't know what those will be we only match on the first
    // part of the response.
  ],
  filter: [
    {
      vendorId: '0403',
      productId: '6015',
    },
  ],
});

const PROBERS = [
  xbeeSerialProber,
  deconzSerialProber,
];

// Scan the serial ports looking for an XBee adapter.
async function loadZigbeeAdapters(addonManager, manifest, errorCallback) {
  let promise;
  let allowFTDISerial = false;

  // Attempt to move to new config format
  if (Database) {
    const db = new Database(manifest.name);
    promise = db.open().then(() => {
      return db.loadConfig();
    }).then((config) => {
      if (config.hasOwnProperty('discoverAttributes')) {
        delete config.discoverAttributes;
      }

      if (config.hasOwnProperty('scanChannels') &&
          typeof config.scanChannels === 'string') {
        config.scanChannels = parseInt(config.scanChannels, 16);
      }
      allowFTDISerial = config.allowFTDISerial;

      if (config.hasOwnProperty('debug')) {
        console.log(`DEBUG config = '${config.debug}'`);
        require('./zb-debug').set(config.debug);
      }

      manifest.moziot.config = config;
      return db.saveConfig(config);
    });
  } else {
    promise = Promise.resolve();
  }
  await promise;

  const {DEBUG_serialProber} = require('./zb-debug');
  SerialProber.debug(DEBUG_serialProber);
  if (allowFTDISerial) {
    xbeeSerialProber.param.filter.push(XBEE_FTDI_FILTER);
  }
  SerialProber.probeAll(PROBERS).then((matches) => {
    if (matches.length == 0) {
      SerialProber.listAll().then(() => {
        errorCallback(manifest.name, 'No Zigbee dongle found');
      }).catch((err) => {
        errorCallback(manifest.name, err);
      });
      return;
    }
    // We put the driver requires here rather than at the top of
    // the file so that the debug config gets initialized before we
    // import the driver class.
    const XBeeDriver = require('./xbee-driver');
    const DeconzDriver = require('./deconz-driver');
    const driver = {
      [xbeeSerialProber.param.name]: XBeeDriver,
      [deconzSerialProber.param.name]: DeconzDriver,
    };
    for (const match of matches) {
      new driver[match.prober.param.name](addonManager,
                                          manifest,
                                          match.port.comName,
                                          match.serialPort);
    }
  });
}

module.exports = loadZigbeeAdapters;

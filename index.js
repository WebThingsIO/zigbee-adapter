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
const SerialPort = require('serialport');


function isDigiPort(port) {
  // Note that 0403:6001 is the default FTDI VID:PID, so we need to further
  // refine the search using the manufacturer.
  return (port.vendorId === '0403' &&
          port.productId === '6001' &&
          port.manufacturer === 'Digi');
}

// Devices like the UartSBee, which can have an XBee S2 programmed with
// the Coordinator API have a generic FTDI chip.
function isFTDIPort(port) {
  return (port.vendorId === '0403' &&
          port.productId === '6001' &&
          port.manufacturer === 'FTDI');
}

// Scan the serial ports looking for an XBee adapter.
//
//    callback(error, port)
//        Upon success, callback is invoked as callback(null, port) where `port`
//        is the port object from SerialPort.list().
//        Upon failure, callback is invoked as callback(err) instead.
//
function findDigiPorts(allowFTDISerial) {
  return new Promise((resolve, reject) => {
    SerialPort.list((error, ports) => {
      if (error) {
        reject(error);
        return;
      }

      const digiPorts = ports.filter(isDigiPort);
      if (digiPorts.length) {
        resolve(digiPorts);
        return;
      }

      if (allowFTDISerial) {
        const ftdiPorts = ports.filter(isFTDIPort);
        if (ftdiPorts.length) {
          resolve(ftdiPorts);
          return;
        }
        reject('No Digi/FTDI port found');
        return;
      }

      reject('No Digi port found');
    });
  });
}

function extraInfo(port) {
  let output = '';
  if (port.manufacturer) {
    output += ` Vendor: ${port.manufacturer}`;
  }
  if (port.serialNumber) {
    output += ` Serial: ${port.serialNumber}`;
  }
  return output;
}

function loadZigbeeAdapters(addonManager, manifest, errorCallback) {
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

  promise.then(() => findDigiPorts(allowFTDISerial)).then((digiPorts) => {
    // We put the ZigbeeAdapter require here rather than at the top of
    // the file so that the debug config gets initialized before we
    // import the adapter class.
    const ZigbeeAdapter = require('./zb-adapter');
    for (const port of digiPorts) {
      // Under OSX, SerialPort.list returns the /dev/tty.usbXXX instead
      // /dev/cu.usbXXX. tty.usbXXX requires DCD to be asserted which
      // isn't necessarily the case for Zigbee dongles. The cu.usbXXX
      // doesn't care about DCD.
      if (port.comName.startsWith('/dev/tty.usb')) {
        port.comName = port.comName.replace('/dev/tty', '/dev/cu');
      }
      new ZigbeeAdapter(addonManager, manifest, port);
    }
  }).catch((error) => {
    // Report the serial ports that we did find.
    console.log('Serial ports that were found:');
    SerialPort.list((serError, ports) => {
      if (serError) {
        console.log('Error:', serError);
        errorCallback(manifest.name, error);
        return;
      }
      for (const port of ports) {
        if (port.vendorId) {
          const vidPid = `${port.vendorId}:${port.productId}`;
          console.log('USB Serial Device', vidPid + extraInfo(port),
                      'found @', port.comName);
        } else {
          console.log('Serial Device found @', port.comName);
        }
      }
      errorCallback(manifest.name, error);
    });
  });
}

module.exports = loadZigbeeAdapters;

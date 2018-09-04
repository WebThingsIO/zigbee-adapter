/**
 *
 * ZigbeeAdapter - Adapter which manages Zigbee devices.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ZigbeeNode = require('./zb-node');
const SerialPort = require('serialport');
const xbeeApi = require('xbee-api');
const at = require('./zb-at');
const util = require('util');
const zdo = require('./zb-zdo');
const zcl = require('zcl-packet');
const zclId = require('zcl-id');
const registerFamilies = require('./zb-families');

let Adapter, Database, utils;
try {
  Adapter = require('../adapter');
  utils = require('../utils');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Adapter = gwa.Adapter;
  Database = gwa.Database;
  utils = gwa.Utils;
}

const C = xbeeApi.constants;
const AT_CMD = at.AT_CMD;

const ZHA_PROFILE_ID = zclId.profile('HA').value;
const ZHA_PROFILE_ID_HEX = utils.hexStr(ZHA_PROFILE_ID, 4);

const CLUSTER_ID_LIGHTINGCOLORCTRL = zclId.cluster('lightingColorCtrl').value;
const CLUSTER_ID_LIGHTINGCOLORCTRL_HEX =
  utils.hexStr(CLUSTER_ID_LIGHTINGCOLORCTRL, 4);

const ATTR_ID_LIGHTINGCOLORCTRL_COLORCAPABILITIES =
  zclId.attr(CLUSTER_ID_LIGHTINGCOLORCTRL, 'colorCapabilities').value;

const CLUSTER_ID_GENOTA = zclId.cluster('genOta').value;
const CLUSTER_ID_GENOTA_HEX = utils.hexStr(CLUSTER_ID_GENOTA, 4);

const CLUSTER_ID_GENPOLLCTRL = zclId.cluster('genPollCtrl').value;
const CLUSTER_ID_GENPOLLCTRL_HEX = utils.hexStr(CLUSTER_ID_GENPOLLCTRL, 4);

const CLUSTER_ID_SSIASZONE = zclId.cluster('ssIasZone').value;
const CLUSTER_ID_SSIASZONE_HEX = utils.hexStr(CLUSTER_ID_SSIASZONE, 4);

const ATTR_ID_SSIASZONE_ZONESTATE =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneState').value;
const ATTR_ID_SSIASZONE_ZONETYPE =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneType').value;
const ATTR_ID_SSIASZONE_ZONESTATUS =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneStatus').value;
const ATTR_ID_SSIASZONE_CIEADDR =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'iasCieAddr').value;

const STATUS_SUCCESS = zclId.status('success').value;

const WAIT_TIMEOUT_DELAY = 1 * 1000;
const EXTENDED_TIMEOUT_DELAY = 10 * 1000;
const WAIT_RETRY_MAX = 3;   // includes initial send

const DEVICE_TYPE = {
  0x30001: 'ConnectPort X8 Gateway',
  0x30002: 'ConnectPort X4 Gateway',
  0x30003: 'ConnectPort X2 Gateway',
  0x30005: 'RS-232 Adapter',
  0x30006: 'RS-485 Adapter',
  0x30007: 'XBee Sensor Adapter',
  0x30008: 'Wall Router',
  0x3000A: 'Digital I/O Adapter',
  0x3000B: 'Analog I/O Adapter',
  0x3000C: 'XStick',
  0x3000F: 'Smart Plug',
  0x30011: 'XBee Large Display',
  0x30012: 'XBee Small Display',
};

// Function which will convert endianess of hex strings.
// i.e. '12345678'.swapHex() returns '78563412'
String.prototype.swapHex = function() {
  return this.match(/.{2}/g).reverse().join('');
};

function serialWriteError(error) {
  if (error) {
    console.log('SerialPort.write error:', error);
    throw error;
  }
}

const SEND_FRAME = 0x01;
const WAIT_FRAME = 0x02;
const EXEC_FUNC = 0x03;
const RESOLVE_SET_PROPERTY = 0x04;
const MIN_COMMAND_TYPE = 0x01;
const MAX_COMMAND_TYPE = 0x04;

class Command {
  constructor(cmdType, cmdData, priority) {
    this.cmdType = cmdType;
    this.cmdData = cmdData;
    this.priority = priority;
  }

  print(adapter, idx) {
    let prioStr = 'p:-';
    if (typeof this.priority !== 'undefined') {
      prioStr = `p:${this.priority}`;
    }

    const idxStr = `| ${`    ${idx}`.slice(-4)}: ${prioStr} `;
    switch (this.cmdType) {
      case SEND_FRAME: {
        adapter.dumpFrame(`${idxStr}SEND:`, this.cmdData, false);
        break;
      }
      case WAIT_FRAME:
        console.log(`${idxStr}WAIT`);
        break;
      case EXEC_FUNC:
        console.log(`${idxStr}EXEC:`, this.cmdData[1].name);
        break;
      case RESOLVE_SET_PROPERTY:
        console.log(`${idxStr}RESOLVE_SET_PROPERTY`);
        break;
      default:
        console.log(`${idxStr}UNKNOWN: ${this.cmdType}`);
    }
  }
}

function FUNC(ths, func, args) {
  return new Command(EXEC_FUNC, [ths, func, args]);
}

class ZigbeeAdapter extends Adapter {
  constructor(addonManager, manifest, port) {
    // The Zigbee adapter supports multiple dongles and
    // will create an adapter object for each dongle.
    // We don't know the actual adapter id until we
    // retrieve the serial number from the dongle. So we
    // set it to zb-unknown here, and fix things up later
    // just before we call addAdapter.
    super(addonManager, 'zb-unknown', manifest.name);

    this.configDir = '.';
    if (process.env.hasOwnProperty('MOZIOT_HOME')) {
      // Check user profile directory.
      const profileDir = path.join(process.env.MOZIOT_HOME, 'config');
      if (fs.existsSync(profileDir) &&
          fs.lstatSync(profileDir).isDirectory()) {
        this.configDir = profileDir;
      }
    }
    this.manifest = manifest;
    this.port = port;

    // debugRawFrames causes the raw serial frames to/from the dongle
    // to be reported.
    this.debugRawFrames = false;

    // debugFrames causes a 1-line summary to be printed for each frame
    // which is sent or received.
    this.debugFrames = false;

    // debugFrameDetail causes detailed information about each frame to be
    // printed.
    this.debugDumpFrameDetail = false;

    // Use debugFlow if you need to debug the flow of the program. This causes
    // prints at the beginning of many functions to print some info.
    this.debugFlow = false;

    // debugFrameParsing causes frame detail about the initial frame, before
    // we do any parsing of the data to be printed. This is useful to enable
    // if the frame parsing code is crashing.
    this.debugFrameParsing = false;

    // debugDiscoverAttributes causes us to ask for and print out the attributes
    // available for each cluster.
    this.debugDiscoverAttributes = false;

    this.frameDumped = false;
    this.isPairing = false;

    this.xb = new xbeeApi.XBeeAPI({
      api_mode: 1,
      raw_frames: this.debugRawFrames,
    });

    this.atAttr = {};
    this.nodes = {};
    this.cmdQueue = [];
    this.running = false;
    this.waitFrame = null;
    this.waitTimeout = null;
    this.waitRetryCount = 0;
    this.lastFrameSent = null;

    this.serialNumber = '0000000000000000';
    this.nextStartIndex = -1;

    this.zdo = new zdo.ZdoApi(this.xb);
    this.at = new at.AtApi();

    if (this.debugRawFrames) {
      this.xb.on('frame_raw', (rawFrame) => {
        console.log('Rcvd:', rawFrame);
        if (this.xb.canParse(rawFrame)) {
          try {
            const frame = this.xb.parseFrame(rawFrame);
            try {
              this.handleFrame(frame);
            } catch (e) {
              console.error('Error handling frame_raw');
              console.error(e);
              console.error(frame);
            }
          } catch (e) {
            console.error('Error parsing raw frame_raw');
            console.error(e);
            console.error(rawFrame);
          }
        }
      });
    } else {
      this.xb.on('frame_object', (frame) => {
        try {
          this.handleFrame(frame);
        } catch (e) {
          console.error('Error handling frame_object');
          console.error(e);
          console.error(frame);
        }
      });
    }

    console.log('Opening serial port', port.comName);
    this.serialport = new SerialPort(port.comName, {
      baudRate: 9600,
    }, (err) => {
      if (err) {
        console.error('SerialPort open err =', err);
      }

      // Hook up the Zigbee raw parser.
      this.serialport.on('data', (chunk) => {
        this.xb.parseRaw(chunk);
      });

      this.queueCommands([
        this.AT(AT_CMD.API_MODE),
        FUNC(this, this.configureApiModeIfNeeded),
        this.AT(AT_CMD.DEVICE_TYPE_IDENTIFIER),
        this.AT(AT_CMD.CONFIGURED_64_BIT_PAN_ID),
        this.AT(AT_CMD.SERIAL_NUMBER_HIGH),
        this.AT(AT_CMD.SERIAL_NUMBER_LOW),
        this.AT(AT_CMD.NETWORK_ADDR_16_BIT),
        this.AT(AT_CMD.OPERATING_64_BIT_PAN_ID),
        this.AT(AT_CMD.OPERATING_16_BIT_PAN_ID),
        this.AT(AT_CMD.OPERATING_CHANNEL),
        this.AT(AT_CMD.SCAN_CHANNELS),
        this.AT(AT_CMD.NODE_IDENTIFIER),
        this.AT(AT_CMD.NUM_REMAINING_CHILDREN),
        this.AT(AT_CMD.ZIGBEE_STACK_PROFILE),
        this.AT(AT_CMD.API_OPTIONS),
        this.AT(AT_CMD.ENCRYPTION_ENABLED),
        this.AT(AT_CMD.ENCRYPTION_OPTIONS),
        FUNC(this, this.configureIfNeeded, []),
        FUNC(this, this.permitJoin, [0]),
        FUNC(this, this.adapterInitialized, []),
      ]);
    });
  }

  // This function is called once the Xbee controller has been initialized.
  adapterInitialized() {
    if (this.debugFlow) {
      console.log('adapterInitialized');
    }
    this.dumpInfo();
    this.id = `zb-${this.serialNumber}`;
    this.manager.addAdapter(this);

    this.deviceInfoFilename = path.join(this.configDir,
                                        `zb-${this.serialNumber}.json`);

    // Use this opportunity to create the node for the Coordinator.
    const coordinator = this.nodes[this.serialNumber] =
      new ZigbeeNode(this, this.serialNumber, this.networkAddr16);

    this.readDeviceInfo().then(() => {
      // Go find out what devices are on the network.
      this.queueCommands(
        this.getManagementLqiCommands(coordinator)
          .concat(this.getManagementRtgCommands(coordinator))
          .concat([
            FUNC(this, this.handleDeviceAdded, [coordinator]),
            FUNC(this, this.startScan),
            FUNC(this, this.scanComplete),
          ]));
    });
  }

  startScan() {
    console.log('----- Scan Starting -----');
    this.scanning = true;
    this.enumerateAllNodes(this.scanNode);
  }

  scanNode(node) {
    if (this.debugFlow) {
      console.log('scanNode: Calling populateNodeInfo');
    }
    this.populateNodeInfo(node);
  }

  scanComplete() {
    this.dumpNodes();
    console.log('----- Scan Complete -----');
    this.saveDeviceInfo();
    this.scanning = false;
  }

  AT(command, frame) {
    return [
      new Command(SEND_FRAME, this.at.makeFrame(command, frame)),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.AT_COMMAND_RESPONSE,
        command: command,
      }),
    ];
  }

  configureApiModeIfNeeded() {
    if (this.debugFlow) {
      console.log('configureApiModeIfNeeded');
    }
    const configCommands = [];
    if (this.apiMode != 1) {
      configCommands.push(this.AT(AT_CMD.API_MODE,
                                  {apiMode: 1}));
      configCommands.push(this.AT(AT_CMD.API_MODE));
    }

    if (configCommands.length > 0) {
      console.log('Setting API mode to 1');
      configCommands.push(this.AT(AT_CMD.WRITE_PARAMETERS));
      this.queueCommandsAtFront(configCommands);
    } else {
      console.log('API Mode already set to 1 (i.e. no need to change)');
    }
  }

  configureIfNeeded() {
    if (this.debugFlow) {
      console.log('configureIfNeeded');
    }
    const configCommands = [];
    if (this.configuredPanId64 === '0000000000000000') {
      configCommands.push(this.AT(AT_CMD.CONFIGURED_64_BIT_PAN_ID,
                                  {configuredPanId: this.operatingPanId64}));
      configCommands.push(this.AT(AT_CMD.CONFIGURED_64_BIT_PAN_ID));
    }
    if (this.zigBeeStackProfile != 2) {
      configCommands.push(this.AT(AT_CMD.ZIGBEE_STACK_PROFILE,
                                  {zigBeeStackProfile: 2}));
      configCommands.push(this.AT(AT_CMD.ZIGBEE_STACK_PROFILE));
    }
    // API Options = 1 allows Explicit Rx frames to ve rcvd
    // API Options = 3 enables ZDO passthrough
    // i.e. Simple Descriptor Request, Active Endpoint Request
    //      and Match Descriptor Requests which come from an
    //      endpoint will be passed through (received).
    if (this.apiOptions != 3) {
      configCommands.push(this.AT(AT_CMD.API_OPTIONS,
                                  {apiOptions: 3}));
      configCommands.push(this.AT(AT_CMD.API_OPTIONS));
    }
    if (this.encryptionEnabled != 1) {
      configCommands.push(this.AT(AT_CMD.ENCRYPTION_ENABLED,
                                  {encryptionEnabled: 1}));
      configCommands.push(this.AT(AT_CMD.ENCRYPTION_ENABLED));
    }
    if (this.encryptionOptions != 2) {
      configCommands.push(this.AT(AT_CMD.ENCRYPTION_OPTIONS,
                                  {encryptionOptions: 2}));
      configCommands.push(this.AT(AT_CMD.ENCRYPTION_OPTIONS));
    }
    let configScanChannels = this.manifest.moziot.config.scanChannels;
    if (typeof configScanChannels === 'string') {
      configScanChannels = parseInt(configScanChannels, 16);
    } else if (typeof configScanChannels !== 'number') {
      configScanChannels = 0x1ffe;
    }
    if (this.scanChannels != configScanChannels) {
      // For reference, the most likely values to use as configScanChannels
      // would be channels 15 and 20, which sit between the Wifi channels.
      // Channel 15 corresponds to a mask of 0x0010
      // Channel 20 corresponds to a mask of 0x0200
      configCommands.push(this.AT(AT_CMD.SCAN_CHANNELS,
                                  {scanChannels: configScanChannels}));
      configCommands.push(this.AT(AT_CMD.SCAN_CHANNELS));
    }
    if (configCommands.length > 0) {
      // We're going to change something, so we might as well set the link
      // key, since it's write only and we can't tell if its been set before.
      configCommands.push(this.AT(AT_CMD.LINK_KEY,
                                  {linkKey: 'ZigBeeAlliance09'}));
      configCommands.push(this.AT(AT_CMD.WRITE_PARAMETERS));

      // TODO: It sends a modem status, but only the first time after the
      //       dongle powers up. So I'm not sure if we need to wait on anything
      //       after doing the WR command.
      // configCommands.push(new Command(WAIT_FRAME, {
      //   type: C.FRAME_TYPE.MODEM_STATUS
      // }));
      this.queueCommandsAtFront(configCommands);
    } else {
      console.log('No configuration required');
    }
  }

  dumpFrame(label, frame, dumpFrameDetail) {
    if (typeof dumpFrameDetail === 'undefined') {
      dumpFrameDetail = this.debugDumpFrameDetail;
    }
    this.frameDumped = true;
    let frameTypeStr = C.FRAME_TYPE[frame.type];
    if (!frameTypeStr) {
      frameTypeStr = `Unknown(0x${frame.type.toString(16)})`;
    }
    let atCmdStr;
    let status;

    switch (frame.type) {
      case C.FRAME_TYPE.AT_COMMAND:
        if (frame.command in AT_CMD) {
          atCmdStr = AT_CMD[frame.command];
        } else {
          atCmdStr = frame.command;
        }
        if (frame.commandParameter.length > 0) {
          console.log(label, frameTypeStr, 'Set', atCmdStr);
          if (dumpFrameDetail) {
            console.log(label, frame);
          }
        } else {
          console.log(label, frameTypeStr, 'Get', atCmdStr);
        }
        break;

      case C.FRAME_TYPE.AT_COMMAND_RESPONSE:
        if (frame.command in AT_CMD) {
          atCmdStr = AT_CMD[frame.command];
        } else {
          atCmdStr = frame.command;
        }
        console.log(label, frameTypeStr, atCmdStr);
        if (dumpFrameDetail) {
          console.log(label, frame);
        }
        break;

      case C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME:
        if (this.zdo.isZdoFrame(frame)) {
          console.log(label, 'Explicit Tx', frame.destination64, 'ZDO',
                      zdo.getClusterIdAsString(frame.clusterId),
                      zdo.getClusterIdDescription(frame.clusterId));
        } else if (this.isZhaFrame(frame)) {
          console.log(label, 'Explicit Tx', frame.destination64,
                      'ZHA', frame.clusterId,
                      zclId.cluster(parseInt(frame.clusterId, 16)).key,
                      frame.zcl.cmd, frame.zcl.payload);
        } else {
          console.log(label, frame.destination64, frame.clusterId);
        }
        if (dumpFrameDetail) {
          console.log(label, util.inspect(frame, {depth: null}));
        }
        break;

      case C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX:
        if (this.zdo.isZdoFrame(frame)) {
          if (frame.hasOwnProperty('status')) {
            status = zclId.status(frame.status);
          } else {
            // Frames sent from the device not in response to an ExplicitTx
            // (like "End Device Announcement") won't have a status.
            status = {
              key: 'none',
              // eslint-disable-next-line no-undefined
              value: undefined,
            };
          }
          if (!status) {
            // Something that zclId doesn't know about.
            status = {
              key: 'unknown',
              value: frame.status,
            };
          }
          console.log(label, 'Explicit Rx', frame.remote64,
                      'ZDO', frame.clusterId,
                      zdo.getClusterIdDescription(frame.clusterId),
                      'status:', status.key, `(${status.value})`);
        } else if (this.isZhaFrame(frame)) {
          if (frame.zcl) {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZHA', frame.clusterId,
                        zclId.cluster(parseInt(frame.clusterId, 16)).key,
                        frame.zcl ? frame.zcl.cmdId : '???', frame.zcl.payload);
          } else {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZHA', frame.clusterId,
                        zclId.cluster(parseInt(frame.clusterId, 16)).key,
                        '??? no zcl ???');
          }
        } else {
          console.log(label, frame.remote64, frame.clusterId);
        }
        if (dumpFrameDetail) {
          console.log(label, util.inspect(frame, {depth: null}));
        }
        break;

      case C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS:
        if (dumpFrameDetail || frame.deliveryStatus !== 0) {
          console.log(label, frameTypeStr,
                      'id:', frame.id,
                      'Remote16:', frame.remote16,
                      'Retries:', frame.transmitRetryCount,
                      'Delivery:',
                      this.getDeliveryStatusAsString(frame.deliveryStatus),
                      'Discovery:',
                      this.getDiscoveryStatusAsString(frame.discoveryStatus));
        }
        break;

      case C.FRAME_TYPE.MODEM_STATUS:
        console.log(label, frameTypeStr, 'modemStatus:',
                    this.getModemStatusAsString(frame.modemStatus));
        break;

      case C.FRAME_TYPE.ROUTE_RECORD:
        if (dumpFrameDetail) {
          console.log(label, frameTypeStr);
          console.log(label, frame);
        }
        break;

      default:
        console.log(label, frameTypeStr);
        if (dumpFrameDetail) {
          console.log(label, frame);
        }
    }
  }

  dumpInfo() {
    let deviceTypeString = DEVICE_TYPE[this.deviceTypeIdentifier];
    if (!deviceTypeString) {
      deviceTypeString = '??? Unknown ???';
    }
    console.log(
      '       Device Type:', `0x${this.deviceTypeIdentifier.toString(16)} -`,
      this.deviceTypeString(this.deviceTypeIdentifier));
    console.log('   Network Address:', this.serialNumber,
                this.networkAddr16);
    console.log('   Node Identifier:', this.nodeIdentifier);
    console.log(' Configured PAN Id:', this.configuredPanId64);
    console.log('  Operating PAN Id:', this.operatingPanId64,
                this.operatingPanId16);
    console.log(' Operating Channel:', this.operatingChannel);
    console.log(' Channel Scan Mask:', this.scanChannels.toString(16));
    console.log('         Join Time:', this.networkJoinTime);
    console.log('Remaining Children:', this.numRemainingChildren);
    console.log('     Stack Profile:', this.zigBeeStackProfile);
    console.log('       API Options:', this.apiOptions);
    console.log('Encryption Enabled:', this.encryptionEnabled);
    console.log('Encryption Options:', this.encryptionOptions);
  }

  dumpNodes() {
    const deviceType = ['Coord ',
                        'Router',
                        'EndDev',
                        '???   '];
    const relationship = ['Parent  ',
                          'Child   ',
                          'Sibling ',
                          'None    ',
                          'Previous'];
    const permitJoins = ['Y', 'N', '?', '?'];

    console.log('----- Nodes -----');
    for (const nodeId in this.nodes) {
      const node = this.nodes[nodeId];
      const name = utils.padRight(node.name, 32);
      console.log('Node:', node.addr64, node.addr16,
                  'Name:', name,
                  'endpoints:', Object.keys(node.activeEndpoints));
      for (const neighbor of node.neighbors) {
        console.log('  Neighbor: %s %s DT: %s R: %s PJ: %s D: %s ' +
                    'LQI: %s',
                    neighbor.addr64,
                    neighbor.addr16,
                    deviceType[neighbor.deviceType],
                    relationship[neighbor.relationship],
                    permitJoins[neighbor.permitJoining],
                    `   ${neighbor.depth}`.slice(-3),
                    `   ${neighbor.lqi}`.slice(-3));
      }
    }
    console.log('-----------------');
  }

  deviceTypeString() {
    if (DEVICE_TYPE.hasOwnProperty(this.deviceTypeIdentifier)) {
      return DEVICE_TYPE[this.deviceTypeIdentifier];
    }
    return '??? Unknown ???';
  }

  readDeviceInfo() {
    return new Promise((resolve) => {
      fs.readFile(this.deviceInfoFilename, 'utf8', (err, data) => {
        if (err) {
          console.log('readDeviceInfo: read failed:', err);
          // ENOENT just means that the configuration file didn't exist. We
          // treat this as a success case.
          if (err.code != 'ENOENT') {
            console.error('Error reading Zigbee device info file:',
                          this.deviceInfoFilename);
            console.error(err);
          }
          // If there are any errors, we just ignore them, and treat it like
          // the device info file doesn't exist.
          resolve();
          return;
        }
        let devInfo;
        try {
          devInfo = JSON.parse(data);
        } catch (err) {
          console.log('readDeviceInfo: JSON.parse failed on:',
                      this.deviceInfoFilename);
          console.log(err);
          resolve();
          return;
        }

        for (const nodeId in devInfo.nodes) {
          const devInfoNode = devInfo.nodes[nodeId];
          let node = this.nodes[nodeId];
          if (!node) {
            node = new ZigbeeNode(this, devInfoNode.addr64, devInfoNode.addr16);
            this.nodes[nodeId] = node;
          }
          node.fromDeviceInfo(devInfoNode);
        }
        resolve();
      });
    });
  }

  saveDeviceInfoDeferred() {
    // In order to reduce the number of times we rewrite the device info
    // we defer writes for a time.
    const timeoutSeconds = this.debugFrames ? 1 : 120;

    if (this.saveDeviceInfoTimeout) {
      // already a timeout setup.
      return;
    }
    this.saveDeviceInfoTimeout = setTimeout(() => {
      this.saveDeviceInfoTimeout = null;
      this.saveDeviceInfo();
    }, timeoutSeconds * 1000);
  }

  saveDeviceInfo() {
    const devInfo = {
      info: {
        deviceType: `0x${this.deviceTypeIdentifier.toString(16)}`,
        deviceTypeStr: `${this.deviceTypeString(this.deviceTypeIdentifier)}`,
        serialNumber: this.serialNumber,
        nodeIdentifier: this.nodeIdentifier,
        configuredPanId64: this.configuredPanId64,
        operatingPanId64: this.operatingPanId64,
        operatingPanId16: this.operatingPanId16,
        operatingChannel: this.operatingChannel,
        scanChannels: `0x${this.scanChannels.toString(16)}`,
        apiOptions: this.apiOptions,
      },
      nodes: {},
    };

    for (const nodeId in this.nodes) {
      const node = this.nodes[nodeId];
      if (!node.isCoordinator) {
        const nodeInfo = node.asDeviceInfo();
        devInfo.nodes[nodeId] = nodeInfo;
      }
    }

    const tmpFilename = `${this.deviceInfoFilename}.tmp`;
    fs.writeFileSync(tmpFilename, JSON.stringify(devInfo, null, '  '));
    fs.renameSync(tmpFilename, this.deviceInfoFilename);

    this.deviceInfoLastSavedTime = process.hrtime();
    if (this.debugFlow) {
      console.log('Saved device information in', this.deviceInfoFilename);
    }
  }

  enumerateAllNodes(iterCb, doneCb) {
    if (this.debugFlow) {
      console.log('enumerateAllNodes');
    }
    this.enumerateIterCb = iterCb;
    this.enumerateDoneCb = doneCb;
    this.enumerateNodes = [];
    for (const nodeId in this.nodes) {
      const node = this.nodes[nodeId];
      if (!node.isCoordinator) {
        this.enumerateNodes.push(node);
      }
    }
    this.enumerateNextNode();
  }

  enumerateNextNode() {
    if (this.debugFlow) {
      console.log('enumerateNextNode');
    }
    const node = this.enumerateNodes.shift();
    if (node) {
      // Note that iterCb should queue it's commands in front of the
      //
      this.queueCommandsAtFront([
        FUNC(this, this.enumerateNextNode, []),
      ]);
      this.enumerateIterCb(node);
    } else if (this.enumerateDonCb) {
      this.enumerateDoneCb(node);
    }
  }

  findNodeFromFrame(frame) {
    const addr64 = frame.remote64;
    const addr16 = frame.remote16;

    // Some devices (like xiaomi) switch from using a proper 64-bit address to
    // using broadcast but still provide the a 16-bit address.
    if (addr64 == 'ffffffffffffffff') {
      return this.findNodeByAddr16(addr16);
    }

    let node = this.nodes[addr64];
    if (!node) {
      // We have both the addr64 and addr16 - go ahead and create a new node.
      node = this.nodes[addr64] = new ZigbeeNode(this, addr64, addr16);
    }
    return node;
  }

  findNodeByAddr16(addr16) {
    for (const nodeId in this.nodes) {
      const node = this.nodes[nodeId];
      if (node.addr16 == addr16) {
        return node;
      }
    }
  }

  flattenCommands(cmdSeq) {
    const cmds = [];
    for (const cmd of cmdSeq) {
      if (cmd.constructor === Array) {
        for (const cmd2 of cmd) {
          assert(cmd2 instanceof Command,
                 '### Expecting instance of Command ###');
          assert(typeof cmd2.cmdType === 'number',
                 `### Invalid Command Type: ${cmd2.cmdType} ###`);
          assert(cmd2.cmdType >= MIN_COMMAND_TYPE,
                 `### Invalid Command Type: ${cmd2.cmdType} ###`);
          assert(cmd2.cmdType <= MAX_COMMAND_TYPE,
                 `### Invalid Command Type: ${cmd2.cmdType} ###`);
          cmds.push(cmd2);
        }
      } else {
        assert(cmd instanceof Command,
               '### Expecting instance of Command ###');
        assert(typeof cmd.cmdType === 'number',
               `### Invalid Command Type: ${cmd.cmdType} ###`);
        assert(cmd.cmdType >= MIN_COMMAND_TYPE,
               `### Invalid Command Type: ${cmd.cmdType} ###`);
        assert(cmd.cmdType <= MAX_COMMAND_TYPE,
               `### Invalid Command Type: ${cmd.cmdType} ###`);
        cmds.push(cmd);
      }
    }
    // Now that we've flattened things, make sure all of the commands
    // have the same priority.
    const priority = cmds[0].priority;
    for (const cmd of cmds) {
      cmd.priority = priority;
    }
    return cmds;
  }

  getDeliveryStatusAsString(deliveryStatus) {
    if (deliveryStatus in C.DELIVERY_STATUS) {
      return C.DELIVERY_STATUS[deliveryStatus];
    }
    return `??? 0x${deliveryStatus.toString(16)} ???`;
  }

  getDiscoveryStatusAsString(discoveryStatus) {
    if (discoveryStatus in C.DISCOVERY_STATUS) {
      return C.DISCOVERY_STATUS[discoveryStatus];
    }
    return `??? 0x${discoveryStatus.toString(16)} ???`;
  }

  getModemStatusAsString(modemStatus) {
    if (modemStatus in C.MODEM_STATUS) {
      return C.MODEM_STATUS[modemStatus];
    }
    return `??? 0x${modemStatus.toString(16)} ???`;
  }

  // ----- Misc Commands -----------------------------------------------------

  handleBindResponse(frame) {
    if (frame.status != 0) {
      // The device doesn't support the bind command, which means that we
      // can't use configReports, so we have no way of knowing if any
      // property values change. The Hue bulbs behave this way when using
      // the ZHA protocol.
      const node = this.nodes[frame.remote64];
      if (node) {
        for (const property of node.properties.values()) {
          property.fireAndForget = true;
        }
      }
    }
  }

  handleExplicitRx(frame) {
    if (this.zdo.isZdoFrame(frame)) {
      try {
        this.zdo.parseZdoFrame(frame);
        if (this.debugFrames) {
          this.dumpFrame('Rcvd:', frame);
        }
        const clusterId = parseInt(frame.clusterId, 16);
        if (clusterId in ZigbeeAdapter.zdoClusterHandler) {
          ZigbeeAdapter.zdoClusterHandler[clusterId].call(this, frame);
        } else {
          console.error('No handler for ZDO cluster:',
                        zdo.getClusterIdAsString(clusterId));
        }
      } catch (e) {
        console.error('handleExplicitRx: Caught an exception parsing',
                      'ZDO frame');
        console.error(e);
        console.error(frame);
      }
    } else if (this.isZhaFrame(frame)) {
      try {
        zcl.parse(frame.data, parseInt(frame.clusterId, 16), (error, data) => {
          if (error) {
            console.error('Error parsing ZHA frame:', frame);
            console.error(error);
          } else {
            frame.zcl = data;
            if (this.debugFrames) {
              this.dumpFrame('Rcvd:', frame);
            }
            // Add some special fields to ease waitFrame processing.
            if (frame.zcl.seqNum) {
              frame.zclSeqNum = frame.zcl.seqNum;
            }
            if (frame.zcl.cmdId) {
              frame.zclCmdId = frame.zcl.cmdId;
            }
            const node = this.findNodeFromFrame(frame);
            if (node) {
              node.handleZhaResponse(frame);
            } else {
              console.log('Node:', frame.remote64, frame.remote16, 'not found');
            }
          }
        });
      } catch (e) {
        console.error('handleExplicitRx: Caught an exception parsing',
                      'ZHA frame');
        console.error(e);
        console.error(frame);
      }
    }
  }

  handleTransmitStatus(frame) {
    if (frame.deliveryStatus !== 0) {
      // Note: For failed transmissions, the remote16 will always be set
      // to 0xfffd so there isn't any point in reporting it.
      if (this.debugFrames) {
        console.error('Transmit Status ERROR:',
                      this.getDeliveryStatusAsString(frame.deliveryStatus),
                      'id:', frame.id);
        console.log(frame);
      }
    }
    if (frame.discoveryStatus ==
        C.DISCOVERY_STATUS.EXTENDED_TIMEOUT_DISCOVERY) {
      const node = this.findNodeByAddr16(frame.remote16);
      if (node) {
        node.extendedTimeout = true;
      } else {
        console.error('Unable to find node for remote16 =', frame.remote16);
      }
    }
  }

  // eslint-disable-next-line no-unused-vars
  handleRouteRecord(frame) {
    if (this.debugFlow) {
      console.log('Processing ROUTE_RECORD');
    }
  }

  sendFrames(frames) {
    const commands = [];
    for (const frame of frames) {
      let waitFrame;
      if (frame.type ==
          C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME) {
        if (this.zdo.isZdoFrame(frame)) {
          waitFrame = {
            type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
            zdoSeq: frame.zdoSeq,
            sendOnSuccess: frame.sendOnSuccess,
          };
        } else if (this.isZhaFrame(frame)) {
          waitFrame = {
            type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
            zclSeqNum: frame.zcl.seqNum,
          };
        }
      }
      if (!waitFrame) {
        waitFrame = {
          type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
          id: frame.id,
        };
      }
      commands.push(new Command(SEND_FRAME, frame));
      commands.push(new Command(WAIT_FRAME, waitFrame));
    }
    this.queueCommandsAtFront(commands);
  }

  // ----- AT Commands -------------------------------------------------------

  handleAtResponse(frame) {
    if (frame.commandData.length) {
      this.at.parseFrame(frame);
      if (frame.command in ZigbeeAdapter.atCommandMap) {
        const varName = ZigbeeAdapter.atCommandMap[frame.command];
        this[varName] = frame[varName];
      } else if (frame.command in ZigbeeAdapter.atResponseHandler) {
        ZigbeeAdapter.atResponseHandler[frame.command].call(this, frame);
      }
    }
  }

  handleAtSerialNumberHigh(frame) {
    this.serialNumber =
      frame.serialNumberHigh + this.serialNumber.slice(8, 8);
  }

  handleAtSerialNumberLow(frame) {
    this.serialNumber = this.serialNumber.slice(0, 8) + frame.serialNumberLow;
  }

  // ----- END DEVICE ANNOUNCEMENT -------------------------------------------

  createNodeIfRequired(addr64, addr16) {
    if (this.debugFlow) {
      console.log('createNodeIfRequired:', addr64, addr16);
    }

    if (addr64 == 'ffffffffffffffff') {
      // We can't create a new node if we don't know the 64-bit address.
      // Hopefully, we've seen this node before.
      return this.findNodeByAddr16(addr16);
    }

    let saveDeviceInfo = false;
    let node = this.nodes[addr64];
    if (node) {
      // Update the 16-bit address, since it may have changed.
      if (node.addr16 != addr16) {
        node.addr16 = addr16;
        saveDeviceInfo = true;
      }
    } else {
      node = this.nodes[addr64] = new ZigbeeNode(this, addr64, addr16);
      saveDeviceInfo = true;
    }
    if (saveDeviceInfo) {
      this.saveDeviceInfoDeferred();
    }
    return node;
  }

  handleEndDeviceAnnouncement(frame) {
    if (this.debugFlow) {
      console.log('Processing END_DEVICE_ANNOUNCEMENT');
    }
    if (this.isPairing) {
      this.cancelPairing();
    }

    // Create the node now, since we know the 64 and 16 bit addresses. This
    // allows us to process broadcasts which only come in with a 16-bit address.
    const node = this.createNodeIfRequired(frame.zdoAddr64, frame.zdoAddr16);
    if (node) {
      // Xiaomi devices send a genReport right after sending the end device
      // announcement, so we introduce a slight delay to allow this to happen
      // before we assume that it's a regular device.
      setTimeout(() => {
        if (this.debugFlow) {
          console.log('Processing END_DEVICE_ANNOUNCEMENT (after timeout)');
        }
        if (!node.family) {
          if (node.isMainsPowered()) {
            // We get an end device announcement when adding devices through
            // pairing, or for routers (typically not battery powered) when they
            // get powered on. In this case we want to do an initialRead so that
            // we can sync the state.
            node.properties.forEach((property) => {
              if (property.attr) {
                // The actual read will occur later, once rebinding happens.
                property.initialReadNeeded = true;
              }
            });
          }
          this.populateNodeInfo(node);
        }
      }, 500);
    }
  }

  // ----- MATCH DESCRIPTOR REQUEST ------------------------------------------

  handleMatchDescriptorRequest(frame) {
    const node = this.createNodeIfRequired(frame.remote64, frame.remote16);
    if (!node) {
      return;
    }

    for (const inputCluster of frame.inputClusters) {
      switch (inputCluster) {
        case CLUSTER_ID_GENOTA_HEX:
          // Indicate that we support the OTA cluster
          this.sendMatchDescriptorResponse(node, frame, 1);
          break;
      }
    }

    for (const outputCluster of frame.outputClusters) {
      switch (outputCluster) {
        case CLUSTER_ID_SSIASZONE_HEX:
          // Sensors which are "Security sensors" will ask if we support
          // the SSIASZONE cluster, so we tell them that we do.
          this.sendMatchDescriptorResponse(node, frame, 1);
          break;

        case CLUSTER_ID_GENPOLLCTRL_HEX: {
          this.sendMatchDescriptorResponse(node, frame, 1);
          break;
        }
      }
    }

    this.populateNodeInfo(node);
  }

  sendMatchDescriptorResponse(node, reqFrame, endpoint) {
    // Match Descriptor requests come from the end devices and often
    // arrive while we're trying to query the device. For end devices
    // which are battery powered, this causes our response to be delayed,
    // so we send it right away.
    this.sendFrameNow(this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.MATCH_DESCRIPTOR_RESPONSE,
      zdoSeq: reqFrame.zdoSeq,
      status: 0,
      zdoAddr16: node.addr16,
      endpoints: [endpoint],
    }));
  }

  // ----- GET ACTIVE ENDPOINTS ----------------------------------------------

  getActiveEndpoint(node) {
    if (this.debugFlow) {
      console.log('getActiveEndpoint node.addr64 =', node.addr64);
    }
    this.queueCommandsAtFront(this.getActiveEndpointCommands(node));
  }

  getActiveEndpointCommands(node) {
    if (this.debugFlow) {
      console.log('getActiveEndpointCommands node.addr64 =', node.addr64);
    }
    this.activeEndpointResponseCount = 0;
    this.activeEndpointRetryCount = 0;
    return this.getActiveEndpointCommandsOnly(node);
  }

  getActiveEndpointCommandsOnly(node) {
    if (this.debugFlow) {
      console.log('getActiveEndpointCommandsOnly node.addr64 =', node.addr64);
    }
    const frame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.ACTIVE_ENDPOINTS_REQUEST,
    });
    node.queryingActiveEndpoints = true;
    return [
      new Command(SEND_FRAME, frame),
      // new Command(WAIT_FRAME, {
      //   type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
      //   id: frame.id,
      // }),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zdoSeq: frame.zdoSeq,
      }),
      FUNC(this, this.retryGetActiveEndpointIfNeeded, [node, frame]),
    ];
  }

  retryGetActiveEndpointIfNeeded(node, frame) {
    if (this.debugFlow) {
      console.log('retryGetActiveEndpointIfNeeded node.addr64 =', node.addr64,
                  'responseCount =', this.activeEndpointResponseCount,
                  'retryCount =', this.activeEndpointRetryCount);
    }
    node.queryingActiveEndpoints = false;
    if (this.activeEndpointResponseCount > 0) {
      return;
    }
    this.activeEndpointRetryCount++;
    if (this.activeEndpointRetryCount < 5) {
      node.queryingActiveEndpoints = true;
      this.queueCommandsAtFront([
        new Command(SEND_FRAME, frame),
        new Command(WAIT_FRAME, {
          type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
          id: frame.id,
        }),
        FUNC(this, this.retryGetActiveEndpointIfNeeded, [node, frame]),
      ]);
    }
  }

  handleActiveEndpointsResponse(frame) {
    if (this.debugFlow) {
      console.log('Processing ACTIVE_ENDPOINTS_RESPONSE');
    }
    this.activeEndpointResponseCount++;
    const node = this.nodes[frame.remote64];
    if (node) {
      for (const endpointNum of frame.activeEndpoints) {
        if (!(endpointNum in node.activeEndpoints)) {
          node.activeEndpoints[endpointNum] = {};
        }
      }
      node.activeEndpointsPopulated = true;
      this.saveDeviceInfoDeferred();
      this.populateNodeInfoEndpoints(node);
    }
  }

  // ----- GET MANAGEMENT LQI ------------------------------------------------

  getManagementLqi(node, startIndex) {
    if (!startIndex) {
      startIndex = 0;
    }
    if (this.debugFlow) {
      console.log('getManagementLqi node.addr64 =', node.addr64,
                  'startIndex:', startIndex);
    }

    this.queueCommandsAtFront(this.getManagementLqiCommands(node, startIndex));
  }

  getManagementLqiCommands(node, startIndex) {
    if (!startIndex) {
      startIndex = 0;
    }
    if (this.debugFlow) {
      console.log('getManagementLqiCommands node.addr64 =', node.addr64,
                  'startIndex:', startIndex);
    }
    const lqiFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_LQI_REQUEST,
      startIndex: startIndex,
    });
    return [
      new Command(SEND_FRAME, lqiFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: lqiFrame.id,
      }),
      FUNC(this, this.getManagementLqiNext, [node]),
    ];
  }

  getManagementLqiNext(node) {
    if (this.nextStartIndex >= 0) {
      const nextStartIndex = this.nextStartIndex;
      this.nextStartIndex = -1;
      this.queueCommandsAtFront(
        this.getManagementLqiCommands(node, nextStartIndex));
    }
  }

  handleManagementLqiResponse(frame) {
    if (this.debugFlow) {
      console.log('Processing CLUSTER_ID.MANAGEMENT_LQI_RESPONSE');
    }
    let node = this.nodes[frame.remote64];
    if (!node) {
      node = this.nodes[frame.remote64] =
        new ZigbeeNode(this, frame.remote64, frame.remote16);
    }

    for (let i = 0; i < frame.numEntriesThisResponse; i++) {
      const neighborIndex = frame.startIndex + i;
      const neighbor = frame.neighbors[i];
      node.neighbors[neighborIndex] = neighbor;
      if (this.debugFlow) {
        console.log('Added neighbor', neighbor.addr64);
      }
      let neighborNode = this.nodes[neighbor.addr64];
      if (!neighborNode) {
        neighborNode = this.nodes[neighbor.addr64] =
          new ZigbeeNode(this, neighbor.addr64, neighbor.addr16);
      }
      if (neighborNode.addr16 == 'fffe') {
        neighborNode.addr16 = neighbor.addr16;
      }
      neighborNode.deviceType = neighbor.deviceType;
    }

    if (frame.startIndex + frame.numEntriesThisResponse <
        frame.numEntries) {
      this.nextStartIndex =
        frame.startIndex + frame.numEntriesThisResponse;
    } else {
      this.nextStartIndex = -1;
    }
  }

  // ----- GET MANAGEMENT RTG ------------------------------------------------

  getManagementRtgCommands(node, startIndex) {
    if (!startIndex) {
      startIndex = 0;
    }
    if (this.debugFlow) {
      console.log('getManagementRtgCommands node.addr64 =', node.addr64,
                  'startIndex:', startIndex);
    }
    const rtgFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_RTG_REQUEST,
      startIndex: startIndex,
    });
    return [
      new Command(SEND_FRAME, rtgFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: rtgFrame.id,
      }),
      FUNC(this, this.getManagementRtgNext, [node]),
    ];
  }

  getManagementRtgNext(node) {
    if (this.nextStartIndex >= 0) {
      const nextStartIndex = this.nextStartIndex;
      this.nextStartIndex = -1;
      this.queueCommandsAtFront(
        this.getManagementRtgCommands(node, nextStartIndex));
    }
  }

  handleManagementRtgResponse(frame) {
    if (frame.startIndex + frame.numEntriesThisResponse <
        frame.numEntries) {
      this.nextStartIndex = frame.startIndex +
                            frame.numEntriesThisResponse;
    } else {
      this.nextStartIndex = -1;
    }
  }

  // ----- GET NODE DESCRIPTOR -----------------------------------------------

  getNodeDescriptors() {
    if (this.debugFlow) {
      console.log('getNodeDescriptors');
    }
    this.enumerateAllNodes(this.getNodeDescriptor);
  }

  getNodeDescriptor(node) {
    if (this.debugFlow) {
      console.log('getNodeDescriptor node.addr64 =', node.addr64);
    }
    const nodeDescFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.NODE_DESCRIPTOR_REQUEST,
    });
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, nodeDescFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: nodeDescFrame.id,
      }),
    ]);
  }

  // ----- GET SIMPLE DESCRIPTOR ---------------------------------------------

  getSimpleDescriptor(node, endpointNum) {
    if (this.debugFlow) {
      console.log('getSimpleDescriptor node.addr64 =', node.addr64,
                  'endpoint =', endpointNum);
    }
    this.queueCommandsAtFront(
      this.getSimpleDescriptorCommands(node, endpointNum));
  }

  getSimpleDescriptorCommands(node, endpointNum) {
    if (this.debugFlow) {
      console.log('getSimpleDescriptorCommands: node.addr64 =', node.addr64,
                  'endpoint =', endpointNum);
    }
    const simpleDescFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.SIMPLE_DESCRIPTOR_REQUEST,
      endpoint: endpointNum,
    });
    const endpoint = node.activeEndpoints[endpointNum];
    if (!endpoint) {
      return [];
    }
    endpoint.queryingSimpleDescriptor = true;
    return [
      new Command(SEND_FRAME, simpleDescFrame),

      // I've seen a couple of cases where the Tx Status message seems
      // to get dropped, so wait for the actual response instead.
      //
      // TODO: Should probably update all of the WAIT_FRAME to wait for
      // the actual response rather than the Tx Status message
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        clusterId: zdo.getClusterIdAsString(
          zdo.CLUSTER_ID.SIMPLE_DESCRIPTOR_RESPONSE),
        zdoSeq: simpleDescFrame.zdoSeq,
      }),
      FUNC(this, this.clearQueryingSimpleDescriptor, [node, endpointNum]),
    ];
  }

  clearQueryingSimpleDescriptor(node, endpointNum) {
    // Called to cover the case where no response is received.
    const endpoint = node.activeEndpoints[endpointNum];
    if (endpoint) {
      endpoint.queryingSimpleDescriptor = false;
    }
  }

  handleSimpleDescriptorResponse(frame) {
    if (this.debugFlow) {
      console.log('Processing SIMPLE_DESCRIPTOR_RESPONSE');
    }
    const node = this.nodes[frame.remote64];
    if (!node) {
      return;
    }
    const endpoint = node.activeEndpoints[frame.endpoint];
    if (endpoint) {
      endpoint.queryingSimpleDescriptor = false;
      endpoint.profileId = frame.appProfileId;
      endpoint.deviceId = frame.appDeviceId;
      endpoint.deviceVersion = frame.appDeviceVersion;
      endpoint.inputClusters = frame.inputClusters.slice(0);
      endpoint.outputClusters = frame.outputClusters.slice(0);
    }
    this.populateNodeInfoEndpoints(node);
  }

  // ----- MANAGEMENT LEAVE --------------------------------------------------

  removeThing(node) {
    if (this.debugFlow) {
      console.log(`removeThing(${node.addr64})`);
    }
    this.managementLeave(node);
  }

  // eslint-disable-next-line no-unused-vars
  cancelRemoveThing(node) {
    // Nothing to do. We've either sent the leave request or not.
  }

  unload() {
    this.serialport.close();
    return super.unload();
  }

  managementLeave(node) {
    if (this.debugFlow) {
      console.log('managementLeave node.addr64 =', node.addr64);
    }

    const leaveFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_LEAVE_REQUEST,
      leaveOptions: 0,
    });
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, leaveFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: leaveFrame.id,
      }),
    ]);
    this.handleDeviceRemoved(node);
    this.saveDeviceInfoDeferred();
  }

  handleManagementLeaveResponse(frame) {
    if (frame.status != STATUS_SUCCESS) {
      // This means that the device didn't unpair from the network. So
      // we're going to keep around our knowledge of the device since it
      // still thinks its part of the network.
      return;
    }
    const node = this.nodes[frame.remote64];
    if (!node) {
      return;
    }

    // Walk through all of the nodes and remove the node from the
    // neighbor tables
    for (const nodeAddr in this.nodes) {
      const scanNode = this.nodes[nodeAddr];
      for (const neighborIdx in scanNode.neighbors) {
        const neighbor = scanNode.neighbors[neighborIdx];
        if (neighbor.addr64 == node.addr64) {
          scanNode.neighbors.splice(neighborIdx, 1);
          break;
        }
      }
    }
    delete this.nodes[node.addr64];
  }

  // ----- PERMIT JOIN -------------------------------------------------------

  permitJoin(seconds) {
    this.networkJoinTime = seconds;

    const permitJoinFrame = this.zdo.makeFrame({
      destination64: '000000000000ffff',
      destination16: 'fffe',
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_PERMIT_JOIN_REQUEST,
      permitDuration: seconds,
      trustCenterSignificance: 0,
    });

    this.queueCommandsAtFront([
      this.AT(AT_CMD.NODE_JOIN_TIME, {networkJoinTime: seconds}),
      new Command(SEND_FRAME, permitJoinFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: permitJoinFrame.id,
      }),
    ]);
  }

  startPairing(timeoutSeconds) {
    console.log('Pairing mode started, timeout =', timeoutSeconds);
    this.isPairing = true;
    this.permitJoin(timeoutSeconds);
  }

  cancelPairing() {
    console.log('Cancelling pairing mode');
    this.isPairing = false;
    this.permitJoin(0);
  }

  // ----- Discover Attributes -----------------------------------------------

  discoverAttributes(node) {
    this.waitFrameTimeoutFunc = this.discoverAttributesTimeout.bind(this);
    node.discoveringAttributes = true;
    console.log('**** Starting discovery for node:', node.id, '*****');
    let commands = [];
    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];

      commands = commands.concat(
        FUNC(this, this.print,
             [`  Input clusters for endpoint ${endpointNum}`])
      );
      if (endpoint.inputClusters && endpoint.inputClusters.length) {
        for (const inputCluster of endpoint.inputClusters) {
          const inputClusterId = parseInt(inputCluster, 16);
          const zclCluster = zclId.clusterId.get(inputClusterId);
          let inputClusterStr = inputCluster;
          if (zclCluster) {
            inputClusterStr += ` - ${zclCluster.key}`;
          }
          commands = commands.concat(
            FUNC(this, this.print, [`    ${inputClusterStr}`])
          );

          const discoverFrame =
            node.makeDiscoverAttributesFrame(parseInt(endpointNum),
                                             endpoint.profileId,
                                             inputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.zcl.seqNum,
            }),
          ]);
        }
      } else {
        commands = commands.concat(FUNC(this, this.print, ['    None']));
      }

      commands = commands.concat(
        FUNC(this, this.print,
             [`  Output clusters for endpoint ${endpointNum}`])
      );
      if (endpoint.outputClusters && endpoint.outputClusters.length) {
        for (const outputCluster of endpoint.outputClusters) {
          const outputClusterId = parseInt(outputCluster, 16);
          const zclCluster = zclId.clusterId.get(outputClusterId);
          let outputClusterStr = outputCluster;
          if (zclCluster) {
            outputClusterStr += ` - ${zclCluster.key}`;
          }
          commands = commands.concat(
            FUNC(this, this.print, [`    ${outputClusterStr}`])
          );
          const discoverFrame =
            node.makeDiscoverAttributesFrame(parseInt(endpointNum),
                                             endpoint.profileId,
                                             outputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.zcl.seqNum,
            }),
          ]);
        }
      } else {
        commands = commands.concat(FUNC(this, this.print, ['    None']));
      }
    }
    commands = commands.concat(FUNC(this, this.doneDiscoverAttributes, [node]));

    this.queueCommandsAtFront(commands);
  }

  doneDiscoverAttributes(node) {
    console.log('***** Discovery done for node:', node.id, '*****');
    this.waitFrameTimeoutFunc = null;
    node.discoveringAttributes = false;
  }

  discoverAttributesTimeout(frame) {
    // Some of the attributes fail to read during discover. I suspect that
    // this is because something related to the attribute hasn't been
    // initialized. Just report what we know.
    if (frame.zcl && frame.zcl.cmd == 'read') {
      const clusterId = parseInt(frame.clusterId, 16);
      for (const attrEntry of frame.zcl.payload) {
        const attr = zclId.attr(clusterId, attrEntry.attrId);
        const attrStr = attr ? attr.key : 'unknown';
        console.log('      AttrId:', `${attrStr} (${attrEntry.attrId})`,
                    'read failed');
      }
    }
  }

  // ----- Read Attribute ----------------------------------------------------

  readAttribute(node, endpoint, profileId, clusterId, attrId) {
    this.waitFrameTimeoutFunc = this.readAttributeTimeout.bind(this);
    node.discoveringAttributes = true;
    clusterId = zdo.getClusterIdAsInt(clusterId);
    console.log('**** Starting read attribute for node:', node.id, '*****');
    const attrIds = [];
    if (typeof attrId === 'undefined') {
      const attrList = zclId.attrList(clusterId);
      if (attrList) {
        attrList.forEach((entry) => {
          attrIds.push(entry.attrId);
        });
      }
    } else {
      attrIds.push(attrId);
    }
    const commands = [];
    for (attrId of attrIds) {
      const readFrame = node.makeReadAttributeFrame(endpoint, profileId,
                                                    clusterId, attrId);
      const waitFrame = {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
      };
      commands.push(new Command(SEND_FRAME, readFrame));
      commands.push(new Command(WAIT_FRAME, waitFrame));
    }
    commands.push(FUNC(this, this.doneReadAttribute, [node]));
    this.queueCommandsAtFront(commands);
  }

  doneReadAttribute(node) {
    console.log('***** Read attribute done for node:', node.id, '*****');
    this.waitFrameTimeoutFunc = null;
    node.discoveringAttributes = false;
  }

  readAttributeTimeout(frame) {
    this.discoverAttributesTimeout(frame);
  }

  // -------------------------------------------------------------------------

  nextFrameId() {
    return xbeeApi._frame_builder.nextFrameId();
  }

  sendFrame(frame) {
    this.queueCommands([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: frame.id,
      }),
    ]);
  }

  makeFrameWaitFrame(sendFrame, waitFrame, priority) {
    return [
      new Command(SEND_FRAME, sendFrame, priority),
      new Command(WAIT_FRAME, waitFrame, priority),
    ];
  }

  makeFuncCommand(ths, func, args) {
    return FUNC(ths, func, args);
  }

  sendFrameWaitFrameAtFront(sendFrame, waitFrame, priority) {
    this.queueCommandsAtFront(
      this.makeFrameWaitFrame(sendFrame, waitFrame, priority));
  }

  sendFrameWaitFrame(sendFrame, waitFrame, priority) {
    this.queueCommands(this.makeFrameWaitFrame(sendFrame, waitFrame, priority));
  }

  sendFrameWaitFrameResolve(sendFrame, waitFrame, property) {
    this.queueCommands([
      new Command(SEND_FRAME, sendFrame),
      new Command(WAIT_FRAME, waitFrame),
      new Command(RESOLVE_SET_PROPERTY, property),
    ]);
  }

  sendFrameNow(frame) {
    if (this.debugFlow) {
      console.log('sendFrameNow');
    }
    if (this.debugFrames) {
      this.dumpFrame('Sent:', frame);
    }
    const rawFrame = this.xb.buildFrame(frame);
    if (this.debugRawFrames) {
      console.log('Sent:', rawFrame);
    }
    this.serialport.write(rawFrame, serialWriteError);
  }

  // -------------------------------------------------------------------------

  addIfReady(node) {
    this.saveDeviceInfoDeferred();

    if (!node.activeEndpointsPopulated && !this.scanning) {
      if (this.debugFlow) {
        console.log('addIfReady:', node.addr64,
                    'activeEndpoints not populated yet');
      }
      this.populateNodeInfo(node);
      return;
    }
    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];
      if (!endpoint.classifierAttributesPopulated) {
        if (!this.scanning) {
          if (this.debugFlow) {
            console.log('addIfReady:', node.addr64, 'endpoint', endpointNum,
                        'classifier attributes not read yet');
          }
          this.populateNodeInfoEndpoints(node);
        }
        return;
      }
    }
    this.handleDeviceAdded(node);

    // We want the initial scan to be quick, so we ignore end devices
    // during the scan.
    if (!this.scanning) {
      node.rebindIfRequired();
    }
  }

  handleDeviceAdded(node) {
    if (this.debugFlow) {
      console.log('handleDeviceAdded: ', node.addr64,
                  'rebindRequired:', node.rebindRequired);
    }
    // Only add the device if we haven't already added it.
    if (node.added) {
      return;
    }
    if (node.isCoordinator) {
      node.name = node.defaultName;
    } else {
      node.classify();
      super.handleDeviceAdded(node);
      node.added = true;
    }
  }

  handleFrame(frame) {
    if (this.debugFrameParsing) {
      this.dumpFrame('Rcvd (before parsing):', frame);
    }
    this.frameDumped = false;
    const frameHandler = ZigbeeAdapter.frameHandler[frame.type];
    if (frameHandler) {
      frameHandler.call(this, frame);
    }
    if (this.debugFrames && !this.frameDumped) {
      this.dumpFrame('Rcvd:', frame);
    }

    if (this.waitFrame) {
      if (this.debugFlow) {
        console.log('Waiting for', this.waitFrame);
      }
      let match = true;
      const specialNames = [
        'sendOnSuccess',
        'callback',
        'timeoutFunc',
      ];
      for (const propertyName in this.waitFrame) {
        if (specialNames.includes(propertyName)) {
          continue;
        }
        if (this.waitFrame[propertyName] != frame[propertyName]) {
          match = false;
          break;
        }
      }
      if (match) {
        if (this.debugFlow || this.debugDumpFrameDetail) {
          console.log('Wait satisified');
        }
        const sendOnSuccess = this.waitFrame.sendOnSuccess;
        const callback = this.waitFrame.callback;
        this.waitFrame = null;
        this.waitRetryCount = 0;
        if (this.waitTimeout) {
          clearTimeout(this.waitTimeout);
          this.waitTimeout = null;
        }
        if (sendOnSuccess && frame.status === 0) {
          this.sendFrames(sendOnSuccess);
        }
        if (callback) {
          callback(frame);
        }
      } else if (this.debugFlow || this.debugDumpFrameDetail) {
        console.log('Wait NOT satisified');
        console.log('    waitFrame =', this.waitFrame);
      }
    }
    this.run();
  }

  isZhaFrame(frame) {
    if (typeof frame.profileId === 'number') {
      return frame.profileId === ZHA_PROFILE_ID;
    }
    return frame.profileId === ZHA_PROFILE_ID_HEX;
  }

  populateNodeInfo(node) {
    if (this.debugFlow) {
      console.log('populateNodeInfo node.addr64 =', node.addr64);
    }
    if (node.addr64 == this.serialNumber) {
      // We don't populate information for the coordinator (i.e. dongle)
      return;
    }

    if (node.activeEndpointsPopulated) {
      // We already know the active endpoints, no need to request
      // them again.
      this.populateNodeInfoEndpoints(node);
    } else if (!node.queryingActiveEndpoints && !this.scanning) {
      // We don't know the active endpoints, and a query for the active
      // endpoints hasn't been queued up => queue up a command to retrieve
      // the active endpoints
      this.saveDeviceInfoDeferred();
      this.queueCommandsAtFront(this.getActiveEndpointCommands(node));
    }
  }

  // populateNodeAttrbibutes will read attributes which are required by
  // the classifier to determine the type of thing its dealing with.
  populateClassifierAttributes(node, endpointNum) {
    const endpoint = node.activeEndpoints[endpointNum];
    if (this.debugFlow) {
      console.log('populateClassifierAttributes node.addr64 =', node.addr64,
                  'endpointNum =', endpointNum,
                  'classifierAttributesPopulated =',
                  endpoint.classifierAttributesPopulated);
    }
    if (endpoint.classifierAttributesPopulated) {
      this.addIfReady(node);
      return;
    }

    if (node.endpointHasZhaInputClusterIdHex(
      endpoint, CLUSTER_ID_LIGHTINGCOLORCTRL_HEX)) {
      node.lightingColorCtrlEndpoint = endpointNum;
      if (node.hasOwnProperty('colorCapabilities')) {
        this.setClassifierAttributesPopulated(node, endpointNum);
      } else {
        const readFrame = node.makeReadAttributeFrame(
          endpointNum,
          ZHA_PROFILE_ID,
          CLUSTER_ID_LIGHTINGCOLORCTRL,
          ATTR_ID_LIGHTINGCOLORCTRL_COLORCAPABILITIES);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: this.populateClassifierAttributesLightingControl.bind(this),
        });
      }
      return;
    }

    if (node.endpointHasZhaInputClusterIdHex(endpoint,
                                             CLUSTER_ID_SSIASZONE_HEX)) {
      node.ssIasZoneEndpoint = endpointNum;
      if (node.hasOwnProperty('zoneType')) {
        if (this.debugFlow) {
          console.log('populateClassifierAttributes has zoneType - done');
        }
        this.setClassifierAttributesPopulated(node, endpointNum);
      } else {
        if (this.debugFlow) {
          console.log('populateClassifierAttributes has no zoneType -',
                      'querying via read');
        }
        // zoneType is the only field that the classifier actually needs.
        // We read the status and cieAddr to save a read later.
        const readFrame = node.makeReadAttributeFrame(
          endpointNum,
          ZHA_PROFILE_ID,
          CLUSTER_ID_SSIASZONE,
          [
            ATTR_ID_SSIASZONE_ZONESTATE,
            ATTR_ID_SSIASZONE_ZONETYPE,
            ATTR_ID_SSIASZONE_ZONESTATUS,
            ATTR_ID_SSIASZONE_CIEADDR,
          ]);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: this.populateClassifierAttributesIasZone.bind(this),
        });
      }
      return;
    }

    // Since we got to here, this endpoint doesn't need any classifier
    // attributes
    this.setClassifierAttributesPopulated(node, endpointNum);
    endpoint.classifierAttributesPopulated = true;
  }

  populateClassifierAttributesLightingControl(frame) {
    if (this.debugFlow) {
      console.log('populateClassifierAttributesLightingControl');
    }
    const node = this.nodes[frame.remote64];
    if (!node) {
      return;
    }
    for (const attrEntry of frame.zcl.payload) {
      if (attrEntry.status == 0 &&
          attrEntry.attrId == ATTR_ID_LIGHTINGCOLORCTRL_COLORCAPABILITIES) {
        node.colorCapabilities = attrEntry.attrData;
      }
    }
    // The sourceEndpoint comes back as a hex string. Convert it to decimal
    const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
    this.setClassifierAttributesPopulated(node, sourceEndpoint);
  }

  populateClassifierAttributesIasZone(frame) {
    if (this.debugFlow) {
      console.log('populateClassifierAttributesIasZone');
    }
    const node = this.nodes[frame.remote64];
    if (node) {
      node.handleIasReadResponse(frame);
    }
  }

  setClassifierAttributesPopulated(node, endpointNum) {
    if (this.debugFlow) {
      console.log('setClassifierAttributesPopulated: node.addr64 =',
                  node.addr64,
                  'endpointNum =', endpointNum,
                  'zoneType =', node.zoneType);
    }
    const endpoint = node.activeEndpoints[endpointNum];
    if (endpoint) {
      endpoint.classifierAttributesPopulated = true;
      this.addIfReady(node);
    }
  }

  populateNodeInfoEndpoints(node) {
    if (this.debugFlow) {
      console.log('populateNodeInfoEndpoints node.addr64 =', node.addr64);
    }

    // Check to see that have all of the simple descriptors
    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];
      if (!endpoint.hasOwnProperty('profileId')) {
        if (!endpoint.queryingSimpleDescriptor && !this.scanning) {
          // We don't have the simpleDescriptor information
          // (profileId is missing) and we don't have a command queued up to
          // retrieve it - queue one up.
          if (this.debugFlow) {
            console.log('populateNodeInfoEndpoints: queueing ',
                        'Simple Descriptor request for endpoint', endpointNum);
          }
          this.queueCommandsAtFront(
            this.getSimpleDescriptorCommands(node, endpointNum));
        }
        // We're waiting for a response - handleSimpleDescriptorResponse
        // will call us again once we get the response.
        return;
      }
    }

    // Since we got here, all of the simple descriptors have been populated.
    // Check to see that we have all of the classifier attributes
    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];
      if (!endpoint.classifierAttributesPopulated) {
        if (!this.scanning) {
          this.populateClassifierAttributes(node, parseInt(endpointNum));
        }
        return;
      }
    }
    node.nodeInfoEndpointsPopulated = true;

    this.addIfReady(node);
  }

  print(str) {
    console.log(str);
  }

  dumpCommands(commands) {
    if (typeof commands === 'undefined') {
      commands = this.cmdQueue;
    }
    console.log(`Commands (${commands.length})`);
    for (const idx in commands) {
      const cmd = commands[idx];
      cmd.print(this, idx);
    }
    console.log('---');
  }

  queueCommands(cmdSeq) {
    if (this.debugFlow) {
      console.log('queueCommands');
    }
    cmdSeq = this.flattenCommands(cmdSeq);
    const priority = cmdSeq[0].priority;
    let idx = -1;
    if (typeof priority !== 'undefined') {
      // The command being inserted has a priority. This means
      // it will get inserted in front of the first command in
      // the queue with no priority, or a command with a priority
      // greater than the one being inserted.
      idx = this.cmdQueue.findIndex((cmd) => {
        return typeof cmd.priority === 'undefined' ||
               priority < cmd.priority;
      });
    }
    if (idx < 0) {
      idx = this.cmdQueue.length;
    }
    this.cmdQueue.splice(idx, 0, ...cmdSeq);
    if (this.debugFlow) {
      this.dumpCommands();
    }
    if (!this.running) {
      this.run();
    }
  }

  queueCommandsAtFront(cmdSeq) {
    if (this.debugFlow) {
      console.log('queueCommandsAtFront');
    }
    cmdSeq = this.flattenCommands(cmdSeq);
    const priority = cmdSeq[0].priority;
    let idx = -1;
    if (typeof priority === 'undefined') {
      // The command being inserted has no priority. This means
      // it will be inserted in front of the first command
      // with no priority.
      idx = this.cmdQueue.findIndex((cmd) => {
        return typeof cmd.priority === 'undefined';
      });
    } else {
      // The command being inserted has a priority. This means
      // it will get inserted in front of the first command in
      // the queue with no priority, or a command with a priority
      // greater than or equal to the one being inserted.
      idx = this.cmdQueue.findIndex((cmd) => {
        return typeof cmd.priority === 'undefined' ||
               priority <= cmd.priority;
      });
    }
    if (idx < 0) {
      idx = this.cmdQueue.length;
    }
    this.cmdQueue.splice(idx, 0, ...cmdSeq);
    if (this.debugFlow) {
      this.dumpCommands();
    }
    if (!this.running) {
      this.run();
    }
  }

  run() {
    if (this.debugFlow) {
      console.log('run queue len =', this.cmdQueue.length,
                  'running =', this.running);
    }
    if (this.waitFrame) {
      if (this.debugFlow) {
        console.log('Queue stalled waiting for frame.');
      }
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    while (this.cmdQueue.length > 0 && !this.waitFrame) {
      const cmd = this.cmdQueue.shift();
      switch (cmd.cmdType) {
        case SEND_FRAME: {
          const frame = cmd.cmdData;
          let sentPrefix = '';
          if (frame.resend) {
            sentPrefix = 'Re';
          }
          if (this.debugFlow) {
            console.log(`${sentPrefix}SEND_FRAME`);
          }
          if (this.debugFrames) {
            this.dumpFrame(`${sentPrefix}Sent:`, frame);
          }
          // The xbee library returns source and destination endpoints
          // as a 2 character hex string. However, the frame builder
          // expects a number. And since we use the endpoint as a key
          // in the node.activeEndpoints, we get the endpoint as a string
          // containing a decimal number. So we put these asserts in to
          // make sure that we're dealing with numbers and not strings.
          if (frame.hasOwnProperty('sourceEndpoint') &&
              typeof frame.sourceEndpoint !== 'number') {
            console.log(frame);
            assert(typeof frame.sourceEndpoint === 'number',
                   'Expecting sourceEndpoint to be a number');
          }
          if (frame.hasOwnProperty('destinationEndpoint') &&
              typeof frame.destinationEndpoint !== 'number') {
            console.log(frame);
            assert(typeof frame.destinationEndpoint === 'number',
                   'Expecting destinationEndpoint to be a number');
          }
          const rawFrame = this.xb.buildFrame(frame);
          if (this.debugRawFrames) {
            console.log(`${sentPrefix}Sent:`, rawFrame);
          }
          this.serialport.write(rawFrame, serialWriteError);
          this.lastFrameSent = frame;
          break;
        }
        case WAIT_FRAME: {
          this.waitFrame = cmd.cmdData;
          this.waitRetryCount += 1;
          let timeoutDelay = WAIT_TIMEOUT_DELAY;
          if (this.lastFrameSent && this.lastFrameSent.destination64) {
            const node = this.nodes[this.lastFrameSent.destination64];
            if (node && node.extendedTimeout) {
              timeoutDelay = EXTENDED_TIMEOUT_DELAY;
            }
          }
          if (this.debugDumpFrameDetail) {
            console.log('WAIT_FRAME type:', this.waitFrame.type,
                        'timeoutDelay =', timeoutDelay);
          }
          this.waitTimeout = setTimeout(this.waitTimedOut.bind(this),
                                        timeoutDelay);
          break;
        }
        case EXEC_FUNC: {
          const ths = cmd.cmdData[0];
          const func = cmd.cmdData[1];
          const args = cmd.cmdData[2];
          if (this.debugDumpFrameDetail) {
            console.log('EXEC_FUNC', func.name);
          }
          func.apply(ths, args);
          break;
        }
        case RESOLVE_SET_PROPERTY: {
          const property = cmd.cmdData;
          if (this.debugDumpFrameDetail) {
            console.log('RESOLVE_SET_PROPERTY', property.name);
          }
          const deferredSet = property.deferredSet;
          if (deferredSet) {
            property.deferredSet = null;
            deferredSet.resolve(property.value);
          }
          break;
        }
        default:
          console.error('#####');
          console.error(`##### UNKNOWN COMMAND: ${cmd.cmdType} #####`);
          console.error('#####');
          break;
      }
    }
    this.running = false;
  }

  waitTimedOut() {
    if (this.debugDumpFrameDetail) {
      console.log('WAIT_FRAME timed out');
    }
    // We timed out waiting for a response, resend the last command.
    clearTimeout(this.waitTimeout);
    this.waitTimeout = null;

    // We need to set waitFrame back to null in order for the run
    // function to do anything.
    const waitFrame = this.waitFrame;
    const timeoutFunc = waitFrame.timeoutFunc;
    this.waitFrame = null;

    if (this.waitRetryCount > WAIT_RETRY_MAX) {
      if (this.debugFlow) {
        console.log('WAIT_FRAME exceeded max retry count');
      }
      if (timeoutFunc) {
        timeoutFunc();
      }
      // We've tried a few times, but no response.
      if (this.waitFrameTimeoutFunc) {
        this.waitFrameTimeoutFunc(this.lastFrameSent);
      }
      if (!this.running) {
        this.run();
      }
      return;
    }

    if (this.lastFrameSent && waitFrame) {
      if (this.debugFrames) {
        console.error('Resending ...');
      }
      this.lastFrameSent.resend = true;

      // Uncomment the following to cause the new send to go out with
      // a new ID. In the cases I've seen, sending with the new or
      // existing ID doesn't change the behaviour. Leaving the ID the
      // same allows up to pick up a late response from an earlier
      // request.

      // this.lastFrameSent.id = this.nextFrameId();
      // if (waitFrame.id) {
      //   waitFrame.id = this.lastFrameSent.id;
      // }

      this.sendFrameWaitFrameAtFront(this.lastFrameSent, waitFrame);
    }
  }
}

const acm = ZigbeeAdapter.atCommandMap = {};
acm[AT_CMD.API_OPTIONS] = 'apiOptions';
acm[AT_CMD.API_MODE] = 'apiMode';
acm[AT_CMD.CONFIGURED_64_BIT_PAN_ID] = 'configuredPanId64';
acm[AT_CMD.DEVICE_TYPE_IDENTIFIER] = 'deviceTypeIdentifier';
acm[AT_CMD.ENCRYPTION_ENABLED] = 'encryptionEnabled';
acm[AT_CMD.ENCRYPTION_OPTIONS] = 'encryptionOptions';
acm[AT_CMD.NETWORK_ADDR_16_BIT] = 'networkAddr16';
acm[AT_CMD.NODE_IDENTIFIER] = 'nodeIdentifier';
acm[AT_CMD.NODE_JOIN_TIME] = 'networkJoinTime';
acm[AT_CMD.NUM_REMAINING_CHILDREN] = 'numRemainingChildren';
acm[AT_CMD.OPERATING_16_BIT_PAN_ID] = 'operatingPanId16';
acm[AT_CMD.OPERATING_64_BIT_PAN_ID] = 'operatingPanId64';
acm[AT_CMD.OPERATING_CHANNEL] = 'operatingChannel';
acm[AT_CMD.SCAN_CHANNELS] = 'scanChannels';
acm[AT_CMD.ZIGBEE_STACK_PROFILE] = 'zigBeeStackProfile';

const arh = ZigbeeAdapter.atResponseHandler = {};
arh[AT_CMD.SERIAL_NUMBER_HIGH] =
  ZigbeeAdapter.prototype.handleAtSerialNumberHigh;
arh[AT_CMD.SERIAL_NUMBER_LOW] =
  ZigbeeAdapter.prototype.handleAtSerialNumberLow;

const fh = ZigbeeAdapter.frameHandler = {};
fh[C.FRAME_TYPE.AT_COMMAND_RESPONSE] =
  ZigbeeAdapter.prototype.handleAtResponse;
fh[C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX] =
  ZigbeeAdapter.prototype.handleExplicitRx;
fh[C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS] =
  ZigbeeAdapter.prototype.handleTransmitStatus;
fh[C.FRAME_TYPE.ROUTE_RECORD] =
  ZigbeeAdapter.prototype.handleRouteRecord;

const zch = ZigbeeAdapter.zdoClusterHandler = {};
zch[zdo.CLUSTER_ID.ACTIVE_ENDPOINTS_RESPONSE] =
  ZigbeeAdapter.prototype.handleActiveEndpointsResponse;
zch[zdo.CLUSTER_ID.MANAGEMENT_LEAVE_RESPONSE] =
  ZigbeeAdapter.prototype.handleManagementLeaveResponse;
zch[zdo.CLUSTER_ID.MANAGEMENT_LQI_RESPONSE] =
  ZigbeeAdapter.prototype.handleManagementLqiResponse;
zch[zdo.CLUSTER_ID.MANAGEMENT_RTG_RESPONSE] =
  ZigbeeAdapter.prototype.handleManagementRtgResponse;
zch[zdo.CLUSTER_ID.MATCH_DESCRIPTOR_REQUEST] =
  ZigbeeAdapter.prototype.handleMatchDescriptorRequest;
zch[zdo.CLUSTER_ID.SIMPLE_DESCRIPTOR_RESPONSE] =
  ZigbeeAdapter.prototype.handleSimpleDescriptorResponse;
zch[zdo.CLUSTER_ID.END_DEVICE_ANNOUNCEMENT] =
  ZigbeeAdapter.prototype.handleEndDeviceAnnouncement;
zch[zdo.CLUSTER_ID.BIND_RESPONSE] =
  ZigbeeAdapter.prototype.handleBindResponse;

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

      manifest.moziot.config = config;
      return db.saveConfig(config);
    });
  } else {
    promise = Promise.resolve();
  }

  promise.then(() => findDigiPorts(allowFTDISerial)).then((digiPorts) => {
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

registerFamilies();

module.exports = loadZigbeeAdapters;

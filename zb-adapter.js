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

const {Adapter, Utils} = require('gateway-addon');
const {
  ATTR_ID,
  CLUSTER_ID,
  PROFILE_ID,
  STATUS,
} = require('./zb-constants');

const {
  DEBUG_flow,
  DEBUG_frames,
  DEBUG_frameDetail,
  DEBUG_frameParsing,
  DEBUG_rawFrames,
} = require('./zb-debug');

const C = xbeeApi.constants;
const AT_CMD = at.AT_CMD;

const WAIT_TIMEOUT_DELAY = 1 * 1000;
const EXTENDED_TIMEOUT_DELAY = 10 * 1000;
const WAIT_RETRY_MAX = 3;   // includes initial send

const PERMIT_JOIN_PRIORITY = 1;

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
    console.error('SerialPort.write error:', error);
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

    // debugDiscoverAttributes causes us to ask for and print out the attributes
    // available for each cluster.
    this.debugDiscoverAttributes = false;

    this.frameDumped = false;
    this.isPairing = false;

    // Indicate that we're scanning so we don't try to talk to devices
    // until after we're initialized.
    this.scanning = true;

    this.xb = new xbeeApi.XBeeAPI({
      api_mode: 1,
      raw_frames: DEBUG_rawFrames,
    });

    this.atAttr = {};
    this.nodes = {};
    this.cmdQueue = [];
    this.running = false;
    this.waitFrame = null;
    this.waitTimeout = null;
    this.lastFrameSent = null;

    this.serialNumber = '0000000000000000';
    this.nextStartIndex = -1;

    this.zdo = new zdo.ZdoApi(this.xb);
    this.at = new at.AtApi();

    if (DEBUG_rawFrames) {
      this.xb.on('frame_raw', (rawFrame) => {
        console.log('Rcvd:', rawFrame);
        if (this.xb.canParse(rawFrame)) {
          try {
            const frame = this.xb.parseFrame(rawFrame);
            try {
              this.handleFrame(frame);
            } catch (e) {
              console.log('Error handling frame_raw');
              console.log(e);
              console.log(frame);
            }
          } catch (e) {
            console.log('Error parsing raw frame_raw');
            console.log(e);
            console.log(rawFrame);
          }
        }
      });
    } else {
      this.xb.on('frame_object', (frame) => {
        try {
          this.handleFrame(frame);
        } catch (e) {
          console.log('Error handling frame_object');
          console.log(e);
          console.log(util.inspect(frame, {depth: null}));
        }
      });
    }

    console.log('Opening serial port', port.comName);
    this.serialport = new SerialPort(port.comName, {
      baudRate: 9600,
    }, (err) => {
      if (err) {
        console.log('SerialPort open err =', err);
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
    if (DEBUG_flow) {
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
            FUNC(this, this.updateComplete),
          ]));
    });
  }

  startScan() {
    console.log('----- Scan Starting -----');
    this.enumerateAllNodes(this.scanNode);
  }

  scanNode(node) {
    if (DEBUG_flow) {
      console.log('scanNode: Calling populateNodeInfo');
    }
    this.populateNodeInfo(node);
  }

  scanComplete() {
    this.dumpNodes();
    console.log('----- Scan Complete -----');
    this.saveDeviceInfo();
    this.scanning = false;
    this.enumerateAllNodes(this.updateNetworkAddress);
  }

  updateComplete() {
    this.dumpNodes();
    console.log('----- Update Network Addresses Complete -----');
  }

  updateNetworkAddress(node) {
    if (!node.rxOnWhenIdle) {
      // Ignore nodes which won't be listening
      if (DEBUG_flow) {
        console.log('updateNetworkAddress: Skipping:', node.addr64,
                    'since rxOnWhenIdle is 0');
      }
      return;
    }
    const updateFrame = this.zdo.makeFrame({
      destination64: '000000000000ffff',
      destination16: 'fffe',
      clusterId: zdo.CLUSTER_ID.NETWORK_ADDRESS_REQUEST,
      addr64: node.addr64,
      requestType: 0, // 0 = Single Device Response
      startIndex: 0,
    });
    this.sendFrameWaitFrameAtFront(updateFrame, {
      type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
      zdoSeq: updateFrame.zdoSeq,
      waitRetryMax: 2,
    });
  }

  handleIEEEAddressResponse(frame) {
    // The IEEE Address Response and Netork Address Response have
    // the same format, and it turns out we do the same processing.

    this.handleNetworkAddressResponse(frame);
  }

  handleNetworkAddressResponse(frame) {
    if (frame.status != STATUS.SUCCESS) {
      if (DEBUG_flow) {
        console.log('handleNetworkAddressResponse: Skipping:', node.addr64,
                    'due to status:', this.frameStatus(frame));
      }
      return;
    }
    const node = this.nodes[frame.nwkAddr64];
    if (!node) {
      console.log('handleNetworkAddressResponse: Skipping:', node.addr64,
                  'due to unknown addr64');
      return;
    }

    if (node.addr16 != frame.nwkAddr16) {
      node.addr16 = frame.nwkAddr16;
      this.saveDeviceInfoDeferred();
    }
    if (node.rebindRequired) {
      this.populateNodeInfo(node);
    }
  }

  AT(command, frame, priority) {
    if (frame) {
      frame.shortDescr = util.inspect(frame);
    }
    return [
      new Command(SEND_FRAME, this.at.makeFrame(command, frame), priority),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.AT_COMMAND_RESPONSE,
        command: command,
      }),
    ];
  }

  configureApiModeIfNeeded() {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
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

  frameStatus(frame) {
    if (frame.hasOwnProperty('status')) {
      const status = zclId.status(frame.status);
      if (status) {
        return status;
      }
      // Something that zclId doesn't know about.
      return {
        key: 'unknown',
        value: frame.status,
      };
    }

    // Frames sent from the device not in response to an ExplicitTx
    // (like "End Device Announcement") won't have a status.
    return {
      key: 'none',
      // eslint-disable-next-line no-undefined
      value: undefined,
    };
  }

  dumpFrame(label, frame, dumpFrameDetail) {
    if (typeof dumpFrameDetail === 'undefined') {
      dumpFrameDetail = DEBUG_frameDetail;
    }
    this.frameDumped = true;
    let frameTypeStr = C.FRAME_TYPE[frame.type];
    if (!frameTypeStr) {
      frameTypeStr = `Unknown(0x${frame.type.toString(16)})`;
    }
    let atCmdStr;

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

      case C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME: {
        const cluster = zclId.cluster(parseInt(frame.clusterId, 16));
        const clusterKey = cluster && cluster.key || '???';
        if (this.zdo.isZdoFrame(frame)) {
          const shortDescr = frame.shortDescr || '';
          console.log(label, 'Explicit Tx', frame.destination64,
                      'ZDO',
                      zdo.getClusterIdAsString(frame.clusterId),
                      zdo.getClusterIdDescription(frame.clusterId),
                      shortDescr);
        } else if (this.isZhaFrame(frame)) {
          console.log(label, 'Explicit Tx', frame.destination64,
                      'ZHA', frame.clusterId, clusterKey,
                      frame.zcl.cmd, frame.zcl.payload);
        } else if (this.isZllFrame(frame)) {
          console.log(label, 'Explicit Tx', frame.destination64,
                      'ZLL', frame.clusterId, clusterKey,
                      frame.zcl.cmd, frame.zcl.payload);
        } else {
          console.log(label, 'Explicit Tx', frame.destination64,
                      `???(${frame.profileId})`, frame.clusterId);
        }
        if (dumpFrameDetail) {
          console.log(label, util.inspect(frame, {depth: null}));
        }
        break;
      }

      case C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX: {
        const cluster = zclId.cluster(parseInt(frame.clusterId, 16));
        const clusterKey = cluster && cluster.key || '???';
        if (this.zdo.isZdoFrame(frame)) {
          const status = this.frameStatus(frame);
          console.log(label, 'Explicit Rx', frame.remote64,
                      'ZDO', frame.clusterId,
                      zdo.getClusterIdDescription(frame.clusterId),
                      'status:', status.key, `(${status.value})`);
        } else if (this.isZhaFrame(frame)) {
          if (frame.zcl) {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZHA', frame.clusterId, clusterKey,
                        frame.zcl ? frame.zcl.cmdId : '???', frame.zcl.payload);
          } else {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZHA', frame.clusterId, clusterKey,
                        '??? no zcl ???');
          }
        } else if (this.isZllFrame(frame)) {
          if (frame.zcl) {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZLL', frame.clusterId, clusterKey,
                        frame.zcl ? frame.zcl.cmdId : '???', frame.zcl.payload);
          } else {
            console.log(label, 'Explicit Rx', frame.remote64,
                        'ZLL', frame.clusterId, clusterKey,
                        '??? no zcl ???');
          }
        } else {
          console.log(label, 'Explicit Rx', frame.remote64,
                      `???(${frame.profileId})`, frame.clusterId);
        }
        if (dumpFrameDetail) {
          console.log(label, util.inspect(frame, {depth: null}));
        }
        break;
      }

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
      const name = Utils.padRight(node.name, 32);
      console.log('Node:', node.addr64, node.addr16,
                  'Name:', name,
                  'rebindRequired:', node.rebindRequired,
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
            console.log('Error reading Zigbee device info file:',
                        this.deviceInfoFilename);
            console.log(err);
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
    const timeoutSeconds = DEBUG_frames ? 1 : 120;

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
    if (typeof this.deviceInfoFilename == 'undefined') {
      // The adapter hasn't finished initializing
      // (i.e. this.adapterInitialized() hasn't been called yet.)
      return;
    }
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
    if (DEBUG_flow) {
      console.log('Saved device information in', this.deviceInfoFilename);
    }
  }

  enumerateAllNodes(iterCb, doneCb) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
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
    let node;

    // Some devices (like xiaomi) switch from using a proper 64-bit address to
    // using broadcast but still provide the a 16-bit address.
    if (addr64 == 'ffffffffffffffff') {
      node = this.findNodeByAddr16(addr16);
      if (!node) {
        // We got a frame with a braodcast address and a 16-bit address
        // and we don't know the 16-bit address. Send out a request to
        // determine the 64-bit address. At least we'll be able to deal
        // with the next frame.

        const addrFrame = this.zdo.makeFrame({
          destination64: 'ffffffffffffffff',
          destination16: addr16,
          clusterId: zdo.CLUSTER_ID.IEEE_ADDRESS_REQUEST,
          addr64: 'ffffffffffffffff',
          requestType: 0, // 0 = Single Device Response
          startIndex: 0,
        });
        this.sendFrameNow(addrFrame);
      }
      return node;
    }

    node = this.nodes[addr64];
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
          if (DEBUG_flow) {
            console.error(node.addr64,
                          'bind failed - setting fireAndForget to true');
          }
          property.fireAndForget = true;
        }
      }
    }
  }

  handleManagementBindResponse(_frame) {
    console.log('handleManagementBindResponse');
  }

  handleExplicitRx(frame) {
    const node = this.nodes[frame.remote64];
    if (node && node.addr16 != frame.remote16) {
      node.addr16 = frame.renote16;
      this.saveDeviceInfoDeferred();
    }
    if (this.zdo.isZdoFrame(frame)) {
      try {
        this.zdo.parseZdoFrame(frame);
        if (DEBUG_frames) {
          this.dumpFrame('Rcvd:', frame);
        }
        const clusterId = parseInt(frame.clusterId, 16);
        if (clusterId in ZigbeeAdapter.zdoClusterHandler) {
          ZigbeeAdapter.zdoClusterHandler[clusterId].call(this, frame);
        } else {
          console.log('No handler for ZDO cluster:',
                      zdo.getClusterIdAsString(clusterId));
        }
      } catch (e) {
        console.error('handleExplicitRx:',
                      'Caught an exception parsing ZDO frame');
        console.error(e);
        console.error(util.inspect(frame, {depth: null}));
      }
    } else if (this.isZhaFrame(frame) || this.isZllFrame(frame)) {
      try {
        // The OSRAM lightify sends a manufacturer specific command
        // which the zcl-parse library doesn't deal with, so we put a check
        // for that here.
        const zclData = frame.data;
        if (zclData.length == 5 &&
            zclData[0] == 0x05 &&
            zclData[1] == 0x4e &&
            zclData[2] == 0x10 &&
            zclData[4] == 0x03) {
          this.handleZclFrame(frame, {
            frameCntl: {
              frameType: 1,
              manufSpec: 1,
              direction: 0,
              disDefaultRsp: 0,
            },
            manufCode: 0x104e,
            seqNum: zclData[3],
            cmdId: 'confirm',   // Made up - i.e. not from spec
            payload: {},
          });
        } else {
          const clusterId = parseInt(frame.clusterId, 16);
          zcl.parse(zclData, clusterId, (error, zclData) => {
            if (error) {
              console.error('Error parsing ZHA frame:', frame);
              console.error(error);
            } else {
              this.handleZclFrame(frame, zclData);
            }
          });
        }
      } catch (e) {
        console.error('handleExplicitRx:',
                      'Caught an exception parsing ZHA frame');
        console.error(e);
        console.error(util.inspect(frame, {depth: null}));
      }
    }
  }

  handleZclFrame(frame, zclData) {
    frame.zcl = zclData;
    if (DEBUG_frames) {
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

  handleTransmitStatus(frame) {
    if (frame.deliveryStatus !== 0) {
      // Note: For failed transmissions, the remote16 will always be set
      // to 0xfffd so there isn't any point in reporting it.
      if (DEBUG_frames) {
        console.log('Transmit Status ERROR:',
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
        console.log('Unable to find node for remote16 =', frame.remote16);
      }
    }
  }

  // eslint-disable-next-line no-unused-vars
  handleRouteRecord(frame) {
    if (DEBUG_flow) {
      console.log('Processing ROUTE_RECORD');
    }
    const node = this.nodes[frame.remote64];
    if (node && node.addr16 != frame.remote16) {
      node.addr16 = frame.remote16;
      this.saveDeviceInfoDeferred();
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
        } else if (this.isZhaFrame(frame) || this.isZllFrame(frame)) {
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
      if (frame.extraParams) {
        waitFrame.extraParams = frame.extraParams;
      }
      if (frame.callback) {
        waitFrame.callback = frame.callback;
      }
      if (frame.timeoutFunc) {
        waitFrame.timeoutFunc = frame.timeoutFunc;
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
    if (DEBUG_flow) {
      console.log('createNodeIfRequired:', addr64, addr16);
    }

    if (addr64 == 'ffffffffffffffff') {
      // We can't create a new node if we don't know the 64-bit address.
      // Hopefully, we've seen this node before.
      return this.findNodeByAddr16(addr16);
    }

    let node = this.nodes[addr64];
    if (node) {
      // Update the 16-bit address, since it may have changed.
      if (node.addr16 != addr16) {
        node.addr16 = addr16;
        this.saveDeviceInfoDeferred();
      }
    } else {
      node = this.nodes[addr64] = new ZigbeeNode(this, addr64, addr16);
      this.saveDeviceInfoDeferred();
    }
    return node;
  }

  handleEndDeviceAnnouncement(frame) {
    if (DEBUG_flow) {
      console.log('Processing END_DEVICE_ANNOUNCEMENT',
                  frame.zdoAddr64, frame.zdoAddr16);
    }
    if (this.isPairing) {
      this.cancelPairing();
    }
    if (this.scanning) {
      if (DEBUG_flow) {
        console.log('Ignoring END_DEVICE_ANNOUNCEMENT - scanning in progress');
      }
      return;
    }

    // Create the node now, since we know the 64 and 16 bit addresses. This
    // allows us to process broadcasts which only come in with a 16-bit address.
    const node = this.createNodeIfRequired(frame.zdoAddr64, frame.zdoAddr16);
    if (node) {
      if (node.classified && !node.family) {
        // For regular Zigbee nodes that we've already classified, we
        // don't need to delay.
        this.handleEndEndDeviceAnnouncementInternal(node);
        node.rebindIfRequired();
      } else {
        // Xiaomi devices send a genReport right after sending the end device
        // announcement, so we introduce a slight delay to allow this to happen
        // before we assume that it's a regular device.
        setTimeout(() => {
          if (DEBUG_flow) {
            console.log('Processing END_DEVICE_ANNOUNCEMENT (after timeout)');
          }
          this.handleEndEndDeviceAnnouncementInternal(node);
        }, 500);
      }
    }
  }

  handleEndEndDeviceAnnouncementInternal(node) {
    if (DEBUG_flow) {
      console.log('handleEndEndDeviceAnnouncementInternal:', node.addr64,
                  'isMainsPowered:', node.isMainsPowered(),
                  'classified:', node.classified,
                  'rebindRequired:', node.rebindRequired);
    }
    if (node.isMainsPowered() || !node.classified) {
      // We get an end device announcement when adding devices through
      // pairing, or for routers (typically not battery powered) when they
      // get powered on. In this case we want to do an initialRead so that
      // we can sync the state.
      node.properties.forEach((property) => {
        property.setInitialReadNeeded();
      });
      this.populateNodeInfo(node);
    }
  }

  // ----- MATCH DESCRIPTOR REQUEST ------------------------------------------

  handleMatchDescriptorRequest(frame) {
    const node = this.createNodeIfRequired(frame.remote64, frame.remote16);
    if (!node) {
      return;
    }
    if (this.scanning) {
      if (DEBUG_flow) {
        console.log('Ignoring Match Descriptor Request - scanning in progress');
      }
      return;
    }

    for (const inputCluster of frame.inputClusters) {
      switch (inputCluster) {
        case CLUSTER_ID.GENOTA_HEX:
          // Indicate that we support the OTA cluster
          this.sendMatchDescriptorResponse(node, frame, 1);
          break;
      }
    }

    for (const outputCluster of frame.outputClusters) {
      switch (outputCluster) {
        case CLUSTER_ID.SSIASZONE_HEX:
          // Sensors which are "Security sensors" will ask if we support
          // the SSIASZONE cluster, so we tell them that we do.
          this.sendMatchDescriptorResponse(node, frame, 1);
          break;

        case CLUSTER_ID.GENPOLLCTRL_HEX: {
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
    if (DEBUG_flow) {
      console.log('getActiveEndpoint node.addr64 =', node.addr64);
    }
    this.queueCommandsAtFront(this.getActiveEndpointCommands(node));
  }

  getActiveEndpointCommands(node) {
    if (DEBUG_flow) {
      console.log('getActiveEndpointCommands node.addr64 =', node.addr64);
    }
    this.activeEndpointResponseCount = 0;
    this.activeEndpointRetryCount = 0;
    return this.getActiveEndpointCommandsOnly(node);
  }

  getActiveEndpointCommandsOnly(node) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log('getManagementLqi node.addr64 =', node.addr64,
                  'startIndex:', startIndex);
    }

    this.queueCommandsAtFront(this.getManagementLqiCommands(node, startIndex));
  }

  getManagementLqiCommands(node, startIndex) {
    if (!startIndex) {
      startIndex = 0;
    }
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log('Processing CLUSTER_ID.MANAGEMENT_LQI_RESPONSE');
    }
    const node = this.createNodeIfRequired(frame.remote64, frame.remote16);

    for (let i = 0; i < frame.numEntriesThisResponse; i++) {
      const neighborIndex = frame.startIndex + i;
      const neighbor = frame.neighbors[i];
      node.neighbors[neighborIndex] = neighbor;
      if (DEBUG_flow) {
        console.log('Added neighbor', neighbor.addr64);
      }
      const neighborNode =
        this.createNodeIfRequired(neighbor.addr64, neighbor.addr16);
      if (neighborNode) {
        neighborNode.deviceType = neighbor.deviceType;
        neighborNode.rxOnWhenIdle = neighbor.rxOnWhenIdle;
      }
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
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log('getNodeDescriptors');
    }
    this.enumerateAllNodes(this.getNodeDescriptor);
  }

  getNodeDescriptor(node) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log('getSimpleDescriptor node.addr64 =', node.addr64,
                  'endpoint =', endpointNum);
    }
    this.queueCommandsAtFront(
      this.getSimpleDescriptorCommands(node, endpointNum));
  }

  getSimpleDescriptorCommands(node, endpointNum) {
    if (DEBUG_flow) {
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
        timeoutFunc: () => {
          endpoint.queryingSimpleDescriptor = false;
        },
      }),
    ];
  }

  handleSimpleDescriptorResponse(frame) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log(`removeThing(${node.addr64})`);
    }
    node.removed = true;
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
    if (DEBUG_flow) {
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

    node.added = false;
    this.handleDeviceRemoved(node);
    this.saveDeviceInfoDeferred();
    if (DEBUG_flow) {
      console.log('----- Management Leave -----');
      this.dumpNodes();
    }
  }

  handleManagementLeaveResponse(frame) {
    if (DEBUG_flow) {
      console.log('handleManagementLeaveResponse: addr64 =',
                  frame.remote64);
    }
    if (frame.status != STATUS.SUCCESS) {
      // This means that the device didn't unpair from the network. So
      // we're going to keep around our knowledge of the device since it
      // still thinks its part of the network.
      if (DEBUG_flow) {
        console.log('handleManagementLeaveResponse:',
                    'status failed - returning');
      }
      return;
    }
    const node = this.nodes[frame.remote64];
    if (!node) {
      if (DEBUG_flow) {
        console.log('handleManagementLeaveResponse:',
                    'node not found - returning');
      }
      return;
    }

    if (DEBUG_flow) {
      console.log('handleManagementLeaveResponse: Removing node:', node.addr64);
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

    if (DEBUG_flow) {
      console.log(`----- Permit Join (${seconds}) -----`);
      this.dumpNodes();
    }

    const permitJoinFrame = this.zdo.makeFrame({
      destination64: '000000000000ffff',
      destination16: 'fffe',
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_PERMIT_JOIN_REQUEST,
      permitDuration: seconds,
      trustCenterSignificance: 0,
    });
    if (DEBUG_frames) {
      permitJoinFrame.shortDescr =
        `permitDuration: ${permitJoinFrame.permitDuration}`;
    }

    this.queueCommandsAtFront([
      this.AT(AT_CMD.NODE_JOIN_TIME,
              {networkJoinTime: seconds},
              PERMIT_JOIN_PRIORITY),
      new Command(SEND_FRAME, permitJoinFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: permitJoinFrame.id,
      }),
    ]);
  }

  startPairing(timeoutSeconds) {
    console.log('Pairing mode started, timeout =', timeoutSeconds);
    for (const nodeId in this.nodes) {
      const node = this.nodes[nodeId];
      if (node.removed) {
        this.handleDeviceAdded(node);
      }
    }
    this.isPairing = true;
    this.permitJoin(timeoutSeconds);
  }

  cancelPairing() {
    console.log('Cancelling pairing mode');
    this.isPairing = false;
    this.permitJoin(0);
  }

  // ----- Discover Attributes -----------------------------------------------

  discoverAttributes(node, discoverEndpointNum, discoverCluster) {
    this.waitFrameTimeoutFunc = this.discoverAttributesTimeout.bind(this);
    node.discoveringAttributes = true;
    console.log('discover: **** Starting discovery for node:', node.id,
                'endpointNum:', discoverEndpointNum,
                'clusterId:', discoverCluster, '*****');
    let commands = [];
    for (const endpointNum in node.activeEndpoints) {
      if (discoverEndpointNum && endpointNum != discoverEndpointNum) {
        continue;
      }
      const endpoint = node.activeEndpoints[endpointNum];

      commands = commands.concat(
        FUNC(this, this.print,
             [`discover:   Input clusters for endpoint ${endpointNum}`])
      );
      if (endpoint.inputClusters && endpoint.inputClusters.length) {
        for (const inputCluster of endpoint.inputClusters) {
          if (discoverCluster && discoverCluster != inputCluster) {
            continue;
          }
          const inputClusterId = parseInt(inputCluster, 16);
          const zclCluster = zclId.clusterId.get(inputClusterId);
          let inputClusterStr = inputCluster;
          if (zclCluster) {
            inputClusterStr += ` - ${zclCluster.key}`;
          }
          commands = commands.concat(
            FUNC(this, this.print, [`discover:     ${inputClusterStr}`])
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
             [`discover:   Output clusters for endpoint ${endpointNum}`])
      );
      if (endpoint.outputClusters && endpoint.outputClusters.length) {
        for (const outputCluster of endpoint.outputClusters) {
          if (discoverCluster && discoverCluster != outputCluster) {
            continue;
          }
          const outputClusterId = parseInt(outputCluster, 16);
          const zclCluster = zclId.clusterId.get(outputClusterId);
          let outputClusterStr = outputCluster;
          if (zclCluster) {
            outputClusterStr += ` - ${zclCluster.key}`;
          }
          commands = commands.concat(
            FUNC(this, this.print, [`discover:     ${outputClusterStr}`])
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
    console.log('discover: ***** Discovery done for node:', node.id, '*****');
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
        console.log('discover:       AttrId:',
                    `${attrStr} (${attrEntry.attrId})`,
                    'read failed');
      }
    }
  }

  // ----- Read Attribute ----------------------------------------------------

  // readAttribute is used to support debugCmd - readAttr
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
    if (DEBUG_flow) {
      console.log('sendFrameNow');
    }
    if (DEBUG_frames) {
      this.dumpFrame('Sent:', frame);
    }
    const rawFrame = this.xb.buildFrame(frame);
    if (DEBUG_rawFrames) {
      console.log('Sent:', rawFrame);
    }
    this.serialport.write(rawFrame, serialWriteError);
  }

  // -------------------------------------------------------------------------

  addIfReady(node) {
    this.saveDeviceInfoDeferred();

    if (!node.activeEndpointsPopulated && !this.scanning) {
      if (DEBUG_flow) {
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
          if (DEBUG_flow) {
            console.log('addIfReady:', node.addr64, 'endpoint', endpointNum,
                        'classifier attributes not read yet');
          }
          this.populateNodeInfoEndpoints(node);
        }
        return;
      }
    }
    this.handleDeviceAdded(node);
    node.rebindIfRequired();
  }

  handleDeviceAdded(node) {
    if (DEBUG_flow) {
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
      node.removed = false;
    }
  }

  handleDeviceDescriptionUpdated(node) {
    super.handleDeviceAdded(node);
    this.saveDeviceInfoDeferred();
  }

  handleFrame(frame) {
    if (DEBUG_frameParsing) {
      this.dumpFrame('Rcvd (before parsing):', frame);
    }
    this.frameDumped = false;
    const frameHandler = ZigbeeAdapter.frameHandler[frame.type];
    if (frameHandler) {
      if (this.waitFrame && this.waitFrame.extraParams) {
        frame.extraParams = this.waitFrame.extraParams;
      }
      frameHandler.call(this, frame);
    }
    if (DEBUG_frames && !this.frameDumped) {
      this.dumpFrame('Rcvd:', frame);
    }

    if (this.waitFrame) {
      if (DEBUG_flow) {
        console.log('Waiting for', this.waitFrame);
      }
      let match = true;
      const specialNames = [
        'sendOnSuccess',
        'callback',
        'timeoutFunc',
        'waitRetryCount',
        'waitRetryMax',
        'extraParams',
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
        if (DEBUG_flow || DEBUG_frameDetail) {
          console.log('Wait satisified');
        }
        const sendOnSuccess = this.waitFrame.sendOnSuccess;
        const callback = this.waitFrame.callback;
        this.waitFrame = null;
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
      } else if (DEBUG_flow || DEBUG_frameDetail) {
        console.log('Wait NOT satisified');
        console.log('    waitFrame =', this.waitFrame);
      }
    }
    this.run();
  }

  isZhaFrame(frame) {
    if (typeof frame.profileId === 'number') {
      return frame.profileId === PROFILE_ID.ZHA;
    }
    return frame.profileId === PROFILE_ID.ZHA_HEX;
  }

  isZllFrame(frame) {
    if (typeof frame.profileId === 'number') {
      return frame.profileId === PROFILE_ID.ZLL;
    }
    return frame.profileId === PROFILE_ID.ZLL_HEX;
  }

  populateNodeInfo(node) {
    if (DEBUG_flow) {
      console.log('populateNodeInfo node.addr64 =', node.addr64,
                  'rebindRequired:', node.rebindRequired);
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
    if (DEBUG_flow) {
      console.log('populateClassifierAttributes node.addr64 =', node.addr64,
                  'endpointNum =', endpointNum,
                  'classifierAttributesPopulated =',
                  endpoint.classifierAttributesPopulated);
    }

    if (endpoint.classifierAttributesPopulated) {
      this.addIfReady(node);
      return;
    }

    if (!node.hasOwnProperty('modelId')) {
      if (node.endpointHasZhaInputClusterIdHex(endpoint,
                                               CLUSTER_ID.GENBASIC_HEX)) {
        const readFrame = node.makeReadAttributeFrame(
          endpointNum,
          PROFILE_ID.ZHA, // IKEA bulbs require PROFILE_ID.ZHA
          CLUSTER_ID.GENBASIC,
          [
            ATTR_ID.GENBASIC.MODELID,
            ATTR_ID.GENBASIC.POWERSOURCE,
          ],
        );
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: () => {
            this.populateClassifierAttributes(node, endpointNum);
          },
        });
        return;
      }
    }

    if (endpointNum == node.lightingColorCtrlEndpoint) {
      if (node.hasOwnProperty('colorCapabilities') &&
          node.hasOwnProperty('colorMode')) {
        this.setClassifierAttributesPopulated(node, endpointNum);
      } else {
        const readFrame = node.makeReadAttributeFrame(
          node.lightingColorCtrlEndpoint,
          PROFILE_ID.ZHA, // IKEA bulbs require PROFILE_ID.ZHA
          CLUSTER_ID.LIGHTINGCOLORCTRL,
          [
            ATTR_ID.LIGHTINGCOLORCTRL.COLORCAPABILITIES,
            ATTR_ID.LIGHTINGCOLORCTRL.COLORMODE,
          ]);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: this.populateClassifierAttributesLightingControl.bind(this),
        });
      }
      return;
    }

    if (endpointNum == node.ssIasZoneEndpoint) {
      if (node.hasOwnProperty('zoneType')) {
        if (DEBUG_flow) {
          console.log('populateClassifierAttributes has zoneType - done');
        }
        this.setClassifierAttributesPopulated(node, endpointNum);
      } else {
        if (node.readingZoneType) {
          if (DEBUG_flow) {
            console.log('populateClassifierAttributes: read of zoneType',
                        'already in progress');
          }
          return;
        }
        if (DEBUG_flow) {
          console.log('populateClassifierAttributes has no zoneType -',
                      'querying via read');
        }
        // zoneType is the only field that the classifier actually needs.
        // We read the status and cieAddr to save a read later.
        node.readingZoneType = true;
        const readFrame = node.makeReadAttributeFrame(
          node.ssIasZoneEndpoint,
          PROFILE_ID.ZHA,
          CLUSTER_ID.SSIASZONE,
          [
            ATTR_ID.SSIASZONE.ZONESTATE,
            ATTR_ID.SSIASZONE.ZONETYPE,
            ATTR_ID.SSIASZONE.ZONESTATUS,
            ATTR_ID.SSIASZONE.IASCIEADDR,
            ATTR_ID.SSIASZONE.ZONEID,
          ]);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: () => {
            node.readingZoneType = false;
            if (this.hasOwnProperty('zoneType')) {
              this.setClassifierAttributesPopulated(this,
                                                    this.ssIasZoneEndpoint);
            }
          },
          timeoutFunc: () => {
            node.readingZoneType = false;
          },
        });
      }
      return;
    }

    // Since we got to here, this endpoint doesn't need any classifier
    // attributes
    this.setClassifierAttributesPopulated(node, endpointNum);
  }

  populateClassifierAttributesLightingControl(frame) {
    if (DEBUG_flow) {
      console.log('populateClassifierAttributesLightingControl');
    }
    const node = this.nodes[frame.remote64];
    if (!node) {
      return;
    }
    for (const attrEntry of frame.zcl.payload) {
      if (attrEntry.status != 0) {
        // Attribute not supported. For colorCapabilites and colorMode
        // we use a value of 0 to cover this case.
        attrEntry.data = 0;
      }
      switch (attrEntry.attrId) {
        case ATTR_ID.LIGHTINGCOLORCTRL.COLORCAPABILITIES:
          node.colorCapabilities = attrEntry.attrData;
          break;
        case ATTR_ID.LIGHTINGCOLORCTRL.COLORMODE:
          node.colorMode = attrEntry.attrData;
          break;
      }
    }
    // The sourceEndpoint comes back as a hex string. Convert it to decimal
    const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
    this.setClassifierAttributesPopulated(node, sourceEndpoint);
  }

  populateClassifierAttributesIasZone(frame) {
    if (DEBUG_flow) {
      console.log('populateClassifierAttributesIasZone');
    }
    const node = this.nodes[frame.remote64];
    if (node) {
      node.handleIasReadResponse(frame);
    }
  }

  setClassifierAttributesPopulated(node, endpointNum) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      console.log('populateNodeInfoEndpoints node.addr64 =', node.addr64);
    }

    // As soon as we know about the genPollCtrl endpoint, set the checkin
    // interval
    const genPollCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.GENPOLLCTRL_HEX);
    if (genPollCtrlEndpoint && !this.scanning) {
      node.genPollCtrlEndpoint = genPollCtrlEndpoint;
      node.writeCheckinInterval();
    }

    // Check to see that have all of the simple descriptors
    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];
      if (!endpoint.hasOwnProperty('profileId')) {
        if (!endpoint.queryingSimpleDescriptor && !this.scanning) {
          // We don't have the simpleDescriptor information
          // (profileId is missing) and we don't have a command queued up to
          // retrieve it - queue one up.
          if (DEBUG_flow) {
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

    // Assign significant endpoint numbers here, before the call to addIfReady.
    // These are significant because the classifier expects that they've been
    // initialized already. If we're using cached device info, it's possible
    // that classifierAttributesPopulated will be set to true the first time
    // through this function.
    node.lightingColorCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.LIGHTINGCOLORCTRL_HEX);
    node.ssIasZoneEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.SSIASZONE_HEX);

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
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      this.dumpCommands();
    }
    if (!this.running) {
      this.run();
    }
  }

  queueCommandsAtFront(cmdSeq) {
    if (DEBUG_flow) {
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
    if (DEBUG_flow) {
      this.dumpCommands();
    }
    if (!this.running) {
      this.run();
    }
  }

  run() {
    if (DEBUG_flow) {
      console.log('run queue len =', this.cmdQueue.length,
                  'running =', this.running);
    }
    if (this.waitFrame) {
      if (DEBUG_flow) {
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
          if (DEBUG_flow) {
            console.log(`${sentPrefix}SEND_FRAME`);
          }
          if (DEBUG_frames) {
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
          if (DEBUG_rawFrames) {
            console.log(`${sentPrefix}Sent:`, rawFrame);
          }
          this.serialport.write(rawFrame, serialWriteError);
          this.lastFrameSent = frame;
          break;
        }
        case WAIT_FRAME: {
          this.waitFrame = cmd.cmdData;
          if (!this.waitFrame.hasOwnProperty('waitRetryCount')) {
            this.waitFrame.waitRetryCount = 1;
          }
          if (!this.waitFrame.hasOwnProperty('waitRetryMax')) {
            this.waitFrame.waitRetryMax = WAIT_RETRY_MAX;
          }
          let timeoutDelay = WAIT_TIMEOUT_DELAY;
          if (this.lastFrameSent && this.lastFrameSent.destination64) {
            const node = this.nodes[this.lastFrameSent.destination64];
            if (node && node.extendedTimeout) {
              timeoutDelay = EXTENDED_TIMEOUT_DELAY;
            }
          }
          if (DEBUG_frameDetail) {
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
          if (DEBUG_frameDetail) {
            console.log('EXEC_FUNC', func.name);
          }
          func.apply(ths, args);
          break;
        }
        case RESOLVE_SET_PROPERTY: {
          const property = cmd.cmdData;
          if (DEBUG_frameDetail) {
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
          console.log('#####');
          console.log(`##### UNKNOWN COMMAND: ${cmd.cmdType} #####`);
          console.log('#####');
          break;
      }
    }
    this.running = false;
  }

  waitTimedOut() {
    if (DEBUG_frameDetail) {
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

    if (waitFrame.waitRetryCount >= waitFrame.waitRetryMax) {
      if (DEBUG_flow) {
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
      waitFrame.waitRetryCount += 1;
      if (DEBUG_frames) {
        console.log('Resending',
                    `(${waitFrame.waitRetryCount}/${waitFrame.waitRetryMax})`,
                    '...');
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
zch[zdo.CLUSTER_ID.IEEE_ADDRESS_RESPONSE] =
  ZigbeeAdapter.prototype.handleIEEEAddressResponse;
zch[zdo.CLUSTER_ID.NETWORK_ADDRESS_RESPONSE] =
  ZigbeeAdapter.prototype.handleNetworkAddressResponse;
zch[zdo.CLUSTER_ID.MANAGEMENT_BIND_RESPONSE] =
  ZigbeeAdapter.prototype.handleManagementBindResponse;
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

registerFamilies();

module.exports = ZigbeeAdapter;

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
const ZigbeeNode = require('./zb-node');
const SerialPort = require('serialport');
const xbeeApi = require('xbee-api');
const at = require('./zb-at');
const util = require('util');
const zdo = require('./zb-zdo');
const zcl = require('zcl-packet');
const zclId = require('zcl-id');
const zigBeeClassifier = require('./zb-classifier');

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

const CLUSTER_ID_GENPOLLCTRL = zclId.cluster('genPollCtrl').value;
const CLUSTER_ID_GENPOLLCTRL_HEX = utils.hexStr(CLUSTER_ID_GENPOLLCTRL, 4);

const ATTR_ID_GENPOLLCTRL_CHECKININTERVAL =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'checkinInterval').value;
const ATTR_ID_GENPOLLCTRL_LONGPOLLINTERVAL =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'longPollInterval').value;
const ATTR_ID_GENPOLLCTRL_SHORTPOLLINTERVAL =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'shortPollInterval').value;
const ATTR_ID_GENPOLLCTRL_FASTPOLLINTERVAL =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'fastPollTimeout').value;

const CLUSTER_ID_SSIASZONE = zclId.cluster('ssIasZone').value;
const CLUSTER_ID_SSIASZONE_HEX = utils.hexStr(CLUSTER_ID_SSIASZONE, 4);

const ATTR_ID_SSIASZONE_ZONETYPE =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneType').value;
const ATTR_ID_SSIASZONE_ZONESTATUS =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneStatus').value;
const ATTR_ID_SSIASZONE_CIEADDR =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'iasCieAddr').value;

const WAIT_TIMEOUT_DELAY = 1000;
const EXTENDED_TIMEOUT_DELAY = 3 * WAIT_TIMEOUT_DELAY;
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

class Command {
  constructor(cmdType, cmdData) {
    this.cmdType = cmdType;
    this.cmdData = cmdData;
  }

  print(adapter, idx) {
    const idxStr = `${`    ${idx}`.slice(-4)}: `;
    switch (this.cmdType) {
      case SEND_FRAME:
        adapter.dumpFrame(`${idxStr}SEND:`, this.cmdData);
        break;
      case WAIT_FRAME:
        console.log(`${idxStr}WAIT`);
        break;
      case EXEC_FUNC:
        console.log(`${idxStr}EXEC:`, this.cmdData[1].name, this.cmdData[2]);
        break;
      case RESOLVE_SET_PROPERTY:
        console.log(`${idxStr}RESOLVE_SET_PROPERTY`);
        break;
      default:
        console.log(`${idxStr}UNKNOWN`);
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
          const frame = this.xb.parseFrame(rawFrame);
          this.handleFrame(frame);
        }
      });
    } else {
      this.xb.on('frame_object', (frame) => {
        this.handleFrame(frame);
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
      console.log('adapter initialized');
    }
    this.dumpInfo();
    this.id = `zb-${this.serialNumber}`;
    this.manager.addAdapter(this);

    // Use this opertunity to create the node for the Coordinator.

    const coordinator = this.nodes[this.serialNumber] =
      new ZigbeeNode(this, this.serialNumber, this.networkAddr16);

    // Go find out what devices are on the network.
    this.queueCommands(
      this.getManagementLqiCommands(coordinator)
        .concat(this.getManagementRtgCommands(coordinator))
        .concat([
          FUNC(this, this.handleDeviceAdded, [coordinator]),
          FUNC(this, this.enumerateAllNodes, [this.populateNodeInfo]),
          FUNC(this, this.dumpNodes, []),
          FUNC(this, this.print, ['----- Scan Complete -----']),
        ]));
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
      '       Device Type:',
      `0x${this.deviceTypeIdentifier.toString(16)} - ${deviceTypeString}`);
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
          assert(cmd2 instanceof Command, 'Expecting instance of Command');
          cmds.push(cmd2);
        }
      } else {
        assert(cmd instanceof Command, 'Expecting instance of Command');
        cmds.push(cmd);
      }
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
      this.zdo.parseZdoFrame(frame);
      if (this.debugFrames) {
        this.dumpFrame('Rcvd:', frame);
      }
      const clusterId = parseInt(frame.clusterId, 16);
      if (clusterId in ZigbeeAdapter.zdoClusterHandler) {
        ZigbeeAdapter.zdoClusterHandler[clusterId].call(this, frame);
      } else {
        console.error('No handler for ZDO cluster:', clusterId);
      }
    } else if (this.isZhaFrame(frame)) {
      zcl.parse(frame.data, parseInt(frame.clusterId, 16), (error, data) => {
        if (error) {
          console.log('Error parsing ZHA frame:', frame);
          console.log(error);
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
          const node = this.nodes[frame.remote64];
          if (node) {
            node.handleZhaResponse(frame);
          }
        }
      });
    }
  }

  handleTransmitStatus(frame) {
    if (frame.deliveryStatus !== 0) {
      console.error('Transmit Status ERROR:',
                    this.getDeliveryStatusAsString(frame.deliveryStatus));
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
            zdoSeq: frame.id,
            sendOnSuccess: frame.sendOnSuccess,
          };
        } else if (this.isZhaFrame(frame)) {
          waitFrame = {
            type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
            zclSeqNum: frame.id,
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

  handleEndDeviceAnnouncement(frame) {
    if (this.debugFlow) {
      console.log('Processing END_DEVICE_ANNOUNCEMENT');
    }

    let node = this.nodes[frame.zdoAddr64];
    if (node) {
      // This probably shouldn't happen, but if it does, update the
      // 16 bit address.
      node.addr16 = frame.zdoAddr16;
    } else {
      node = this.nodes[frame.zdoAddr64] =
        new ZigbeeNode(this, frame.zdoAddr64, frame.zdoAddr16);
    }
    if (this.isPairing) {
      this.cancelPairing();
    }
    this.populateNodeInfo(node);
  }

  // ----- MATCH DESCRIPTOR REQUEST ------------------------------------------

  handleMatchDescriptorRequest(frame) {
    if (frame.outputClusters.indexOf(CLUSTER_ID_SSIASZONE_HEX) >= 0) {
      // Sensors which are "Security sensors" will ask if we support
      // the SSIASZONE cluster, so we tell them that we do.
      this.queueCommandsAtFront([new Command(SEND_FRAME, this.zdo.makeFrame({
        destination64: frame.remote64,
        destination16: frame.remote16,
        clusterId: zdo.CLUSTER_ID.MATCH_DESCRIPTOR_RESPONSE,
        status: 0,
        zdoAddr16: frame.remote16,
        endpoints: [1],
      }))]);
    }
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
    const nodeDescFrame = this.zdo.makeFrame({
      destination64: node.addr64,
      destination16: node.addr16,
      clusterId: zdo.CLUSTER_ID.ACTIVE_ENDPOINTS_REQUEST,
    });
    return [
      new Command(SEND_FRAME, nodeDescFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: nodeDescFrame.id,
      }),
      FUNC(this, this.retryGetActiveEndpointIfNeeded, [node]),
    ];
  }

  retryGetActiveEndpointIfNeeded(node) {
    if (this.debugFlow) {
      console.log('retryGetActiveEndpointIfNeeded node.addr64 =', node.addr64,
                  'responseCount =', this.activeEndpointResponseCount,
                  'retryCount =', this.activeEndpointRetryCount);
    }
    if (this.activeEndpointResponseCount > 0) {
      return;
    }
    this.activeEndpointRetryCount++;
    if (this.activeEndpointRetryCount < 5) {
      this.queueCommandsAtFront(this.getActiveEndpointCommandsOnly(node));
    }
  }

  handleActiveEndpointsResponse(frame) {
    if (this.debugFlow) {
      console.log('Processing ACTIVE_ENDPOINTS_RESPONSE');
    }
    this.activeEndpointResponseCount++;
    const node = this.nodes[frame.remote64];
    if (node) {
      for (const endpoint of frame.activeEndpoints) {
        if (!(endpoint in node.activeEndpoints)) {
          node.activeEndpoints[endpoint] = {populated: false};
        }
      }
      node.activeEndpointsPopulated = true;
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
        this.nodes[neighbor.addr64] =
          new ZigbeeNode(this, neighbor.addr64, neighbor.addr16);
        neighborNode = this.nodes[neighbor.addr64];
      }
      if (neighborNode.addr16 == 'fffe') {
        neighborNode.addr16 = neighbor.addr16;
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

  getSimpleDescriptors(node) {
    if (this.debugFlow) {
      console.log('getSimpleDescriptors node.addr64 =', node.addr64);
    }
    let commands = [];
    for (const endpointNum in node.activeEndpoints) {
      // Only ask for the simple descriptor if we don't already
      // know what it is. This is especially important for battery
      // operated devices
      const endpoint = node.activeEndpoints[endpointNum];
      if (!endpoint.hasOwnProperty('profileId')) {
        commands = commands.concat(
          this.getSimpleDescriptorCommands(node, endpointNum));
      }
    }

    if (this.debugDiscoverAttributes) {
      // If we're configured to do so, then ask for and print out
      // the attributes available for each cluster.
      commands = commands.concat(
        FUNC(this, this.discoverAttributes, [node])
      );
    }
    this.queueCommandsAtFront(commands);
  }

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
        zdoSeq: simpleDescFrame.id,
      }),
    ];
  }

  handleSimpleDescriptorResponse(frame) {
    if (this.debugFlow) {
      console.log('Processing SIMPLE_DESCRIPTOR_RESPONSE');
    }
    const node = this.nodes[frame.remote64];
    if (node) {
      const endpoint = node.activeEndpoints[frame.endpoint];
      if (endpoint) {
        endpoint.profileId = frame.appProfileId;
        endpoint.deviceId = frame.appDeviceId;
        endpoint.deviceVersion = frame.appDeviceVersion;
        endpoint.inputClusters = frame.inputClusters.slice(0);
        endpoint.outputClusters = frame.outputClusters.slice(0);
      }
    }
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
    this.handleDeviceRemoved(node);
  }

  handleManagementLeaveResponse(_frame) {
    // We've already removed the device, so we don't need
    // to do anything else.
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
            node.makeDiscoverAttributesFrame(endpointNum,
                                             endpoint.profileId,
                                             inputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.id,
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
            node.makeDiscoverAttributesFrame(endpointNum,
                                             endpoint.profileId,
                                             outputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.id,
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
        zclSeqNum: readFrame.id,
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

  sendFrameWaitFrameAtFront(sendFrame, waitFrame) {
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, sendFrame),
      new Command(WAIT_FRAME, waitFrame),
    ]);
  }

  sendFrameWaitFrame(sendFrame, waitFrame) {
    this.queueCommands([
      new Command(SEND_FRAME, sendFrame),
      new Command(WAIT_FRAME, waitFrame),
    ]);
  }

  sendFrameWaitFrameResolve(sendFrame, waitFrame, property) {
    this.queueCommands([
      new Command(SEND_FRAME, sendFrame),
      new Command(WAIT_FRAME, waitFrame),
      new Command(RESOLVE_SET_PROPERTY, property),
    ]);
  }

  // -------------------------------------------------------------------------

  handleDeviceAdded(node) {
    if (this.debugFlow) {
      console.log('ZigbeeAdapter: handleDeviceAdded: ', node.addr64);
    }
    // Only add the device if we haven't already added it.
    if (!node.added) {
      if (node.isCoordinator) {
        node.name = node.defaultName;
      } else {
        zigBeeClassifier.classify(node);
        super.handleDeviceAdded(node);
        node.added = true;
      }
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
      for (const propertyName in this.waitFrame) {
        if (propertyName === 'sendOnSuccess' || propertyName === 'callback') {
          continue;
        }
        if (this.waitFrame[propertyName] != frame[propertyName]) {
          match = false;
          break;
        }
      }
      if (match) {
        if (this.debugFlow) {
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
    let commands = [];
    if (!node.activeEndpointsPopulated) {
      commands = commands.concat(this.getActiveEndpointCommands(node));
    }
    commands = commands.concat([
      FUNC(this, this.populateNodeInfoEndpoints, [node]),
      FUNC(this, this.populateNodeAttributes, [node]),
      FUNC(this, this.handleDeviceAdded, [node]),
    ]);
    this.queueCommandsAtFront(commands);
  }

  // populateNodeAttrbibutes will read attributes which are required by
  // the classifier to determine the type of thing its dealing with.
  populateNodeAttributes(node) {
    if (this.debugFlow) {
      console.log('populateNodeAttributes node.addr64 =', node.addr64);
    }

    const lightingColorCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID_LIGHTINGCOLORCTRL_HEX);
    if (lightingColorCtrlEndpoint) {
      node.lightingColorCtrlEndpoint = lightingColorCtrlEndpoint;
      if (!node.hasOwnProperty('colorCapabilities')) {
        const readFrame = node.makeReadAttributeFrame(
          lightingColorCtrlEndpoint,
          ZHA_PROFILE_ID,
          CLUSTER_ID_LIGHTINGCOLORCTRL,
          ATTR_ID_LIGHTINGCOLORCTRL_COLORCAPABILITIES);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.id,
          callback: this.populateNodeAttributesLightingControl.bind(this),
        });
      }
    }

    const ssIasZoneEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SSIASZONE_HEX);
    if (ssIasZoneEndpoint) {
      node.ssIasZoneEndpoint = ssIasZoneEndpoint;
      if (!node.hasOwnProperty('zoneType') ||
          !node.hasOwnProperty('zoneStatus')) {
        const readFrame = node.makeReadAttributeFrame(
          ssIasZoneEndpoint,
          ZHA_PROFILE_ID,
          CLUSTER_ID_SSIASZONE,
          [
            ATTR_ID_SSIASZONE_ZONETYPE,
            ATTR_ID_SSIASZONE_ZONESTATUS,
            ATTR_ID_SSIASZONE_CIEADDR,
          ]);
        this.sendFrameWaitFrameAtFront(readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.id,
          callback: this.populateNodeAttributesIasZone.bind(this),
        });
      }
    }
  }

  populateNodeAttributesLightingControl(frame) {
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
  }

  populateNodeAttributesIasZone(frame) {
    const node = this.nodes[frame.remote64];
    if (!node) {
      return;
    }
    let cieAddr;
    for (const attrEntry of frame.zcl.payload) {
      if (attrEntry.status == 0) {
        switch (attrEntry.attrId) {
          case ATTR_ID_SSIASZONE_ZONETYPE:
            node.zoneType = attrEntry.attrData;
            break;
          case ATTR_ID_SSIASZONE_ZONESTATUS:
            node.zoneStatus = attrEntry.attrData;
            break;
          case ATTR_ID_SSIASZONE_CIEADDR:
            cieAddr = attrEntry.attrData;
            break;
        }
      }
    }
    const ourCieAddr = `0x${this.serialNumber}`;
    let commands = [];

    if (cieAddr != ourCieAddr) {
      // Tell the sensor to send statusChangeNotifications to us.
      const writeFrame = node.makeWriteAttributeFrame(
        frame.sourceEndpoint,
        ZHA_PROFILE_ID,
        CLUSTER_ID_SSIASZONE,
        [[ATTR_ID_SSIASZONE_CIEADDR, ourCieAddr]]
      );
      commands = commands.concat([
        new Command(SEND_FRAME, writeFrame),
        new Command(WAIT_FRAME, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'writeRsp',
          zclSeqNum: writeFrame.id,
        }),
      ]);
    }

    // Make sure that the sensor is "enrolled".
    const reqFrame = null;
    const rspStatus = 0;
    const zoneId = 1;
    const enrollRspFrame =
      node.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
    commands = commands.concat([
      new Command(SEND_FRAME, enrollRspFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: enrollRspFrame.id,
      }),
    ]);

    // Find out what the various poll intervals are.
    const genPollCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENPOLLCTRL_HEX);
    if (genPollCtrlEndpoint) {
      const readFrame = node.makeReadAttributeFrame(
        genPollCtrlEndpoint,
        ZHA_PROFILE_ID,
        CLUSTER_ID_GENPOLLCTRL,
        [
          ATTR_ID_GENPOLLCTRL_CHECKININTERVAL,
          ATTR_ID_GENPOLLCTRL_LONGPOLLINTERVAL,
          ATTR_ID_GENPOLLCTRL_SHORTPOLLINTERVAL,
          ATTR_ID_GENPOLLCTRL_FASTPOLLINTERVAL,
        ]);
      commands = commands.concat([
        new Command(SEND_FRAME, readFrame),
        new Command(WAIT_FRAME, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.id,
        }),
      ]);
    }

    this.queueCommandsAtFront(commands);
  }

  populateNodeInfoEndpoints(node) {
    if (this.debugFlow) {
      console.log('populateNodeInfoEndpoints node.addr64 =', node.addr64);
    }
    this.getSimpleDescriptors(node);
  }

  print(str) {
    console.log(str);
  }

  dumpCommands() {
    console.log(`Commands (${this.cmdQueue.length})`);
    for (const idx in this.cmdQueue) {
      const cmd = this.cmdQueue[idx];
      cmd.print(this, idx);
    }
    console.log('---');
  }

  queueCommands(cmdSeq) {
    if (this.debugFlow) {
      console.log('queueCommands');
    }
    this.cmdQueue = this.cmdQueue.concat(this.flattenCommands(cmdSeq));
    if (!this.running) {
      this.run();
    }
  }

  queueCommandsAtFront(cmdSeq) {
    if (this.debugFlow) {
      console.log('queueCommandsAtFront');
    }
    this.cmdQueue = this.flattenCommands(cmdSeq).concat(this.cmdQueue);
    if (!this.running) {
      this.run();
    }
  }

  run() {
    if (this.debugFlow) {
      console.log('run queue len =', this.cmdQueue.length);
    }
    if (this.waitFrame) {
      if (this.debugFlow) {
        console.log('Queue stalled waiting for frame.');
      }
      return;
    }
    if (this.running) {
      if (this.debugFlow) {
        console.log('Queue already running.');
      }
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
          const rawFrame = this.xb.buildFrame(frame);
          if (this.debugRawFrames) {
            console.log(`${sentPrefix}Sent:`, rawFrame);
          }
          this.serialport.write(rawFrame, serialWriteError);
          this.lastFrameSent = frame;
          break;
        }
        case WAIT_FRAME: {
          if (this.debugFlow) {
            console.log('WAIT_FRAME');
          }
          this.waitFrame = cmd.cmdData;
          this.waitRetryCount += 1;
          let timeoutDelay = WAIT_TIMEOUT_DELAY;
          if (this.lastFrameSent && this.lastFrameSent.destination64) {
            const node = this.nodes[this.lastFrameSent.destination64];
            if (node && node.extendedTimeout) {
              timeoutDelay = EXTENDED_TIMEOUT_DELAY;
            }
          }
          this.waitTimeout = setTimeout(this.waitTimedOut.bind(this),
                                        timeoutDelay);
          break;
        }
        case EXEC_FUNC: {
          const ths = cmd.cmdData[0];
          const func = cmd.cmdData[1];
          const args = cmd.cmdData[2];
          if (this.debugFlow) {
            console.log('EXEC_FUNC', func.name);
          }
          func.apply(ths, args);
          break;
        }
        case RESOLVE_SET_PROPERTY: {
          const property = cmd.cmdData;
          const deferredSet = property.deferredSet;
          if (deferredSet) {
            property.deferredSet = null;
            deferredSet.resolve(property.value);
          }
          break;
        }
      }
    }
    this.running = false;
  }

  waitTimedOut() {
    // We timed out waiting for a response, resend the last command.
    clearTimeout(this.waitTimeout);
    this.waitTimeout = null;

    // We need to set waitFrame back to null in order for the run
    // function to do anything.
    const waitFrame = this.waitFrame;
    this.waitFrame = null;

    if (this.waitRetryCount > WAIT_RETRY_MAX) {
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

module.exports = loadZigbeeAdapters;

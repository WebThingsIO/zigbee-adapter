/**
 *
 * xbee-driver - Driver to support the Digi XStick.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const at = require('./zb-at');
const util = require('util');
const xbeeApi = require('xbee-api');

const {
  Command,
  FUNC,
  PERMIT_JOIN_PRIORITY,
  SEND_FRAME,
  WAIT_FRAME,
  ZigbeeDriver,
} = require('./zb-driver');

const {
  DEBUG_flow,
  DEBUG_frameDetail,
  DEBUG_frames,
  DEBUG_rawFrames,
} = require('./zb-debug');

const C = xbeeApi.constants;
const AT_CMD = at.AT_CMD;

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

function serialWriteError(error) {
  if (error) {
    console.error('SerialPort.write error:', error);
    throw error;
  }
}

class XBeeDriver extends ZigbeeDriver {

  constructor(addonManager, config, portName, serialPort) {
    super(addonManager, config);
    this.portName = portName;
    this.serialPort = serialPort;

    this.serialNumber = '0000000000000000';

    this.xb = new xbeeApi.XBeeAPI({
      api_mode: 1,
      raw_frames: DEBUG_rawFrames,
    });
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
              console.error('Error handling frame_raw');
              console.error(e);
              console.error(util.inspect(frame, {depth: null}));
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
          console.error(util.inspect(frame, {depth: null}));
        }
      });
    }

    console.log(`XBeeDriver: Using serial port ${portName}`);
    this.serialPort.on('data', (chunk) => {
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
  }

  adapterInitialized() {
    this.dumpInfo();
    this.adapter.adapterInitialized();
  }

  asDeviceInfo() {
    return {
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
    };
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

  buildAndSendRawFrame(frame) {
    if (!frame.hasOwnProperty('type')) {
      frame.type = C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME;
    }
    const sentPrefix = frame.resend ? 'Re' : '';
    const rawFrame = this.xb.buildFrame(frame);
    if (DEBUG_rawFrames) {
      console.log(`${sentPrefix}Sent:`, rawFrame);
    }
    this.serialPort.write(rawFrame, serialWriteError);
  }

  close() {
    this.serialPort.close();
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
    // API Options = 1 allows Explicit Rx frames to be rcvd
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
    let configScanChannels = this.config.scanChannels;
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

  deviceTypeString() {
    if (DEVICE_TYPE.hasOwnProperty(this.deviceTypeIdentifier)) {
      return DEVICE_TYPE[this.deviceTypeIdentifier];
    }
    return '??? Unknown ???';
  }

  dumpFrame(label, frame, dumpFrameDetail) {
    if (typeof dumpFrameDetail === 'undefined') {
      dumpFrameDetail = DEBUG_frameDetail;
    }
    this.frameDumped = true;
    let frameTypeStr = this.frameTypeAsStr(frame);
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
        break;

      case C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME: {
        this.dumpZigbeeTxFrame(label, frame);
        break;
      }

      case C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX: {
        this.dumpZigbeeRxFrame(label, frame);
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
        }
        break;

      default:
        console.log(label, frameTypeStr);
    }
    if (dumpFrameDetail) {
      const frameStr = util.inspect(frame, {depth: null})
        .replace(/\n/g, `\n${label} `);
      console.log(label, frameStr);
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

  frameTypeAsStr(frame) {
    if (C.FRAME_TYPE.hasOwnProperty(frame.type)) {
      return C.FRAME_TYPE[frame.type];
    }
    return `${frame.type} (0x${frame.type.toString(16)})`;
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

  getExplicitRxFrameType() {
    return C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX;
  }

  getExplicitTxFrameType() {
    return C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME;
  }

  getFrameHandler(frame) {
    return XBeeDriver.frameHandler[frame.type];
  }

  getModemStatusAsString(modemStatus) {
    if (modemStatus in C.MODEM_STATUS) {
      return C.MODEM_STATUS[modemStatus];
    }
    return `??? 0x${modemStatus.toString(16)} ???`;
  }

  getTransmitStatusFrameType() {
    return C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS;
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
      const node = this.adapter.findNodeByAddr16(frame.remote16);
      if (node) {
        node.extendedTimeout = true;
      } else {
        console.log('Unable to find node for remote16 =', frame.remote16);
      }
    }
  }

  handleRouteRecord(frame) {
    if (DEBUG_flow) {
      console.log('Processing ROUTE_RECORD');
    }
    this.adapter.findNodeFromRxFrame(frame);
  }

  // ----- AT Commands -------------------------------------------------------

  handleAtResponse(frame) {
    if (frame.commandData.length) {
      this.at.parseFrame(frame);
      if (frame.command in XBeeDriver.atCommandMap) {
        const varName = XBeeDriver.atCommandMap[frame.command];
        this[varName] = frame[varName];
      } else if (frame.command in XBeeDriver.atResponseHandler) {
        XBeeDriver.atResponseHandler[frame.command].call(this, frame);
      }
    }
  }

  handleAtSerialNumberHigh(frame) {
    this.serialNumber =
      frame.serialNumberHigh + this.serialNumber.slice(8, 8);
    this.adapter.networkAddr64 = this.serialNumber;
    this.adapter.networkAddr16 = '0000';
  }

  handleAtSerialNumberLow(frame) {
    this.serialNumber =
      this.serialNumber.slice(0, 8) + frame.serialNumberLow;
    this.adapter.networkAddr64 = this.serialNumber;
    this.adapter.networkAddr16 = '0000';
  }

  // -------------------------------------------------------------------------

  nextFrameId() {
    return xbeeApi._frame_builder.nextFrameId();
  }

  permitJoinCommands(duration) {
    return this.AT(AT_CMD.NODE_JOIN_TIME,
                   {networkJoinTime: duration},
                   PERMIT_JOIN_PRIORITY);
  }
}

XBeeDriver.atCommandMap = {
  [AT_CMD.API_OPTIONS]: 'apiOptions',
  [AT_CMD.API_MODE]: 'apiMode',
  [AT_CMD.CONFIGURED_64_BIT_PAN_ID]: 'configuredPanId64',
  [AT_CMD.DEVICE_TYPE_IDENTIFIER]: 'deviceTypeIdentifier',
  [AT_CMD.ENCRYPTION_ENABLED]: 'encryptionEnabled',
  [AT_CMD.ENCRYPTION_OPTIONS]: 'encryptionOptions',
  [AT_CMD.NETWORK_ADDR_16_BIT]: 'networkAddr16',
  [AT_CMD.NODE_IDENTIFIER]: 'nodeIdentifier',
  [AT_CMD.NODE_JOIN_TIME]: 'networkJoinTime',
  [AT_CMD.NUM_REMAINING_CHILDREN]: 'numRemainingChildren',
  [AT_CMD.OPERATING_16_BIT_PAN_ID]: 'operatingPanId16',
  [AT_CMD.OPERATING_64_BIT_PAN_ID]: 'operatingPanId64',
  [AT_CMD.OPERATING_CHANNEL]: 'operatingChannel',
  [AT_CMD.SCAN_CHANNELS]: 'scanChannels',
  [AT_CMD.ZIGBEE_STACK_PROFILE]: 'zigBeeStackProfile',
};

XBeeDriver.atResponseHandler = {
  [AT_CMD.SERIAL_NUMBER_HIGH]: XBeeDriver.prototype.handleAtSerialNumberHigh,
  [AT_CMD.SERIAL_NUMBER_LOW]: XBeeDriver.prototype.handleAtSerialNumberLow,
};

XBeeDriver.frameHandler = {
  [C.FRAME_TYPE.AT_COMMAND_RESPONSE]: XBeeDriver.prototype.handleAtResponse,
  [C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX]: ZigbeeDriver.prototype.handleExplicitRx,
  [C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS]:
    XBeeDriver.prototype.handleTransmitStatus,
  [C.FRAME_TYPE.ROUTE_RECORD]: XBeeDriver.prototype.handleRouteRecord,
};

module.exports = XBeeDriver;

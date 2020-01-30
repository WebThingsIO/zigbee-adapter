/**
 *
 * deconz-driver - Driver to support the RaspBee and ConBee.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const deconzApi = require('deconz-api');
const util = require('util');

const C = deconzApi.constants;

const {
  APS_STATUS,
  NWK_STATUS,
} = require('./zb-constants');

const {
  Command,
  FUNC,
  PERMIT_JOIN_PRIORITY,
  WATCHDOG_PRIORITY,
  SEND_FRAME,
  WAIT_FRAME,
  ZigbeeDriver,
} = require('./zb-driver');

const {
  DEBUG_flow,
  DEBUG_frameDetail,
  // DEBUG_frames,
  DEBUG_rawFrames,
  DEBUG_slip,
} = require('./zb-debug');

const {Utils} = require('gateway-addon');

const PARAM = [
  C.PARAM_ID.MAC_ADDRESS,
  C.PARAM_ID.NETWORK_PANID16,
  C.PARAM_ID.NETWORK_ADDR16,
  C.PARAM_ID.NETWORK_PANID64,
  C.PARAM_ID.APS_DESIGNATED_COORDINATOR,
  C.PARAM_ID.SCAN_CHANNELS,
  C.PARAM_ID.APS_PANID64,
  C.PARAM_ID.TRUST_CENTER_ADDR64,
  C.PARAM_ID.SECURITY_MODE,
  C.PARAM_ID.NETWORK_KEY,
  C.PARAM_ID.OPERATING_CHANNEL,
  C.PARAM_ID.PROTOCOL_VERSION,
  C.PARAM_ID.NETWORK_UPDATE_ID,
  C.PARAM_ID.PERMIT_JOIN,
  C.PARAM_ID.WATCHDOG_TTL,
];

const WATCHDOG_TIMEOUT_SECS = 3600;   // 1 hour

function serialWriteError(error) {
  if (error) {
    console.error('SerialPort.write error:', error);
    throw error;
  }
}

class DeconzDriver extends ZigbeeDriver {

  constructor(addonManager, config, portName, serialPort) {
    super(addonManager, config);
    this.portName = portName;
    this.serialPort = serialPort;

    this.dataConfirm = false;
    this.dataIndication = false;
    this.dataRequest = true;  // assume we have space to send the first frame
    this.dataIndicationInProgress = false;
    this.dataConfirmInProgress = false;

    this.rawFrameQueue = [];
    this.waitingForResponseType = 0;
    this.waitingForSequenceNum = 0;

    this.dc = new deconzApi.DeconzAPI({raw_frames: DEBUG_rawFrames});

    this.dc.on('error', (err) => {
      console.error('deConz error:', err);
    });

    if (DEBUG_rawFrames) {
      this.dc.on('frame_raw', (rawFrame) => {
        console.log('Rcvd:', rawFrame);
        if (this.dc.canParse(rawFrame)) {
          try {
            const frame = this.dc.parseFrame(rawFrame);
            try {
              this.handleFrame(frame);
            } catch (e) {
              console.error('Error handling frame_raw');
              console.error(e);
              console.error(util.inspect(frame, {depth: null}));
            }
          } catch (e) {
            console.error('Error parsing frame_raw');
            console.error(e);
            console.error(rawFrame);
          }
        } else {
          console.error('canParse returned false for frame - ignoring');
          console.error(rawFrame);
        }
      });
    } else {
      this.dc.on('frame_object', (frame) => {
        try {
          this.handleFrame(frame);
        } catch (e) {
          console.error('Error handling frame_object');
          console.error(e);
          console.error(util.inspect(frame, {depth: null}));
        }
      });
    }

    console.log(`DeconzDriver: Using serial port ${portName}`);
    this.serialPort.on('data', (chunk) => {
      if (DEBUG_slip) {
        console.log('Rcvd Chunk:', chunk);
      }
      this.dc.parseRaw(chunk);
    });

    this.queueCommands([
      FUNC(this, this.version),
      FUNC(this, this.readParameters),
      FUNC(this, this.kickWatchDog),
      FUNC(this, this.permitJoin, [0]),
      FUNC(this, this.dumpParameters),
      FUNC(this, this.adapterInitialized),
    ]);
  }

  adapterInitialized() {
    this.adapter.networkAddr16 = '0000';
    this.adapter.adapterInitialized();
  }

  asDeviceInfo() {
    const dict = {};
    for (const paramId of PARAM) {
      const param = C.PARAM_ID[paramId];
      let value = this[param.fieldName];
      if (paramId == C.PARAM_ID.SCAN_CHANNELS) {
        value = value.toString(16).padStart(8, '0');
      }
      dict[param.fieldName] = value;
    }
    dict.version = this.version;
    return dict;
  }

  buildAndSendRawFrame(frame) {
    if (!frame.hasOwnProperty('type')) {
      frame.type = C.FRAME_TYPE.APS_DATA_REQUEST;
    }
    const sentPrefix = frame.resend ? 'Re' : '';
    const rawFrame = this.dc.buildFrame(frame, false);
    if (DEBUG_rawFrames) {
      console.log(`${sentPrefix}Queued:`, rawFrame);
    }

    this.rawFrameQueue.push(rawFrame);
    this.processRawFrameQueue();
  }

  // All requests to the DeConz dongle get a response using the same frame
  // type. See deconzApi.constants.FRAME_TYPE for the valid frame types.
  // I discovered that the comms seem to flow much more smoothly if we wait
  // for the corresponding response before proceeding to the send the next
  // frame. this.rawFrameQueue holds these outgoing commands. All of the
  // responses should be sent immediately after the dongle receives the
  // request. So the only delays should be waiting for serial bytes to be
  // sent and received.
  //
  // For all of the commands sent to the dongle, the first byte of the
  // frame is the frame type and the second byte is a sequence number.

  processRawFrameQueue() {
    if (this.waitingForResponseType != 0) {
      // We've sent a frame to the dongle and we're waiting for a response.
      if (DEBUG_rawFrames) {
        console.log('processRawFrameQueue: waiting for type:',
                    this.waitingForResponseType);
      }
      return;
    }

    let rawFrame;
    if (this.dataIndication) {
      // There is an incoming frame waiting for us
      if (DEBUG_rawFrames) {
        console.log('Incoming Frame available -',
                    'requesting it (via APS_DATA_INDICATION)');
      }
      rawFrame = this.dc.buildFrame({type: C.FRAME_TYPE.APS_DATA_INDICATION},
                                    false);
    } else if (this.dataConfirm) {
      // There is an outgoing frame sent confirmation waiting for us
      if (DEBUG_rawFrames) {
        console.log('Outgoing Frame confirmation available -',
                    'requesting it (via APS_DATA_CONFIRM)');
      }
      rawFrame = this.dc.buildFrame({type: C.FRAME_TYPE.APS_DATA_CONFIRM},
                                    false);
    } else if (this.dataRequest) {
      // There is space for an outgoing frame
      if (this.rawFrameQueue.length > 0) {
        if (DEBUG_rawFrames) {
          console.log('Sending queued frame');
        }
        rawFrame = this.rawFrameQueue.pop();
      } else {
        if (DEBUG_rawFrames) {
          console.log('No raw frames to send');
        }
        // No frames to send.
        return;
      }
    } else {
      if (DEBUG_rawFrames) {
        console.log('No space to send any frames - wait for space');
      }
      // We need to wait for conditions to change.
      return;
    }

    // we have a raw frame to send
    this.waitingForResponseType = rawFrame[0];
    this.waitingForSequenceNum = rawFrame[1];

    if (DEBUG_rawFrames) {
      console.log('Sent:', rawFrame);
    }
    const slipFrame = this.dc.encapsulateFrame(rawFrame);
    if (DEBUG_slip) {
      console.log(`Sent Chunk:`, slipFrame);
    }
    this.serialPort.write(slipFrame, serialWriteError);
  }

  close() {
    if (this.watchDogTimeout) {
      clearTimeout(this.watchDogTimeout);
      this.watchDogTimeout = null;
    }
    this.serialPort.close();
  }

  deviceStateStr(frame) {
    let devStateStr = '';
    devStateStr += frame.dataConfirm ? 'S' : '-';
    devStateStr += frame.dataIndication ? 'D' : '-';
    devStateStr += frame.dataRequest ? 'L' : '-';
    devStateStr += frame.configChanged ? 'C' : '-';
    return `Net:${'OJCL'[frame.networkState]} Dev:${devStateStr}`;
  }

  dumpFrame(label, frame, dumpFrameDetail) {
    if (typeof dumpFrameDetail === 'undefined') {
      dumpFrameDetail = DEBUG_frameDetail;
    }
    try {
      this.dumpFrameInternal(label, frame, dumpFrameDetail);
    } catch (e) {
      console.error('Error dumping frame');
      console.error(e);
      console.error(util.inspect(frame, {depth: null}));
    }
  }

  dumpFrameInternal(label, frame, dumpFrameDetail) {
    let frameTypeStr = this.frameTypeAsStr(frame);
    if (!frameTypeStr) {
      frameTypeStr = `Unknown(0x${frame.type.toString(16)})`;
    }
    if (frame.response) {
      frameTypeStr += ' Response';
    } else {
      frameTypeStr += ' Request ';
    }

    switch (frame.type) {

      case C.FRAME_TYPE.READ_PARAMETER:
      case C.FRAME_TYPE.WRITE_PARAMETER: {
        let paramStr;
        if (frame.paramId in C.PARAM_ID) {
          paramStr = C.PARAM_ID[frame.paramId].label;
        } else {
          paramStr = `Unknown(${frame.paramId})`;
        }
        const param = C.PARAM_ID[frame.paramId];
        if (param) {
          if (frame.hasOwnProperty(param.fieldName)) {
            paramStr += `: ${frame[param.fieldName]}`;
          }
        }
        console.log(label, frameTypeStr, paramStr);
        break;
      }

      case C.FRAME_TYPE.APS_DATA_CONFIRM: { // Query Send State
        if (dumpFrameDetail) {
          if (!frame.response) {
            console.log(label, 'Explicit Tx State (APS Data Confirm) Request');
            break;
          }
          const dstAddr = frame.destination64 || frame.destination16;
          console.log(label, 'Explicit Tx State (APS Data Confirm) Response',
                      dstAddr, `ID:${frame.id}`,
                      this.deviceStateStr(frame));
        }
        break;
      }

      case C.FRAME_TYPE.APS_DATA_INDICATION: {  // Read Received Data
        if (!frame.response) {
          if (dumpFrameDetail) {
            console.log(label, 'Explicit Rx (APS Data Indication) Request');
          }
          break;
        }
        this.dumpZigbeeRxFrame(label, frame);
        break;
      }

      case C.FRAME_TYPE.APS_DATA_REQUEST: {   // Enqueue Send Data
        if (frame.response) {
          if (dumpFrameDetail) {
            console.log(label, 'Explicit Tx (APS Data Request) Response',
                        this.deviceStateStr(frame));
          }
          break;
        }
        this.dumpZigbeeTxFrame(label, frame);
        break;
      }

      case C.FRAME_TYPE.DEVICE_STATE:
      case C.FRAME_TYPE.DEVICE_STATE_CHANGED:
        if (dumpFrameDetail) {
          if (frame.response) {
            console.log(label, frameTypeStr, this.deviceStateStr(frame));
          } else {
            console.log(label, frameTypeStr);
          }
        }
        break;

      case C.FRAME_TYPE.VERSION:
        if (frame.response) {
          console.log(label, frameTypeStr, frame.version);
        } else {
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

  dumpParameters() {
    for (const paramId of PARAM) {
      const param = C.PARAM_ID[paramId];
      const label = param.label.padStart(20, ' ');
      let value = this[param.fieldName];
      if (paramId == C.PARAM_ID.SCAN_CHANNELS) {
        value = value.toString(16).padStart(8, '0');
      }
      console.log(`${label}: ${value}`);
    }
    console.log(`             Version: ${this.version}`);
  }

  frameTypeAsStr(frame) {
    if (C.FRAME_TYPE.hasOwnProperty(frame.type)) {
      return C.FRAME_TYPE[frame.type];
    }
    return `${frame.type} (0x${frame.type.toString(16)})`;
  }

  getFrameHandler(frame) {
    return DeconzDriver.frameHandler[frame.type];
  }

  getExplicitRxFrameType() {
    return C.FRAME_TYPE.APS_DATA_INDICATION;
  }

  getExplicitTxFrameType() {
    return C.FRAME_TYPE.APS_DATA_REQUEST;
  }

  getTransmitStatusFrameType() {
    return C.FRAME_TYPE.APS_DATA_CONFIRM;
  }

  // Response to APS_DATA_CONFIRM request (i.e. confirm frame sent)
  handleApsDataConfirm(frame) {
    DEBUG_flow && console.log('handleApsDataConfirm: seqNum:', frame.seqNum,
                              'id', frame.id);
    this.dataConfirmInProgress = false;
    if (frame.confirmStatus != 0) {
      this.reportConfirmStatus(frame);
    }
    this.updateFlags(frame);
  }

  // Response to APS_DATA_INDICATION request (i.e. frame received)
  handleApsDataIndication(frame) {
    DEBUG_flow && console.log('handleApsDataIndication: seqNum:', frame.seqNum);
    this.dataIndicationInProgress = false;
    if (frame.status != 0) {
      this.reportStatus(frame);
    }
    this.updateFlags(frame);
    this.handleExplicitRx(frame);
  }

  // Reponse to APS_DATA_REQUEST (i.e. frame was queued for sending)
  handleApsDataRequest(frame) {
    DEBUG_flow && console.log('handleApsDataRequest: seqNum:', frame.seqNum);
    this.dataConfirmInProgress = false;
    if (frame.status != 0) {
      this.reportStatus(frame);
    }
    this.updateFlags(frame);
  }

  // APS_MAC_POLL - this seems to be sent by the ConBee II and not the ConBee
  // We just ignore the frame for now.
  handleApsMacPoll(_frame) {
  }

  // Response to DEVICE_STATE request
  handleDeviceState(frame) {
    DEBUG_flow && console.log('handleDeviceState: seqNum:', frame.seqNum);
    this.updateFlags(frame);
  }

  // Unsolicited indication of state change
  handleDeviceStateChanged(frame) {
    DEBUG_flow && console.log('handleDeviceStateChanged: seqNum:',
                              frame.seqNum);
    if (frame.status != 0) {
      this.reportStatus(frame);
    }
    this.updateFlags(frame);
  }

  handleFrame(frame) {
    if (this.waitingForResponseType == frame.type &&
        this.waitingForSequenceNum == frame.seqNum) {
      // We got the frame we're waiting for
      this.waitingForResponseType = 0;
      this.waitingForSequenceNum = 0;
    }
    if (frame.status == 0) {
      super.handleFrame(frame);
    }

    // Send out any queued raw frames, if there are any.
    this.processRawFrameQueue();
  }

  handleReadParameter(frame) {
    if (frame.status != 0) {
      this.reportStatus(frame);
    }
    const paramId = frame.paramId;
    if (C.PARAM_ID.hasOwnProperty(paramId)) {
      const fieldName = C.PARAM_ID[paramId].fieldName;
      this[fieldName] = frame[fieldName];
      if (fieldName == 'macAddress') {
        this.adapter.networkAddr64 = this.macAddress;
        this.neworkAddr16 = '0000';
      }
    }
  }

  handleWriteParameter(frame) {
    if (frame.status != 0) {
      this.reportStatus(frame);
    }
  }

  handleVersion(frame) {
    console.log('DeConz Firmware version:', Utils.hexStr(frame.version, 8));
  }

  kickWatchDog() {
    if (this.protocolVersion < C.WATCHDOG_PROTOCOL_VERSION) {
      console.error('This version of ConBee doesn\'t support the watchdog');
      return;
    }
    console.log('Kicking WatchDog for', WATCHDOG_TIMEOUT_SECS, 'seconds');
    this.queueCommandsAtFront(
      this.writeParameterCommands(C.PARAM_ID.WATCHDOG_TTL,
                                  WATCHDOG_TIMEOUT_SECS,
                                  WATCHDOG_PRIORITY));
    if (this.watchDogTimeout) {
      clearTimeout(this.watchDogTimeout);
      this.watchDogTimeout = null;
    }
    this.watchDogTimeout = setTimeout(() => {
      this.watchDogTimeout = null;
      this.kickWatchDog();
    }, (WATCHDOG_TIMEOUT_SECS / 2) * 1000);
  }

  nextFrameId() {
    return deconzApi._frame_builder.nextFrameId();
  }

  permitJoinCommands(duration) {
    return this.writeParameterCommands(C.PARAM_ID.PERMIT_JOIN,
                                       duration,
                                       PERMIT_JOIN_PRIORITY);
  }

  processDeviceState() {
    DEBUG_flow && console.log('processDeviceState:',
                              'dataIndication', this.dataIndication,
                              'inProgress:', this.dataIndicationInProgress,
                              'dataConfirm', this.dataConfirm,
                              'inProgress:', this.dataConfirmInProgress);
    if (this.dataIndication && !this.dataIndicationInProgress) {
      // There is a frame ready to be read.
      this.dataIndicationInProgress = true;
      this.sendFrameNow({type: C.FRAME_TYPE.APS_DATA_INDICATION});
    }
    if (this.dataConfirm && !this.dataConfirmInProgress) {
      // There is a data confirm ready to be read.
      this.dataConfirmInProgress = true;
      this.sendFrameNow({type: C.FRAME_TYPE.APS_DATA_CONFIRM});
    }
  }

  readParameter() {
    if (this.paramIdx >= PARAM.length) {
      return;
    }
    const paramId = PARAM[this.paramIdx];
    if (paramId == C.PARAM_ID.WATCHDOG_TTL) {
      if (this.protocolVersion < C.WATCHDOG_PROTOCOL_VERSION) {
        // This version of the ConBee firmware doesn't support the
        // watchdog parameter - skip
        this.paramIdx++;
        this.readParameter();
        return;
      }
    }
    const readParamFrame = {
      type: C.FRAME_TYPE.READ_PARAMETER,
      paramId: paramId,
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, readParamFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.READ_PARAMETER,
        paramId: paramId,
        callback: (_frame) => {
          if (this.paramIdx < PARAM.length) {
            this.paramIdx++;
            this.readParameter();
          }
        },
      }),
    ]);
  }

  readParameters() {
    this.paramIdx = 0;
    this.readParameter();
  }

  reportStatus(frame) {
    const status = frame.status;
    if (status < C.STATUS_STR.length) {
      if (status == 0) {
        console.log(`Frame Status: ${status}: ${C.STATUS_STR[status]}`);
      } else {
        console.error(`Frame Status: ${status}: ${C.STATUS_STR[status]}`);
        console.error(frame);
      }
    } else {
      console.error(`Frame Status: ${status}: unknown`);
      console.error(frame);
    }
  }

  reportConfirmStatus(frame) {
    if (frame.payloadLen < 11) {
      // This is an invalid frame. We've already reported it.
      return;
    }

    // These are common statuses, so don't report them unless we're
    // debugging.
    const noReport = [APS_STATUS.NO_ACK, APS_STATUS.NO_SHORT_ADDRESS];
    const status = frame.confirmStatus;

    let addr = 'unknown';
    let node;
    if (frame.hasOwnProperty('destination16')) {
      addr = frame.destination16;
      node = this.adapter.findNodeByAddr16(addr);
    } else if (frame.hasOwnProperty('destination64')) {
      addr = frame.destination64;
      node = this.adapter.nodes[addr];
    }
    if (node) {
      addr = `${node.addr64} ${node.addr16}`;
    }

    if (APS_STATUS.hasOwnProperty(status)) {
      if (status == 0) {
        console.log(`Confirm Status: ${status}: ${APS_STATUS[status]}`,
                    `addr: ${addr}`);
      } else if (DEBUG_frameDetail || !noReport.includes(status)) {
        console.error(`Confirm Status: ${status}: ${APS_STATUS[status]}`,
                      `addr: ${addr}`);
      }
    } else if (NWK_STATUS.hasOwnProperty(status)) {
      console.error(`Confirm Status: ${status}: ${NWK_STATUS[status]}`,
                    `addr: ${addr}`);
    } else {
      console.error(`Confirm Status: ${status}: unknown`,
                    `addr: ${addr}`);
      console.error(frame);
    }
  }

  updateFlags(frame) {
    this.dataConfirm = frame.dataConfirm;
    this.dataIndication = frame.dataIndication;
    this.dataRequest = frame.dataRequest;
  }

  version() {
    const versionFrame = {
      type: C.FRAME_TYPE.VERSION,
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, versionFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.VERSION,
        callback: (frame) => {
          this.version = frame.version;
        },
      }),
    ]);
  }

  writeParameter(paramId, value, priority) {
    this.queueCommandsAtFront(
      this.writeParameterCommands(paramId, value, priority));
  }

  writeParameterCommands(paramId, value, priority) {
    if (!C.PARAM_ID.hasOwnProperty(paramId)) {
      console.error(`Unknown parameter ID: ${paramId}`);
      return [];
    }
    const fieldName = C.PARAM_ID[paramId].fieldName;
    this[fieldName] = value;
    const writeParamFrame = {
      type: C.FRAME_TYPE.WRITE_PARAMETER,
      paramId: paramId,
      [fieldName]: value,
    };
    if (typeof priority !== 'undefined') {
      writeParamFrame.priority = priority;
    }
    return [
      new Command(SEND_FRAME, writeParamFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.WRITE_PARAMETER,
        paramId: paramId,
      }),
    ];
  }
}

DeconzDriver.frameHandler = {
  [C.FRAME_TYPE.APS_DATA_CONFIRM]: DeconzDriver.prototype.handleApsDataConfirm,
  [C.FRAME_TYPE.APS_DATA_INDICATION]:
    DeconzDriver.prototype.handleApsDataIndication,
  [C.FRAME_TYPE.APS_DATA_REQUEST]: DeconzDriver.prototype.handleApsDataRequest,
  [C.FRAME_TYPE.APS_MAC_POLL]: DeconzDriver.prototype.handleApsMacPoll,
  [C.FRAME_TYPE.DEVICE_STATE]: DeconzDriver.prototype.handleDeviceState,
  [C.FRAME_TYPE.DEVICE_STATE_CHANGED]:
    DeconzDriver.prototype.handleDeviceStateChanged,
  [C.FRAME_TYPE.VERSION]: DeconzDriver.prototype.handleVersion,
  [C.FRAME_TYPE.READ_PARAMETER]: DeconzDriver.prototype.handleReadParameter,
  [C.FRAME_TYPE.WRITE_PARAMETER]: DeconzDriver.prototype.handleWriteParameter,
};

module.exports = DeconzDriver;

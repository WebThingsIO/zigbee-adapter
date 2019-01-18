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
  // DEBUG_frames,
  DEBUG_rawFrames,
  DEBUG_slip,
} = require('./zb-debug');

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
];

function serialWriteError(error) {
  if (error) {
    console.error('SerialPort.write error:', error);
    throw error;
  }
}

class DeconzDriver extends ZigbeeDriver {

  constructor(addonManager, manifest, portName, serialPort) {
    super(addonManager, manifest);
    this.portName = portName;
    this.serialPort = serialPort;

    this.dataConfirm = false;
    this.dataIndication = false;
    this.dataRequest = false;
    this.dataIndicationInProgress = false;
    this.dataConfirmInProgress = false;

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
      FUNC(this, this.permitJoin, [0]),
      FUNC(this, this.dumpParameters),
      FUNC(this, this.adapterInitialized),
    ]);
  }

  adapterInitialized() {
    this.adapter.networkAddr64 = this.macAddress;
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
    const rawFrame = this.dc.buildFrame(frame);
    if (DEBUG_rawFrames) {
      console.log(`${sentPrefix}Sent:`, rawFrame);
    }
    this.serialPort.write(rawFrame, serialWriteError);
    if (frame.type == C.FRAME_TYPE.APS_DATA_REQUEST) {
      // If we receive a DEVICE_STATE_CHANGED we don't
      // want to send out the confirm until we get the
      // APS_DATA_REQUEST response.
      this.dataConfirmInProgress = true;
    }
  }

  close() {
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
        if (!frame.response) {
          console.log(label, 'Explicit Tx State (APS Data Confirm) Request');
          break;
        }
        const dstAddr = frame.destination64 || frame.destination16;
        console.log(label, 'Explicit Tx State (APS Data Confirm) Response',
                    dstAddr, `ID:${frame.id}`,
                    this.deviceStateStr(frame));
        break;
      }

      case C.FRAME_TYPE.APS_DATA_INDICATION: {  // Read Received Data
        if (!frame.response) {
          console.log(label, 'Explicit Rx (APS Data Indication) Request');
          break;
        }
        this.dumpZigbeeRxFrame(label, frame);
        break;
      }

      case C.FRAME_TYPE.APS_DATA_REQUEST: {   // Enqueue Send Data
        if (frame.response) {
          console.log(label, 'Explicit Tx (APS Data Request) Response',
                      this.deviceStateStr(frame));
          break;
        }
        this.dumpZigbeeTxFrame(label, frame);
        break;
      }

      case C.FRAME_TYPE.DEVICE_STATE:
      case C.FRAME_TYPE.DEVICE_STATE_CHANGED:
        if (frame.response) {
          console.log(label, frameTypeStr, this.deviceStateStr(frame));
        } else {
          console.log(label, frameTypeStr);
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
    this.updateFlags(frame);
    this.processDeviceState();
  }

  // Response to APS_DATA_INDICATION request (i.e. frame received)
  handleApsDataIndication(frame) {
    DEBUG_flow && console.log('handleApsDataIndication: seqNum:', frame.seqNum);
    this.dataIndicationInProgress = false;
    this.updateFlags(frame);
    this.handleExplicitRx(frame);
    this.processDeviceState();
  }

  // Reponse to APS_DATA_REQUEST (i.e. frame was queued for sending)
  handleApsDataRequest(frame) {
    DEBUG_flow && console.log('handleApsDataRequest: seqNum:', frame.seqNum);
    this.dataConfirmInProgress = false;
    this.updateFlags(frame);
    this.processDeviceState();
  }

  // Response to DEVICE_STATE request
  handleDeviceState(frame) {
    DEBUG_flow && console.log('handleDeviceState: seqNum:', frame.seqNum);
    this.updateFlags(frame);
    this.processDeviceState();
  }

  // Unsolicited indication of state change
  handleDeviceStateChanged(frame) {
    DEBUG_flow && console.log('handleDeviceStateChanged: seqNum:',
                              frame.seqNum);
    this.updateFlags(frame);
    this.processDeviceState();
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
    if (this.dataConfirm && !this.dataConfirmInProgress) {
      // There is a data confirm ready to be read.
      this.dataConfirmInProgress = true;
      this.sendFrameNow({type: C.FRAME_TYPE.APS_DATA_CONFIRM});
    } else if (this.dataIndication && !this.dataIndicationInProgress) {
      // There is a frame ready to be read.
      this.dataIndicationInProgress = true;
      this.sendFrameNow({type: C.FRAME_TYPE.APS_DATA_INDICATION});
    }
  }

  readParameter() {
    if (this.paramIdx >= PARAM.length) {
      return;
    }
    const paramId = PARAM[this.paramIdx];
    const readParamFrame = {
      type: C.FRAME_TYPE.READ_PARAMETER,
      paramId: paramId,
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, readParamFrame),
      new Command(WAIT_FRAME, {
        type: C.FRAME_TYPE.READ_PARAMETER,
        paramId: paramId,
        callback: (frame) => {
          if (this.paramIdx < PARAM.length) {
            const paramId = PARAM[this.paramIdx];
            const fieldName = C.PARAM_ID[paramId].fieldName;
            this[fieldName] = frame[fieldName];
            this.paramIdx++;
            this.readParameter(this.paramIdx);
          }
        },
      }),
    ]);
  }

  readParameters() {
    this.paramIdx = 0;
    this.readParameter();
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
    if (typeof priorty !== 'undefined') {
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
  [C.FRAME_TYPE.DEVICE_STATE]: DeconzDriver.prototype.handleDeviceState,
  [C.FRAME_TYPE.DEVICE_STATE_CHANGED]:
    DeconzDriver.prototype.handleDeviceStateChanged,
};

module.exports = DeconzDriver;

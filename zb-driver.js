/**
 *
 * zb-driver - Driver base class for Mozilla IoT Zigbee adapter.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const assert = require('assert');
const util = require('util');
const zcl = require('zcl-packet');
const zclId = require('zcl-id');
const zdo = require('zigbee-zdo');
const {Utils} = require('gateway-addon');

const {
  PROFILE_ID,
} = require('./zb-constants');

const {
  DEBUG_flow,
  DEBUG_frames,
  DEBUG_frameDetail,
  DEBUG_frameParsing,
} = require('./zb-debug');

const WAIT_TIMEOUT_DELAY = 1 * 1000;
const EXTENDED_TIMEOUT_DELAY = 10 * 1000;
const WAIT_RETRY_MAX = 3;   // includes initial send

const PERMIT_JOIN_PRIORITY = 1;

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

  print(driver, idx) {
    let prioStr = 'p:-';
    if (typeof this.priority !== 'undefined') {
      prioStr = `p:${this.priority}`;
    }

    const idxStr = `| ${idx.toString().padStart(4, ' ')}: ${prioStr} `;
    switch (this.cmdType) {
      case SEND_FRAME: {
        driver.dumpFrame(`${idxStr}SEND:`, this.cmdData, false);
        break;
      }
      case WAIT_FRAME:
        driver.dumpWaitFrame(`${idxStr}WAIT:`, this.cmdData);
        break;
      case EXEC_FUNC:
        console.log(`${idxStr}EXEC:`, this.cmdData[1].name);
        break;
      case RESOLVE_SET_PROPERTY: {
        const property = this.cmdData;
        console.log(`${idxStr}RESOLVE_SET_PROPERTY: ${property.device.addr64}`,
                    property.name);
        break;
      }
      default:
        console.log(`${idxStr}UNKNOWN: ${this.cmdType}`);
    }
  }
}

function FUNC(ths, func, args) {
  return new Command(EXEC_FUNC, [ths, func, args]);
}

class ZigbeeDriver {

  constructor(addonManager, manifest) {
    // This is the only place that we need to reference ZigbeeAdapter.
    // To avoid circular dependency problems, we put the require
    // statement here as well.
    const ZigbeeAdapter = require('./zb-adapter');
    this.adapter = new ZigbeeAdapter(addonManager, manifest, this);

    this.manifest = manifest;

    this.cmdQueue = [];
    this.running = false;
    this.waitFrame = null;
    this.waitTimeout = null;
    this.lastFrameSent = null;
  }

  // It is expected that a derived driver will override this class.
  buildAndSendRawFrame(_frame) {
    assert.fail('buildAndSendRawFrame needs to implemented');
  }

  close() {
    assert.fail('Driver close needs to implemented');
  }

  dumpWaitFrame(label, frame) {
    let frameTypeStr = this.frameTypeAsStr(frame);
    if (frame.hasOwnProperty('remote64')) {
      frameTypeStr += ` from: ${frame.remote64}`;
    }
    if (frame.hasOwnProperty('id')) {
      frameTypeStr += ` id:${frame.id}`;
    }
    if (frame.hasOwnProperty('clusterId')) {
      frameTypeStr += ` CL:${Utils.hexStr(frame.clusterId, 4)}`;
      if (zdo.isZdoFrame(frame)) {
        frameTypeStr += ` - ${zdo.getClusterIdDescription(frame.clusterId)}`;
      } if (this.isZclFrame(frame)) {
        const cluster = zclId.cluster(parseInt(frame.clusterId, 16));
        const clusterKey = cluster && cluster.key || '???';
        frameTypeStr += ` - ${clusterKey}`;
      }
    }
    if (frame.hasOwnProperty('zdoSeq')) {
      frameTypeStr += ` zdoSeq:${frame.zdoSeq}`;
    }
    if (frame.hasOwnProperty('zclCmdId')) {
      frameTypeStr += ` zclCmdId:${frame.zclCmdId}`;
    }
    if (frame.hasOwnProperty('zclSeq')) {
      frameTypeStr += ` zclSeq:${frame.zclSeq}`;
    }
    console.log(label, frameTypeStr);
  }

  dumpZclPayload(label, frame) {
    label += '  ';
    const cmd = frame.zcl.cmd || frame.zcl.cmdId;
    const clusterId = parseInt(frame.clusterId, 16);
    switch (cmd) {
      case 'read':
      case 'readRsp':
      case 'report':
      case 'write':
      case 'writeRsp': {
        for (const attrEntry of frame.zcl.payload) {
          let s = '';
          if (attrEntry.hasOwnProperty('attrId')) {
            const attrId = attrEntry.attrId;
            const attr = zclId.attr(clusterId, attrId);
            const attrIdStr = attrId.toString().padStart(5, ' ');
            s += ` ${attrIdStr}:${attr ? attr.key : '???'}`;
          }
          if (attrEntry.hasOwnProperty('status')) {
            const status = zclId.status(attrEntry.status);
            s += ` ${attrEntry.status}:${status ? status.key : '???'}`;
          }
          if (attrEntry.hasOwnProperty('dataType')) {
            const dataType = zclId.dataType(attrEntry.dataType);
            s += ` ${attrEntry.dataType}:${dataType ? dataType.key : '???'}`;
          }
          if (attrEntry.hasOwnProperty('attrData')) {
            if (typeof attrEntry.attrData === 'number') {
              s += ` 0x${attrEntry.attrData.toString(16)}`;
              s += `(${attrEntry.attrData})`;
            } else {
              s += ` ${attrEntry.attrData}`;
            }
          }
          console.log(label, s.slice(1));
        }
        break;
      }

      default:
        console.log(label, 'payload:', frame.zcl.payload);
    }
  }

  dumpZigbeeRxFrame(label, frame) {
    const cluster = zclId.cluster(parseInt(frame.clusterId, 16));
    const clusterKey = cluster && cluster.key || '???';
    const remoteAddr = frame.remote64 || frame.remote16;
    if (zdo.isZdoFrame(frame)) {
      const shortDescr = frame.shortDescr || '';
      const status = this.frameStatus(frame);
      console.log(label, 'Explicit Rx', remoteAddr,
                  'ZDO',
                  zdo.getClusterIdAsString(frame.clusterId),
                  zdo.getClusterIdDescription(frame.clusterId),
                  shortDescr,
                  'status:', status.key, `(${status.value})`);
      zdo.dumpZdoFrame(`${label}  `, frame);
    } else if (this.isZhaFrame(frame)) {
      if (frame.zcl) {
        console.log(label, 'Explicit Rx', remoteAddr,
                    'ZHA', frame.clusterId, clusterKey,
                    frame.zcl ? frame.zcl.cmdId : '???');
        this.dumpZclPayload(label, frame);
      } else {
        console.log(label, 'Explicit Rx', remoteAddr,
                    'ZHA', frame.clusterId, clusterKey,
                    '??? no zcl ???');
      }
    } else if (this.isZllFrame(frame)) {
      if (frame.zcl) {
        console.log(label, 'Explicit Rx', remoteAddr,
                    'ZLL', frame.clusterId, clusterKey,
                    frame.zcl ? frame.zcl.cmdId : '???');
        this.dumpZclPayload(label, frame);
      } else {
        console.log(label, 'Explicit Rx', remoteAddr,
                    'ZLL', frame.clusterId, clusterKey,
                    '??? no zcl ???');
      }
    } else {
      console.log(label, 'Explicit Rx', remoteAddr,
                  `???(${frame.profileId})`, frame.clusterId);
    }
  }

  dumpZigbeeTxFrame(label, frame) {
    const cluster = zclId.cluster(parseInt(frame.clusterId, 16));
    const clusterKey = cluster && cluster.key || '???';
    const dstAddr = frame.destination64 || frame.destination16;
    if (zdo.isZdoFrame(frame)) {
      const shortDescr = frame.shortDescr || '';
      console.log(label, 'Explicit Tx', dstAddr,
                  'ZDO',
                  zdo.getClusterIdAsString(frame.clusterId),
                  zdo.getClusterIdDescription(frame.clusterId),
                  shortDescr);
      zdo.dumpZdoFrame(`${label}  `, frame);
    } else if (this.isZhaFrame(frame)) {
      if (frame.zcl) {
        const cmd = frame.zcl.cmd || frame.zcl.cmdId;
        console.log(label, 'Explicit Tx', dstAddr,
                    'ZHA', frame.clusterId, clusterKey, cmd);
        this.dumpZclPayload(label, frame);
      } else {
        console.log(label, 'Explicit Tx', dstAddr,
                    `ID:${frame.id}`,
                    'ZHA', frame.clusterId, clusterKey,
                    '??? no zcl ???');
      }
    } else if (this.isZllFrame(frame)) {
      if (frame.zcl) {
        const cmd = frame.zcl.cmd || frame.zcl.cmdId;
        console.log(label, 'Explicit Tx', dstAddr,
                    `ID:${frame.id}`,
                    'ZLL', frame.clusterId, clusterKey, cmd);
        this.dumpZclPayload(label, frame);
      } else {
        console.log(label, 'Explicit Tx', dstAddr,
                    `ID:${frame.id}`,
                    'ZLL', frame.clusterId, clusterKey,
                    '??? no zcl ???');
      }
    } else {
      console.log(label, 'Explicit Tx', dstAddr,
                  `???(${frame.profileId})`, frame.clusterId);
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

  frameTypeAsStr(_frame) {
    assert.fail('frameTypeAsStr needs to implemented');
  }

  getFrameHandler(_frame) {
    assert.fail('getFrameHandler needs to implemented');
  }

  getExplicitRxFrameType() {
    assert.fail('getExplicitRxFrameType needs to implemented');
  }

  getExplicitTxFrameType() {
    assert.fail('getExplicitTxFrameType needs to implemented');
  }

  getTransmitStatusFrameType() {
    assert.fail('getTransmitStatusFrameType needs to implemented');
  }

  handleExplicitRx(frame) {
    if (zdo.isZdoFrame(frame)) {
      try {
        this.adapter.handleZdoFrame(frame);
      } catch (e) {
        console.error('handleExplicitRx:',
                      'Caught an exception parsing ZDO frame');
        console.error(e);
        console.error(util.inspect(frame, {depth: null}));
      }
    } else if (this.isZclFrame(frame)) {
      try {
        this.adapter.handleZclFrame(frame);
      } catch (e) {
        console.error('handleExplicitRx:',
                      'Caught an exception parsing ZCL frame');
        console.error(e);
        console.error(util.inspect(frame, {depth: null}));
      }
    } else {
      console.error('handleExplicitRx: Unrecognize frame received');
      console.error(util.inspect(frame, {depth: null}));
    }
  }

  // Called by the driver whenever a new frame becomes available.
  handleFrame(frame) {
    if (DEBUG_frameParsing) {
      this.dumpFrame('Rcvd (before parsing):', frame);
    }
    if (zdo.isZdoFrame(frame)) {
      zdo.parseZdoFrame(frame);
      this.handleParsedFrame(frame);
    } else if (this.isZclFrame(frame)) {
      this.parseZclFrame(frame).then((frame) => {
        this.handleParsedFrame(frame);
      }).catch((error) => {
        console.error('Error parsing ZCL frame');
        console.error(error);
        console.error(util.inspect(frame, {depth: null}));
      });
    } else {
      this.handleParsedFrame(frame);
    }
  }

  handleParsedFrame(frame) {
    if (DEBUG_frames) {
      this.dumpFrame('Rcvd:', frame);
    }
    const frameHandler = this.getFrameHandler(frame);
    if (frameHandler) {
      if (this.waitFrame && this.waitFrame.extraParams) {
        frame.extraParams = this.waitFrame.extraParams;
      }
      frameHandler.call(this, frame);
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

  isZclFrame(frame) {
    if (typeof frame.profileId === 'number') {
      return frame.profileId === PROFILE_ID.ZHA ||
             frame.profileId === PROFILE_ID.ZLL;
    }
    return frame.profileId === PROFILE_ID.ZHA_HEX ||
           frame.profileId === PROFILE_ID.ZLL_HEX;
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

  makeFrameWaitFrame(sendFrame, waitFrame, priority) {
    return [
      new Command(SEND_FRAME, sendFrame, priority),
      new Command(WAIT_FRAME, waitFrame, priority),
    ];
  }

  makeFuncCommand(ths, func, args) {
    return FUNC(ths, func, args);
  }

  nextFrameId() {
    assert.fail('nextFrameId needs to implemented');
  }

  parseZclFrame(frame) {
    return new Promise((resolve, reject) => {
      // The OSRAM lightify sends a manufacturer specific command
      // which the zcl-parse library doesn't deal with, so we put a check
      // for that here.
      const zclData = frame.data;
      if (zclData.length == 5 &&
          zclData[0] == 0x05 &&
          zclData[1] == 0x4e &&
          zclData[2] == 0x10 &&
          zclData[4] == 0x03) {
        frame.zcl = {
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
        };
        resolve(frame);
      } else {
        const clusterId = parseInt(frame.clusterId, 16);
        zcl.parse(zclData, clusterId, (error, zclData) => {
          if (error) {
            reject(error);
          } else {
            frame.zcl = zclData;
            resolve(frame);
          }
        });
      }
    });
  }

  permitJoin(duration) {
    this.adapter.permitJoin(duration);
  }

  permitJoinCommands(_duration) {
    assert.fail('permitJoinCommands needs to implemented');
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
          const sentPrefix = frame.resend ? 'Re' : '';
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
          this.buildAndSendRawFrame(frame);
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
          // Frames which don't have a profileId, aren't directed to a node
          // (i.e. AT commands or other driver specific commands.)
          if (this.lastFrameSent &&
              this.lastFrameSent.hasOwnProperty('profileId')) {
            const node = this.adapter.findNodeFromTxFrame(this.lastFrameSent);
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
          if (DEBUG_frameDetail || DEBUG_flow) {
            console.log('EXEC_FUNC', func.name);
          }
          func.apply(ths, args);
          break;
        }
        case RESOLVE_SET_PROPERTY: {
          const property = cmd.cmdData;
          if (DEBUG_frameDetail || DEBUG_flow) {
            console.log('RESOLVE_SET_PROPERTY',
                        property.device.addr64, property.name,
                        'value:', property.value);
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

  sendFrameNow(frame) {
    if (DEBUG_flow) {
      console.log('sendFrameNow');
    }
    if (DEBUG_frames) {
      this.dumpFrame('Sent:', frame);
    }
    this.buildAndSendRawFrame(frame);
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

      this.queueCommandsAtFront(
        this.makeFrameWaitFrame(this.lastFrameSent, waitFrame));
    }
  }
}

module.exports = {
  Command,
  FUNC,
  PERMIT_JOIN_PRIORITY,
  RESOLVE_SET_PROPERTY,
  SEND_FRAME,
  WAIT_FRAME,
  ZigbeeDriver,
};

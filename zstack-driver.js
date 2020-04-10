/**
 *
 * ZStackDriver - Zigbee driver for TI's ZStack-based dongles (ex. CC253x)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const zdo = require('zigbee-zdo');
const BufferReader = require('buffer-reader');
const BufferBuilder = require('buffer-builder');
const Unpi = require('unpi');

const {
  Command,
  FUNC,
  SEND_FRAME,
  WAIT_FRAME,
  ZigbeeDriver,
} = require('./zb-driver');

// const {
//     DEBUG_flow,
//     DEBUG_frameDetail,
//     DEBUG_frames,
//     DEBUG_rawFrames,
//     DEBUG_slip,
//   } = require('./zb-debug');

const {
  PROFILE_ID,
} = require('./zb-constants');

const cmdType = {
  POLL: 0,
  SREQ: 1,
  AREQ: 2,
  SRSP: 3,
};

const subSys = {
  RES0: 0,
  SYS: 1,
  MAC: 2,
  NWK: 3,
  AF: 4,
  ZDO: 5,
  SAPI: 6,
  UTIL: 7,
  DBG: 8,
  APP: 9,
  DEBUG: 15,
};

const devStates = {
  DEV_HOLD: 0,
  DEV_INIT: 1,
  DEV_NWK_DISC: 2,
  DEV_NWK_JOINING: 3,
  DEV_NWK_SEC_REJOIN_CURR_CHANNEL: 4,
  DEV_END_DEVICE_UNAUTH: 5,
  DEV_END_DEVICE: 6,
  DEV_ROUTER: 7,
  DEV_COORD_STARTING: 8,
  DEV_ZB_COORD: 9,
  DEV_NWK_ORPHAN: 10,
  DEV_NWK_KA: 11,
  DEV_NWK_BACKOFF: 12,
  DEV_NWK_SEC_REJOIN_ALL_CHANNEL: 13,
  DEV_NWK_TC_REJOIN_CURR_CHANNEL: 14,
  DEV_NWK_TC_REJOIN_ALL_CHANNEL: 15,
};

const nvItems = {
  ZCD_NV_USERDESC: 0x0081,
  ZCD_NV_NWKKEY: 0x0082,
  ZCD_NV_PANID: 0x0083,
  ZCD_NV_CHANLIST: 0x0084,
  ZCD_NV_LEAVE_CTRL: 0x0085,
  ZCD_NV_SCAN_DURATION: 0x0086,
  ZCD_NV_LOGICAL_TYPE: 0x0087,
};

const BEACON_MAX_DEPTH = 0x0F;
const DEF_RADIUS = 2 * BEACON_MAX_DEPTH;

let self;

class ZStackDriver extends ZigbeeDriver {

  constructor(addonManager, manifest, portName, serialPort) {
    super(addonManager, manifest);

    self = this;

    this.lastIDSeq = 0;
    this.lastZDOSeq = 0;

    this.idSeq = 0;

    this.serialPort = serialPort;
    this.unpi = new Unpi({lenBytes: 1, phy: serialPort});

    this.unpi.on('data', this.onZStackFrame);

    this.queueInitCmds();
  }

  queueInitCmds() {
    this.queueCommands([
      FUNC(this, this.resetZNP),
      FUNC(this, this.getExtAddr),
      FUNC(this, this.registerApp),
      FUNC(this, this.disableTCKeyExchange),
      FUNC(this, this.startCoordinator),
    ]);
  }

  resetZNP() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SAPI',
      cmd: 0x09,              // ZB_SYSTEM_RESET
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME,
                  {type: cmdType.AREQ,
                   subsys: subSys.SYS,
                   cmd: 0x80,
                   waitRetryTimeout: 5000}), // SYS_RESET_IND
    ]);
  }

  registerApp() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'AF',
      cmd: 0x00,              // register app
      payload: Buffer.from([
        0x01,               // EP number
        0x04, 0x01,         // ZHA profile
        0x50, 0x00,         // DeviceID = Home Gateway
        this.product,       // device
        0x00,               // no latency
        0x02,               // 1 input clusters
        0x00, 0x00, 0x15, 0x00,
        0x00,               // 1 output clusters
      ]),
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  getExtAddr() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SYS',
      cmd: 0x04,
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  getNVInfo() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'UTIL',
      cmd: 0x01,
    };
    this.queueCommands([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  getNWKInfo() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'ZDO',
      cmd: 0x50,
    };
    this.queueCommands([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP, cmd: 0x50}),
    ]);
  }

  zdoRegisterCallbacks() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'ZDO',
      cmd: 0x3E,   // ZDO_MSG_CB_REG
      payload: Buffer.from([0xFF, 0xFF]),
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  startCoordinator() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SAPI',
      cmd: 0x00, // ZB_START_REQ
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  allowBind() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SAPI',
      cmd: 0x02, // MT_SAPI_ALLOW_BIND_REQ
      payload: Buffer.from([0xFF]),
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  disableTCKeyExchange() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'DEBUG',
      cmd: 0x09, // MT_APP_CNF_BDB_SET_TC_REQUIRE_KEY_EXCHANGE
      payload: Buffer.from([0x00]),
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  setUseMulticast() {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'ZDO',
      cmd: 0x53,
      payload: Buffer.from([0x81]),
    };
    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  readNVItem(item) {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SYS',
      cmd: 0x08, // OSAL_NV_READ
      payload: Buffer.from([ 0, 0, 0]),
    };

    this.lastNVReadItem = item;
    frame.payload.writeUInt16LE(item, 0);

    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP, cmd: 0x08}),
    ]);
  }

  writeNVItem(item, data) {
    const frame = {
      type: cmdType.SREQ,
      subsys: 'SYS',
      cmd: 0x09,
    };

    const nvData = Buffer.alloc(4 + data.length);
    const builder = new BufferBuilder(nvData);

    builder.appendUInt16LE(item);
    builder.appendUInt8(0x00);
    builder.appendUInt8(data.length);
    builder.appendBuffer(Buffer.from(data));
    frame.payload = nvData.slice(0, builder.length);

    this.queueCommandsAtFront([
      new Command(SEND_FRAME, frame),
      new Command(WAIT_FRAME, {type: cmdType.SRSP}),
    ]);
  }

  buildAndSendRawFrame(frame) {
    // console.log('buildAndSendRawFrame: ');
    // console.log(frame);

    if (frame.hasOwnProperty('subsys') && frame.hasOwnProperty('cmd')) {
      this.lastIDSeq = frame.id;
      this.unpi.send(frame.type, frame.subsys, frame.cmd, frame.payload);
    } else {
      const zsf = {type: frame.type};

      if (frame.profileId === PROFILE_ID.ZDO) {
        zsf.subsys = 'ZDO';
        zsf.cmd = parseInt(frame.clusterId, 16);
        self.lastZDOSeq = frame.zdoSeq;

        const zdoData = Buffer.alloc(256);
        const builder = new BufferBuilder(zdoData);

        console.log(`Sending ${zdo.CLUSTER_ID[zsf.cmd]}`);
        switch (zsf.cmd) {
          default:
            console.warn(`ZDO command ${zsf.cmd} not handled!`);
            break;
          case zdo.CLUSTER_ID.NETWORK_ADDRESS_REQUEST:
            builder.appendBuffer(frame.data.slice(1));
            break;
          case zdo.CLUSTER_ID.MANAGEMENT_LQI_REQUEST:
            builder.appendUInt16LE(parseInt(frame.destination16, 16));
            builder.appendUInt8(frame.startIndex);
            break;
          case zdo.CLUSTER_ID.MANAGEMENT_PERMIT_JOIN_REQUEST:
          {
            const dstAddr = parseInt(frame.destination16, 16);

            builder.appendUInt8(0x02);
            builder.appendUInt16LE(dstAddr);
            builder.appendUInt8(frame.permitDuration);
            builder.appendUInt8(frame.trustCenterSignificance);
            break;
          }
          case zdo.CLUSTER_ID.MANAGEMENT_LEAVE_REQUEST:
          {
            builder.appendUInt16LE(parseInt(frame.destination16, 16));
            builder.appendBuffer(frame.data.slice(1));
            break;
          }
          case zdo.CLUSTER_ID.SIMPLE_DESCRIPTOR_REQUEST:
            builder.appendUInt16LE(parseInt(frame.destination16, 16));
            builder.appendBuffer(frame.data.slice(1));
            break;
          case zdo.CLUSTER_ID.NODE_DESCRIPTOR_REQUEST:
          case zdo.CLUSTER_ID.ACTIVE_ENDPOINTS_REQUEST:
            {
              const dstAddr = parseInt(frame.destination16, 16);

              builder.appendUInt16LE(dstAddr);
              builder.appendUInt16LE(dstAddr);
              builder.appendUInt8(zsf.cmd);
              zsf.cmd = 0x29; // address of interest
            }
            break;
          case zdo.CLUSTER_ID.BIND_REQUEST:
            {
              builder.appendUInt16LE(parseInt(frame.destination16, 16));
              builder.appendBuffer(frame.data.slice(1));
            }
            break;
        }

        zsf.payload = zdoData.slice(0, builder.length);
      } else if (this.isZclFrame(frame)) {
        zsf.subsys = 'AF';
        zsf.cmd = 0x01; // AF_DATA_REQ

        const zclData = Buffer.alloc(256);
        const builder = new BufferBuilder(zclData);

        builder.appendUInt16LE(parseInt(frame.destination16, 16));
        builder.appendUInt8(frame.destinationEndpoint);
        builder.appendUInt8(frame.sourceEndpoint);
        builder.appendUInt16LE(parseInt(frame.clusterId, 16));
        builder.appendUInt8(frame.id);
        builder.appendUInt8(frame.options);
        builder.appendUInt8(DEF_RADIUS);
        builder.appendUInt8(frame.data.length);
        builder.appendBuffer(frame.data);
        zsf.payload = zclData.slice(0, builder.length);

        // console.log('AF data req: ', zsf.payload);
      } else {
        console.warn(`Profile ${frame.profileId} not handled! Skipping sending frame!`);
        return;
      }

      this.lastIDSeq = frame.id;
      this.unpi.send(zsf.type, zsf.subsys, zsf.cmd, zsf.payload);
    }
  }

  onZStackFrame(frame) {
    // console.log('ZStack frame:', frame);

    if (frame.type == cmdType.AREQ) {
      self.parseAREQ(frame);
    } else if (frame.type == cmdType.SRSP) {
      self.parseSRSP(frame);
    } else {
      console.warn('No handler defined for frame type: ', frame.type);
      return;
    }

    if ((frame.type == cmdType.AREQ && frame.subsys == subSys.ZDO &&
        frame.cmd == 0xFF) ||
            frame.drop === true) {
      return;
    }

    self.handleFrame(frame);
  }

  parseAREQ(frame) {
    // console.log('AREQ:');
    const reader = new BufferReader(frame.payload);

    if (frame.subsys == subSys.ZDO) {
      frame.id = self.lastIDSeq;

      if ((frame.cmd >= 0x82 && // nodeDescRsp
                frame.cmd <= 0x8A) || // serverDiscRsp
                (frame.cmd >= 0xB0 && // mgmtNwkDiscRsp
                frame.cmd <= 0xB6) ||   // mgmtPermitJoinRsp
                (frame.cmd >= 0xA0 &&   // bindings
                 frame.cmd <= 0xA2)
      ) {
        frame.remote16 = reader.nextString(2, 'hex').swapHex();
        reader.move(-1);
        frame.data = reader.restAll();
        frame.data[0] = this.lastZDOSeq;
        frame.profileId = 0;
        frame.clusterId = (0x8000 | (frame.cmd & 0x7F)).toString(16);

        // console.log(frame);
        // console.log(this.adapter.nodes);
        const node = this.adapter.findNodeByAddr16(frame.remote16);
        if (node) {
          frame.remote64 = node.addr64;
        }
        frame.destination64 = this.adapter.destination64;
        // console.log('ZDO RSP: ', frame);
      } else if (frame.cmd == 0x80) { // nwkAddrRsp
        frame.clusterId = (0x8000 | (frame.cmd & 0x7F)).toString(16);
        frame.profileId = 0;
        frame.data = Buffer.allocUnsafe(frame.payload.length + 1);
        frame.data.writeUInt8(this.lastZDOSeq);
        frame.payload.copy(frame.data, 1, 0, 1 + 8 + 2);
        frame.data[12] = (frame.payload[12]);
        frame.data[13] = (frame.payload[11]);
      } else if (frame.cmd == 0xC0) { // DevStateChanged
        console.log('ZStack device state changed to ', frame.payload[0]);
        if (frame.payload[0] == devStates.DEV_ZB_COORD) {
          console.log('Zigbee coordinator started!');
          this.getNWKInfo();
          this.getNVInfo();
          this.adapter.adapterInitialized();
        } else if (frame.payload[0] == devStates.DEV_END_DEVICE ||
                        frame.payload[0] == devStates.DEV_ROUTER) {
          console.log(
            'ZStack role is router or enddevice. Chaning to coodinator!');
          this.resetZNP();
          this.writeNVItem(nvItems.ZCD_NV_LOGICAL_TYPE, [0x00]);
        }
      } else if (frame.cmd == 0xC1) { // endDeviceAnnceInd
        frame.profileId = 0;
        frame.clusterId = '0013';
        frame.remote16 = reader.nextString(2, 'hex').swapHex();
        reader.move(-1);
        frame.data = reader.restAll();
        frame.data[0] = this.lastZDOSeq;
      } else if (frame.cmd == 0xC4) { // SRC RTG indication
        frame.drop = true;
      } else if (frame.cmd == 0xC9) { // leave indication
        frame.remote16 = reader.nextString(2, 'hex').swapHex();
        frame.remote64 = reader.nextString(8, 'hex').swapHex();

        console.log(`Device ${frame.remote64}:${frame.remote16} left network!`);
        frame.drop = true;
      } else if (frame.cmd == 0xCA) { // TC indication
        frame.drop = true;
      } else if (frame.cmd == 0xFF) { // zdoMsgCbIncomming
        frame.profileId = PROFILE_ID.ZDO;
        frame.remote16 = reader.nextString(2, 'hex').swapHex();
        frame.broadcast = reader.nextUInt8() == 0 ? false : true;
        frame.clusterId = reader.nextString(2, 'hex').swapHex();
        frame.securityUse = reader.nextUInt8() == 0 ? false : true;
        frame.zdoSeq = reader.nextUInt8();
        frame.destination16 = reader.nextString(2, 'hex').swapHex();
        reader.move(-1);
        frame.data = reader.restAll();
        frame.data[0] = self.lastZDOSeq;

        const node = this.adapter.findNodeByAddr16(frame.remote16);
        if (node) {
          frame.remote64 = node.addr64;
          // console.log(node);
        }
      }
    } else if (frame.subsys == subSys.AF) {
      frame.id = self.lastIDSeq;
      if (frame.cmd == 0x81) {
        frame.profileId = PROFILE_ID.ZHA.toString(16).padStart(4, '0');
        frame.groupId = reader.nextUInt16LE();
        frame.clusterId = reader.nextString(2, 'hex').swapHex();
        frame.remote16 = reader.nextString(2, 'hex').swapHex();
        frame.sourceEndpoint = reader.nextString(1, 'hex');
        frame.destinationEndpoint = reader.nextString(1, 'hex');
        frame.broadcast = reader.nextUInt8() == 0 ? false : true;
        frame.lqi = reader.nextUInt8();
        frame.securityUse = reader.nextUInt8() == 0 ? false : true;
        frame.timestamp = reader.nextInt32LE();
        frame.zdoSeq = reader.nextUInt8();
        const dataLen = reader.nextUInt8();
        frame.data = reader.restAll().slice(0, dataLen);

        const node = this.adapter.findNodeByAddr16(frame.remote16);
        if (node) {
          frame.remote64 = node.addr64;
        }
      } else if (frame.cmd == 0x80) { // AF data confirm
        frame.drop = true;
      } else {
        console.warn(`AF AREQ, cmd ${frame.cmd} not handled!`);
      }
    } else if (frame.subsys == subSys.SYS) {
      if (frame.cmd == 0x80) { // SYS_RESET_IND
        // version response
        this.transportRev = frame.payload[1];
        this.product = frame.payload[2];
        this.version = `${frame.payload[3].toString(16)}.${
          frame.payload[4].toString(16)}.${
          frame.payload[5].toString(16)}`;

        console.log('ZStack reset. Reason ', frame.payload[0]);
        console.log(`ZStack dongle ${this.transportRev}, product: ${this.product}, version: ${this.version}`);
      } else {
        console.warn(`SYS AREQ, cmd ${frame.cmd} not handled!`);
      }
    } else {
      console.warn(`No parser for AREQ, subsystem ${frame.subsys}`);
    }
  }

  parseSRSP(frame) {
    // console.log('SRSP: ', frame);
    if (frame.subsys == subSys.SYS) {
      if (frame.cmd == 0x04) {
        const br = new BufferReader(frame.payload);

        this.adapter.networkAddr64 = br.nextString(8, 'hex').swapHex();
        this.adapter.networkAddr16 = '0000';
      }
      //   else if (frame.cmd == 0x08) { // OSAL_NV_READ
      //     if (frame.payload[0] == 0x00) // success
      //     {
      //       if (this.lastNVReadItem == nvItems.ZCD_NV_PANID) {
      //         const panID = frame.payload.readUInt16LE(2);
      //         if (panID == 0xFFFF) {

      //         }
      //       }
      //     }
    } else if (frame.subsys == subSys.ZDO) {
      if (frame.cmd == 0x50) { // NWK info rsp
        const br = new BufferReader(frame.payload);
        this.shortAddr = br.nextString(2, 'hex').swapHex();
        this.PANID = br.nextString(2, 'hex').swapHex();
        this.parentAddr = br.nextString(2, 'hex').swapHex();
        this.ExtPANID = br.nextString(8, 'hex').swapHex();
        this.ExtParentAddr = br.nextString(8, 'hex').swapHex();
        this.channel = br.nextUInt8();

        console.log('NWK info:');
        console.log('PANID: ', this.PANID);
        console.log('Ext PANID: ', this.ExtPANID);
        console.log('Current channel: ', this.channel);
      } else {
        frame.status = frame.payload[0];
        if (frame.status == 0x00) {
          frame.id = self.lastIDSeq;
        } else {
          console.log(`ZDO SRSP for cmd ${frame.cmd} status error ${frame.status}!`);
        }
      }
    } else if (frame.subsys == subSys.AF) {
      frame.status = frame.payload[0];
      frame.type = self.getExplicitRxFrameType();
      // console.log('last frame: ', JSON.stringify(this.lastFrameSent));
      if (this.lastFrameSent.destination64) {
        frame.remote64 = this.lastFrameSent.destination64;
      }
      if (frame.status == 0x00) {
        frame.id = self.lastIDSeq;
      } else {
        console.log(`AF SRSP for cmd ${frame.cmd} status error ${frame.status}!`);
      }
    } else if (frame.subsys == subSys.UTIL) {
      if (frame.cmd == 0x01) { // get NV info
        const br = new BufferReader(frame.payload);
        const status = br.nextUInt8();

        if ((status & 0x01) == 0) {
          console.log('IEEE: ', br.nextString(8, 'hex').swapHex());
        }
        if ((status & 0x02) == 0) {
          console.log('Channels: ', br.nextString(4, 'hex').swapHex());
        }
        if ((status & 0x04) == 0) {
          const nvPANID = br.nextString(2, 'hex').swapHex();
          console.log('PanID: ', nvPANID);
          if (this.PANID !== nvPANID) {
            console.log(`Saving PAN ID: ${this.PANID} to NV ram!`);
            const p = parseInt(this.PANID, 16);
            this.writeNVItem(nvItems.ZCD_NV_PANID, [p & 0xFF, p >> 8]);
          }
        }
      }
    } else {
      console.warn('No parser for SRSP, subsystem ', frame.subsys);
    }
  }

  nextFrameId() {
    self.idSeq++;
    if (self.idSeq > 0xFF) {
      self.idSeq = 0;
    }
    return self.idSeq;
  }

  frameTypeAsStr(frame) {
    return `${frame.type} (0x${frame.type.toString(16)})`;
  }

  dumpFrame(label, _frame, _dumpFrameDetail) {
    console.log(label);
  }

  getExplicitRxFrameType() {
    return cmdType.AREQ;
  }

  getExplicitTxFrameType() {
    return cmdType.SREQ;
  }

  getTransmitStatusFrameType() {
    return cmdType.SRSP;
  }

  permitJoinCommands(_duration) {
    return [];
  }

  asDeviceInfo() {
    return {
      deviceType: 'coordinator',
      version: this.version,
      configuredPanId64: this.adapter.networkAddr64,
    };
  }

  handleAREQ(frame) {
    // console.log('AREQ post handle: ', frame);
    if (frame.subsys == subSys.ZDO) {
      self.handleExplicitRx(frame);
    } else if (frame.subsys == subSys.AF && frame.cmd == 0x81) {
      self.handleExplicitRx(frame);
    }
  }

  handleSRSP(_frame) {

  }

  getFrameHandler(frame) {
    return ZStackDriver.frameHandler[frame.type];
  }

  close() {
    this.serialPort.close();
  }
}

ZStackDriver.frameHandler = {
  [cmdType.AREQ]: ZStackDriver.prototype.handleAREQ,
  [cmdType.SRSP]: ZStackDriver.prototype.handleSRSP,
};

module.exports = ZStackDriver;

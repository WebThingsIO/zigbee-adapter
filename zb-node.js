/**
 *
 * ZigbeeDevice - represents a device on the Zigbee network
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const xbeeApi = require('xbee-api');
const zclId = require('zcl-id');
const zcl = require('zcl-packet');
const zdo = require('./zb-zdo');

let Device, utils;
try {
  Device = require('../device');
  utils = require('../utils');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Device = gwa.Device;
  utils = gwa.Utils;
}

const C = xbeeApi.constants;

// Server in this context means "server of the cluster"
const DIR_CLIENT_TO_SERVER = 0;
const DIR_SERVER_TO_CLIENT = 1;

const ZHA_PROFILE_ID = zclId.profile('HA').value;
const ZHA_PROFILE_ID_HEX = utils.hexStr(ZHA_PROFILE_ID, 4);
const ZLL_PROFILE_ID = zclId.profile('LL').value;
const ZLL_PROFILE_ID_HEX = utils.hexStr(ZLL_PROFILE_ID, 4);

const CLUSTER_ID_GENOTA = zclId.cluster('genOta').value;

const CLUSTER_ID_SSIASZONE = zclId.cluster('ssIasZone').value;
const CLUSTER_ID_SSIASZONE_HEX = utils.hexStr(CLUSTER_ID_SSIASZONE, 4);

const ZCL_STATUS_SUCCESS = zclId.status('success').value;

const SKIP_DISCOVER_READ_CLUSTERS = ['haDiagnostic'];

class ZigbeeNode extends Device {

  constructor(adapter, id64, id16) {
    // Our id is a Mac address on the Zigbee network. It's unique within
    // the zigbee network, but might not be globally unique, so we prepend
    // with zb- to put it in a namespace.
    const deviceId = `zb-${id64}`;
    super(adapter, deviceId);

    this.addr64 = id64;
    this.addr16 = id16;
    this.neighbors = [];
    this.activeEndpoints = {};
    this.activeEndpointsPopulated = false;

    this.isCoordinator = (id64 == adapter.serialNumber);

    if (this.isCoordinator) {
      this.defaultName = `${deviceId}-Dongle`;
    } else {
      this.defaultName = `${deviceId}-Node`;
    }
    this.discoveringAttributes = false;
    this.fireAndForget = false;
    this.extendedTimeout = false;
    this.added = false;
  }

  asDict() {
    const dict = super.asDict();
    dict.addr64 = this.addr64;
    dict.addr16 = this.addr16;
    dict.neighbors = this.neighbors;
    dict.activeEndpoints = this.activeEndpoints;
    dict.isCoordinator = this.isCoordinator;
    dict.fireAndForget = this.fireAndForget;
    for (const endpointNum in dict.activeEndpoints) {
      const endpoint = dict.activeEndpoints[endpointNum];
      let clusterId;
      let idx;
      let zclCluster;
      for (idx in endpoint.inputClusters) {
        clusterId = parseInt(endpoint.inputClusters[idx], 16);
        zclCluster = zclId.clusterId.get(clusterId);
        if (zclCluster) {
          endpoint.inputClusters[idx] += ` - ${zclCluster.key}`;
        }
      }
      for (idx in endpoint.outputClusters) {
        clusterId = parseInt(endpoint.outputClusters[idx], 16);
        zclCluster = zclId.clusterId.get(clusterId);
        if (zclCluster) {
          endpoint.outputClusters[idx] += ` - ${zclCluster.key}`;
        }
      }
    }
    return dict;
  }

  debugCmd(cmd, params) {
    switch (cmd) {

      case 'debug':
        if (params.hasOwnProperty('debugFrames')) {
          console.log('Setting debugFrames to', params.debugFrames);
          this.adapter.debugFrames = params.debugFrames;
        }
        if (params.hasOwnProperty('debugDumpFrameDetail')) {
          console.log('Setting debugDumpFrameDetail to',
                      params.debugDumpFrameDetail);
          this.adapter.debugDumpFrameDetail = params.debugDumpFrameDetail;
        }
        break;

      case 'discoverAttr':
        this.adapter.discoverAttributes(this);
        break;

      case 'readAttr': {
        let paramMissing = false;
        // Note: We allow attrId to be optional
        for (const p of ['endpoint', 'profileId', 'clusterId']) {
          if (!params.hasOwnProperty(p)) {
            console.error('Missing parameter:', p);
            paramMissing = true;
          }
        }
        if (!paramMissing) {
          console.log('Issuing read attribute for endpoint:', params.endpoint,
                      'profileId:', params.profileId,
                      'clusterId', params.clusterId,
                      'attrId:', params.attrId);
          this.adapter.readAttribute(this,
                                     params.endpoint,
                                     params.profileId,
                                     params.clusterId,
                                     params.attrId);
        }
        break;
      }

      default:
        console.log('Unrecognized debugCmd:', cmd);
    }
  }

  findZhaEndpointWithInputClusterIdHex(clusterIdHex) {
    for (const endpointNum in this.activeEndpoints) {
      const endpoint = this.activeEndpoints[endpointNum];
      if (endpoint.profileId == ZHA_PROFILE_ID_HEX ||
          endpoint.profileId == ZLL_PROFILE_ID_HEX) {
        if (endpoint.inputClusters.includes(clusterIdHex)) {
          return endpointNum;
        }
      }
    }
  }

  findZhaEndpointWithOutputClusterIdHex(clusterIdHex) {
    for (const endpointNum in this.activeEndpoints) {
      const endpoint = this.activeEndpoints[endpointNum];
      if (endpoint.profileId == ZHA_PROFILE_ID_HEX ||
          endpoint.profileId == ZLL_PROFILE_ID_HEX) {
        if (endpoint.outputClusters.includes(clusterIdHex)) {
          return endpointNum;
        }
      }
    }
  }

  getAttrEntryFromFrame(frame, attrId) {
    if (frame.zcl && Array.isArray(frame.zcl.payload)) {
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.attrId == attrId) {
          return attrEntry;
        }
      }
    }
  }

  getAttrEntryFromFrameForProperty(frame, property) {
    let attrId;
    if (Array.isArray(property.attr)) {
      const attrEntries = [];
      for (const attr of property.attr) {
        attrId = zclId.attr(property.clusterId, attr).value;
        const attrEntry = this.getAttrEntryFromFrame(frame, attrId);
        if (attrEntry) {
          attrEntries.push(attrEntry);
        }
      }
      return attrEntries;
    }
    attrId = zclId.attr(property.clusterId, property.attr).value;
    return this.getAttrEntryFromFrame(frame, attrId);
  }

  frameHasAttr(frame, property) {
    if (frame.clusterId == CLUSTER_ID_SSIASZONE_HEX) {
      // For IAS Zones, there should only be one property.
      return true;
    }
    const attrEntry = this.getAttrEntryFromFrameForProperty(frame, property);
    if (Array.isArray(attrEntry)) {
      return attrEntry.length > 0;
    }
    return !!attrEntry;
  }

  findPropertyFromFrame(frame) {
    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    const endpoint = parseInt(frame.sourceEndpoint, 16);

    for (const property of this.properties.values()) {
      if (profileId == property.profileId &&
          endpoint == property.endpoint &&
          clusterId == property.clusterId) {
        if (this.frameHasAttr(frame, property)) {
          return property;
        }
      }
    }
  }

  handleConfigReportRsp(frame) {
    if (this.reportZclStatusError(frame)) {
      // Some devices, like Hue bulbs, don't support configReports on the
      // ZHA clusters. This means that we need to treat them as
      // 'fire and forget'.

      const property = this.findPropertyFromFrame(frame);
      if (property) {
        property.fireAndForget = true;
      }
    }
  }

  handleDiscoverRsp(frame) {
    this.reportZclStatusError(frame);
    const payload = frame.zcl.payload;
    if (payload.discComplete == 0) {
      // More attributes are available
      const discoverFrame =
        this.makeDiscoverAttributesFrame(
          frame.sourceEndpoint,
          frame.profileId,
          frame.clusterId,
          payload.attrInfos.slice(-1)[0].attrId + 1
        );
      this.adapter.sendFrameWaitFrameAtFront(discoverFrame, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'discoverRsp',
        zclSeqNum: discoverFrame.id,
      });
    }

    const clusterId = parseInt(frame.clusterId, 16);
    const clusterIdStr = zclId.cluster(clusterId).key;
    let attrInfo;
    if (SKIP_DISCOVER_READ_CLUSTERS.includes(clusterIdStr)) {
      // This is a cluster which dosen't seem to respond to read requests.
      // Just print the attributes.
      for (attrInfo of payload.attrInfos) {
        const attr = zclId.attr(clusterId, attrInfo.attrId);
        const attrStr = attr ? attr.key : 'unknown';
        const dataType = zclId.dataType(attrInfo.dataType);
        const dataTypeStr = dataType ? dataType.key : 'unknown';
        console.log('      AttrId:', `${attrStr} (${attrInfo.attrId})`,
                    'dataType:', `${dataTypeStr} (${attrInfo.dataType})`);
      }
      return;
    }

    // Read the values of all of the attributes. We put this after
    // asking for the next frame, since the read requests go at the
    // front of the queue.

    for (attrInfo of payload.attrInfos.reverse()) {
      const readFrame = this.makeReadAttributeFrame(
        frame.sourceEndpoint,
        frame.profileId,
        clusterId,
        attrInfo.attrId
      );
      this.adapter.sendFrameWaitFrameAtFront(readFrame, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.id,
      });
    }
  }

  handleEnrollReq(reqFrame) {
    const rspStatus = 0;
    const zoneId = 1;
    const enrollRspFrame =
      this.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
    this.adapter.sendFrameWaitFrameAtFront(enrollRspFrame, {
      type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
      id: enrollRspFrame.id,
    });
  }

  handleQueryNextImageReq(frame) {
    // For the time being, we always indicate that we have no images.
    const rspFrame = this.makeZclFrame(
      frame.sourceEndpoint,
      frame.profileId,
      CLUSTER_ID_GENOTA,
      {
        cmd: 'queryNextImageRsp',
        frameCntl: {
          frameType: 1,   // queryNextImageRsp is specific to genOta
          direction: DIR_SERVER_TO_CLIENT,
          disDefaultRsp: 1,
        },
        seqNum: frame.zcl.seqNum,
        payload: {
          status: zclId.status('noImageAvailable').value,
        },
      }
    );
    rspFrame.sourceEndpoint = parseInt(frame.destinationEndpoint);

    this.adapter.sendFrameWaitFrameAtFront(rspFrame, {
      type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
      id: rspFrame.id,
    });
  }

  handleReadRsp(frame) {
    this.reportZclStatusError(frame);
    if (this.discoveringAttributes && frame.zcl.cmdId === 'readRsp') {
      const clusterId = parseInt(frame.clusterId, 16);
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.status == ZCL_STATUS_SUCCESS) {
          const attr = zclId.attr(clusterId, attrEntry.attrId);
          const attrStr = attr ? attr.key : 'unknown';
          const dataType = zclId.dataType(attrEntry.dataType);
          const dataTypeStr = dataType ? dataType.key : 'unknown';
          console.log('      AttrId:',
                      `${attrStr} ( ${attrEntry.attrId})`,
                      'dataType:', `${dataTypeStr} (${attrEntry.dataType})`,
                      'data:', attrEntry.attrData);
        }
      }
      return;
    }

    const property = this.findPropertyFromFrame(frame);
    if (property) {
      // Note: attrEntry might be an array.
      const attrEntry = this.getAttrEntryFromFrameForProperty(frame, property);
      const [value, logValue] = property.parseAttrEntry(attrEntry);
      property.setCachedValue(value);
      console.log(this.name,
                  'property:', property.name,
                  'profileId:', utils.hexStr(property.profileId, 4),
                  'endpoint:', property.endpoint,
                  'clusterId:', utils.hexStr(property.clusterId, 4),
                  frame.zcl.cmdId,
                  'value:', logValue);
      const deferredSet = property.deferredSet;
      if (deferredSet) {
        property.deferredSet = null;
        deferredSet.resolve(property.value);
      }
      this.notifyPropertyChanged(property);
    }
  }

  handleStatusChangeNotification(frame) {
    const zoneStatus = frame.zcl.payload.zonestatus;
    const property = this.findPropertyFromFrame(frame);
    if (property) {
      const value = ((zoneStatus & 3) != 0);
      property.setCachedValue(value);
      console.log(this.name,
                  'property:', property.name,
                  'profileId:', utils.hexStr(property.profileId, 4),
                  'endpoint:', property.endpoint,
                  'clusterId:', utils.hexStr(property.clusterId, 4),
                  'value:', value,
                  'zoneStatus:', zoneStatus);
      this.notifyPropertyChanged(property);
    }
  }

  handleZhaResponse(frame) {
    if (frame.zcl) {
      switch (frame.zcl.cmdId) {
        case 'configReportRsp':
          this.handleConfigReportRsp(frame);
          break;
        case 'defaultRsp':
          // Don't generate a defaultRsp to a defaultRsp. We ignore
          // defaultRsp, so there's nothing else to do.
          return;
        case 'readRsp':
        case 'report':
          this.handleReadRsp(frame);
          break;
        case 'discoverRsp':
          this.handleDiscoverRsp(frame);
          break;
        case 'enrollReq':
          this.handleEnrollReq(frame);
          // enrollReq sends back an enrollRsp so no need to
          // generate a defaultRsp
          return;
        case 'statusChangeNotification':
          // Note: The zcl-packet library doesn't seem to extract
          //       the zoneid or delay fields from the received packet.
          this.handleStatusChangeNotification(frame);
          break;
        case 'queryNextImageReq':
          this.handleQueryNextImageReq(frame);
          // We send a queryNextImageRsp, so no need to
          // generate a defaultRsp
          return;
        case 'writeNoRsp':
          // Don't generate a defaultRsp to a writeNoRsp command.
          return;
      }

      // Generate a defaultRsp
      if (frame.zcl.frameCntl.disDefaultRsp == 0 &&
          this.isZclStatusSuccess(frame)) {
        const defaultRspFrame =
          this.makeDefaultRspFrame(frame, ZCL_STATUS_SUCCESS);
        this.adapter.sendFrameWaitFrameAtFront(defaultRspFrame, {
          type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
          id: defaultRspFrame.id,
        });
      }
    }
  }

  makeBindFrame(endpoint, clusterId, configReportFrames) {
    const frame = this.adapter.zdo.makeFrame({
      destination64: this.addr64,
      destination16: this.addr16,
      clusterId: zdo.CLUSTER_ID.BIND_REQUEST,
      bindSrcAddr64: this.addr64,
      bindSrcEndpoint: endpoint,
      bindClusterId: clusterId,
      bindDstAddrMode: 3,
      bindDstAddr64: this.adapter.serialNumber,
      bindDstEndpoint: 0,
      sendOnSuccess: configReportFrames,
    });
    return frame;
  }

  addBindFramesFor(frames) {
    // Find all of the unique configReport clusterId/endpoint combinations
    // and create bind frames for each one. Some devices, like the Hue bulbs,
    // don't support binding, which means we also set things up so that we
    // only send the configReport frames if the binding request is successful.
    const outputFrames = [];
    const uniqueClusterEndpoint = {};
    for (const frame of frames) {
      if (frame.zcl && frame.zcl.cmd == 'configReport') {
        const key = `${frame.destinationEndpoint}${frame.clusterId}`;
        if (uniqueClusterEndpoint.hasOwnProperty(key)) {
          uniqueClusterEndpoint[key].frames.push(frame);
        } else {
          uniqueClusterEndpoint[key] = {
            endpoint: frame.destinationEndpoint,
            clusterId: frame.clusterId,
            frames: [frame],
          };
        }
      } else {
        outputFrames.push(frame);
      }
    }
    for (const uce of Object.values(uniqueClusterEndpoint)) {
      outputFrames.unshift(this.makeBindFrame(uce.endpoint,
                                              uce.clusterId,
                                              uce.frames));
    }
    return outputFrames;
  }

  makeConfigReportFrame(property) {
    const clusterId = property.clusterId;
    let attrs = property.attr;
    if (!Array.isArray(attrs)) {
      attrs = [attrs];
    }

    const frame = this.makeZclFrameForProperty(
      property,
      {
        cmd: 'configReport',
        payload: attrs.map((attr) => {
          return {
            direction: DIR_CLIENT_TO_SERVER,
            attrId: zclId.attr(clusterId, attr).value,
            dataType: zclId.attrType(clusterId, attr).value,
            minRepIntval: 1,
            maxRepIntval: 120,
            repChange: 1,
          };
        }),
      }
    );
    return frame;
  }

  makeDefaultRspFrame(frame, statusCode) {
    const rspFrame = this.makeZclFrame(
      frame.sourceEndpoint,
      frame.profileId,
      frame.clusterId,
      {
        cmd: 'defaultRsp',
        frameCntl: {
          frameType: 0,
          disDefaultRsp: 1,
        },
        payload: {
          cmdId: frame.zcl.cmdId,
          statusCode: statusCode,
        },
      }
    );
    rspFrame.zcl.seqNum = frame.zcl.seqNum;
    return rspFrame;
  }

  makeDiscoverAttributesFrame(endpoint, profileId, clusterId, startAttrId) {
    const frame = this.makeZclFrame(
      endpoint, profileId, clusterId,
      {
        cmd: 'discover',
        payload: {
          startAttrId: startAttrId,
          maxAttrIds: 255,
        },
      }
    );
    return frame;
  }

  makeEnrollRspFrame(enrollReqFrame, status, zoneId) {
    if (!enrollReqFrame) {
      enrollReqFrame = {
        sourceEndpoint:
          this.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SSIASZONE_HEX),
        profileId: ZHA_PROFILE_ID_HEX,
      };
    }
    const rspFrame = this.makeZclFrame(
      enrollReqFrame.sourceEndpoint,
      enrollReqFrame.profileId,
      CLUSTER_ID_SSIASZONE,
      {
        cmd: 'enrollRsp',
        frameCntl: {
          frameType: 1,   // enrollRsp is specific to the IAS Zone cluster
        },
        payload: {
          enrollrspcode: status,
          zoneid: zoneId,
        },
      }
    );
    if (enrollReqFrame.zcl) {
      rspFrame.zcl.seqNum = enrollReqFrame.zcl.seqNum;
    }
    return rspFrame;
  }

  makeReadAttributeFrame(endpoint, profileId, clusterId, attrIds) {
    if (!Array.isArray(attrIds)) {
      attrIds = [attrIds];
    }
    const frame = this.makeZclFrame(
      endpoint, profileId, clusterId,
      {
        cmd: 'read',
        payload: attrIds.map((attrId) => {
          return {direction: DIR_CLIENT_TO_SERVER, attrId: attrId};
        }),
      }
    );
    return frame;
  }

  makeReadAttributeFrameForProperty(property) {
    return this.makeReadAttributeFrame(property.endpoint,
                                       property.profileId,
                                       property.clusterId,
                                       property.attrId);
  }

  makeReadReportConfigFrame(property) {
    const clusterId = property.clusterId;
    const attr = property.attr;
    const frame = this.makeZclFrameForProperty(
      property,
      {
        cmd: 'readReportConfig',
        payload: [
          {
            direction: DIR_CLIENT_TO_SERVER,
            attrId: zclId.attr(clusterId, attr).value,
          },
        ],
      }
    );
    return frame;
  }

  // attrIdsVals is an array of tuples:
  //  [[attrId1, attrVal1], [attrId2, attrVal2], ...]
  makeWriteAttributeFrame(endpoint, profileId, clusterId, attrIdsVals) {
    const frame = this.makeZclFrame(
      endpoint, profileId, clusterId,
      {
        cmd: 'write',
        payload: attrIdsVals.map((attrTuple) => {
          const attrId = attrTuple[0];
          const attrData = attrTuple[1];
          return {
            attrId: zclId.attr(clusterId, attrId).value,
            dataType: zclId.attrType(clusterId, attrId).value,
            attrData: attrData,
          };
        }),
      }
    );
    return frame;
  }

  makeZclFrame(endpoint, profileId, clusterId, zclData) {
    if (!zclData.hasOwnProperty('frameCntl')) {
      zclData.frameCntl = {
        // frameType 0 = foundation
        // frameType 1 = functional (cluster specific)
        frameType: 0,
      };
    }
    if (!zclData.frameCntl.hasOwnProperty('manufSpec')) {
      zclData.frameCntl.manufSpec = 0;
    }
    if (!zclData.frameCntl.hasOwnProperty('direction')) {
      zclData.frameCntl.direction = DIR_CLIENT_TO_SERVER;
    }
    if (!zclData.frameCntl.hasOwnProperty('disDefaultRsp')) {
      zclData.frameCntl.disDefaultRsp = 0;
    }
    if (!zclData.hasOwnProperty('manufCode')) {
      zclData.manufCode = 0;
    }
    if (!zclData.hasOwnProperty('payload')) {
      zclData.payload = [];
    }

    const frame = {
      id: xbeeApi._frame_builder.nextFrameId(),
      type: C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME,
      destination64: this.addr64,
      destination16: this.addr16,
      sourceEndpoint: 0,

      destinationEndpoint: endpoint,
      profileId: profileId,
      clusterId: utils.hexStr(clusterId, 4),

      broadcastRadius: 0,
      options: 0,
      zcl: zclData,
    };

    frame.data = zcl.frame(zclData.frameCntl,
                           zclData.manufCode,
                           frame.id,
                           zclData.cmd,
                           zclData.payload,
                           clusterId);
    return frame;
  }

  makeZclFrameForProperty(property, zclData) {
    return this.makeZclFrame(property.endpoint,
                             property.profileId,
                             property.clusterId,
                             zclData);
  }

  notifyPropertyChanged(property) {
    const deferredSet = property.deferredSet;
    if (deferredSet) {
      property.deferredSet = null;
      deferredSet.resolve(property.value);
    }
    super.notifyPropertyChanged(property);
  }

  isZclStatusSuccess(frame) {
    // Note: 'report' frames don't have a status
    // Cluster specific commands may or may not have payloads
    // which are arrays, so we only try to iterate if it looks
    // like an array.
    if (Array.isArray(frame.zcl.payload)) {
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.hasOwnProperty('status') &&
            attrEntry.status != ZCL_STATUS_SUCCESS) {
          return false;
        }
      }
    }
    return true;
  }

  reportZclStatusError(frame) {
    let errorFound = false;
    for (const attrEntry of frame.zcl.payload) {
      // Note: 'report' frames don't have a status
      if (attrEntry.hasOwnProperty('status') &&
          attrEntry.status != ZCL_STATUS_SUCCESS) {
        let status = zclId.status(attrEntry.status);
        if (!status) {
          status = {key: 'unknown', value: attrEntry.status};
        }
        const clusterId = zdo.getClusterIdAsInt(frame.clusterId);
        let cluster = zclId.cluster(clusterId);
        if (!cluster) {
          cluster = {key: 'unknown', value: frame.clusterId};
        }
        let attr = zclId.attr(frame.clusterId, attrEntry.attrId);
        if (!attr) {
          attr = {key: 'unknown', value: attrEntry.attrId};
        }
        console.error('Response:', frame.zcl.cmdId,
                      'got status:', status.key, `(${status.value}) node:`,
                      this.name, 'cluster:', cluster.key,
                      `(${cluster.value}) attr:`, attr.key, `(${attr.value})`);
        errorFound = true;
      }
    }
    return errorFound;
  }

  sendFrames(frames) {
    this.adapter.sendFrames(frames);
  }

  sendZclFrameWaitExplicitRx(property, zclData) {
    const frame = this.makeZclFrameForProperty(property, zclData);
    this.adapter.sendFrameWaitFrame(frame, {
      type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
      remote64: frame.destination64,
    }, property);
  }

  sendZclFrameWaitExplicitRxResolve(property, zclData) {
    const frame = this.makeZclFrameForProperty(property, zclData);
    this.adapter.sendFrameWaitFrameResolve(frame, {
      type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
      remote64: frame.destination64,
    }, property);
  }
}

module.exports = ZigbeeNode;

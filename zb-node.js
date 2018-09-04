/**
 *
 * ZigbeeDevice - represents a device on the Zigbee network
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const assert = require('assert');
const cloneDeep = require('clone-deep');
const xbeeApi = require('xbee-api');
const zclId = require('zcl-id');
const zcl = require('zcl-packet');
const zdo = require('./zb-zdo');
const zigbeeClassifier = require('./zb-classifier');
const ZigbeeFamily = require('./zb-family');

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

const DEBUG = false;

const C = xbeeApi.constants;

// Server in this context means "server of the cluster"
const DIR_CLIENT_TO_SERVER = 0;
const DIR_SERVER_TO_CLIENT = 1;

const ZHA_PROFILE_ID = zclId.profile('HA').value;
const ZHA_PROFILE_ID_HEX = utils.hexStr(ZHA_PROFILE_ID, 4);
const ZLL_PROFILE_ID = zclId.profile('LL').value;
const ZLL_PROFILE_ID_HEX = utils.hexStr(ZLL_PROFILE_ID, 4);

const CLUSTER_ID_GENBASIC = zclId.cluster('genBasic').value;
const CLUSTER_ID_GENBASIC_HEX = utils.hexStr(CLUSTER_ID_GENBASIC, 4);

const ATTR_ID_GENBASIC_APPVERSION =
  zclId.attr(CLUSTER_ID_GENBASIC, 'appVersion').value;
const ATTR_ID_GENBASIC_ZCLVERSION =
  zclId.attr(CLUSTER_ID_GENBASIC, 'zclVersion').value;
const ATTR_ID_GENBASIC_MODELID =
  zclId.attr(CLUSTER_ID_GENBASIC, 'modelId').value;
const ATTR_ID_GENBASIC_POWERSOURCE =
  zclId.attr(CLUSTER_ID_GENBASIC, 'powerSource').value;

  // powerSource is from cluster 0000, attrId 7
const POWERSOURCE_UNKNOWN = 0;
const POWERSOURCE_BATTERY = 3;

const CLUSTER_ID_GENOTA = zclId.cluster('genOta').value;

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
const ATTR_ID_GENPOLLCTRL_CHECKININTERVALMIN =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'checkinIntervalMin').value;
const ATTR_ID_GENPOLLCTRL_LONGPOLLINTERVALMIN =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'longPollIntervalMin').value;
const ATTR_ID_GENPOLLCTRL_FASTPOLLTIMEOUTMAX =
  zclId.attr(CLUSTER_ID_GENPOLLCTRL, 'fastPollTimeoutMax').value;

const CLUSTER_ID_OCCUPANCY_SENSOR = zclId.cluster('msOccupancySensing').value;

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
const ATTR_ID_SSIASZONE_ZONEID =
  zclId.attr(CLUSTER_ID_SSIASZONE, 'zoneId').value;

const STATUS_SUCCESS = zclId.status('success').value;

const SKIP_DISCOVER_READ_CLUSTERS = ['haDiagnostic'];

const DEVICE_INFO_FIELDS = [
  'name', 'type', '@type', 'defaultName', 'extendedTimeout',
  'activeEndpointsPopulated',
  'nodeInfoEndpointsPopulated',
  'colorCapabilities',
  'zoneType',
  'modelId',
  'appVersion',
  'powerSource',
];

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
    this.queryingActiveEndpoints = false;
    this.nodeInfoEndpointsPopulated = false;

    this.isCoordinator = (id64 == adapter.serialNumber);

    if (this.isCoordinator) {
      this.defaultName = `${deviceId}-Dongle`;
    } else {
      this.defaultName = `${deviceId}-Node`;
    }
    this.discoveringAttributes = false;
    this.fireAndForget = false;
    this.extendedTimeout = true;
    this.powerSource = POWERSOURCE_UNKNOWN;
    this.added = false;
    this.rebindRequired = true;
    this.zclSeqNum = 1;
  }

  advanceZclSeqNum() {
    this.zclSeqNum = (this.zclSeqNum + 1) & 0xff;
    if (this.zclSeqNum == 0) {
      // I'm not sure if 0 is a valid sequence number or not, but we'll skip it
      // just in case.
      this.zclSeqNum = 1;
    }
  }

  asDeviceInfo() {
    const devInfo = {
      addr64: this.addr64,
      addr16: this.addr16,
      activeEndpoints: {},
      properties: {},
    };
    for (const field of DEVICE_INFO_FIELDS) {
      if (this.hasOwnProperty(field)) {
        devInfo[field] = this[field];
      }
    }
    if (this.family) {
      devInfo.family = this.family.name;
    }
    for (const endpointNum in this.activeEndpoints) {
      const endpoint = this.activeEndpoints[endpointNum];
      devInfo.activeEndpoints[endpointNum] = {
        profileId: endpoint.profileId,
        deviceId: endpoint.deviceId,
        deviceVersion: endpoint.deviceVersion,
        inputClusters: (endpoint.hasOwnProperty('inputClusters') &&
                        endpoint.inputClusters.slice(0)) || [],
        outputClusters: (endpoint.hasOwnProperty('inputClusters') &&
                         endpoint.outputClusters.slice(0)) || [],
        classifierAttributesPopulated: endpoint.classifierAttributesPopulated,
      };
    }

    this.properties.forEach((property, propertyName) => {
      devInfo.properties[propertyName] = property.asDict();
    });
    return devInfo;
  }

  fromDeviceInfo(devInfo) {
    // Currently, we make the assumption that this function is called
    // before we know any information about the devices, so we do the
    // simple thing and create new. If needed, this could be some type
    // of "merge".
    for (const field of DEVICE_INFO_FIELDS) {
      if (devInfo.hasOwnProperty(field)) {
        this[field] = devInfo[field];
      }
    }
    if (!this.name) {
      this.name = this.defaultName;
    }
    for (const endpointNum in devInfo.activeEndpoints) {
      const endpoint = devInfo.activeEndpoints[endpointNum];
      this.activeEndpoints[endpointNum] = {
        profileId: endpoint.profileId,
        deviceId: endpoint.deviceId,
        deviceVersion: endpoint.deviceVersion,
        inputClusters: endpoint.inputClusters.slice(0),
        outputClusters: endpoint.outputClusters.slice(0),
        classifierAttributesPopulated: endpoint.classifierAttributesPopulated,
      };
    }
    this.devInfoProperties = cloneDeep(devInfo.properties);

    ZigbeeFamily.identifyFamily(this);
    const devInfoFamilyName = devInfo.family || '';
    const familyName = this.family && this.family.name || '';
    if (devInfoFamilyName != familyName) {
      console.warn('fromDeviceInfo: recorded family:', devInfoFamilyName,
                   'doesn\'t match identified family:', familyName);
    }
  }

  asDict() {
    const dict = super.asDict();
    dict.addr64 = this.addr64;
    dict.addr16 = this.addr16;
    dict.neighbors = this.neighbors;
    dict.activeEndpoints = cloneDeep(this.activeEndpoints);
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

  classify() {
    if (this.family) {
      DEBUG && console.log('classify: Calling family classifier:',
                           this.family.name);
      this.family.classify();
    } else {
      DEBUG && console.log('classify: Calling generic classifier');
      zigbeeClassifier.classify(this);
    }
  }

  debugCmd(cmd, params) {
    console.log('debugCmd:', this.addr64, cmd, params);
    switch (cmd) {

      case 'debug':
        if (params.hasOwnProperty('debugFlow')) {
          console.log('Setting debugFlow to', params.debugFlow);
          this.adapter.debugFlow = params.debugFlow;
        }
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

      case 'devices':
        for (const nodeId in this.adapter.nodes) {
          const node = this.adapter.nodes[nodeId];
          console.log(node.addr64, node.addr16, node.name);
        }
        break;

      case 'discoverAttr':
        this.adapter.discoverAttributes(this);
        break;

      case 'info': {
        let node;
        if (params.addr64) {
          node = this.adapter.nodes[params.addr64];
        } else {
          node = this;
        }
        console.log(node.asDeviceInfo());
        break;
      }

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

  isMainsPowered() {
    return this.powerSource != POWERSOURCE_UNKNOWN &&
           this.powerSource != POWERSOURCE_BATTERY;
  }

  endpointHasZhaInputClusterIdHex(endpoint, clusterIdHex) {
    if (endpoint.profileId == ZHA_PROFILE_ID_HEX ||
        endpoint.profileId == ZLL_PROFILE_ID_HEX) {
      if (endpoint.inputClusters.includes(clusterIdHex)) {
        return true;
      }
    }
    return false;
  }

  findZhaEndpointWithInputClusterIdHex(clusterIdHex) {
    for (const endpointNum in this.activeEndpoints) {
      // Since endpointNum is a key, it comes back as a string
      const endpoint = this.activeEndpoints[endpointNum];
      if (this.endpointHasZhaInputClusterIdHex(endpoint, clusterIdHex)) {
        return parseInt(endpointNum);
      }
    }
  }

  findZhaEndpointWithOutputClusterIdHex(clusterIdHex) {
    for (const endpointNum in this.activeEndpoints) {
      // Since endpointNum is a key, it comes back as a string
      const endpoint = this.activeEndpoints[endpointNum];
      if (endpoint.profileId == ZHA_PROFILE_ID_HEX ||
          endpoint.profileId == ZLL_PROFILE_ID_HEX) {
        if (endpoint.outputClusters.includes(clusterIdHex)) {
          return parseInt(endpointNum);
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
    if (!property.hasOwnProperty('attrId')) {
      return;
    }
    if (Array.isArray(property.attrId)) {
      const attrEntries = [];
      for (const attrId of property.attrId) {
        const attrEntry = this.getAttrEntryFromFrame(frame, attrId);
        if (attrEntry) {
          attrEntries.push(attrEntry);
        }
      }
      return attrEntries;
    }
    return this.getAttrEntryFromFrame(frame, property.attrId);
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

  handleCheckin(frame) {
    const rspFrame = this.makeZclFrame(
      parseInt(frame.sourceEndpoint, 16),
      frame.profileId,
      CLUSTER_ID_GENPOLLCTRL,
      {
        cmd: 'checkinRsp',
        frameCntl: {
          frameType: 1, // checkinRsp is specific to GENPOLLCTRL
          direction: DIR_CLIENT_TO_SERVER,
          disDefaultRsp: 1,
        },
        seqNum: frame.zcl.seqNum,
        payload: {
          startfastpolling: this.rebindRequired ? 1 : 0,
          fastpolltimeout: 120 * 4, // quarter seconds
        },
      }
    );
    this.adapter.sendFrameNow(rspFrame);
    this.rebindIfRequired();
  }

  handleConfigReportRsp(frame) {
    const property = this.findPropertyFromFrame(frame);
    if (property) {
      if (this.reportZclStatusError(frame)) {
        // Some devices, like Hue bulbs, don't support configReports on the
        // ZHA clusters. This means that we need to treat them as
        // 'fire and forget'.

        property.fireAndForget = true;
      }
      property.configReportNeeded = false;
    }
  }

  handleDiscoverRsp(frame) {
    const payload = frame.zcl.payload;
    if (payload.discComplete == 0) {
      // More attributes are available
      const discoverFrame =
        this.makeDiscoverAttributesFrame(
          parseInt(frame.sourceEndpoint, 16),
          frame.profileId,
          frame.clusterId,
          payload.attrInfos.slice(-1)[0].attrId + 1
        );
      this.adapter.sendFrameWaitFrameAtFront(discoverFrame, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'discoverRsp',
        zclSeqNum: discoverFrame.zcl.seqNum,
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
        parseInt(frame.sourceEndpoint, 16),
        frame.profileId,
        clusterId,
        attrInfo.attrId
      );
      this.adapter.sendFrameWaitFrameAtFront(readFrame, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
      });
    }
  }

  handleEnrollReq(reqFrame) {
    // If the cieAddr hasn't been set, then we can wind up receiving an
    // enrollReq, and never receive an endDeviceAnnouncement, so we make sure
    // that the cieAddr gets set.
    this.rebindIasZone();

    const rspStatus = 0;
    const zoneId = 1;
    const enrollRspFrame =
      this.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
    DEBUG && console.log('handleEnrollReq: Queueing up enrollRsp: seqNum =',
                         enrollRspFrame.zcl.seqNum);
    this.adapter.sendFrameNow(enrollRspFrame);
  }

  handleQueryNextImageReq(frame) {
    // For the time being, we always indicate that we have no images.
    const rspFrame = this.makeZclFrame(
      parseInt(frame.sourceEndpoint, 16),
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
    this.adapter.sendFrameNow(rspFrame);
  }

  handleReadRsp(frame) {
    DEBUG && console.log('handleReadRsp node:', this.addr64);

    this.reportZclStatusError(frame);
    if (this.discoveringAttributes && frame.zcl.cmdId === 'readRsp') {
      const clusterId = parseInt(frame.clusterId, 16);
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.status == STATUS_SUCCESS) {
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

    this.handleGenericZclReadRsp(frame);

    if (!this.family) {
      if (frame.zcl.cmdId === 'report') {
        // Xiaomi devices announce themselves using a genBasic report.
        if (ZigbeeFamily.identifyFamily(this)) {
          this.adapter.saveDeviceInfo();
        }
      }
    }

    const property = this.findPropertyFromFrame(frame);
    if (property) {
      // Note: attrEntry might be an array.
      const attrEntry = this.getAttrEntryFromFrameForProperty(frame, property);
      if (!attrEntry) {
        // This can happen for a property associated with the ssIasZone
        // cluster, and a read initiated from a command line tool.
        // We just ignore the readRsp.
        return;
      }
      const [value, logValue] = property.parseAttrEntry(attrEntry);
      property.setCachedValue(value);
      property.initialReadNeeded = false;
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

      if (property.clusterId == CLUSTER_ID_OCCUPANCY_SENSOR &&
          this.occupancyTimeout) {
        if (this.occupancyTimer) {
          // remove any previously created timer
          clearTimeout(this.occupancyTimer);
        }
        // create a new timer
        this.occupancyTimer = setTimeout(() => {
          this.occupancyTimer = null;
          property.setCachedValue(false);
          console.log(this.name,
                      'property:', property.name,
                      'timeout - clearing value');
          this.notifyPropertyChanged(property);
        }, this.occupancyTimeout * 1000);
      }
    }
  }

  handleGenericZclReadRsp(frame) {
    DEBUG && console.log('handleGenericZclReadRsp: clusterId:',
                         frame.clusterId);

    for (const attrEntry of frame.zcl.payload) {
      // readRsp has a status but report doesn't
      if (attrEntry.hasOwnProperty('status') &&
          attrEntry.status != STATUS_SUCCESS) {
        continue;
      }
      switch (frame.clusterId) {
        case CLUSTER_ID_GENBASIC_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID_GENBASIC_ZCLVERSION: // 0
              this.zclVersion = attrEntry.attrData;
              break;
            case ATTR_ID_GENBASIC_APPVERSION: // 1
              this.appVersion = attrEntry.attrData;
              break;
            case ATTR_ID_GENBASIC_MODELID:  // 5
              this.modelId = attrEntry.attrData;
              break;
            case ATTR_ID_GENBASIC_POWERSOURCE:  // 7
              this.powerSource = attrEntry.attrData;
              break;
          }
          break;

        case CLUSTER_ID_SSIASZONE_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID_SSIASZONE_ZONETYPE:
              this.zoneType = attrEntry.attrData;
              break;
            case ATTR_ID_SSIASZONE_ZONESTATUS:
              this.zoneStatus = attrEntry.attrData;
              break;
            case ATTR_ID_SSIASZONE_CIEADDR:
              this.cieAddr = attrEntry.attrData;
              break;
          }
          break;
      }
    }
  }

  handleStatusChangeNotification(frame) {
    const zoneStatus = frame.zcl.payload.zonestatus;
    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    const endpoint = parseInt(frame.sourceEndpoint, 16);

    for (const property of this.properties.values()) {
      if (profileId == property.profileId &&
          endpoint == property.endpoint &&
          clusterId == property.clusterId) {
        const value = ((zoneStatus & property.mask) != 0);
        const prevValue = property.value;
        property.setCachedValue(value);
        // Note: These attributes are unsettable, so there should never
        //       be a deferredSet pending. Since a single status change
        // notification maps onto multiple properties, reporting only
        // the changes reduces the amount of logging.
        if (property.value != prevValue) {
          console.log(this.name,
                      'property:', property.name,
                      'profileId:', utils.hexStr(property.profileId, 4),
                      'endpoint:', property.endpoint,
                      'clusterId:', utils.hexStr(property.clusterId, 4),
                      'value:', value,
                      `zoneStatus: 0x${zoneStatus.toString(16)}`);
          this.notifyPropertyChanged(property);
        }
      }
    }
  }

  handleZhaResponse(frame) {
    DEBUG && console.log('handleZhaResponse: node:', this.addr64);
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
        case 'checkin':
          this.handleCheckin(frame);
          break;
        case 'writeNoRsp':
          // Don't generate a defaultRsp to a writeNoRsp command.
          return;
      }

      // Generate a defaultRsp
      if (frame.zcl.frameCntl.disDefaultRsp == 0 &&
          this.isZclStatusSuccess(frame)) {
        const defaultRspFrame =
          this.makeDefaultRspFrame(frame, STATUS_SUCCESS);
        this.adapter.sendFrameNow(defaultRspFrame);
      }
    }
  }

  rebind() {
    DEBUG && console.log('rebind called for node:', this.addr64,
                         'rebindRequired =', this.rebindRequired);

    this.rebinding = true;

    // Ask for the zclVersion. This is a mandatory attribute for the genBasic
    // cluster. If the device responds, then we'll go through the binding
    // process, otherwise, we'll wait until we get an end-device-announcement
    // (battery powered devices will be sleeping until they wakeup and announce
    // themselves to us.)

    const genBasicEndpointNum =
      this.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENBASIC_HEX);

    if (!genBasicEndpointNum) {
      // If the device doesn't support genBasic, then we don't want to
      // talk to it.
      return;
    }
    const endpoint = this.activeEndpoints[genBasicEndpointNum];
    const readFrame = this.makeReadAttributeFrame(
      genBasicEndpointNum,
      endpoint.profileId,
      CLUSTER_ID_GENBASIC,
      [ATTR_ID_GENBASIC_ZCLVERSION, ATTR_ID_GENBASIC_POWERSOURCE],
    );
    this.adapter.sendFrameWaitFrameAtFront(readFrame, {
      type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
      zclCmdId: 'readRsp',
      zclSeqNum: readFrame.zcl.seqNum,
      callback: this.rebindCallback.bind(this),
      timeoutFunc: () => {
        this.rebinding = false;
      },
    });
  }

  rebindCallback(frame) {
    this.handleGenericZclReadRsp(frame);
    this.extendedTimeout = this.powerSource == POWERSOURCE_BATTERY;

    // Go ahead and do the actual binding.
    let frames = [];
    this.properties.forEach((property) => {
      if (property.configReportNeeded) {
        frames = frames.concat(this.makeConfigReportFrame(property));
      }
      if (property.initialReadNeeded) {
        frames = frames.concat(
          this.makeReadAttributeFrameForProperty(property));
      }
    });
    if (frames.length > 0) {
      this.sendFrames(this.addBindFramesFor(frames));
    }

    this.rebindIasZone();
  }

  rebindIasZone() {
    DEBUG && console.log('rebindIasZone: addr64 =', this.addr64);

    if (!node.ssIasZoneEndpoint) {
      this.rebinding = false;
      return;
    }

    if (!this.hasOwnProperty('cieAddr')) {
      const readFrame = this.makeReadAttributeFrame(
        this.ssIasZoneEndpoint,
        ZHA_PROFILE_ID,
        CLUSTER_ID_SSIASZONE,
        [
          ATTR_ID_SSIASZONE_ZONESTATE,
          ATTR_ID_SSIASZONE_ZONETYPE,
          ATTR_ID_SSIASZONE_ZONESTATUS,
          ATTR_ID_SSIASZONE_CIEADDR,
          ATTR_ID_SSIASZONE_ZONEID,
        ]);
      this.adapter.sendFrameWaitFrameAtFront(readFrame, {
        type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
        callback: this.handleIasReadResponse.bind(this),
        timeoutFunc: () => {
          this.rebinding = false;
        },
      });
      return;
    }

    this.rebindIfRequired();
  }

  handleIasReadResponse(frame) {
    this.handleGenericZclReadRsp(frame);

    if (this.hasOwnProperty('zoneType')) {
      this.adapter.setClassifierAttributesPopulated(this,
                                                    this.ssIasZoneEndpoint);
    }
    const ourCieAddr = `0x${this.adapter.serialNumber}`;
    let commands = [];

    DEBUG && console.log('handleIasReadResponse: this.cieAddr =', this.cieAddr,
                         'ourCieAddr =', ourCieAddr);
    if (this.cieAddr != ourCieAddr) {
      // Tell the sensor to send statusChangeNotifications to us.
      const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
      const writeFrame = this.makeWriteAttributeFrame(
        sourceEndpoint,
        ZHA_PROFILE_ID,
        CLUSTER_ID_SSIASZONE,
        [[ATTR_ID_SSIASZONE_CIEADDR, ourCieAddr]]
      );
      this.cieAddr = ourCieAddr;
      commands = commands.concat(this.adapter.makeFrameWaitFrame(
        writeFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'writeRsp',
          zclSeqNum: writeFrame.zcl.seqNum,
        }
      ));
    }

    // Make sure that the sensor is "enrolled".
    const reqFrame = null;
    const rspStatus = 0;
    const zoneId = 1;
    const enrollRspFrame =
      this.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
    commands = commands.concat(this.adapter.makeFrameWaitFrame(
      enrollRspFrame, {
        type: C.FRAME_TYPE.ZIGBEE_TRANSMIT_STATUS,
        id: enrollRspFrame.id,
      }
    ));

    // Find out what the various poll intervals are.
    const genPollCtrlEndpoint =
      this.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENPOLLCTRL_HEX);
    if (genPollCtrlEndpoint) {
      const readFrame = this.makeReadAttributeFrame(
        genPollCtrlEndpoint,
        ZHA_PROFILE_ID,
        CLUSTER_ID_GENPOLLCTRL,
        [
          ATTR_ID_GENPOLLCTRL_CHECKININTERVAL,
          ATTR_ID_GENPOLLCTRL_LONGPOLLINTERVAL,
          ATTR_ID_GENPOLLCTRL_SHORTPOLLINTERVAL,
          ATTR_ID_GENPOLLCTRL_FASTPOLLINTERVAL,
          ATTR_ID_GENPOLLCTRL_CHECKININTERVALMIN,
          ATTR_ID_GENPOLLCTRL_LONGPOLLINTERVALMIN,
          ATTR_ID_GENPOLLCTRL_FASTPOLLTIMEOUTMAX,
        ]);
      commands = commands.concat(this.adapter.makeFrameWaitFrame(
        readFrame, {
          type: C.FRAME_TYPE.ZIGBEE_EXPLICIT_RX,
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
        }
      ));
    }
    commands = commands.concat(
      this.adapter.makeFuncCommand(this, () => {
        this.rebinding = false;
      }),
      this.adapter.makeFuncCommand(this, this.rebindIfRequired));

    this.adapter.queueCommandsAtFront(commands);
  }

  rebindIfRequired() {
    this.updateRebindRequired();
    DEBUG && console.log('rebindIfRequired: rebindRequired =',
                         this.rebindRequired,
                         'rebinding =', this.rebinding);
    if (this.rebindRequired && !this.rebinding) {
      this.rebind();
    }
  }

  updateRebindRequired() {
    this.rebindRequired = true;

    const ourCieAddr = `0x${this.adapter.serialNumber}`;
    if (this.ssIasEndpoint && this.cieAddr != ourCieAddr) {
      DEBUG && console.log('updateRebindRequired: node:', this.addr64,
                           'cieAddr not set - rebind still required');
      return;
    }

    // We need to be able to break out of the for loop, so don't be tempted
    // to replace the for loop with forEach
    for (const [propertyName, property] of this.properties.entries()) {
      if (property.configReportNeeded) {
        DEBUG && console.log('updateRebindRequired: node:', this.addr64,
                             'property:', propertyName,
                             'configReportNeeded is true -',
                             'rebind still required');
        return;
      }
      if (property.initialReadNeeded) {
        DEBUG && console.log('updateRebindRequired: node:', this.addr64,
                             'property:', propertyName,
                             'initialReadNeeded is true -',
                             'rebind still required');
        return;
      }
    }

    // Since we got to here, it looks like everything is setup and no
    // rebinding is needed.
    this.rebindRequired = false;
    if (this.rebinding) {
      this.adapter.saveDeviceInfo();
    }
    this.rebinding = false;
  }

  makeBindFrame(endpoint, clusterId, configReportFrames) {
    DEBUG && console.log('makeBindFrame: endpoint =', endpoint,
                         'clusterId =', clusterId);
    const frame = this.adapter.zdo.makeFrame({
      destination64: this.addr64,
      destination16: this.addr16,
      clusterId: zdo.CLUSTER_ID.BIND_REQUEST,
      bindSrcAddr64: this.addr64,
      bindSrcEndpoint: endpoint,
      bindClusterId: clusterId,
      bindDstAddrMode: 3,
      bindDstAddr64: this.adapter.serialNumber,
      bindDstEndpoint: 1,
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
            minRepIntval: property.configReport.minRepInterval,
            maxRepIntval: property.configReport.maxRepInterval,
            repChange: property.configReport.repChange,
          };
        }),
      }
    );
    return frame;
  }

  makeDefaultRspFrame(frame, statusCode) {
    // The frame-builder in the xbee-api library expects the source and
    // destination endpoints to be integers, but the frame parser presents
    // the endpoints as hex-strings. So we need to convert them.
    const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
    const destinationEndpoint = parseInt(frame.destinationEndpoint, 16);

    this.zclSeqNum = frame.zcl.seqNum;
    const rspFrame = this.makeZclFrame(
      sourceEndpoint,
      frame.profileId,
      frame.clusterId,
      {
        cmd: 'defaultRsp',
        frameCntl: {
          frameType: 0,
          direction: frame.zcl.frameCntl.direction ? 0 : 1,
          disDefaultRsp: 1,
        },
        payload: {
          cmdId: frame.zcl.cmdId,
          statusCode: statusCode,
        },
      }
    );
    // makeZclFrame normally assumes it's making new frames rather than
    // response frames, so we need to correct the sourceEndpoint.
    rspFrame.sourceEndpoint = destinationEndpoint;
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
    let sourceEndpoint;
    let profileId;
    if (enrollReqFrame) {
      sourceEndpoint = parseInt(enrollReqFrame.sourceEndpoint, 16);
      profileId = enrollReqFrame.profileId;
    } else {
      sourceEndpoint =
        this.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SSIASZONE_HEX);
      profileId = ZHA_PROFILE_ID_HEX;
    }
    const rspFrame = this.makeZclFrame(
      sourceEndpoint,
      profileId,
      CLUSTER_ID_SSIASZONE,
      {
        cmd: 'enrollRsp',
        frameCntl: {
          frameType: 1,   // enrollRsp is specific to the IAS Zone cluster
          direction: DIR_CLIENT_TO_SERVER,
        },
        payload: {
          enrollrspcode: status,
          zoneid: zoneId,
        },
      }
    );
    if (enrollReqFrame) {
      // We're responding to an enrollReq - make sure the enrollRsp has the
      // same sequence number.
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
    assert(typeof endpoint === 'number',
           'makeZclFrame: Expecting endpoint to be a number');

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
    if (!zclData.hasOwnProperty('seqNum')) {
      zclData.seqNum = this.zclSeqNum;
      this.advanceZclSeqNum();
    }

    const frame = {
      id: xbeeApi._frame_builder.nextFrameId(),
      type: C.FRAME_TYPE.EXPLICIT_ADDRESSING_ZIGBEE_COMMAND_FRAME,
      destination64: this.addr64,
      destination16: this.addr16,
      sourceEndpoint: 1,

      destinationEndpoint: endpoint,
      profileId: profileId,
      clusterId: utils.hexStr(clusterId, 4),

      broadcastRadius: 0,
      options: 0,
      zcl: zclData,
    };

    frame.data = zcl.frame(zclData.frameCntl,
                           zclData.manufCode,
                           zclData.seqNum,
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

    this.adapter.saveDeviceInfoDeferred();
  }

  isZclStatusSuccess(frame) {
    // Note: 'report' frames don't have a status
    // Cluster specific commands may or may not have payloads
    // which are arrays, so we only try to iterate if it looks
    // like an array.
    if (Array.isArray(frame.zcl.payload)) {
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.hasOwnProperty('status') &&
            attrEntry.status != STATUS_SUCCESS) {
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
          attrEntry.status != STATUS_SUCCESS) {
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

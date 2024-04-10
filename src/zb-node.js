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
const util = require('util');
const zclId = require('zcl-id');
const zcl = require('zcl-packet');
const zdo = require('zigbee-zdo');
const zigbeeClassifier = require('./zb-classifier');
const ZigbeeFamily = require('./zb-family').default;

const { Device, Event, Utils } = require('gateway-addon');
const {
  ATTR_ID,
  BROADCAST_ADDR,
  CLUSTER_ID,
  DIR,
  DOORLOCK_EVENT_CODES,
  POWERSOURCE,
  PROFILE_ID,
  STATUS,
  UNKNOWN_ADDR_16,
} = require('./zb-constants');

const { DEBUG_node } = require('./zb-debug').default;
const DEBUG = DEBUG_node;

const FAST_CHECKIN_INTERVAL = 20 * 4; // 20 seconds (quarter seconds)
const SLOW_CHECKIN_INTERVAL = 10 * 60 * 4; // 10 min (quarter seconds)

const SKIP_DISCOVER_READ_CLUSTERS = ['haDiagnostic', 'genGreenPowerProxy'];

const DEVICE_INFO_FIELDS = [
  'name',
  'type',
  '@type',
  'defaultName',
  'extendedTimeout',
  'activeEndpointsPopulated',
  'nodeInfoEndpointsPopulated',
  'colorCapabilities',
  'colorMode',
  'zoneType',
  'modelId',
  'appVersion',
  'powerSource',
  'checkinInterval',
  'longPollInterval',
  'shortPollInterval',
  'fastPollTimeout',
  'slowCheckinInterval',
  'pollCtrlBindingNeeded',
  'rxOnWhenIdle',
];

class ZigbeeNode extends Device {
  constructor(adapter, id64, id16) {
    // Our id is a Mac address on the Zigbee network. It's unique within
    // the zigbee network, but might not be globally unique, so we prepend
    // with zb- to put it in a namespace.
    const deviceId = `zb-${id64}`;
    super(adapter, deviceId);

    this.driver = adapter.driver;

    this.addr64 = id64;
    this.addr16 = id16;

    console.log('ZigbeeNode created: addr64:', this.addr64, 'addr16:', this.addr16);

    this.neighbors = [];
    this.activeEndpoints = {};
    this.activeEndpointsPopulated = false;
    this.queryingActiveEndpoints = false;
    this.nodeInfoEndpointsPopulated = false;

    this.isCoordinator = id64 == adapter.networkAddr64;

    if (this.isCoordinator) {
      this.defaultName = `${deviceId}-Dongle`;
    } else {
      this.defaultName = `${deviceId}-Node`;
    }
    this.discoveringAttributes = false;
    this.extendedTimeout = true;
    this.powerSource = POWERSOURCE.UNKNOWN;
    this.added = false;
    this.removed = false;
    this.rebindRequired = true;
    this.zclSeqNum = 1;
    this.classified = false;
  }

  updateAddr16(addr16) {
    if (addr16 && this.addr16 != addr16 && parseInt(addr16, 16) < 0xfffc) {
      console.log('updateAddr16:', this.addr64, 'Updated addr16 from:', this.addr16, 'to:', addr16);
      this.addr16 = addr16;
      const device = this.adapter.devices[this.id];
      if (device) {
        device.addr16 = addr16;
      }
      this.adapter.saveDeviceInfoDeferred();
    }
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
        inputClusters:
          (endpoint.hasOwnProperty('inputClusters') && endpoint.inputClusters.slice(0)) || [],
        outputClusters:
          (endpoint.hasOwnProperty('outputClusters') && endpoint.outputClusters.slice(0)) || [],
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
    const familyName = (this.family && this.family.name) || '';
    if (devInfoFamilyName != familyName) {
      console.warn(
        'fromDeviceInfo: recorded family:',
        devInfoFamilyName,
        // eslint-disable-next-line @typescript-eslint/quotes
        "doesn't match identified family:",
        familyName
      );
    }
  }

  asDict() {
    const dict = super.asDict();
    dict.addr64 = this.addr64;
    dict.addr16 = this.addr16;
    dict.neighbors = this.neighbors;
    dict.activeEndpoints = cloneDeep(this.activeEndpoints);
    dict.isCoordinator = this.isCoordinator;
    dict.rebindRequired = this.rebindRequired;

    for (const field of DEVICE_INFO_FIELDS) {
      if (this.hasOwnProperty(field)) {
        dict[field] = this[field];
      }
    }

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

    // Remove invisible properties from the Thing Description
    // See https://github.com/WebThingsIO/zigbee-adapter/issues/334
    for (const prop of Object.values(dict.properties)) {
      if (prop.hasOwnProperty('visible') && prop.visible === false) {
        delete dict.properties[prop.name];
      }
    }

    return dict;
  }

  classify() {
    if (this.family) {
      DEBUG && console.log('classify: Calling family classifier:', this.family.name);
      this.family.classify();
    } else {
      DEBUG && console.log('classify: Calling generic classifier for:', this.addr64);
      zigbeeClassifier.classify(this);
    }
    this.classified = true;
    if (this.genPollCtrlEndpoint) {
      this.pollCtrlBindingNeeded = true;
    }
  }

  debugCmd(cmd, params) {
    console.log('debugCmd:', this.addr64, this.addr16, cmd, params);
    switch (cmd) {
      case 'bind': {
        let paramMissing = false;
        // Note: We allow attrId to be optional
        for (const p of ['srcEndpoint', 'clusterId']) {
          if (!params.hasOwnProperty(p)) {
            console.error('Missing parameter:', p);
            paramMissing = true;
          }
        }
        if (!paramMissing) {
          if (typeof params.srcEndpoint === 'string') {
            params.srcEndpoint = parseInt(params.srcEndpoint);
          }
          console.error(
            'Issuing bind for endpoint:',
            params.srcEndpoint,
            'clusterId',
            params.clusterId
          );
          const bindFrame = this.makeBindFrame(params.srcEndpoint, params.clusterId);
          this.sendFrames([bindFrame]);
        }
        break;
      }

      case 'bindings': {
        const bindingsFrame = this.makeBindingsFrame(0);
        bindingsFrame.callback = (frame) => {
          const nextIndex = frame.startIndex + frame.numEntriesThisResponse;
          if (nextIndex < frame.numEntries) {
            const nextFrame = this.makeBindingsFrame(nextIndex);
            nextFrame.callback = frame.callback;
            this.sendFrames([nextFrame]);
          }
        };
        this.sendFrames([bindingsFrame]);
        break;
      }

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
          console.log('Setting debugDumpFrameDetail to', params.debugDumpFrameDetail);
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
        if (typeof params.endpoint === 'string') {
          params.endpoint = parseInt(params.endpoint);
        }
        this.adapter.discoverAttributes(this, params.endpoint, params.clusterId);
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
          if (typeof params.endpoint === 'string') {
            params.endpoint = parseInt(params.endpoint);
          }
          if (Array.isArray(params.attrId)) {
            for (const i in params.attrId) {
              if (typeof params.attrId[i] === 'string') {
                // The spec uses hex attributeIds
                params.attrId[i] = parseInt(params.attrId[i], 16);
              }
            }
          }
          console.log(
            'Issuing read attribute for endpoint:',
            params.endpoint,
            'profileId:',
            params.profileId,
            'clusterId',
            params.clusterId,
            'attrId:',
            params.attrId
          );
          this.adapter.readAttribute(
            this,
            params.endpoint,
            params.profileId,
            params.clusterId,
            params.attrId
          );
        }
        break;
      }

      case 'moveToHueAndSaturation': {
        let paramMissing = false;
        // Note: We allow attrId to be optional
        for (const p of ['endpoint', 'hue', 'saturation']) {
          if (!params.hasOwnProperty(p)) {
            console.error('Missing parameter:', p);
            paramMissing = true;
          }
        }
        if (!paramMissing) {
          if (typeof params.endpoint === 'string') {
            params.endpoint = parseInt(params.endpoint);
          }
          console.log(
            'Issuing moveToHueAndSaturation for endpoint:',
            params.endpoint,
            'hue',
            params.hue,
            'saturation:',
            params.saturation
          );
          if (params.hue < 0 || params.hue > 254) {
            console.error('Expecting hue to be 0-254');
            break;
          }
          if (params.saturation < 0 || params.saturation > 254) {
            console.error('Expecting saturation to be 0-254');
            break;
          }
          this.adapter.moveToHueAndSaturation(this, params.endpoint, params.hue, params.saturation);
        }
        break;
      }

      default:
        console.error('Unrecognized debugCmd:', cmd);
    }
  }

  handleDeviceDescriptionUpdated() {
    this.adapter.handleDeviceDescriptionUpdated(this);
  }

  isMainsPowered() {
    // Only take the lower 4 bits, as bit 7 indicates the backup power source
    const ps = this.powerSource & 0x0f;
    return ps != POWERSOURCE.UNKNOWN && ps != POWERSOURCE.DC_SOURCE && ps != POWERSOURCE.BATTERY;
  }

  isBatteryPowered() {
    return this.powerSource == POWERSOURCE.BATTERY;
  }

  endpointHasZhaInputClusterIdHex(endpoint, clusterIdHex) {
    if (endpoint.profileId == PROFILE_ID.ZHA_HEX || endpoint.profileId == PROFILE_ID.ZLL_HEX) {
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

  findZhaEndpointsWithInputClusterIdHex(clusterIdHex) {
    const endpoints = [];
    for (const endpointNum in this.activeEndpoints) {
      // Since endpointNum is a key, it comes back as a string
      const endpoint = this.activeEndpoints[endpointNum];
      if (this.endpointHasZhaInputClusterIdHex(endpoint, clusterIdHex)) {
        endpoints.push(parseInt(endpointNum));
      }
    }
    return endpoints;
  }

  findZhaEndpointWithOutputClusterIdHex(clusterIdHex) {
    const endpoints = [];
    for (const endpointNum in this.activeEndpoints) {
      // Since endpointNum is a key, it comes back as a string
      const endpoint = this.activeEndpoints[endpointNum];
      if (endpoint.profileId == PROFILE_ID.ZHA_HEX || endpoint.profileId == PROFILE_ID.ZLL_HEX) {
        if (endpoint.outputClusters.includes(clusterIdHex)) {
          endpoints.push(parseInt(endpointNum));
        }
      }
    }
    return endpoints;
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
    if (frame.clusterId == CLUSTER_ID.SSIASZONE_HEX) {
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
      if (
        profileId == property.profileId &&
        endpoint == property.endpoint &&
        clusterId == property.clusterId
      ) {
        if (this.frameHasAttr(frame, property)) {
          return property;
        }
      }
    }
  }

  findPropertiesByAttrId(profileId, clusterId, endpoint, attrId) {
    // Remember that a property can have multiple attrIds
    // (i.e. attrId is an array).
    return Array.from(this.properties.values()).filter(
      (property) =>
        profileId == property.profileId &&
        endpoint == property.endpoint &&
        clusterId == property.clusterId &&
        (attrId == property.attrId ||
          (Array.isArray(property.attrId) && property.attrId.includes(attrId)))
    );
  }

  handleCheckin(frame) {
    if (this.adapter.scanning) {
      if (this.adapter.debugFlow) {
        console.log('Ignoring checkin - scanning in progress');
      }
      return;
    }

    if (this.adapter.driver.cmdQueue.length == 0) {
      // This is a bit of a hack, but is needed until I rewrite the
      // whole binding/configReport/initialRead to be able to work
      // incrementally. The fact that the command queue is empty
      // means that we're no longer rebinding since everything has
      // either been sent or timed out.
      this.rebinding = false;
    }

    const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
    this.genPollCtrlEndpoint = sourceEndpoint;
    const rspFrame = this.makeZclFrame(sourceEndpoint, frame.profileId, CLUSTER_ID.GENPOLLCTRL, {
      cmd: 'checkinRsp',
      frameCntl: {
        frameType: 1, // checkinRsp is specific to GENPOLLCTRL
        direction: DIR.CLIENT_TO_SERVER,
        disDefaultRsp: 1,
      },
      seqNum: frame.zcl.seqNum,
      payload: {
        startfastpolling: this.rebindRequired ? 1 : 0,
        fastpolltimeout: 20 * 4, // quarter seconds
      },
    });
    this.writeCheckinInterval();
    this.adapter.sendFrameNow(rspFrame);
    this.rebindIfRequired();
  }

  handleConfigReportRsp(frame) {
    this.reportZclStatusError(frame);

    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    const endpoint = parseInt(frame.sourceEndpoint, 16);

    for (const attrIdx in frame.extraParams) {
      const attrId = frame.extraParams[attrIdx];
      const properties = this.findPropertiesByAttrId(profileId, clusterId, endpoint, attrId);
      if (properties.length > 0) {
        for (const property of properties) {
          // If the configReport was successful, then only a single status
          // is returned and no attrId's are included.
          const status =
            frame.extraParams.length == frame.zcl.payload.length
              ? frame.zcl.payload[attrIdx].status
              : frame.zcl.payload[0].status;
          if (status != STATUS.SUCCESS && status != STATUS.INSUFFICIENT_SPACE) {
            // If the device doesn't support configReports, then treat it as
            // 'fire and forget'.
            //
            // Insufficient space means we're trying to configure reporting
            // on too many attributes, which is more of a classifier issue
            // so we don't set fireAndForget in that case because it gets
            // persisted.
            console.error(this.addr64, 'configReport failed - setting fireAndForget to true');
            property.fireAndForget = true;
          }
          property.configReportNeeded = false;
        }
      } else {
        console.log(
          '##### handleConfigReportRsp:',
          'Property not found for attrId:',
          attrId,
          'frame:'
        );
        console.log(util.inspect(frame, { depth: null }));
      }
    }
  }

  handleDiscoverRsp(frame) {
    const payload = frame.zcl.payload;
    if (payload.discComplete == 0) {
      // More attributes are available
      const discoverFrame = this.makeDiscoverAttributesFrame(
        parseInt(frame.sourceEndpoint, 16),
        frame.profileId,
        frame.clusterId,
        payload.attrInfos.slice(-1)[0].attrId + 1
      );
      this.adapter.sendFrameWaitFrameAtFront(discoverFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'discoverRsp',
        zclSeqNum: discoverFrame.zcl.seqNum,
        waitRetryMax: 1,
        waitRetryTimeout: 1000,
      });
    }

    const clusterId = parseInt(frame.clusterId, 16);
    const cluster = zclId.cluster(clusterId);
    const clusterIdStr = cluster ? cluster.key : 'unknown';
    let attrInfo;
    if (SKIP_DISCOVER_READ_CLUSTERS.includes(clusterIdStr)) {
      // This is a cluster which dosen't seem to respond to read requests.
      // Just print the attributes.
      for (attrInfo of payload.attrInfos) {
        const attr = zclId.attr(clusterId, attrInfo.attrId);
        const attrStr = attr ? attr.key : 'unknown';
        const dataType = zclId.dataType(attrInfo.dataType);
        const dataTypeStr = dataType ? dataType.key : 'unknown';
        console.log(
          '      AttrId:',
          `${attrStr} (${attrInfo.attrId})`,
          'dataType:',
          `${dataTypeStr} (${attrInfo.dataType})`
        );
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
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
        waitRetryMax: 1,
        waitRetryTimeout: 1000,
      });
    }
  }

  handleEnrollReq(reqFrame) {
    this.zoneType = reqFrame.zcl.payload.zonetype;

    // If the cieAddr hasn't been set, then we can wind up receiving an
    // enrollReq, and never receive an endDeviceAnnouncement, so we make sure
    // that the cieAddr gets set.
    this.rebindIasZone();

    const rspStatus = 0;
    const zoneId = 1;
    const enrollRspFrame = this.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
    DEBUG &&
      console.log('handleEnrollReq: Queueing up enrollRsp: seqNum =', enrollRspFrame.zcl.seqNum);
    this.adapter.sendFrameNow(enrollRspFrame);
  }

  handleQueryNextImageReq(frame) {
    if (!this.adapter.scanning) {
      this.adapter.populateNodeInfo(this);
    }

    // For the time being, we always indicate that we have no OTA images
    const rspFrame = this.makeZclFrame(
      parseInt(frame.sourceEndpoint, 16),
      frame.profileId,
      CLUSTER_ID.GENOTA,
      {
        cmd: 'queryNextImageRsp',
        frameCntl: {
          frameType: 1, // queryNextImageRsp is specific to genOta
          direction: DIR.SERVER_TO_CLIENT,
          disDefaultRsp: 1,
        },
        seqNum: frame.zcl.seqNum,
        payload: {
          status: zclId.status('noImageAvailable').value,
        },
      }
    );
    rspFrame.sourceEndpoint = parseInt(frame.destinationEndpoint, 16);
    DEBUG &&
      console.log('handleQueryNextImageReq: rspFrame =', util.inspect(frame, { depth: null }));
    this.adapter.sendFrameNow(rspFrame);
  }

  handleReadRsp(frame) {
    DEBUG &&
      console.log(
        'handleReadRsp node:',
        this.addr64,
        'discoveringAttributes',
        this.discoveringAttributes
      );

    if (this.adapter.scanning && frame.zcl.cmdId === 'report') {
      if (this.adapter.debugFlow) {
        console.log('Ignoring report - scanning in progress');
      }
      return;
    }

    this.reportZclStatusError(frame);
    if (this.discoveringAttributes && frame.zcl.cmdId === 'readRsp') {
      const clusterId = parseInt(frame.clusterId, 16);
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.status == STATUS.SUCCESS) {
          const attr = zclId.attr(clusterId, attrEntry.attrId);
          const attrStr = attr ? attr.key : 'unknown';
          const dataType = zclId.dataType(attrEntry.dataType);
          const dataTypeStr = dataType ? dataType.key : 'unknown';
          console.log(
            'discover:       AttrId:',
            `${attrStr} ( ${attrEntry.attrId})`,
            'dataType:',
            `${dataTypeStr} (${attrEntry.dataType})`,
            'data:',
            attrEntry.attrData
          );
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

    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    const endpoint = parseInt(frame.sourceEndpoint, 16);
    let propertyFound = false;

    for (const attrEntry of frame.zcl.payload) {
      const properties = this.findPropertiesByAttrId(
        profileId,
        clusterId,
        endpoint,
        attrEntry.attrId
      );
      if (properties.length > 0) {
        for (const property of properties) {
          propertyFound = true;
          // readRsp has a status but report doesn't
          if (attrEntry.hasOwnProperty('status')) {
            switch (attrEntry.status) {
              case STATUS.SUCCESS:
                break;
              case STATUS.UNSUPPORTED_ATTRIB:
                property.fireAndForget = true;
                if (property.hasOwnProperty('defaultValue')) {
                  attrEntry.dataType = zclId.attrType(clusterId, attrEntry.attrId).value;
                  attrEntry.attrData = property.defaultValue;
                  break;
                }
                break;
              default:
                continue;
            }
          }

          const [value, logValue] = property.parseAttrEntry(attrEntry);
          if (typeof value === 'undefined') {
            continue;
          }
          property.setCachedValue(value);
          property.initialReadNeeded = false;

          console.log(
            this.name,
            'property:',
            property.name,
            'profileId:',
            Utils.hexStr(property.profileId, 4),
            'endpoint:',
            property.endpoint,
            'clusterId:',
            Utils.hexStr(property.clusterId, 4),
            frame.zcl.cmdId,
            'value:',
            logValue
          );
          const deferredSet = property.deferredSet;
          if (deferredSet) {
            property.deferredSet = null;
            deferredSet.resolve(property.value);
          }
          this.notifyPropertyChanged(property);

          if (property.clusterId == CLUSTER_ID.OCCUPANCY_SENSOR && this.occupancyTimeout) {
            if (this.occupancyTimer) {
              // remove any previously created timer
              clearTimeout(this.occupancyTimer);
            }
            // create a new timer
            this.occupancyTimer = setTimeout(() => {
              this.occupancyTimer = null;
              property.setCachedValue(false);
              console.log(this.name, 'property:', property.name, 'timeout - clearing value');
              this.notifyPropertyChanged(property);
            }, this.occupancyTimeout * 1000);
          }
        }
      }
    }
    if (
      !propertyFound &&
      frame.clusterId != CLUSTER_ID.GENBASIC_HEX &&
      frame.clusterId != CLUSTER_ID.SSIASZONE_HEX &&
      frame.clusterId != CLUSTER_ID.GENPOLLCTRL_HEX
    ) {
      console.log(
        'handleReadRsp: ##### No property found for frame #####',
        this.name,
        'remote64:',
        frame.remote64,
        'profileId:',
        frame.profileId,
        'clusterId:',
        frame.clusterId,
        'sourceEndpoint:',
        frame.sourceEndpoint,
        'cmdId:',
        frame.zcl.cmdId,
        'payload:',
        JSON.stringify(frame.zcl.payload)
      );
    }
    if (frame.zcl.cmdId === 'report') {
      this.rebindIfRequired();
    }
  }

  handleGenericZclReadRsp(frame) {
    DEBUG && console.log('handleGenericZclReadRsp: clusterId:', frame.clusterId);

    for (const attrEntry of frame.zcl.payload) {
      // readRsp has a status but report doesn't
      if (attrEntry.hasOwnProperty('status') && attrEntry.status != STATUS.SUCCESS) {
        if (
          frame.clusterId == CLUSTER_ID.GENBASIC_HEX &&
          attrEntry.attrId == ATTR_ID.GENBASIC.MODELID
        ) {
          // We need the modelId to be set, even if it is an unsupported
          // attribute. The default nrf52840 zigbee devices don't
          // support the modelId, so doing this prevents an infinite loop
          // trying to retrieve the modelId.
          this.modelId = '';
        }
        continue;
      }
      switch (frame.clusterId) {
        case CLUSTER_ID.GENBASIC_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID.GENBASIC.ZCLVERSION: // 0
              this.zclVersion = attrEntry.attrData;
              break;
            case ATTR_ID.GENBASIC.APPVERSION: // 1
              this.appVersion = attrEntry.attrData;
              break;
            case ATTR_ID.GENBASIC.MODELID: // 5
              this.modelId = attrEntry.attrData;
              break;
            case ATTR_ID.GENBASIC.POWERSOURCE: // 7
              this.powerSource = attrEntry.attrData;
              break;
          }
          break;

        case CLUSTER_ID.GENPOLLCTRL_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID.GENPOLLCTRL.CHECKININTERVAL:
              this.checkinInterval = attrEntry.attrData;
              break;
            case ATTR_ID.GENPOLLCTRL.LONGPOLLINTERVAL:
              this.longPollInterval = attrEntry.attrData;
              break;
            case ATTR_ID.GENPOLLCTRL.SHORTPOLLINTERVAL:
              this.shortPollInterval = attrEntry.attrData;
              break;
            case ATTR_ID.GENPOLLCTRL.FASTPOLLTIMEOUT:
              this.fastPollTimeout = attrEntry.attrData;
              break;
          }
          break;

        case CLUSTER_ID.LIGHTINGCOLORCTRL_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID.LIGHTINGCOLORCTRL.COLORCAPABILITIES:
              this.colorCapabilities = attrEntry.attrData;
              console.log('Stored colorCapabilities:', this.colorCapabilities);
              break;
            case ATTR_ID.LIGHTINGCOLORCTRL.COLORMODE:
              this.colorMode = attrEntry.attrData;
              console.log('Stored colorMode:', this.colorMode);
              break;
          }
          break;

        case CLUSTER_ID.SSIASZONE_HEX:
          switch (attrEntry.attrId) {
            case ATTR_ID.SSIASZONE.ZONESTATE:
              this.zoneState = attrEntry.attrData;
              break;
            case ATTR_ID.SSIASZONE.ZONETYPE:
              this.zoneType = attrEntry.attrData;
              break;
            case ATTR_ID.SSIASZONE.ZONESTATUS:
              this.zoneStatus = attrEntry.attrData;
              break;
            case ATTR_ID.SSIASZONE.IASCIEADDR:
              this.cieAddr = attrEntry.attrData;
              break;
            case ATTR_ID.SSIASZONE.ZONEID:
              this.zoneId = attrEntry.attrData;
              break;
          }
          break;
      }
    }
  }

  handleButtonCommand(frame) {
    const endpoint = parseInt(frame.sourceEndpoint, 16);
    DEBUG &&
      console.log(
        'handleButtonCommand:',
        this.addr64,
        `EP:${endpoint} CL:${frame.clusterId}`,
        `cmd:${frame.zcl.cmdId}`
      );
    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    let propertyFound = false;
    for (const property of this.properties.values()) {
      if (
        profileId == property.profileId &&
        endpoint == property.endpoint &&
        clusterId == property.clusterId
      ) {
        propertyFound = true;
        switch (frame.zcl.cmdId) {
          case 'on': // on property
            this.handleButtonOnOffCommand(property, true);
            this.notifyEvent(`${property.buttonIndex}-pressed`);
            break;
          case 'onWithTimedOff': // on property
            this.handleButtonOnOffCommand(property, true);
            this.notifyEvent('motion');
            this.occupancyTimeout = frame.zcl.payload.ontime / 10;
            if (this.occupancyTimer) {
              // remove any previously created timer
              clearTimeout(this.occupancyTimer);
            }
            // create a new timer
            DEBUG && console.log('Creating a timer for', this.occupancyTimeout, 'seconds');
            this.occupancyTimer = setTimeout(() => {
              this.occupancyTimer = null;
              property.setCachedValue(false);
              console.log(this.name, 'property:', property.name, 'timeout - clearing value');
              this.notifyPropertyChanged(property);
              this.notifyEvent('no-motion');
            }, this.occupancyTimeout * 1000);
            break;
          case 'off': // on property
          case 'offWithEffect': // onProperty
            this.handleButtonOnOffCommand(property, false);
            this.notifyEvent(`${property.buttonIndex + 1}-pressed`);
            break;
          case 'toggle': // onproperty
            this.handleButtonOnOffCommand(property, !property.value);
            this.notifyEvent(`${property.buttonIndex}-pressed`);
            break;
          case 'moveWithOnOff': {
            // level property
            this.handleButtonMoveWithOnOffCommand(
              property,
              frame.zcl.payload.movemode,
              frame.zcl.payload.rate
            );
            // movemode 0 = up, 1 = down. So we just add 1 to the movemode
            // to get a button number.
            const button = property.buttonIndex + frame.zcl.payload.movemode;
            this.heldButton = button;
            this.notifyEvent(`${button}-longPressed`);
            return;
          }
          case 'moveToLevelWithOnOff': {
            // level / scene property
            this.handleButtonMoveToLevelWithOnOffCommand(
              property,
              frame.zcl.payload.level,
              frame.zcl.payload.transtime
            );

            const button = property.buttonIndex + frame.zcl.payload.level;
            this.notifyEvent(`${button}-pressed`);
            return;
          }
          case 'move': {
            // level/scene property
            this.handleButtonMoveCommand(
              property,
              frame.zcl.payload.movemode,
              frame.zcl.payload.rate,
              false
            );
            // movemode 0 = up, 1 = down. So we just add 1 to the movemode
            // to get a button number.
            const button = property.buttonIndex + frame.zcl.payload.movemode;
            this.heldButton = button;
            this.notifyEvent(`${button}-longPressed`);
            return;
          }
          case 'stepWithOnOff': {
            // level/scene property
            this.handleButtonStepWithOnOffCommand(
              property,
              frame.zcl.payload.stepmode,
              frame.zcl.payload.stepsize
            );
            const button = property.buttonIndex + frame.zcl.payload.stepmode;
            this.notifyEvent(`${button}-pressed`);
            return;
          }
          case 'step': {
            // level/scene property
            this.handleButtonStepCommand(
              property,
              frame.zcl.payload.stepmode,
              frame.zcl.payload.stepsize
            );
            const button = property.buttonIndex + frame.zcl.payload.stepmode;
            this.notifyEvent(`${button}-pressed`);
            return;
          }
          case 'stop':
          case 'stopWithOnOff': // level/scene property
            this.handleButtonStopCommand(property);
            if (this.heldButton) {
              this.notifyEvent(`${this.heldButton}-released`);
              this.heldButton = null;
            }
            return;
        }
      }
    }
    if (!propertyFound) {
      DEBUG &&
        console.log(
          'handleButtonCommand: no property found for:',
          'profileId:',
          profileId,
          'endpoint:',
          endpoint,
          'clusterId:',
          clusterId
        );
    }
  }

  handleButtonOnOffCommand(property, newValue) {
    DEBUG &&
      console.log(
        'handleButtonOnOffCommmand:',
        this.addr64,
        'property:',
        property.name,
        'value:',
        newValue
      );
    if (newValue == property.value) {
      // Already at desired value, nothing else to do
      return;
    }
    property.setCachedValue(newValue);
    this.notifyPropertyChanged(property);
  }

  handleButtonMoveWithOnOffCommand(property, moveMode, rate) {
    DEBUG &&
      console.log(
        'handleButtonMoveWithOnOffCommand:',
        this.addr64,
        'property:',
        property.name,
        'moveMode:',
        moveMode,
        'rate:',
        rate
      );
    if (this.onOffProperty && !this.onOffProperty.value) {
      // onOff Property was off - turn it on
      this.handleButtonOnOffCommand(this.onOffProperty, true);
    }
    this.handleButtonMoveCommand(property, moveMode, rate, true);
    // implies turn off if level reaches zero
  }

  handleButtonMoveToLevelWithOnOffCommand(property, level, rate) {
    DEBUG &&
      console.log(
        'handleButtonMoveToLevelWithOnOffCommand:',
        this.addr64,
        'property:',
        property.name,
        'level:',
        level,
        'rate:',
        rate
      );

    if (this.onOffProperty && !this.onOffProperty.value) {
      // onOff Property was off - turn it on
      this.handleButtonOnOffCommand(this.onOffProperty, true);
    }

    property.setCachedValue(level);
    this.notifyPropertyChanged(property);

    // TODO: handle this properly as move property.
    // let moveMode = property.value > level; // Move down if new value is lower
    // this.handleButtonMoveCommand(property, moveMode, rate, false);
  }

  handleButtonMoveCommand(property, moveMode, rate, offAtZero) {
    DEBUG &&
      console.log(
        'handleButtonMoveCommand:',
        this.addr64,
        'property:',
        property.name,
        'moveMode:',
        moveMode,
        'rate:',
        rate,
        'offAtZero:',
        offAtZero
      );
    // moveMode: 0 = up, 1 = down
    // rate: units/second

    if (property.moveTimer) {
      // There's already a timer running.
      return;
    }

    const updatesPerSecond = 4;
    const delta = ((moveMode ? -1 : 1) * rate) / updatesPerSecond;

    this.moveTimerCallback(property, delta, offAtZero);
    if (
      (property.value > property.minimum && delta < 0) ||
      (property.value < property.maximum && delta > 0)
    ) {
      // We haven't hit the end, setup a timer to move towards it.
      property.moveTimer = setInterval(
        this.moveTimerCallback.bind(this),
        1000 / updatesPerSecond,
        property,
        delta,
        offAtZero
      );
    }
  }

  moveTimerCallback(property, delta, offAtZero) {
    let newValue = Math.round(property.value + delta);
    newValue = Math.max(property.minimum, newValue);
    newValue = Math.min(property.maximum, newValue);

    DEBUG &&
      console.log(
        'moveTimerCallback:',
        this.addr64,
        'property:',
        property.name,
        'value:',
        property.value,
        'delta:',
        delta,
        'newValue:',
        newValue,
        'offAtZero:',
        offAtZero
      );

    // Cancel the timer if we don't need it any more.
    if (
      newValue == property.value ||
      (newValue == property.minimum && delta < 0) ||
      (newValue == property.maximum && delta > 0)
    ) {
      this.handleButtonStopCommand(property);
    }

    // Update the value, if it changed
    if (newValue != property.value) {
      property.setCachedValue(newValue);
      this.notifyPropertyChanged(property);
    }

    // Turn it off, if instructed and we hit zero
    if (offAtZero && property.value == 0 && this.onOffProperty) {
      this.handleButtonOnOffCommand(this.onOffProperty, false);
    }
  }

  handleButtonStepWithOnOffCommand(property, stepMode, stepSize) {
    DEBUG &&
      console.log(
        'handleButtonStepWithOnOffCommand:',
        this.addr64,
        'property:',
        property.name,
        'moveMode:',
        stepMode,
        'stepSize:',
        stepSize
      );
    if (this.onOffProperty && !this.onOffProperty.value) {
      // onOff Property was off - turn it on
      this.handleButtonOnOffCommand(this.onOffProperty, true);
    }
    this.handleButtonStepCommand(property, stepMode, stepSize);
    // implies turn off if level reaches zero
  }

  handleButtonStepCommand(property, stepMode, stepSize) {
    DEBUG &&
      console.log(
        'handleButtonStepCommand:',
        this.addr64,
        'property:',
        property.name,
        'stepeMode:',
        stepMode
      );
    // stepMode: 0 = up, 1 = down
    const delta = (stepMode ? -1 : 1) * stepSize;
    let newValue = Math.round(property.value + delta);
    newValue = Math.max(property.minimum, newValue);
    newValue = Math.min(property.maximum, newValue);

    // Update the value, if it changed
    if (newValue != property.value) {
      property.setCachedValue(newValue);
      this.notifyPropertyChanged(property);
    }
  }

  handleButtonStopCommand(property) {
    DEBUG && console.log('handleButtonStopCommand:', this.addr64, 'property:', property.name);
    if (property.moveTimer) {
      clearInterval(property.moveTimer);
      property.moveTimer = null;
    }
  }

  handleDoorLockEvent(frame) {
    const payload = frame.zcl.payload;

    const eventSrcStrs = ['Keypad', 'RF', 'Manual', 'RFID', 'Unknown'];
    const eventSrc = Math.min(eventSrcStrs.length - 1, payload.opereventsrc);
    const eventSrcStr = eventSrcStrs[eventSrc];

    let eventCode = payload.opereventcode;
    if (eventCode >= DOORLOCK_EVENT_CODES.length) {
      eventCode = 0;
    }
    const eventCodeStr = DOORLOCK_EVENT_CODES[eventCode];

    this.notifyEvent(eventCodeStr, {
      code: payload.opereventcode,
      source: payload.opereventsrc,
      sourceStr: eventSrcStr,
      userId: payload.userid,
    });
  }

  handleStatusChangeNotification(frame) {
    const zoneStatus = frame.zcl.payload.zonestatus;
    const profileId = parseInt(frame.profileId, 16);
    const clusterId = parseInt(frame.clusterId, 16);
    const endpoint = parseInt(frame.sourceEndpoint, 16);

    if (this.zoneType == 0x8000) {
      // Samsung button - this is event based and doesn't have any
      // properties.

      // Note: It would make sense for a zoneStatus of 0 to correspond
      // to 'released', but so far, I've not seen the button generate
      // such a zone status.
      const events = ['released', 'pressed', 'doublePressed', 'longPressed'];
      this.notifyEvent(events[zoneStatus & 3]);

      // Even though the notification doesn't disable the defaultRsp,
      // I've always seen a transmit status error if we try send one,
      // so we don't bother.
      frame.zcl.frameCntl.disDefaultRsp = 1;
      return;
    }

    for (const property of this.properties.values()) {
      if (
        profileId == property.profileId &&
        endpoint == property.endpoint &&
        clusterId == property.clusterId
      ) {
        const value = (zoneStatus & property.mask) != 0;
        const prevValue = property.value;
        property.setCachedValue(value);
        // Note: These attributes are unsettable, so there should never
        //       be a deferredSet pending. Since a single status change
        // notification maps onto multiple properties, reporting only
        // the changes reduces the amount of logging.
        if (property.value != prevValue) {
          console.log(
            this.name,
            'property:',
            property.name,
            'profileId:',
            Utils.hexStr(property.profileId, 4),
            'endpoint:',
            property.endpoint,
            'clusterId:',
            Utils.hexStr(property.clusterId, 4),
            'value:',
            value,
            `zoneStatus: 0x${zoneStatus.toString(16)}`
          );
          this.notifyPropertyChanged(property);
        }
      }
    }
    if (frame.zcl.frameCntl.disDefaultRsp == 0) {
      if (!this.adapter.scanning) {
        this.adapter.populateNodeInfo(this);
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
        case 'operationEventNotification': // door lock event
          this.handleDoorLockEvent(frame);
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
        case 'on':
        case 'onWithTimedOff':
        case 'off':
        case 'offWithEffect':
        case 'moveWithOnOff':
        case 'moveToLevelWithOnOff':
        case 'move':
        case 'stepWithOnOff':
        case 'step':
        case 'stopWithOnOff':
        case 'stop':
        case 'toggle':
          this.handleButtonCommand(frame);
          break;
        case 'writeNoRsp':
          // Don't generate a defaultRsp to a writeNoRsp command.
          return;
      }

      // Generate a defaultRsp
      if (frame.zcl.frameCntl.disDefaultRsp == 0 && this.isZclStatusSuccess(frame)) {
        const defaultRspFrame = this.makeDefaultRspFrame(frame, STATUS.SUCCESS);
        this.adapter.sendFrameNow(defaultRspFrame);
      }
    }
  }

  rebind() {
    if (this.rebinding) {
      DEBUG && console.log('rebind:', this.addr64, 'exiting due to rebind already in progress');
      return;
    }

    DEBUG &&
      console.log(
        'rebind called for node:',
        this.addr64,
        this.addr16,
        'rebindRequired =',
        this.rebindRequired,
        'pollCtrlBindingNeeded =',
        this.pollCtrlBindingNeeded
      );

    if (typeof this.addr16 === 'undefined') {
      DEBUG && console.log('rebind: Requesting 16-bit address for', this.addr64);
      this.rebinding = true;
      const updateFrame = this.adapter.zdo.makeFrame({
        // Send the network address request to all routers. This way the
        // parent will respond if it's a sleeping end device.
        destination64: this.addr64,
        destination16: BROADCAST_ADDR.ROUTERS,
        clusterId: zdo.CLUSTER_ID.NETWORK_ADDRESS_REQUEST,
        addr64: this.addr64,
        requestType: 0, // 0 = Single Device Response
        startIndex: 0,
        options: 0,
        callback: (_frame) => {
          this.rebinding = false;
          this.rebind();
        },
        timeoutFunc: () => {
          this.rebinding = false;
        },
      });
      this.adapter.sendFrameWaitFrameAtFront(updateFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zdoSeq: updateFrame.zdoSeq,
        waitRetryMax: 1,
      });
      return;
    }

    if (this.genPollCtrlEndpoint && this.pollCtrlBindingNeeded) {
      if (this.writingCheckinInterval) {
        DEBUG && console.log('rebind: exiting - writeCheckinInterval already in progress');
        return;
      }

      // We need to bind the poll control endpoint in order to receive
      // checkin reports.
      this.rebinding = true;
      const bindFrame = this.makeBindFrame(this.genPollCtrlEndpoint, CLUSTER_ID.GENPOLLCTRL_HEX);
      bindFrame.callback = () => {
        this.rebinding = false;
        this.writeCheckinInterval(FAST_CHECKIN_INTERVAL);
      };
      bindFrame.timeoutFunc = () => {
        this.rebinding = false;
      };
      this.sendFrames([bindFrame]);
      return;
    }

    // Do configurations necessary for security sensors.
    this.rebindIasZone();

    for (const property of this.properties.values()) {
      DEBUG &&
        console.log(
          'rebind:   property:',
          property.name,
          'bindNeeded:',
          property.bindNeeded,
          'configReportNeeded:',
          property.configReportNeeded,
          'initialReadNeeded:',
          property.initialReadNeeded
        );
      if (property.bindNeeded) {
        this.rebinding = true;
        const bindFrame = this.makeBindFrame(property.endpoint, property.clusterId);
        bindFrame.callback = (_frame) => {
          DEBUG &&
            console.log(
              'rebind:   bind response for property:',
              property.name,
              `EP:${property.endpoint}`,
              `CL:${Utils.hexStr(property.clusterId, 4)}`
            );
          this.rebinding = false;
          property.bindNeeded = false;
          // We only need to bind per endpoint/cluster. Since we've
          // just successfully done a bind, mark any remaining
          // matching bind requests as being unnecessary.
          this.properties.forEach((p) => {
            if (p.endpoint == property.endpoint && p.clusterId == property.clusterId) {
              p.bindNeeded = false;
            }
          });
          this.rebind();
        };
        bindFrame.timeoutFunc = () => {
          this.rebinding = false;
        };
        this.sendFrames([bindFrame]);
        return;
      }

      if (property.configReportNeeded) {
        this.rebinding = true;
        const configFrame = this.makeConfigReportFrame(property);
        configFrame.callback = (_frame) => {
          DEBUG &&
            console.log(
              'rebind:   configReportRsp for property:',
              property.name,
              `EP:${property.endpoint}`,
              `CL:${Utils.hexStr(property.clusterId, 4)}`
            );
          this.rebinding = false;
          property.configReportNeeded = false;
          this.rebind();
        };
        configFrame.timeoutFunc = () => {
          this.rebinding = false;
        };
        this.sendFrames([configFrame]);
        return;
      }

      if (property.initialReadNeeded) {
        this.rebinding = true;
        const readFrame = this.makeReadAttributeFrameForProperty(property);
        readFrame.callback = (_frame) => {
          DEBUG &&
            console.log(
              'rebind:   readRsp for property:',
              property.name,
              `EP:${property.endpoint}`,
              `CL:${Utils.hexStr(property.clusterId, 4)}`
            );
          this.rebinding = false;
          property.initialReadNeeded = false;
          this.rebind();
        };
        readFrame.timeoutFunc = () => {
          this.rebinding = false;
        };
        this.sendFrames([readFrame]);
        return;
      }
    }
  }

  rebindIasZone() {
    // ssIasZoneEndpoint is set by the classifier
    if (!this.ssIasZoneEndpoint) {
      DEBUG &&
        console.log('rebindIasZone: addr64:', this.addr64, 'not a security sensor - exiting');
      // no ssIasZoneEndpoint, so this isn't a security sensor. Nothing
      // else to do in this function.
      return;
    }
    DEBUG && console.log('rebindIasZone: addr64:', this.addr64);

    if (!this.hasOwnProperty('cieAddr') || !this.hasOwnProperty('zoneState')) {
      DEBUG && console.log('rebindIasZone: querying attributes');
      this.rebinding = true;
      const readFrame = this.makeReadAttributeFrame(
        this.ssIasZoneEndpoint,
        PROFILE_ID.ZHA,
        CLUSTER_ID.SSIASZONE,
        [
          ATTR_ID.SSIASZONE.ZONESTATE,
          ATTR_ID.SSIASZONE.ZONETYPE,
          ATTR_ID.SSIASZONE.ZONESTATUS,
          ATTR_ID.SSIASZONE.IASCIEADDR,
          ATTR_ID.SSIASZONE.ZONEID,
        ]
      );
      this.adapter.sendFrameWaitFrameAtFront(readFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
        callback: () => {
          this.rebinding = false;
          this.rebindIasZone();
        },
        timeoutFunc: () => {
          this.rebinding = false;
        },
      });
      return;
    }

    if (this.hasOwnProperty('zoneType')) {
      this.rebinding = true; // prevent recursion
      this.adapter.setClassifierAttributesPopulated(this, this.ssIasZoneEndpoint);
      this.rebinding = false;
    }
    const ourCieAddr = `0x${this.adapter.networkAddr64}`;

    DEBUG && console.log('rebindIasZone: this.cieAddr =', this.cieAddr, 'ourCieAddr =', ourCieAddr);
    if (this.cieAddr != ourCieAddr) {
      // Tell the sensor to send statusChangeNotifications to us.
      DEBUG && console.log('rebindIasZone: setting iasCieAddr');
      this.rebinding = true;
      const writeFrame = this.makeWriteAttributeFrame(
        this.ssIasZoneEndpoint,
        PROFILE_ID.ZHA,
        CLUSTER_ID.SSIASZONE,
        [[ATTR_ID.SSIASZONE.IASCIEADDR, ourCieAddr]]
      );
      this.adapter.sendFrameWaitFrameAtFront(writeFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'writeRsp',
        zclSeqNum: writeFrame.zcl.seqNum,
        callback: () => {
          this.rebinding = false;
          this.cieAddr = ourCieAddr;
          this.rebindIasZone();
        },
        timeoutFunc: () => {
          this.rebinding = false;
        },
      });
      return;
    }

    if (this.zoneState == 0) {
      DEBUG && console.log('rebindIasZone: enrolling sensor');
      // We're not enrolled - enroll so that we get notification statuses
      this.rebinding = true;
      const reqFrame = null;
      const rspStatus = 0;
      const zoneId = 1;
      const enrollRspFrame = this.makeEnrollRspFrame(reqFrame, rspStatus, zoneId);
      this.adapter.sendFrameWaitFrameAtFront(enrollRspFrame, {
        type: this.driver.getTransmitStatusFrameType(),
        id: enrollRspFrame.id,
        callback: () => {
          this.rebinding = false;
          // Remove zoneState so that we'll be forced to re-read it
          delete this.zoneState;
          this.rebindIasZone();
        },
        timeoutFunc: () => {
          this.rebinding = false;
        },
      });
      // eslint-disable-next-line
      return;
    }
  }

  writeCheckinInterval(interval) {
    if (!interval) {
      const slowCheckinInterval = this.slowCheckinInterval || SLOW_CHECKIN_INTERVAL;
      interval = this.rebindRequired ? FAST_CHECKIN_INTERVAL : slowCheckinInterval;
    }

    DEBUG &&
      console.log(
        `writeCheckinInterval(${interval})`,
        `this.checkinInterval: ${this.checkinInterval}`
      );
    if (!this.genPollCtrlEndpoint) {
      DEBUG && console.log('writeCheckinInterval: exiting - no genPollCtrlEndpoint');
      return;
    }
    if (this.writingCheckinInterval) {
      DEBUG && console.log('writeCheckinInterval: exiting - write already in progress');
      return;
    }

    if (!this.hasOwnProperty('checkinInterval')) {
      const readFrame = this.makeReadAttributeFrame(
        this.genPollCtrlEndpoint,
        PROFILE_ID.ZHA,
        CLUSTER_ID.GENPOLLCTRL,
        [
          ATTR_ID.GENPOLLCTRL.CHECKININTERVAL,
          ATTR_ID.GENPOLLCTRL.LONGPOLLINTERVAL,
          ATTR_ID.GENPOLLCTRL.SHORTPOLLINTERVAL,
          ATTR_ID.GENPOLLCTRL.FASTPOLLTIMEOUT,
        ]
      );
      this.writingCheckinInterval = true;
      this.adapter.sendFrameWaitFrameAtFront(readFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'readRsp',
        zclSeqNum: readFrame.zcl.seqNum,
        callback: () => {
          this.writingCheckinInterval = false;
          // If the checkinInterval wasn't in the readRsp (perhaps because
          // of an unsupported attribute), make sure that we set it
          // to something so that we can advance)
          if (!this.hasOwnProperty('checkinInterval')) {
            this.checkinInterval = 0;
          }
          this.writeCheckinInterval(interval);
        },
        timeoutFunc: () => {
          this.writingCheckinInterval = false;
        },
      });
      return;
    }

    if (this.checkinInterval != interval) {
      this.rebinding = true;
      this.writingCheckinInterval = true;
      const writeFrame = this.makeWriteAttributeFrame(
        this.genPollCtrlEndpoint,
        PROFILE_ID.ZHA,
        CLUSTER_ID.GENPOLLCTRL,
        [[ATTR_ID.GENPOLLCTRL.CHECKININTERVAL, interval]]
      );
      this.adapter.sendFrameWaitFrameAtFront(writeFrame, {
        type: this.driver.getExplicitRxFrameType(),
        zclCmdId: 'writeRsp',
        zclSeqNum: writeFrame.zcl.seqNum,
        callback: () => {
          this.rebinding = false;
          this.writingCheckinInterval = false;
          this.pollCtrlBindingNeeded = false;
          this.checkinInterval = interval;
          this.adapter.saveDeviceInfoDeferred();
          this.rebindIfRequired();
        },
        timeoutFunc: () => {
          this.rebinding = false;
          this.writingCheckinInterval = false;
        },
      });
    } else {
      this.pollCtrlBindingNeeded = false;
      this.adapter.saveDeviceInfoDeferred();
    }
  }

  rebindIfRequired() {
    if (this.adapter.scanning) {
      DEBUG && console.log(`rebindIfRequired: ${this.addr64}`, 'ignoring while scanning');
      return;
    }
    this.updateRebindRequired();
    DEBUG &&
      console.log(
        `rebindIfRequired: ${this.addr64} rebindRequired =`,
        this.rebindRequired,
        'rebinding =',
        this.rebinding
      );
    if (this.rebindRequired) {
      this.rebind();
    }
  }

  updateRebindRequired() {
    this.rebindRequired = true;

    if (this.pollCtrlBindingNeeded) {
      DEBUG &&
        console.log(
          'updateRebindRequired: node:',
          this.addr64,
          'pollCtrlBindingNeeded - rebind still required'
        );
      return;
    }

    const ourCieAddr = `0x${this.adapter.networkAddr64}`;
    if (this.ssIasEndpoint && this.cieAddr != ourCieAddr) {
      DEBUG &&
        console.log(
          'updateRebindRequired: node:',
          this.addr64,
          'cieAddr not set - rebind still required'
        );
      return;
    }

    // We need to be able to break out of the for loop, so don't be tempted
    // to replace the for loop with forEach
    for (const [propertyName, property] of this.properties.entries()) {
      if (property.configReportNeeded) {
        DEBUG &&
          console.log(
            'updateRebindRequired: node:',
            this.addr64,
            'property:',
            propertyName,
            'configReportNeeded is true -',
            'rebind still required'
          );
        return;
      }
      if (property.initialReadNeeded) {
        DEBUG &&
          console.log(
            'updateRebindRequired: node:',
            this.addr64,
            'property:',
            propertyName,
            'initialReadNeeded is true -',
            'rebind still required'
          );
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
    DEBUG && console.log('makeBindFrame: endpoint =', endpoint, 'clusterId =', clusterId);
    const addr16 = this.addr16 || UNKNOWN_ADDR_16;
    const frame = this.adapter.zdo.makeFrame({
      destination64: this.addr64,
      destination16: addr16,
      clusterId: zdo.CLUSTER_ID.BIND_REQUEST,
      bindSrcAddr64: this.addr64, // address of device that sends reports
      bindSrcEndpoint: endpoint, // endpoint of device that sends reports
      bindClusterId: clusterId, // clusterId of device that sends reports
      bindDstAddrMode: 3, // 3 = 64-bit DstAddr and DstEndpoint provided
      bindDstAddr64: this.adapter.networkAddr64, // coordinator address
      bindDstEndpoint: 1, // Endpoint on the coordinator
    });
    if (this.adapter.debugFrames) {
      frame.shortDescr = `EP:${endpoint} CL:${Utils.hexStr(clusterId, 4)}`;
    }
    if (configReportFrames) {
      frame.sendOnSuccess = configReportFrames;
    }
    return frame;
  }

  makeBindingsFrame(startIndex) {
    DEBUG && console.log('makeBindingsFrame: startIndex =', startIndex);
    const frame = this.adapter.zdo.makeFrame({
      destination64: this.addr64,
      destination16: this.addr16,
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_BIND_REQUEST,
      startIndex: startIndex,
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
      outputFrames.unshift(this.makeBindFrame(uce.endpoint, uce.clusterId, uce.frames));
    }
    return outputFrames;
  }

  makeConfigReportFrame(property) {
    const clusterId = property.clusterId;
    let attrs = property.attr;
    if (!Array.isArray(attrs)) {
      attrs = [attrs];
    }

    const payload = attrs.map((attr) => {
      return {
        direction: DIR.CLIENT_TO_SERVER,
        attrId: zclId.attr(clusterId, attr).value,
        dataType: zclId.attrType(clusterId, attr).value,
        minRepInterval: property.configReport.minRepInterval,
        maxRepInterval: property.configReport.maxRepInterval,
        repChange: property.configReport.repChange,
      };
    });
    const attrIds = payload.map((attrEntry) => {
      return attrEntry.attrId;
    });

    const frame = this.makeZclFrameForProperty(property, {
      cmd: 'configReport',
      payload: payload,
    });
    // The configReportResponse doesn't include attrId's if everything
    // was successfull.
    frame.extraParams = attrIds;
    return frame;
  }

  makeDefaultRspFrame(frame, statusCode) {
    // The frame-builder in the xbee-api library expects the source and
    // destination endpoints to be integers, but the frame parser presents
    // the endpoints as hex-strings. So we need to convert them.
    const sourceEndpoint = parseInt(frame.sourceEndpoint, 16);
    const destinationEndpoint = parseInt(frame.destinationEndpoint, 16);

    this.zclSeqNum = frame.zcl.seqNum;
    const rspFrame = this.makeZclFrame(sourceEndpoint, frame.profileId, frame.clusterId, {
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
    });
    // makeZclFrame normally assumes it's making new frames rather than
    // response frames, so we need to correct the sourceEndpoint.
    rspFrame.sourceEndpoint = destinationEndpoint;
    return rspFrame;
  }

  makeDiscoverAttributesFrame(endpoint, profileId, clusterId, startAttrId) {
    const frame = this.makeZclFrame(endpoint, profileId, clusterId, {
      cmd: 'discover',
      payload: {
        startAttrId: startAttrId,
        maxAttrIds: 255,
      },
    });
    return frame;
  }

  makeEnrollRspFrame(enrollReqFrame, status, zoneId) {
    let sourceEndpoint;
    let profileId;
    if (enrollReqFrame) {
      sourceEndpoint = parseInt(enrollReqFrame.sourceEndpoint, 16);
      profileId = enrollReqFrame.profileId;
    } else {
      sourceEndpoint = this.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.SSIASZONE_HEX);
      profileId = PROFILE_ID.ZHA_HEX;
    }
    const rspFrame = this.makeZclFrame(sourceEndpoint, profileId, CLUSTER_ID.SSIASZONE, {
      cmd: 'enrollRsp',
      frameCntl: {
        frameType: 1, // enrollRsp is specific to the IAS Zone cluster
        direction: DIR.CLIENT_TO_SERVER,
      },
      payload: {
        enrollrspcode: status,
        zoneid: zoneId,
      },
    });
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
    const frame = this.makeZclFrame(endpoint, profileId, clusterId, {
      cmd: 'read',
      payload: attrIds.map((attrId) => {
        return { direction: DIR.CLIENT_TO_SERVER, attrId: attrId };
      }),
    });
    return frame;
  }

  makeReadAttributeFrameForProperty(property) {
    return this.makeReadAttributeFrame(
      property.endpoint,
      property.profileId,
      property.clusterId,
      property.attrId
    );
  }

  makeReadReportConfigFrame(property) {
    const clusterId = property.clusterId;
    const attr = property.attr;
    const frame = this.makeZclFrameForProperty(property, {
      cmd: 'readReportConfig',
      payload: [
        {
          direction: DIR.CLIENT_TO_SERVER,
          attrId: zclId.attr(clusterId, attr).value,
        },
      ],
    });
    return frame;
  }

  // attrIdsVals is an array of tuples:
  //  [[attrId1, attrVal1], [attrId2, attrVal2], ...]
  makeWriteAttributeFrame(endpoint, profileId, clusterId, attrIdsVals) {
    const frame = this.makeZclFrame(endpoint, profileId, clusterId, {
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
    });
    return frame;
  }

  makeZclFrame(endpoint, profileId, clusterId, zclData) {
    assert(typeof endpoint === 'number', 'makeZclFrame: Expecting endpoint to be a number');

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
      zclData.frameCntl.direction = DIR.CLIENT_TO_SERVER;
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
      id: this.driver.nextFrameId(),
      type: this.driver.getExplicitTxFrameType(),
      destination64: this.addr64,
      sourceEndpoint: 1,

      destinationEndpoint: endpoint,
      profileId: profileId,
      clusterId: Utils.hexStr(clusterId, 4),

      broadcastRadius: 0,
      options: 0,
      zcl: zclData,
    };
    if (typeof this.addr16 !== 'undefined') {
      frame.destination16 = this.addr16;
    }

    frame.data = zcl.frame(
      zclData.frameCntl,
      zclData.manufCode,
      zclData.seqNum,
      zclData.cmd,
      zclData.payload,
      clusterId
    );
    return frame;
  }

  makeZclFrameForProperty(property, zclData) {
    return this.makeZclFrame(property.endpoint, property.profileId, property.clusterId, zclData);
  }

  notifyEvent(eventName, eventData) {
    if (eventData) {
      console.log(this.name, 'event:', eventName, 'data:', eventData);
    } else {
      console.log(this.name, 'event:', eventName);
    }
    this.eventNotify(new Event(this, eventName, eventData));
  }

  notifyPropertyChanged(property) {
    const deferredSet = property.deferredSet;
    if (deferredSet) {
      property.deferredSet = null;
      deferredSet.resolve(property.value);
    }
    super.notifyPropertyChanged(property);

    if (property.hasOwnProperty('updated')) {
      property.updated();
    }

    this.adapter.saveDeviceInfoDeferred();
  }

  isZclStatusSuccess(frame) {
    // Note: 'report' frames don't have a status
    // Cluster specific commands may or may not have payloads
    // which are arrays, so we only try to iterate if it looks
    // like an array.
    if (Array.isArray(frame.zcl.payload)) {
      for (const attrEntry of frame.zcl.payload) {
        if (attrEntry.hasOwnProperty('status') && attrEntry.status != STATUS.SUCCESS) {
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
      if (attrEntry.hasOwnProperty('status') && attrEntry.status != STATUS.SUCCESS) {
        let status = zclId.status(attrEntry.status);
        if (!status) {
          status = { key: 'unknown', value: attrEntry.status };
        }
        const clusterId = zdo.getClusterIdAsInt(frame.clusterId);
        let cluster = zclId.cluster(clusterId);
        if (!cluster) {
          cluster = { key: 'unknown', value: frame.clusterId };
        }
        let attr = zclId.attr(clusterId, attrEntry.attrId);
        if (!attr) {
          attr = { key: 'unknown', value: attrEntry.attrId };
        }
        console.error(
          'Response:',
          frame.zcl.cmdId,
          'got status:',
          status.key,
          `(${status.value}) node:`,
          this.name,
          'cluster:',
          cluster.key,
          `(${cluster.value}) attr:`,
          attr.key,
          `(${attr.value})`
        );
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
    this.adapter.sendFrameWaitFrame(
      frame,
      {
        type: this.driver.getExplicitRxFrameType(),
        remote64: frame.destination64,
      },
      property
    );
  }

  sendZclFrameWaitExplicitRxResolve(property, zclData) {
    const frame = this.makeZclFrameForProperty(property, zclData);
    this.adapter.sendFrameWaitFrameResolve(
      frame,
      {
        type: this.driver.getExplicitRxFrameType(),
        remote64: frame.destination64,
      },
      property
    );
  }

  performAction(action) {
    console.log(`${this.name}: Performing action '${action.name}'`);

    if (this.doorLockAction) {
      return Promise.reject('Lock/Unlock already in progress - ignoring');
    }

    action.start();
    switch (action.name) {
      case 'lock': // Start locking the door
        if (this.doorLockState.value === 'locked') {
          console.log('Door already locked - ignoring');
          action.finish();
          return Promise.resolve();
        }
        this.doorLockAction = action;
        this.doorLockProperty.setValue(true);
        this.setPropertyValue(this.doorLockState, 'unknown');
        break;

      case 'unlock': // Start unlocking the door
        if (this.doorLockState.value === 'unlocked') {
          console.log('Door already unlocked - ignoring');
          action.finish();
          return Promise.resolve();
        }
        this.doorLockAction = action;
        this.doorLockProperty.setValue(false);
        this.setPropertyValue(this.doorLockState, 'unknown');
        break;

      default:
        action.finish();
        return Promise.reject(`Unrecognized action: ${action.name}`);
    }

    if (this.doorLockAction) {
      this.doorLockTimeout = setTimeout(() => {
        // We didn't receive any type of status update. Assume jammed.
        this.setPropertyValue(this.doorLockState, 'jammed');
        const doorLockAction = this.doorLockAction;
        if (doorLockAction) {
          this.doorLockAction = null;
          doorLockAction.finish();
        }
      }, 15000);
    }
    return Promise.resolve();
  }

  // Used to set properties which don't have an associated attr
  setPropertyValue(property, value) {
    property.setCachedValue(value);
    console.log('setPropertyValue property:', property.name, 'for:', this.name, 'value:', value);
    this.notifyPropertyChanged(property);
  }
}

module.exports = ZigbeeNode;

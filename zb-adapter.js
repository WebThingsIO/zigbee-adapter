/**
 *
 * ZigbeeAdapter - Adapter which manages Zigbee devices.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const fs = require('fs');
const manifest = require('./manifest.json');
const mkdirp = require('mkdirp');
const os = require('os');
const path = require('path');
const ZigbeeNode = require('./zb-node');
const zdo = require('zigbee-zdo');
const zclId = require('zcl-id');
const registerFamilies = require('./zb-families');

const {Adapter, Utils} = require('gateway-addon');
const {
  ATTR_ID,
  BROADCAST_ADDR,
  CLUSTER_ID,
  PROFILE_ID,
  STATUS,
} = require('./zb-constants');

const {
  DEBUG_flow,
  DEBUG_frames,
} = require('./zb-debug');

const {
  Command,
  FUNC,
  RESOLVE_SET_PROPERTY,
  SEND_FRAME,
  WAIT_FRAME,
} = require('./zb-driver');

// Function which will convert endianess of hex strings.
// i.e. '12345678'.swapHex() returns '78563412'
String.prototype.swapHex = function() {
  return this.match(/.{2}/g).reverse().join('');
};

function getDataPath() {
  let profileDir;
  if (process.env.hasOwnProperty('MOZIOT_HOME')) {
    profileDir = process.env.MOZIOT_HOME;
  } else {
    profileDir = path.join(os.homedir(), '.mozilla-iot');
  }

  return path.join(profileDir, 'data', 'zigbee-adapter');
}

function getConfigPath() {
  if (process.env.hasOwnProperty('MOZIOT_HOME')) {
    return path.join(process.env.MOZIOT_HOME, 'config');
  }

  return path.join(os.homedir(), '.mozilla-iot', 'config');
}

class ZigbeeAdapter extends Adapter {
  constructor(addonManager, config, driver) {
    // The Zigbee adapter supports multiple dongles and
    // will create an adapter object for each dongle.
    // We don't know the actual adapter id until we
    // retrieve the serial number from the dongle. So we
    // set it to zb-unknown here, and fix things up later
    // just before we call addAdapter.
    super(addonManager, 'zb-unknown', manifest.id);
    this.config = config;
    this.driver = driver;
    console.log('this.driver =', driver);

    this.configDir = getDataPath();
    if (!fs.existsSync(this.configDir)) {
      mkdirp.sync(this.configDir, {mode: 0o755});
    }

    // move any old config files to the new directory
    const oldConfigDir = getConfigPath();
    const entries = fs.readdirSync(oldConfigDir);
    for (const entry of entries) {
      if (/^zb-[A-Fa-f0-9]+\.json$/.test(entry)) {
        const oldPath = path.join(oldConfigDir, entry);
        const newPath = path.join(this.configDir, entry);
        fs.renameSync(oldPath, newPath);
      }
    }

    // debugDiscoverAttributes causes us to ask for and print out the attributes
    // available for each cluster.
    this.debugDiscoverAttributes = false;

    this.isPairing = false;

    // Indicate that we're scanning so we don't try to talk to devices
    // until after we're initialized.
    this.scanning = true;

    this.atAttr = {};

    // Note: this structure parallels the this.devices dict in the Adapter
    //       base class. this.devices is keyed by deviceId (which would be
    // zb-XXX where XXX is the 64-bit address of the device). this.nodes
    // is keyed by the 64-bit address.
    this.nodes = {};

    this.nextStartIndex = -1;

    this.zdo = new zdo.ZdoApi(this.driver.nextFrameId,
                              this.driver.getExplicitTxFrameType());
  }

  // This function is called once the Xbee controller has been initialized.
  adapterInitialized() {
    if (DEBUG_flow) {
      console.log('adapterInitialized');
    }
    this.id = `zb-${this.networkAddr64}`;
    this.manager.addAdapter(this);

    this.deviceInfoFilename = path.join(this.configDir,
                                        `zb-${this.networkAddr64}.json`);

    // Use this opportunity to create the node for the Coordinator.
    const coordinator = this.nodes[this.networkAddr64] =
      new ZigbeeNode(this, this.networkAddr64, this.networkAddr16);

    this.readDeviceInfo().then(() => {
      // Go find out what devices are on the network.
      this.queueCommands(
        this.getManagementLqiCommands(coordinator)
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
      // Send the network address request to all routers. This way the
      // parent will respond if it's a sleeping end device.
      destination64: node.addr64,
      destination16: BROADCAST_ADDR.ROUTERS,
      clusterId: zdo.CLUSTER_ID.NETWORK_ADDRESS_REQUEST,
      addr64: node.addr64,
      requestType: 0, // 0 = Single Device Response
      startIndex: 0,
      options: 0,
    });    },
    "0000000000000000": {
      "addr64": "0000000000000000",
      "addr16": "ff70",
      "activeEndpoints": {},
      "properties": {},
      "name": "zb-0000000000000000-Node",
      "@type": [],
      "defaultName": "zb-0000000000000000-Node",
      "extendedTimeout": true,
      "activeEndpointsPopulated": false,
      "nodeInfoEndpointsPopulated": false,
      "powerSource": 0,
      "rxOnWhenIdle": 1

    this.sendFrameWaitFrameAtFront(updateFrame, {
      type: this.driver.getExplicitRxFrameType(),
      zdoSeq: updateFrame.zdoSeq,
      waitRetryMax: 1,
      waitRetryTimeout: 1000, // Minimize delay for powered off devices.
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
      console.log('handleNetworkAddressResponse: Skipping:', node.nwkAddr64,
                  'due to unknown addr64');
      return;
    }

    node.updateAddr16(frame.nwkAddr16);
    if (node.rebindRequired) {
      this.populateNodeInfo(node);
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
                    `${neighbor.depth}`.padStart(3, ' '),
                    `${neighbor.lqi}`.padStart(3, ' '));
      }
    }
    console.log('-----------------');
  }

  readDeviceInfo() {
    DEBUG_flow && console.log('readDeviceInfo() called');
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

        for (const addr64 in devInfo.nodes) {
          const devInfoNode = devInfo.nodes[addr64];
          let node = this.nodes[addr64];
          if (!node) {
            node = new ZigbeeNode(this, addr64, devInfoNode.addr16);
            this.nodes[addr64] = node;
          }
          node.fromDeviceInfo(devInfoNode);
        }
        DEBUG_flow && console.log('readDeviceInfo() done');
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
      driver: this.driver.asDeviceInfo(),
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
    } else if (this.enumerateDoneCb) {
      this.enumerateDoneCb(node);
    }
  }

  findNodeFromRxFrame(frame) {
    const addr64 = frame.remote64 || 'ffffffffffffffff';
    const addr16 = frame.remote16;
    DEBUG_flow &&
      console.log('findNodeFromRxFrame: addr64:', addr64, 'addr16:', addr16);
    let node;

    // Some devices (like xiaomi) switch from using a proper 64-bit address to
    // using broadcast but still provide the a 16-bit address.
    if (addr64 == 'ffffffffffffffff') {
      if (addr16) {
        node = this.findNodeByAddr16(addr16);
        if (!node) {
          // We got a frame with a broadcast address and a 16-bit address
          // and we don't know the 64-bit address. Send out a request to
          // determine the 64-bit address. At least we'll be able to deal
          // with the next frame.

          const addrFrame = this.zdo.makeFrame({
            destination64: 'ffffffffffffffff',
            destination16: addr16,
            clusterId: zdo.CLUSTER_ID.IEEE_ADDRESS_REQUEST,
            addr16: addr16,
            requestType: 0, // 0 = Single Device Response
            startIndex: 0,
          });
          this.sendFrameNow(addrFrame);
        }
      }
      return node;
    }

    node = this.createNodeIfRequired(addr64, addr16);
    return node;
  }

  findNodeFromTxFrame(frame) {
    const addr64 = frame.destination64 || 'ffffffffffffffff';
    const addr16 = frame.destination16;
    DEBUG_flow &&
      console.log('findNodeFromTxFrame: addr64:', addr64, 'addr16:', addr16);
    let node;
    if (addr64 == 'ffffffffffffffff') {
      if (addr16) {
        node = this.findNodeByAddr16(addr16);
      }
    } else {
      node = this.nodes[addr64];
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

  handleZdoFrame(frame) {
    const clusterId = parseInt(frame.clusterId, 16);
    if (clusterId in ZigbeeAdapter.zdoClusterHandler) {
      ZigbeeAdapter.zdoClusterHandler[clusterId].call(this, frame);
    } else {
      console.error('No handler for ZDO cluster:',
                    zdo.getClusterIdAsString(clusterId));
      console.error(frame);
    }
  }

  handleZclFrame(frame) {
    // Add some special fields to ease waitFrame processing.
    if (frame.zcl.seqNum) {
      frame.zclSeqNum = frame.zcl.seqNum;
    }
    if (frame.zcl.cmdId) {
      frame.zclCmdId = frame.zcl.cmdId;
    }
    const node = this.findNodeFromRxFrame(frame);
    if (node) {
      node.handleZhaResponse(frame);
    } else {
      console.log('Node:', frame.remote64, frame.remote16, 'not found');
    }
  }

  // ----- END DEVICE ANNOUNCEMENT -------------------------------------------

  createNodeIfRequired(addr64, addr16) {
    if (DEBUG_flow) {
      console.log('createNodeIfRequired:', addr64, addr16);
    }

    if (addr64 == 'ffffffffffffffff' || typeof addr64 === 'undefined') {
      // We can't create a new node if we don't know the 64-bit address.
      // Hopefully, we've seen this node before.
      return this.findNodeByAddr16(addr16);
    }

    let node = this.nodes[addr64];
    if (node) {
      // Update the 16-bit address, since it may have changed.
      node.updateAddr16(addr16);
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
      new Command(WAIT_FRAME, {
        type: this.driver.getExplicitRxFrameType(),
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
          type: this.driver.getExplicitRxFrameType(),
          zdoSeq: frame.zdoSeq,
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
        type: this.driver.getExplicitRxFrameType(),
        zdoSeq: lqiFrame.zdoSeq,
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
      if (neighbor.addr64 == '0000000000000000') {
        const tmpnode = this.findNodeByAddr16(neighbor.addr16);
        if (tmpnode) {
          neighbor.addr64 = tmpnode.addr64;
        }
      }
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
        type: this.driver.getExplicitRxFrameType(),
        zdoSeq: rtgFrame.zdoSeq,
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
        type: this.driver.getExplicitRxFrameType(),
        zdoSeq: nodeDescFrame.zdoSeq,
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
        type: this.driver.getExplicitRxFrameType(),
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
    if (node.name == node.defaultName) {
      // Set the name to the empty string. This will allow the classifier
      // to assign a new default name.
      node.name = '';
    }
    this.managementLeave(node);
  }

  // eslint-disable-next-line no-unused-vars
  cancelRemoveThing(node) {
    // Nothing to do. We've either sent the leave request or not.
  }

  unload() {
    this.driver.close();
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
        type: this.driver.getTransmitStatusFrameType(),
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
      // I tried broadcasting a variety of ways, but with the ConBee
      // dongle they all get an INVALID_PARAMETER confirmStatus, with the
      // exception of sending it to '0000'
      destination64: this.networkAddr64,
      destination16: '0000',
      clusterId: zdo.CLUSTER_ID.MANAGEMENT_PERMIT_JOIN_REQUEST,
      permitDuration: seconds,
      trustCenterSignificance: 1,
    });
    if (DEBUG_frames) {
      permitJoinFrame.shortDescr =
        `permitDuration: ${permitJoinFrame.permitDuration}`;
    }

    this.queueCommandsAtFront([
      this.driver.permitJoinCommands(seconds),
      new Command(SEND_FRAME, permitJoinFrame),
      new Command(WAIT_FRAME, {
        type: this.driver.getTransmitStatusFrameType(),
        id: permitJoinFrame.id,
      }),
    ]);
  }

  handlePermitJoinResponse(_frame) {
    // Nothing to do.
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
    console.log('discover:   ModelId:', node.modelId);
    let commands = [];
    for (const endpointNum in node.activeEndpoints) {
      if (discoverEndpointNum && endpointNum != discoverEndpointNum) {
        continue;
      }
      const endpoint = node.activeEndpoints[endpointNum];

      commands = commands.concat([
        FUNC(this, this.print,
             [`discover:   Endpoint ${endpointNum} ` +
              `ProfileID: ${endpoint.profileId}`]),
        FUNC(this, this.print,
             [`discover:   Endpoint ${endpointNum} ` +
              `DeviceID: ${endpoint.deviceId}`]),
        FUNC(this, this.print,
             [`discover:   Endpoint ${endpointNum} ` +
              `DeviceVersion: ${endpoint.deviceVersion}`]),
        FUNC(this, this.print,
             [`discover:   Input clusters for endpoint ${endpointNum}`]),
      ]);
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
            node.makeDiscoverAttributesFrame(
              parseInt(endpointNum),
              PROFILE_ID.ZHA,  // IKEA bulbs require ZHA profile
              inputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: this.driver.getExplicitRxFrameType(),
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.zcl.seqNum,
              waitRetryMax: 1,
              waitRetryTimeout: 1000,
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
            node.makeDiscoverAttributesFrame(
              parseInt(endpointNum),
              PROFILE_ID.ZHA, // IKEA bulbs require ZHA profile
              outputCluster, 0);
          commands = commands.concat([
            new Command(SEND_FRAME, discoverFrame),
            new Command(WAIT_FRAME, {
              type: this.driver.getExplicitRxFrameType(),
              zclCmdId: 'discoverRsp',
              zclSeqNum: discoverFrame.zcl.seqNum,
              waitRetryMax: 1,
              waitRetryTimeout: 1000,
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
        type: this.driver.getExplicitRxFrameType(),
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

  // moveToHueAndSaturation is used to support deubgCmd - moveToHueAndSaturation
  moveToHueAndSaturation(node, endpoint, hue, saturation) {
    const profileId = 260;
    const clusterId = 0x0300;
    this.sendFrameNow(node.makeZclFrame(endpoint, profileId, clusterId, {
      frameCntl: {frameType: 1},
      cmd: 'moveToHueAndSaturation',
      payload: [hue, saturation, 0],
    }));
  }

  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------

  addIfReady(node) {
    this.saveDeviceInfoDeferred();
    if (DEBUG_flow) {
      console.log('addIfReady: node.activeEndpointsPopulated:',
                  node.activeEndpointsPopulated,
                  'scanning:', this.scanning);
    }

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
      console.log('handleDeviceAdded: ', node.addr64, node.addr16,
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

  populateNodeInfo(node) {
    if (DEBUG_flow) {
      console.log('populateNodeInfo node.addr64 =', node.addr64,
                  'rebindRequired:', node.rebindRequired);
    }
    if (node.addr64 == this.networkAddr64) {
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
          type: this.driver.getExplicitRxFrameType(),
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
          type: this.driver.getExplicitRxFrameType(),
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
          type: this.driver.getExplicitRxFrameType(),
          zclCmdId: 'readRsp',
          zclSeqNum: readFrame.zcl.seqNum,
          callback: () => {
            node.readingZoneType = false;
            if (node.hasOwnProperty('zoneType')) {
              this.setClassifierAttributesPopulated(node,
                                                    node.ssIasZoneEndpoint);
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
    node.handleGenericZclReadRsp(frame);
    if (DEBUG_flow) {
      console.log('populateClassifierAttributesLightingControl:',
                  'colorCapabilities =', node.colorCapabilities,
                  'colorMode =', node.colorMode);
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

  queueCommands(cmdSeq) {
    this.driver.queueCommands(cmdSeq);
  }

  queueCommandsAtFront(cmdSeq) {
    this.driver.queueCommandsAtFront(cmdSeq);
  }

  sendFrameNow(frame) {
    this.driver.sendFrameNow(frame);
  }

  sendFrames(frames) {
    const commands = [];
    for (const frame of frames) {
      let waitFrame;
      if (zdo.isZdoFrame(frame)) {
        waitFrame = {
          type: this.driver.getExplicitRxFrameType(),
          zdoSeq: frame.zdoSeq,
          sendOnSuccess: frame.sendOnSuccess,
        };
      } else if (this.driver.isZclFrame(frame)) {
        waitFrame = {
          type: this.driver.getExplicitRxFrameType(),
          zclSeqNum: frame.zcl.seqNum,
        };
      }
      if (!waitFrame) {
        waitFrame = {
          type: this.driver.getTransmitStatusFrameType(),
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
    this.driver.queueCommandsAtFront(commands);
  }

  sendFrameWaitFrameAtFront(sendFrame, waitFrame, priority) {
    this.driver.queueCommandsAtFront(
      this.driver.makeFrameWaitFrame(sendFrame, waitFrame, priority));
  }

  sendFrameWaitFrame(sendFrame, waitFrame, priority) {
    this.driver.queueCommands(
      this.driver.makeFrameWaitFrame(sendFrame, waitFrame, priority));
  }

  sendFrameWaitFrameResolve(sendFrame, waitFrame, property) {
    this.driver.queueCommands([
      new Command(SEND_FRAME, sendFrame),
      new Command(WAIT_FRAME, waitFrame),
      new Command(RESOLVE_SET_PROPERTY, property),
    ]);
  }
}

ZigbeeAdapter.zdoClusterHandler = {
  [zdo.CLUSTER_ID.ACTIVE_ENDPOINTS_RESPONSE]:
    ZigbeeAdapter.prototype.handleActiveEndpointsResponse,
  [zdo.CLUSTER_ID.IEEE_ADDRESS_RESPONSE]:
    ZigbeeAdapter.prototype.handleIEEEAddressResponse,
  [zdo.CLUSTER_ID.NETWORK_ADDRESS_RESPONSE]:
    ZigbeeAdapter.prototype.handleNetworkAddressResponse,
  [zdo.CLUSTER_ID.MANAGEMENT_BIND_RESPONSE]:
    ZigbeeAdapter.prototype.handleManagementBindResponse,
  [zdo.CLUSTER_ID.MANAGEMENT_LEAVE_RESPONSE]:
    ZigbeeAdapter.prototype.handleManagementLeaveResponse,
  [zdo.CLUSTER_ID.MANAGEMENT_LQI_RESPONSE]:
    ZigbeeAdapter.prototype.handleManagementLqiResponse,
  [zdo.CLUSTER_ID.MANAGEMENT_RTG_RESPONSE]:
    ZigbeeAdapter.prototype.handleManagementRtgResponse,
  [zdo.CLUSTER_ID.MATCH_DESCRIPTOR_REQUEST]:
    ZigbeeAdapter.prototype.handleMatchDescriptorRequest,
  [zdo.CLUSTER_ID.SIMPLE_DESCRIPTOR_RESPONSE]:
    ZigbeeAdapter.prototype.handleSimpleDescriptorResponse,
  [zdo.CLUSTER_ID.END_DEVICE_ANNOUNCEMENT]:
    ZigbeeAdapter.prototype.handleEndDeviceAnnouncement,
  [zdo.CLUSTER_ID.BIND_RESPONSE]:
    ZigbeeAdapter.prototype.handleBindResponse,
  [zdo.CLUSTER_ID.MANAGEMENT_PERMIT_JOIN_RESPONSE]:
    ZigbeeAdapter.prototype.handlePermitJoinResponse,
};

registerFamilies();

module.exports = ZigbeeAdapter;

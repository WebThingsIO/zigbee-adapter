/**
 *
 * zb-xiaomi.js - special case code for xiami devices
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const cloneDeep = require('clone-deep');
const zclId = require('zcl-id');
const ZigbeeFamily = require('./zb-family');
const ZigbeeProperty = require('./zb-property');

let Constants, utils;
try {
  Constants = require('../addon-constants');
  utils = require('../utils');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Constants = gwa.Constants;
  utils = gwa.Utils;
}

const DEBUG = false;

const ZHA_PROFILE_ID = zclId.profile('HA').value;
const ZHA_PROFILE_ID_HEX = utils.hexStr(ZHA_PROFILE_ID, 4);

const CLUSTER_ID_GENBASIC = zclId.cluster('genBasic').value;
const CLUSTER_ID_GENBASIC_HEX = utils.hexStr(CLUSTER_ID_GENBASIC, 4);

const CLUSTER_ID_GENONOFF = zclId.cluster('genOnOff').value;
const CLUSTER_ID_GENONOFF_HEX = utils.hexStr(CLUSTER_ID_GENONOFF, 4);

const CLUSTER_ID_OCCUPANCY_SENSOR = zclId.cluster('msOccupancySensing').value;
const CLUSTER_ID_OCCUPANCY_SENSOR_HEX =
  utils.hexStr(CLUSTER_ID_OCCUPANCY_SENSOR, 4);

const POWERSOURCE_BATTERY = 3;

// The following github repository has a bunch of useful information
// for each of the xiaomi sensors.
// https://github.com/Frans-Willem/AqaraHub/tree/master/documentation/devices

const MODEL_IDS = {
  'lumi.sensor_magnet': {
    name: 'magent',
    type: Constants.THING_TYPE_BINARY_SENSOR,
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE_BATTERY,
    activeEndpoints: {
      1: {
        profileId: ZHA_PROFILE_ID_HEX,
        inputClusters: [
          CLUSTER_ID_GENBASIC_HEX,
          CLUSTER_ID_GENONOFF_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      on: {
        descr: {
          '@type': 'BooleanProperty',
          label: 'On',
          type: 'boolean',
          description: 'Magnet Sensor',
        },
        profileId: ZHA_PROFILE_ID,
        endpoint: 1,
        clusterId: CLUSTER_ID_GENONOFF,
        attr: 'onOff',
        value: false,
        parseValueFromAttr: 'parseOffOnAttr',
      },
    },
  },
  'lumi.sensor_switch': {
    name: 'switch',
    type: Constants.THING_TYPE_BINARY_SENSOR,
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE_BATTERY,
    activeEndpoints: {
      1: {
        profileId: ZHA_PROFILE_ID_HEX,
        inputClusters: [
          CLUSTER_ID_GENBASIC_HEX,
          CLUSTER_ID_GENONOFF_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      on: {
        descr: {
          '@type': 'BooleanProperty',
          label: 'On',
          type: 'boolean',
          description: 'Magnet Sensor',
        },
        profileId: ZHA_PROFILE_ID,
        endpoint: 1,
        clusterId: CLUSTER_ID_GENONOFF,
        attr: 'onOff',
        value: false,
        parseValueFromAttr: 'parseOffOnAttr',
      },
      multiClick: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'MultiClick',
          type: 'number',
        },
        description: 'Switch Sensor',
        profileId: ZHA_PROFILE_ID,
        endpoint: 1,
        clusterId: CLUSTER_ID_GENONOFF,
        attr: '',
        attrId: 0x8000,
        value: 0,
        parseValueFromAttr: 'parseNumericAttr',
      },
    },
  },
  'lumi.sensor_motion': {
    name: 'occupancy',
    type: Constants.THING_TYPE_BINARY_SENSOR,
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE_BATTERY,
    occupancyTimeout: 10, // seconds
    activeEndpoints: {
      1: {
        profileId: ZHA_PROFILE_ID_HEX,
        inputClusters: [
          CLUSTER_ID_GENBASIC_HEX,
          CLUSTER_ID_OCCUPANCY_SENSOR_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      occupied: {
        descr: {
          '@type': 'BooleanProperty',
          type: 'boolean',
          label: 'Occupied',
          description: 'Occupancy Sensor',
        },
        profileId: ZHA_PROFILE_ID,
        endpoint: 1,
        clusterId: CLUSTER_ID_OCCUPANCY_SENSOR,
        attr: 'occupancy',
        value: false,
        parseValueFromAttr: 'parseOccupiedAttr',
      },
    },
  },
};

class XiaomiFamily extends ZigbeeFamily {
  constructor() {
    super('xiaomi');
  }

  classify(_node) {
    // The xiaomi fmaily does the classification as part of the init
    // function, so we don't need to do anything here.
  }

  identify(node) {
    if (MODEL_IDS.hasOwnProperty(node.modelId)) {
      this.init(node);
      return true;
    }
    return false;
  }

  init(node) {
    const attribs = MODEL_IDS[node.modelId];
    if (!attribs) {
      console.error('xiaomi.classify: Unknown modelId:', node.modelId);
      return;
    }
    if (node.inited) {
      return;
    }
    node.inited = true;

    DEBUG && console.log('xiaomi.init: modelId:', node.modelId);
    for (const attribName in attribs) {
      const attrib = attribs[attribName];
      switch (attribName) {
        case 'name':
          node.name = `${node.id}-${attrib}`;
          break;

        case 'properties':
          for (const propertyName in attrib) {
            const xiaomiProperty = attrib[propertyName];
            const property = new ZigbeeProperty(
              node,
              propertyName,
              xiaomiProperty.descr,
              xiaomiProperty.profileId,
              xiaomiProperty.endpoint,
              xiaomiProperty.clusterId,
              xiaomiProperty.attr,
              xiaomiProperty.setAttrFromValue || '',
              xiaomiProperty.parseValueFromAttr || ''
            );
            property.configReportNeeded = false;
            property.initialReadNeeded = false;

            if (xiaomiProperty.hasOwnProperty('attrId')) {
              property.attrId = xiaomiProperty.attrId;
            }
            if (xiaomiProperty.hasOwnProperty('value')) {
              property.setCachedValue(xiaomiProperty.value);
            }

            DEBUG && console.log('xiaomi.init: added property:',
                                 propertyName, property.asDict());

            node.properties.set(propertyName, property);
          }
          break;

        default:
          node[attribName] = cloneDeep(attrib);
          break;
      }
    }

    for (const endpointNum in node.activeEndpoints) {
      const endpoint = node.activeEndpoints[endpointNum];
      endpoint.classifierAttributesPopulated = true;
    }
    node.activeEndpointsPopulated = true;
    node.nodeInfoEndpointsPopulated = true;
    node.rebindRequired = false;

    // Make sure that the family is set before calling
    // handleDeviceAdded. This ensures that our classifier gets
    // called and not the generic one.
    node.family = this;
    node.adapter.saveDeviceInfo();
    node.adapter.handleDeviceAdded(node);
  }
}

module.exports = XiaomiFamily;

ZigbeeFamily.register(new XiaomiFamily());

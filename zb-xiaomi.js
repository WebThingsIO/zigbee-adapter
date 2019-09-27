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
const ZigbeeFamily = require('./zb-family');
const ZigbeeProperty = require('./zb-property');

const {DEBUG_xiaomi} = require('./zb-debug');
const DEBUG = DEBUG_xiaomi;

const {
  CLUSTER_ID,
  PROFILE_ID,
  POWERSOURCE,
} = require('./zb-constants');

// The following github repository has a bunch of useful information
// for each of the xiaomi sensors.
// https://github.com/Frans-Willem/AqaraHub/tree/master/documentation/devices

const MODEL_IDS = {
  'lumi.sensor_magnet': {
    name: 'magnet',
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.GENONOFF_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      on: {
        descr: {
          '@type': 'BooleanProperty',
          label: 'Open',
          type: 'boolean',
          description: 'Magnet Sensor',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.GENONOFF,
        attr: 'onOff',
        value: false,
        parseValueFromAttr: 'parseOnOffAttr',
      },
    },
  },
  'lumi.sensor_switch': {
    name: 'switch',
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.GENONOFF_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      on: {
        descr: {
          '@type': 'BooleanProperty',
          label: 'Pressed',
          type: 'boolean',
          description: 'Magnet Sensor',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.GENONOFF,
        attr: 'onOff',
        value: false,
        parseValueFromAttr: 'parseOffOnAttr',
      },
      multiClick: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'MultiClick',
          type: 'number',
          description: 'Switch Sensor',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.GENONOFF,
        attr: '',
        attrId: 0x8000,
        value: 0,
        parseValueFromAttr: 'parseNumericAttr',
      },
    },
  },
  'lumi.sensor_motion': {
    name: 'motion',
    '@type': ['MotionSensor'],
    powerSource: POWERSOURCE.BATTERY,
    occupancyTimeout: 10, // seconds
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.OCCUPANCY_SENSOR_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      occupied: {
        descr: {
          '@type': 'MotionProperty',
          type: 'boolean',
          label: 'Motion',
          description: 'Motion Sensor',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.OCCUPANCY_SENSOR,
        attr: 'occupancy',
        value: false,
        parseValueFromAttr: 'parseOccupiedAttr',
      },
    },
  },
  'lumi.sensor_motion.aq2': {// RTCGQ11LM
    name: 'motion',
    '@type': ['MotionSensor'],
    powerSource: POWERSOURCE.BATTERY,
    occupancyTimeout: 10, // seconds
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.OCCUPANCY_SENSOR_HEX,
          CLUSTER_ID.ILLUMINANCE_MEASUREMENT_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      occupied: {
        descr: {
          '@type': 'MotionProperty',
          type: 'boolean',
          label: 'Motion',
          description: 'Motion Sensor',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.OCCUPANCY_SENSOR,
        attr: 'occupancy',
        value: false,
        parseValueFromAttr: 'parseOccupiedAttr',
      },
      illuminance: {
        descr: {
          '@type': 'LevelProperty',
          type: 'number',
          label: 'Illuminance',
          unit: 'lux',
          minimum: 0,
          maximum: 1500,
          description: 'Lux Sensor',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.ILLUMINANCE_MEASUREMENT,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseNumericAttr',
      },
    },
  },
  'lumi.sensor_ht': {// WSDCGQ01LM (round)
    name: 'temperature',
    '@type': ['TemperatureSensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.TEMPERATURE_HEX,
          CLUSTER_ID.RELATIVE_HUMIDITY_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      temperature: {
        descr: {
          '@type': 'TemperatureProperty',
          label: 'Temperature',
          type: 'number',
          unit: 'degree celsius',
          minimum: -20,
          maximum: 60,
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.TEMPERATURE,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseTemperatureMeasurementAttr',
      },
      humidity: {
        descr: {
          '@type': 'LevelProperty',
          label: 'Humidity',
          type: 'number',
          unit: 'percent',
          minimum: 0,
          maximum: 100,
          description: 'Relative Humidity',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.RELATIVE_HUMIDITY,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseNumericHundredthsAttr',
      },
    },
  },
  'lumi.weather': {// WSDCGQ11LM (square)
    name: 'temperature',
    '@type': ['TemperatureSensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.TEMPERATURE_HEX,
          CLUSTER_ID.PRESSURE_HEX,
          CLUSTER_ID.RELATIVE_HUMIDITY_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      temperature: {
        descr: {
          '@type': 'TemperatureProperty',
          label: 'Temperature',
          type: 'number',
          unit: 'degree celsius',
          minimum: -20,
          maximum: 60,
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.TEMPERATURE,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseTemperatureMeasurementAttr',
      },
      humidity: {
        descr: {
          '@type': 'LevelProperty',
          label: 'Humidity',
          type: 'number',
          unit: 'percent',
          minimum: 0,
          maximum: 100,
          description: 'Relative Humidity',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.RELATIVE_HUMIDITY,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseNumericHundredthsAttr',
      },
      pressure: {
        descr: {
          '@type': 'LevelProperty',
          label: 'Pressure',
          type: 'number',
          unit: 'hPa',
          minimum: 800,
          maximum: 1100,
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.PRESSURE,
        attr: 'measuredValue',
        value: 0,
        parseValueFromAttr: 'parseNumericAttr',
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
      console.log('xiaomi.classify: Unknown modelId:', node.modelId);
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

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
  'lumi.sensor_switch.aq2': {
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
  'lumi.remote.b1acn01': {
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
    '@type': ['TemperatureSensor', 'HumiditySensor'],
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
          '@type': 'HumidityProperty',
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
    '@type': [
      'TemperatureSensor',
      'HumiditySensor',
      'BarometricPressureSensor',
    ],
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
          '@type': 'HumidityProperty',
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
          '@type': 'BarometricPressureProperty',
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
  'lumi.sensor_cube': {
    name: 'sensor-cube',
    '@type': ['BinarySensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENBASIC_HEX,
          CLUSTER_ID.GENOTA_HEX,
          CLUSTER_ID.GENMULTISTATEINPUT_HEX,
        ],
        outputClusters: [],
      },
      2: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENMULTISTATEINPUT_HEX,
        ],
        outputClusters: [],
      },
      3: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENANALOGINPUT_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      transitionString: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'State',
          type: 'string',
          description: 'Cube Motion Sensor',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 2,
        clusterId: CLUSTER_ID.GENMULTISTATEINPUT,
        attr: 'presentValue',
        value: '',
        parseValueFromAttr: 'parseCubeNumericAttr',
      },
      current_side: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'Side',
          type: 'integer',
          description: 'Current side of the cube',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 2,
        clusterId: CLUSTER_ID.GENMULTISTATEINPUT,
        attr: 'presentValue',
        value: '',
        parseValueFromAttr: 'decodeCurrentCubeSide',
      },
      /*
      transitionNumeric: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'State',
          type: 'number',
          description: 'Cube Motion Sensor',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 2,
        clusterId: CLUSTER_ID.GENMULTISTATEINPUT,
        attr: 'presentValue',
        value: 0,
        parseValueFromAttr: 'parseNumericAttr',
      },
      */
      rotate: {
        descr: {
          '@type': 'MultiClickProperty',
          label: 'Rotation',
          type: 'number',
          unit: '°',
          description: 'Cube Rotation',
          minimum: -180,
          maximum: 180,
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 3,
        clusterId: CLUSTER_ID.GENANALOGINPUT,
        attr: 'presentValue',
        value: '',
        parseValueFromAttr: 'parseNumericAttr',
      },
    },
  },
  'lumi.plug.maeu01': {
    name: 'smartplug',
    '@type': [
      'SmartPlug',
      'EnergyMonitor',
      'OnOffSwitch',
      'MultiLevelSensor',
    ],
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENONOFF_HEX,
          CLUSTER_ID.SEMETERING_HEX,
          CLUSTER_ID.HAELECTRICAL_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      switch: {
        descr: {
          '@type': 'OnOffProperty',
          label: 'On/Off',
          type: 'boolean',
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.GENONOFF,
        attr: 'onOff',
        parseValueFromAttr: 'parseOnOffAttr',
      },
      counter: {
        descr: {
          '@type': 'InstantaneousPowerProperty',
          label: 'Energy Total',
          type: 'number',
          unit: 'watt',
          description: 'Total consumed energy',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.SEMETERING,
        attr: 'currentSummDelivered',
        parseValueFromAttr: 'parseUInt48NumericAttr',
      },
      instPower: {
        descr: {
          '@type': 'InstantaneousPowerProperty',
          label: 'Power',
          type: 'number',
          unit: 'watt',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.HAELECTRICAL,
        attr: 'activePower',
        value: 0,
        parseValueFromAttr: 'parseNumericTenthsAttr',
      },
    },
  },
  'lumi.sensor_wleak.aq1': {
    name: 'water-sensor',
    '@type': ['LeakSensor'],
    powerSource: POWERSOURCE.BATTERY,
    activeEndpoints: {
      1: {
        profileId: PROFILE_ID.ZHA_HEX,
        inputClusters: [
          CLUSTER_ID.GENPOWERCFG_HEX,
          CLUSTER_ID.SSIASZONE_HEX,
        ],
        outputClusters: [],
      },
    },
    properties: {
      waterLeak: {
        descr: {
          '@type': 'LeakProperty',
          label: 'Water Leak',
          type: 'boolean',
          description: 'Water Leak detected',
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.SSIASZONE,
        attr: 'zoneStatus',
        value: 0,
        parseValueFromAttr: 'parseZoneStatusAttr',
      },
      battery: {
        descr: {
          '@type': 'LevelProperty',
          label: 'Battery',
          type: 'number',
          unit: 'percent',
          description: 'Remaining Battery percentage',
          minimum: 0,
          maximum: 100,
          readOnly: true,
        },
        profileId: PROFILE_ID.ZHA,
        endpoint: 1,
        clusterId: CLUSTER_ID.GENPOWERCFG,
        attr: 'batteryPercentageRemaining',
        value: 0,
        parseValueFromAttr: 'parseLevelAttr',
      },
    },
  },
};

const MODEL_IDS_MAP = {
  'lumi.sensor_magnet.aq2': 'lumi.sensor_magnet',
  'lumi.sensor_cube.aqgl01': 'lumi.sensor_cube',
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
    if (MODEL_IDS.hasOwnProperty(this.mapModelID(node))) {
      this.init(node);
      return true;
    }
    return false;
  }

  mapModelID(node) {
    if (MODEL_IDS_MAP.hasOwnProperty(node.modelId)) {
      return MODEL_IDS_MAP[node.modelId];
    }
    return node.modelId;
  }

  init(node) {
    const attribs = MODEL_IDS[this.mapModelID(node)];
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

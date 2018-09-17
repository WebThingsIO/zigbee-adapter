/**
 *
 * ZigbeeClassifier - Determines properties from Zigbee clusters.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */


'use strict';

const zclId = require('zcl-id');
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

const ZHA_PROFILE_ID = zclId.profile('HA').value;
const ZLL_PROFILE_ID = zclId.profile('LL').value;

const CLUSTER_ID_GENBINARYINPUT = zclId.cluster('genBinaryInput').value;
const CLUSTER_ID_GENBINARYINPUT_HEX =
  utils.hexStr(CLUSTER_ID_GENBINARYINPUT, 4);
const CLUSTER_ID_GENDEVICETEMPCFG = zclId.cluster('genDeviceTempCfg').value;
const CLUSTER_ID_GENDEVICETEMPCFG_HEX =
  utils.hexStr(CLUSTER_ID_GENDEVICETEMPCFG, 4);
const CLUSTER_ID_GENLEVELCTRL = zclId.cluster('genLevelCtrl').value;
const CLUSTER_ID_GENLEVELCTRL_HEX = utils.hexStr(CLUSTER_ID_GENLEVELCTRL, 4);
const CLUSTER_ID_GENONOFF = zclId.cluster('genOnOff').value;
const CLUSTER_ID_GENONOFF_HEX = utils.hexStr(CLUSTER_ID_GENONOFF, 4);
const CLUSTER_ID_GENPOWERCFG = zclId.cluster('genPowerCfg').value;
const CLUSTER_ID_GENPOWERCFG_HEX = utils.hexStr(CLUSTER_ID_GENPOWERCFG, 4);
const CLUSTER_ID_HAELECTRICAL = zclId.cluster('haElectricalMeasurement').value;
const CLUSTER_ID_HAELECTRICAL_HEX = utils.hexStr(CLUSTER_ID_HAELECTRICAL, 4);
const CLUSTER_ID_ILLUMINANCE_MEASUREMENT =
  zclId.cluster('msIlluminanceMeasurement').value;
const CLUSTER_ID_ILLUMINANCE_MEASUREMENT_HEX =
  utils.hexStr(CLUSTER_ID_ILLUMINANCE_MEASUREMENT, 4);
const CLUSTER_ID_LIGHTINGCOLORCTRL = zclId.cluster('lightingColorCtrl').value;
const CLUSTER_ID_LIGHTLINK = zclId.cluster('lightLink').value;
const CLUSTER_ID_LIGHTLINK_HEX = utils.hexStr(CLUSTER_ID_LIGHTLINK, 4);
const CLUSTER_ID_OCCUPANCY_SENSOR = zclId.cluster('msOccupancySensing').value;
const CLUSTER_ID_OCCUPANCY_SENSOR_HEX =
  utils.hexStr(CLUSTER_ID_OCCUPANCY_SENSOR, 4);
const CLUSTER_ID_SEMETERING = zclId.cluster('seMetering').value;
const CLUSTER_ID_SEMETERING_HEX = utils.hexStr(CLUSTER_ID_SEMETERING, 4);
const CLUSTER_ID_SSIASZONE = zclId.cluster('ssIasZone').value;
const CLUSTER_ID_SSIASZONE_HEX = utils.hexStr(CLUSTER_ID_SSIASZONE, 4);
const CLUSTER_ID_TEMPERATURE = zclId.cluster('msTemperatureMeasurement').value;
const CLUSTER_ID_TEMPERATURE_HEX = utils.hexStr(CLUSTER_ID_TEMPERATURE, 4);

const ZONE_STATUS_ALARM_MASK = 0x03;
const ZONE_STATUS_TAMPER_MASK = 0x04;
const ZONE_STATUS_LOW_BATTERY_MASK = 0x08;

const DEVICE_ID_ONOFFSWITCH = zclId.device('HA', 'onOffSwitch').value;
const DEVICE_ID_ONOFFSWITCH_HEX = utils.hexStr(DEVICE_ID_ONOFFSWITCH, 4);
const DEVICE_ID_ONOFFOUTPUT = zclId.device('HA', 'onOffOutput').value;
const DEVICE_ID_ONOFFOUTPUT_HEX = utils.hexStr(DEVICE_ID_ONOFFOUTPUT, 4);
const DEVICE_ID_SMART_PLUG = zclId.device('HA', 'smartPlug').value;
const DEVICE_ID_SMART_PLUG_HEX = utils.hexStr(DEVICE_ID_SMART_PLUG, 4);

const DEBUG = false;

// From the ZigBee Cluster Library Specification, document 07-5123-06,
// Revision 6, Draft Version 1.0.
// Table 8-5 - Values of the ZoneType Attribute
const ZONE_TYPE_NAME = {
  // Note: the Smart Things mulitpurpose sensor reports a zoneType of 0.
  // so we use 0 to inidcate that its a smart switch. If we find other
  // non-switch sensors which also report a zoneType of 0, we may need
  // to use further refinements, like the presence of the binaryInput
  // cluster.
  0x0000: {
    name: 'switch',
    '@type': ['DoorSensor'],
    propertyName: 'open',
    propertyDescr: {
      '@type': 'OpenProperty',
      type: 'boolean',
      label: 'Open',
      description: 'Contact Switch',
    },
  },
  0x000d: {
    name: 'motion',
    '@type': ['MotionSensor'],
    propertyName: 'motion',
    propertyDescr: {
      '@type': 'MotionProperty',
      type: 'boolean',
      label: 'Motion',
      description: 'Motion Sensor',
    },
  },
  0x0015: {
    name: 'switch',
    '@type': ['DoorSensor'],
    propertyName: 'open',
    propertyDescr: {
      '@type': 'OpenProperty',
      type: 'boolean',
      label: 'Open',
      description: 'Contact Switch',
    },
  },
  0x0028: {
    name: 'fire',
    '@type': ['BinarySensor'],
    propertyName: 'on',
    propertyDescr: {
      '@type': 'BooleanProperty',
      type: 'boolean',
      label: 'Fire',
      description: 'Fire Sensor',
    },
  },
  0x002a: {
    name: 'water',
    '@type': ['BinarySensor'],
    propertyName: 'on',
    propertyDescr: {
      '@type': 'BooleanProperty',
      type: 'boolean',
      label: 'Water',
      description: 'Water Sensor',
    },
  },
  0x002b: {
    name: 'co',
    '@type': ['BinarySensor'],
    propertyName: 'on',
    propertyDescr: {
      '@type': 'BooleanProperty',
      type: 'boolean',
      label: 'CO',
      description: 'Carbon Monoxide Sensor',
    },
  },
  0x002c: {
    name: 'ped',
    '@type': ['PushButton'],
    propertyName: 'pushed',
    propertyDescr: {
      '@type': 'PushedProperty',
      type: 'boolean',
      label: 'Pressed',
      description: 'Personal Emergency Device',
    },
  },
  0x002d: {
    name: 'vibration',
    '@type': ['BinarySensor'],
    propertyName: 'on',
    propertyDescr: {
      '@type': 'BooleanProperty',
      type: 'boolean',
      label: 'Vibrating',
      description: 'Vibration/Movement Sensor',
    },
  },
  0x010f: {
    name: 'remote-panic',
    '@type': ['PushButton'],
    propertyName: 'pushed',
    propertyDescr: {
      '@type': 'PushedProperty',
      type: 'boolean',
      label: 'Pressed',
      description: 'Remote Control',
    },
  },
  0x0115: {
    name: 'keyfob-panic',
    '@type': ['PushButton'],
    propertyName: 'pushed',
    propertyDescr: {
      '@type': 'PushedProperty',
      type: 'boolean',
      label: 'Pressed',
      description: 'Keyfob',
    },
  },
  0x021d: {
    name: 'keypad-panic',
    '@type': ['PushButton'],
    propertyName: 'pushed',
    propertyDescr: {
      '@type': 'PushedProperty',
      type: 'boolean',
      label: 'Pressed',
      description: 'Keypad',
    },
  },
  0x0226: {
    name: 'glass',
    '@type': ['BinarySensor'],
    propertyName: 'on',
    propertyDescr: {
      '@type': 'BooleanProperty',
      type: 'boolean',
      label: 'Breakage',
      description: 'Glass Break Sensor',
    },
  },
};

// One way to do a deepEqual that turns out to be fairly performant.
// See: http://www.mattzeunert.com/2016/01/28/javascript-deep-equal.html
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CONFIG_REPORT_INTEGER = {
  minRepInterval: 1,    // seconds
  maxRepInterval: 120,  // seconds
  repChange: 1,
};

const CONFIG_REPORT_CURRENT = {
  minRepInterval: 5,    // seconds
  maxRepInterval: 120,  // seconds
  repChange: 10,
};

const CONFIG_REPORT_VOLTAGE = {
  minRepInterval: 5,    // seconds
  maxRepInterval: 120,  // seconds
  repChange: 10,
};

const CONFIG_REPORT_POWER = {
  minRepInterval: 5,    // seconds
  maxRepInterval: 120,  // seconds
  repChange: 10,
};

const CONFIG_REPORT_FREQUENCY = {
  minRepInterval: 5,    // seconds
  maxRepInterval: 120,  // seconds
  repChange: 2,
};

const CONFIG_REPORT_BATTERY = {
  minRepInterval: 10 * 60,  // 10 minutes
  maxRepInterval: 30 * 60,  // 30 minutes
  repChange: 2,             // 0.2 V
};

const CONFIG_REPORT_ILLUMINANCE = {
  minRepInterval: 0,
  maxRepInterval: 10 * 60,  // 10 minutes
  repChange: 0xffff,        // disabled
};

const CONFIG_REPORT_TEMPERATURE = {
  minRepInterval: 1 * 60,   // 1 minute
  maxRepInterval: 10 * 60,  // 10 minutes
  repChange: 10,            // 0.1 C
};

class ZigbeeClassifier {

  constructor() {
    this.frames = [];
  }

  appendFrames(frames) {
    this.frames = this.frames.concat(frames);
  }

  prependFrames(frames) {
    this.frames = frames.concat(this.frames);
  }

  addColorProperty(node, lightingColorCtrlEndpoint) {
    const endpoint = node.activeEndpoints[lightingColorCtrlEndpoint];
    this.addProperty(
      node,                           // device
      '_level',                       // name
      {                               // property description
        type: 'number',
      },
      endpoint.profileId,             // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID_GENLEVELCTRL,        // clusterId
      'currentLevel',                 // attr
      'setLevelValue',                // setAttrFromValue
      'parseLevelAttr'                // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      'color',                        // name
      {                               // property description
        '@type': 'ColorProperty',
        label: 'Color',
        type: 'string',
      },
      endpoint.profileId,             // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID_LIGHTINGCOLORCTRL,   // clusterId
      'currentHue,currentSaturation', // attr
      'setColorValue',                // setAttrFromValue
      'parseColorAttr'                // parseValueFromAttr
    );
  }

  addBrightnessProperty(node, genLevelCtrlEndpoint) {
    const endpoint = node.activeEndpoints[genLevelCtrlEndpoint];
    this.addProperty(
      node,                           // device
      'level',                        // name
      {                               // property description
        '@type': 'BrightnessProperty',
        label: 'Brightness',
        type: 'number',
        unit: 'percent',
        minimum: 0,
        maximum: 100,
      },
      endpoint.profileId,             // profileId
      genLevelCtrlEndpoint,           // endpoint
      CLUSTER_ID_GENLEVELCTRL,        // clusterId
      'currentLevel',                 // attr
      'setLevelValue',                // setAttrFromValue
      'parseLevelAttr',               // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addDeviceTemperatureProperty(node, genDeviceTempCfgEndpoint) {
    this.addProperty(
      node,                           // device
      'temperature',                  // name
      {                               // property description
        '@type': 'TemperatureProperty',
        label: 'Temperature',
        type: 'number',
        unit: 'celsius',
      },
      ZHA_PROFILE_ID,                 // profileId
      genDeviceTempCfgEndpoint,       // endpoint
      CLUSTER_ID_GENDEVICETEMPCFG,    // clusterId
      'currentTemperature',           // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addLevelProperty(node, genLevelCtrlEndpoint) {
    const endpoint = node.activeEndpoints[genLevelCtrlEndpoint];
    this.addProperty(
      node,                           // device
      'level',                        // name
      {                               // property description
        '@type': 'LevelProperty',
        label: 'Level',
        type: 'number',
        unit: 'percent',
        minimum: 0,
        maximum: 100,
      },
      endpoint.profileId,             // profileId
      genLevelCtrlEndpoint,           // endpoint
      CLUSTER_ID_GENLEVELCTRL,        // clusterId
      'currentLevel',                 // attr
      'setLevelValue',                // setAttrFromValue
      'parseLevelAttr',               // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addOnProperty(node, genOnOffEndpoint) {
    const endpoint = node.activeEndpoints[genOnOffEndpoint];
    this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'OnOffProperty',
        label: 'On/Off',
        type: 'boolean',
      },
      endpoint.profileId,             // profileId
      genOnOffEndpoint,               // endpoint
      CLUSTER_ID_GENONOFF,            // clusterId
      'onOff',                        // attr
      'setOnOffValue',                // setAttrFromValue
      'parseOnOffAttr',               // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addPresentValueProperty(node, genBinaryInputEndpoint) {
    this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'BooleanProperty',
        label: 'Present',
        type: 'boolean',
      },
      ZHA_PROFILE_ID,                 // profileId
      genBinaryInputEndpoint,         // endpoint
      CLUSTER_ID_GENBINARYINPUT,      // clusterId
      'presentValue',                 // attr
      'setOnOffValue',                // setAttrFromValue
      'parseOnOffAttr',               // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addHaCurrentProperty(node, haElectricalEndpoint) {
    this.addProperty(
      node,                           // device
      '_currentMul',                  // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acCurrentMultiplier',          // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      '_currentDiv',                  // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acCurrentDivisor',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      'current',                      // name
      {                               // property description
        '@type': 'CurrentProperty',
        label: 'Current',
        type: 'number',
        unit: 'ampere',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'rmsCurrent',                   // attr
      '',                             // setAttrFromValue
      'parseHaCurrentAttr',           // parseValueFromAttr
      CONFIG_REPORT_CURRENT
    );
  }

  addHaFrequencyProperty(node, haElectricalEndpoint) {
    this.addProperty(
      node,                           // device
      'frequency',                    // name
      {                               // property description
        '@type': 'FrequencyProperty',
        label: 'Frequency',
        type: 'number',
        unit: 'hertz',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acFrequency',                  // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      CONFIG_REPORT_FREQUENCY
    );
  }

  addHaInstantaneousPowerProperty(node, haElectricalEndpoint) {
    this.addProperty(
      node,                           // device
      '_powerMul',                    // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acPowerMultiplier',            // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      '_powerDiv',                    // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acPowerDivisor',               // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      'instantaneousPower',           // name
      {                               // property description
        '@type': 'InstantaneousPowerProperty',
        label: 'Power',
        type: 'number',
        unit: 'watt',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'activePower',                  // attr
      '',                             // setAttrFromValue
      'parseHaInstantaneousPowerAttr', // parseValueFromAttr
      CONFIG_REPORT_POWER
    );
  }

  addHaVoltageProperty(node, haElectricalEndpoint) {
    this.addProperty(
      node,                           // device
      '_voltageMul',                  // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acVoltageMultiplier',          // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      '_voltageDiv',                  // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'acVoltageDivisor',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      1                               // defaultValue
    );
    this.addProperty(
      node,                           // device
      'voltage',                      // name
      {                               // property description
        '@type': 'VoltageProperty',
        label: 'Voltage',
        type: 'number',
        unit: 'volt',
      },
      ZHA_PROFILE_ID,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'rmsVoltage',                   // attr
      '',                             // setAttrFromValue
      'parseHaVoltageAttr',           // parseValueFromAttr
      CONFIG_REPORT_VOLTAGE
    );
  }

  addSeInstantaneousPowerProperty(node, seMeteringEndpoint) {
    this.addProperty(
      node,                           // device
      '_multiplier',                  // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID_SEMETERING,          // clusterId
      'multiplier',                   // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      '_divisor',                     // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID_SEMETERING,          // clusterId
      'divisor',                      // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      'instantaneousPower',           // name
      {                               // property description
        '@type': 'InstantaneousPowerProperty',
        label: 'Power',
        type: 'number',
        unit: 'watt',
      },
      ZHA_PROFILE_ID,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID_SEMETERING,          // clusterId
      'instantaneousDemand',          // attr
      '',                             // setAttrFromValue
      'parseSeInstantaneousPowerAttr', // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addOccupancySensorProperty(node, msOccupancySensingEndpoint) {
    this.addProperty(
      node,                           // device
      'occupied',                     // name
      {                               // property description
        '@type': 'BooleanProperty',
        type: 'boolean',
        label: 'Occupied',
        description: 'Occupancy Sensor',
      },
      ZHA_PROFILE_ID,                 // profileId
      msOccupancySensingEndpoint,     // endpoint
      CLUSTER_ID_OCCUPANCY_SENSOR,    // clusterId
      'occupancy',                    // attr
      '',                             // setAttrFromValue
      'parseOccupiedAttr',            // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
    this.addProperty(
      node,                           // device
      'sensorType',                   // name
      {                               // property description
        label: 'Sensor Type',
        type: 'string',
      },
      ZHA_PROFILE_ID,                 // profileId
      msOccupancySensingEndpoint,     // endpoint
      CLUSTER_ID_OCCUPANCY_SENSOR,    // clusterId
      'occupancySensorType',          // attr
      '',                             // setAttrFromValue
      'parseOccupancySensorTypeAttr'  // parseValueFromAttr
    );
  }

  addIlluminanceMeasurementProperty(node, msMeasurementEndpoint) {
    this.addProperty(
      node,                           // device
      '_minIlluminance',              // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID_ILLUMINANCE_MEASUREMENT, // clusterId
      'minMeasuredValue',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      '_maxIlluminance',              // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID_ILLUMINANCE_MEASUREMENT, // clusterId
      'maxMeasuredValue',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      'illuminance',                  // name
      {                               // property description
        '@type': 'IlluminanceProperty',
        label: 'Illuminance',
        type: 'number',
        unit: 'lux',
      },
      ZHA_PROFILE_ID,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID_ILLUMINANCE_MEASUREMENT, // clusterId
      'measuredValue',                // attr
      '',                             // setAttrFromValue
      'parseIlluminanceMeasurementAttr', // parseValueFromAttr
      CONFIG_REPORT_ILLUMINANCE
    );
  }

  addPowerCfgVoltageProperty(node, genPowerCfgEndpoint) {
    let attr = 'batteryVoltage';
    if (node.activeEndpoints[genPowerCfgEndpoint].deviceId ==
        DEVICE_ID_SMART_PLUG_HEX) {
      attr = 'mainsVoltage';
    }
    this.addProperty(
      node,                           // device
      'voltage',                      // name
      {                               // property description
        '@type': 'VoltageProperty',
        label: 'Voltage',
        type: 'number',
        unit: 'volt',
      },
      ZHA_PROFILE_ID,                 // profileId
      genPowerCfgEndpoint,            // endpoint
      CLUSTER_ID_GENPOWERCFG,         // clusterId
      attr,                           // attr
      '',                             // setAttrFromValue
      'parseNumericTenthsAttr',       // parseValueFromAttr
      CONFIG_REPORT_BATTERY
    );
  }

  addTemperatureSensorProperty(node, msTemperatureEndpoint) {
    this.addProperty(
      node,                           // device
      '_minTemp',                     // name
      {                               // property description
        type: 'number',
        unit: 'celsius',
      },
      ZHA_PROFILE_ID,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID_TEMPERATURE,         // clusterId
      'minMeasuredValue',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      '_maxTemp',                     // name
      {                               // property description
        type: 'number',
        unit: 'celsius',
      },
      ZHA_PROFILE_ID,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID_TEMPERATURE,         // clusterId
      'maxMeasuredValue',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      'temperature',                  // name
      {                               // property description
        '@type': 'TemperatureProperty',
        label: 'Temperature',
        type: 'number',
        unit: 'celsius',
      },
      ZHA_PROFILE_ID,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID_TEMPERATURE,         // clusterId
      'measuredValue',                // attr
      '',                             // setAttrFromValue
      'parseTemperatureMeasurementAttr', // parseValueFromAttr
      CONFIG_REPORT_TEMPERATURE
    );
  }

  addZoneTypeProperty(node, propertyName, propertyDescr) {
    this.addProperty(
      node,                           // device
      propertyName,                   // name
      propertyDescr,                  // property description
      ZHA_PROFILE_ID,                 // profileId
      node.ssIasZoneEndpoint,         // endpoint
      CLUSTER_ID_SSIASZONE,           // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    ).mask = ZONE_STATUS_ALARM_MASK;

    this.addProperty(
      node,                           // device
      'tamper',                       // name
      {                               // property description
        '@type': 'TamperProperty',
        type: 'boolean',
        label: 'Tamper',
      },
      ZHA_PROFILE_ID,                 // profileId
      node.ssIasZoneEndpoint,         // endpoint
      CLUSTER_ID_SSIASZONE,           // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    ).mask = ZONE_STATUS_TAMPER_MASK;

    this.addProperty(
      node,                           // device
      'lowBattery',                   // name
      {                               // property description
        '@type': 'LowPatteryProperty',
        type: 'boolean',
        label: 'Low Battery',
      },
      ZHA_PROFILE_ID,                 // profileId
      node.ssIasZoneEndpoint,         // endpoint
      CLUSTER_ID_SSIASZONE,           // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    ).mask = ZONE_STATUS_LOW_BATTERY_MASK;
  }

  addProperty(node, name, descr, profileId, endpoint, clusterId,
              attr, setAttrFromValue, parseValueFromAttr, configReport,
              defaultValue) {
    if (typeof profileId === 'string') {
      profileId = parseInt(profileId, 16);
    }
    // Some lights, like the IKEA ones, don't seem to respond to read requests
    // when the profileId is set to ZLL.
    let isZll = false;
    if (profileId == ZLL_PROFILE_ID) {
      isZll = true;
      profileId = ZHA_PROFILE_ID;
    }
    const property = new ZigbeeProperty(node, name, descr, profileId,
                                        endpoint, clusterId, attr,
                                        setAttrFromValue, parseValueFromAttr);
    node.properties.set(name, property);

    DEBUG && console.log('addProperty:', node.addr64, name);

    if (node.hasOwnProperty('devInfoProperties') &&
        node.devInfoProperties.hasOwnProperty(name)) {
      const devInfo = node.devInfoProperties[name];
      if (property.endpoint == devInfo.endpoint &&
          property.profileId == devInfo.profileId &&
          property.clusterId == devInfo.clusterId &&
          jsonEqual(property.attr, devInfo.attr)) {
        property.fireAndForget = devInfo.fireAndForget;
        property.value = devInfo.value;
        if (devInfo.hasOwnProperty('level')) {
          property.level = devInfo.level;
        }
      }
    }
    if (isZll) {
      // The ZLL spec says "Attribute reporting shall not be used in this
      // profile", which means that we'll never get reports.
      property.fireAndForget = true;
    }
    DEBUG && console.log('addProperty:   fireAndForget =',
                         property.fireAndForget);

    property.configReportNeeded = false;
    if (configReport && attr && !property.fireAndForget) {
      property.configReportNeeded = true;
      property.configReport = configReport;
    }
    if (name[0] == '_') {
      property.visible = false;
    }
    property.setInitialReadNeeded();
    property.defaultValue = defaultValue;

    DEBUG && console.log('addProperty:   configReportNeeded =',
                         property.configReportNeeded,
                         'initialReadNeeded =', property.initialReadNeeded);

    return property;
  }

  // internal function allows us to use early returns.
  classifyInternal(node) {
    const seMeteringEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SEMETERING_HEX);
    const haElectricalEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_HAELECTRICAL_HEX);

    const genBinaryInputEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENBINARYINPUT_HEX);
    const genLevelCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENLEVELCTRL_HEX);
    const genLevelCtrlOutputEndpoint =
      node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID_GENLEVELCTRL_HEX);
    const genOnOffEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);
    const genOnOffOutputEndpoint =
      node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);
    const msOccupancySensingEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID_OCCUPANCY_SENSOR_HEX);
    const msTemperatureEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_TEMPERATURE_HEX);
    const illuminanceEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID_ILLUMINANCE_MEASUREMENT_HEX);
    const genPowerCfgEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENPOWERCFG_HEX);
    const genDeviceTempCfgEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID_GENDEVICETEMPCFG_HEX);
    const ssIasZoneEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SSIASZONE_HEX);
    node.ssIasZoneEndpoint = ssIasZoneEndpoint;

    if (DEBUG) {
      console.log('---- Zigbee classifier -----');
      console.log('        seMeteringEndpoint =', seMeteringEndpoint);
      console.log('      haElectricalEndpoint =', haElectricalEndpoint);
      console.log('    genBinaryInputEndpoint =', genBinaryInputEndpoint);
      console.log('      genLevelCtrlEndpoint =', genLevelCtrlEndpoint);
      console.log('genLevelCtrlOutputEndpoint =', genLevelCtrlOutputEndpoint);
      console.log('          genOnOffEndpoint =', genOnOffEndpoint);
      console.log('    genOnOffOutputEndpoint =', genOnOffOutputEndpoint);
      console.log('         colorCapabilities =', node.colorCapabilities);
      console.log('msOccupancySensingEndpoint =', msOccupancySensingEndpoint);
      console.log('     msTemperatureEndpoint =', msTemperatureEndpoint);
      console.log('       genPowerCfgEndpoint =', genPowerCfgEndpoint);
      console.log('  genDeviceTempCfgEndpoint =', genDeviceTempCfgEndpoint);
      console.log('                  zoneType =', node.zoneType);
    }

    if (msTemperatureEndpoint) {
      this.addTemperatureSensorProperty(node, msTemperatureEndpoint);
    } else if (genDeviceTempCfgEndpoint) {
      this.addDeviceTemperatureProperty(node, genDeviceTempCfgEndpoint);
    }
    if (illuminanceEndpoint) {
      this.addIlluminanceMeasurementProperty(node, illuminanceEndpoint);
    }
    if (genPowerCfgEndpoint) {
      this.addPowerCfgVoltageProperty(node, genPowerCfgEndpoint);
    }

    if (typeof node.zoneType !== 'undefined') {
      this.initBinarySensorFromZoneType(node);
      return;
    }

    if (msOccupancySensingEndpoint) {
      this.initOccupancySensor(node, msOccupancySensingEndpoint);
      return;
    }

    if (haElectricalEndpoint) {
      this.initHaSmartPlug(node, haElectricalEndpoint, genLevelCtrlEndpoint);
      return;
    }
    if (seMeteringEndpoint) {
      this.initSeSmartPlug(node, seMeteringEndpoint, genLevelCtrlEndpoint);
      return;
    }
    if (genLevelCtrlEndpoint) {
      this.initMultiLevelSwitch(node, genLevelCtrlEndpoint);
      return;
    }
    if (genOnOffEndpoint) {
      this.initOnOffSwitch(node, genOnOffEndpoint);
      return;
    }
    // if (genLevelCtrlOutputEndpoint) {
    //    this.initMultiLevelButton(genOnOffOutputEndpoint,
    //                              genLevelCtrlOutputEndpoint);
    // }
    if (genBinaryInputEndpoint) {
      this.initBinarySensor(node, genBinaryInputEndpoint);
      // return;
    }
    // The linter complains if the above return is present.
    // Uncomment this return if you add any code here.
  }

  classify(node) {
    DEBUG && console.log('classify called for node:', node.addr64);

    if (node.isCoordinator) {
      return;
    }
    node.type = 'thing'; // Replace with THING_TYPE_THING once it exists

    this.classifyInternal(node);

    // Now that we know the type, set the default name.
    node.defaultName = `${node.id}-${node.type}`;
    if (!node.name) {
      node.name = node.defaultName;
    }
    DEBUG && console.log('classify: Initialized as type:', node.type,
                         'name:', node.name,
                         'defaultName:', node.defaultName);
  }

  initBinarySensor(node, endpointNum) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    node['@type'] = ['BinarySensor'];
    this.addPresentValueProperty(node, endpointNum);
  }

  initBinarySensorFromZoneType(node) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    let propertyName;
    let propertyDescr;
    let name;
    if (ZONE_TYPE_NAME.hasOwnProperty(node.zoneType)) {
      name = ZONE_TYPE_NAME[node.zoneType].name;
      node['@type'] = ZONE_TYPE_NAME[node.zoneType]['@type'];
      propertyName = ZONE_TYPE_NAME[node.zoneType].propertyName;
      propertyDescr = ZONE_TYPE_NAME[node.zoneType].propertyDescr;
    } else {
      // This is basically 'just in case'
      name = 'thing';
      node['@type'] = ['BinarySensor'];
      propertyName = 'on';
      propertyDescr = {
        '@type': 'BooleanProperty',
        type: 'boolean',
        label: `ZoneType${node.zoneType}`,
        descr: `ZoneType${node.zoneType}`,
      };
    }
    node.name = `${node.id}-${name}`;

    this.addZoneTypeProperty(node, propertyName, propertyDescr);
  }

  initOccupancySensor(node, msOccupancySensingEndpoint) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    node['@type'] = ['BinarySensor'];
    node.name = `${node.id}-occupancy`;

    this.addOccupancySensorProperty(node, msOccupancySensingEndpoint);
  }

  initOnOffSwitch(node, genOnOffEndpoint) {
    node.type = Constants.THING_TYPE_ON_OFF_SWITCH;
    node['@type'] = ['OnOffSwitch'];
    this.addOnProperty(node, genOnOffEndpoint);
  }

  initMultiLevelSwitch(node, genLevelCtrlEndpoint) {
    const lightLinkEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_LIGHTLINK_HEX);
    DEBUG && console.log('     lightLinkEndpoint =', lightLinkEndpoint);
    let colorSupported = false;
    if (lightLinkEndpoint) {
      if (node.hasOwnProperty('colorCapabilities') &&
          (node.colorCapabilities & 3) != 0) {
        // Hue and Saturation are supported
        colorSupported = true;
        node.type = Constants.THING_TYPE_ON_OFF_COLOR_LIGHT;
        node['@type'] = ['OnOffSwitch', 'Light', 'ColorControl'];
      } else {
        node.type = Constants.THING_TYPE_DIMMABLE_LIGHT;
        node['@type'] = ['OnOffSwitch', 'Light'];
      }
    } else {
      node.type = Constants.THING_TYPE_MULTI_LEVEL_SWITCH;
      node['@type'] = ['OnOffSwitch', 'MultiLevelSwitch'];
    }
    this.addOnProperty(node, genLevelCtrlEndpoint);
    if (colorSupported) {
      this.addColorProperty(node, node.lightingColorCtrlEndpoint);
    } else if (lightLinkEndpoint) {
      this.addBrightnessProperty(node, genLevelCtrlEndpoint);
    } else {
      this.addLevelProperty(node, genLevelCtrlEndpoint);
    }
  }

  initHaSmartPlug(node, haElectricalEndpoint, genLevelCtrlEndpoint) {
    node.type = Constants.THING_TYPE_SMART_PLUG;
    node['@type'] = ['OnOffSwitch', 'SmartPlug', 'EnergyMonitor'];
    this.addOnProperty(node, haElectricalEndpoint);
    if (genLevelCtrlEndpoint) {
      const endpoint = node.activeEndpoints[genLevelCtrlEndpoint];
      if (endpoint.deviceId != DEVICE_ID_ONOFFSWITCH_HEX &&
          endpoint.deviceId != DEVICE_ID_ONOFFOUTPUT_HEX) {
        // The Samsung SmartSwitch advertises the genLevelCtrl cluster,
        // but it doesn't do anything. It also advertises itself as an
        // onOffOutput, so we use that to filter out the level control.
        this.addLevelProperty(node, genLevelCtrlEndpoint);
        node['@type'].push('MultiLevelSwitch');
      }
    }
    this.addHaInstantaneousPowerProperty(node, haElectricalEndpoint);
    this.addHaCurrentProperty(node, haElectricalEndpoint);
    this.addHaFrequencyProperty(node, haElectricalEndpoint);
    this.addHaVoltageProperty(node, haElectricalEndpoint);
  }

  initSeSmartPlug(node, seMeteringEndpoint, genLevelCtrlEndpoint) {
    node.type = Constants.THING_TYPE_SMART_PLUG;
    node['@type'] = ['OnOffSwitch', 'SmartPlug', 'EnergyMonitor'];
    this.addOnProperty(node, seMeteringEndpoint);
    if (genLevelCtrlEndpoint) {
      this.addLevelProperty(node, genLevelCtrlEndpoint);
      node['@type'].push('MultiLevelSwitch');
    }
    this.addSeInstantaneousPowerProperty(node, seMeteringEndpoint);
  }
}

module.exports = new ZigbeeClassifier();

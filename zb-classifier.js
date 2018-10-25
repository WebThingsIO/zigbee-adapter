/**
 *
 * ZigbeeClassifier - Determines properties from Zigbee clusters.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */


'use strict';

const {
  CLUSTER_ID,
  COLOR_CAPABILITY,
  COLOR_MODE,
  DEVICE_ID,
  DOORLOCK_EVENT_CODES,
  PROFILE_ID,
  ZONE_STATUS,
} = require('./zb-constants');

const ZigbeeProperty = require('./zb-property');

const {Constants, Utils} = require('gateway-addon');

const {DEBUG_classifier} = require('./zb-debug');
const DEBUG = DEBUG_classifier;

const ZONE_TYPE_MOTION = 0x000d;
const ZONE_TYPE_SWITCH = 0x0015;

// From the ZigBee Cluster Library Specification, document 07-5123-06,
// Revision 6, Draft Version 1.0.
// Table 8-5 - Values of the ZoneType Attribute
const ZONE_TYPE_NAME = {
  [ZONE_TYPE_MOTION]: {   // 0x000d
    name: 'motion',
    '@type': ['MotionSensor'],
    propertyName: 'motion',
    propertyDescr: {
      '@type': 'MotionProperty',
      type: 'boolean',
      label: 'Motion',
      description: 'Motion Sensor',
      readOnly: true,
    },
  },
  [ZONE_TYPE_SWITCH]: {   // 0x0015
    name: 'switch',
    '@type': ['DoorSensor'],
    propertyName: 'open',
    propertyDescr: {
      '@type': 'OpenProperty',
      type: 'boolean',
      label: 'Open',
      description: 'Contact Switch',
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
    },
  },
};

// The newer SmartThings sensors report a zoneType of zero, so we
// use the modelId to further classify them
const ZONE_TYPE_ZERO = {
  multiv4: ZONE_TYPE_SWITCH,
  motionv5: ZONE_TYPE_MOTION,
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
        unit: 'percent',
        minimum: 0,
        maximum: 100,
      },
      endpoint.profileId,             // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID.GENLEVELCTRL,        // clusterId
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
      CLUSTER_ID.LIGHTINGCOLORCTRL,   // clusterId
      'currentHue,currentSaturation', // attr
      'setColorValue',                // setAttrFromValue
      'parseColorAttr'                // parseValueFromAttr
    );
  }

  addColorXYProperty(node, lightingColorCtrlEndpoint) {
    const endpoint = node.activeEndpoints[lightingColorCtrlEndpoint];
    this.addProperty(
      node,                           // device
      '_level',                       // name
      {                               // property description
        type: 'number',
        unit: 'percent',
        minimum: 0,
        maximum: 100,
      },
      endpoint.profileId,             // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID.GENLEVELCTRL,        // clusterId
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
      CLUSTER_ID.LIGHTINGCOLORCTRL,   // clusterId
      'currentX,currentY',            // attr
      'setColorXYValue',              // setAttrFromValue
      'parseColorXYAttr'              // parseValueFromAttr
    );
  }

  addColorTemperatureProperty(node, lightingColorCtrlEndpoint) {
    this.addProperty(
      node,                           // device
      '_minTemperature',              // name
      {                               // property description
        type: 'number',
      },
      PROFILE_ID.ZHA,                 // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID.LIGHTINGCOLORCTRL,   // clusterId
      'colorTempPhysicalMin',         // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      153                             // defaultValue (153 = 6500K)
    );
    this.addProperty(
      node,                           // device
      '_maxTemperature',              // name
      {                               // property description
        type: 'number',
      },
      PROFILE_ID.ZHA,                 // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID.LIGHTINGCOLORCTRL,   // clusterId
      'colorTempPhysicalMax',         // attr
      '',                             // setAttrFromValue
      'parseNumericAttr',             // parseValueFromAttr
      null,                           // configReport
      370                             // defaultValue (370 = 2700K)
    );
    this.addProperty(
      node,                           // device
      'colorTemperature',             // name
      {                               // property description
        '@type': 'ColorTemperatureProperty',
        label: 'Color Temperature',
        type: 'number',
        unit: 'kelvin',
      },
      PROFILE_ID.ZHA,                 // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID.LIGHTINGCOLORCTRL,   // clusterId
      'colorTemperature',             // attr
      'setColorTemperatureValue',     // setAttrFromValue
      'parseColorTemperatureAttr',    // parseValueFromAttr
      null,                           // configReport
      370                             // defaultValue
    );
    // IKEA color temperature bulbs return an unsupportedAttribute error
    // when trying to read the current color temperature. We set the
    // defaultValue to 370 so that it's numeric, and then
    // parseColorTemperatureAttr will clamp it to fall between the min/max
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
      CLUSTER_ID.GENLEVELCTRL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      genDeviceTempCfgEndpoint,       // endpoint
      CLUSTER_ID.GENDEVICETEMPCFG,    // clusterId
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
      CLUSTER_ID.GENLEVELCTRL,        // clusterId
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
      CLUSTER_ID.GENONOFF,            // clusterId
      'onOff',                        // attr
      'setOnOffValue',                // setAttrFromValue
      'parseOnOffAttr',               // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
  }

  addButtonOnProperty(node, genOnOffOutputEndpoint) {
    const property = this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'BooleanProperty',
        label: 'On/Off',
        type: 'boolean',
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      genOnOffOutputEndpoint,         // endpoint
      CLUSTER_ID.GENONOFF,            // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    );
    property.bindNeeded = true;
    if (typeof property.value === 'undefined') {
      property.value = false;
    }
    node.onOffProperty = property;
    DEBUG && console.log('addProperty:',
                         '  bindNeeded:', property.bindNeeded,
                         'value:', property.value);
  }

  addButtonLevelProperty(node, genLevelCtrlOutputEndpoint) {
    const property = this.addProperty(
      node,                           // device
      'level',                        // name
      {                               // property description
        '@type': 'LevelProperty',
        label: 'Level',
        type: 'number',
        unit: 'percent',
        minimum: 0,
        maximum: 100,
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      genLevelCtrlOutputEndpoint,     // endpoint
      CLUSTER_ID.GENLEVELCTRL,        // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    );
    property.bindNeeded = true;
    if (typeof property.value === 'undefined') {
      property.value = 0;
    }
    node.levelProperty = property;
    DEBUG && console.log('addProperty:',
                         '  bindNeeded:', property.bindNeeded,
                         'value:', property.value);
  }

  addDoorLockedProperty(node, doorLockEndpoint) {
    this.addProperty(
      node,                           // device
      'locked',                       // name
      {                               // property description
        '@type': 'BooleanProperty',
        label: 'Locked',
        type: 'boolean',
      },
      PROFILE_ID.ZHA,                 // profileId
      doorLockEndpoint,               // endpoint
      CLUSTER_ID.DOORLOCK,            // clusterId
      'lockState',                    // attr
      'setDoorLockedValue',           // setAttrFromValue
      'parseDoorLockedAttr',          // parseValueFromAttr
      CONFIG_REPORT_INTEGER
    );
    const doorLockEvents = {};
    for (const eventCode of DOORLOCK_EVENT_CODES) {
      doorLockEvents[eventCode] = {'@type': 'DoorLockEvent'};
    }
    this.addEvents(node, doorLockEvents);
    // Set the checkin interval for door locks to be faster since we
    // may need to talk to them.
    node.slowCheckinInterval = 1 * 60 * 4;  // 1 minute (quarterseconds)
  }

  addPresentValueProperty(node, genBinaryInputEndpoint) {
    this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'BooleanProperty',
        label: 'Present',
        type: 'boolean',
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      genBinaryInputEndpoint,         // endpoint
      CLUSTER_ID.GENBINARYINPUT,      // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID.HAELECTRICAL,        // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID.SEMETERING,          // clusterId
      'multiplier',                   // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      '_divisor',                     // name
      {                               // property description
        type: 'number',
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID.SEMETERING,          // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      seMeteringEndpoint,             // endpoint
      CLUSTER_ID.SEMETERING,          // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msOccupancySensingEndpoint,     // endpoint
      CLUSTER_ID.OCCUPANCY_SENSOR,    // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msOccupancySensingEndpoint,     // endpoint
      CLUSTER_ID.OCCUPANCY_SENSOR,    // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID.ILLUMINANCE_MEASUREMENT, // clusterId
      'minMeasuredValue',             // attr
      '',                             // setAttrFromValue
      'parseNumericAttr'              // parseValueFromAttr
    );
    this.addProperty(
      node,                           // device
      '_maxIlluminance',              // name
      {                               // property description
        type: 'number',
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID.ILLUMINANCE_MEASUREMENT, // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msMeasurementEndpoint,          // endpoint
      CLUSTER_ID.ILLUMINANCE_MEASUREMENT, // clusterId
      'measuredValue',                // attr
      '',                             // setAttrFromValue
      'parseIlluminanceMeasurementAttr', // parseValueFromAttr
      CONFIG_REPORT_ILLUMINANCE
    );
  }

  addPowerCfgVoltageProperty(node, genPowerCfgEndpoint) {
    let attr = 'batteryVoltage';
    if (node.activeEndpoints[genPowerCfgEndpoint].deviceId ==
        DEVICE_ID.SMART_PLUG_HEX) {
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      genPowerCfgEndpoint,            // endpoint
      CLUSTER_ID.GENPOWERCFG,         // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID.TEMPERATURE,         // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID.TEMPERATURE,         // clusterId
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
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID.TEMPERATURE,         // clusterId
      'measuredValue',                // attr
      '',                             // setAttrFromValue
      'parseTemperatureMeasurementAttr', // parseValueFromAttr
      CONFIG_REPORT_TEMPERATURE
    );
  }

  addZoneTypeProperty(node, propertyName, propertyDescr) {
    if (propertyName && propertyDescr) {
      this.addProperty(
        node,                           // device
        propertyName,                   // name
        propertyDescr,                  // property description
        PROFILE_ID.ZHA,                 // profileId
        node.ssIasZoneEndpoint,         // endpoint
        CLUSTER_ID.SSIASZONE,           // clusterId
        '',                             // attr
        '',                             // setAttrFromValue
        ''                              // parseValueFromAttr
      ).mask = ZONE_STATUS.ALARM_MASK;

      this.addProperty(
        node,                           // device
        'tamper',                       // name
        {                               // property description
          '@type': 'TamperProperty',
          type: 'boolean',
          label: 'Tamper',
          readOnly: true,
        },
        PROFILE_ID.ZHA,                 // profileId
        node.ssIasZoneEndpoint,         // endpoint
        CLUSTER_ID.SSIASZONE,           // clusterId
        '',                             // attr
        '',                             // setAttrFromValue
        ''                              // parseValueFromAttr
      ).mask = ZONE_STATUS.TAMPER_MASK;
    }

    this.addProperty(
      node,                           // device
      'lowBattery',                   // name
      {                               // property description
        '@type': 'LowBatteryProperty',
        type: 'boolean',
        label: 'Low Battery',
        readOnly: true,
      },
      PROFILE_ID.ZHA,                 // profileId
      node.ssIasZoneEndpoint,         // endpoint
      CLUSTER_ID.SSIASZONE,           // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    ).mask = ZONE_STATUS.LOW_BATTERY_MASK;

    // Remove the cieAddr so that we'll requery it from the device.
    delete node.cieAddr;
  }

  addEvents(node, events) {
    for (const eventName in events) {
      node.addEvent(eventName, events[eventName]);
    }
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
    if (profileId == PROFILE_ID.ZLL) {
      isZll = true;
      profileId = PROFILE_ID.ZHA;
    }
    const property = new ZigbeeProperty(node, name, descr, profileId,
                                        endpoint, clusterId, attr,
                                        setAttrFromValue, parseValueFromAttr);
    node.properties.set(name, property);

    DEBUG && console.log('addProperty:', node.addr64, name,
                         `EP:${property.endpoint}`,
                         `CL:${Utils.hexStr(property.clusterId, 4)}`);

    if (node.hasOwnProperty('devInfoProperties') &&
        node.devInfoProperties.hasOwnProperty(name)) {
      const devInfo = node.devInfoProperties[name];
      if (property.endpoint == devInfo.endpoint &&
          property.profileId == devInfo.profileId &&
          property.clusterId == devInfo.clusterId &&
          jsonEqual(property.attr, devInfo.attr)) {
        property.fireAndForget = devInfo.fireAndForget;
        property.value = devInfo.value;
        if (devInfo.hasOwnProperty('minimum')) {
          property.minimum = devInfo.minimum;
        }
        if (devInfo.hasOwnProperty('maximum')) {
          property.maximum = devInfo.maximum;
        }
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
    property.bindNeeded = property.configReportNeeded;

    DEBUG && console.log('addProperty:   ',
                         'bindNeeded:', property.bindNeeded,
                         'configReportNeeded:', property.configReportNeeded,
                         'initialReadNeeded:', property.initialReadNeeded);

    return property;
  }

  // internal function allows us to use early returns.
  classifyInternal(node) {
    const seMeteringEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.SEMETERING_HEX);
    const haElectricalEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.HAELECTRICAL_HEX);

    const genBinaryInputEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.GENBINARYINPUT_HEX);
    const genLevelCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.GENLEVELCTRL_HEX);
    const genLevelCtrlOutputEndpoint =
      node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID.GENLEVELCTRL_HEX);
    const genOnOffEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.GENONOFF_HEX);
    const genOnOffOutputEndpoint =
      node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID.GENONOFF_HEX);
    const doorLockEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.DOORLOCK_HEX);
    const msOccupancySensingEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.OCCUPANCY_SENSOR_HEX);
    const msTemperatureEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.TEMPERATURE_HEX);
    const illuminanceEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.ILLUMINANCE_MEASUREMENT_HEX);
    const genPowerCfgEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.GENPOWERCFG_HEX);
    const genDeviceTempCfgEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID.GENDEVICETEMPCFG_HEX);
    const lightLinkEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.LIGHTLINK_HEX);
    const ssIasZoneEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID.SSIASZONE_HEX);
    node.ssIasZoneEndpoint = ssIasZoneEndpoint;

    if (DEBUG) {
      console.log('---- Zigbee classifier -----');
      console.log('                   modelId =', node.modelId);
      console.log('        seMeteringEndpoint =', seMeteringEndpoint);
      console.log('      haElectricalEndpoint =', haElectricalEndpoint);
      console.log('    genBinaryInputEndpoint =', genBinaryInputEndpoint);
      console.log('      genLevelCtrlEndpoint =', genLevelCtrlEndpoint);
      console.log('genLevelCtrlOutputEndpoint =', genLevelCtrlOutputEndpoint);
      console.log('          genOnOffEndpoint =', genOnOffEndpoint);
      console.log('    genOnOffOutputEndpoint =', genOnOffOutputEndpoint);
      console.log('          doorLockEndpoint =', doorLockEndpoint);
      console.log('    lightingContolEndpoint =',
                  node.lightingColorCtrlEndpoint);
      console.log('         colorCapabilities =', node.colorCapabilities);
      console.log('                 colorMode =', node.colorMode);
      console.log('         lightLinkEndpoint =', lightLinkEndpoint);
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

    if (haElectricalEndpoint &&
        !lightLinkEndpoint &&
        !node.lightingColorCtrlEndpoint) {
      this.initHaSmartPlug(node, haElectricalEndpoint, genLevelCtrlEndpoint);
      return;
    }
    if (seMeteringEndpoint &&
        !lightLinkEndpoint &&
        !node.lightingColorCtrlEndpoint) {
      this.initSeSmartPlug(node, seMeteringEndpoint, genLevelCtrlEndpoint);
      return;
    }
    if (genLevelCtrlEndpoint) {
      this.initMultiLevelSwitch(node, genLevelCtrlEndpoint, lightLinkEndpoint);
      return;
    }
    if (genOnOffEndpoint) {
      this.initOnOffSwitch(node, genOnOffEndpoint);
      return;
    }
    if (genLevelCtrlOutputEndpoint) {
      this.initMultiLevelButton(node, genLevelCtrlOutputEndpoint);
      return;
    }
    if (doorLockEndpoint) {
      this.initDoorLock(node, doorLockEndpoint);
      return;
    }
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
    let zoneType = node.zoneType;
    if (zoneType == 0 && ZONE_TYPE_ZERO.hasOwnProperty(node.modelId)) {
      zoneType = ZONE_TYPE_ZERO[node.modelId];
    }
    if (ZONE_TYPE_NAME.hasOwnProperty(zoneType)) {
      name = ZONE_TYPE_NAME[zoneType].name;
      node['@type'] = ZONE_TYPE_NAME[zoneType]['@type'];
      propertyName = ZONE_TYPE_NAME[zoneType].propertyName;
      propertyDescr = ZONE_TYPE_NAME[zoneType].propertyDescr;
    } else if (zoneType == 0x8000) {
      // The SmartThings button has a zoneType of 0x8000
      node.type = 'thing';
      node['@type'] = ['PushButton'];
      this.addEvents(node, {
        pressed: {
          '@type': 'PressedEvent',
          description: 'Button pressed and released quickly',
        },
        doublePressed: {
          '@type': 'DoublePressedEvent',
          description: 'Button pressed and released twice quickly',
        },
        longPressed: {
          '@type': 'LongPressedEvent',
          description: 'Button pressed and held',
        },
      });
      name = 'button';
      propertyName = null;
      propertyDescr = null;
    } else {
      // This is basically 'just in case' (or unknown zoneType=0)
      name = 'thing';
      node['@type'] = ['BinarySensor'];
      propertyName = 'on';
      propertyDescr = {
        '@type': 'BooleanProperty',
        type: 'boolean',
        label: `ZoneType${zoneType}`,
        descr: `ZoneType${zoneType}`,
      };
    }
    node.name = `${node.id}-${name}`;

    this.addZoneTypeProperty(node, propertyName, propertyDescr);
  }

  initDoorLock(node, doorLockEndpoint) {
    // TODO: Replace with DoorLock type
    node.type = Constants.THING_TYPE_ON_OFF_SWITCH;
    node['@type'] = ['BinarySensor']; // TODO: Replace woth DoorLock type
    node.name = `${node.id}-doorlock`;
    this.addDoorLockedProperty(node, doorLockEndpoint);
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

  initMultiLevelSwitch(node, genLevelCtrlEndpoint, lightLinkEndpoint) {
    let colorSupported = false;
    const colorCapabilities = (node.hasOwnProperty('colorCapabilities') &&
                                node.colorCapabilities) || 0;
    const colorMode = (node.hasOwnProperty('colorMode') &&
                        node.colorMode) || 0;
    if (lightLinkEndpoint || node.lightingColorCtrlEndpoint) {
      // It looks like a
      if ((colorCapabilities &
           (COLOR_CAPABILITY.HUE_SAT | COLOR_CAPABILITY.XY)) != 0) {
        // Hue and Saturation (or XY) are supported
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
      if ((colorCapabilities & COLOR_CAPABILITY.HUE_SAT) != 0) {
        this.addColorProperty(node, node.lightingColorCtrlEndpoint);
      } else if ((colorCapabilities & COLOR_CAPABILITY.XY) != 0) {
        this.addColorXYProperty(node, node.lightingColorCtrlEndpoint);
      }
    } else {
      if ((colorCapabilities & COLOR_CAPABILITY.TEMPERATURE) != 0 ||
          (colorMode & COLOR_MODE.TEMPERATURE) != 0) {
        // Color temperature is basically a specialized way of selecting
        // a color, so we don't include this property with full-color
        // bulbs.
        this.addColorTemperatureProperty(node, node.lightingColorCtrlEndpoint);
      }
      if (lightLinkEndpoint) {
        this.addBrightnessProperty(node, genLevelCtrlEndpoint);
      } else {
        this.addLevelProperty(node, genLevelCtrlEndpoint);
      }
    }
  }

  initMultiLevelButton(node, genLevelCtrlOutputEndpoint) {
    node.name = `${node.id}-button`;
    node.type = 'multiLevelSwitch';
    node['@type'] = ['OnOffSwitch', 'MultiLevelSwitch', 'PushButton'];
    this.addButtonOnProperty(node, genLevelCtrlOutputEndpoint);
    this.addButtonLevelProperty(node, genLevelCtrlOutputEndpoint);
    this.addEvents(node, {
      '1-pressed': {
        '@type': 'PressedEvent',
        description: 'Top button pressed and released',
      },
      '2-pressed': {
        '@type': 'PressedEvent',
        description: 'Bottom button pressed and released',
      },
      '1-longPressed': {
        '@type': 'LongPressedEvent',
        description: 'Top button pressed and held',
      },
      '2-longPressed': {
        '@type': 'LongPressedEvent',
        description: 'Bottom button pressed and held',
      },
      '1-released': {
        '@type': 'ReleasedEvent',
        description: 'Top button released (after being held)',
      },
      '2-released': {
        '@type': 'ReleasedEvent',
        description: 'Bottom button released (after being held)',
      },
    });
  }

  initHaSmartPlug(node, haElectricalEndpoint, genLevelCtrlEndpoint) {
    node.type = Constants.THING_TYPE_SMART_PLUG;
    node['@type'] = ['OnOffSwitch', 'SmartPlug', 'EnergyMonitor'];
    this.addOnProperty(node, haElectricalEndpoint);
    if (genLevelCtrlEndpoint) {
      const endpoint = node.activeEndpoints[genLevelCtrlEndpoint];
      if (endpoint.deviceId != DEVICE_ID.ONOFFSWITCH_HEX &&
          endpoint.deviceId != DEVICE_ID.ONOFFOUTPUT_HEX) {
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

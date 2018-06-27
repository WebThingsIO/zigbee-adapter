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

const CLUSTER_ID_GENBINARYINPUT = zclId.cluster('genBinaryInput').value;
const CLUSTER_ID_GENBINARYINPUT_HEX =
  utils.hexStr(CLUSTER_ID_GENBINARYINPUT, 4);
const CLUSTER_ID_GENLEVELCTRL = zclId.cluster('genLevelCtrl').value;
const CLUSTER_ID_GENLEVELCTRL_HEX = utils.hexStr(CLUSTER_ID_GENLEVELCTRL, 4);
const CLUSTER_ID_GENONOFF = zclId.cluster('genOnOff').value;
const CLUSTER_ID_GENONOFF_HEX = utils.hexStr(CLUSTER_ID_GENONOFF, 4);
const CLUSTER_ID_HAELECTRICAL = zclId.cluster('haElectricalMeasurement').value;
const CLUSTER_ID_HAELECTRICAL_HEX = utils.hexStr(CLUSTER_ID_HAELECTRICAL, 4);
const CLUSTER_ID_LIGHTINGCOLORCTRL = zclId.cluster('lightingColorCtrl').value;
const CLUSTER_ID_LIGHTLINK = zclId.cluster('lightLink').value;
const CLUSTER_ID_LIGHTLINK_HEX = utils.hexStr(CLUSTER_ID_LIGHTLINK, 4);
const CLUSTER_ID_OCCUPANCY_SENSOR = zclId.cluster('msOccupancySensing').value;
const CLUSTER_ID_OCCUPANCY_SENSOR_HEX =
  utils.hexStr(CLUSTER_ID_OCCUPANCY_SENSOR, 4);
const CLUSTER_ID_SSIASZONE = zclId.cluster('ssIasZone').value;
const CLUSTER_ID_TEMPERATURE = zclId.cluster('msTemperatureMeasurement').value;
const CLUSTER_ID_TEMPERATURE_HEX = utils.hexStr(CLUSTER_ID_TEMPERATURE, 4);
const CLUSTER_ID_SEMETERING = zclId.cluster('seMetering').value;
const CLUSTER_ID_SEMETERING_HEX = utils.hexStr(CLUSTER_ID_SEMETERING, 4);

const DEBUG = false;

// From the ZigBee Cluster Library Specification, document 07-5123-06,
// Revision 6, Draft Version 1.0.
// Table 8-5 - Values of the ZoneType Attribute
const ZONE_TYPE_NAME = {
  0x000d: {name: 'motion', descr: 'Motion Sensor'},
  0x0015: {name: 'switch', descr: 'Contact Switch'},
  0x0028: {name: 'fire', descr: 'Fire Sensor'},
  0x002a: {name: 'water', descr: 'Water Sensor'},
  0x002b: {name: 'co', descr: 'Carbon Monoxide Sensor'},
  0x002c: {name: 'ped', descr: 'Personal Emergency Device'},
  0x002d: {name: 'vibration', descr: 'Vibration/Movement Sensor'},
  0x010f: {name: 'remote-panic', descr: 'Remote Control'},
  0x0115: {name: 'keyfob-panic', descr: 'Keyfob'},
  0x021d: {name: 'keypad-panic', descr: 'Keypad'},
  0x0226: {name: 'glass', descr: 'Glass Break Sensor'},
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
    this.addProperty(
      node,                           // device
      '_level',                       // name
      {                               // property description
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
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
      ZHA_PROFILE_ID,                 // profileId
      lightingColorCtrlEndpoint,      // endpoint
      CLUSTER_ID_LIGHTINGCOLORCTRL,   // clusterId
      'currentHue,currentSaturation', // attr
      'setColorValue',                // setAttrFromValue
      'parseColorAttr'                // parseValueFromAttr
    );
  }

  addBrightnessProperty(node, genLevelCtrlEndpoint) {
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
      ZHA_PROFILE_ID,                 // profileId
      genLevelCtrlEndpoint,           // endpoint
      CLUSTER_ID_GENLEVELCTRL,        // clusterId
      'currentLevel',                 // attr
      'setLevelValue',                // setAttrFromValue
      'parseLevelAttr'                // parseValueFromAttr
    );
  }

  addLevelProperty(node, genLevelCtrlEndpoint) {
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
      ZHA_PROFILE_ID,                 // profileId
      genLevelCtrlEndpoint,           // endpoint
      CLUSTER_ID_GENLEVELCTRL,        // clusterId
      'currentLevel',                 // attr
      'setLevelValue',                // setAttrFromValue
      'parseLevelAttr'                // parseValueFromAttr
    );
  }

  addOnProperty(node, genOnOffEndpoint) {
    this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'OnOffProperty',
        label: 'On/Off',
        type: 'boolean',
      },
      ZHA_PROFILE_ID,                 // profileId
      genOnOffEndpoint,               // endpoint
      CLUSTER_ID_GENONOFF,            // clusterId
      'onOff',                        // attr
      'setOnOffValue',                // setAttrFromValue
      'parseOnOffAttr'                // parseValueFromAttr
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
      'parseOnOffAttr'                // parseValueFromAttr
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
      'parseNumericAttr'              // parseValueFromAttr
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
      'parseNumericAttr'              // parseValueFromAttr
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
      'parseHaCurrentAttr'            // parseValueFromAttr
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
      'parseNumericAttr'              // parseValueFromAttr
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
      'parseNumericAttr'              // parseValueFromAttr
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
      haElectricalEndpoint,           // endpoint
      CLUSTER_ID_HAELECTRICAL,        // clusterId
      'activePower',                  // attr
      '',                             // setAttrFromValue
      'parseHaInstantaneousPowerAttr' // parseValueFromAttr
    );
  }

  addHaVoltageProperty(node, haElectricalEndpoint) {
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
      'parseNumericAttr'              // parseValueFromAttr
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
      'parseSeInstantaneousPowerAttr' // parseValueFromAttr
    );
  }

  addOccupancySensorProperty(node, msOccupancySensingEndpoint) {
    this.addProperty(
      node,                           // device
      'occupied',                     // name
      {                               // property description
        '@type': 'BooleanProperty',
        label: 'Occupied',
        type: 'boolean',
      },
      ZHA_PROFILE_ID,                 // profileId
      msOccupancySensingEndpoint,     // endpoint
      CLUSTER_ID_OCCUPANCY_SENSOR,    // clusterId
      'occupancy',                    // attr
      '',                             // setAttrFromValue
      'parseOccupiedAttr'             // parseValueFromAttr
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

  addTemperatureSensorProperty(node, msTemperatureEndpoint) {
    this.addProperty(
      node,                           // device
      '_minTemp',                     // name
      {                               // property description
        type: 'number',
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
        // TODO: add proper @type here
        label: 'Temperature',
        type: 'number',
      },
      ZHA_PROFILE_ID,                 // profileId
      msTemperatureEndpoint,          // endpoint
      CLUSTER_ID_TEMPERATURE,         // clusterId
      'measuredValue',                // attr
      '',                             // setAttrFromValue
      'parseTemperatureMeasurementAttr' // parseValueFromAttr
    );
  }

  addZoneTypeProperty(node, name, descr) {
    this.addProperty(
      node,                           // device
      'on',                           // name
      {                               // property description
        '@type': 'BooleanProperty',
        type: 'boolean',
        descr: descr,
      },
      ZHA_PROFILE_ID,                 // profileId
      node.ssIasZoneEndpoint,         // endpoint
      CLUSTER_ID_SSIASZONE,           // clusterId
      '',                             // attr
      '',                             // setAttrFromValue
      ''                              // parseValueFromAttr
    );
  }

  addProperty(node, name, descr, profileId, endpoint, clusterId,
              attr, setAttrFromValue, parseValueFromAttr) {
    const property = new ZigbeeProperty(node, name, descr, profileId,
                                        endpoint, clusterId, attr,
                                        setAttrFromValue, parseValueFromAttr);
    node.properties.set(name, property);
    if (name[0] == '_') {
      property.visible = false;
      // Right now, hidden attributes aren't things that change their value
      // so we don't need to report changes.
    } else if (attr) {
      this.appendFrames([
        node.makeConfigReportFrame(property),
      ]);
    }
    if (attr) {
      this.appendFrames([
        node.makeReadAttributeFrameForProperty(property),
      ]);
    }
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
    const genOnOffEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);
    // const genOnOffOutputEndpoint =
    //   node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);
    const msOccupancySensingEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(
        CLUSTER_ID_OCCUPANCY_SENSOR_HEX);
    const msTemperatureEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_TEMPERATURE_HEX);

    if (DEBUG) {
      console.log('---- Zigbee classifier -----');
      console.log('    seMeteringEndpoint =', seMeteringEndpoint);
      console.log('  haElectricalEndpoint =', haElectricalEndpoint);
      console.log('genBinaryInputEndpoint =', genBinaryInputEndpoint);
      console.log('  genLevelCtrlEndpoint =', genLevelCtrlEndpoint);
      console.log('      genOnOffEndpoint =', genOnOffEndpoint);
      // console.log('genOnOffOutputEndpoint =', genOnOffOutputEndpoint);
      console.log('     colorCapabilities =', node.colorCapabilities);
      console.log('msOccupancySensingEndpoint =', msOccupancySensingEndpoint);
      console.log('     msTemperatureEndpoint =', msTemperatureEndpoint);
      console.log('                  zoneType =', node.zoneType);
    }

    if (msTemperatureEndpoint) {
      this.addTemperatureSensorProperty(node, msTemperatureEndpoint);
    }

    if (typeof node.zoneType !== 'undefined') {
      this.initBinarySensorFromZoneType(node);
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
    if (genBinaryInputEndpoint) {
      this.initBinarySensor(node, genBinaryInputEndpoint);
      // return;
    }
    // The linter complains if the above return is present.
    // Uncomment this return if you add any code here.
  }

  classify(node) {
    if (node.isCoordinator) {
      return;
    }
    node.type = 'thing'; // Replace with THING_TYPE_THING once it exists

    this.classifyInternal(node);
    DEBUG && console.log('Initialized as', node.type);
    node.sendFrames(node.addBindFramesFor(this.frames));
    this.frames = [];

    // Now that we know the type, set the default name.
    node.defaultName = `${node.id}-${node.type}`;
    if (!node.name) {
      node.name = node.defaultName;
    }
  }

  initBinarySensor(node, endpointNum) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    node['@type'] = ['BinarySensor'];
    this.addPresentValueProperty(node, endpointNum);
  }

  initBinarySensorFromZoneType(node) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    node['@type'] = ['BinarySensor'];
    let name = 'thing';
    let descr = '';
    if (ZONE_TYPE_NAME.hasOwnProperty(node.zoneType)) {
      name = ZONE_TYPE_NAME[node.zoneType].name;
      descr = ZONE_TYPE_NAME[node.zoneType].descr;
    }
    node.name = `${node.id}-${name}`;

    this.addZoneTypeProperty(node, name, descr);
  }

  initOnOffSwitch(node, genOnOffEndpoint) {
    node.type = Constants.THING_TYPE_ON_OFF_SWITCH;
    node['@type'] = ['OnOffSwitch'];
    this.addOnProperty(node, genOnOffEndpoint);
  }

  initMultiLevelSwitch(node, genLevelCtrlEndpoint) {
    const lightLinkEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_LIGHTLINK_HEX);
    if (DEBUG) {
      console.log('     lightLinkEndpoint =', lightLinkEndpoint);
    }
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
      this.addLevelProperty(node, genLevelCtrlEndpoint);
      node['@type'].push('MultiLevelSwitch');
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

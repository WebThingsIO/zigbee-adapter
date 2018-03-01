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

const CLUSTER_ID_GENONOFF = zclId.cluster('genOnOff').value;
const CLUSTER_ID_GENONOFF_HEX = utils.hexStr(CLUSTER_ID_GENONOFF, 4);
const CLUSTER_ID_GENLEVELCTRL = zclId.cluster('genLevelCtrl').value;
const CLUSTER_ID_GENLEVELCTRL_HEX = utils.hexStr(CLUSTER_ID_GENLEVELCTRL, 4);
const CLUSTER_ID_HAELECTRICAL = zclId.cluster('haElectricalMeasurement').value;
const CLUSTER_ID_HAELECTRICAL_HEX = utils.hexStr(CLUSTER_ID_HAELECTRICAL, 4);
const CLUSTER_ID_LIGHTINGCOLORCTRL = zclId.cluster('lightingColorCtrl').value;
const CLUSTER_ID_LIGHTLINK = zclId.cluster('lightLink').value;
const CLUSTER_ID_LIGHTLINK_HEX = utils.hexStr(CLUSTER_ID_LIGHTLINK, 4);
const CLUSTER_ID_SEMETERING = zclId.cluster('seMetering').value;
const CLUSTER_ID_SEMETERING_HEX = utils.hexStr(CLUSTER_ID_SEMETERING, 4);

const DEBUG = false;

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

  addLevelProperty(node, genLevelCtrlEndpoint) {
    this.addProperty(
      node,                           // device
      'level',                        // name
      {                               // property description
        type: 'number',
        unit: 'percent',
        min: 0,
        max: 100,
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

  addProperty(node, name, descr, profileId, endpoint, clusterId,
              attr, setAttrFromValue, parseValueFromAttr) {
    let property =  new ZigbeeProperty(node, name, descr, profileId,
                                       endpoint, clusterId, attr,
                                       setAttrFromValue, parseValueFromAttr);
    node.properties.set(name, property);
    if (name[0] == '_') {
      property.visible = false;
      // Right now, hidden attributes aren't things that change their value
      // so we don't need to report changes.
    } else {
      this.appendFrames([
        node.makeConfigReportFrame(property),
      ]);
    }
    this.appendFrames([
      node.makeReadAttributeFrameForProperty(property)
    ]);
  }

  // internal function allows us to use early returns.
  classifyInternal(node) {
    let seMeteringEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_SEMETERING_HEX);
    let haElectricalEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_HAELECTRICAL_HEX);

    let genLevelCtrlEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENLEVELCTRL_HEX);
    let genOnOffEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);
    let genOnOffOutputEndpoint =
      node.findZhaEndpointWithOutputClusterIdHex(CLUSTER_ID_GENONOFF_HEX);

    if (DEBUG) {
      console.log('---- Zigbee classifier -----');
      console.log('    seMeteringEndpoint =', seMeteringEndpoint);
      console.log('  haElectricalEndpoint =', haElectricalEndpoint);
      console.log('  genLevelCtrlEndpoint =', genLevelCtrlEndpoint);
      console.log('      genOnOffEndpoint =', genOnOffEndpoint);
      console.log('genOnOffOutputEndpoint =', genOnOffOutputEndpoint);
      console.log('     colorCapabilities =', node.colorCapabilities);
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
    if (genOnOffOutputEndpoint) {
      // Switches have both input and output clusters for genOnOff where a
      // sensor only has an output cluster.
      this.initBinarySensor(node, genOnOffOutputEndpoint);
      return;
    }
  }

  classify(node) {
    if (node.isCoordinator) {
      return;
    }

    this.classifyInternal(node);
    DEBUG && console.log('Initialized as', node.type);
    node.sendFrames(node.addBindFramesFor(this.frames));
    this.frames = [];

    // Now that we know the type, set the default name.
    node.defaultName = node.id + '-' + node.type;
    if (!node.name) {
      node.name = node.defaultName;
    }
  }

  initBinarySensor(node, endpointNum) {
    node.type = Constants.THING_TYPE_BINARY_SENSOR;
    this.addOnProperty(node, endpointNum);
  }

  initOnOffSwitch(node, genOnOffEndpoint) {
    node.type = Constants.THING_TYPE_ON_OFF_SWITCH;
    this.addOnProperty(node, genOnOffEndpoint);
  }

  initMultiLevelSwitch(node, genLevelCtrlEndpoint) {
    let lightLinkEndpoint =
      node.findZhaEndpointWithInputClusterIdHex(CLUSTER_ID_LIGHTLINK_HEX);
    if (DEBUG) {
      console.log('     lightLinkEndpoint =', lightLinkEndpoint);
    }
    let colorSupported = false;
    if (lightLinkEndpoint) {
      if ((node.colorCapabilities & 3) != 0) {
        // Hue and Saturation are supported
        colorSupported = true;
        node.type = Constants.THING_TYPE_ON_OFF_COLOR_LIGHT;
      } else {
        node.type = Constants.THING_TYPE_DIMMABLE_LIGHT;
      }
    } else {
      node.type = Constants.THING_TYPE_MULTI_LEVEL_SWITCH;
    }
    this.addOnProperty(node, genLevelCtrlEndpoint);
    if (colorSupported) {
      this.addColorProperty(node, node.lightingColorCtrlEndpoint);
    } else {
      this.addLevelProperty(node, genLevelCtrlEndpoint);
    }
  }

  initHaSmartPlug(node, haElectricalEndpoint, genLevelCtrlEndpoint) {
    node.type = Constants.THING_TYPE_SMART_PLUG;
    this.addOnProperty(node, haElectricalEndpoint);
    if (genLevelCtrlEndpoint) {
      this.addLevelProperty(node, genLevelCtrlEndpoint);
    }
    this.addHaInstantaneousPowerProperty(node, haElectricalEndpoint);
    this.addHaCurrentProperty(node, haElectricalEndpoint);
    this.addHaFrequencyProperty(node, haElectricalEndpoint);
    this.addHaVoltageProperty(node, haElectricalEndpoint);
  }

  initSeSmartPlug(node, seMeteringEndpoint, genLevelCtrlEndpoint) {
    node.type = Constants.THING_TYPE_SMART_PLUG;
    this.addOnProperty(node, seMeteringEndpoint);
    if (genLevelCtrlEndpoint) {
      this.addLevelProperty(node, genLevelCtrlEndpoint);
    }
    this.addSeInstantaneousPowerProperty(node, seMeteringEndpoint);
  }
}

module.exports = new ZigbeeClassifier();

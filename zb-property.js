/**
 * Zigbee Property.
 *
 * Object which decscribes a property, and its value.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const Color = require('color');
const zclId = require('zcl-id');

const {Deferred, Property, Utils} = require('gateway-addon');
const {
  ATTR_ID,
  HVAC_FAN_MODE,
  THERMOSTAT_RUN_MODE,
  THERMOSTAT_SYSTEM_MODE,
  THERMOSTAT_STATE,
} = require('./zb-constants');

const {DEBUG_property} = require('./zb-debug');
const DEBUG = DEBUG_property;

/**
 * @function levelToPercent
 *
 * Converts a light level in the range 0-254 into a percentage using
 * linear interpolation.
 */
function levelToPercent(level) {
  if (level < 1) {
    return 0;
  }
  return Math.min(level * 100 / 254, 100);
}

/**
 * @function percentToLevel
 *
 * Inverse of the levelToPercent function. Takes a percentage in the range
 * 0-100 and converts it into a level in the range 0-254.
 */
function percentToLevel(percent) {
  if (percent < 0.1) {
    return 0;
  }
  return Math.min(Math.round(percent * 254 / 100), 254);
}

class ZigbeeProperty extends Property {
  constructor(device, name, propertyDescr, profileId, endpoint, clusterId, attr,
              setAttrFromValue, parseValueFromAttr) {
    super(device, name, propertyDescr);

    if (propertyDescr.hasOwnProperty('enum')) {
      this.enum = propertyDescr.enum;
    }

    this.profileId = profileId;
    if (typeof endpoint === 'string') {
      this.endpoint = parseInt(endpoint);
    } else {
      this.endpoint = endpoint;
    }
    this.clusterId = clusterId;
    if (setAttrFromValue) {
      this.setAttrFromValue = Object.getPrototypeOf(this)[setAttrFromValue];
      if (!this.setAttrFromValue) {
        const err = `Unknown function: ${setAttrFromValue}`;
        console.error(err);
        throw err;
      }
    }
    if (parseValueFromAttr) {
      this.parseValueFromAttr = Object.getPrototypeOf(this)[parseValueFromAttr];
      if (!this.parseValueFromAttr) {
        const err = `Unknown function: ${parseValueFromAttr}`;
        console.error(err);
        throw err;
      }
    }
    const attrs = attr.split(',');
    if (attrs.length > 1) {
      this.attr = attrs;
      this.attrId = [];
      this.attrType = [];
      for (const attr of attrs) {
        this.attrId.push(zclId.attr(clusterId, attr).value);
        this.attrType.push(zclId.attrType(clusterId, attr).value);
      }
    } else {
      this.attr = attr;
      // The on property for IAS Zone devices don't have an attribute
      // so an empty string is used for attr in that case.
      if (attr) {
        this.attrId = zclId.attr(clusterId, attr).value;
        this.attrType = zclId.attrType(clusterId, attr).value;
      }
    }
    this.fireAndForget = false;
  }

  asDict() {
    const dict = super.asDict();
    dict.profileId = this.profileId;
    dict.endpoint = this.endpoint;
    dict.clusterId = this.clusterId;
    dict.attr = this.attr;
    dict.attrId = this.attrId;
    dict.value = this.value;
    dict.fireAndForget = this.fireAndForget;
    dict.bindNeeded = this.bindNeeded;
    dict.configReportNeeded = this.configReportNeeded;
    dict.initialReadNeeded = this.initialReadNeeded;
    if (this.hasOwnProperty('level')) {
      dict.level = this.level;
    }
    return dict;
  }

  /**
   * @method parseAttrEntry
   *
   * Parses the attribute data received via ZCL and converts it into
   * a property value.
   *
   * @param attrEntry - An attribute entry from the zcl-packet library
   *    readRsp which will look something like this:
   *    { attrId: 0, status: 0, dataType: 32, attrData: 254 }
   *
   *    attrId is a 16-bit attribute id.
   *    status is an 8-bit status indicating the success/failure of the read.
   *    dataType is an 8-bit field indicating the type of data.
   *    attrData contains the actual data.
   *
   *    The above fields can be examined symbolically using the zcl-id module:
   *    zclId.attr('genLevelCtrl', 0).key == 'currentLevel'
   *    zclId.status(0).key == 'success'
   *    zclId.dataType(32).key == 'uint8'
   *
   * @returns an array containing 2 entries. The first entry is the
   *    property value, and the second entry is a printable version
   *    suitable for logging.
   */

  parseAttrEntry(attrEntry) {
    // For readRsp, attrEntry includes a status, for report it doesn't
    if (typeof attrEntry.status !== 'undefined') {
      if (attrEntry.status != 0) {
        attrEntry.attrData = this.defaultValue;
      }
    }
    return this.parseValueFromAttr(attrEntry);
  }

  /**
   * @method parseColorAttr
   *
   * Converts the ZCL 'currentHue' and 'currentSaturation' attributes (uint8's)
   * into an RGB color string.
   */
  parseColorAttr(attrEntry) {
    if (attrEntry.attrId == ATTR_ID.LIGHTINGCOLORCTRL.CURRENTHUE) {
      // We expect that we'll always get the hue in one call, and
      // the saturation in a later call. For hue, we just record it.
      this.hue = (attrEntry.attrData / 254) * 360;
      return [];
    }
    if (attrEntry.attrId != ATTR_ID.LIGHTINGCOLORCTRL.CURRENTSATURATION) {
      return [];
    }
    const hue = this.hue;
    const sat = (attrEntry.attrData / 254) * 100;
    let level = 0;
    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      level = levelProperty.value;
    }
    const color = new Color({h: hue, s: sat, v: level});
    const colorStr = color.rgb().hex();
    console.log(`parseColorAttr: colorStr: ${colorStr}`,
                `hue:${hue} sat:${sat}, level:${level}`);
    return [colorStr, colorStr];
  }

  /**
   * @method parseColorXYAttr
   *
   * Converts the ZCL 'currentX' and 'currentY' attributes (uint8's)
   * into an RGB color string.
   */
  parseColorXYAttr(attrEntry) {
    if (attrEntry.attrId == ATTR_ID.LIGHTINGCOLORCTRL.CURRENTX) {
      // We expect that we'll always get the currentX in one call, and
      // the currentY in a later call. For currentX, we just record it.
      this.currentX = attrEntry.attrData;
      return [];
    }
    if (attrEntry.attrId != ATTR_ID.LIGHTINGCOLORCTRL.CURRENTY) {
      return [];
    }
    const currentX = this.currentX;
    const currentY = attrEntry.attrData;
    let level = 0;

    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      level = levelProperty.value;
    }

    // We get x, y, and level from the bulb. The x and y values come
    // from the xyY color space. So we do an initial conversion assuming
    // Y = 1, and come up with an RGB color. We then scale the RGB value
    // so that at least one of the rgb values is 255 and then scale the
    // the whole thing by the brightness.

    // Convert xyY values into XYZ and then RGB using the math presented here:
    // https://www.easyrgb.com/en/math.php

    const x = currentX / 65536;
    const y = currentY / 65536;

    let X = 0;
    let Z = 0;
    if (currentY > 0) {
      X = x / y;
      Z = (1 - x - y) / y;
    }

    const rgb1 = [
      X * 3.2406 + -1.5372 + Z * -0.4986,
      X * -0.9689 + 1.8758 + Z * 0.0415,
      X * 0.0557 + -0.2040 + Z * 1.0570,
    ];
    const rgb = rgb1.map((x) => {
      if (x > 0.0031308) {
        x = 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      } else {
        x = x * 12.92;
      }
      return Math.max(0, Math.min(255, Math.round(x * 255)));
    });
    // level is 0-100
    const scale = (255 * level / 100) / Math.max(...rgb);
    const rgbColor = new Color(rgb.map((x) => {
      return x * scale;
    }));
    const rgbHexStr = rgbColor.hex();
    return [rgbHexStr, rgbHexStr];
  }

  parseColorTemperatureAttr(attrEntry) {
    // NOTE: the zigbee attributes for color temperature are stored
    //       in units of mireds, which are inversly proportional to
    // degrees kelvin, which is why the min/max are reversed below.
    //
    // i.e. 6500K corresponds to a colorTempPhysicalMin = 153
    //      2700L corresponds to a colorTempPhysicalMax = 370

    let thingDescriptionUpdated = false;

    // We set the min/max here so that updated values get sent to the
    // gateway when we do the propertyChanged notification.
    if (!this.hasOwnProperty('maximum')) {
      const minColorTempProperty = this.device.findProperty('_minTemperature');
      if (minColorTempProperty && minColorTempProperty.value) {
        this.minimumMireds = minColorTempProperty.value; // mireds
        this.maximum = Math.trunc(1000000 / this.minimumMireds);
        thingDescriptionUpdated = true;
      }
    }
    if (!this.hasOwnProperty('minimum')) {
      const maxColorTempProperty = this.device.findProperty('_maxTemperature');
      if (maxColorTempProperty && maxColorTempProperty.value) {
        this.maximumMireds = maxColorTempProperty.value; // mireds
        this.minimum = Math.trunc(1000000 / this.maximumMireds);
        thingDescriptionUpdated = true;
      }
    }

    if (thingDescriptionUpdated) {
      this.device.handleDeviceDescriptionUpdated();
    }

    const colorTempMireds = attrEntry.attrData;
    const colorTemp = Math.trunc(1000000 / colorTempMireds);
    return [colorTemp, `${colorTemp}K (${colorTempMireds})`];
  }

  /**
   * @method parseLevelAttr
   *
   * Converts the ZCL 'currentLevel' attribute (a uint8) into
   * a 'level' property (a percentage).
   */
  parseLevelAttr(attrEntry) {
    this.level = attrEntry.attrData;
    const percent = levelToPercent(this.level);
    return [
      percent,
      `${percent.toFixed(1)}% (${this.level})`,
    ];
  }

  /**
   * @method parseHaCurrentAttr
   *
   * Converts the rmsCurrent attribute into current (amps)
   * for devices which support the haElectricalMeasurement cluster.
   */
  parseHaCurrentAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_currentMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_currentDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let current = 0;
    if (this.multiplier && this.divisor) {
      const rmsCurrent = attrEntry.attrData;
      current = rmsCurrent * this.multiplier / this.divisor;
    }
    return [current, `${current}`];
  }

  /**
   * @method parseHaInstantaneousPowerAttr
   *
   * Converts the instantaneousDemand attribute into power (watts)
   * for devices which support the haElectricalMeasurement cluster.
   */
  parseHaInstantaneousPowerAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_powerMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_powerDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let power = 0;
    if (this.multiplier && this.divisor) {
      const demand = attrEntry.attrData;
      // the units for haElectricalMeasurement are watts
      power = demand * this.multiplier / this.divisor;
    }
    return [power, `${power}`];
  }

  /**
   * @method parseHaVoltageAttr
   *
   * Converts the rmsVoltage attribute into voltage (volts)
   * for devices which support the haElectricalMeasurement cluster.
   */
  parseHaVoltageAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_voltageMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_voltageDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let voltage = 0;
    if (this.multiplier && this.divisor) {
      const rmsVoltage = attrEntry.attrData;
      voltage = rmsVoltage * this.multiplier / this.divisor;
    }
    return [voltage, `${voltage}`];
  }

  /**
   * @method parseSeInstantaneousPowerAttr
   *
   * Converts the instantaneousDemand attribute into power (watts)
   * for devices which support the seMetering cluster.
   */
  parseSeInstantaneousPowerAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_multiplier');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_divisor');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let power = 0;
    if (this.multiplier && this.divisor) {
      const demand = attrEntry.attrData;
      // the units for seMetering are kilowatts, so we multiple by 1000
      // to convert to watts.
      power = demand * this.multiplier * 1000 / this.divisor;
    }
    return [power, `${power}`];
  }

  /**
   * @method parseSeCurrentSummDeliveredAttr
   *
   * Converts the currentSummDelivered counter value stored in watts into
   * kilowatts for devices which support the seMetering cluster.
   */
  parseSeCurrentSummDeliveredAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_counterMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      } else {
        this.divisor = 1;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_counterDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      } else {
        this.divisor = 1000;
      }
    }

    let counter = 0;
    if (this.multiplier && this.divisor) {
      const rawValue = parseInt(attrEntry.attrData);
      counter = rawValue * this.multiplier / this.divisor;
    }
    return [counter, `${counter}`];
  }

  attrToIlluminance(measuredValue) {
    if (measuredValue > 0) {
      return Math.pow(10, (measuredValue - 1) / 10000);
    }
    return 0;
  }

  /**
   * @method parseDoorLockedAttr
   *
   * Converts the ZCL 'lockState' attribute into the 'locked' property.
   */
  parseDoorLockedAttr(attrEntry) {
    // The lockstate actually has 3 values.
    // 0 - not fully locked
    // 1 - Locked
    // 2 - Unlocked
    // We're currently usiong a boolean.
    const propertyValue = attrEntry.attrData != 2;
    return [
      propertyValue,
      `${(propertyValue ? 'locked' : 'unlocked')} (${attrEntry.attrData})`,
    ];
  }

  /**
   * @method parseEnumAttr
   *
   * Converts a thermostat mode attribute into a property value (string).
   */
  parseEnumAttr(attrEntry) {
    const attrData = attrEntry.attrData;
    let propertyValue;

    if (this.hasOwnProperty('enum') && attrData < this.enum.length) {
      propertyValue = this.enum[attrData];
    } else {
      propertyValue = attrData.toString();
    }
    return [
      propertyValue,
      `${propertyValue} (${attrData})`,
    ];
  }

  /**
   * @method parseFanModeAttr
   *
   * Parses the fan mode attribute as a property.
   */
  parseFanModeAttr(attrEntry) {
    let attrData = attrEntry.attrData;
    if (attrData >= HVAC_FAN_MODE.length) {
      attrData = 0;
    }
    const propertyValue = HVAC_FAN_MODE[attrData];
    return [
      propertyValue,
      `${propertyValue} (${attrData})`,
    ];
  }

  /**
   * @method parseIlluminanceMeasurementAttr
   *
   * Parses the temperature attribute as a property.
   */
  parseIlluminanceMeasurementAttr(attrEntry) {
    if (!this.hasOwnProperty('minimum')) {
      const minProperty = this.device.findProperty('_minIlluminance');
      if (minProperty && minProperty.value) {
        this.minimum = this.attrToIlluminance(minProperty.value);
      }
    }
    if (!this.hasOwnProperty('maximum')) {
      const maxProperty = this.device.findProperty('_maxIlluminance');
      if (maxProperty && maxProperty.value) {
        this.maximum = this.attrToIlluminance(maxProperty.value);
      }
    }
    let illuminance = 0;
    const measuredValue = attrEntry.attrData;
    // A measuredValue of 0 is interpreted as "too low to measure".
    if (measuredValue > 0) {
      illuminance = Math.pow(10, (measuredValue - 1) / 10000);
      if (this.hasOwnProperty('minimum')) {
        illuminance = Math.max(this.minimum, illuminance);
      }
      if (this.hasOwnProperty('maximum')) {
        illuminance = Math.min(this.maximum, illuminance);
      }
    }
    return [illuminance, `${illuminance.toFixed(0)} (${measuredValue})`];
  }

  /**
   * @method parseHalfPercentAttr
   *
   * Parses a percentage attribute into a property.
   */
  parseHalfPercentAttr(attrEntry) {
    let percentage = null;
    if (typeof attrEntry.attrData !== 'number') {
      console.error('zb-property.js/parseHalfPercentAttr:',
                    'expected attrEntry.attrData to be a number, found a ',
                    typeof attrEntry.attrData);
    } else if (attrEntry.attrData === 0xFF) {
      console.error('zb-property.js/parseHalfPercentAttr:',
                    'device reported "invalid value", 0xFF');
    } else {
      percentage = attrEntry.attrData / 2;
    }
    return [percentage, `${percentage} (${attrEntry.attrData})`];
  }

  attrToTemperature(measuredValue) {
    return measuredValue / 100;
  }

  /**
   * @method parseTemperatureMeasurementAttr
   *
   * Parses the temperature attribute as a property.
   */
  parseTemperatureMeasurementAttr(attrEntry) {
    if (!this.hasOwnProperty('minimum')) {
      const minTempProperty = this.device.findProperty('_minTemp');
      if (minTempProperty && minTempProperty.value) {
        this.minimum = this.attrToTemperature(minTempProperty.value);
      }
    }
    if (!this.hasOwnProperty('maximum')) {
      const maxTempProperty = this.device.findProperty('_maxTemp');
      if (maxTempProperty && maxTempProperty.value) {
        this.maximum = this.attrToTemperature(maxTempProperty.value);
      }
    }
    const measuredValue = attrEntry.attrData;
    let temperature = this.attrToTemperature(measuredValue);
    if (this.hasOwnProperty('minimum')) {
      temperature = Math.max(this.minimum, temperature);
    }
    if (this.hasOwnProperty('maximum')) {
      temperature = Math.min(this.maximum, temperature);
    }
    return [temperature, `${temperature.toFixed(1)} (${measuredValue})`];
  }

  /**
   * @method parseNumericAttr
   *
   * Converts generic numeric attributes in a number.
   */
  parseNumericAttr(attrEntry) {
    const value = attrEntry.attrData;
    return [value, `${value}`];
  }

  /**
   * @method parseNumericTenthsAttr
   *
   * Converts generic numeric attributes in a number, and divides
   * the number by 10.
   */
  parseNumericTenthsAttr(attrEntry) {
    const value = attrEntry.attrData / 10;
    return [value, `${value}`];
  }

  /**
   * @method parseNumericHundredthsAttr
   *
   * Converts generic numeric attributes in a number, and divides
   * the number by 100.
   */
  parseNumericHundredthsAttr(attrEntry) {
    const value = attrEntry.attrData / 100;
    return [value, `${value}`];
  }

  /**
   * @method parseOccupiedAttr
   *
   * Converts the ZCL 'occupied' attribute (a bit field) into the 'occupied'
   * property (a boolean).
   */
  parseOccupiedAttr(attrEntry) {
    const propertyValue = attrEntry.attrData != 0;
    const occupiedStr = (propertyValue ? 'occupied' : 'not occupied');
    return [propertyValue, `${occupiedStr} (${attrEntry.attrData})`];
  }

  /**
   * @method parseOccupancySensorTypeAttr
   *
   * Converts the ZCL 'occupied' attribute (a bit field) into the 'occupied'
   * property (a boolean).
   */
  parseOccupancySensorTypeAttr(attrEntry) {
    let type = 'unknown';
    switch (attrEntry.attrData) {
      case 0:
        type = 'PIR';
        break;
      case 1:
        type = 'ultrasonic';
        break;
      case 2:
        type = 'PIR+ultrasonic';
        break;
    }
    return [type, `${type} (${attrEntry.attrData})`];
  }

  /**
   * @method parseOnOffAttr
   *
   * Converts the ZCL 'onOff' attribute (a boolean) into the 'on' property
   * (a boolean).
   */
  parseOnOffAttr(attrEntry) {
    const propertyValue = attrEntry.attrData != 0;
    return [
      propertyValue,
      `${(propertyValue ? 'on' : 'off')} (${attrEntry.attrData})`,
    ];
  }

  /**
   * @method parseOffOnAttr
   *
   * Like parseOnOffAttr but inverted (0 = on, 1 = off)
   */
  parseOffOnAttr(attrEntry) {
    const propertyValue = attrEntry.attrData == 0;
    return [
      propertyValue,
      `${(propertyValue ? 'on' : 'off')} (${attrEntry.attrData})`,
    ];
  }

  /**
   * @method parseCubeNumericAttr
   *
   * Convert numeric state values to cube action
   */
  parseCubeNumericAttr(attrEntry) {
    let cubeAction = 'none';
    switch (attrEntry.attrData) {
      /* Shake/Clear State */
      case 0:
        cubeAction = 'shake';
        break;
      /* Wake Up */
      case 2:
        cubeAction = 'wakeup';
        break;
      /* Flip Cube 90° */
      case 65: case 66: case 68: case 69:
      case 72: case 74: case 75: case 77:
      case 80: case 81: case 83: case 84:
      case 89: case 90: case 92: case 93:
      case 96: case 98: case 99: case 101:
      case 104: case 105: case 107: case 108:
        cubeAction = 'flip90';
        break;
      /* Flip Cube 180° */
      case 128: case 129: case 130: case 131: case 132: case 133:
        cubeAction = 'flip180';
        break;
      /* Slide */
      case 256: case 258: case 259: case 261: case 260: case 257:
        cubeAction = 'slide';
        break;
      /* Tap */
      case 512: case 514: case 515: case 517: case 516: case 513:
        cubeAction = 'tap';
        break;
      default:
        cubeAction = `unknown (${attrEntry.attrData})`;
        break;
    }
    return [cubeAction, `${cubeAction}`];
  }

  /**
   * @method decodeCurrentCubeSide
   *
   * Decode the current side of the cube
   */
  decodeCurrentCubeSide(attrEntry) {
    const value = decodeByBitmask(attrEntry.attrData);

    function decodeByBitmask(value) {
      const MASK_TAP = 0x01FF;
      const MASK_SLIDE = 0xFF;
      const MASK_FLIP_180 = 0x7F;
      const MASK_FLIP_90 = 0x3F;
      const MASK_FLIP_90_TO_SIDE = 0x07;

      const masks = [
        MASK_TAP,
        MASK_SLIDE,
        MASK_FLIP_180,
      ];

      for (const mask of masks) {
        if (value & ~mask) {
          return value & mask;
        }
      }

      if (value & ~MASK_FLIP_90) {
        return value & MASK_FLIP_90_TO_SIDE;
      }

      return value;
    }

    return [value, `${value}`];
  }

  /**
   * @method parseThermostatRunModeAttr
   *
   * Converts a thermostat mode attribute into a property value (string).
   */
  parseThermostatRunModeAttr(attrEntry) {
    const mode = attrEntry.attrData;
    let modeStr;
    if (mode >= THERMOSTAT_RUN_MODE.length) {
      modeStr = mode.toString();
    } else {
      modeStr = THERMOSTAT_RUN_MODE[mode];
    }
    return [
      modeStr,
      `${modeStr} (${mode})`,
    ];
  }

  /**
   * @method parseThermostatSystemModeAttr
   *
   * Converts a thermostat mode attribute into a property value (string).
   */
  parseThermostatSystemModeAttr(attrEntry) {
    const mode = attrEntry.attrData;
    let modeStr;
    if (mode >= THERMOSTAT_SYSTEM_MODE.length) {
      modeStr = mode.toString();
    } else {
      modeStr = THERMOSTAT_SYSTEM_MODE[mode];
    }
    return [
      modeStr,
      `${modeStr} (${mode})`,
    ];
  }

  /**
   * @method parseThermostatStateAttr
   *
   * Converts a thermostat state attribute into a property value (string).
   */
  parseThermostatStateAttr(attrEntry) {
    const state = attrEntry.attrData;
    let stateStr = '';
    for (const idx in THERMOSTAT_STATE) {
      if (state & (1 << idx)) {
        if (stateStr.length > 0) {
          stateStr += ',';
        }
        stateStr += THERMOSTAT_STATE[idx];
      }
    }
    if (stateStr.length == 0) {
      stateStr = 'Off';
    }
    return [
      stateStr,
      `${stateStr} (${state})`,
    ];
  }

  setInitialReadNeeded() {
    if (!this.hasOwnProperty('initialReadNeeded')) {
      this.initialReadNeeded = false;
    }
    if (!this.attr) {
      // This property has no attributes which means that its event driven
      // and there is nothing that we can actually read.
      return;
    }
    if (!this.visible && typeof this.value != 'undefined') {
      // We already know the value for this invisible property,
      // no need to read it again.
      return;
    }
    this.initialReadNeeded = true;
  }

  /**
   * @method setColorValue
   *
   * Convert the 'color' property value (an RGB hex string) into hue
   * and saturation values.
   */
  setColorValue(propertyValue) {
    const color = new Color(propertyValue);
    const hsv = color.hsv().color;
    const hue = hsv[0];   // 0-359
    const sat = hsv[1];   // 0-100
    const level = hsv[2]; // 0-100

    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      const zclData = levelProperty.valueToZclData(level);
      this.device.sendZclFrameWaitExplicitRx(levelProperty, zclData);
    }

    const attrHue = Math.round(hue / 360 * 254);
    const attrSat = Math.round(sat / 100 * 254);
    console.log(`setColorValue: propertyValue: ${propertyValue}`,
                `hue:${hue}`,
                `sat:${sat}`,
                `level:${level}`,
                `attrHue:${attrHue}`,
                `attrSat:${attrSat}`);
    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToHueAndSaturation',
        payload: [attrHue,
                  attrSat,
                  10],  // 10ths of a second
      },
      `hsv: [${hue}, ${sat}, ${level}]`,
    ];
  }

  /**
   * @method setColorXYValue
   *
   * Convert the 'color' property value (an RGB hex string) into XY values.
   */
  setColorXYValue(propertyValue) {
    const color = new Color(propertyValue);

    // Convert RGB to XYZ and then to xyY. This uses the math presented
    // here: https://www.easyrgb.com/en/math.php

    const [r, g, b] = color.color.map((x) => {
      x = x / 255;
      if (x > 0.04045) {
        return Math.pow(((x + 0.055) / 1.055), 2.4) * 100;
      }
      return x / 0.1292;
    });

    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    const x = X / (X + Y + Z);
    const y = Y / (X + Y + Z);

    // xy are 0-1 and need to be scaled for Zigbee
    const currentX = Math.max(0, Math.min(65279, Math.round(x * 65536)));
    const currentY = Math.max(0, Math.min(65279, Math.round(y * 65536)));

    // Compute the level the same way that the RGB -> HSV conversion does.
    const level = Math.max(...color.color) * 100 / 255;
    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      this.device.sendZclFrameWaitExplicitRx(
        levelProperty,
        levelProperty.valueToZclData(level));
    }

    // Return the zigbee currentX and currentY
    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToColor',
        payload: [currentX, currentY],
      },
      `xyV: [${x.toFixed(3)}(${currentX}), ${y.toFixed(3)}(${currentY}),` +
      `${level}]`,
    ];
  }

  /**
   * @method setColorTemperatureValue
   *
   * Convert the color temperature property value (degrees K) into
   * the ZCL moveToColorTemperature, along with the color temperature
   * in mireds.
   */
  setColorTemperatureValue(propertyValue) {
    // NOTE: the zigbee attributes for color temperature are stored
    //       in units of mireds, which are inversly proportional to
    // degrees kelvin, which is why the min/max are reversed below.
    //
    // i.e. 6500K corresponds to a colorTempPhysicalMin = 153
    //      2700L corresponds to a colorTempPhysicalMax = 370

    if (!this.hasOwnProperty('maximum')) {
      const minColorTempProperty = this.device.findProperty('_minTemperature');
      if (minColorTempProperty && minColorTempProperty.value) {
        this.minimumMireds = minColorTempProperty.value; // mireds
        this.maximum = Math.trunc(1000000 / this.minimumMireds);
      }
    }
    if (!this.hasOwnProperty('minimum')) {
      const maxColorTempProperty = this.device.findProperty('_maxTemperature');
      if (maxColorTempProperty && maxColorTempProperty.value) {
        this.maximumMireds = maxColorTempProperty.value; // mireds
        this.minimum = Math.trunc(1000000 / this.maximumMireds);
      }
    }
    let colorTempMireds = Math.trunc(1000000 / propertyValue);
    if (this.hasOwnProperty('minimumMireds')) {
      colorTempMireds = Math.max(this.minimumMireds, colorTempMireds);
    }
    if (this.hasOwnProperty('maximumMireds')) {
      colorTempMireds = Math.min(this.maximumMireds, colorTempMireds);
    }
    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToColorTemp',
        payload: [colorTempMireds],
      },
      `colorTemp: ${colorTempMireds} (${propertyValue}K)`,
    ];
  }

  /**
   * @method setDoorLockedAttr
   *
   * Converts the 'locked' property value (a boolean) into the ZCL lock or
   * unlock commands.
   */
  setDoorLockedValue(propertyValue) {
    // propertyValue is a boolean
    const attr = propertyValue ? 'lockDoor' : 'unlockDoor';
    return [
      {
        frameCntl: {frameType: 1},
        cmd: attr,
        payload: [''],
      },
      attr,
    ];
  }

  /**
   * @method setFanModeValue
   *
   * Convert the 'fanMode' property value (an enumeration) into the ZCL
   * write command to set the fanMode sequence.
   */
  setFanModeValue(propertyValue) {
    let attrData = HVAC_FAN_MODE.indexOf(propertyValue);
    if (attrData < 0) {
      attrData = 0; // Off
    }
    return [
      {
        cmd: 'write',
        payload: [{
          attrId: this.attrId,
          dataType: this.attrType,
          attrData: attrData,
        }],
      },
      `${attrData} (${propertyValue})`,
    ];
  }

  /**
   * @method setLevelValue
   *
   * Convert the 'level' property value (a percentage) into the ZCL
   * 'moveToLevel' command along with a light level.
   */
  setLevelValue(propertyValue) {
    // propertyValue is a percentage 0-100
    if (this.hasOwnProperty('min') && propertyValue < this.min) {
      propertyValue = this.min;
    }
    if (this.hasOwnProperty('max') && propertyValue > this.max) {
      propertyValue = this.max;
    }
    this.level = percentToLevel(propertyValue);
    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToLevel',
        payload: [this.level],
      },
      `level: ${this.level} (${propertyValue.toFixed(1)}%)`,
    ];
  }

  /**
   * @method setOnOffValue
   *
   * Converts the 'on' property value (a boolean) into the ZCL on or off
   * command.
   */
  setOnOffValue(propertyValue) {
    // propertyValue is a boolean
    const attr = propertyValue ? 'on' : 'off';
    return [
      {
        frameCntl: {frameType: 1},
        cmd: attr,
      },
      attr,
    ];
  }

  /**
   * @method setOnOffWriteValue
   *
   * Converts the 'on' property value (a boolean) into the ZCL on or off
   * command.
   */
  setOnOffWriteValue(propertyValue) {
    // propertyValue is a boolean
    const attrData = propertyValue ? 1 : 0;
    return [
      {
        cmd: 'write',
        payload: [{
          attrId: this.attrId,
          dataType: this.attrType,
          attrData: attrData,
        }],
      },
      `${attrData} (${propertyValue})`,
    ];
  }

  /**
   * @method setWriteEnumValue
   *
   * Converts an enumeration into a ZCL write command to set
   * the attribute.
   */
  setWriteEnumValue(propertyValue) {
    let attrData = this.enum.indexOf(propertyValue);
    if (attrData < 0) {
      attrData = 0;
    }
    return [
      {
        cmd: 'write',
        payload: [{
          attrId: this.attrId,
          dataType: this.attrType,
          attrData: attrData,
        }],
      },
      `${attrData} (${propertyValue})`,
    ];
  }

  /**
   * @method setThermostatModeValue
   *
   * Converts the system mode or running mode property value (a string)
   * into the appropriate ZCL write command to set the attribute.
   */
  setThermostatSystemModeValue(propertyValue) {
    let attrData = THERMOSTAT_SYSTEM_MODE.indexOf(propertyValue);
    if (attrData < 0) {
      attrData = 0; // Off
    }
    return [
      {
        cmd: 'write',
        payload: [{
          attrId: this.attrId,
          dataType: this.attrType,
          attrData: attrData,
        }],
      },
      `${attrData} (${propertyValue})`,
    ];
  }

  /**
   * @method setThermostatTemperatureValue
   *
   * Converts a temperature (a number in degrees celsius)
   * into the appropriate ZCL write command to set the attribute.
   */
  setThermostatTemperatureValue(propertyValue) {
    const attrData = propertyValue * 100;
    return [
      {
        cmd: 'write',
        payload: [{
          attrId: this.attrId,
          dataType: this.attrType,
          attrData: attrData,
        }],
      },
      `${attrData} (${propertyValue})`,
    ];
  }

  /**
   * @returns a promise which resolves to the updated value.
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    if (!this.setAttrFromValue) {
      console.error('ZigbeeProperty:setValue: no setAttrFromValue');
      return Promise.resolve();
    }

    let deferredSet = this.deferredSet;
    if (!deferredSet) {
      deferredSet = new Deferred();
      this.deferredSet = deferredSet;
    }

    this.device.sendZclFrameWaitExplicitRxResolve(
      this, this.valueToZclData(value));
    return deferredSet.promise;
  }

  valueToZclData(value) {
    this.setCachedValue(value);

    const [zclData, logData] = this.setAttrFromValue(value);

    console.log('setProperty property:', this.name,
                'for:', this.device.name,
                'profileId:', Utils.hexStr(this.profileId, 4),
                'endpoint:', this.endpoint,
                'clusterId:', Utils.hexStr(this.clusterId, 4),
                'zcl:', logData,
                'value:', value);

    return zclData;
  }

  setMinimum(minimum) {
    if (this.hasOwnProperty('minimum') && this.minimum == minimum) {
      // No change detected - ignore
      return;
    }
    this.minimum = minimum;
    this.device.handleDeviceDescriptionUpdated();
  }

  setMaximum(maximum) {
    if (this.hasOwnProperty('maximum') && this.maximum == maximum) {
      // No change detected - ignore
      return;
    }
    this.maximum = maximum;
    this.device.handleDeviceDescriptionUpdated();
  }
}

if (DEBUG) {
  Object.getOwnPropertyNames(ZigbeeProperty.prototype).forEach((method) => {
    const baseMethod = ZigbeeProperty.prototype[method];
    if (method === 'constructor' || typeof baseMethod !== 'function') {
      return;
    }
    ZigbeeProperty.prototype[method] = function() {
      console.log(`ZigbeeProperty:${method} arguments: `, arguments);
      const result = baseMethod.apply(this, arguments);
      console.log(`ZigbeeProperty:${method} result: `, result);
      return result;
    };
  });
}

module.exports = ZigbeeProperty;

/**
 *
 * zb-constants - Exports constants used by the zigbee adapter.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const zclId = require('zcl-id');

const {Utils} = require('gateway-addon');

function addHexValues(dict) {
  for (const key in dict) {
    dict[`${key}_HEX`] = Utils.hexStr(dict[key], 4);
  }
}

const CLUSTER_ID = {
  DOORLOCK: zclId.cluster('closuresDoorLock').value,
  GENBASIC: zclId.cluster('genBasic').value,
  GENBINARYINPUT: zclId.cluster('genBinaryInput').value,
  GENDEVICETEMPCFG: zclId.cluster('genDeviceTempCfg').value,
  GENLEVELCTRL: zclId.cluster('genLevelCtrl').value,
  GENONOFF: zclId.cluster('genOnOff').value,
  GENOTA: zclId.cluster('genOta').value,
  GENPOLLCTRL: zclId.cluster('genPollCtrl').value,
  GENPOWERCFG: zclId.cluster('genPowerCfg').value,
  HAELECTRICAL: zclId.cluster('haElectricalMeasurement').value,
  ILLUMINANCE_MEASUREMENT: zclId.cluster('msIlluminanceMeasurement').value,
  LIGHTINGCOLORCTRL: zclId.cluster('lightingColorCtrl').value,
  LIGHTLINK: zclId.cluster('lightLink').value,
  OCCUPANCY_SENSOR: zclId.cluster('msOccupancySensing').value,
  SEMETERING: zclId.cluster('seMetering').value,
  SSIASZONE: zclId.cluster('ssIasZone').value,
  TEMPERATURE: zclId.cluster('msTemperatureMeasurement').value,
};
addHexValues(CLUSTER_ID);

const ATTR_ID = {};
function makeAttrIds(clusterName, attrIds) {
  const clusterId = CLUSTER_ID[clusterName];
  const attrDict = {};
  for (const attrName of attrIds) {
    attrDict[attrName.toUpperCase()] = zclId.attr(clusterId, attrName).value;
  }
  ATTR_ID[clusterName] = attrDict;
}
makeAttrIds('GENBASIC', [
  'zclVersion',   // 0
  'appVersion',   // 1
  'modelId',      // 5
  'powerSource',  // 7
]);
makeAttrIds('GENPOLLCTRL', [
  'checkinInterval',      // 0
  'longPollInterval',     // 1
  'shortPollInterval',    // 2
  'fastPollTimeout',      // 3
  'checkinIntervalMin',   // 4
  'longPollIntervalMin',  // 5
  'fastPollTimeoutMax',   // 6
]);
makeAttrIds('LIGHTINGCOLORCTRL', [
  'currentHue',           // 0
  'currentSaturation',    // 1
  'currentX',             // 3
  'currentY',             // 4
  'colorMode',            // 8
  'colorCapabilities',    // 16394 (0x400a)
]);
makeAttrIds('SSIASZONE', [
  'zoneState',    // 0
  'zoneType',     // 1
  'zoneStatus',   // 2
  'iasCieAddr',   // 16 (0x10)
  'zoneId',       // 17 (0x11)
]);

// COLOR_CAPABILITY describes values for the colorCapability attribute from
// the lightingColorCtrl cluster.
const COLOR_CAPABILITY = {
  HUE_SAT: (1 << 0),
  ENHANCED_HUE_SAT: (1 << 1),
  XY: (1 << 3),
  TEMPERATURE: (1 << 4),
};

// COLOR_MDOE describes values for the colorMode attribute from
// the lightingColorCtrl cluster.
const COLOR_MODE = {
  HUE_SAT: 0,
  XY: 1,
  TEMPERATURE: 2,
};

const DEVICE_ID = {
  ONOFFSWITCH: zclId.device('HA', 'onOffSwitch').value,
  ONOFFOUTPUT: zclId.device('HA', 'onOffOutput').value,
  SMART_PLUG: zclId.device('HA', 'smartPlug').value,
};
addHexValues(DEVICE_ID);

// Server in this context means "server of the cluster"
const DIR = {
  CLIENT_TO_SERVER: 0,
  SERVER_TO_CLIENT: 1,
};

const DOORLOCK_EVENT_CODES = [
  'Unknown',                      // 0
  'Lock',                         // 1
  'Unlock',                       // 2
  'LockFailInvalidPinOrID',       // 3
  'LockFailInvalidSchedule',      // 4
  'UnlockFailInvalidPinOrID',     // 5
  'UnlockFailInvalidSchedule',    // 6
  'OneTouchLock',                 // 7
  'KeyLock',                      // 8
  'KeyUnlock',                    // 9
  'AutoLock',                     // 10 (0x0A)
  'ScheduleLock',                 // 11 (0x0B)
  'ScheduleUnlock',               // 12 (0x0C)
  'ManualLock',                   // 13 (0x0D)
  'ManualUnlock',                 // 14 (0x0E)
  'NonAccessUserEvent',           // 15 (0X0F)
];

// POWERSOURCE describes the values for the powerSource attribute from
// the genBasic cluster
const POWERSOURCE = {
  UNKNOWN: 0,
  BATTERY: 3,
};

const PROFILE_ID = {
  ZDO: 0,
  ZHA: zclId.profile('HA').value,
  ZLL: zclId.profile('LL').value,
};
addHexValues(PROFILE_ID);

const STATUS = {
  SUCCESS: zclId.status('success').value,
  UNSUPPORTED_ATTRIB: zclId.status('unsupAttribute').value,
};

// ZONE_STATUS describes values for the zoneStatus attribute from
// the ssIasZone cluster.
const ZONE_STATUS = {
  ALARM_MASK: 0x03,
  TAMPER_MASK: 0x04,
  LOW_BATTERY_MASK: 0x08,
};

module.exports = {
  ATTR_ID,
  CLUSTER_ID,
  COLOR_CAPABILITY,
  COLOR_MODE,
  DEVICE_ID,
  DIR,
  DOORLOCK_EVENT_CODES,
  POWERSOURCE,
  PROFILE_ID,
  STATUS,
  ZONE_STATUS,
};

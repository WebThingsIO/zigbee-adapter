/**
 *
 * zb-families.js - Registers all families
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const XiaomiFamily = require('./zb-xiaomi');
const ZigbeeFamily = require('./zb-family');

function registerFamilies() {
  ZigbeeFamily.register(new XiaomiFamily());
}

module.exports = registerFamilies;

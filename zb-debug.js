/**
 *
 * zb-debug - manage debug configuration.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const DEBUG_FLAG = {
  // Use DEBUG_classifier for debugging the behaviour of the classifier.
  DEBUG_classifier: false,

  // Use DEBUG_flow if you need to debug the flow of the program. This causes
  // prints at the beginning of many functions to print some info.
  DEBUG_flow: false,

  // DEBUG_frames causes a 1-line summary to be printed for each frame
  // which is sent or received.
  DEBUG_frames: false,

  // DEBUG_frameDetail causes detailed information about each frame to be
  // printed.
  DEBUG_frameDetail: false,

  // DEBUG_frameParsing causes frame detail about the initial frame, before
  // we do any parsing of the data to be printed. This is useful to enable
  // if the frame parsing code is crashing.
  DEBUG_frameParsing: false,

  // DEBUG_node causes additional debug information from the zb-node.js
  // file to be printed.
  DEBUG_node: false,

  // DEBUG_property causes additional debug information to be printed
  // from zb-property.js
  DEBUG_property: false,

  // DEBUG_rawFrames causes the raw serial frames to/from the dongle
  // to be reported.
  DEBUG_rawFrames: false,

  // DEBUG_serialProber causes information about the serial probing at
  // module load time to be printed.
  DEBUG_serialProber: false,

  // DEBUG_slip causes SLIP encapsulated raw data (used by deConz)
  // to be printed.
  DEBUG_slip: false,

  // DEBUG_xiaomi causes additional debug information to be printed
  // from zb-xiaomi.js
  DEBUG_xiaomi: false,

  set: function(names) {
    for (const name of names.split(/[, ]+/)) {
      if (name === '') {
        // If names is empty then split returns ['']
        continue;
      }
      const debugName = `DEBUG_${name}`;
      if (DEBUG_FLAG.hasOwnProperty(debugName)) {
        console.log(`Enabling ${debugName}`);
        DEBUG_FLAG[debugName] = true;
      } else {
        console.log(`DEBUG: Unrecognized flag: '${debugName}' (ignored)`);
      }
    }
  },
};

module.exports = DEBUG_FLAG;

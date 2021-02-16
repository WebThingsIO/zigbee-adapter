/**
 *
 * zb-family.js - Provides customizations for a family of devices.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ZigbeeNode = require('./zb-node');

export default class ZigbeeFamily {
  static families: Record<string, ZigbeeFamily> = {};

  name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * @function classify
   *
   * The classify function is called by the framework either during
   * the initial scan, or when an end device announces itself, and
   * it hasn't yet been classified. The classify method is responsible
   * for creating appropriate properties for the node.
   *
   * @param {ZigbeeNode} node
   */
  classify(_node: typeof ZigbeeNode): void {
    // pass
  }

  static findFamily(findFamilyName: string): ZigbeeFamily | null {
    for (const familyName in ZigbeeFamily.families) {
      if (familyName == findFamilyName) {
        return ZigbeeFamily.families[familyName];
      }
    }

    return null;
  }

  /**
   * @function identify
   *
   * This function is used to identify the family of a node.
   *
   * @param {ZigbeeNode} node
   * @return Returns true to indicate that the indicated node is
   *         an instance of this family.
   */
  identify(_node: typeof ZigbeeNode): boolean {
    return false;
  }

  /**
   * @function identifyFamily
   *
   * This function walks through all of the registered families and sees
   * if any of them are able to identify the node.
   *
   * @param {ZigbeeNode} node
   * @return Returns true to indicate that the indicated node is
   *         an instance of this family.
   */
  static identifyFamily(node: typeof ZigbeeNode): boolean {
    for (const familyName in ZigbeeFamily.families) {
      const family = ZigbeeFamily.families[familyName];
      if (family.identify(node)) {
        node.family = family;
        return true;
      }
    }
    return false;
  }

  /**
   * @function register
   *
   * Called to register a device fmaily.
   *
   * @param {ZigbeeFamily} family - An instance of this class.
   */
  static register(family: ZigbeeFamily): void {
    ZigbeeFamily.families[family.name] = family;
  }
}

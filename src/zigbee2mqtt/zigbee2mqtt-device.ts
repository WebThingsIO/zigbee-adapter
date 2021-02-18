/**
 *
 * Zigbee2MqttDevice - A Zigbee2Mqtt device.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Action, Device, Event } from 'gateway-addon';
import { PropertyValue } from 'gateway-addon/lib/schema';
import { Zigbee2MqttAdapter, DeviceDefinition, Expos } from './zigbee2mqtt-adapter';
import {
  OnOffProperty,
  BrightnessProperty,
  ColorTemperatureProperty,
  ColorProperty,
  Zigbee2MqttProperty,
  WRITE_BIT,
  parseType,
} from './zigbee2mqtt-property';
import mqtt from 'mqtt';
import DEBUG_FLAG from '../zb-debug';

const debug = DEBUG_FLAG.DEBUG_zigbee2mqtt;

export class Zigbee2MqttDevice extends Device {
  private deviceTopic: string;

  constructor(
    adapter: Zigbee2MqttAdapter,
    id: string,
    deviceDefinition: DeviceDefinition,
    private client: mqtt.Client,
    topicPrefix: string
  ) {
    super(adapter, id);
    this.deviceTopic = `${topicPrefix}/${id}`;

    this.detectProperties(deviceDefinition);

    console.log(`Subscribing to ${this.deviceTopic}`);

    client.subscribe(this.deviceTopic, (err) => {
      if (err) {
        console.error(`Could not subscribe to ${this.deviceTopic}: ${err}`);
      }
    });

    if (deviceDefinition?.definition?.description) {
      this.setTitle(deviceDefinition?.definition?.description);
    } else {
      this.setTitle(`Zigbee2MQTT (${id})`);
    }
  }

  protected detectProperties(deviceDefinition: DeviceDefinition): void {
    for (const expose of deviceDefinition?.definition?.exposes ?? []) {
      if (expose.name === 'linkquality') {
        continue;
      }

      switch (expose.type ?? '') {
        case 'light':
          this.createLightProperties(expose);
          break;
        default:
          if (expose.name === 'action') {
            this.createEvents(expose.values as string[]);
          } else {
            const isWriteOnly = (expose.access ?? 0) == WRITE_BIT;

            if (isWriteOnly) {
              this.createAction(expose);
            } else {
              this.createProperty(expose);
            }
          }
          break;
      }
    }
  }

  private createLightProperties(expose: Expos): void {
    if (expose.features) {
      ((this as unknown) as { '@type': string[] })['@type'].push('Light');

      for (const feature of expose.features) {
        if (feature.name) {
          switch (feature.name) {
            case 'state':
              {
                console.log(`Creating property for ${feature.name}`);

                const property = new OnOffProperty(
                  this,
                  feature.name,
                  feature,
                  this.client,
                  this.deviceTopic
                );

                this.addProperty(property);
              }
              break;
            case 'brightness':
              {
                console.log(`Creating property for ${feature.name}`);

                const property = new BrightnessProperty(
                  this,
                  feature.name,
                  feature,
                  this.client,
                  this.deviceTopic
                );

                this.addProperty(property);
              }
              break;
            case 'color_temp':
              {
                console.log(`Creating property for ${feature.name}`);

                const property = new ColorTemperatureProperty(
                  this,
                  feature.name,
                  feature,
                  this.client,
                  this.deviceTopic
                );

                this.addProperty(property);
              }
              break;
            case 'color_xy':
              {
                console.log(`Creating property for ${feature.name}`);

                const property = new ColorProperty(
                  this,
                  'color',
                  feature,
                  this.client,
                  this.deviceTopic
                );

                this.addProperty(property);
              }
              break;
          }
        } else {
          console.log(`Ignoring property without name: ${JSON.stringify(expose, null, 0)}`);
        }
      }
    } else {
      console.warn(`Expected features array in light expose: ${JSON.stringify(expose)}`);
    }
  }

  private createEvents(values: string[]): void {
    if (Array.isArray(values)) {
      if (values.length > 0) {
        for (const value of values) {
          console.log(`Creating property for ${value}`);

          this.addEvent(value, {
            name: value,
          });
        }
      } else {
        console.log(`Expected list of values but got ${JSON.stringify(values)}`);
      }
    } else {
      console.log(`Expected array but got ${typeof values}`);
    }
  }

  private createAction(expose: Expos): void {
    if (expose.name) {
      console.log(`Creating action for ${expose.name}`);

      this.addAction(expose.name, {
        description: expose.description,
        input: {
          type: parseType(expose.type),
          unit: expose.unit,
          enum: expose.values,
          minimum: expose.value_min,
          maximum: expose.value_max,
        },
      });
    } else {
      console.log(`Ignoring action without name: ${JSON.stringify(expose, null, 0)}`);
    }
  }

  private createProperty<T extends PropertyValue>(expose: Expos): void {
    if (expose.name) {
      console.log(`Creating property for ${expose.name}`);

      const property = new Zigbee2MqttProperty<T>(
        this,
        expose.name,
        expose,
        this.client,
        this.deviceTopic
      );

      this.addProperty(property);
    } else {
      console.log(`Ignoring property without name: ${JSON.stringify(expose, null, 0)}`);
    }
  }

  update(update: Record<string, PropertyValue>): void {
    if (typeof update !== 'object') {
      console.log(`Expected object but got ${typeof update}`);
    }

    for (const [key, value] of Object.entries(update)) {
      if (key === 'action') {
        const event = new Event(this, value as string);
        this.eventNotify(event);
      } else {
        const property = this.findProperty(key) as Zigbee2MqttProperty<PropertyValue>;

        if (property) {
          property.update(value, update);
        } else if (debug) {
          console.log(`Could not find property with name ${key}`);
        }
      }
    }
  }

  performAction(action: Action): Promise<void> {
    const { name, input } = action.asDict();

    action.start();

    return new Promise<void>((resolve, reject) => {
      const writeTopic = `${this.deviceTopic}/set`;
      const json = { [name]: input };

      if (debug) {
        console.log(`Sending ${JSON.stringify(json)} to ${writeTopic}`);
      }

      this.client.publish(writeTopic, JSON.stringify(json), (error) => {
        action.finish();

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

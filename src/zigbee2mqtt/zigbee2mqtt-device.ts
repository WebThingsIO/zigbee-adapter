/**
 *
 * Zigbee2MqttDevice - A Zigbee2Mqtt device.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Action, Device, Event } from 'gateway-addon';
import { PropertyValue, Event as EventSchema } from 'gateway-addon/lib/schema';
import { Zigbee2MqttAdapter, DeviceDefinition, Expos } from './zigbee2mqtt-adapter';
import {
  OnOffProperty,
  BrightnessProperty,
  ColorTemperatureProperty,
  ColorProperty,
  Zigbee2MqttProperty,
  WRITE_BIT,
  parseType,
  isReadable,
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

    const exposes = deviceDefinition?.definition?.exposes;

    if (Array.isArray(exposes)) {
      const properties: Record<string, unknown> = this.getKeys(exposes);

      if (Object.keys(properties).length > 0) {
        const readTopic = `${this.deviceTopic}/get`;
        const readPayload = JSON.stringify(properties);

        client.publish(readTopic, readPayload, (error) => {
          if (error) {
            console.warn(`Could not send ${readPayload} to ${readTopic}: ${console.error()}`);
          }
        });
      }
    }
  }

  private getKeys(exposes: Expos[]): Record<string, unknown> {
    let properties: Record<string, unknown> = {};

    for (const expose of exposes) {
      if (expose.name) {
        if (this.hasReadableProperties(expose)) {
          properties[expose.name] = '';
        }
      } else if (Array.isArray(expose.features)) {
        properties = {
          ...properties,
          ...this.getKeys(expose.features),
        };
      }
    }

    return properties;
  }

  private hasReadableProperties(expose: Expos): boolean {
    if (typeof expose.access === 'number') {
      return isReadable(expose.access);
    } else if (Array.isArray(expose.features)) {
      for (const feature of expose.features) {
        if (this.hasReadableProperties(feature)) {
          return true;
        }
      }
    }

    return false;
  }

  protected detectProperties(deviceDefinition: DeviceDefinition): void {
    for (const expose of deviceDefinition?.definition?.exposes ?? []) {
      switch (expose.type ?? '') {
        case 'light':
          this.createLightProperties(expose);
          break;
        case 'switch':
          this.createSmartPlugProperties(expose);
          break;
        case 'climate':
          this.createThermostatProperties(expose);
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

  private createSmartPlugProperties(expose: Expos): void {
    if (expose.features) {
      ((this as unknown) as { '@type': string[] })['@type'].push('SmartPlug');

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
          }
        } else {
          console.log(`Ignoring property without name: ${JSON.stringify(expose, null, 0)}`);
        }
      }
    } else {
      console.warn(`Expected features array in light expose: ${JSON.stringify(expose)}`);
    }
  }

  private createThermostatProperties(expose: Expos): void {
    if (expose.features) {
      ((this as unknown) as { '@type': string[] })['@type'].push('Thermostat');

      for (const feature of expose.features) {
        if (feature.name) {
          this.createProperty(feature);
        } else {
          console.log(`Ignoring property without name: ${JSON.stringify(expose, null, 0)}`);
        }
      }
    } else {
      console.warn(`Expected features array in thermostat expose: ${JSON.stringify(expose)}`);
    }
  }

  private createEvents(values: string[]): void {
    if (Array.isArray(values)) {
      if (values.length > 0) {
        let isPushbutton = false;

        for (const value of values) {
          console.log(`Creating property for ${value}`);

          const additionalProperties: Record<string, unknown> = {};

          switch (value) {
            case 'single':
              additionalProperties['@type'] = 'PressedEvent';
              isPushbutton = true;
              break;
            case 'double':
              additionalProperties['@type'] = 'DoublePressedEvent';
              isPushbutton = true;
              break;
            case 'release':
              additionalProperties['@type'] = 'LongPressedEvent';
              isPushbutton = true;
              break;
          }

          this.addEvent(value, {
            name: value,
            ...additionalProperties,
          });

          console.log({
            name: value,
            ...additionalProperties,
          });
        }

        if (isPushbutton) {
          const device = (this as unknown) as { '@type': string[] };
          device['@type'].push('PushButton');
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
      switch (expose.name) {
        case 'linkquality':
        case 'local_temperature_calibration':
        case 'running_state':
          return;
      }

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
        if (typeof value !== 'string') {
          console.log(`Expected event of type string but got ${typeof value}`);
          continue;
        }

        const exists = ((this as unknown) as { events: Map<string, EventSchema> }).events.has(
          value
        );

        if (!exists) {
          if (debug) {
            console.log(`Event '${value}' does not exist on ${this.getTitle()} (${this.getId()})`);
          }
          continue;
        }

        const event = new Event(this, value as string);
        this.eventNotify(event);
      } else {
        const property = this.findProperty(key) as Zigbee2MqttProperty<PropertyValue>;

        if (property) {
          property.update(value, update);
        } else if (debug) {
          console.log(`Property '${key}' does not exist on ${this.getTitle()} (${this.getId()})`);
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

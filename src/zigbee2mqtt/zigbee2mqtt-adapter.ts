/**
 *
 * Zigbee2MqttAdapter - Adapter which communicates over MQTT with the Zigbee2Mqtt stack.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, AddonManagerProxy, Device } from 'gateway-addon';
import { Config, Zigbee2MQTTAdapter } from '../config';
import mqtt from 'mqtt';
import { Zigbee2MqttDevice } from './zigbee2mqtt-device';
import DEBUG_FLAG from '../zb-debug';

const debug = DEBUG_FLAG.DEBUG_zigbee2mqtt;

import manifest from '../manifest.json';

interface Response {
  data?: {
    id?: string;
    block?: boolean;
    force?: boolean;
    value: boolean;
  };
  status?: string;
  error?: string;
}

interface Log {
  level?: string;
  message?: string;
}

const DEVICES_POSTFIX = '/bridge/devices';
const PERMIT_REQUEST_POSTFIX = '/bridge/request/permit_join';
const PERMIT_RESPONSE_POSTFIX = '/bridge/response/permit_join';
const REMOVE_REQUEST_POSTFIX = '/bridge/request/device/remove';
const REMOVE_RESPONSE_POSTFIX = '/bridge/response/device/remove';
const LOGGING_POSTFIX = '/bridge/logging';

const DEFAULT_PORT = 1883;

export class Zigbee2MqttAdapter extends Adapter {
  private prefix: string;

  private client?: mqtt.Client;

  constructor(
    addonManager: AddonManagerProxy,
    private config: Config,
    private adapterConfig: Zigbee2MQTTAdapter
  ) {
    super(
      addonManager,
      `zb-zigbee2mqtt-${adapterConfig.host}:${adapterConfig.port ?? DEFAULT_PORT}`,
      manifest.id);
    this.prefix = adapterConfig.topicPrefix ?? 'zigbee2mqtt';
    this.connect();
  }

  async connect(): Promise<void> {
    const host = this.adapterConfig.host;
    const port = this.adapterConfig.port || DEFAULT_PORT;
    const broker = `mqtt://${host}:${port}`;
    console.log(`Connecting to broker ${broker}`);
    const client = mqtt.connect(broker);
    this.client = client;

    client.on('connect', () => {
      console.log(`Successfully connected to ${broker}`);

      this.subscribe(`${this.prefix}${DEVICES_POSTFIX}`);
      this.subscribe(`${this.prefix}${PERMIT_RESPONSE_POSTFIX}`);
      this.subscribe(`${this.prefix}${REMOVE_RESPONSE_POSTFIX}`);
      if (this.config.zigbee2mqtt?.zigbee2mqttDebugLogs) {
        this.subscribe(`${this.prefix}${LOGGING_POSTFIX}`);
      }
    });

    client.on('error', (error) => {
      console.error(`Could not connect to broker: ${error}`);
    });

    client.on('message', (topic, message) => {
      const raw = message.toString();

      if (debug) {
        console.log(`Received on ${topic}: ${raw}`);
      }

      try {
        const json = JSON.parse(raw);

        const parts = topic.split('/');

        if (topic.endsWith(DEVICES_POSTFIX)) {
          this.handleDevices(client, json);
        } else if (parts.length == 2) {
          const id = parts[1];
          const device = this.getDevice(id) as Zigbee2MqttDevice;

          if (device) {
            device.update(json);
          } else {
            console.log(`Could not find device with id ${id}`);
          }
        } else if (topic.endsWith(PERMIT_RESPONSE_POSTFIX)) {
          const response: Response = json;

          if (response.error) {
            console.log(`Could not enable permit join mode: ${response.error}`);
          } else if (response.status === 'ok') {
            if (response.data?.value) {
              console.log('Bridge is now permitting new devices to join');
            } else {
              console.log('Bridge is no longer permitting new devices to join');
            }
          }
        } else if (topic.endsWith(REMOVE_RESPONSE_POSTFIX)) {
          const response: Response = json;
          const id = response.data?.id ?? 'unknown';

          if (response.error) {
            console.log(`Could not remove device ${id}: ${response.error}`);
          } else if (response.status === 'ok') {
            console.log(`Removed device ${id} successfully`);

            const existingDevice = this.getDevice(id);

            if (existingDevice) {
              this.handleDeviceRemoved(existingDevice);
            } else {
              console.warn(`Could not find device with id ${id}`);
            }
          }
        } else if (topic.indexOf(LOGGING_POSTFIX) > -1) {
          const log: Log = json;
          console.log(`Zigbee2Mqtt::${log.level}: ${log.message}`);
        }
      } catch (error) {
        console.error(`Could not process message ${raw}: ${error}`);
      }
    });
  }

  private subscribe(topic: string): void {
    console.log(`Subscribing to ${topic}`);

    if (!this.client) {
      console.log('No client to subscribe to');
      return;
    }

    this.client.subscribe(topic, (err) => {
      if (err) {
        console.error(`Could not subscribe to ${topic}: ${err}`);
      } else {
        console.log(`Successfully subscribed to ${topic}`);
      }
    });
  }

  private handleDevices(client: mqtt.Client, deviceDefinitions: DeviceDefinition[]): void {
    if (!Array.isArray(deviceDefinitions)) {
      console.log(`Expected list of devices but got ${typeof deviceDefinitions}`);
      return;
    }

    for (const deviceDefinition of deviceDefinitions) {
      if (deviceDefinition.type == 'EndDevice' || deviceDefinition.type == 'Router') {
        const id = deviceDefinition.ieee_address;

        if (id) {
          const existingDevice = this.getDevice(id);

          if (!existingDevice) {
            const device = new Zigbee2MqttDevice(this, id, deviceDefinition, client, this.prefix);
            this.handleDeviceAdded(device);
          } else if (debug) {
            console.log(`Device ${id} already exists`);
          }
        } else {
          // eslint-disable-next-line max-len
          console.log(`Ignoring device without id: ${JSON.stringify(deviceDefinition)}`);
        }
      } else {
        // eslint-disable-next-line max-len
        console.log(`Ignoring device of type ${deviceDefinition.type}`);
      }
    }
  }

  startPairing(timeoutSeconds: number): void {
    console.log(`Permit joining for ${timeoutSeconds} seconds`);
    const permitTopic = `${this.prefix}${PERMIT_REQUEST_POSTFIX}`;
    this.publish(permitTopic, JSON.stringify({ value: true, time: timeoutSeconds }));
  }

  cancelPairing(): void {
    console.log('Deny joining');
    const permitTopic = `${this.prefix}${PERMIT_REQUEST_POSTFIX}`;
    this.publish(permitTopic, JSON.stringify({ value: false }));
  }

  removeThing(device: Device): void {
    console.log(`Removing ${device.getTitle()} (${device.getId()})`);
    const removeTopic = `${this.prefix}${REMOVE_REQUEST_POSTFIX}`;
    this.publish(removeTopic, JSON.stringify({ id: device.getId() }));
  }

  private publish(topic: string, payload: string): void {
    if (debug) {
      console.log(`Sending ${payload} to ${topic}`);
    }

    this?.client?.publish(topic, payload, (error) => {
      if (error) {
        console.log(`Could not send ${payload} to ${topic}: ${error}`);
      }
    });
  }
}

export interface DeviceDefinition {
  definition?: Definition;
  friendly_name?: string;
  ieee_address?: string;
  interview_completed?: boolean;
  interviewing?: boolean;
  model_id?: string;
  network_address?: number;
  power_source?: string;
  supported?: boolean;
  type?: string;
}

export interface Definition {
  description?: string;
  exposes?: Expos[];
  model?: string;
  supports_ota?: boolean;
  vendor?: string;
}

export interface Expos {
  access?: number;
  description?: string;
  name?: string;
  property?: string;
  type?: string;
  unit?: string;
  value_max?: number;
  value_min?: number;
  values?: string[];
  features: Expos[];
}

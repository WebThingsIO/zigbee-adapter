import { Expos } from '../zigbee2mqtt-adapter';
import { Zigbee2MqttDevice } from '../zigbee2mqtt-device';
import { Zigbee2MqttProperty } from '../zigbee2mqtt-property';
import mqtt from 'mqtt';

function convertHeatingCoolingValues(value?: string[]): string[] | undefined {
  if (value) {
    return value.map((x) => convertHeatingCoolingValue(x));
  }

  return value;
}

function convertHeatingCoolingValue(value: string): string {
  switch (value) {
    case 'idle':
      return 'off';
    case 'heat':
      return 'heating';
    case 'cool':
      return 'cooling';
    default:
      throw new Error(`Invalid HeatingCoolingValue ${value}, expected idle, heat or cool`);
  }
}

export class HeatingCoolingProperty extends Zigbee2MqttProperty<string> {
  constructor(
    device: Zigbee2MqttDevice,
    name: string,
    expose: Expos,
    client: mqtt.Client,
    deviceTopic: string
  ) {
    super(device, name, expose, client, deviceTopic, {
      '@type': 'HeatingCoolingProperty',
      title: 'Run Mode',
      type: 'string',
      enum: convertHeatingCoolingValues(expose.values),
    });
  }

  update(value: string, update: Record<string, unknown>): void {
    super.update(convertHeatingCoolingValue(value), update);
  }
}

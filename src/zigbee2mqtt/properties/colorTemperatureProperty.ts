import { Expos } from '../zigbee2mqtt-adapter';
import { Zigbee2MqttDevice } from '../zigbee2mqtt-device';
import { Zigbee2MqttProperty } from '../zigbee2mqtt-property';
import mqtt from 'mqtt';

function kelvinToMiredd(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

function miredToKelvin(mired: number): number {
  return Math.round(1_000_000 / mired);
}

export class ColorTemperatureProperty extends Zigbee2MqttProperty<number> {
  constructor(
    device: Zigbee2MqttDevice,
    name: string,
    expose: Expos,
    client: mqtt.Client,
    deviceTopic: string
  ) {
    super(device, name, expose, client, deviceTopic, {
      '@type': 'ColorTemperatureProperty',
      title: 'Color temperature',
      type: 'number',
      minimum: miredToKelvin(expose.value_max!),
      maximum: miredToKelvin(expose.value_min!),
      unit: 'kelvin',
    });
  }

  update(value: number, update: Record<string, unknown>): void {
    super.update(miredToKelvin(value), update);
  }

  protected async sendValue(value: number): Promise<void> {
    return super.sendValue(kelvinToMiredd(value));
  }
}

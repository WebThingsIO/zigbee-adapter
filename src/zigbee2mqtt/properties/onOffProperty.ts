import { Expos } from '../zigbee2mqtt-adapter';
import { Zigbee2MqttDevice } from '../zigbee2mqtt-device';
import mqtt from 'mqtt';
import { Zigbee2MqttProperty } from '../zigbee2mqtt-property';
import { parseType } from '../utils';

export class OnOffProperty extends Zigbee2MqttProperty<boolean> {
  constructor(
    device: Zigbee2MqttDevice,
    name: string,
    expose: Expos,
    client: mqtt.Client,
    deviceTopic: string
  ) {
    super(device, name, expose, client, deviceTopic, {
      '@type': 'OnOffProperty',
      title: 'On',
      type: parseType(expose),
    });
  }

  update(value: string, update: Record<string, unknown>): void {
    super.update(value === 'ON', update);
  }

  protected async sendValue(value: boolean): Promise<void> {
    return super.sendValue(value ? 'ON' : 'OFF');
  }
}

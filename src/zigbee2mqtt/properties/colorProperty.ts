import { Expos } from '../zigbee2mqtt-adapter';
import { Zigbee2MqttDevice } from '../zigbee2mqtt-device';
import { Zigbee2MqttProperty } from '../zigbee2mqtt-property';
import mqtt from 'mqtt';
import Color from 'color';

function limit(value: number, min: number, max: number): number {
  return Math.max(Math.min(value, max), min);
}

/*
 I tried

 Color({
   x: value.x * 100,
   y: value.y * 100,
   z: ((update.brightness as number) ?? 255) * 100 / 255,
 }).hex()

 but it seems to calculate the wrong color.
 If we send #00FF00 to zigbee2mqtt we get {"x":0.1721,"y":0.6905} as answer.
 The Color class translates this to #00FFF5.
 */
// https://stackoverflow.com/questions/22894498/philips-hue-convert-xy-from-api-to-hex-or-rgb
function xyBriToRgb(x: number, y: number, bri: number): RGB {
  const z = 1.0 - x - y;

  const Y = bri / 255.0;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  let r = X * 1.612 - Y * 0.203 - Z * 0.302;
  let g = -X * 0.509 + Y * 1.412 + Z * 0.066;
  let b = X * 0.026 - Y * 0.072 + Z * 0.962;

  r = r <= 0.0031308 ? 12.92 * r : (1.0 + 0.055) * Math.pow(r, 1.0 / 2.4) - 0.055;
  g = g <= 0.0031308 ? 12.92 * g : (1.0 + 0.055) * Math.pow(g, 1.0 / 2.4) - 0.055;
  b = b <= 0.0031308 ? 12.92 * b : (1.0 + 0.055) * Math.pow(b, 1.0 / 2.4) - 0.055;

  const maxValue = Math.max(r, g, b);

  r /= maxValue;
  g /= maxValue;
  b /= maxValue;

  r = limit(r * 255, 0, 255);
  g = limit(g * 255, 0, 255);
  b = limit(b * 255, 0, 255);

  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface XY {
  x: number;
  y: number;
}

export class ColorProperty extends Zigbee2MqttProperty<string> {
  constructor(
    device: Zigbee2MqttDevice,
    name: string,
    expose: Expos,
    client: mqtt.Client,
    deviceTopic: string
  ) {
    super(device, name, expose, client, deviceTopic, {
      '@type': 'ColorProperty',
      title: 'Color',
      type: 'string',
      readOnly: false,
    });
  }

  update(value: XY, update: Record<string, unknown>): void {
    const rgb = xyBriToRgb(value.x, value.y, (update.brightness as number) ?? 255);
    const color = new Color(rgb);
    super.update(color.hex(), update);
  }

  protected async sendValue(value: string): Promise<void> {
    const color = new Color(value);
    const rgb = color.object();
    return super.sendValue(rgb);
  }
}

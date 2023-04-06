import { PropertyValueType } from 'gateway-addon/lib/schema';
import { Expos } from './zigbee2mqtt-adapter';

export function parseType(expose: Expos): PropertyValueType {
  switch (expose.type) {
    case 'numeric':
      if (expose.value_step === 1) {
        return 'integer';
      } else {
        return 'number';
      }
    case 'enum':
      return 'string';
    case 'binary':
      return 'boolean';
  }

  return 'string';
}

export function parseUnit(unit?: string): string | undefined {
  switch (unit) {
    case '°C':
      return 'degree celsius';
  }

  return unit;
}

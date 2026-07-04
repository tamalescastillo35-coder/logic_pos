// Best-effort printing to a Bluetooth thermal printer directly from the browser via Web
// Bluetooth. IMPORTANT limitation: Web Bluetooth only speaks BLE (GATT); it cannot open a
// classic Bluetooth SPP/RFCOMM socket, which is what most cheap 58/80mm ESC/POS printers
// (MERION PT-B1 included) use. This only works if the printer's Bluetooth chip *also*
// advertises a BLE "serial" service — common on clones built for iOS support, since iOS
// doesn't allow third-party apps to use classic Bluetooth at all. Whether a given unit
// supports this can only be confirmed by testing it; there is no way to detect it in advance.
// Supported in Chrome/Edge on desktop and Android; not supported in Safari or Firefox.

// Candidate BLE "serial passthrough" services seen across common cheap printer/UART clones.
// Web Bluetooth requires every service you might touch to be pre-declared here — you can't
// discover arbitrary unlisted services after connecting, for privacy reasons.
const CANDIDATE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // common in ESC/POS BLE printer clones
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 style UART module
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
];

// BLE writes are capped by the connection's negotiated MTU (commonly ~20 bytes when nothing
// negotiates a larger one, which Web Bluetooth gives no control over) — send the ticket in
// small chunks with a short pause so the printer's buffer keeps up.
const CHUNK_SIZE = 20;
const CHUNK_DELAY_MS = 20;

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export async function requestBluetoothPrinter(): Promise<BluetoothDevice> {
  if (!navigator.bluetooth) throw new Error('Este navegador no soporta Bluetooth (Web Bluetooth). Usa Chrome o Edge.');
  return navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: CANDIDATE_SERVICES,
  });
}

async function findWritableCharacteristic(server: BluetoothRemoteGATTServer): Promise<BluetoothRemoteGATTCharacteristic> {
  const services = await server.getPrimaryServices();
  for (const service of services) {
    const chars = await service.getCharacteristics();
    const writable = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
    if (writable) return writable;
  }
  throw new Error(
    'Esta impresora no expone un canal Bluetooth BLE compatible. Probablemente solo tiene Bluetooth clásico (SPP), que los navegadores no pueden usar — en ese caso solo se puede imprimir por Bluetooth desde la app instalada (APK), o por cable USB desde el navegador.'
  );
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function printBluetooth(device: BluetoothDevice, data: Uint8Array): Promise<void> {
  if (!device.gatt) throw new Error('Este dispositivo no soporta conexión GATT.');
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const characteristic = await findWritableCharacteristic(server);
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.subarray(i, i + CHUNK_SIZE);
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
    await wait(CHUNK_DELAY_MS);
  }
  server.disconnect();
}

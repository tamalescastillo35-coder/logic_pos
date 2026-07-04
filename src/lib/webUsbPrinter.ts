// Prints raw ESC/POS bytes to a USB thermal printer directly from the browser via WebUSB —
// the web-only counterpart to BluetoothPrinterPlugin.java (which only exists inside the APK).
// Supported in Chrome/Edge on desktop and Android with the printer plugged in by USB cable;
// not supported in Safari or Firefox (no WebUSB implementation there).

const USB_PRINTER_CLASS = 0x07;

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

export async function requestUsbPrinter(): Promise<USBDevice> {
  if (!navigator.usb) throw new Error('Este navegador no soporta impresión USB (WebUSB). Usa Chrome o Edge.');
  return navigator.usb.requestDevice({ filters: [{ classCode: USB_PRINTER_CLASS }] });
}

// WebUSB remembers previously-granted devices per origin, so a plugged-in printer can be
// reattached silently on load without asking the user to pick it again.
export async function getPairedUsbPrinters(): Promise<USBDevice[]> {
  if (!navigator.usb) return [];
  return navigator.usb.getDevices();
}

function findPrinterEndpoint(device: USBDevice): { interfaceNumber: number; endpointNumber: number } | null {
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === USB_PRINTER_CLASS) {
          const outEp = alt.endpoints.find(e => e.direction === 'out');
          if (outEp) return { interfaceNumber: iface.interfaceNumber, endpointNumber: outEp.endpointNumber };
        }
      }
    }
  }
  return null;
}

export async function printUsb(device: USBDevice, data: Uint8Array): Promise<void> {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const target = findPrinterEndpoint(device);
  if (!target) {
    throw new Error('No se encontró una interfaz de impresora en este dispositivo USB.');
  }
  await device.claimInterface(target.interfaceNumber);
  try {
    await device.transferOut(target.endpointNumber, data);
  } finally {
    await device.releaseInterface(target.interfaceNumber);
    await device.close();
  }
}

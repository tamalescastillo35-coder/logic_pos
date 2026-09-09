import { registerPlugin } from '@capacitor/core';

export interface BluetoothPrinterDevice {
  name: string;
  address: string;
}

interface ReceiptPrinterPlugin {
  print(options: { html: string; jobName?: string }): Promise<{ value: boolean }>;
}

interface BluetoothPrinterPlugin {
  listPairedDevices(): Promise<{ devices: BluetoothPrinterDevice[] }>;
  printEscPos(options: { address: string; data: string }): Promise<{ value: boolean }>;
}

interface LogicPosNativePlugins {
  receipt: ReceiptPrinterPlugin;
  bluetooth: BluetoothPrinterPlugin;
}

const globalPluginCache = globalThis as typeof globalThis & {
  __logicPosNativePlugins?: LogicPosNativePlugins;
};

// Vite can reevaluate modules during a development reload. Keep one proxy per native plugin
// for the lifetime of the page so Capacitor does not register the same name twice.
const plugins = globalPluginCache.__logicPosNativePlugins ?? {
  receipt: registerPlugin<ReceiptPrinterPlugin>('ReceiptPrinter'),
  bluetooth: registerPlugin<BluetoothPrinterPlugin>('BluetoothPrinter'),
};

globalPluginCache.__logicPosNativePlugins = plugins;

export const ReceiptPrinter = plugins.receipt;
export const BluetoothPrinter = plugins.bluetooth;

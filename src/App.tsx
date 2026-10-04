import React, { useState, useEffect, useMemo, useRef, FormEvent } from 'react';
import { 
  ShoppingCart,
  Package,
  Users,
  BarChart3,
  Receipt,
  Sparkles,
  Plus,
  Minus,
  Trash2,
  Search,
  Percent,
  CircleDollarSign,
  Check,
  ChevronRight,
  UserPlus,
  ArrowLeft,
  RotateCcw,
  FileText,
  AlertCircle,
  ShieldCheck,
  TrendingUp,
  X,
  Filter,
  DollarSign,
  Tag,
  Briefcase,
  Layers,
  Store,
  Truck,
  Building2,
  Settings,
  Key,
  Menu,
  Palette,
  MapPin,
  Download,
  Printer,
  LayoutGrid,
  List,
  Rocket,
  History,
  User as UserIcon,
  Lock,
  Link2,
  Upload,
  TrendingDown,
  MessageCircle,
  Mail,
  Share2,
  Pencil,
  RefreshCw,
} from 'lucide-react';
// Firebase integrations
import { auth, db, googleProvider, driveGoogleProvider, OperationType, handleFirestoreError, getCachedAccessToken, setCachedAccessToken, SessionInvalidError, isSessionInvalidError } from './firebase';
import { onAuthStateChanged, signInWithPopup, signInWithCredential, signOut, User, signInWithEmailAndPassword, GoogleAuthProvider } from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { BluetoothPrinter, ReceiptPrinter, type BluetoothPrinterDevice } from './lib/nativePlugins';
import { buildReceiptEscPos, buildTestPrint, buildTransferEscPos, uint8ToBase64, columnsForPaperWidth } from './lib/escpos';
import { isWebUsbSupported, requestUsbPrinter, getPairedUsbPrinters, printUsb } from './lib/webUsbPrinter';
import { isWebBluetoothSupported, requestBluetoothPrinter, printBluetooth } from './lib/webBluetoothPrinter';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { Network } from '@capacitor/network';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import {
  CashRegisterClosedError,
  StockUnavailableError,
  describeCheckoutError,
  describeStockOperationError,
  getDayRange,
  getMonthRange,
  getRecordDayKey,
  getRecordMonthKey,
  isNetZeroStockChange,
  msUntilNextLocalDay,
  resolveActiveBranchId,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from './lib/posSafety';
import { createDocumentId } from './lib/ids';
import { canManageInvoicingRole, canRefundSalesRole, getHistoryAccess, getInventoryExportBranches, hasAppPermission, isOwnerRole, type CompanyRole } from './lib/permissions';
import { FirestoreConnectionController } from './lib/firestoreConnection';

const isNativePlatform = Capacitor.isNativePlatform();

// En APK usa el SDK nativo de Google (Android Credential Manager) en vez del flujo de
// redirect por WebView — ese flujo requiere que Firebase sirva `/__/auth/handler` por red
// real, algo que Capacitor no puede garantizar cuando la app corre 100% empaquetada
// (ver bug de pantalla blanca, sesión 2026-07-02). Tras el sign-in nativo, el idToken se
// usa para autenticar también el SDK de JS (signInWithCredential), así el resto de la app
// (onAuthStateChanged, reglas de Firestore, etc.) sigue funcionando sin cambios.
const signInWithGoogle = async () => {
  if (isNativePlatform) {
    const result = await FirebaseAuthentication.signInWithGoogle();
    const idToken = result.credential?.idToken;
    if (!idToken) throw new Error('No se recibió el token de acceso de Google.');
    const credential = GoogleAuthProvider.credential(idToken, result.credential?.accessToken);
    await signInWithCredential(auth, credential);
    if (result.credential?.accessToken) setCachedAccessToken(result.credential.accessToken);
  } else {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) setCachedAccessToken(credential.accessToken);
  }
};
import {
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  writeBatch,
  getDoc,
  updateDoc,
  runTransaction,
  query,
  where,
  orderBy,
  limit,
  getDocFromServer,
} from 'firebase/firestore';

// Custom Tenant Components
import CompanySelector from './components/CompanySelector';
import CompanySettingsView from './components/CompanySettingsView';

// UTF-8-safe string → base64 (plain btoa() mangles accented characters like á/é/í/ó/ú/ñ).
const utf8ToBase64 = (str: string): string =>
  btoa(Array.from(new TextEncoder().encode(str), b => String.fromCharCode(b)).join(''));

// saveFileOnDevice moved inside the App() component below — it now needs component state
// (pendingFileSave) to show a Descargar/Compartir choice instead of picking one path
// automatically per platform.

// Interfaces
interface Product {
  id: string;
  name: string;
  category: string;
  costPrice: number;
  salePrice: number;
  stock: number;
  minStock: number;
  imageUrl?: string;
  sku?: string;
  supplierId?: string; // Associated Suppplier
  branchStocks?: { [branchId: string]: number }; // Branch-specific stocks!
  // Shared-stock link (e.g. "Atole Mediano"/"1 Litro" drawing from one "Atole" pool in liters):
  // when set, this product has no stock of its own — getProductStock resolves it from the
  // linked parent's stock divided by the factor. Both undefined means a normal, independent
  // product (the vast majority).
  linkedStockProductId?: string; // id of the "parent" pool product
  stockConsumptionFactor?: number; // how much of the parent's stock one unit of this product consumes (0.5 = medio, 1 = litro)
  // Marks a product as itself a shared-stock pool (e.g. "Atole de Chocolate" backing "...
  // Mediano"/"...1 Litro"). Set explicitly at creation — NOT inferred from whether some other
  // product currently links to it — so it's excluded from the sale catalog from the moment it's
  // created, before any child has been linked yet.
  isStockPool?: boolean;
}

interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  unpaidBalance: number; // For "Fiado" (Credit)
  registeredDate: string;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface SaleItem {
  productId: string;
  name: string;
  quantity: number;
  salePrice: number;
  // Snapshot of the product's shared-stock link AT THE MOMENT OF SALE (not re-read from the
  // live product later) — so a refund always restores the correct pool even if the product's
  // link config changed or the product was deleted in between.
  linkedStockProductId?: string;
  stockConsumptionFactor?: number;
}

interface Sale {
  id: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paymentMethod: 'Cash' | 'Card' | 'Transfer' | 'Credit'; // 'Credit' is "Fiado"
  customerId?: string;
  customerName?: string;
  timestamp: string;
  createdAt?: number; // epoch ms — used for reliable sorting (timestamp is a locale display string, not parseable)
  status: 'Completed' | 'Refunded';
  branchId?: string; // Associated Branch/Office
  folio?: string; // Reference Folio
  requiresInvoice?: boolean;
  invoiceStatus?: 'pending' | 'completed';
  employeeName?: string; // Who rang up the sale (owner, encargado, or cajero) — "Atendido por"
}

type CashTransactionType = 'Ingreso' | 'Egreso' | 'Venta' | 'Transferencia' | 'Apertura' | 'Cierre';

interface CashTransaction {
  id?: string;
  type: CashTransactionType;
  amount: number;
  cashDelta?: number;
  description: string;
  time: string;
  timestamp?: string;
  createdAt?: number;
  branchId?: string;
  shiftId?: string;
  saleId?: string;
  paymentMethod?: Sale['paymentMethod'];
  createdBy?: string;
  balanceAfter?: number;
}

interface CashRegister {
  isOpen: boolean;
  initialCash: number;
  currentCash: number;
  // Read-only compatibility with register documents created before the append-only ledger.
  // New code never appends to or clears this field.
  transactions: CashTransaction[];
  lastOperationalDate?: string; // e.g. '2026-05-20'
  currentShiftId?: string;
  openedAt?: number;
  closedAt?: number;
  lastTransactionId?: string;
  updatedAt?: number;
}

interface Branch {
  id: string;
  name: string;
  address: string;
  phone: string;
  manager: string;
  isMatriz?: boolean; // Toggle for main manufacturing branch
}

// Append-only inventory audit log — one entry per restock ("surtido") or per side of an
// inter-branch transfer. Kept separate from the cash register (which tracks money) so the
// Historial has a clean, dedicated "Movimientos de Inventario" view. `quantity` is units.
interface StockMovement {
  id: string;
  type: 'surtido' | 'merma' | 'transfer_in' | 'transfer_out';
  productId: string;
  productName: string;
  quantity: number;
  branchId: string; // branch whose stock this entry affects
  branchName?: string;
  counterpartBranchId?: string; // the other branch, for transfers
  counterpartBranchName?: string;
  userName?: string;
  timestamp: string; // human-readable display string
  createdAt: number; // epoch ms — for sorting and monthly filtering
  transferId?: string; // groups the transfer_out/transfer_in pair(s) of one multi-product transfer
  unitPrice?: number; // sale price at transfer time, for the printed ticket's total — only set on transfer_out/transfer_in entries created after this field existed
}

// Best-effort, invisible audit log of the checkout SAVE funnel — one entry per real save
// attempt inside completeTransaction (i.e. only after credit/folio/stock/session validation
// already passed and a Sale object exists), plus its eventual outcome. This exists to answer
// one question after the fact: when a paper sale doesn't show up in Firestore, was it a
// technical save failure, or was it simply never rung up in the app at all? It is NOT a
// general error log, NOT surfaced in any UI screen, and NOT a substitute for the Sale record
// itself — it only has to prove an attempt happened and how it ended.
type CheckoutEventStatus =
  | 'started'                  // save attempt began after local validation
  | 'success'                  // sale and every dependent write committed atomically
  | 'failed'                   // atomic transaction rejected; no sale-side state was committed
  | 'offline_queued'           // read-only compatibility with historical diagnostic events
  | 'offline_resolved_success' // read-only compatibility with historical diagnostic events
  | 'offline_resolved_failed'; // read-only compatibility with historical diagnostic events

interface CheckoutEvent {
  id: string;
  saleId: string;              // newSale.id — links back to companies/{id}/sales/{saleId} when it exists
  status: CheckoutEventStatus;
  branchId?: string;           // newSale.branchId — "per branch" diagnostic
  branchName?: string;         // resolved once at attempt time, for readability without a join
  employeeName?: string;       // newSale.employeeName — "per employee" diagnostic
  userId?: string;             // auth.currentUser.uid — reliable grouping key even if employeeName is a display fallback
  paymentMethod?: Sale['paymentMethod'];
  total?: number;              // dollar exposure of attempts that failed/queued
  itemCount?: number;          // cart size, without duplicating full line-item detail
  errorMessage?: string;       // only set on failed / offline_resolved_failed
  isSessionInvalid?: boolean;  // only set on failed / offline_resolved_failed
  timestamp: string;           // human-readable, same convention as Sale.timestamp / StockMovement.timestamp
  createdAt: number;           // epoch ms — for sorting/filtering by day, same convention as StockMovement.createdAt
}

interface TransferLineItem {
  productId: string;
  quantity: number;
}

interface CompletedTransferItem {
  productId: string;
  productName: string;
  quantity: number;
  salePrice: number; // frozen at transfer time, same idea as SaleItem.salePrice
}

// Snapshot of a just-completed transfer, used to render the success modal and the printed
// ticket without re-resolving `products`/`branches` state later (mirrors how SaleItem freezes
// `name`/`salePrice` at sale time).
interface CompletedTransfer {
  id: string;
  timestamp: string;
  createdAt: number;
  sourceBranchId: string;
  sourceBranchName: string;
  sourceBranchAddress?: string;
  targetBranchId: string;
  targetBranchName: string;
  targetBranchAddress?: string;
  initiatedByName?: string;
  items: CompletedTransferItem[];
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: CompanyRole;
  joinedAt?: string;
  assignedBranchId?: string;
  permissions?: string[];
}

// Stock is per-branch: `branchStocks[branchId]` is the only real source of truth. The
// top-level `stock` field is just the consolidated total across every branch (kept for
// reports) and must NEVER be used as a stand-in for a branch that has no entry of its own —
// doing that made every branch "inherit" whatever another branch last did, which is why
// restocking one sucursal appeared to raise stock everywhere. A branch with no entry has
// simply never received that product: that's 0, not somebody else's number.
export const getProductStock = (prod: Product, branchId: string, products: Product[]): number => {
  if (prod.linkedStockProductId && prod.stockConsumptionFactor) {
    const parent = products.find(p => p.id === prod.linkedStockProductId);
    if (!parent) return 0; // parent deleted/missing — no stock, rather than crashing
    const parentStock = parent.branchStocks?.[branchId] ?? 0;
    return Math.floor(parentStock / prod.stockConsumptionFactor); // only whole units of the child can be sold
  }
  // Legacy products predating per-branch tracking have no branchStocks map at all; those
  // still read the single global number until their first per-branch movement.
  if (!prod.branchStocks) return prod.stock;
  return prod.branchStocks[branchId] ?? 0;
};

// Consolidated total across branches, for the `stock` field / reports. Rounded because
// shared-pool presentations use fractional factors (e.g. 0.5 L) and repeated adding would
// otherwise drift into values like 12.000000000000002.
const sumBranchStocks = (branchStocks: { [branchId: string]: number }): number =>
  Math.round(Object.values(branchStocks).reduce((acc, v) => acc + (v || 0), 0) * 1000) / 1000;

interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  category: string;
}

interface Branding {
  displayName?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  darkColor?: string;
  tagline?: string;
}

interface PrintConfig {
  paperWidth: '58mm' | '80mm' | 'A4';
  showLogo: boolean;
  showTaxLine: boolean;
  footerText: string;
}

const DEFAULT_PRINT_CONFIG: PrintConfig = {
  paperWidth: '80mm',
  showLogo: true,
  showTaxLine: true,
  footerText: '¡Gracias por su compra!',
};

export const formatMXN = (val: number): string => {
  if (isNaN(val) || val === undefined || val === null) return '$0.00 MXN';
  return `$${val.toFixed(2)} MXN`;
};

const MONTH_NAMES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export const getCurrentMonthKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Groups a sale into a "YYYY-MM" bucket. Uses the reliable numeric `createdAt` when
// available; falls back to parsing the legacy `timestamp` display string (best-effort,
// only affects sales recorded before `createdAt` was introduced).
export const getSaleMonthKey = (sale: Sale): string => {
  return getRecordMonthKey(sale);
};

// Same idea as getSaleMonthKey, but a "YYYY-MM-DD" bucket for the daily cut (Corte Diario).
export const getSaleDayKey = (sale: Sale): string => {
  return getRecordDayKey(sale);
};

// Same "YYYY-MM-DD" bucketing as getSaleDayKey, but for a raw epoch-ms timestamp — used to
// place cashRegister.transactions / stockMovements entries (which only carry `createdAt`,
// not a Sale) into the Corte Diario.
const msToDayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const getMonthLabel = (monthKey: string): string => {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES_ES[(m - 1 + 12) % 12]} ${y}`;
};

// Builds the descending list of month keys ("YYYY-MM") that have at least one sale,
// always including the current month even if it has no sales yet.
export const getAvailableMonths = (allSales: Sale[]): string[] => {
  const keys = new Set<string>([getCurrentMonthKey()]);
  allSales.forEach(s => {
    const key = getSaleMonthKey(s);
    if (key) keys.add(key);
  });
  return Array.from(keys).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
};

export default function App() {
  // Tabs: 'pos' | 'products' | 'customers' | 'history' | 'analytics' | 'branches' | 'suppliers' | 'settings' | 'invoicing'
  const [activeTab, setActiveTab] = useState<'pos' | 'products' | 'customers' | 'history' | 'analytics' | 'branches' | 'suppliers' | 'settings' | 'invoicing'>('pos');
  const [branding, setBranding] = useState<Branding>({});
  const [printConfig, setPrintConfig] = useState<PrintConfig>(DEFAULT_PRINT_CONFIG);

  // Preloaded logo for the iOS canvas-based ticket image (see printHtmlTicket) — loaded
  // ahead of time so printing never has to wait on an image load before calling
  // navigator.share(), which must fire within iOS's "recent user gesture" window.
  // crossOrigin lets a same-origin canvas draw it without tainting (blocking toDataURL()).
  const logoImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!branding.logoUrl) { logoImgRef.current = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = branding.logoUrl;
    logoImgRef.current = img;
  }, [branding.logoUrl]);

  // Selected Bluetooth thermal printer (e.g. MERION PT-B1). Tied to this physical device, not
  // the company/account, so it's kept in localStorage rather than Firestore.
  const [bluetoothPrinter, setBluetoothPrinter] = useState<BluetoothPrinterDevice | null>(() => {
    try {
      const raw = localStorage.getItem('logicpos_bt_printer');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const saveBluetoothPrinter = (device: BluetoothPrinterDevice | null) => {
    setBluetoothPrinter(device);
    if (device) safeLocalStorageSet('logicpos_bt_printer', JSON.stringify(device));
    else safeLocalStorageRemove('logicpos_bt_printer');
  };
  const handleScanBluetoothPrinters = async (): Promise<BluetoothPrinterDevice[]> => {
    const { devices } = await BluetoothPrinter.listPairedDevices();
    return devices;
  };
  const handleTestPrintBluetooth = async () => {
    if (!bluetoothPrinter) return;
    const bytes = buildTestPrint(columnsForPaperWidth(printConfig.paperWidth), businessName);
    await BluetoothPrinter.printEscPos({ address: bluetoothPrinter.address, data: uint8ToBase64(bytes) });
  };

  // Direct-to-printer for the plain web build (no APK installed) — WebUSB for a cabled
  // printer, Web Bluetooth as a best-effort option for printers whose chip also speaks BLE
  // (see src/lib/webBluetoothPrinter.ts for why classic Bluetooth can't be reached this way).
  // The live device handle only lives in memory for the session; `webPrinterInfo` persists
  // just the display name so the settings screen can show what was last connected.
  const [webUsbDevice, setWebUsbDevice] = useState<USBDevice | null>(null);
  const [webBluetoothDevice, setWebBluetoothDevice] = useState<BluetoothDevice | null>(null);
  const [webPrinterInfo, setWebPrinterInfo] = useState<{ mode: 'usb' | 'bluetooth'; name: string } | null>(() => {
    try {
      const raw = localStorage.getItem('logicpos_web_printer_info');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // WebUSB (unlike Web Bluetooth) can silently reattach a previously-authorized device on
  // load, since the printer is almost certainly still plugged into the same cable.
  React.useEffect(() => {
    if (isNativePlatform) return;
    getPairedUsbPrinters().then(devices => {
      if (devices.length > 0) {
        setWebUsbDevice(devices[0]);
        setWebPrinterInfo({ mode: 'usb', name: devices[0].productName || 'Impresora USB' });
      }
    }).catch(() => {});
  }, []);

  const handleConnectWebUsbPrinter = async () => {
    const device = await requestUsbPrinter();
    setWebUsbDevice(device);
    setWebBluetoothDevice(null);
    const info = { mode: 'usb' as const, name: device.productName || 'Impresora USB' };
    setWebPrinterInfo(info);
    safeLocalStorageSet('logicpos_web_printer_info', JSON.stringify(info));
  };

  const handleConnectWebBluetoothPrinter = async () => {
    const device = await requestBluetoothPrinter();
    setWebBluetoothDevice(device);
    setWebUsbDevice(null);
    const info = { mode: 'bluetooth' as const, name: device.name || 'Impresora Bluetooth' };
    setWebPrinterInfo(info);
    safeLocalStorageSet('logicpos_web_printer_info', JSON.stringify(info));
  };

  const handleForgetWebPrinter = () => {
    setWebUsbDevice(null);
    setWebBluetoothDevice(null);
    setWebPrinterInfo(null);
    safeLocalStorageRemove('logicpos_web_printer_info');
  };

  const handleTestPrintWeb = async () => {
    const bytes = buildTestPrint(columnsForPaperWidth(printConfig.paperWidth), businessName);
    if (webUsbDevice) return printUsb(webUsbDevice, bytes);
    if (webBluetoothDevice) return printBluetooth(webBluetoothDevice, bytes);
    throw new Error('No hay impresora conectada.');
  };

  // Apply branding palette to CSS variables and inject dynamic styles
  React.useEffect(() => {
    const validHex = (v?: string) => (v && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : null;
    const dark    = validHex(branding.darkColor)    || '#1e1b4b';
    const primary = validHex(branding.primaryColor) || '#6366f1';
    const accent  = validHex(branding.accentColor)  || '#a855f7';
    const root = document.documentElement;
    root.style.setProperty('--brand-dark', dark);
    root.style.setProperty('--brand-primary', primary);
    root.style.setProperty('--brand-accent', accent);
    // Inject/update dynamic brand stylesheet
    let styleEl = document.getElementById('brand-styles') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'brand-styles';
      document.head.appendChild(styleEl);
    }
    const p10  = `color-mix(in srgb, ${primary} 10%, white)`;
    const p15  = `color-mix(in srgb, ${primary} 15%, white)`;
    const p20  = `color-mix(in srgb, ${primary} 20%, white)`;
    const p25  = `color-mix(in srgb, ${primary} 25%, transparent)`;
    const pDark = `color-mix(in srgb, ${primary} 80%, black)`;
    const a15  = `color-mix(in srgb, ${accent} 15%, white)`;
    const a30  = `color-mix(in srgb, ${accent} 30%, transparent)`;
    const dDark = `color-mix(in srgb, ${dark} 80%, black)`;
    styleEl.textContent = `
      /* ── Nav sidebar active items ── */
      #nav-pos.active-nav, #nav-products.active-nav, #nav-customers.active-nav,
      #nav-branches.active-nav, #nav-suppliers.active-nav, #nav-invoicing.active-nav,
      #nav-history.active-nav, #nav-analytics.active-nav, #nav-settings.active-nav {
        background-color: ${p15} !important;
        color: ${primary} !important;
        border-color: ${p25} !important;
      }
      /* ── Primary text (prices, labels, links) ── */
      .text-indigo-600, .text-violet-600, .text-purple-600,
      .text-indigo-500, .text-violet-500, .text-purple-500,
      .text-indigo-400, .text-blue-600 { color: ${primary} !important; }
      .text-indigo-700, .text-violet-700, .text-purple-700 { color: ${pDark} !important; }
      /* ── Primary solid backgrounds (buttons, pills) ── */
      .bg-indigo-600, .bg-violet-600, .bg-purple-600 { background-color: ${primary} !important; }
      .bg-indigo-700, .bg-violet-700 { background-color: ${pDark} !important; }
      /* ── Light tint backgrounds ── */
      .bg-indigo-50, .bg-violet-50, .bg-purple-50 { background-color: ${p10} !important; }
      .bg-indigo-100, .bg-violet-100, .bg-purple-100 { background-color: ${p20} !important; }
      /* ── Borders ── */
      .border-indigo-500, .border-violet-500, .border-purple-500 { border-color: ${primary} !important; }
      .border-indigo-600, .border-violet-600, .border-purple-600 { border-color: ${primary} !important; }
      .border-indigo-100, .border-violet-100, .border-purple-100 { border-color: ${p15} !important; }
      .border-indigo-200, .border-violet-200, .border-purple-200 { border-color: ${p20} !important; }
      /* ── Hover pseudo-classes ── */
      .hover\\:bg-indigo-600:hover, .hover\\:bg-violet-600:hover, .hover\\:bg-purple-50:hover { background-color: ${primary} !important; }
      .hover\\:bg-indigo-700:hover, .hover\\:bg-violet-700:hover { background-color: ${pDark} !important; }
      .hover\\:text-indigo-600:hover, .hover\\:text-violet-600:hover { color: ${primary} !important; }
      /* ── Group-hover (product card add button) ── */
      .group:hover .group-hover\\:text-indigo-600 { color: ${primary} !important; }
      .group:hover .group-hover\\:bg-indigo-50 { background-color: ${p10} !important; }
      .group:hover .group-hover\\:border-indigo-100 { border-color: ${p15} !important; }
      /* ── Header overlays (semi-transparent on dark banner) ── */
      .bg-indigo-900\/40, .bg-purple-950\/60 { background-color: color-mix(in srgb, ${dark} 45%, transparent) !important; }
      .bg-indigo-900\/60 { background-color: color-mix(in srgb, ${dark} 60%, transparent) !important; }
      .bg-indigo-900\/80 { background-color: color-mix(in srgb, ${dark} 80%, transparent) !important; }
      .bg-indigo-800 { background-color: ${dDark} !important; }
      .bg-indigo-950 { background-color: color-mix(in srgb, ${dark} 90%, black) !important; }
      .border-indigo-700\/30 { border-color: color-mix(in srgb, ${primary} 30%, transparent) !important; }
      .border-indigo-700\/35 { border-color: color-mix(in srgb, ${primary} 35%, transparent) !important; }
      .border-indigo-700 { border-color: color-mix(in srgb, ${primary} 60%, black) !important; }
      .border-indigo-800, .border-purple-800\/30 { border-color: color-mix(in srgb, ${dark} 60%, black) !important; }
      .text-indigo-200, .text-purple-200 { color: color-mix(in srgb, ${primary} 40%, white) !important; }
      .text-indigo-300 { color: color-mix(in srgb, ${primary} 55%, white) !important; }
      .text-indigo-100 { color: color-mix(in srgb, ${primary} 25%, white) !important; }
      /* ── Focus rings ── */
      .ring-indigo-500, .focus\\:ring-indigo-500:focus { --tw-ring-color: ${primary} !important; }
      /* ── Custom classes ── */
      .btn-brand-primary { background-color: ${primary} !important; border-color: ${primary} !important; }
      .btn-brand-primary:hover { filter: brightness(1.12); }
    `;
  }, [branding]);

  const [posSubTab, setPosSubTab] = useState<'catalog' | 'history' | 'cashier'>('catalog');
  // Inventory display preference (cards vs compact list), remembered across sessions.
  const [inventoryView, setInventoryView] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('logic_inventory_view') as 'grid' | 'list') || 'grid'
  );
  // Independent from the Terminal POS search term: Inventario needs to find *any* catalog
  // item (including out-of-stock ones, which the POS search intentionally hides), so sharing
  // state would make the two screens' filtering feel inconsistent with each other.
  const [inventorySearchTerm, setInventorySearchTerm] = useState('');
  // Same idea for the Terminal POS catalog — kept as its own preference (not shared with
  // Inventario) since each row needs different actions: quick add-to-cart here vs. edit/
  // delete/surtir there. List mode packs many more products on screen without scrolling.
  const [posCatalogView, setPosCatalogView] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('logic_pos_catalog_view') as 'grid' | 'list') || 'grid'
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [nowStr, setNowStr] = useState(() => {
    const d = new Date();
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  });
  React.useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowStr(d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
    };
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);
  
  // Authentication state
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // Employee-credential login form (used by the mandatory login gate — see the early
  // return before the main JSX)
  const [authCompanyId, setAuthCompanyId] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [isSignInLoading, setIsSignInLoading] = useState(false);
  // Shown inline in the login form instead of alert(): alert() blocks JS execution until
  // dismissed, and on some Android WebView builds that native dialog doesn't render (or
  // renders somewhere the user never sees) — leaving the button stuck on "Verificando..."
  // forever with no visible error, even though the code already knew exactly what went wrong.
  const [authError, setAuthError] = useState('');

  // Credential-employee bootstrap ("Conectando al sistema..." waiting screen, see the
  // users/{uid} sync effect below): true once every automatic retry has been exhausted
  // without successfully rebuilding the profile, so the waiting screen can show a real
  // error + "Reintentar" button instead of spinning forever. bootstrapRetryTrigger lets that
  // button re-run the whole sync effect (it's in the effect's dependency array) without
  // needing the user to sign out and back in.
  const [credentialBootstrapFailed, setCredentialBootstrapFailed] = useState(false);
  const [bootstrapRetryTrigger, setBootstrapRetryTrigger] = useState(0);

  const handleCredentialSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    if (!authCompanyId.trim() || !authUsername.trim()) {
      setAuthError("Por favor completa el Código de Comercio y tu Número de Empleado.");
      return;
    }

    setIsSignInLoading(true);
    try {
      const cleanCompanyId = authCompanyId.trim().toLowerCase();
      const cleanUsername = authUsername.trim();

      // Build virtual email
      const virtualEmail = `${cleanCompanyId}_${cleanUsername}@logicpos.com`;

      // Password = employee number as-is (mirrors creation logic — see CompanySettingsView.handleCreateCredentialEmployee).
      // No zero-padding: employee numbers must be 6+ real digits, set at account creation time.
      const effectivePassword = cleanUsername;

      // Sign in natively with Firebase Auth using virtual email & password
      await signInWithEmailAndPassword(auth, virtualEmail, effectivePassword);

      // Clean local Form State
      setAuthCompanyId('');
      setAuthUsername('');
    } catch (err: any) {
      console.error("Error signing in with employee credentials:", err);
      let errMsg = "Credenciales incorrectas o problemas de conexión.";
      if (err.code === 'auth/operation-not-allowed' || (err.message && err.message.includes('operation-not-allowed'))) {
        errMsg = "El método de inicio de sesión por Correo/Contraseña está deshabilitado en tu Firebase Console.\n\nPara habilitarlo:\n1. Entra a console.firebase.google.com y ve a tu proyecto.\n2. Ve a 'Authentication' -> pestaña 'Sign-in method'.\n3. Habilita y guarda el proveedor 'Correo electrónico/contraseña'.";
      } else if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        errMsg = "El ID de comercio, usuario o contraseña son incorrectos.";
      }
      setAuthError(errMsg);
    } finally {
      setIsSignInLoading(false);
    }
  };

  // Multi-Company States
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  const [userCompanies, setUserCompanies] = useState<{ [id: string]: { id: string; name: string; role: CompanyRole } }>({});

  // Shared "which business is this" resolver — same fallback chain already used by the
  // printed receipt (ticketBusinessName) and the header, reused here for the browser tab
  // title/favicon and the WhatsApp/email/printer-test messages so they show the registered
  // company's own name instead of a hardcoded one (this app is multi-tenant white-label).
  const businessName = useMemo(
    () => branding.displayName || (activeCompanyId ? userCompanies[activeCompanyId]?.name : '') || 'Mi Comercio',
    [branding.displayName, activeCompanyId, userCompanies]
  );

  // Browser tab title + favicon, kept in sync with the resolved business name/logo. Neither
  // exists statically beyond a generic default in index.html — this is what makes them
  // dynamic per company instead of frozen at whatever loaded first.
  useEffect(() => {
    document.title = businessName && businessName !== 'Mi Comercio' ? `${businessName} powered by XAMU POS` : 'XAMU POS';
    let iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!iconLink) {
      iconLink = document.createElement('link');
      iconLink.rel = 'icon';
      document.head.appendChild(iconLink);
    }
    iconLink.href = branding.logoUrl || '/xamu_logo.png';
  }, [businessName, branding.logoUrl]);

  // Saves a generated file (CSV/PDF) so it actually reaches the user. Both platforms now show
  // a small Descargar/Compartir choice instead of picking one path automatically: on native,
  // "share" used to be the ONLY option (straight to the OS share sheet, with a real save
  // buried inside it as just one of the share targets, no confirmation) — testing the
  // Descargar path also needed to be possible on desktop, not just on a phone.
  const [pendingFileSave, setPendingFileSave] = useState<{ filename: string; base64Data: string; mimeType: string } | null>(null);

  const saveFileOnDevice = async (filename: string, base64Data: string, mimeType: string) => {
    setPendingFileSave({ filename, base64Data, mimeType });
  };

  const confirmDownloadPendingFile = async () => {
    if (!pendingFileSave) return;
    const { filename, base64Data, mimeType } = pendingFileSave;
    try {
      if (isNativePlatform) {
        // Directory.Documents (unlike the old Directory.Cache + share-only path) needs no
        // extra Android permission and lands somewhere the user can find via a Files app.
        await Filesystem.writeFile({ path: filename, data: base64Data, directory: Directory.Documents });
        alert(`"${filename}" se guardó correctamente en Documentos.`);
      } else {
        const byteChars = atob(base64Data);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('File download error:', err);
      alert('No se pudo descargar el archivo. Intenta compartirlo en su lugar.');
    } finally {
      setPendingFileSave(null);
    }
  };

  const confirmSharePendingFile = async () => {
    if (!pendingFileSave) return;
    const { filename, base64Data, mimeType } = pendingFileSave;
    try {
      if (isNativePlatform) {
        const result = await Filesystem.writeFile({ path: filename, data: base64Data, directory: Directory.Cache });
        await Share.share({ title: filename, url: result.uri, dialogTitle: `Guardar ${filename}` });
      } else {
        // Same base64 -> File conversion already used for the iOS ticket share fallback above.
        const byteChars = atob(base64Data);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const file = new File([bytes], filename, { type: mimeType });
        if (!navigator.share) {
          throw new Error('share-unsupported');
        }
        if (navigator.canShare && !navigator.canShare({ files: [file] })) {
          throw new Error('share-files-unsupported');
        }
        await navigator.share({ files: [file], title: filename });
      }
    } catch (err: any) {
      // AbortError = the user closed the share sheet themselves — not a real failure, no alert.
      if (err?.name !== 'AbortError') {
        console.error('File share error:', err);
        alert('No se pudo compartir el archivo. Usa "Descargar" en su lugar.');
      }
    } finally {
      setPendingFileSave(null);
    }
  };

  const [currentUserMember, setCurrentUserMember] = useState<any | null>(null);
  // Branch-sync gate ("Cargando tu sucursal..." screen, see the branch-lock effect below):
  // true once ~8s have passed while a branch-locked employee/admin is still waiting for
  // their assigned branch to be confirmed, so the gate can show a real error + "Reintentar"
  // instead of blocking the POS forever. branchSyncRetryTrigger lets that button re-run the
  // members/{uid} listener (it's in that effect's dependency array).
  const [branchSyncTimedOut, setBranchSyncTimedOut] = useState(false);
  const [branchSyncRetryTrigger, setBranchSyncRetryTrigger] = useState(0);
  // Firebase keeps a session alive indefinitely by refreshing its token in the background, so
  // the app can look logged in long after the session actually stopped being valid server-side
  // (revoked, password changed, account disabled). Revalidating in the background — never on
  // the checkout path, which would add a network round trip to every single sale — catches
  // that before the next sale is rung up instead of after it silently fails to save.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [firestoreConnectionState, setFirestoreConnectionState] = useState<'checking' | 'ready' | 'offline' | 'error'>('checking');
  const connectionController = useMemo(
    () =>
      new FirestoreConnectionController({
        probeFn: async (companyId) => {
          await getDocFromServer(doc(db, 'companies', companyId));
        },
        probeTimeoutMs: 8000,
      }),
    []
  );

  useEffect(() => {
    return connectionController.subscribe((state) => {
      setFirestoreConnectionState(state.status);
    });
  }, [connectionController]);

  const [folioNumber, setFolioNumber] = useState('');

  // Hard States
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string>('b1');

  // Prompts and custom Modals (bypassing restricted iframe prompt/confirms)
  const [paymentPrompt, setPaymentPrompt] = useState<{customerId: string, customerName: string, unpaidBalance: number} | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<'pending' | 'completed' | 'all'>('all');
  const [newCatPrompt, setNewCatPrompt] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [editInitialCashPrompt, setEditInitialCashPrompt] = useState(false);
  const [newInitialCash, setNewInitialCash] = useState('');

  
  const [cashRegister, setCashRegister] = useState<CashRegister>({
    isOpen: false,
    initialCash: 0,
    currentCash: 0,
    transactions: []
  });
  const [cashTransactions, setCashTransactions] = useState<CashTransaction[]>([]);
  const [legacyCashTransactions, setLegacyCashTransactions] = useState<CashTransaction[]>([]);
  const allCashTransactions = useMemo(() => {
    const merged = new Map<string, CashTransaction>();
    [...legacyCashTransactions, ...cashTransactions].forEach((entry, index) => {
      const legacyIndex = index < legacyCashTransactions.length ? index : -1;
      const key = entry.id || (entry.createdAt !== undefined && legacyIndex >= 0
        ? `LEGACY-${entry.createdAt}-${legacyIndex}`
        : `legacy-undated-${entry.type}-${entry.amount}-${entry.description}-${index}`);
      merged.set(key, entry);
    });
    return Array.from(merged.values()).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }, [legacyCashTransactions, cashTransactions]);

  // What the various cash-register widgets show — once the turno is closed, `currentCash`
  // still holds the real closing balance for audit/history purposes, but showing that number
  // next to a "Caja Cerrada" badge reads as if there were still an active balance in the
  // drawer, which confuses staff. Display 0 instead until the next Apertura sets a real one.
  const displayedCash = cashRegister.isOpen ? cashRegister.currentCash : 0;

  // Ad-hoc Custom Categories state
  const [customCategories, setCustomCategories] = useState<string[]>(() => {
    const saved = localStorage.getItem('logic_custom_categories');
    return saved ? JSON.parse(saved) : [];
  });
  const [newCategoryInput, setNewCategoryInput] = useState('');

  // Cash Register Dialog / Alert States
  const [showOvernightWarning, setShowOvernightWarning] = useState(false);
  const [warningOperationalDate, setWarningOperationalDate] = useState('');
  
  const [isCorteModalOpen, setIsCorteModalOpen] = useState(false);
  const [realCashInput, setRealCashInput] = useState('');
  
  const [isOpeningCajaModalOpen, setIsOpeningCajaModalOpen] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState('2000');
  const [showClosedCajaBanner, setShowClosedCajaBanner] = useState(true);

  // Distribution branch state
  const [isDistModalOpen, setIsDistModalOpen] = useState(false);
  const [distSourceBranchId, setDistSourceBranchId] = useState('');
  const [distDestBranchId, setDistDestBranchId] = useState('');
  const [distQuantities, setDistQuantities] = useState<{[prodId: string]: number}>({});

  const activeCompanyRole = user && activeCompanyId ? (userCompanies[activeCompanyId]?.role || 'employee') : 'owner';
  const isOwner = isOwnerRole(activeCompanyRole);
  // A persisted role outside the three supported ones (e.g. a legacy master_admin that has not
  // been converted yet) gets no defaults, no branch lock and no permissions, which would leave
  // an inert POS full of "no branch" errors. Block it explicitly instead — see the
  // role-migration gate near the bottom of this component.
  const roleNeedsMigration = !!(user && activeCompanyId)
    && !(['owner', 'admin', 'employee'] as string[]).includes(activeCompanyRole);
  // Encargados (admin) manage a single sucursal, same as Cajeros (employee) — only
  // Owner can see/switch between every sucursal of the company. The Owner
  // still reassigns an Encargado's branch from Mi Empresa/Equipo (Member.assignedBranchId);
  // that change takes effect here automatically since currentUserMember is a live listener.
  const isBranchLocked = activeCompanyRole === 'employee' || activeCompanyRole === 'admin';
  const assignedBranchId = currentUserMember?.assignedBranchId?.trim() || '';
  // Every branch-scoped operation uses this value. A non-owner never inherits a stale
  // localStorage/header branch while their member document is loading or malformed.
  const operationalBranchId = isOwner ? selectedBranchId : assignedBranchId;
  const canViewSalesHistory = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'sales_history');
  const canEditProducts = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'products_edit');
  const canTransferStock = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'stock_transfer');
  const canRestock = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'stock_restock');
  const canManageSuppliers = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'suppliers_restock');
  const canCloseCash = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'cash_close');
  const canApplyDiscount = hasAppPermission(activeCompanyRole, currentUserMember?.permissions, 'apply_discount');
  // A plain cashier sees only today's sales of its branch (no statistics, cash audit, inventory
  // log or older periods); those heavier streams are only opened for whoever uses them.
  const { canViewCashAudit, canViewInventoryLog, canViewAnalytics, salesWindow } =
    getHistoryAccess(activeCompanyRole, currentUserMember?.permissions);
  // Owner refunds in any branch; an Encargado (admin) only in its assigned branch.
  const canRefundSales = canRefundSalesRole(activeCompanyRole);
  // Invoicing (Facturación): the owner for every branch, an Encargado for its assigned branch only.
  const canManageInvoicing = canManageInvoicingRole(activeCompanyRole);
  const canCreateCompany = !activeCompanyId
    ? Object.keys(userCompanies).length === 0 || Object.values(userCompanies).some((company: { role: CompanyRole }) => isOwnerRole(company.role))
    : isOwner;
  const canViewSuppliers = canManageSuppliers || canRestock;

  useEffect(() => {
    const lacksSelectedModule =
      (activeTab === 'history' && !canViewSalesHistory)
      || (activeTab === 'analytics' && !canViewAnalytics)
      || (activeTab === 'branches' && !isOwner)
      || (activeTab === 'suppliers' && !canViewSuppliers)
      || (activeTab === 'invoicing' && !canManageInvoicing)
      || (activeTab === 'settings' && !isOwner);
    if (lacksSelectedModule) setActiveTab('pos');
  }, [activeTab, canManageInvoicing, canManageSuppliers, canRestock, canViewAnalytics, canViewSalesHistory, canViewSuppliers, isOwner]);

  useEffect(() => {
    if (!canApplyDiscount) setDiscountVal(0);
  }, [canApplyDiscount]);
  // True while a branch-locked employee/admin's real assigned branch hasn't been confirmed
  // yet from companies/{id}/members/{uid} — gates the whole POS (see the waiting screen near
  // the bottom of this component) so a sale/stock/cash entry can never be filed under a stale
  // or placeholder branchId while this is still settling right after login.
  const assignedBranchExists = branches.length > 0 && branches.some(branch => branch.id === assignedBranchId);
  const branchSyncPending = !!activeCompanyId && isBranchLocked && (
    !currentUserMember || !assignedBranchId || !assignedBranchExists || selectedBranchId !== assignedBranchId
  );

  // True when the logged-in user authenticated with an employee code (virtual email), not Google
  const isCredentialEmployee = Boolean(user?.email?.includes('_') && user?.email?.endsWith('@logicpos.com'));

  // Last-resort label for "who rang this up". Credential employees sign in with a virtual
  // email (comp_384860_103003@logicpos.com) and never get a Firebase displayName, so if their
  // member document hasn't loaded there'd be nothing left to identify them by — and a sale
  // with no seller is exactly what makes an incident impossible to trace later. The employee
  // number is always recoverable from the address itself.
  const employeeNumberFromEmail = useMemo(() => {
    if (!isCredentialEmployee || !user?.email) return undefined;
    const local = user.email.split('@')[0];
    const firstUnderscore = local.indexOf('_');
    const secondUnderscore = local.indexOf('_', firstUnderscore + 1);
    if (secondUnderscore === -1) return undefined;
    return local.substring(secondUnderscore + 1) || undefined;
  }, [isCredentialEmployee, user?.email]);

  // Handler to Create a new Company inside cloud & bootstrap default entities
  const handleCreateCompany = async (companyName: string) => {
    if (!companyName.trim()) return;
    if (!user) return;
    if (!canCreateCompany) {
      alert('Solo el Dueño puede crear una nueva empresa desde una sesión con membresías existentes.');
      return;
    }

    try {
      const companyId = createDocumentId('comp');
      const newCompany = {
        id: companyId,
        name: companyName,
        ownerId: user.uid,
        invitationCode: null,
        createdAt: new Date().toISOString()
      };

      // 1. Save company registration document
      await setDoc(doc(db, 'companies', companyId), newCompany);

      // 2. Add creator as owner member
      await setDoc(doc(db, 'companies', companyId, 'members', user.uid), {
        userId: user.uid,
        name: user.displayName || 'Propietario',
        email: user.email || '',
        role: 'owner',
        joinedAt: new Date().toISOString()
      });

      // 3. No branches exist yet at this point, so there's nothing to pre-create a cash
      // register for — each branch gets its own companies/{id}/cashRegisters/{branchId}
      // doc lazily, the first time someone opens its register (see writeCashRegisterForBranch).

      // 4. Update parent profile
      const updatedCompanies = {
        ...userCompanies,
        [companyId]: {
          id: companyId,
          name: companyName,
          role: 'owner' as const
        }
      };

      await setDoc(doc(db, 'users', user.uid), {
        companies: updatedCompanies,
        activeCompanyId: companyId
      }, { merge: true });

      safeLocalStorageSet(`logic_active_company_${user.uid}`, companyId);
      setActiveCompanyId(companyId);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `companies_creation`);
    }
  };

  const handleRestoreCompanyData = async (backupData: any, onProgress: (msg: string) => void) => {
    if (!isOwner) throw new Error('Solo el Dueño puede restaurar los datos de la empresa.');
    if (!activeCompanyId) throw new Error("No hay un comercio seleccionado.");
    if (!backupData || typeof backupData !== 'object') {
      throw new Error("El archivo de respaldo no es válido o está corrupto.");
    }
    if (!Array.isArray(backupData.products) && backupData.products !== undefined) {
      throw new Error("El campo 'products' del respaldo no tiene el formato correcto.");
    }

    onProgress("Inicializando restauración...");

    // Products
    if (backupData.products && backupData.products.length > 0) {
      for (let i = 0; i < backupData.products.length; i++) {
        const p = backupData.products[i];
        onProgress(`Restaurando productos: ${i + 1} de ${backupData.products.length}...`);
        await setDoc(doc(db, 'companies', activeCompanyId, 'products', p.id), p);
      }
    }

    // Sales
    if (backupData.sales && backupData.sales.length > 0) {
      for (let i = 0; i < backupData.sales.length; i++) {
        const s = backupData.sales[i];
        onProgress(`Restaurando historial de ventas: ${i + 1} de ${backupData.sales.length}...`);
        await setDoc(doc(db, 'companies', activeCompanyId, 'sales', s.id), s);
      }
    }

    // Customers
    if (backupData.customers && backupData.customers.length > 0) {
      for (let i = 0; i < backupData.customers.length; i++) {
        const c = backupData.customers[i];
        onProgress(`Restaurando catálogo de clientes: ${i + 1} de ${backupData.customers.length}...`);
        await setDoc(doc(db, 'companies', activeCompanyId, 'customers', c.id), c);
      }
    }

    // Branches
    if (backupData.branches && backupData.branches.length > 0) {
      for (let i = 0; i < backupData.branches.length; i++) {
        const b = backupData.branches[i];
        onProgress(`Restaurando sucursales: ${i + 1} de ${backupData.branches.length}...`);
        await setDoc(doc(db, 'companies', activeCompanyId, 'branches', b.id), b);
      }
    }

    // Suppliers
    if (backupData.suppliers && backupData.suppliers.length > 0) {
      for (let i = 0; i < backupData.suppliers.length; i++) {
        const sup = backupData.suppliers[i];
        onProgress(`Restaurando proveedores: ${i + 1} de ${backupData.suppliers.length}...`);
        await setDoc(doc(db, 'companies', activeCompanyId, 'suppliers', sup.id), sup);
      }
    }

    // Custom Categories
    if (Array.isArray(backupData.customCategories)) {
      onProgress("Restaurando categorías personalizadas...");
      safeLocalStorageSet('logic_custom_categories', JSON.stringify(backupData.customCategories));
      setCustomCategories(backupData.customCategories);
    }

    // Branding settings
    if (backupData.branding && typeof backupData.branding === 'object' && Object.keys(backupData.branding).length > 0) {
      onProgress("Restaurando apariencia del comercio...");
      await setDoc(doc(db, 'companies', activeCompanyId, 'settings', 'branding'), backupData.branding, { merge: true });
    }

    onProgress("¡Completado!");
  };

  // Handler to Join an existing Company using an Active invitation Code
  const handleJoinCompanyWithCode = async (code: string) => {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) return;
    if (!user) return;
    // Credential employees (employee-number accounts) cannot use invite codes
    if (isCredentialEmployee) {
      alert("Los códigos de invitación son exclusivos para cuentas de Google. Las cuentas de empleado son creadas por el administrador desde el panel de Equipo.");
      return;
    }

    try {
      // Fetch global invitation code doc
      const inviteDocSnap = await getDoc(doc(db, 'invitationCodes', cleanCode));
      if (!inviteDocSnap.exists()) {
        alert("El código de invitación ingresado es incorrecto, ya ha expirado o fue retirado.");
        return;
      }

      const inviteData = inviteDocSnap.data();
      const compId = inviteData.companyId;
      const compName = inviteData.companyName || "Empresa Invitada";
      const userRole = inviteData.role || "employee";
      const assignedBranchId = typeof inviteData.assignedBranchId === 'string'
        ? inviteData.assignedBranchId.trim()
        : '';
      if (!assignedBranchId) {
        alert('Esta invitación no tiene una sucursal asignada. Solicita al Dueño que genere un código nuevo.');
        return;
      }
      const usageType = inviteData.usageType || 'multiple';
      const expiresAtMs = typeof inviteData.expiresAt?.toMillis === 'function'
        ? inviteData.expiresAt.toMillis()
        : 0;
      if (!expiresAtMs || expiresAtMs <= Date.now()) {
        alert('Este código de invitación ya expiró. Solicita uno nuevo al propietario.');
        return;
      }

      const memberRef = doc(db, 'companies', compId, 'members', user.uid);
      const userRef = doc(db, 'users', user.uid);
      const inviteRef = doc(db, 'invitationCodes', cleanCode);
      const companyRef = doc(db, 'companies', compId);
      const joinBatch = writeBatch(db);

      // Membership, user profile and single-use consumption are one atomic request. A
      // single-use code can therefore never admit two users through a delete race.
      joinBatch.set(memberRef, {
        userId: user.uid,
        name: user.displayName || 'Empleado',
        email: user.email || '',
        role: userRole,
        assignedBranchId,
        joinedAt: new Date().toISOString(),
        inviteCode: cleanCode
      });

      // Map to user accounts profile
      const updatedCompanies = {
        ...userCompanies,
        [compId]: {
          id: compId,
          name: compName,
          role: userRole as any
        }
      };

      joinBatch.set(userRef, {
        companies: updatedCompanies,
        activeCompanyId: compId
      }, { merge: true });

      if (usageType === 'single') {
        joinBatch.delete(inviteRef);
        joinBatch.update(companyRef, { invitationCode: null });
      }
      await joinBatch.commit();

      safeLocalStorageSet(`logic_active_company_${user.uid}`, compId);
      setActiveCompanyId(compId);
      alert(`Te has unido exitosamente a "${compName}" con rol de ${userRole === 'admin' ? 'Administrador' : 'Empleado'}.${usageType === 'single' ? ' (El enlace temporal de un solo uso fue desactivado)' : ''}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `invitation_code_join`);
    }
  };

  // Delete an existing company (Requires owner role)
  // Deletes every document in a company subcollection, chunked into batches of at most
  // 450 ops to stay safely under Firestore's 500-write batch limit.
  const deleteAllDocsInSubcollection = async (companyId: string, subcollection: string) => {
    const snap = await getDocs(collection(db, 'companies', companyId, subcollection));
    const docRefs = snap.docs.map(d => d.ref);
    for (let i = 0; i < docRefs.length; i += 450) {
      const batch = writeBatch(db);
      docRefs.slice(i, i + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
  };

  const handleDeleteCompany = async (companyId: string) => {
    if (!user) return;
    if (!isOwnerRole(userCompanies[companyId]?.role || 'employee')) {
      alert('Solo el Dueño puede eliminar una empresa.');
      return;
    }
    try {
      // 1. Delete the root company doc first, while the caller's own owner membership
      // doc still exists (companies.delete requires isOwner(), which reads that doc).
      await deleteDoc(doc(db, 'companies', companyId));

      // 2. Delete every subcollection doc. `members` must go last: every other
      // subcollection's delete rule checks membership, which reads
      // the requester's own members/{uid} doc — deleting it earlier would lock the rest
      // of this cleanup out partway through. Leaving stray subcollection docs behind
      // (as the old root-doc-only delete did) meant former members kept full read/write
      // access to "deleted" company data forever, since isMemberOfCompany never checks
      // whether the parent companies/{companyId} doc still exists.
      for (const sub of ['products', 'customers', 'branches', 'suppliers', 'sales', 'cashRegisters', 'stockMovements', 'settings']) {
        await deleteAllDocsInSubcollection(companyId, sub);
      }
      await deleteAllDocsInSubcollection(companyId, 'members');

      // 3. Remove company from user's companies profile mapping
      const updatedCompanies = { ...userCompanies };
      delete updatedCompanies[companyId];

      const userRef = doc(db, 'users', user.uid);
      await updateDoc(userRef, {
        companies: updatedCompanies,
        ...(activeCompanyId === companyId ? { activeCompanyId: null } : {})
      });

      // Clear local storage key choice
      safeLocalStorageRemove(`logic_active_company_${user.uid}`);
      if (activeCompanyId === companyId) {
        setActiveCompanyId(null);
      }
      alert("La empresa ha sido eliminada permanentemente en la nube.");
    } catch (err) {
      console.error("Error deleting company:", err);
      alert("Error al intentar eliminar la empresa. Por favor confirma tus privilegios de Propietario o red.");
    }
  };

  // Auth Status listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (usr) => {
      setUser(usr);
      setIsAuthLoading(false);
    });
    return () => unsub();
  }, []);

  // Background session revalidation (see `sessionExpired` above). Runs when the app regains
  // focus — the realistic moment for a shift change on a shared terminal — plus a slow
  // interval as a fallback. Being offline is NOT an expired session: that error code is
  // ignored so a weak signal never locks a cashier out of the register.
  useEffect(() => {
    if (!user) return;

    const revalidate = async () => {
      try {
        await user.getIdToken(true);
        setSessionExpired(false);
      } catch (err: any) {
        if (err?.code === 'auth/network-request-failed') return;
        console.error('Session revalidation failed:', err);
        setSessionExpired(true);
      }
    };

    const onVisibilityChange = () => { if (!document.hidden) revalidate(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = setInterval(revalidate, 10 * 60 * 1000);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(interval);
    };
  }, [user]);

  // Generation-aware connection controller: validates Firestore access via server-read probe.
  // Mono-increasing generation prevents stale probes, network fluctuations, or company switches
  // from leaving the POS in permanent checking state or falsely marking an old company ready.
  useEffect(() => {
    connectionController.setCompanyId(user && activeCompanyId ? activeCompanyId : null);
  }, [user, activeCompanyId, connectionController]);

  useEffect(() => {
    let removeNetworkListener: (() => Promise<void>) | undefined;

    void Network.getStatus()
      .then((status) => connectionController.notifyNetwork(status))
      // A failing plugin (older APK without it) leaves connectivity unknown; the Firestore probe
      // decides instead of locking checkout behind a false "Sin conexión".
      .catch(() => connectionController.notifyNetworkUnknown());

    void Network.addListener('networkStatusChange', (status) =>
      connectionController.notifyNetwork(status)
    ).then((handle) => {
      removeNetworkListener = () => handle.remove();
    }).catch(() => {
      // Same older APKs as above: without the plugin there are no network events to follow;
      // the Firestore probe and the visibility retry below keep the state honest.
    });

    const onVisibilityChange = () => {
      if (!document.hidden) connectionController.retry();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (removeNetworkListener) void removeNetworkListener();
    };
  }, [connectionController]);

  // Listen for direct URL invitation links (e.g. ?invite=INV-XXXXX)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('invite');
    if (inviteCode) {
      sessionStorage.setItem('pending_invite_code', inviteCode.trim().toUpperCase());
      // Clean URL parameters immediately to keep clean slate
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Process pending invitation code once user becomes authenticated
  useEffect(() => {
    if (user && !isAuthLoading) {
      const pendingCode = sessionStorage.getItem('pending_invite_code');
      if (pendingCode) {
        sessionStorage.removeItem('pending_invite_code');
        handleJoinCompanyWithCode(pendingCode);
      }
    }
  }, [user, isAuthLoading]);

  // Multi-Company User registration and listings synchronization listeners
  useEffect(() => {
    if (!user) {
      setActiveCompanyId(null);
      setUserCompanies({});
      return;
    }

    // Restore activeCompanyId immediately from localStorage so Firestore listeners
    // start right away and avoid a blank-data flash while the users doc snapshot resolves
    const quickRestore = localStorage.getItem(`logic_active_company_${user.uid}`);
    if (quickRestore) setActiveCompanyId(quickRestore);

    const isVirtualEmployee = !!(user.email && user.email.includes('_') && user.email.endsWith('@logicpos.com'));
    let parsedCompanyId: string | null = null;
    if (isVirtualEmployee) {
      const emailLocal = user.email!.split('@')[0];
      const firstUnderscore = emailLocal.indexOf('_');
      const secondUnderscore = emailLocal.indexOf('_', firstUnderscore + 1);
      parsedCompanyId = secondUnderscore !== -1 ? emailLocal.substring(0, secondUnderscore) : null;
    }

    // Bootstraps (or rebuilds) a credential (virtual-email) employee's users/{uid} doc from
    // their company member record. Called both when the doc doesn't exist yet (first login)
    // and when it exists but was left with an empty `companies` map (a stuck/"poisoned"
    // profile from before this self-heal existed, or any other transient failure) — that
    // second case used to be a permanent dead end, since a doc that already exists never
    // re-triggers the "doesn't exist" branch again, not even after signing out and back in.
    // Retries several times over ~10s to ride out brief connectivity/propagation hiccups
    // (e.g. right after an Owner creates the account) before finally giving up and letting
    // the waiting screen show a real error + "Reintentar" button instead of spinning forever.
    const bootstrapCredentialEmployee = async (attempt: number) => {
      if (!parsedCompanyId) { setCredentialBootstrapFailed(true); return; }
      if (attempt === 0) setCredentialBootstrapFailed(false);
      try {
        const memberSnap = await getDoc(doc(db, 'companies', parsedCompanyId, 'members', user.uid));
        if (!memberSnap.exists()) throw new Error('member-not-visible-yet');
        const mData = memberSnap.data();

        let compName = 'Mi Empresa';
        try {
          const compSnap = await getDoc(doc(db, 'companies', parsedCompanyId));
          if (compSnap.exists()) compName = compSnap.data().name || compName;
        } catch {
          // Company name lookup failing isn't fatal — fall back to the generic label.
        }

        await setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          email: user.email || '',
          name: mData.name || 'Empleado',
          createdAt: new Date().toISOString(),
          companies: {
            [parsedCompanyId]: {
              id: parsedCompanyId,
              name: compName,
              role: mData.role || 'employee'
            }
          },
          activeCompanyId: parsedCompanyId
        });
      } catch (err) {
        if (attempt < 4) {
          setTimeout(() => bootstrapCredentialEmployee(attempt + 1), 2500);
        } else {
          setCredentialBootstrapFailed(true);
        }
      }
    };

    const unsubUser = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        const companies = data.companies || {};
        const keys = Object.keys(companies);

        if (keys.length === 0 && isVirtualEmployee) {
          // Stuck/poisoned credential-employee profile — self-heal instead of leaving it
          // stranded (see comment on bootstrapCredentialEmployee above).
          bootstrapCredentialEmployee(0);
          return;
        }

        setUserCompanies(companies);

        const savedActiveCompanyId = localStorage.getItem(`logic_active_company_${user.uid}`);
        const cloudActiveCompanyId = data.activeCompanyId;

        if (cloudActiveCompanyId && companies[cloudActiveCompanyId]) {
          setActiveCompanyId(cloudActiveCompanyId);
        } else if (savedActiveCompanyId && companies[savedActiveCompanyId]) {
          setActiveCompanyId(savedActiveCompanyId);
        } else if (keys.length > 0) {
          setActiveCompanyId(keys[0]);
        } else {
          setActiveCompanyId(null);
        }
      } else if (isVirtualEmployee) {
        bootstrapCredentialEmployee(0);
      } else {
        // Genuine new signup (Google account that's never created/joined a company) — this
        // IS the correct steady state, not a failure: seeds an empty companies map so they
        // land on "create your first company" instead of the employee waiting screen.
        setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          email: user.email || '',
          name: user.displayName || 'Comerciante',
          createdAt: new Date().toISOString(),
          companies: {}
        }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
        setActiveCompanyId(null);
        setUserCompanies({});
      }
    }, (error) => {
      // If the listener subscription itself fails (not just a read inside
      // bootstrapCredentialEmployee — e.g. a transient permission error right after sign-in,
      // before the auth token is fully settled), a credential employee would otherwise be
      // stuck on the waiting screen forever with no path to the "Reintentar" button, since
      // that button only gets armed by bootstrapCredentialEmployee's own retry exhaustion.
      if (isVirtualEmployee) setCredentialBootstrapFailed(true);
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    return () => unsubUser();
  }, [user, bootstrapRetryTrigger]);

  // Self-healing role sync to preserve security and sync changes automatically across active teams
  useEffect(() => {
    if (!user || !activeCompanyId || !userCompanies[activeCompanyId]) {
      setCurrentUserMember(null);
      return;
    }

    const unsubMemberSelf = onSnapshot(doc(db, 'companies', activeCompanyId, 'members', user.uid), (snapshot) => {
      if (snapshot.exists()) {
        const memberData = snapshot.data();
        setCurrentUserMember(memberData);

        const realRole = memberData.role;
        const currentRoleInUserDoc = userCompanies[activeCompanyId]?.role;
        
        if (realRole && realRole !== currentRoleInUserDoc) {
          console.log(`Self-healing company role sync: ${currentRoleInUserDoc} -> ${realRole}`);
          const updatedCompanies = {
            ...userCompanies,
            [activeCompanyId]: {
              ...userCompanies[activeCompanyId],
              role: realRole
            }
          };
          updateDoc(doc(db, 'users', user.uid), {
            companies: updatedCompanies
          }).catch(err => {
            console.error("Error healing company role:", err);
          });
        }
      } else {
        setCurrentUserMember(null);
      }
    }, (error) => {
      console.warn("User has not synced member record yet:", error.message);
    });

    return () => unsubMemberSelf();
  }, [user, activeCompanyId, userCompanies, branchSyncRetryTrigger]);

  // Lock the branch selector for employees and encargados (admin) — both manage a single
  // sucursal; only owner can roam across all of them. Re-runs whenever
  // currentUserMember changes, so an Owner reassigning this user's branch takes effect live.
  useEffect(() => {
    if (!user || !activeCompanyId) return;

    const assigned = currentUserMember?.assignedBranchId?.trim() || '';
    if (isBranchLocked && assigned) {
      if (selectedBranchId !== assigned) {
        setSelectedBranchId(assigned);
        safeLocalStorageSet(`logic_active_branch_${user.uid}`, assigned);
      }
    }
  }, [currentUserMember, isBranchLocked, selectedBranchId, activeCompanyId, user]);

  // Owners can retain a legacy/deleted branch ID in localStorage. A native <select> then
  // displays its first option even though React state still contains the missing ID, making
  // the header look correct while POS stock and cash are read from a nonexistent branch.
  useEffect(() => {
    if (!user || !activeCompanyId || isBranchLocked || branches.length === 0) return;
    const resolvedBranchId = resolveActiveBranchId(selectedBranchId, branches.map(branch => branch.id));
    if (!resolvedBranchId || resolvedBranchId === selectedBranchId) return;
    setSelectedBranchId(resolvedBranchId);
    safeLocalStorageSet(`logic_active_branch_${user.uid}`, resolvedBranchId);
  }, [branches, selectedBranchId, isBranchLocked, activeCompanyId, user]);

  // Safety valve for the branch-sync gate above: if companies/{id}/members/{uid} never
  // resolves (permission error, offline, etc. — see the onSnapshot error handler above,
  // which today just logs a warning and never retries), branchSyncPending would otherwise
  // stay true forever with no way out. After ~8s, surface a real error + "Reintentar"/"Salir"
  // instead of leaving the employee stuck on a spinner.
  useEffect(() => {
    if (!branchSyncPending) {
      setBranchSyncTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setBranchSyncTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [branchSyncPending, branchSyncRetryTrigger]);

  // Sync state from Firestore
  useEffect(() => {
    if (!user) {
      // Logged out: the whole app is gated behind login (see the early return before the
      // main JSX), so nothing here is ever visible — but we still clear state rather than
      // loading the old "modo local" fallback from localStorage. That fallback used to read
      // back `logic_products`/`logic_sales`/etc., which are the SAME keys saveAllData() mirrors
      // on every authenticated write as an offline-durability cache — so a logged-out session
      // on a device that had previously been signed in could load and briefly hold real
      // production data in memory. Clearing avoids that entirely.
      setBranding({});
      setProducts([]);
      setCustomers([]);
      setBranches([]);
      setSuppliers([]);
      setSales([]);
      return;
    }

    if (!activeCompanyId) {
      // Clean display till company is picked
      setProducts([]);
      setCustomers([]);
      setBranches([]);
      setSuppliers([]);
      setSales([]);
      setStockMovements([]);
      setBranding({});
      return;
    }

    // Connect real-time Firestore synchronization feeds
    const compId = activeCompanyId;

    const unsubProducts = onSnapshot(collection(db, 'companies', compId, 'products'), (snapshot) => {
      const list: Product[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Product);
      });
      setProducts(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/products`);
    });

    const unsubCustomers = onSnapshot(collection(db, 'companies', compId, 'customers'), (snapshot) => {
      const list: Customer[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Customer);
      });
      setCustomers(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/customers`);
    });

    const unsubBranches = onSnapshot(collection(db, 'companies', compId, 'branches'), (snapshot) => {
      const list: Branch[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Branch);
      });
      setBranches(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/branches`);
    });

    const unsubSuppliers = onSnapshot(collection(db, 'companies', compId, 'suppliers'), (snapshot) => {
      const list: Supplier[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Supplier);
      });
      setSuppliers(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/suppliers`);
    });

    const unsubMembers = onSnapshot(collection(db, 'companies', compId, 'members'), (snapshot) => {
      const list: Member[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Member);
      });
      setMembers(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/members`);
    });

    const unsubBranding = onSnapshot(doc(db, 'companies', compId, 'settings', 'branding'), (snapshot) => {
      if (snapshot.exists()) {
        setBranding(snapshot.data() as Branding);
      } else {
        setBranding({});
      }
    }, (err) => {
      // Log permission errors without clearing branding (rules may still be propagating)
      console.error('[Branding] onSnapshot error:', err.code, err.message);
    });

    const unsubPrintConfig = onSnapshot(doc(db, 'companies', compId, 'settings', 'printConfig'), (snapshot) => {
      if (snapshot.exists()) {
        setPrintConfig({ ...DEFAULT_PRINT_CONFIG, ...snapshot.data() } as PrintConfig);
      } else {
        setPrintConfig(DEFAULT_PRINT_CONFIG);
      }
    }, (err) => {
      console.error('[PrintConfig] onSnapshot error:', err.code, err.message);
    });

    // Per-user key first (keeps each employee's own remembered branch on a shared device);
    // falls back to the old shared key so nobody has to re-pick their branch after this
    // migration — the old key just stops being written to going forward.
    const savedActiveBranch = localStorage.getItem(`logic_active_branch_${user.uid}`) || localStorage.getItem('logic_active_branch');
    if (savedActiveBranch) setSelectedBranchId(savedActiveBranch);

    return () => {
      unsubProducts();
      unsubCustomers();
      unsubBranches();
      unsubSuppliers();
      unsubMembers();
      unsubBranding();
      unsubPrintConfig();
    };
  }, [user, activeCompanyId]);

  // Cash register is scoped per-branch (companies/{id}/cashRegisters/{branchId}), not one
  // shared document — otherwise switching branches shows the same balance everywhere.
  // Kept in its own effect (instead of the big listener effect above) so it re-subscribes
  // only when the branch actually changes, not on every unrelated company-level update.
  useEffect(() => {
    if (!user || !activeCompanyId || !operationalBranchId) return;
    const compId = activeCompanyId;
    const branchId = operationalBranchId;
    const currentMonthRange = getMonthRange(getCurrentMonthKey());

    setCashTransactions([]);
    setLegacyCashTransactions([]);

    const unsubCash = onSnapshot(doc(db, 'companies', compId, 'cashRegisters', branchId), (snapshot) => {
      if (snapshot.exists()) {
        // Defaults first, then the doc's own fields — a register doc can exist with only
        // currentCash/transactions if it was auto-created by a sale/transfer delta before
        // anyone ever pressed "abrir caja" (isOpen/initialCash would otherwise be missing).
        const data = snapshot.data() as Partial<CashRegister>;
        setLegacyCashTransactions(Array.isArray(data.transactions) ? data.transactions : []);
        setCashRegister({ isOpen: false, initialCash: 0, currentCash: 0, ...data, transactions: [] } as CashRegister);
      } else {
        // No register doc yet for this branch (brand-new branch, never opened) — show a
        // clean closed state instead of leaking whatever the previous branch had cached.
        setCashRegister({ isOpen: false, initialCash: 0, currentCash: 0, transactions: [] });
        setLegacyCashTransactions([]);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `companies/${compId}/cashRegisters/${branchId}`);
    });

    let unsubCashTransactions = () => {};
    if (canViewCashAudit) {
      const cashLedgerQuery = currentMonthRange
        ? query(
            collection(db, 'companies', compId, 'cashRegisters', branchId, 'transactions'),
            where('createdAt', '>=', currentMonthRange.start),
            orderBy('createdAt', 'desc'),
            limit(2000)
          )
        : query(collection(db, 'companies', compId, 'cashRegisters', branchId, 'transactions'), limit(2000));
      unsubCashTransactions = onSnapshot(cashLedgerQuery, (snapshot) => {
        const list: CashTransaction[] = [];
        snapshot.forEach(entry => list.push({ id: entry.id, ...entry.data() } as CashTransaction));
        setCashTransactions(list);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `companies/${compId}/cashRegisters/${branchId}/transactions`);
      });
    }

    return () => {
      unsubCash();
      unsubCashTransactions();
    };
  }, [user, activeCompanyId, operationalBranchId, canViewCashAudit]);

  // Local calendar day ("YYYY-MM-DD"), refreshed at midnight and whenever the app comes back to
  // the foreground, so the day/month-scoped sales stream below rolls over on terminals that stay
  // open overnight instead of keeping yesterday's window.
  const [currentDayKey, setCurrentDayKey] = useState(() => msToDayKey(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      setCurrentDayKey(msToDayKey(Date.now()));
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => refresh(), msUntilNextLocalDay(new Date()));
    };
    refresh();
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  // What the sales stream is scoped to: today for a plain cashier, the current month otherwise.
  const salesStreamKey = salesWindow === 'today' ? currentDayKey : currentDayKey.slice(0, 7);

  // Sales and stock movements are the two largest, fastest-growing collections in the
  // company, so — like cashRegister above — they're scoped to the active branch's own
  // `branchId` instead of loading every branch's full history into every session (that used
  // to be the single biggest driver of Firestore read-quota consumption). New sales/movements
  // always carry a real branchId (see handleCheckout/logStockMovements); the few screens that
  // genuinely need every branch at once (Sucursales revenue cards, the CSV dashboard export,
  // Facturación, and reprinting a transfer from the receiving branch) fetch those separately
  // with a one-off getDocs query instead of depending on this live, branch-scoped stream.
  useEffect(() => {
    if (!user || !activeCompanyId || !operationalBranchId || !canViewSalesHistory) {
      setSales([]);
      setStockMovements([]);
      return;
    }
    const compId = activeCompanyId;
    const branchId = operationalBranchId;
    const currentMonthRange = getMonthRange(salesStreamKey.slice(0, 7));
    if (!currentMonthRange) return;
    // A plain cashier only needs today's sales of its branch (tens of documents instead of up
    // to 2000 for the whole month); everyone else keeps the month-long stream.
    const salesRange = (salesWindow === 'today' ? getDayRange(salesStreamKey) : null) ?? currentMonthRange;

    setSales([]);
    setStockMovements([]);

    const unsubSales = onSnapshot(
      query(
        collection(db, 'companies', compId, 'sales'),
        where('branchId', '==', branchId),
        where('createdAt', '>=', salesRange.start),
        orderBy('createdAt', 'desc'),
        limit(2000)
      ),
      (snapshot) => {
        const list: Sale[] = [];
        snapshot.forEach(d => list.push(d.data() as Sale));
        // `timestamp` is a locale display string (e.g. "30/6/2026, 4:55 p.m.") and isn't
        // reliably parseable by `new Date()` — sort by the numeric `createdAt` instead.
        // Older sales recorded before this field existed fall back to 0 (oldest last).
        const saleSortKey = (s: Sale) => s.createdAt ?? 0;
        list.sort((a, b) => saleSortKey(b) - saleSortKey(a));
        setSales(list);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `companies/${compId}/sales`);
      }
    );

    // The inventory log is only opened for whoever can see it (not for a plain cashier).
    const unsubStockMovements = canViewInventoryLog ? onSnapshot(
      query(
        collection(db, 'companies', compId, 'stockMovements'),
        where('branchId', '==', branchId),
        where('createdAt', '>=', currentMonthRange.start),
        orderBy('createdAt', 'desc'),
        limit(2000)
      ),
      (snapshot) => {
        const list: StockMovement[] = [];
        snapshot.forEach(d => list.push(d.data() as StockMovement));
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setStockMovements(list);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `companies/${compId}/stockMovements`);
      }
    ) : () => {};

    return () => {
      unsubSales();
      unsubStockMovements();
    };
  }, [user, activeCompanyId, operationalBranchId, canViewSalesHistory, canViewInventoryLog, salesWindow, salesStreamKey]);

  const getTodayDateString = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  useEffect(() => {
    if (cashRegister && cashRegister.isOpen) {
      const todayStr = getTodayDateString();
      if (!cashRegister.lastOperationalDate) {
        const updated = { ...cashRegister, lastOperationalDate: todayStr };
        setCashRegister(updated);
      } else if (cashRegister.lastOperationalDate !== todayStr) {
        setWarningOperationalDate(cashRegister.lastOperationalDate);
        setShowOvernightWarning(true);
      }
    }
  }, [cashRegister?.isOpen, cashRegister?.lastOperationalDate]);

  useEffect(() => {
    if (cashRegister && !cashRegister.isOpen) {
      setShowClosedCajaBanner(true);
    }
  }, [cashRegister?.isOpen]);

  // Register state and its append-only ledger entry are committed in one batch. The legacy
  // `transactions` array is deliberately omitted so opening a new shift neither deletes old
  // history nor makes the register document grow forever.
  const writeCashRegisterForBranch = async (
    branchId: string,
    newCash: CashRegister,
    entry: CashTransaction
  ) => {
    if (!user || !activeCompanyId) throw new SessionInvalidError('writeCashRegisterForBranch: sesión inválida');
    const now = entry.createdAt ?? Date.now();
    const transactionId = entry.id || `CT-${now}-${crypto.randomUUID()}`;
    const fullEntry: CashTransaction = {
      ...entry,
      id: transactionId,
      branchId,
      createdAt: now,
      timestamp: entry.timestamp || new Date(now).toISOString(),
      createdBy: user.uid,
    };
    const { transactions: _legacyTransactions, ...registerState } = newCash;
    const batch = writeBatch(db);
    batch.set(doc(db, 'companies', activeCompanyId, 'cashRegisters', branchId), sanitize({
      ...registerState,
      lastTransactionId: transactionId,
      updatedAt: now,
    }), { merge: true });
    batch.set(
      doc(db, 'companies', activeCompanyId, 'cashRegisters', branchId, 'transactions', transactionId),
      sanitize(fullEntry)
    );
    await batch.commit();
    setCashRegister({ ...newCash, transactions: [] });
  };

  const handleCloseCaja = async (realCashValue: number) => {
    if (!canCloseCash) {
      alert('Tu cuenta no tiene permiso para cerrar la caja.');
      return;
    }
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    const expected = cashRegister.currentCash;
    const diff = realCashValue - expected;
    const diffText = diff === 0
      ? 'Caja Cuadrada'
      : diff > 0
        ? `Sobrante de ${formatMXN(diff)}`
        : `Faltante de ${formatMXN(Math.abs(diff))}`;

    const now = Date.now();
    const newTx: CashTransaction = {
      type: 'Cierre',
      amount: Math.abs(diff),
      cashDelta: diff,
      description: `Cierre de Caja - Real: ${formatMXN(realCashValue)} | Esp: ${formatMXN(expected)} (${diffText})`,
      time: new Date().toLocaleTimeString(),
      createdAt: now,
      shiftId: cashRegister.currentShiftId,
      balanceAfter: realCashValue,
    };

    const closedCash: CashRegister = {
      ...cashRegister,
      isOpen: false,
      currentCash: realCashValue,
      closedAt: now,
      transactions: []
    };

    try {
      await writeCashRegisterForBranch(operationalBranchId, closedCash, newTx);
      setShowOvernightWarning(false);
      setIsCorteModalOpen(false);
      alert(`¡Caja cerrada correctamente! Total esperado: ${formatMXN(expected)} | Físico: ${formatMXN(realCashValue)} (${diffText}).`);
      setIsOpeningCajaModalOpen(true);
    } catch (error) {
      console.error('Error closing cash register:', error);
      alert('No se pudo confirmar el cierre de caja. La caja permanece abierta; intenta nuevamente.');
    }
  };

  const handleOpenCaja = async (initialCashValue: number) => {
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    const todayStr = getTodayDateString();
    const now = Date.now();
    const shiftId = `SHIFT-${now}-${crypto.randomUUID()}`;
    const newCash: CashRegister = {
      isOpen: true,
      initialCash: initialCashValue,
      currentCash: initialCashValue,
      lastOperationalDate: todayStr,
      currentShiftId: shiftId,
      openedAt: now,
      closedAt: undefined,
      transactions: []
    };

    try {
      await writeCashRegisterForBranch(operationalBranchId, newCash, {
        type: 'Apertura',
        amount: initialCashValue,
        cashDelta: initialCashValue,
        description: `Apertura de Caja - Saldo Inicial: ${formatMXN(initialCashValue)}`,
        time: new Date().toLocaleTimeString(),
        createdAt: now,
        shiftId,
        balanceAfter: initialCashValue,
      });
      setIsOpeningCajaModalOpen(false);
      alert(`¡Caja abierta correctamente con un saldo inicial de ${formatMXN(initialCashValue)}!`);
    } catch (error) {
      console.error('Error opening cash register:', error);
      alert('No se pudo confirmar la apertura de caja. Intenta nuevamente antes de cobrar.');
    }
  };

  // Synchronize state functions across Cache & Firestore Cloud
  // Firestore rejects undefined values, safely sanitize objects before writing
  const sanitize = (obj: any): any => JSON.parse(JSON.stringify(obj));

  // Writes only the docs that actually changed (by id, reference-diffed against the
  // previous local arrays) instead of rewriting the entire catalogue/history on every
  // save. Two reasons this matters: a `writeBatch` hard-caps at 500 operations, so
  // rewriting the full sales history + catalogue on every single sale will eventually
  // fail outright once a branch accumulates that many records; and rewriting unrelated
  // documents needlessly multiplies Firestore billing for every action.
  // `currentCash`/`transactions` on the register are intentionally NOT diffed/written
  // here — concurrent terminals must go through applyCashDelta()'s atomic increment
  // instead of a last-write-wins overwrite. Pass the same `cashRegister` reference
  // through when a call site has no register change to make.
  const saveAllData = async (
    newProds: Product[],
    newCusts: Customer[],
    newSales: Sale[],
    newCash: CashRegister,
    newBranches: Branch[] = branches,
    newSuppliers: Supplier[] = suppliers
  ) => {
    // 1. Instantly update React state for latency-free rendering
    setProducts(newProds);
    setCustomers(newCusts);
    setSales(newSales);
    setCashRegister(newCash);
    setBranches(newBranches);
    setSuppliers(newSuppliers);

    // Firestore's persistent IndexedDB cache is the offline cache. Do not duplicate whole
    // catalogues or sales history in localStorage; quota failures must not precede cloud writes.
    if (user && activeCompanyId) {
      const compId = activeCompanyId;
      try {
        const writes: { col: string; item: { id: string } }[] = [];
        const diffInto = (prevArr: { id: string }[], nextArr: { id: string }[], col: string) => {
          const prevById = new Map(prevArr.map(item => [item.id, item]));
          nextArr.forEach(item => {
            if (prevById.get(item.id) !== item) {
              writes.push({ col, item });
            }
          });
        };

        diffInto(products, newProds, 'products');
        diffInto(customers, newCusts, 'customers');
        diffInto(sales, newSales, 'sales');
        diffInto(branches, newBranches, 'branches');
        diffInto(suppliers, newSuppliers, 'suppliers');

        // Cash register writes do NOT go through this generic batch — it's scoped per
        // branch (companies/{id}/cashRegisters/{branchId}) and goes through either
        // applyCashDelta() (atomic deltas) or writeCashRegisterForBranch() (open/close).

        for (let index = 0; index < writes.length; index += 400) {
          const batch = writeBatch(db);
          writes.slice(index, index + 400).forEach(({ col, item }) => {
            batch.set(doc(db, 'companies', compId, col, item.id), sanitize(item));
          });
          await batch.commit();
        }
      } catch (err) {
        throw handleFirestoreError(err, OperationType.WRITE, `companies/${compId}/batch_sync`);
      }
    } else {
      // Steps 1-2 above already ran unconditionally, so a caller that genuinely wants a
      // local-only save still gets one (see handleExecuteTransfer's else branch, which
      // catches this specific error and moves on). Everyone else needs to LEARN that the
      // change never left the device — this used to be a silent no-op, which is how sales
      // could "complete" on screen and never exist in the cloud.
      throw new SessionInvalidError('saveAllData: sesión o empresa activa inválida — los cambios NO se guardaron en la nube');
    }
  };

  // Atomically applies a cash delta and appends ledger documents without growing the register
  // document. Checkout uses the stronger all-in-one transaction below; this helper is for
  // manual cash flows, restocks, balance payments, refunds, and transfers.
  const applyCashDelta = async (branchId: string, amountDelta: number, txEntries: CashRegister['transactions']) => {
    // No branch selected is a caller-side "nothing to do", not a broken session.
    if (!branchId) return;
    if (txEntries.length !== 1) throw new Error('Cada cambio de caja debe corresponder a un solo movimiento de ledger.');
    if (!user || !activeCompanyId) {
      throw new SessionInvalidError('applyCashDelta: sesión o empresa activa inválida');
    }

    try {
      const now = Date.now();
      const normalizedEntries = txEntries.map((entry, index): CashTransaction => ({
        ...entry,
        id: entry.id || `CT-${now}-${index}-${crypto.randomUUID()}`,
        branchId,
        createdAt: entry.createdAt ?? now,
        timestamp: entry.timestamp || new Date(entry.createdAt ?? now).toISOString(),
        createdBy: user.uid,
        shiftId: entry.shiftId || (branchId === operationalBranchId ? cashRegister.currentShiftId : undefined),
        cashDelta: entry.cashDelta ?? (index === txEntries.length - 1 ? amountDelta : 0),
      }));
      const lastEntry = normalizedEntries[normalizedEntries.length - 1];
      const registerRef = doc(db, 'companies', activeCompanyId, 'cashRegisters', branchId);
      await runTransaction(db, async transaction => {
        const registerSnapshot = await transaction.get(registerRef);
        if (!registerSnapshot.exists() || !(registerSnapshot.data() as CashRegister).isOpen) {
          throw new CashRegisterClosedError();
        }
        const register = registerSnapshot.data() as CashRegister;
        const nextCash = register.currentCash + amountDelta;
        transaction.update(registerRef, {
          currentCash: nextCash,
          lastTransactionId: lastEntry.id,
          updatedAt: now,
        });
        normalizedEntries.forEach(entry => {
          transaction.set(
            doc(db, 'companies', activeCompanyId!, 'cashRegisters', branchId, 'transactions', entry.id!),
            sanitize({ ...entry, balanceAfter: entry.id === lastEntry.id ? nextCash : undefined })
          );
        });
      });
    } catch (err) {
      throw handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/cashRegisters/${branchId}`);
    }
  };

  // A customer payment and its cash entry are one transaction. The amount is recalculated
  // against the live balance so two terminals cannot both collect the same outstanding debt.
  const applyCustomerPaymentAtomically = async (customerId: string, requestedAmount: number): Promise<number> => {
    if (!user || !activeCompanyId) {
      throw new SessionInvalidError('applyCustomerPaymentAtomically: sesión o empresa activa inválida');
    }
    if (!operationalBranchId || requestedAmount <= 0) return 0;
    const compId = activeCompanyId;
    const now = Date.now();
    const transactionId = `PAYMENT-${now}-${crypto.randomUUID()}`;
    const customerRef = doc(db, 'companies', compId, 'customers', customerId);
    const registerRef = doc(db, 'companies', compId, 'cashRegisters', operationalBranchId);
    const entryRef = doc(db, 'companies', compId, 'cashRegisters', operationalBranchId, 'transactions', transactionId);
    let appliedAmount = 0;

    await runTransaction(db, async transaction => {
      const [customerSnapshot, registerSnapshot] = await Promise.all([
        transaction.get(customerRef),
        transaction.get(registerRef),
      ]);
      if (!customerSnapshot.exists()) throw new Error('El cliente ya no existe.');
      if (!registerSnapshot.exists() || !(registerSnapshot.data() as CashRegister).isOpen) {
        throw new CashRegisterClosedError();
      }
      const customer = customerSnapshot.data() as Customer;
      const register = registerSnapshot.data() as CashRegister;
      appliedAmount = Math.min(Math.max(0, customer.unpaidBalance || 0), requestedAmount);
      if (appliedAmount <= 0) return;
      const nextCash = register.currentCash + appliedAmount;
      transaction.update(customerRef, { unpaidBalance: Math.max(0, customer.unpaidBalance - appliedAmount) });
      transaction.update(registerRef, { currentCash: nextCash, lastTransactionId: transactionId, updatedAt: now });
      transaction.set(entryRef, sanitize({
        id: transactionId,
        type: 'Ingreso',
        amount: appliedAmount,
        cashDelta: appliedAmount,
        description: `Abono "Fiado" de ${customer.name}`,
        time: new Date(now).toLocaleTimeString(),
        timestamp: new Date(now).toISOString(),
        createdAt: now,
        branchId: operationalBranchId,
        shiftId: register.currentShiftId,
        createdBy: user.uid,
        balanceAfter: nextCash,
      }));
    });
    return appliedAmount;
  };

  // Atomically applies stock deltas (global + per-branch) to one or more products in a
  // single Firestore transaction. Reads the live server documents right before writing,
  // so two terminals selling the last units of the same product at the same time can
  // never both succeed in selling more stock than actually exists / silently overwrite
  // each other's stock count (the failure mode of the old computed-from-stale-local-state
  // overwrite approach).
  const applyStockDeltas = async (
    deltas: { productId: string; branchId: string; qtyDelta: number }[],
    movementEntries: Omit<StockMovement, 'id' | 'timestamp' | 'createdAt' | 'userName'>[] = []
  ) => {
    // An empty delta list is a caller-side "nothing to do", not a broken session.
    if (deltas.length === 0) return;
    if (!user || !activeCompanyId) {
      throw new SessionInvalidError('applyStockDeltas: sesión o empresa activa inválida');
    }
    const compId = activeCompanyId;
    const now = Date.now();
    const normalizedMovements = movementEntries.map((entry, index): StockMovement => ({
      ...entry,
      id: `${createDocumentId('SM')}-${index}`,
      userName: currentUserMember?.name || user.displayName || 'Sistema',
      timestamp: new Date(now).toLocaleString(),
      createdAt: now,
    }));
    try {
      await runTransaction(db, async (tx) => {
        const aggregated = new Map<string, Map<string, number>>();
        deltas.forEach(delta => {
          const byBranch = aggregated.get(delta.productId) || new Map<string, number>();
          byBranch.set(delta.branchId, (byBranch.get(delta.branchId) || 0) + delta.qtyDelta);
          aggregated.set(delta.productId, byBranch);
        });
        const productIds = Array.from(aggregated.keys()).sort();
        if (productIds.length + normalizedMovements.length > 450) {
          throw new Error('La operación supera 450 cambios atómicos. Divide el movimiento en grupos más pequeños.');
        }
        const refs = productIds.map(id => doc(db, 'companies', compId, 'products', id));
        const snaps = await Promise.all(refs.map(ref => tx.get(ref)));

        snaps.forEach((snap, idx) => {
          if (!snap.exists()) throw new StockUnavailableError(`El producto ${productIds[idx]} ya no existe.`);
          const data = snap.data() as Product;
          const productId = productIds[idx];
          const branchStocks = { ...(data.branchStocks || {}) };
          aggregated.get(productId)!.forEach((qtyDelta, branchId) => {
            // A branch with no entry starts from 0, never from the shared total — otherwise
            // it silently adopts another branch's count as its own starting point.
            const currentBranchStock = branchStocks[branchId] ?? 0;
            const nextStock = Math.round((currentBranchStock + qtyDelta) * 1000) / 1000;
            if (nextStock < 0) {
              throw new StockUnavailableError(
                `Stock insuficiente para "${data.name}". Disponible: ${currentBranchStock}; solicitado: ${Math.abs(qtyDelta)}.`
              );
            }
            branchStocks[branchId] = nextStock;
          });

          // `stock` is only ever the consolidated total now — recomputed from the branches
          // instead of being nudged by whichever branch happened to make this change.
          // A transfer between branches (the deltas cancel out) leaves that total untouched:
          // rewriting it would also change a legacy total that disagrees with the branches, and
          // the rules reject any transfer that changes it. The next sale/restock/edit of the
          // product recomputes it from the branches as usual.
          if (isNetZeroStockChange(aggregated.get(productId)!)) {
            tx.update(refs[idx], { branchStocks });
          } else {
            tx.update(refs[idx], { stock: sumBranchStocks(branchStocks), branchStocks });
          }
        });
        normalizedMovements.forEach(movement => {
          tx.set(
            doc(db, 'companies', compId, 'stockMovements', movement.id),
            sanitize(movement)
          );
        });
      });
    } catch (err) {
      throw handleFirestoreError(err, OperationType.UPDATE, `companies/${compId}/products/stock_transaction`);
    }
  };

  // A linked ("child") product has no stock of its own — selling/refunding one unit must move
  // the PARENT's pool instead, scaled by the consumption factor. applyStockDeltas itself stays
  // generic (just applies whatever {productId, branchId, qtyDelta} it's given); this resolves
  // which product a given sale line should actually target before the delta is built.
  const resolveStockTarget = (
    productId: string, branchId: string, quantity: number,
    linkedStockProductId?: string, stockConsumptionFactor?: number
  ) => {
    if (linkedStockProductId && stockConsumptionFactor) {
      return { productId: linkedStockProductId, branchId, qtyDelta: quantity * stockConsumptionFactor };
    }
    return { productId, branchId, qtyDelta: quantity };
  };

  // Best-effort write to the invisible checkout-funnel audit log — see CheckoutEvent. Unlike
  // logStockMovements, this must NEVER be able to affect the real sale path, so on failure it
  // only console.errors and swallows: no handleFirestoreError (which re-throws), no alert, no
  // retry, and callers must never `await` it. companyId is read live from state at call time
  // rather than passed in, so a stale closure can't misattribute an event to the wrong company.
  const logCheckoutEvent = (fields: Omit<CheckoutEvent, 'id' | 'timestamp' | 'createdAt'>): void => {
    if (!activeCompanyId) return; // nothing to attribute this to — silently skip, never block the caller
    const compId = activeCompanyId;
    const now = Date.now();
    const id = createDocumentId('CE');
    const event: CheckoutEvent = { ...fields, id, timestamp: new Date().toLocaleString(), createdAt: now };
    setDoc(doc(db, 'companies', compId, 'checkoutEvents', id), sanitize(event))
      .catch(err => console.error('[checkoutEvents] best-effort log write failed (ignored):', err));
  };

  const commitSaleAtomically = async (
    sale: Sale,
    stockDeltas: { productId: string; branchId: string; qtyDelta: number }[],
    checkoutEventBase: Omit<CheckoutEvent, 'id' | 'timestamp' | 'createdAt' | 'status'>,
    cashEntry: CashTransaction
  ): Promise<void> => {
    if (!user || !activeCompanyId) throw new SessionInvalidError('commitSaleAtomically: sesión inválida');
    if (!sale.branchId) throw new Error('La venta no tiene una sucursal válida.');

    const compId = activeCompanyId;
    const branchId = sale.branchId;
    const actorId = user.uid;
    const aggregated = new Map<string, number>();
    stockDeltas.forEach(delta => {
      if (delta.branchId !== branchId) throw new Error('La venta contiene movimientos de otra sucursal.');
      aggregated.set(delta.productId, (aggregated.get(delta.productId) || 0) + delta.qtyDelta);
    });
    const productIds = Array.from(aggregated.keys()).sort();
    if (productIds.length > 450) throw new Error('La venta excede el máximo seguro de artículos distintos.');

    const saleRef = doc(db, 'companies', compId, 'sales', sale.id);
    const registerRef = doc(db, 'companies', compId, 'cashRegisters', branchId);
    const productRefs = productIds.map(productId => doc(db, 'companies', compId, 'products', productId));
    const customerRef = sale.paymentMethod === 'Credit' && sale.customerId
      ? doc(db, 'companies', compId, 'customers', sale.customerId)
      : null;
    const cashTransactionId = `SALE-${sale.id}`;
    const checkoutEventId = `CE-COMMIT-${sale.id}`;
    const cashTransactionRef = doc(
      db, 'companies', compId, 'cashRegisters', branchId, 'transactions', cashTransactionId
    );
    const checkoutEventRef = doc(db, 'companies', compId, 'checkoutEvents', checkoutEventId);

    await runTransaction(db, async transaction => {
      // Firestore requires every read before the first write. Reading the register and products
      // makes concurrent terminals retry against the newest stock/cash state automatically.
      const readRefs = [saleRef, registerRef, ...productRefs, ...(customerRef ? [customerRef] : [])];
      const snapshots = await Promise.all(readRefs.map(ref => transaction.get(ref)));
      const saleSnapshot = snapshots[0];
      if (saleSnapshot.exists()) return; // deterministic id: a replay is already committed

      const registerSnapshot = snapshots[1];
      if (!registerSnapshot.exists() || !(registerSnapshot.data() as CashRegister).isOpen) {
        throw new CashRegisterClosedError();
      }
      const registerData = registerSnapshot.data() as CashRegister;
      const stockUpdates: { ref: (typeof productRefs)[number]; branchStocks: Record<string, number> }[] = [];

      productRefs.forEach((ref, index) => {
        const snapshot = snapshots[index + 2];
        if (!snapshot.exists()) throw new StockUnavailableError(`El producto ${productIds[index]} ya no existe.`);
        const product = snapshot.data() as Product;
        const branchStocks = { ...(product.branchStocks || {}) };
        const currentStock = branchStocks[branchId] ?? 0;
        const qtyDelta = aggregated.get(productIds[index]) || 0;
        const nextStock = Math.round((currentStock + qtyDelta) * 1000) / 1000;
        if (nextStock < 0) {
          throw new StockUnavailableError(
            `Stock insuficiente para "${product.name}". Disponible: ${currentStock}; solicitado: ${Math.abs(qtyDelta)}.`
          );
        }
        branchStocks[branchId] = nextStock;
        stockUpdates.push({ ref, branchStocks });
      });

      let customerBalanceUpdate: { ref: NonNullable<typeof customerRef>; balance: number } | null = null;
      if (customerRef) {
        const customerSnapshot = snapshots[snapshots.length - 1];
        if (!customerSnapshot.exists()) throw new Error('El cliente seleccionado ya no existe.');
        const customer = customerSnapshot.data() as Customer;
        customerBalanceUpdate = { ref: customerRef, balance: (customer.unpaidBalance || 0) + sale.total };
      }

      const now = Date.now();
      const cashDelta = sale.paymentMethod === 'Cash' ? sale.total : 0;
      const fullCashEntry: CashTransaction = {
        ...cashEntry,
        id: cashTransactionId,
        branchId,
        saleId: sale.id,
        paymentMethod: sale.paymentMethod,
        shiftId: registerData.currentShiftId,
        cashDelta,
        createdAt: sale.createdAt || now,
        timestamp: new Date(sale.createdAt || now).toISOString(),
        createdBy: actorId,
        balanceAfter: registerData.currentCash + cashDelta,
      };
      const committedEvent: CheckoutEvent = {
        ...checkoutEventBase,
        id: checkoutEventId,
        saleId: sale.id,
        status: 'success',
        timestamp: new Date(now).toISOString(),
        createdAt: now,
      };

      transaction.set(saleRef, sanitize(sale));
      stockUpdates.forEach(update => {
        transaction.update(update.ref, {
          branchStocks: update.branchStocks,
          stock: sumBranchStocks(update.branchStocks),
        });
      });
      if (customerBalanceUpdate) {
        transaction.update(customerBalanceUpdate.ref, { unpaidBalance: customerBalanceUpdate.balance });
      }
      transaction.update(registerRef, {
        currentCash: registerData.currentCash + cashDelta,
        lastTransactionId: cashTransactionId,
        updatedAt: now,
      });
      transaction.set(cashTransactionRef, sanitize(fullCashEntry));
      transaction.set(checkoutEventRef, sanitize(committedEvent));
    });
  };

  const refundSaleAtomically = async (sale: Sale): Promise<void> => {
    if (!user || !activeCompanyId) throw new SessionInvalidError('refundSaleAtomically: sesión inválida');
    const compId = activeCompanyId;
    const branchId = sale.branchId || operationalBranchId;
    const saleRef = doc(db, 'companies', compId, 'sales', sale.id);
    const registerRef = doc(db, 'companies', compId, 'cashRegisters', branchId);
    const aggregated = new Map<string, number>();
    sale.items.forEach(item => {
      const delta = resolveStockTarget(
        item.productId, branchId, item.quantity,
        item.linkedStockProductId, item.stockConsumptionFactor
      );
      aggregated.set(delta.productId, (aggregated.get(delta.productId) || 0) + delta.qtyDelta);
    });
    const productIds = Array.from(aggregated.keys()).sort();
    const productRefs = productIds.map(productId => doc(db, 'companies', compId, 'products', productId));
    const customerRef = sale.paymentMethod === 'Credit' && sale.customerId
      ? doc(db, 'companies', compId, 'customers', sale.customerId)
      : null;
    const transactionId = `REFUND-${sale.id}`;
    const cashEntryRef = doc(db, 'companies', compId, 'cashRegisters', branchId, 'transactions', transactionId);

    await runTransaction(db, async transaction => {
      const readRefs = [saleRef, registerRef, ...productRefs, ...(customerRef ? [customerRef] : [])];
      const snapshots = await Promise.all(readRefs.map(ref => transaction.get(ref)));
      if (!snapshots[0].exists()) throw new Error('La venta ya no existe.');
      const serverSale = snapshots[0].data() as Sale;
      if (serverSale.status === 'Refunded') return;
      const registerSnapshot = snapshots[1];
      if (!registerSnapshot.exists() || !(registerSnapshot.data() as CashRegister).isOpen) {
        throw new CashRegisterClosedError('La caja de la sucursal original debe estar abierta para registrar el reembolso.');
      }
      const register = registerSnapshot.data() as CashRegister;

      productRefs.forEach((ref, index) => {
        const snapshot = snapshots[index + 2];
        if (!snapshot.exists()) throw new Error(`No existe el producto ${productIds[index]} para restituir inventario.`);
        const product = snapshot.data() as Product;
        const branchStocks = { ...(product.branchStocks || {}) };
        branchStocks[branchId] = Math.round(((branchStocks[branchId] ?? 0) + (aggregated.get(productIds[index]) || 0)) * 1000) / 1000;
        transaction.update(ref, { branchStocks, stock: sumBranchStocks(branchStocks) });
      });

      if (customerRef) {
        const customerSnapshot = snapshots[snapshots.length - 1];
        if (!customerSnapshot.exists()) throw new Error('No existe el cliente asociado al crédito.');
        const customer = customerSnapshot.data() as Customer;
        transaction.update(customerRef, { unpaidBalance: Math.max(0, (customer.unpaidBalance || 0) - sale.total) });
      }

      const now = Date.now();
      const cashDelta = sale.paymentMethod === 'Cash' ? -sale.total : 0;
      const nextCash = register.currentCash + cashDelta;
      transaction.update(saleRef, { status: 'Refunded' });
      transaction.update(registerRef, {
        currentCash: nextCash,
        lastTransactionId: transactionId,
        updatedAt: now,
      });
      transaction.set(cashEntryRef, sanitize({
        id: transactionId,
        type: 'Egreso',
        amount: sale.total,
        cashDelta,
        description: `Cancelación/Reembolso Venta ${sale.id}`,
        time: new Date(now).toLocaleTimeString(),
        timestamp: new Date(now).toISOString(),
        createdAt: now,
        branchId,
        shiftId: register.currentShiftId,
        saleId: sale.id,
        paymentMethod: sale.paymentMethod,
        createdBy: user.uid,
        balanceAfter: nextCash,
      }));
    });
  };

  const commitRestockAtomically = async (params: {
    targetProduct: Product;
    displayProduct: Product;
    supplier: Supplier;
    supplierId: string;
    purchasedQuantity: number;
    stockQuantity: number;
    unitCost: number;
    branchId: string;
  }): Promise<void> => {
    if (!user || !activeCompanyId) throw new SessionInvalidError('commitRestockAtomically: sesión inválida');
    const compId = activeCompanyId;
    const now = Date.now();
    const cashTransactionId = `RESTOCK-${now}-${crypto.randomUUID()}`;
    const movementId = `SM-${now}-${crypto.randomUUID()}`;
    const totalExpense = params.purchasedQuantity * params.unitCost;
    const productRef = doc(db, 'companies', compId, 'products', params.targetProduct.id);
    const registerRef = doc(db, 'companies', compId, 'cashRegisters', params.branchId);
    const cashEntryRef = doc(db, 'companies', compId, 'cashRegisters', params.branchId, 'transactions', cashTransactionId);
    const movementRef = doc(db, 'companies', compId, 'stockMovements', movementId);

    await runTransaction(db, async transaction => {
      const [productSnapshot, registerSnapshot] = await Promise.all([
        transaction.get(productRef),
        transaction.get(registerRef),
      ]);
      if (!productSnapshot.exists()) throw new StockUnavailableError('El producto ya no existe.');
      if (!registerSnapshot.exists() || !(registerSnapshot.data() as CashRegister).isOpen) {
        throw new CashRegisterClosedError();
      }
      const product = productSnapshot.data() as Product;
      const register = registerSnapshot.data() as CashRegister;
      const branchStocks = { ...(product.branchStocks || {}) };
      branchStocks[params.branchId] = Math.round(((branchStocks[params.branchId] ?? 0) + params.stockQuantity) * 1000) / 1000;
      const nextCash = register.currentCash - totalExpense;

      transaction.update(productRef, {
        branchStocks,
        stock: sumBranchStocks(branchStocks),
        costPrice: params.unitCost,
        supplierId: params.supplierId,
      });
      transaction.update(registerRef, {
        currentCash: nextCash,
        lastTransactionId: cashTransactionId,
        updatedAt: now,
      });
      transaction.set(cashEntryRef, sanitize({
        id: cashTransactionId,
        type: 'Egreso',
        amount: totalExpense,
        cashDelta: -totalExpense,
        description: `Surtido de Stock: ${params.purchasedQuantity}x ${params.displayProduct.name} (Ref: ${params.supplier.name})`,
        time: new Date(now).toLocaleTimeString(),
        timestamp: new Date(now).toISOString(),
        createdAt: now,
        branchId: params.branchId,
        shiftId: register.currentShiftId,
        createdBy: user.uid,
        balanceAfter: nextCash,
      }));
      transaction.set(movementRef, sanitize({
        id: movementId,
        type: 'surtido',
        productId: params.targetProduct.id,
        productName: params.targetProduct.name,
        quantity: params.stockQuantity,
        branchId: params.branchId,
        branchName: branches.find(branch => branch.id === params.branchId)?.name,
        userName: currentUserMember?.name || user.displayName || 'Sistema',
        timestamp: new Date(now).toLocaleString(),
        createdAt: now,
      }));
    });
  };

  // Pos / Cart Operations State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('Todos');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [discountType, setDiscountType] = useState<'val' | 'pct'>('pct');
  const [discountVal, setDiscountVal] = useState<number>(0);
  const [taxPct, setTaxPct] = useState<number>(0);
  const [requiresInvoice, setRequiresInvoice] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Card' | 'Transfer' | 'Credit'>('Cash');
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [receivedCashAmount, setReceivedCashAmount] = useState<string>('');
  // Checkout now awaits the sale write, so it needs a lock: the state drives the button/cart
  // UI, the ref blocks a second click landing before React re-renders the disabled button.
  const [isProcessingSale, setIsProcessingSale] = useState(false);
  const isProcessingSaleRef = useRef(false);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [lastCompletedSale, setLastCompletedSale] = useState<Sale | null>(null);
  const [lastReceivedAmount, setLastReceivedAmount] = useState<number>(0);

  // Search Results
  const uniqueCategories = useMemo(() => {
    const cats = products.map(p => p.category || 'Generales');
    return ['Todos', ...Array.from(new Set(cats))];
  }, [products]);

  const selectCategoriesList = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.category || 'Generales')));
    const defaults = ['Generales', 'Bebidas', 'Alimentos', 'Postres'];
    return Array.from(new Set([...defaults, ...customCategories, ...cats])).filter(c => c !== 'Todos');
  }, [products, customCategories]);

  const handleAddCategory = (newName: string) => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para administrar categorías.');
      return;
    }
    if (!newName.trim()) return;
    const clean = newName.trim();
    if (selectCategoriesList.includes(clean)) {
      alert("Esta categoría ya existe.");
      return;
    }
    const updated = [...customCategories, clean];
    setCustomCategories(updated);
    safeLocalStorageSet('logic_custom_categories', JSON.stringify(updated));
    setNewCategoryInput('');
    alert(`Categoría "${clean}" agregada con éxito.`);
  };

  const handleRenameCategory = async (oldName: string, newName: string) => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para administrar categorías.');
      return;
    }
    if (!newName.trim() || oldName === newName) return;
    const cleanNewName = newName.trim();

    const updatedProducts = products.map(p => {
      if ((p.category || 'Generales') === oldName) {
        return { ...p, category: cleanNewName };
      }
      return p;
    });

    try {
      // saveAllData's diff-based batch only writes the products whose category actually changed
      await saveAllData(updatedProducts, customers, sales, cashRegister, branches, suppliers);
      alert(`La categoría "${oldName}" fue renombrada a "${cleanNewName}" en todos los productos.`);
    } catch (err) {
      console.error("Error renaming category:", err);
      alert("Error al intentar renombrar la categoría en la nube.");
    }
  };

  // Ids of every product that's a shared-stock "parent" for at least one other product (e.g.
  // "Atole de Chocolate" backing "...Mediano"/"...1 Litro") — a fallback for pools created
  // before isStockPool existed, or where someone linked a child without checking the box.
  const linkedParentIds = useMemo(() => {
    return new Set(products.filter(p => p.linkedStockProductId).map(p => p.linkedStockProductId));
  }, [products]);
  // A pool holds stock but is never itself something a cashier rings up — hidden from the sale
  // catalog from the moment isStockPool is checked (not only once something links to it, so
  // there's no window where a freshly-created pool briefly shows up as sellable).
  const isPoolProduct = (p: Product) => !!p.isStockPool || linkedParentIds.has(p.id);

  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      if (isPoolProduct(p)) return false;
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCat = selectedCategory === 'Todos' || p.category === selectedCategory;
      // Terminal POS only sells what's physically in the active branch: products at 0
      // stock are hidden so a cashier can't oversell. They reappear automatically once
      // stock is added (surtido / transfer). This is per-branch, not global.
      const hasStock = getProductStock(p, operationalBranchId, products) >= 1;
      return matchesSearch && matchesCat && hasStock;
    });
  }, [products, searchTerm, selectedCategory, operationalBranchId, linkedParentIds]);

  // Inventario's own search — unlike the Terminal POS list above, this must surface every
  // catalog item (including 0-stock ones, since managing stock is the whole point of this
  // screen) and also matches on SKU, which the POS search doesn't need.
  const inventoryFilteredProducts = useMemo(() => {
    const term = inventorySearchTerm.trim().toLowerCase();
    if (!term) return products;
    return products.filter(p =>
      p.name.toLowerCase().includes(term) ||
      (p.category && p.category.toLowerCase().includes(term)) ||
      (p.sku && p.sku.toLowerCase().includes(term))
    );
  }, [products, inventorySearchTerm]);

  // Inventario shows one card/row per "top-level" product — a linked ("child") product never
  // gets its own card, it's nested inside its parent's card instead (see getLinkedChildren
  // below), so a shared-stock group like "Atole de Chocolate" + "...Mediano" + "...1 Litro"
  // reads as one item, not three near-duplicates. A parent that doesn't itself match the search
  // still shows up if the search matched one of ITS children, so searching "Mediano" doesn't
  // produce a confusing empty result.
  const topLevelInventoryProducts = useMemo(() => {
    const matchedIds = new Set(inventoryFilteredProducts.map(p => p.id));
    return products.filter(p => {
      if (p.linkedStockProductId) return false;
      if (matchedIds.has(p.id)) return true;
      return products.some(child => child.linkedStockProductId === p.id && matchedIds.has(child.id));
    });
  }, [inventoryFilteredProducts, products]);

  const getLinkedChildren = (parentId: string) => products.filter(p => p.linkedStockProductId === parentId);

  // Count of catalogue items hidden from the terminal purely because they're out of stock
  // in the active branch (used to explain an empty grid instead of implying "no products").
  const outOfStockHiddenCount = useMemo(() => {
    return products.filter(p => {
      if (isPoolProduct(p)) return false; // hidden because it's a pool, not because of stock
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCat = selectedCategory === 'Todos' || p.category === selectedCategory;
      return matchesSearch && matchesCat && getProductStock(p, operationalBranchId, products) < 1;
    }).length;
  }, [products, searchTerm, selectedCategory, operationalBranchId, linkedParentIds]);

  // Cart helper functions.
  // Cart quantities are hard-capped at the active branch's available stock so a sale can
  // never exceed physical inventory (no oversell). Stock is read live from `products`
  // (not the cart's product snapshot) in case it changed since the item was added.
  // Reads/writes go through the functional setCart(prev => ...) form rather than the
  // `cart` closure variable. Two rapid clicks (double-tap, slow touchscreen) can fire
  // before React re-renders with the first click's update, so a version reading the
  // outer `cart` would have both clicks see the same stale snapshot — creating two
  // separate cart entries for the same product (or losing one of the two +1s) instead
  // of a single correctly-summed line. The functional form guarantees each update is
  // applied on top of the truly-latest state, in order.
  const addToCart = (product: Product) => {
    const available = getProductStock(product, operationalBranchId, products);
    setCart(prevCart => {
      const idx = prevCart.findIndex(item => item.product.id === product.id);
      const currentQty = idx > -1 ? prevCart[idx].quantity : 0;
      if (currentQty + 1 > available) {
        alert(`No hay stock suficiente de "${product.name}" en esta sucursal.\nDisponible: ${available} u.${currentQty > 0 ? ` · Ya tienes ${currentQty} en el carrito.` : ''}`);
        return prevCart;
      }
      if (idx > -1) {
        const newCart = [...prevCart];
        newCart[idx] = { ...newCart[idx], quantity: newCart[idx].quantity + 1 };
        return newCart;
      }
      return [...prevCart, { product, quantity: 1 }];
    });
  };

  const updateCartQty = (productId: string, val: number) => {
    setCart(prevCart => {
      const item = prevCart.find(i => i.product.id === productId);
      if (!item) return prevCart;
      const newQty = item.quantity + val;
      if (newQty <= 0) {
        return prevCart.filter(i => i.product.id !== productId);
      }
      if (val > 0) {
        const liveProduct = products.find(p => p.id === productId) || item.product;
        const available = getProductStock(liveProduct, operationalBranchId, products);
        if (newQty > available) {
          alert(`No hay stock suficiente de "${item.product.name}" en esta sucursal.\nDisponible: ${available} u.`);
          return prevCart;
        }
      }
      return prevCart.map(i => i.product.id === productId ? { ...i, quantity: newQty } : i);
    });
  };

  const removeFromCart = (productId: string) => {
    setCart(prevCart => prevCart.filter(i => i.product.id !== productId));
  };

  // Cart Metrics
  const cartValues = useMemo(() => {
    const subtotal = cart.reduce((acc, item) => acc + (item.product.salePrice * item.quantity), 0);
    const calculatedDiscount = canApplyDiscount
      ? (discountType === 'pct' ? (subtotal * discountVal / 100) : discountVal)
      : 0;
    const discountedTotal = Math.max(0, subtotal - calculatedDiscount);
    const taxValue = discountedTotal * taxPct / 100;
    const total = discountedTotal + taxValue;
    return { subtotal, calculatedDiscount, taxValue, total };
  }, [cart, discountType, discountVal, taxPct, canApplyDiscount]);

  // Execute Checkout Payment
  const completeTransaction = async () => {
    if (isProcessingSaleRef.current) return;
    if (cart.length === 0) return;
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada. La venta NO se registró.');
      return;
    }
    if (firestoreConnectionState === 'checking') {
      alert('Firestore está reconectando y validando la sesión. Espera a que el indicador muestre “En línea” antes de cobrar.');
      return;
    }
    if (firestoreConnectionState === 'offline') {
      alert('No hay conexión confirmada con Firestore. La venta NO se registró; el carrito permanece intacto.');
      return;
    }
    if (firestoreConnectionState === 'error') {
      alert('Firestore no pudo validar el acceso de esta sesión. La venta NO se registró; revisa la cuenta o los permisos.');
      return;
    }
    if (!cashRegister.isOpen) {
      alert('La caja de esta sucursal está cerrada. Ábrela y confirma la apertura antes de cobrar.');
      return;
    }

    // Validate Credit payment requires customer
    if (paymentMethod === 'Credit' && !selectedCustomer) {
      alert('Debe seleccionar o registrar un cliente para realizar una venta al crédito ("Fiado").');
      return;
    }

    // Validate Card or Transfer requires Folio number
    if ((paymentMethod === 'Card' || paymentMethod === 'Transfer') && !folioNumber.trim()) {
      alert('Para ventas con Tarjeta o Transferencia, es obligatorio registrar el Número de Folio / Referencia de la transacción.');
      return;
    }

    // Final oversell guard: re-check every cart line against LIVE branch stock right
    // before charging. Catches the case where stock dropped after items were added (e.g.
    // a surtido correction, or a second device selling the same branch concurrently).
    const insufficient = cart
      .map(item => {
        const liveProduct = products.find(p => p.id === item.product.id);
        const available = liveProduct ? getProductStock(liveProduct, operationalBranchId, products) : 0;
        return { name: item.product.name, requested: item.quantity, available };
      })
      .filter(x => x.requested > x.available);
    if (insufficient.length > 0) {
      alert(
        'No se puede completar la venta por falta de stock en esta sucursal:\n' +
        insufficient.map(x => `• ${x.name}: pides ${x.requested}, disponible ${x.available}`).join('\n') +
        '\n\nAjusta las cantidades o agrega stock antes de cobrar.'
      );
      return;
    }

    // Session guard: the shared write helpers no-op'd silently when these were falsy, so a
    // sale could "complete" on screen and never reach the cloud. Checking auth.currentUser
    // alongside the React `user` state costs nothing and catches state lagging a tick behind
    // reality (e.g. a shift handoff on a shared terminal). Unlike being offline — handled
    // further down — waiting doesn't fix this, so it blocks the sale outright.
    // Deliberately does NOT require currentUserMember: it only supplies employeeName (which
    // falls back to the Auth display name), branch-locked staff are already held by the
    // branch-sync gate, and demanding it here would stop an Owner from selling over a
    // transient read error on their member doc — blocking a valid sale for no gain.
    if (!user || !auth.currentUser || auth.currentUser.uid !== user.uid || !activeCompanyId) {
      alert(
        'No se pudo confirmar tu sesión o tu empresa activa.\n\n' +
        'La venta NO se registró. Cierra sesión y vuelve a iniciar sesión antes de cobrar.'
      );
      return;
    }

    // 1. New Sale structure
    const newSale: Sale = {
      // Timestamp + random suffix. The old 6-digit random id drew from only 900k values for a
      // single flat collection already holding 11k+ sales; a comparison against the last 7
      // days of point-in-time history found no sale actually lost to a repeat, but a repeat
      // would silently overwrite an existing sale for good, so the risk isn't worth keeping.
      id: `S-${Date.now()}-${crypto.randomUUID()}`,
      items: cart.map(item => ({
        productId: item.product.id,
        name: item.product.name,
        quantity: item.quantity,
        salePrice: item.product.salePrice,
        // Snapshotted now so a future refund restores the correct pool even if this product's
        // link config changes or the product is deleted before the refund happens.
        linkedStockProductId: item.product.linkedStockProductId,
        stockConsumptionFactor: item.product.stockConsumptionFactor
      })),
      subtotal: cartValues.subtotal,
      discount: cartValues.calculatedDiscount,
      tax: cartValues.taxValue,
      total: cartValues.total,
      paymentMethod,
      customerId: selectedCustomer?.id,
      customerName: selectedCustomer?.name,
      timestamp: new Date().toLocaleString(),
      createdAt: Date.now(),
      status: 'Completed',
      branchId: operationalBranchId, // Associate sale with the resolved operational branch!
      folio: (paymentMethod === 'Card' || paymentMethod === 'Transfer') ? folioNumber.trim() : undefined,
      requiresInvoice,
      invoiceStatus: requiresInvoice ? 'pending' : undefined,
      // `currentUserMember.name` covers owner/encargado/cajero alike (all are member docs).
      // The fallbacks matter: checkout no longer blocks when the member doc hasn't loaded, so
      // without them a sale could be recorded with no seller at all. Credential employees have
      // no displayName, hence the employee number parsed from their sign-in address.
      employeeName: currentUserMember?.name
        || user?.displayName
        || (employeeNumberFromEmail ? `Empleado ${employeeNumberFromEmail}` : undefined)
        || user?.email
        || undefined
    };

    // Shared identifiers for every checkoutEvents entry this attempt emits, computed once so
    // all of them (including the offline-resolved one, which can fire minutes later) stay
    // attributed consistently even if branch/session state moves on in the meantime.
    const checkoutEventBase = {
      saleId: newSale.id,
      branchId: newSale.branchId,
      branchName: branches.find(b => b.id === newSale.branchId)?.name,
      employeeName: newSale.employeeName,
      userId: auth.currentUser?.uid,
      paymentMethod: newSale.paymentMethod,
      total: newSale.total,
      itemCount: newSale.items.length,
    };

    isProcessingSaleRef.current = true;
    setIsProcessingSale(true);
    try {
      logCheckoutEvent({ ...checkoutEventBase, status: 'started' });
      const activeBranch = branches.find(b => b.id === operationalBranchId);
      const branchNameSuffix = activeBranch ? ` (${activeBranch.name})` : '';
      const paymentLabel = paymentMethod === 'Cash' ? 'Efectivo' : paymentMethod === 'Card' ? 'Tarjeta' : paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito';
      const descFolio = (paymentMethod === 'Card' || paymentMethod === 'Transfer') && folioNumber.trim() ? ` [Folio: ${folioNumber.trim()}]` : '';

      // One server transaction is the confirmation boundary. It either creates the sale,
      // decrements every live stock document, updates credit/cash, appends the cash ledger,
      // and records success together, or commits none of them. There is no UI timeout.
      await commitSaleAtomically(
        newSale,
        cart.map(item => resolveStockTarget(
          item.product.id, operationalBranchId, -item.quantity,
          item.product.linkedStockProductId, item.product.stockConsumptionFactor
        )),
        checkoutEventBase,
        {
          type: 'Venta',
          amount: cartValues.total,
          description: `Venta ${newSale.id} - ${paymentLabel}${descFolio}${branchNameSuffix}`,
          time: new Date().toLocaleTimeString(),
          createdAt: newSale.createdAt,
        }
      );
      setSales(prev => prev.some(sale => sale.id === newSale.id) ? prev : [newSale, ...prev]);

      // Reset checkout states and triggers success receipt modal
      setLastCompletedSale(newSale);
      setLastReceivedAmount(paymentMethod === 'Cash' ? parseFloat(receivedCashAmount) || 0 : 0);
      setCart([]);
      setSelectedCustomer(null);
      setDiscountVal(0);
      setReceivedCashAmount('');
      setFolioNumber('');
      setRequiresInvoice(false);
      setTaxPct(0);
      setIsCheckoutOpen(false);
    } catch (error) {
      console.error('Error guardando la venta atómicamente:', error);
      const description = isSessionInvalidError(error)
        ? { message: 'La sesión ya no es válida. La venta NO se registró; vuelve a iniciar sesión.' }
        : describeCheckoutError(error);
      logCheckoutEvent({
        ...checkoutEventBase,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        isSessionInvalid: isSessionInvalidError(error),
      });
      alert(`${description.message}\n\nEl carrito permanece intacto y no se modificó inventario, caja ni saldo del cliente.`);
    } finally {
      isProcessingSaleRef.current = false;
      setIsProcessingSale(false);
    }
  };

  const handleSelectBranch = (branchId: string) => {
    if (!isOwner) {
      alert('Solo el Dueño puede cambiar la sucursal activa.');
      return;
    }
    if (!branches.some(branch => branch.id === branchId)) {
      alert('La sucursal seleccionada no está disponible.');
      return;
    }
    setSelectedBranchId(branchId);
    if (user) safeLocalStorageSet(`logic_active_branch_${user.uid}`, branchId);
  };

  // Prints a receipt via a hidden iframe instead of window.open(). The old approach opened
  // a new tab/window and self-closed it — in the Android WebView that spawned an in-app
  // view the user couldn't back out of (had to kill the app). A hidden iframe calls the
  // host's own print dialog (Android's system print → Bluetooth/WiFi printers or Save-as-PDF;
  // the OS handles printer selection), keeps the user in the app, and cleans itself up.
  // Shared transport dispatcher for every printable ticket (sale receipts, transfer tickets).
  // Builds the full-document `ticketText` internally — the popup-blocked fallback needs the
  // *scoped* CSS variant (`ticketStylesFn('#logicpos-print-root')`) while the native-dialog
  // and popup-window paths need the *full-document* variant (`ticketStylesFn('body')`), so
  // callers hand over the body markup + a styles function rather than a prebuilt HTML string.
  const printHtmlTicket = (params: {
    docTitle: string;
    ticketBodyHtml: string;
    ticketStylesFn: (scope: string) => string;
    pageSize: string;
    pageMargin: string;
    bodyPadding: string;
    buildEscPosBytes: () => Uint8Array;
  }) => {
    const { docTitle, ticketBodyHtml, ticketStylesFn, pageSize, pageMargin, bodyPadding, buildEscPosBytes } = params;

    const ticketText = `
      <html>
        <head>
          <title>${docTitle}</title>
          <style>
            ${ticketStylesFn('body')}
            body { padding: ${bodyPadding}; }
            @media print {
              @page { size: ${pageSize}; margin: ${pageMargin}; }
              body { padding: 0; margin: 0 auto; }
            }
          </style>
        </head>
        <body>${ticketBodyHtml}</body>
      </html>
    `;

    if (isNativePlatform && bluetoothPrinter) {
      // Thermal ESC/POS printers (e.g. MERION PT-B1) don't implement Android's Print
      // Framework, so they never appear in ReceiptPrinter's system dialog below — instead we
      // talk straight to the paired device over Bluetooth SPP with raw ESC/POS bytes.
      BluetoothPrinter.printEscPos({ address: bluetoothPrinter.address, data: uint8ToBase64(buildEscPosBytes()) }).catch(err => {
        console.error('Bluetooth print error:', err);
        alert(`No se pudo imprimir en "${bluetoothPrinter.name}". Verifica que esté encendida y emparejada.`);
      });
      return;
    }

    if (isNativePlatform) {
      // Android's WebView never shows a print dialog on window.print() by itself — it needs
      // native support wired up (see ReceiptPrinterPlugin.java), which loads this HTML into
      // its own offscreen WebView and hands it to android.print.PrintManager. That's the
      // native "elige tu impresora" dialog: Bluetooth/WiFi printers or Guardar como PDF.
      ReceiptPrinter.print({ html: ticketText, jobName: docTitle }).catch(err => {
        console.error('Native print error:', err);
        alert('No se pudo abrir el diálogo de impresión. Intenta de nuevo.');
      });
      return;
    }

    if (webUsbDevice || webBluetoothDevice) {
      // Same idea as the native Bluetooth path above, but reached from a plain browser tab —
      // WebUSB/Web Bluetooth talk straight to the printer, bypassing window.print() entirely.
      const printPromise = webUsbDevice
        ? printUsb(webUsbDevice, buildEscPosBytes())
        : printBluetooth(webBluetoothDevice!, buildEscPosBytes());
      printPromise.catch(err => {
        console.error('Web printer error:', err);
        alert(`No se pudo imprimir en "${webPrinterInfo?.name || 'la impresora'}". ${err?.message || ''}`);
      });
      return;
    }

    if (webPrinterInfo) {
      // A Bluetooth printer was configured, but Web Bluetooth doesn't allow silently
      // reattaching after a page reload the way WebUSB does — needs one click to resume.
      alert(`Reconecta tu impresora "${webPrinterInfo.name}" desde Ajustes > Impresora antes de imprimir.`);
      return;
    }

    // iOS (Safari, and every other iOS browser — Apple forces them all onto WebKit) has no
    // Web Bluetooth at all, so it always falls through to window.print() below — which on
    // iOS always opens AirPrint directly, with no way for the page to route it anywhere
    // else. Bixolon's "mPrint" app (and similar thermal-printer companion apps) bridge this
    // by accepting an image through iOS's native Share Sheet instead: build the ticket as a
    // plain Canvas 2D image (no html2canvas/jsPDF.html() — those rasterize a live DOM tree
    // and are slow/async enough that by the time they finish, Safari has already forgotten
    // this was triggered by a user tap, so navigator.share() silently does nothing — that's
    // what caused the frozen-screen report) and hand it to navigator.share() synchronously,
    // right in the click's own call stack. AirPrint/"Guardar en Archivos" stay available from
    // that same sheet. Falls through to window.print() if Share isn't usable or anything here
    // throws.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && typeof navigator.share === 'function') {
      try {
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed; left:-10000px; top:0;';
        container.innerHTML = ticketBodyHtml;
        document.body.appendChild(container);

        // Walk the same ticket markup already used everywhere else (header/rows/separators/
        // signature lines) into draw instructions, reusing the exact structure and wording
        // already proven correct — just rendered with plain Canvas 2D instead of the DOM
        // rasterizer that caused the freeze (see note above).
        type DrawLine =
          | { kind: 'text'; text: string; center: boolean; bold: boolean; big?: boolean }
          | { kind: 'row'; left: string; right: string; bold: boolean }
          | { kind: 'sep' }
          | { kind: 'sigline' };
        const drawLines: DrawLine[] = [];
        // forceCenter: true while walking inside .header, whose CSS centers every child —
        // carried through explicitly instead of only matching specific known classes, so a
        // line like transfer tickets' "TRASPASO ENTRE SUCURSALES" (just class="bold", no
        // class of its own for alignment) still centers like it does in the real HTML/print.
        const walk = (el: Element, forceCenter = false) => {
          Array.from(el.children).forEach(child => {
            const tag = child.tagName;
            const cls = child.className || '';
            if (tag === 'IMG') return; // logo drawn separately below, from the preloaded ref
            if (tag === 'HR') { drawLines.push({ kind: 'sep' }); return; }
            if (cls.includes('sig-line')) { drawLines.push({ kind: 'sigline' }); return; }
            if (cls.includes('row')) {
              // Plain .children filtering instead of querySelectorAll(':scope > span') —
              // this exact spot is the prime suspect for why item/total rows printed as two
              // separate plain lines instead of one left+right row: if :scope selector
              // support/behavior is at all inconsistent on the device, this check silently
              // falls through to the generic DIV-recurse branch below, which treats each
              // <span> as its own independent, unstyled line — matching exactly what showed
              // up on the printed ticket.
              const spans = Array.from(child.children).filter(c => c.tagName === 'SPAN');
              if (spans.length >= 2) {
                drawLines.push({ kind: 'row', left: (spans[0].textContent || '').trim(), right: (spans[1].textContent || '').trim(), bold: cls.includes('total-row') });
                return;
              }
            }
            if (tag === 'DIV' && child.children.length > 0) { walk(child, forceCenter || cls.includes('header') || cls.includes('sig-block')); return; } // container (.header/.footer/.sig-block) — recurse
            const text = (child.textContent || '').trim();
            if (!text) return;
            const bold = cls.includes('bold') || cls.includes('biz-name') || cls.includes('sig-label') || cls.includes('thanks');
            const center = forceCenter || cls.includes('biz-name') || cls.includes('tagline') || cls.includes('txn-id') || cls.includes('sig-label') || cls.includes('sig-sub') || cls.includes('sig-name') || cls.includes('legal') || cls.includes('thanks');
            drawLines.push({ kind: 'text', text, center, bold, big: cls.includes('biz-name') });
          });
        };
        walk(container);
        container.remove();

        const pw = printConfig.paperWidth;
        // 384px/58mm and 576px/80mm are the standard ESC/POS raster widths thermal printers
        // (including the Bixolon SPP-R200III) expect at 203 DPI — mismatching this is what
        // made mPrint crop the ticket to a random-looking center strip last time.
        const canvasWidth = pw === 'A4' ? 800 : pw === '80mm' ? 576 : 384;
        const padding = Math.round(canvasWidth * 0.05);
        const usableWidth = canvasWidth - padding * 2;
        const fontRegular = Math.round(canvasWidth / 18);
        const fontBig = Math.round(fontRegular * 1.4);
        const lineHeight = Math.round(fontRegular * 1.5);
        const sepHeight = Math.round(lineHeight * 0.7);

        const logo = logoImgRef.current;
        const hasLogo = !!(logo && logo.complete && logo.naturalWidth > 0);
        const logoSize = hasLogo ? Math.round(canvasWidth * 0.22) : 0;
        const logoMargin = hasLogo ? Math.round(padding * 0.75) : 0;

        const contentHeight = drawLines.reduce((acc, l) => acc + (l.kind === 'sep' ? sepHeight : l.kind === 'sigline' ? Math.round(lineHeight * 1.5) : l.kind === 'text' && l.big ? Math.round(lineHeight * 1.4) : lineHeight), 0);

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = Math.max(padding * 2 + logoSize + logoMargin + contentHeight, 100);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no-canvas-context');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'top';

        let y = padding;
        if (hasLogo && logo) {
          ctx.drawImage(logo, (canvasWidth - logoSize) / 2, y, logoSize, logoSize);
          y += logoSize + logoMargin;
        }

        for (const line of drawLines) {
          if (line.kind === 'sep') {
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(padding, y + sepHeight / 2);
            ctx.lineTo(canvasWidth - padding, y + sepHeight / 2);
            ctx.strokeStyle = '#000';
            ctx.stroke();
            ctx.restore();
            y += sepHeight;
          } else if (line.kind === 'sigline') {
            ctx.beginPath();
            ctx.moveTo(padding, y + lineHeight * 0.75);
            ctx.lineTo(canvasWidth - padding, y + lineHeight * 0.75);
            ctx.strokeStyle = '#000';
            ctx.stroke();
            y += Math.round(lineHeight * 1.5);
          } else if (line.kind === 'row') {
            ctx.font = `${line.bold ? 'bold ' : ''}${fontRegular}px monospace`;
            ctx.textAlign = 'left';
            ctx.fillText(line.left, padding, y, usableWidth * 0.62);
            ctx.textAlign = 'right';
            ctx.fillText(line.right, canvasWidth - padding, y, usableWidth * 0.4);
            y += lineHeight;
          } else {
            const size = line.big ? fontBig : fontRegular;
            ctx.font = `${line.bold ? 'bold ' : ''}${size}px ${line.big ? 'sans-serif' : 'monospace'}`;
            ctx.textAlign = line.center ? 'center' : 'left';
            ctx.fillText(line.text, line.center ? canvasWidth / 2 : padding, y, usableWidth);
            y += line.big ? Math.round(lineHeight * 1.4) : lineHeight;
          }
        }
        ctx.textAlign = 'left';

        const base64 = canvas.toDataURL('image/png').split(',')[1];
        const byteChars = atob(base64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const file = new File([bytes], `${docTitle}.png`, { type: 'image/png' });

        if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('share-files-unsupported');
        navigator.share({ files: [file], title: docTitle }).catch(err => {
          console.error('iOS share error:', err);
          window.print();
        });
        return;
      } catch (err) {
        console.error('iOS ticket image error:', err);
        // fall through to window.print() below
      }
    }

    // Web: open the ticket in its own tab that prints itself on load. This is the only
    // approach verified to render correctly on Chrome for Android (tested on the client's
    // device): its print service rasterizes the *visible page* — it ignores both hidden
    // iframes and @media print show/hide scoping in the main document, which is why those
    // two earlier attempts printed a screenshot of the app (the "¡Venta Registrada!" modal)
    // instead of the ticket. In a dedicated tab, the visible page IS the ticket. `load`
    // only fires once images (the logo) are in.
    // The in-app-WebView navigation bug that originally motivated moving away from
    // window.open only affected the APK, which no longer reaches this code path at all
    // (native Bluetooth/ReceiptPrinter branches return above).
    //
    // Closing the tab needs per-platform care: on desktop print() blocks until the dialog
    // is dismissed, so close() right after is safe. On Chrome for Android print() returns
    // immediately while the system print UI is still compositing the page in the background —
    // closing right away kills the source document mid-read and the print preview shows
    // "error al cargar el archivo". There the tab goes hidden while the print UI is on top,
    // so we close it only when it becomes visible again (job sent or cancelled).
    const printScript = `
      <script>
        window.addEventListener('load', function () {
          if (/Android/i.test(navigator.userAgent)) {
            var wasHidden = false;
            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'hidden') { wasHidden = true; }
              else if (wasHidden) { window.close(); }
            });
            window.print();
          } else {
            window.print();
            window.close();
          }
        });
      <\/script>
    `;
    const popupHtml = ticketText.replace('</body>', printScript + '</body>');
    const ticketWindow = window.open('', '_blank');
    if (ticketWindow) {
      ticketWindow.document.open();
      ticketWindow.document.write(popupHtml);
      ticketWindow.document.close();
      return;
    }

    // Popup blocked: fall back to rendering the ticket inside the main document and hiding
    // everything else via @media print. Fine on desktop browsers; on Chrome for Android it
    // may print the visible screen instead (see above), so the popup path is preferred.
    document.getElementById('logicpos-print-root')?.remove();
    document.getElementById('logicpos-print-style')?.remove();

    const printStyle = document.createElement('style');
    printStyle.id = 'logicpos-print-style';
    printStyle.textContent = `
      #logicpos-print-root { display: none; }
      ${ticketStylesFn('#logicpos-print-root')}
      @media print {
        @page { size: ${pageSize}; margin: ${pageMargin}; }
        html, body { background: #fff !important; }
        body > *:not(#logicpos-print-root) { display: none !important; }
        #logicpos-print-root { display: block !important; padding: ${bodyPadding}; }
      }
    `;

    const printRoot = document.createElement('div');
    printRoot.id = 'logicpos-print-root';
    printRoot.innerHTML = ticketBodyHtml;

    document.body.appendChild(printStyle);
    document.body.appendChild(printRoot);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      printRoot.remove();
      printStyle.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    // Wait for the logo image (if any) to finish loading, otherwise it prints blank.
    const images = Array.from(printRoot.querySelectorAll('img'));
    const imagesReady = Promise.all(
      images.map(img => img.complete ? Promise.resolve() : new Promise<void>(res => { img.onload = () => res(); img.onerror = () => res(); }))
    );
    imagesReady.then(() => {
      setTimeout(() => {
        try {
          window.print();
        } catch (err) {
          console.error('Print error:', err);
          cleanup();
        }
        // Fallback for browsers that never fire `afterprint`.
        setTimeout(cleanup, 120000);
      }, 100);
    });
  };

  const handlePrintReceipt = (sale: Sale) => {
    const ticketBusinessName = branding.displayName || (activeCompanyId ? userCompanies[activeCompanyId]?.name : '') || 'Mi Comercio';
    const ticketTagline = branding.tagline || '';
    const ticketLogo = (printConfig.showLogo && branding.logoUrl) ? branding.logoUrl : '';
    const payLabel = sale.paymentMethod === 'Cash' ? 'Efectivo' : sale.paymentMethod === 'Card' ? 'Tarjeta' : sale.paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito/Fiado';

    const pw = printConfig.paperWidth;
    const isA4 = pw === 'A4';
    const pageSize = isA4 ? 'A4' : `${pw} auto`;
    const pageMargin = isA4 ? '1cm' : '0mm';
    const bodyMaxWidth = pw === '58mm' ? '220px' : pw === '80mm' ? '302px' : '640px';
    const bodyPadding = isA4 ? '20px 40px' : '10px 14px';
    const baseFontSize = pw === '58mm' ? '11px' : '12px';

    // Inner ticket markup, shared by every HTML-based path (native ReceiptPrinter full-doc,
    // and the web @media-print container). Kept separate from the <style> so the same markup
    // can be printed either as a standalone document or scoped inside the live page.
    const ticketBodyHtml = `
          <div class="header">
            ${ticketLogo ? `<img src="${ticketLogo}" class="logo" alt="logo">` : ''}
            <p class="biz-name">${ticketBusinessName}</p>
            ${ticketTagline ? `<p class="tagline">${ticketTagline}</p>` : ''}
            <p class="txn-id">Transacción: ${sale.id}</p>
          </div>
          <hr class="sep">
          <p><b>Fecha:</b> ${sale.timestamp}</p>
          <p><b>Método de Pago:</b> ${payLabel}</p>
          ${sale.customerName ? `<p><b>Cliente:</b> ${sale.customerName}</p>` : ''}
          ${sale.employeeName ? `<p><b>Atendido por:</b> ${sale.employeeName}</p>` : ''}
          <hr class="sep">
          <p class="bold">ARTÍCULOS:</p>
          ${sale.items.map(it => `
            <div class="row">
              <span>${it.quantity}x ${it.name}</span>
              <span>${formatMXN(it.salePrice * it.quantity)}</span>
            </div>
          `).join('')}
          <hr class="sep">
          <div class="row"><span>Subtotal:</span><span>${formatMXN(sale.subtotal)}</span></div>
          ${sale.discount > 0 ? `<div class="row"><span>Descuento:</span><span>-${formatMXN(sale.discount)}</span></div>` : ''}
          ${printConfig.showTaxLine ? `<div class="row"><span>Impuestos:</span><span>${formatMXN(sale.tax)}</span></div>` : ''}
          <div class="row total-row"><span>TOTAL:</span><span>${formatMXN(sale.total)}</span></div>
          <div class="footer">
            <p class="thanks">${printConfig.footerText || '¡Gracias por su compra!'}</p>
            <p class="legal">Comprobante simplificado sin validez fiscal</p>
          </div>
    `;

    // Ticket CSS, generated for a given scope selector so it can style either a full document
    // (scope 'body') or a container div living inside the app (scope '#logicpos-print-root').
    const ticketStylesFn = (scope: string) => `
            ${scope} { font-family: 'Courier New', Courier, monospace; font-size: ${baseFontSize}; line-height: 1.45; color: #000; max-width: ${bodyMaxWidth}; margin: 0 auto; background: #fff; box-sizing: border-box; }
            ${scope} * { box-sizing: border-box; }
            ${scope} .header { text-align: center; margin-bottom: 6px; }
            ${scope} .logo { display: block; margin: 0 auto 6px; width: 64px; height: 64px; object-fit: contain; filter: grayscale(1) contrast(1.1); }
            ${scope} .biz-name { font-size: ${isA4 ? '20px' : '15px'}; font-weight: 900; letter-spacing: 0.5px; margin: 0 0 2px; text-transform: uppercase; }
            ${scope} .tagline { font-size: 9px; margin: 0 0 4px; color: #555; }
            ${scope} .txn-id { font-size: 9px; color: #666; margin: 0; }
            ${scope} p { margin: 0 0 4px; }
            ${scope} .sep { border: none; border-top: 1px dashed #555; margin: 6px 0; }
            ${scope} .row { display: flex; justify-content: space-between; margin-bottom: 2px; }
            ${scope} .bold { font-weight: bold; }
            ${scope} .total-row { font-size: ${isA4 ? '16px' : '13px'}; font-weight: 900; border-top: 2px solid #000; padding-top: 4px; margin-top: 4px; }
            ${scope} .footer { text-align: center; margin-top: 8px; }
            ${scope} .footer .thanks { font-weight: 900; font-size: ${isA4 ? '14px' : '12px'}; }
            ${scope} .footer .legal { font-size: 9px; color: #777; margin-top: 3px; }
    `;

    printHtmlTicket({
      docTitle: `Ticket ${sale.id}`,
      ticketBodyHtml,
      ticketStylesFn,
      pageSize,
      pageMargin,
      bodyPadding,
      buildEscPosBytes: () => buildReceiptEscPos({
        businessName: ticketBusinessName,
        tagline: ticketTagline,
        saleId: sale.id,
        timestamp: sale.timestamp,
        payLabel,
        customerName: sale.customerName,
        employeeName: sale.employeeName,
        items: sale.items,
        subtotal: sale.subtotal,
        discount: sale.discount,
        tax: sale.tax,
        total: sale.total,
        showTaxLine: printConfig.showTaxLine,
        footerText: printConfig.footerText || '¡Gracias por su compra!',
        columns: columnsForPaperWidth(printConfig.paperWidth),
        formatMXN,
      }),
    });
  };

  // Printable transfer ticket (delivery note) for inter-branch stock transfers — same
  // paper-width/logo config and print pipeline as the sale receipt, but no prices/totals,
  // and 3 blank signature blocks for physical (pen) signatures collected as the merchandise
  // changes hands.
  const handlePrintTransferTicket = (transfer: CompletedTransfer) => {
    const ticketBusinessName = branding.displayName || (activeCompanyId ? userCompanies[activeCompanyId]?.name : '') || 'Mi Comercio';
    const ticketTagline = branding.tagline || '';
    const ticketLogo = (printConfig.showLogo && branding.logoUrl) ? branding.logoUrl : '';

    const pw = printConfig.paperWidth;
    const isA4 = pw === 'A4';
    const pageSize = isA4 ? 'A4' : `${pw} auto`;
    const pageMargin = isA4 ? '1cm' : '0mm';
    const bodyMaxWidth = pw === '58mm' ? '220px' : pw === '80mm' ? '302px' : '640px';
    const bodyPadding = isA4 ? '20px 40px' : '10px 14px';
    const baseFontSize = pw === '58mm' ? '11px' : '12px';

    const signatures: { title: string; subtitle: string }[] = [
      { title: 'FIRMA DE ENVÍO', subtitle: '(Encargado, sucursal origen)' },
      { title: 'FIRMA DE RECEPCIÓN', subtitle: '(Personal, sucursal destino)' },
      { title: 'FIRMA DE VALIDACIÓN', subtitle: '(Encargado, sucursal destino)' },
    ];

    const ticketBodyHtml = `
          <div class="header">
            ${ticketLogo ? `<img src="${ticketLogo}" class="logo" alt="logo">` : ''}
            <p class="biz-name">${ticketBusinessName}</p>
            ${ticketTagline ? `<p class="tagline">${ticketTagline}</p>` : ''}
            <p class="bold" style="margin-top:4px;">TRASPASO ENTRE SUCURSALES</p>
            <p class="txn-id">Folio: ${transfer.id}</p>
          </div>
          <hr class="sep">
          <p><b>Fecha:</b> ${transfer.timestamp}</p>
          <p><b>Origen:</b> ${transfer.sourceBranchName}${transfer.sourceBranchAddress ? ` — ${transfer.sourceBranchAddress}` : ''}</p>
          <p><b>Destino:</b> ${transfer.targetBranchName}${transfer.targetBranchAddress ? ` — ${transfer.targetBranchAddress}` : ''}</p>
          ${transfer.initiatedByName ? `<p><b>Iniciado por:</b> ${transfer.initiatedByName}</p>` : ''}
          <hr class="sep">
          <p class="bold">PRODUCTOS:</p>
          ${transfer.items.map(it => `
            <div class="row">
              <span>${it.quantity}x ${it.productName}</span>
              <span>${formatMXN(it.salePrice * it.quantity)}</span>
            </div>
          `).join('')}
          <div class="row total-row"><span>TOTAL:</span><span>${formatMXN(transfer.items.reduce((acc, it) => acc + it.salePrice * it.quantity, 0))}</span></div>
          <hr class="sep">
          ${signatures.map((sig, idx) => `
            <div class="sig-block">
              <p class="sig-label">${idx + 1}) ${sig.title}</p>
              <p class="sig-sub">${sig.subtitle}</p>
              <div class="sig-line"></div>
              <p class="sig-name">Nombre: ____________________________</p>
            </div>
          `).join('')}
    `;

    const ticketStylesFn = (scope: string) => `
            ${scope} { font-family: 'Courier New', Courier, monospace; font-size: ${baseFontSize}; line-height: 1.45; color: #000; max-width: ${bodyMaxWidth}; margin: 0 auto; background: #fff; box-sizing: border-box; }
            ${scope} * { box-sizing: border-box; }
            ${scope} .header { text-align: center; margin-bottom: 6px; }
            ${scope} .logo { display: block; margin: 0 auto 6px; width: 64px; height: 64px; object-fit: contain; filter: grayscale(1) contrast(1.1); }
            ${scope} .biz-name { font-size: ${isA4 ? '20px' : '15px'}; font-weight: 900; letter-spacing: 0.5px; margin: 0 0 2px; text-transform: uppercase; }
            ${scope} .tagline { font-size: 9px; margin: 0 0 4px; color: #555; }
            ${scope} .txn-id { font-size: 9px; color: #666; margin: 0; }
            ${scope} p { margin: 0 0 4px; }
            ${scope} .sep { border: none; border-top: 1px dashed #555; margin: 6px 0; }
            ${scope} .row { display: flex; justify-content: space-between; margin-bottom: 2px; }
            ${scope} .total-row { font-size: ${isA4 ? '16px' : '13px'}; font-weight: 900; border-top: 2px solid #000; padding-top: 4px; margin-top: 4px; }
            ${scope} .bold { font-weight: bold; }
            ${scope} .sig-block { margin-top: 16px; text-align: center; }
            ${scope} .sig-label { font-weight: 900; font-size: ${isA4 ? '13px' : '11px'}; margin-bottom: 0; }
            ${scope} .sig-sub { font-size: 9px; color: #555; margin-bottom: 20px; }
            ${scope} .sig-line { border-top: 1px solid #000; width: 90%; margin: 0 auto 4px; }
            ${scope} .sig-name { font-size: 10px; }
    `;

    printHtmlTicket({
      docTitle: `Traspaso ${transfer.id}`,
      ticketBodyHtml,
      ticketStylesFn,
      pageSize,
      pageMargin,
      bodyPadding,
      buildEscPosBytes: () => buildTransferEscPos({
        businessName: ticketBusinessName,
        tagline: ticketTagline,
        transferId: transfer.id,
        timestamp: transfer.timestamp,
        sourceBranchName: transfer.sourceBranchName,
        sourceBranchAddress: transfer.sourceBranchAddress,
        targetBranchName: transfer.targetBranchName,
        targetBranchAddress: transfer.targetBranchAddress,
        initiatedByName: transfer.initiatedByName,
        items: transfer.items.map(it => ({ productName: it.productName, quantity: it.quantity, unitPrice: it.salePrice })),
        columns: columnsForPaperWidth(printConfig.paperWidth),
        formatMXN,
      }),
    });
  };

  // Reprints a transfer ticket from the Historial > Inventario audit log — for when it wasn't
  // printed (or was lost) at the time. Reconstructs a CompletedTransfer from every StockMovement
  // sharing this transferId: the 'transfer_out' side alone has everything needed (product list,
  // both branch names, who initiated it), since each product's out/in pair carries identical
  // quantity/productName info from the two branches' perspectives. Only works for transfers made
  // after transferId started being recorded — older movements won't have one.
  const handleReprintTransfer = async (transferId: string) => {
    // Fast path: the active branch's own (branch-scoped) stockMovements already has the
    // 'transfer_out' entry when reprinting from the SENDING branch's Historial.
    let outEntries = stockMovements.filter(mv => mv.transferId === transferId && mv.type === 'transfer_out');
    if (outEntries.length === 0) {
      // Reprinting from the RECEIVING branch instead — its own scoped stockMovements has the
      // 'transfer_in' side, which carries the same products, quantities, prices, initiator and
      // both branch names, so mirror it (the rules only let a non-owner list its own branch's
      // movements, which made the old query below fail for an Encargado).
      outEntries = stockMovements
        .filter(mv => mv.transferId === transferId && mv.type === 'transfer_in')
        .map(mv => ({
          ...mv,
          type: 'transfer_out' as const,
          branchId: mv.counterpartBranchId || '',
          branchName: mv.counterpartBranchName,
          counterpartBranchId: mv.branchId,
          counterpartBranchName: mv.branchName,
        }));
    }
    if (outEntries.length === 0 && isOwner && user && activeCompanyId) {
      // Owner looking at a transfer that is in neither side's loaded log: fetch the sending
      // branch's 'transfer_out' entries on demand.
      try {
        const snap = await getDocs(query(
          collection(db, 'companies', activeCompanyId, 'stockMovements'),
          where('transferId', '==', transferId),
          where('type', '==', 'transfer_out')
        ));
        const fetched: StockMovement[] = [];
        snap.forEach(d => fetched.push(d.data() as StockMovement));
        outEntries = fetched;
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, `companies/${activeCompanyId}/stockMovements (reprint transfer)`);
      }
    }
    if (outEntries.length === 0) {
      alert('No se encontró la información completa de este traspaso para reimprimir.');
      return;
    }
    const first = outEntries[0];
    const sourceBranch = branches.find(b => b.id === first.branchId);
    const targetBranch = branches.find(b => b.id === first.counterpartBranchId);
    handlePrintTransferTicket({
      id: transferId,
      timestamp: first.timestamp,
      createdAt: first.createdAt,
      sourceBranchId: first.branchId,
      sourceBranchName: first.branchName || sourceBranch?.name || 'Sucursal',
      sourceBranchAddress: sourceBranch?.address || undefined,
      targetBranchId: first.counterpartBranchId || '',
      targetBranchName: first.counterpartBranchName || targetBranch?.name || 'Sucursal',
      targetBranchAddress: targetBranch?.address || undefined,
      initiatedByName: first.userName || undefined,
      items: outEntries.map(mv => ({ productId: mv.productId, productName: mv.productName, quantity: mv.quantity, salePrice: mv.unitPrice ?? 0 })),
    });
  };

  // Product Creator/Editor State
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [prodForm, setProdForm] = useState({
    name: '',
    category: '',
    costPrice: '',
    salePrice: '',
    stock: '',
    minStock: '',
    sku: '',
    supplierId: '', // Associated supplier link
    linkedStockProductId: '', // '' = independent product, otherwise id of the shared-stock parent
    stockConsumptionFactor: '', // how much of the parent's stock one unit consumes (0.5 = medio, 1 = litro)
    isStockPool: false // true = this product is itself a shared-stock pool, never sold directly
  });

  // "Producto con Presentaciones" wizard — creates a shared-stock pool product AND every one of
  // its presentations (children) in a single save, instead of the multi-screen manual flow above
  // (create the pool, then edit each presentation separately to link it). Deliberately generic:
  // no product names, prices, or category are ever hardcoded — only the two starter factors
  // (0.5/1, a generic half/whole split) are prefilled, everything else is blank with a
  // placeholder. The manual flow (isStockPool checkbox + linkedStockProductId select above)
  // stays available as-is for one-off/special cases; this is just a faster path for the common
  // "one pool, several presentations" case.
  const [isBulkProductModalOpen, setIsBulkProductModalOpen] = useState(false);
  type BulkPresentationRow = { suffix: string; price: string; factor: string; costPrice: string; sku: string; minStock: string };
  const blankBulkPresentations = (): BulkPresentationRow[] => [
    { suffix: '', price: '', factor: '0.5', costPrice: '', sku: '', minStock: '' },
    { suffix: '', price: '', factor: '1', costPrice: '', sku: '', minStock: '' },
  ];
  const [bulkForm, setBulkForm] = useState({
    baseName: '', // e.g. "Atole de Mango" — becomes the pool product's name
    category: '',
    costPrice: '',   // pool's own cost, same field as the regular product form
    minStock: '5',   // pool's low-stock alert threshold
    sku: '',         // pool's SKU, optional — auto-generated if left blank, same as regular form
    supplierId: '',  // pool's linked supplier for restocking (only the pool is ever restocked)
    initialStock: '', // pool's starting stock, decimals allowed
    presentations: blankBulkPresentations()
  });

  const handleOpenBulkProductModal = () => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para crear productos.');
      return;
    }
    setBulkForm({
      baseName: '',
      category: '',
      costPrice: '',
      minStock: '5',
      sku: '',
      supplierId: '',
      initialStock: '',
      presentations: blankBulkPresentations()
    });
    setIsBulkProductModalOpen(true);
  };

  const handleSaveBulkProductGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para crear productos.');
      return;
    }
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    const presentations = bulkForm.presentations.filter(p => p.suffix.trim() && p.price !== '' && p.factor !== '');
    if (!bulkForm.baseName.trim() || !bulkForm.category.trim() || presentations.length === 0) {
      alert('Nombre base, categoría, y al menos una presentación completa (nombre, precio y factor) son obligatorios.');
      return;
    }
    // A factor of 0 or negative would silently zero out (or invert) that presentation's derived
    // stock forever with no visible error — reject the whole save instead of coercing it away.
    const invalidFactorRow = presentations.find(p => isNaN(parseFloat(p.factor)) || parseFloat(p.factor) <= 0);
    if (invalidFactorRow) {
      alert(`El Factor de Consumo de "${invalidFactorRow.suffix}" debe ser un número mayor a 0.`);
      return;
    }
    const initialStockNum = parseFloat(bulkForm.initialStock) || 0;
    const poolId = createDocumentId('P');
    const poolProduct: Product = {
      id: poolId,
      name: bulkForm.baseName.trim(),
      category: bulkForm.category,
      costPrice: parseFloat(bulkForm.costPrice) || 0,
      salePrice: 0,
      stock: initialStockNum,
      minStock: parseInt(bulkForm.minStock) || 0,
      sku: bulkForm.sku || createDocumentId('SKU'),
      supplierId: bulkForm.supplierId || undefined,
      branchStocks: { [operationalBranchId]: initialStockNum },
      isStockPool: true
    };
    const childProducts: Product[] = presentations.map((p, idx) => ({
      id: `${createDocumentId('P')}-${idx}`,
      name: `${bulkForm.baseName.trim()} ${p.suffix.trim()}`.trim(),
      category: bulkForm.category,
      costPrice: parseFloat(p.costPrice) || 0,
      salePrice: parseFloat(p.price) || 0,
      stock: 0,
      minStock: parseInt(p.minStock) || 0,
      sku: p.sku || `${createDocumentId('SKU')}-${idx}`,
      branchStocks: {},
      linkedStockProductId: poolId,
      stockConsumptionFactor: parseFloat(p.factor)
    }));
    try {
      await saveAllData([...products, poolProduct, ...childProducts], customers, sales, cashRegister);
      setIsBulkProductModalOpen(false);
    } catch {
      alert('No se pudo confirmar el guardado de los productos. Revisa el acceso e inténtalo de nuevo.');
    }
  };

  // Quick add-stock ("Surtir") — adds units to the ACTIVE branch instead of overwriting
  // the total. Faster than editing the article (no need to read the current number and
  // do mental math). Goes through applyStockDeltas so it's atomic and per-branch.
  const [quickStockProduct, setQuickStockProduct] = useState<Product | null>(null);
  const [quickStockAmount, setQuickStockAmount] = useState('');
  const [isSavingQuickStock, setIsSavingQuickStock] = useState(false);

  const handleQuickAddStock = async () => {
    if (!canRestock) {
      alert('Tu cuenta no tiene permiso para surtir o ajustar existencias.');
      return;
    }
    if (!quickStockProduct) return;
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    // parseFloat (not parseInt) so restocking a shared-stock "parent" pool in liters (e.g. 2.5)
    // isn't silently truncated — doesn't change anything for products restocked in whole units.
    const qty = parseFloat(quickStockAmount);
    if (isNaN(qty) || qty === 0) {
      alert('Ingresa una cantidad válida (mayor a 0 para sumar, negativa para restar).');
      return;
    }
    // Centralized safety net: a linked ("child") product has no real stock of its own. The
    // normal UI already keeps children out of every "Surtir" entry point, but this guards
    // against any shortcut that bypasses those pickers (e.g. a dashboard alert's quick-action)
    // by redirecting to the real pool instead of silently writing to the child's unused field —
    // which would otherwise deduct real money from the register for zero actual stock gained.
    let targetProduct = quickStockProduct;
    let effectiveQty = qty;
    if (quickStockProduct.linkedStockProductId && quickStockProduct.stockConsumptionFactor) {
      const parent = products.find(p => p.id === quickStockProduct.linkedStockProductId);
      if (!parent) {
        alert('No se pudo encontrar el producto padre de este artículo. No se puede surtir.');
        return;
      }
      if (!confirm(`"${quickStockProduct.name}" usa el stock de "${parent.name}". Esto agregará ${(qty * quickStockProduct.stockConsumptionFactor).toFixed(2)} unidades al fondo de "${parent.name}" en su lugar. ¿Continuar?`)) {
        return;
      }
      targetProduct = parent;
      effectiveQty = qty * quickStockProduct.stockConsumptionFactor;
    }
    setIsSavingQuickStock(true);
    try {
      // Positive = surtido (entrada); negative = merma/ajuste. Per-branch + atomic.
      const branchName = branches.find(b => b.id === operationalBranchId)?.name;
      // Stock and its audit movement share one transaction: either both exist or neither does.
      await applyStockDeltas([{ productId: targetProduct.id, branchId: operationalBranchId, qtyDelta: effectiveQty }], [{
        type: effectiveQty > 0 ? 'surtido' : 'merma',
        productId: targetProduct.id,
        productName: targetProduct.name,
        quantity: Math.abs(effectiveQty),
        branchId: operationalBranchId,
        branchName,
      }]);
      setQuickStockProduct(null);
      setQuickStockAmount('');
    } catch (err) {
      console.error('Quick stock error:', err);
      alert('No se pudo actualizar el stock. Intenta de nuevo.');
    } finally {
      setIsSavingQuickStock(false);
    }
  };


  const handleOpenProductModal = (product?: Product) => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para crear o editar productos.');
      return;
    }
    if (product) {
      setEditingProduct(product);
      setProdForm({
        name: product.name,
        category: product.category,
        costPrice: product.costPrice.toString(),
        salePrice: product.salePrice.toString(),
        stock: getProductStock(product, operationalBranchId, products).toString(),
        minStock: product.minStock.toString(),
        sku: product.sku || '',
        supplierId: product.supplierId || '',
        linkedStockProductId: product.linkedStockProductId || '',
        stockConsumptionFactor: product.stockConsumptionFactor?.toString() || '',
        isStockPool: product.isStockPool || false
      });
    } else {
      setEditingProduct(null);
      setProdForm({
        name: '',
        category: '',
        costPrice: '',
        salePrice: '',
        stock: '',
        minStock: '5',
        sku: '',
        supplierId: '',
        linkedStockProductId: '',
        stockConsumptionFactor: '',
        isStockPool: false
      });
    }
    setIsProductModalOpen(true);
  };

  const handleSaveProduct = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para crear o editar productos.');
      return;
    }
    if (!prodForm.name || !prodForm.salePrice) {
      alert('Nombre y Precio de Venta son obligatorios.');
      return;
    }

    const salePriceNum = parseFloat(prodForm.salePrice);
    const costPriceNum = parseFloat(prodForm.costPrice) || 0;
    // parseFloat (not parseInt) so a shared-stock "parent" pool can hold liters like 3.5 —
    // doesn't change anything for products where the field is just entered as a whole number.
    const stockNum = parseFloat(prodForm.stock) || 0;
    const minStockNum = parseInt(prodForm.minStock) || 0;
    const linkedStockProductId = prodForm.linkedStockProductId || undefined;
    // A factor of 0 or negative would silently zero out (or invert) this product's derived
    // stock forever with no visible error — reject it explicitly instead of coercing it away.
    if (linkedStockProductId) {
      const parsedFactor = parseFloat(prodForm.stockConsumptionFactor);
      if (isNaN(parsedFactor) || parsedFactor <= 0) {
        alert('El Factor de Consumo debe ser un número mayor a 0.');
        return;
      }
    }
    const stockConsumptionFactor = linkedStockProductId ? parseFloat(prodForm.stockConsumptionFactor) : undefined;
    // A "child" product's own stock isn't real (it's derived from the parent) — never overwrite
    // it here, so whatever was last stored just sits unused instead of drifting from reality.
    const isChild = !!linkedStockProductId;
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }

    let updatedProducts: Product[];
    if (editingProduct) {
      updatedProducts = products.map(p => {
        if (p.id === editingProduct.id) {
          const branchStocks = { ...(p.branchStocks || {}) };
          if (!isChild) branchStocks[operationalBranchId] = stockNum;
          return {
            ...p,
            name: prodForm.name,
            category: prodForm.category || 'Varios',
            costPrice: costPriceNum,
            salePrice: salePriceNum,
            // Consolidated total, not this branch's number — writing the active branch's
            // count here is what let a price/name edit in one sucursal silently redefine
            // every other sucursal's stock.
            stock: isChild ? p.stock : sumBranchStocks(branchStocks),
            minStock: minStockNum,
            sku: prodForm.sku,
            supplierId: prodForm.supplierId || undefined,
            branchStocks,
            linkedStockProductId,
            stockConsumptionFactor,
            isStockPool: prodForm.isStockPool || undefined
          };
        }
        return p;
      });
    } else {
      const newProd: Product = {
        id: createDocumentId('P'),
        name: prodForm.name,
        category: prodForm.category || 'Varios',
        costPrice: costPriceNum,
        salePrice: salePriceNum,
        stock: isChild ? 0 : stockNum,
        minStock: minStockNum,
        sku: prodForm.sku || createDocumentId('SKU'),
        supplierId: prodForm.supplierId || undefined,
        branchStocks: isChild ? {} : { [operationalBranchId]: stockNum },
        linkedStockProductId,
        stockConsumptionFactor,
        isStockPool: prodForm.isStockPool || undefined
      };
      updatedProducts = [...products, newProd];
    }

    try {
      await saveAllData(updatedProducts, customers, sales, cashRegister);
      setIsProductModalOpen(false);
    } catch {
      alert('No se pudo confirmar el guardado del producto. Revisa el acceso e inténtalo de nuevo.');
    }
  };

  const handleDeleteProduct = async (prodId: string) => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para eliminar productos.');
      return;
    }
    // Deleting a shared-stock "parent" leaves its children pointing at nothing — getProductStock
    // treats that as 0 available rather than crashing, but it's silent, so warn explicitly here.
    const dependentChildren = products.filter(p => p.linkedStockProductId === prodId);
    const warning = dependentChildren.length > 0
      ? `Este producto es el fondo de stock de ${dependentChildren.map(p => p.name).join(', ')}. Si lo eliminas, esos productos quedarán sin stock disponible hasta que los vincules a otro padre.\n\n¿Eliminar de todas formas?`
      : '¿Está seguro de que desea eliminar este producto del catálogo?';
    if (confirm(warning)) {
      const updated = products.filter(p => p.id !== prodId);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'products', prodId));
        } catch (err) {
          throw handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/products/${prodId}`);
        }
      }
      try {
        await saveAllData(updated, customers, sales, cashRegister);
      } catch {
        alert('No se pudo confirmar la eliminación del producto.');
      }
    }
  };

  const handleDownloadDashboard = async () => {
    if (!canViewAnalytics) {
      alert('Tu cuenta no tiene acceso a las estad\u00EDsticas.');
      return;
    }
    let csvContent = "\uFEFF";
    csvContent += "REPORTE DE RENDIMIENTO - DASHBOARD GENERAL\n";
    csvContent += `Periodo: ${statsMonth === 'all' ? 'Todo el hist\u00F3rico' : getMonthLabel(statsMonth)}\n`;
    csvContent += `Fecha de exportacion: ${new Date().toLocaleDateString()}\n\n`;

    csvContent += "METRICAS CLAVE\n";
    csvContent += `Ingreso Bruto,${stats.grossRevenue.toFixed(2)} MXN\n`;
    csvContent += `Ganancia Estimada,${stats.profit.toFixed(2)} MXN\n`;
    csvContent += `Ticket Promedio,${stats.averageTicket.toFixed(2)} MXN\n`;
    csvContent += `Productos con Bajo Stock,${stats.lowStockItems.length} articulos\n\n`;

    csvContent += "VENTAS POR CATEGORIA\n";
    csvContent += "Categoria,Unidades Vendidas\n";
    Object.entries(stats.categoryPopularity).forEach(([cat, val]) => {
      csvContent += `${cat.replace(/,/g, ' ')},${val}\n`;
    });
    csvContent += "\n";

    csvContent += "RESUMEN DE SUCURSALES\n";
    csvContent += "Sucursal,Ventas Totales del periodo\n";
    // `sales` in memory is now scoped to only the active branch (see the branch-scoped
    // listener), so the other branches' totals for this cross-branch summary are fetched
    // fresh here, once, only when this export is actually clicked. Fetched in parallel but
    // appended in `branches` order afterward, since Promise.all resolves out of order.
    // A non-owner may only read its own branch (the rules deny every other one), so for an
    // Encargado the summary is limited to its assigned branch instead of failing silently.
    const summaryBranches = getInventoryExportBranches<Branch>(activeCompanyRole, operationalBranchId, branches);
    if (user && activeCompanyId) {
      const compId = activeCompanyId;
      const dashboardRange = statsMonth === 'all' ? null : getMonthRange(statsMonth);
      let branchTotals: number[];
      try {
      branchTotals = await Promise.all(summaryBranches.map(async (b) => {
        const salesRef = collection(db, 'companies', compId, 'sales');
        const snap = await getDocs(dashboardRange
          ? query(
              salesRef,
              where('branchId', '==', b.id),
              where('status', '==', 'Completed'),
              where('createdAt', '>=', dashboardRange.start),
              where('createdAt', '<', dashboardRange.end),
              orderBy('createdAt', 'desc')
            )
          : query(salesRef, where('branchId', '==', b.id), where('status', '==', 'Completed'))
        );
        let bTotal = 0;
        snap.forEach(d => {
          const s = d.data() as Sale;
          if (statsMonth === 'all' || getSaleMonthKey(s) === statsMonth) bTotal += s.total;
        });
        return bTotal;
      }));
      } catch (err) {
        console.error('Dashboard export failed:', err);
        alert('No se pudo calcular el resumen de sucursales. El reporte NO se descargó; intenta de nuevo.');
        return;
      }
      summaryBranches.forEach((b, i) => {
        csvContent += `${b.name.replace(/,/g, ' ')},${branchTotals[i].toFixed(2)} MXN\n`;
      });
    }

    await saveFileOnDevice(`informe_dashboard_${new Date().toISOString().split('T')[0]}.csv`, utf8ToBase64(csvContent), 'text/csv');
  };

  const handleExportProducts = async () => {
    if (!canEditProducts) {
      alert('Tu cuenta no tiene permiso para exportar el catálogo e inventario.');
      return;
    }
    const exportBranches = getInventoryExportBranches<Branch>(activeCompanyRole, operationalBranchId, branches);
    if (!isOwner && exportBranches.length === 0) {
      alert('No se puede exportar: tu sucursal operativa aún no está disponible.');
      return;
    }
    let csvContent = "\uFEFF";
    csvContent += "REPORTE DE CATALOGO E INVENTARIO GENERAL\n";
    csvContent += `Fecha de exportacion: ${new Date().toLocaleDateString()}\n`;
    csvContent += `Comercio: ${userCompanies[activeCompanyId || '']?.name || 'Empresa'}\n\n`;

    // Headers with specific Branch stocks
    let headers = "ID,Nombre,Categoria,PRECIO COMPRA (Costo),PRECIO VENTA,STOCK TOTAL,ALERTA MINIMA,SKU,FONDO COMPARTIDO (VINCULADO A)";
    exportBranches.forEach(b => {
      headers += `,Stock - ${b.name.replace(/,/g, ' ')}`;
    });
    csvContent += headers + "\n";

    products.forEach(p => {
      // getProductStock (not p.stock/p.branchStocks directly) so a linked "child" product shows
      // its real derived availability instead of its own unused/stale stock field.
      const branchVals = exportBranches.map(b => getProductStock(p, b.id, products));
      const totalStock = branchVals.reduce((sum, v) => sum + v, 0);
      // A linked product's STOCK TOTAL is the SAME underlying pool viewed at a different scale
      // as its parent's — this column makes that explicit so nobody sums this row's total
      // together with its parent's (or a sibling presentation's) and double/triple-counts stock
      // that's physically the same inventory.
      const linkedParentName = p.linkedStockProductId
        ? products.find(parent => parent.id === p.linkedStockProductId)?.name || p.linkedStockProductId
        : '';
      let row = `"${p.id}","${p.name.replace(/"/g, '""')}",` +
                `"${(p.category || 'General').replace(/"/g, '""')}",` +
                `${p.costPrice || 0},${p.salePrice || 0},${totalStock},${p.minStock || 0},` +
                `"${p.sku || ''}","${linkedParentName.replace(/"/g, '""')}"`;

      branchVals.forEach(val => {
        row += `,${val}`;
      });
      csvContent += row + "\n";
    });

    await saveFileOnDevice(`catalogo_productos_e_inventario_${new Date().toISOString().split('T')[0]}.csv`, utf8ToBase64(csvContent), 'text/csv');
  };

  // Generates a downloadable PDF "Corte Mensual" (monthly statement) for the currently
  // selected branch and month — every past month with recorded sales is selectable,
  // since the underlying history in Firestore is never pruned.
  const handleDownloadMonthlyCutPdf = async () => {
    if (!canViewCashAudit) {
      alert('Tu cuenta no tiene acceso al corte mensual.');
      return;
    }
    const [{ jsPDF }, { autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const isSelectedMatriz = branches.find(b => b.id === operationalBranchId)?.isMatriz ?? false;
    const branchName = branches.find(b => b.id === operationalBranchId)?.name || 'Sucursal';
    const companyName = branding.displayName || userCompanies[activeCompanyId || '']?.name || 'Mi Comercio';

    const monthSales = sales
      .filter(s =>
        (s.branchId === operationalBranchId || (!s.branchId && isSelectedMatriz)) &&
        getSaleMonthKey(s) === pdfCutMonth
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    const completedSales = monthSales.filter(s => s.status === 'Completed');
    const refundedSales = monthSales.filter(s => s.status === 'Refunded');
    const grossRevenue = completedSales.reduce((acc, s) => acc + s.total, 0);
    const totalDiscount = completedSales.reduce((acc, s) => acc + (s.discount || 0), 0);
    const totalTax = completedSales.reduce((acc, s) => acc + (s.tax || 0), 0);
    const refundedTotal = refundedSales.reduce((acc, s) => acc + s.total, 0);

    const paymentLabels: Record<Sale['paymentMethod'], string> = { Cash: 'Efectivo', Card: 'Tarjeta', Transfer: 'Transferencia', Credit: 'Crédito (Fiado)' };
    const byPaymentMethod: Record<string, { count: number; total: number }> = {};
    completedSales.forEach(s => {
      const key = paymentLabels[s.paymentMethod];
      if (!byPaymentMethod[key]) byPaymentMethod[key] = { count: 0, total: 0 };
      byPaymentMethod[key].count += 1;
      byPaymentMethod[key].total += s.total;
    });

    // Manual cash movements (entradas/retiros de efectivo) for the same period — `time`
    // only has the hour, not the date, so only entries with the newer `createdAt` field
    // can be placed in a specific month; older entries recorded before that field existed
    // are left out rather than guessed at.
    const msToMonthKey = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const monthCashMovements = allCashTransactions
      .filter((tx): tx is typeof tx & { createdAt: number } =>
        (tx.type === 'Ingreso' || tx.type === 'Egreso') &&
        tx.createdAt !== undefined && msToMonthKey(tx.createdAt) === pdfCutMonth
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const totalIngresos = monthCashMovements.filter(t => t.type === 'Ingreso').reduce((acc, t) => acc + t.amount, 0);
    const totalEgresos = monthCashMovements.filter(t => t.type === 'Egreso').reduce((acc, t) => acc + t.amount, 0);

    // Inventory movements (surtidos + transfers) for this branch and month.
    const monthStockMovements = stockMovements
      .filter(m => m.branchId === operationalBranchId && msToMonthKey(m.createdAt) === pdfCutMonth)
      .sort((a, b) => a.createdAt - b.createdAt);
    const stockTypeLabel = (t: StockMovement['type']) =>
      t === 'surtido' ? 'Surtido' : t === 'merma' ? 'Merma/Ajuste' : t === 'transfer_in' ? 'Traspaso entrada' : 'Traspaso salida';

    const doc = new jsPDF();
    const monthLabel = getMonthLabel(pdfCutMonth);

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Corte Mensual de Ventas', 14, 18);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${companyName} — ${branchName}`, 14, 25);
    doc.text(`Periodo: ${monthLabel}`, 14, 31);
    doc.text(`Generado: ${new Date().toLocaleString()}`, 14, 37);

    autoTable(doc, {
      startY: 44,
      theme: 'grid',
      head: [['Resumen del periodo', '']],
      body: [
        ['Ventas completadas', String(completedSales.length)],
        ['Ingreso total del periodo', formatMXN(grossRevenue)],
        ['Descuentos aplicados', formatMXN(totalDiscount)],
        ['Impuestos cobrados', formatMXN(totalTax)],
        ['Ventas reembolsadas', `${refundedSales.length} (${formatMXN(refundedTotal)})`],
        ...Object.entries(byPaymentMethod).map(([label, v]) => [`  · ${label}`, `${v.count} — ${formatMXN(v.total)}`]),
        ['Entradas de efectivo (manuales)', `${monthCashMovements.filter(t => t.type === 'Ingreso').length} (${formatMXN(totalIngresos)})`],
        ['Retiros de efectivo (manuales)', `${monthCashMovements.filter(t => t.type === 'Egreso').length} (${formatMXN(totalEgresos)})`],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [51, 65, 85] },
      columnStyles: { 1: { halign: 'right' } },
    });

    const finalY = (doc as any).lastAutoTable?.finalY ?? 90;

    if (monthSales.length > 0) {
      autoTable(doc, {
        startY: finalY + 8,
        head: [['Fecha', 'Folio', 'Cliente', 'Cajero', 'Método', 'Total', 'Estado']],
        body: monthSales.map(s => [
          s.timestamp,
          s.id,
          s.customerName || 'Público General',
          s.employeeName || '—',
          paymentLabels[s.paymentMethod],
          formatMXN(s.total),
          s.status === 'Completed' ? 'Completada' : 'Reembolsada'
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 6 && data.cell.raw === 'Reembolsada') {
            data.cell.styles.textColor = [190, 30, 60];
          }
        }
      });
    } else {
      doc.setFontSize(10);
      doc.text('No hay ventas registradas para este periodo.', 14, finalY + 10);
    }

    const finalY2 = monthSales.length > 0 ? ((doc as any).lastAutoTable?.finalY ?? finalY + 20) : finalY + 16;

    if (monthCashMovements.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Entradas y Retiros de Efectivo (manuales)', 14, finalY2 + 10);
      autoTable(doc, {
        startY: finalY2 + 14,
        head: [['Hora', 'Tipo', 'Descripción', 'Monto']],
        body: monthCashMovements.map(t => [
          t.time,
          t.type === 'Ingreso' ? 'Entrada' : 'Retiro',
          t.description,
          formatMXN(t.amount)
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        columnStyles: { 3: { halign: 'right' } },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 1) {
            data.cell.styles.textColor = data.cell.raw === 'Entrada' ? [16, 122, 87] : [190, 30, 60];
          }
        }
      });
    }

    const finalY3 = monthCashMovements.length > 0 ? ((doc as any).lastAutoTable?.finalY ?? finalY2 + 20) : finalY2;

    if (monthStockMovements.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Movimientos de Inventario (surtidos y traspasos)', 14, finalY3 + 12);
      autoTable(doc, {
        startY: finalY3 + 16,
        head: [['Hora', 'Producto', 'Tipo', 'Origen/Destino', 'Unidades']],
        body: monthStockMovements.map(m => {
          const isIn = m.type === 'surtido' || m.type === 'transfer_in';
          return [
            m.timestamp,
            m.productName,
            stockTypeLabel(m.type),
            m.counterpartBranchName ? `${isIn ? 'desde' : 'hacia'} ${m.counterpartBranchName}` : '—',
            `${isIn ? '+' : '-'}${m.quantity}`
          ];
        }),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        columnStyles: { 4: { halign: 'right' } },
      });
    }

    // jsPDF's own .save() has the same web-only <a download> problem as the CSV exports
    // above — extract the base64 payload from a data URI instead and route it through the
    // same cross-platform saveFileOnDevice() helper.
    const pdfDataUri = doc.output('datauristring');
    const pdfBase64 = pdfDataUri.split('base64,')[1];
    await saveFileOnDevice(`corte_mensual_${branchName.replace(/[^a-zA-Z0-9]/g, '_')}_${pdfCutMonth}.pdf`, pdfBase64, 'application/pdf');
  };

  // Corte Diario (PDF) — same structure/detail level as handleDownloadMonthlyCutPdf above,
  // but scoped to a single day (`statsDay`) instead of a month, plus a Top 5 products table.
  // Fully independent from the monthly cut: separate state, separate function, doesn't touch it.
  const handleDownloadDailyCutPdf = async () => {
    const [{ jsPDF }, { autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    if (!statsDay) return;
    const isSelectedMatriz = branches.find(b => b.id === operationalBranchId)?.isMatriz ?? false;
    const branchName = branches.find(b => b.id === operationalBranchId)?.name || 'Sucursal';
    const companyName = branding.displayName || userCompanies[activeCompanyId || '']?.name || 'Mi Comercio';

    const daySales = sales
      .filter(s =>
        (s.branchId === operationalBranchId || (!s.branchId && isSelectedMatriz)) &&
        getSaleDayKey(s) === statsDay
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    const completedSales = daySales.filter(s => s.status === 'Completed');
    const refundedSales = daySales.filter(s => s.status === 'Refunded');
    const grossRevenue = completedSales.reduce((acc, s) => acc + s.total, 0);
    const totalDiscount = completedSales.reduce((acc, s) => acc + (s.discount || 0), 0);
    const totalTax = completedSales.reduce((acc, s) => acc + (s.tax || 0), 0);
    const refundedTotal = refundedSales.reduce((acc, s) => acc + s.total, 0);

    const paymentLabels: Record<Sale['paymentMethod'], string> = { Cash: 'Efectivo', Card: 'Tarjeta', Transfer: 'Transferencia', Credit: 'Crédito (Fiado)' };
    const byPaymentMethod: Record<string, { count: number; total: number }> = {};
    completedSales.forEach(s => {
      const key = paymentLabels[s.paymentMethod];
      if (!byPaymentMethod[key]) byPaymentMethod[key] = { count: 0, total: 0 };
      byPaymentMethod[key].count += 1;
      byPaymentMethod[key].total += s.total;
    });

    const dayCashMovements = allCashTransactions
      .filter((tx): tx is typeof tx & { createdAt: number } =>
        (tx.type === 'Ingreso' || tx.type === 'Egreso') &&
        tx.createdAt !== undefined && msToDayKey(tx.createdAt) === statsDay
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const totalIngresos = dayCashMovements.filter(t => t.type === 'Ingreso').reduce((acc, t) => acc + t.amount, 0);
    const totalEgresos = dayCashMovements.filter(t => t.type === 'Egreso').reduce((acc, t) => acc + t.amount, 0);

    const dayStockMovements = stockMovements
      .filter(m => m.branchId === operationalBranchId && msToDayKey(m.createdAt) === statsDay)
      .sort((a, b) => a.createdAt - b.createdAt);
    const stockTypeLabel = (t: StockMovement['type']) =>
      t === 'surtido' ? 'Surtido' : t === 'merma' ? 'Merma/Ajuste' : t === 'transfer_in' ? 'Traspaso entrada' : 'Traspaso salida';

    const topProducts = dailyTopProducts;

    const doc = new jsPDF();
    const dayLabel = new Date(`${statsDay}T00:00:00`).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Corte Diario de Ventas', 14, 18);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${companyName} — ${branchName}`, 14, 25);
    doc.text(`Día: ${dayLabel}`, 14, 31);
    doc.text(`Generado: ${new Date().toLocaleString()}`, 14, 37);

    autoTable(doc, {
      startY: 44,
      theme: 'grid',
      head: [['Resumen del día', '']],
      body: [
        ['Ventas completadas', String(completedSales.length)],
        ['Ingreso total del día', formatMXN(grossRevenue)],
        ['Descuentos aplicados', formatMXN(totalDiscount)],
        ['Impuestos cobrados', formatMXN(totalTax)],
        ['Ventas reembolsadas', `${refundedSales.length} (${formatMXN(refundedTotal)})`],
        ...Object.entries(byPaymentMethod).map(([label, v]) => [`  · ${label}`, `${v.count} — ${formatMXN(v.total)}`]),
        ['Entradas de efectivo (manuales)', `${dayCashMovements.filter(t => t.type === 'Ingreso').length} (${formatMXN(totalIngresos)})`],
        ['Retiros de efectivo (manuales)', `${dayCashMovements.filter(t => t.type === 'Egreso').length} (${formatMXN(totalEgresos)})`],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [51, 65, 85] },
      columnStyles: { 1: { halign: 'right' } },
    });

    const finalY = (doc as any).lastAutoTable?.finalY ?? 90;

    if (daySales.length > 0) {
      autoTable(doc, {
        startY: finalY + 8,
        head: [['Fecha', 'Folio', 'Cliente', 'Cajero', 'Método', 'Total', 'Estado']],
        body: daySales.map(s => [
          s.timestamp,
          s.id,
          s.customerName || 'Público General',
          s.employeeName || '—',
          paymentLabels[s.paymentMethod],
          formatMXN(s.total),
          s.status === 'Completed' ? 'Completada' : 'Reembolsada'
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 6 && data.cell.raw === 'Reembolsada') {
            data.cell.styles.textColor = [190, 30, 60];
          }
        }
      });
    } else {
      doc.setFontSize(10);
      doc.text('No hay ventas registradas para este día.', 14, finalY + 10);
    }

    const finalY2 = daySales.length > 0 ? ((doc as any).lastAutoTable?.finalY ?? finalY + 20) : finalY + 16;

    if (dayCashMovements.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Entradas y Retiros de Efectivo (manuales)', 14, finalY2 + 10);
      autoTable(doc, {
        startY: finalY2 + 14,
        head: [['Hora', 'Tipo', 'Descripción', 'Monto']],
        body: dayCashMovements.map(t => [
          t.time,
          t.type === 'Ingreso' ? 'Entrada' : 'Retiro',
          t.description,
          formatMXN(t.amount)
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        columnStyles: { 3: { halign: 'right' } },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 1) {
            data.cell.styles.textColor = data.cell.raw === 'Entrada' ? [16, 122, 87] : [190, 30, 60];
          }
        }
      });
    }

    const finalY3 = dayCashMovements.length > 0 ? ((doc as any).lastAutoTable?.finalY ?? finalY2 + 20) : finalY2;

    if (topProducts.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Top 5 Artículos Más Vendidos', 14, finalY3 + 12);
      autoTable(doc, {
        startY: finalY3 + 16,
        head: [['#', 'Producto', 'Unidades vendidas']],
        body: topProducts.map((p, idx) => [String(idx + 1), p.name, String(p.quantity)]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        columnStyles: { 2: { halign: 'right' } },
      });
    }

    const finalY4 = topProducts.length > 0 ? ((doc as any).lastAutoTable?.finalY ?? finalY3 + 20) : finalY3;

    if (dayStockMovements.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Movimientos de Inventario (surtidos y traspasos)', 14, finalY4 + 12);
      autoTable(doc, {
        startY: finalY4 + 16,
        head: [['Hora', 'Producto', 'Tipo', 'Origen/Destino', 'Unidades']],
        body: dayStockMovements.map(m => {
          const isIn = m.type === 'surtido' || m.type === 'transfer_in';
          return [
            m.timestamp,
            m.productName,
            stockTypeLabel(m.type),
            m.counterpartBranchName ? `${isIn ? 'desde' : 'hacia'} ${m.counterpartBranchName}` : '—',
            `${isIn ? '+' : '-'}${m.quantity}`
          ];
        }),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        columnStyles: { 4: { halign: 'right' } },
      });
    }

    const pdfDataUri = doc.output('datauristring');
    const pdfBase64 = pdfDataUri.split('base64,')[1];
    await saveFileOnDevice(`corte_diario_${branchName.replace(/[^a-zA-Z0-9]/g, '_')}_${statsDay}.pdf`, pdfBase64, 'application/pdf');
  };

  // Branch Office (Sucursal) State & Forms
  const [isBranchModalOpen, setIsBranchModalOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [branchForm, setBranchForm] = useState({
    name: '',
    address: '',
    phone: '',
    manager: '',
    isMatriz: false
  });

  // Goods Transfer between Branches (Transferencia multisuccursal y de matriz)
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferItems, setTransferItems] = useState<TransferLineItem[]>([]);
  const [transferProductSearch, setTransferProductSearch] = useState(''); // filter text for the checkbox picker below
  const [transferSourceBranchId, setTransferSourceBranchId] = useState('');
  const [transferTargetBranchId, setTransferTargetBranchId] = useState('');
  const [lastCompletedTransfer, setLastCompletedTransfer] = useState<CompletedTransfer | null>(null);

  // Merge-by-id cart handlers for the transfer line items — same idea as addToCart/
  // updateCartQty/removeFromCart, but storing just {productId, quantity} instead of a
  // product snapshot: transfers have no price to freeze, so the product is resolved live.
  const addTransferItem = (productId: string) => {
    if (!productId) return;
    setTransferItems(prev => {
      const idx = prev.findIndex(it => it.productId === productId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [...prev, { productId, quantity: 1 }];
    });
  };

  const updateTransferItemQty = (productId: string, quantity: number) => {
    const qty = Math.max(1, Math.floor(quantity) || 1);
    setTransferItems(prev => prev.map(it => it.productId === productId ? { ...it, quantity: qty } : it));
  };

  const removeTransferItem = (productId: string) => {
    setTransferItems(prev => prev.filter(it => it.productId !== productId));
  };

  // Checkbox picker list for the transfer modal: filtered by search text and by having
  // stock at the chosen origin branch, so staff doing many transfers a day (often several
  // items at once) can search instead of scrolling every catalog item.
  const transferProductOptions = useMemo(() => {
    const term = transferProductSearch.trim().toLowerCase();
    const sourceBranchId = isOwner ? transferSourceBranchId : operationalBranchId;
    return products.filter(p => {
      // Linked ("child") products have no stock of their own to transfer — only their parent pool does.
      if (p.linkedStockProductId) return false;
      if (sourceBranchId && getProductStock(p, sourceBranchId, products) <= 0) return false;
      if (!term) return true;
      return p.name.toLowerCase().includes(term) || (p.category && p.category.toLowerCase().includes(term));
    });
  }, [products, transferProductSearch, transferSourceBranchId, isOwner, operationalBranchId]);

  // The single branch flagged as Matriz, if exactly one is — deliberately undefined (not a
  // best-guess fallback) when zero or more than one branch has isMatriz set, since nothing
  // in handleSaveBranch enforces uniqueness and firestore.rules doesn't validate this field.
  // "Mover Todo a Matriz" below treats undefined as "misconfigured, refuse and explain" rather
  // than silently picking a branch.
  const matrizBranchCandidates = branches.filter(b => b.isMatriz);
  const matrizBranch = matrizBranchCandidates.length === 1 ? matrizBranchCandidates[0] : undefined;

  // Bulk version of handleOpenTransferModal below: preloads the same transfer modal with every
  // in-stock product at the active branch, at full quantity, targeting Matriz directly — instead
  // of building the transfer one product at a time. Kept separate from handleOpenTransferModal
  // (rather than adding flags to it) since the preload logic genuinely differs: every product at
  // full stock vs. one optional product at qty 1, fixed Matriz target vs. "first other branch."
  const handleOpenMoveAllToMatrizModal = () => {
    if (!canTransferStock) {
      alert('Tu cuenta no tiene permiso para transferir existencias.');
      return;
    }
    if (!operationalBranchId || !branches.some(branch => branch.id === operationalBranchId)) {
      alert('No se puede continuar: tu sucursal operativa aún no está disponible.');
      return;
    }
    if (!matrizBranch) {
      alert('No se puede continuar: debe existir exactamente una sucursal marcada como "Matriz" en Sucursales. Revisa la configuración con el Dueño.');
      return;
    }
    const itemsToMove = products
      .filter(p => !p.linkedStockProductId) // linked ("child") products have no stock of their own to move
      .map(p => ({ productId: p.id, quantity: getProductStock(p, operationalBranchId, products) }))
      .filter(it => it.quantity > 0);
    if (itemsToMove.length === 0) {
      alert('No hay stock en esta sucursal para mover a Matriz.');
      return;
    }
    setTransferItems(itemsToMove);
    setTransferProductSearch('');
    setTransferSourceBranchId(operationalBranchId);
    setTransferTargetBranchId(matrizBranch.id);
    setIsTransferModalOpen(true);
  };

  const handleOpenTransferModal = (prodId?: string) => {
    if (!canTransferStock) {
      alert('Tu cuenta no tiene permiso para transferir existencias.');
      return;
    }
    if (!operationalBranchId || !branches.some(branch => branch.id === operationalBranchId)) {
      alert('No se puede transferir: tu sucursal operativa aún no está disponible.');
      return;
    }
    // Always overwrites the cart (never merges with a leftover cart from a cancelled
    // session), same as the single-product version used to fully overwrite transferProductId.
    setTransferItems(prodId ? [{ productId: prodId, quantity: 1 }] : []);
    setTransferProductSearch('');
    // Default source to the resolved operational branch. Non-owners must never fall back to
    // Matriz/first branch when their assigned branch is absent or stale.
    if (branches.length > 0) {
      const current = branches.find(b => b.id === operationalBranchId);
      if (!current) {
        alert('No se puede transferir: tu sucursal asignada aún no está disponible.');
        return;
      }
      setTransferSourceBranchId(current.id);
      const other = branches.find(b => b.id !== current.id) || branches[0];
      setTransferTargetBranchId(other.id);
    }
    setIsTransferModalOpen(true);
  };

  const handleExecuteTransfer = async () => {
    if (!user || !activeCompanyId) {
      alert('La sesión no está activa. El traspaso NO se aplicó; vuelve a iniciar sesión e inténtalo de nuevo.');
      return;
    }
    if (firestoreConnectionState !== 'ready') {
      alert(
        firestoreConnectionState === 'checking'
          ? 'Firestore está reconectando y validando la sesión. Espera a que el indicador muestre conexión lista antes de transferir.'
          : 'No hay conexión confirmada con Firestore. El traspaso NO se aplicó; presiona "Reintentar conexión".'
      );
      return;
    }
    if (!canTransferStock) {
      alert('Tu cuenta no tiene permiso para transferir existencias.');
      return;
    }
    if (!operationalBranchId || !branches.some(branch => branch.id === operationalBranchId)) {
      alert('No se puede transferir: tu sucursal operativa aún no está disponible.');
      return;
    }
    if (transferItems.length === 0) {
      alert("Agrega al menos un producto a la transferencia.");
      return;
    }
    const sourceBranchId = isOwner ? transferSourceBranchId : operationalBranchId;
    if (!sourceBranchId || !transferTargetBranchId) {
      alert("Por favor selecciona la sucursal origen y la sucursal destino.");
      return;
    }
    if (sourceBranchId === transferTargetBranchId) {
      alert("La sucursal de origen y destino no pueden ser la misma.");
      return;
    }

    // A non-owner (Encargado, or Matriz staff) sends stock out of its own branch — the origin is
    // pinned to operationalBranchId above — to any other existing branch, Matriz or not. The
    // destination must still be a real branch of this company.
    if (!branches.some(branch => branch.id === transferTargetBranchId)) {
      alert('La sucursal destino ya no existe. El traspaso NO se aplicó; elige otro destino.');
      return;
    }

    // Aggregate by productId defensively (not just relying on the cart's merge-on-add).
    // applyStockDeltas validates the combined live delta and rejects any negative result.
    const aggregated = new Map<string, number>();
    for (const it of transferItems) {
      aggregated.set(it.productId, (aggregated.get(it.productId) || 0) + it.quantity);
    }

    const lines = Array.from(aggregated.entries()).map(([productId, quantity]) => {
      const prod = products.find(p => p.id === productId);
      return { productId, quantity, prod };
    });
    if (lines.length > 150) {
      alert('Una transferencia puede incluir hasta 150 productos distintos para conservar inventario e historial en una sola operación segura. Divide el movimiento en dos transferencias.');
      return;
    }

    const missing = lines.filter(l => !l.prod);
    if (missing.length > 0) {
      alert("Uno o más productos de la transferencia ya no existen en el catálogo.");
      return;
    }

    const insufficient = lines
      .map(l => ({ name: l.prod!.name, requested: l.quantity, available: getProductStock(l.prod!, sourceBranchId, products) }))
      .filter(l => l.requested > l.available);
    if (insufficient.length > 0) {
      const failure = describeStockOperationError(new StockUnavailableError(
        "Existencias insuficientes en la sucursal de origen:\n\n" +
        insufficient.map(x => `• ${x.name}: pides ${x.requested}, disponible ${x.available}`).join('\n')
      ));
      alert(`${failure.message}\n\nLos productos se conservan en la lista para corregir las cantidades.`);
      return;
    }

    // Timestamp-based for the same reason as sale ids — a plain 6-digit random repeats far
    // sooner than it looks, and a repeat here overwrites a past transfer record outright.
    const transferId = createDocumentId('T');
    const sourceBranch = branches.find(b => b.id === sourceBranchId);
    const targetBranch = branches.find(b => b.id === transferTargetBranchId);
    const sourceBranchName = sourceBranch?.name || 'Sucursal';
    const targetBranchName = targetBranch?.name || 'Sucursal';

    const completedTransfer: CompletedTransfer = {
      id: transferId,
      timestamp: new Date().toLocaleString(),
      createdAt: Date.now(),
      sourceBranchId,
      sourceBranchName,
      sourceBranchAddress: sourceBranch?.address || undefined,
      targetBranchId: transferTargetBranchId,
      targetBranchName,
      targetBranchAddress: targetBranch?.address || undefined,
      initiatedByName: currentUserMember?.name || user?.displayName || undefined,
      items: lines.map(l => ({ productId: l.productId, productName: l.prod!.name, quantity: l.quantity, salePrice: l.prod!.salePrice })),
    };

    try {
      // Single Firestore transaction: decrements source + increments target for every
      // product together, reading the live documents instead of a possibly-stale local copy.
      const deltas = lines.flatMap(l => [
        { productId: l.productId, branchId: sourceBranchId, qtyDelta: -l.quantity },
        { productId: l.productId, branchId: transferTargetBranchId, qtyDelta: l.quantity },
      ]);
      // Stock updates and both audit sides commit together. The 150-product guard keeps
      // the request below Firestore's 500-write ceiling (3 writes per product).
      const movements = lines.flatMap(l => [
        {
          type: 'transfer_out' as const,
          productId: l.productId,
          productName: l.prod!.name,
          quantity: l.quantity,
          branchId: sourceBranchId,
          branchName: sourceBranchName,
          counterpartBranchId: transferTargetBranchId,
          counterpartBranchName: targetBranchName,
          transferId,
          unitPrice: l.prod!.salePrice,
        },
        {
          type: 'transfer_in' as const,
          productId: l.productId,
          productName: l.prod!.name,
          quantity: l.quantity,
          branchId: transferTargetBranchId,
          branchName: targetBranchName,
          counterpartBranchId: sourceBranchId,
          counterpartBranchName: sourceBranchName,
          transferId,
          unitPrice: l.prod!.salePrice,
        },
      ]);
      await applyStockDeltas(deltas, movements);

      setIsTransferModalOpen(false);
      setTransferItems([]);
      setTransferProductSearch('');
      setLastCompletedTransfer(completedTransfer);
    } catch (err) {
      console.error("Error executing branch transfer:", err);
      const failure = describeStockOperationError(err);
      alert(`${failure.message}\n\nLos productos se conservan en la lista para reintentar.`);
    }
  };

  const handleOpenBranchModal = (branch?: Branch) => {
    if (!isOwner) {
      alert('Solo el Dueño puede administrar sucursales.');
      return;
    }
    if (branch) {
      setEditingBranch(branch);
      setBranchForm({
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        manager: branch.manager,
        isMatriz: !!branch.isMatriz
      });
    } else {
      setEditingBranch(null);
      setBranchForm({ name: '', address: '', phone: '', manager: '', isMatriz: false });
    }
    setIsBranchModalOpen(true);
  };

  const handleSaveBranch = async (e: FormEvent) => {
    e.preventDefault();
    if (!isOwner) {
      alert('Solo el Dueño puede administrar sucursales.');
      return;
    }
    if (!branchForm.name) {
      alert('El nombre de la sucursal es obligatorio.');
      return;
    }

    let updated: Branch[];
    if (editingBranch) {
      updated = branches.map(b => b.id === editingBranch.id ? {
        ...b,
        name: branchForm.name,
        address: branchForm.address,
        phone: branchForm.phone,
        manager: branchForm.manager,
        isMatriz: !!branchForm.isMatriz
      } : b);
    } else {
      const newB: Branch = {
        id: createDocumentId('B'),
        name: branchForm.name,
        address: branchForm.address,
        phone: branchForm.phone,
        manager: branchForm.manager,
        isMatriz: !!branchForm.isMatriz
      };
      updated = [...branches, newB];
    }
    try {
      await saveAllData(products, customers, sales, cashRegister, updated, suppliers);
      setIsBranchModalOpen(false);
    } catch {
      alert('No se pudo confirmar el guardado de la sucursal.');
    }
  };

  const handleDeleteBranch = async (bId: string) => {
    if (activeCompanyRole !== 'owner') {
      alert('Solo el Dueño puede eliminar sucursales.');
      return;
    }
    if (branches.length <= 1) {
      alert('Debe haber al menos una sucursal registrada en el sistema.');
      return;
    }
    if (confirm('¿Está seguro de eliminar esta sucursal?')) {
      const updated = branches.filter(b => b.id !== bId);
      const nextActive = selectedBranchId === bId ? updated[0].id : selectedBranchId;
      setSelectedBranchId(nextActive);
      if (user) safeLocalStorageSet(`logic_active_branch_${user.uid}`, nextActive);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'branches', bId));
        } catch (err) {
          throw handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/branches/${bId}`);
        }
      }
      try {
        await saveAllData(products, customers, sales, cashRegister, updated, suppliers);
      } catch {
        alert('No se pudo confirmar la eliminación de la sucursal.');
      }
    }
  };

  // Revenue shown on each branch's card in the Sucursales tab — the only screen that needs
  // every branch's totals at once. `sales` itself is now scoped to just the active branch
  // (see the branch-scoped listener above), so this fetches each other branch's completed
  // sales on demand, only while this tab is open, instead of keeping a live company-wide
  // sales listener running at all times.
  const [branchRevenueStats, setBranchRevenueStats] = useState<Record<string, { revenue: number; count: number }>>({});
  // Throttle: `branches` (a dependency below) gets a new array reference every time its
  // onSnapshot listener reconnects — common on phones that get backgrounded during a busy
  // shift — which would otherwise silently re-run this all-branches query every reconnect
  // while this tab happens to be open, on top of whoever re-opens the tab to check revenue.
  // Skip refetching if the last successful fetch was less than 10 minutes ago.
  const branchRevenueFetchedAtRef = useRef(0);
  useEffect(() => {
    if (!isOwner || activeTab !== 'branches' || !user || !activeCompanyId || branches.length === 0) return;
    if (Date.now() - branchRevenueFetchedAtRef.current < 10 * 60 * 1000) return;
    branchRevenueFetchedAtRef.current = Date.now(); // set before the fetch, not after, so two rapid re-fires can't both slip past the throttle check
    let cancelled = false;
    const compId = activeCompanyId;
    (async () => {
      try {
        const entries = await Promise.all(branches.map(async (branch) => {
          // Only count sales since the current/last shift opening. New register documents
          // keep this boundary in `openedAt`; the legacy array is a read-only fallback.
          let since = 0;
          try {
            const cashSnap = await getDoc(doc(db, 'companies', compId, 'cashRegisters', branch.id));
            const register = cashSnap.data() as CashRegister | undefined;
            since = register?.openedAt || register?.transactions?.[0]?.createdAt || 0;
          } catch { /* no register doc yet (branch never opened caja) — falls back to all-time */ }

          const salesRef = collection(db, 'companies', compId, 'sales');
          const snap = await getDocs(since
            ? query(
                salesRef,
                where('branchId', '==', branch.id),
                where('status', '==', 'Completed'),
                where('createdAt', '>=', since),
                orderBy('createdAt', 'desc')
              )
            : query(salesRef, where('branchId', '==', branch.id), where('status', '==', 'Completed'))
          );
          let revenue = 0;
          let count = 0;
          snap.forEach(d => {
            const sale = d.data() as Sale;
            if (since && (sale.createdAt ?? 0) < since) return;
            revenue += sale.total;
            count++;
          });
          return [branch.id, { revenue, count }] as const;
        }));
        if (!cancelled) setBranchRevenueStats(Object.fromEntries(entries));
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, `companies/${compId}/sales (branch revenue summary)`);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, user, activeCompanyId, branches, isOwner]);

  // Facturación (CFDI) lists invoices from every branch at once, so — same reasoning as
  // branchRevenueStats above — it keeps its own state fetched on demand instead of reading
  // the now branch-scoped `sales`. Kept deliberately separate from `sales` so marking an
  // invoice as facturado/pendiente here can never overwrite the active branch's live sales
  // state via saveAllData.
  const [invoiceSales, setInvoiceSales] = useState<Sale[]>([]);
  // Same throttle as branchRevenueFetchedAtRef above: skip refetching if someone leaves and
  // re-enters this tab within 10 minutes — avoids repeatedly paying for the whole company's
  // invoice-flagged sales just from someone checking back and forth. Keyed by what was fetched
  // (company + branch scope) so a rotated Encargado never keeps the previous branch's list.
  const invoiceSalesFetchRef = useRef<{ scope: string; at: number }>({ scope: '', at: 0 });
  useEffect(() => {
    if (!canManageInvoicing || activeTab !== 'invoicing' || !user || !activeCompanyId) return;
    // An Encargado only sees (and the rules only allow) the invoices of its own branch, so its
    // query must carry the branch filter; the owner keeps the company-wide view.
    if (!isOwner && !operationalBranchId) return;
    const scope = `${activeCompanyId}|${isOwner ? '*' : operationalBranchId}`;
    if (invoiceSalesFetchRef.current.scope !== scope) {
      setInvoiceSales([]);
    } else if (Date.now() - invoiceSalesFetchRef.current.at < 10 * 60 * 1000) {
      return;
    }
    let cancelled = false;
    const compId = activeCompanyId;
    const branchFilter = isOwner ? [] : [where('branchId', '==', operationalBranchId)];
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'companies', compId, 'sales'), where('requiresInvoice', '==', true), ...branchFilter));
        const list: Sale[] = [];
        snap.forEach(d => list.push(d.data() as Sale));
        if (!cancelled) {
          setInvoiceSales(list);
          // Only a completed fetch starts the throttle window for this scope.
          invoiceSalesFetchRef.current = { scope, at: Date.now() };
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, `companies/${compId}/sales (facturacion)`);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, user, activeCompanyId, isOwner, canManageInvoicing, operationalBranchId]);

  // Updates one sale's invoiceStatus directly (not via saveAllData, which would replace the
  // branch-scoped `sales` state) and reflects it in the locally-fetched invoiceSales list.
  const handleSetInvoiceStatus = async (saleId: string, status: 'completed' | 'pending') => {
    if (!canManageInvoicing) {
      alert('Solo el Dueño o el Encargado de la sucursal puede gestionar la facturación.');
      return;
    }
    if (!user || !activeCompanyId) return;
    // An Encargado manages only the invoices of its own branch (the rules enforce the same).
    const target = invoiceSales.find(s => s.id === saleId);
    if (!isOwner && (!target || target.branchId !== operationalBranchId)) {
      alert('Solo puedes gestionar la facturación de las ventas de tu sucursal.');
      return;
    }
    try {
      await updateDoc(doc(db, 'companies', activeCompanyId, 'sales', saleId), { invoiceStatus: status });
      setInvoiceSales(prev => prev.map(s => s.id === saleId ? { ...s, invoiceStatus: status } : s));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/sales/${saleId}`);
    }
  };

  // Supplier (Proveedor) State & Forms
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierForm, setSupplierForm] = useState({
    name: '',
    contactName: '',
    phone: '',
    email: '',
    address: '',
    category: 'General'
  });

  const [supplierProductIds, setSupplierProductIds] = useState<string[]>([]);

  const handleOpenSupplierModal = (supplier?: Supplier) => {
    if (!canManageSuppliers) {
      alert('Tu cuenta no tiene permiso para administrar proveedores.');
      return;
    }
    if (supplier) {
      setEditingSupplier(supplier);
      setSupplierForm({
        name: supplier.name,
        contactName: supplier.contactName,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        category: supplier.category
      });
      const linked = products.filter(p => p.supplierId === supplier.id).map(p => p.id);
      setSupplierProductIds(linked);
    } else {
      setEditingSupplier(null);
      setSupplierForm({ name: '', contactName: '', phone: '', email: '', address: '', category: 'General' });
      setSupplierProductIds([]);
    }
    setIsSupplierModalOpen(true);
  };

  const handleSaveSupplier = async (e: FormEvent) => {
    e.preventDefault();
    if (!canManageSuppliers) {
      alert('Tu cuenta no tiene permiso para administrar proveedores.');
      return;
    }
    if (!supplierForm.name) {
      alert('El nombre del proveedor es obligatorio.');
      return;
    }

    const targetSupplierId = editingSupplier ? editingSupplier.id : createDocumentId('prov');

    let updated: Supplier[];
    if (editingSupplier) {
      updated = suppliers.map(s => s.id === editingSupplier.id ? {
        ...s,
        name: supplierForm.name,
        contactName: supplierForm.contactName,
        phone: supplierForm.phone,
        email: supplierForm.email,
        address: supplierForm.address,
        category: supplierForm.category
      } : s);
    } else {
      const newS: Supplier = {
        id: targetSupplierId,
        name: supplierForm.name,
        contactName: supplierForm.contactName,
        phone: supplierForm.phone,
        email: supplierForm.email,
        address: supplierForm.address,
        category: supplierForm.category
      };
      updated = [...suppliers, newS];
    }

    // Link/unlink products in Firestore through the shared catalogue save path.
    const processedProducts = products.map(p => {
      const shouldBeLinked = supplierProductIds.includes(p.id);
      if (shouldBeLinked) {
        return { ...p, supplierId: targetSupplierId };
      } else if (p.supplierId === targetSupplierId) {
        const updatedProd = { ...p };
        delete updatedProd.supplierId;
        return updatedProd;
      }
      return p;
    });

    try {
      await saveAllData(processedProducts, customers, sales, cashRegister, branches, updated);
      setIsSupplierModalOpen(false);
    } catch {
      alert('No se pudo confirmar el guardado del proveedor.');
    }
  };

  const handleDeleteSupplier = async (sId: string) => {
    if (!canManageSuppliers) {
      alert('Tu cuenta no tiene permiso para eliminar proveedores.');
      return;
    }
    if (confirm('¿Está seguro de eliminar este proveedor? Los artículos correspondientes se desvincularán del proveedor.')) {
      const updated = suppliers.filter(s => s.id !== sId);
      const updatedProducts = products.map(p => p.supplierId === sId ? { ...p, supplierId: undefined } : p);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'suppliers', sId));
        } catch (err) {
          throw handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/suppliers/${sId}`);
        }
      }
      try {
        await saveAllData(updatedProducts, customers, sales, cashRegister, branches, updated);
      } catch {
        alert('No se pudo confirmar la eliminación del proveedor.');
      }
    }
  };

  // Supplier Supply Order (Surtido / Compra) State & Handler
  const [isRestockOpen, setIsRestockOpen] = useState(false);
  const [isSavingRestock, setIsSavingRestock] = useState(false);
  const [restockForm, setRestockForm] = useState({
    supplierId: '',
    productId: '',
    qty: '',
    cost: ''
  });

  const handleOpenRestock = (supplierId?: string, productId?: string) => {
    if (!canRestock) {
      alert('Tu cuenta no tiene permiso para reabastecer productos.');
      return;
    }
    setRestockForm({
      supplierId: supplierId || '',
      productId: productId || '',
      qty: '',
      cost: ''
    });
    setIsRestockOpen(true);
  };

  const handleSaveRestock = async (e: FormEvent) => {
    e.preventDefault();
    if (!canRestock) {
      alert('Tu cuenta no tiene permiso para reabastecer productos.');
      return;
    }
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    const { supplierId, productId, qty, cost } = restockForm;
    if (!supplierId || !productId || !qty || !cost) {
      alert('Por favor complete todos los campos para procesar el reabastecimiento.');
      return;
    }
    const q = parseInt(qty);
    const c = parseFloat(cost);
    if (isNaN(q) || q <= 0 || isNaN(c) || c <= 0) {
      alert('Ingrese una cantidad y costo unitario válidos.');
      return;
    }

    const prod = products.find(p => p.id === productId);
    const supp = suppliers.find(s => s.id === supplierId);
    if (!prod || !supp) return;

    // Same centralized safety net as handleQuickAddStock: a linked ("child") product has no
    // real stock of its own. The Reabastecimiento product picker already excludes children, but
    // a couple of shortcuts (dashboard low-stock alerts, the supplier tab's "Surtir Productos"
    // button) can still pass one in directly — redirect to the real pool instead of spending
    // real money on a restock that would leave actual sellable stock unchanged.
    let targetProd = prod;
    let effectiveQ = q;
    if (prod.linkedStockProductId && prod.stockConsumptionFactor) {
      const parent = products.find(p => p.id === prod.linkedStockProductId);
      if (!parent) {
        alert('No se pudo encontrar el producto padre de este artículo. No se puede reabastecer.');
        return;
      }
      if (!confirm(`"${prod.name}" usa el stock de "${parent.name}". Esto agregará ${(q * prod.stockConsumptionFactor).toFixed(2)} unidades al fondo de "${parent.name}" en su lugar. ¿Continuar?`)) {
        return;
      }
      targetProd = parent;
      effectiveQ = q * prod.stockConsumptionFactor;
    }

    const totalExpense = q * c;

    // Optional confirmation if register is low on cash
    if (cashRegister.currentCash < totalExpense) {
      if (!confirm(`La caja actual tiene ${formatMXN(cashRegister.currentCash)} y el gasto total es de ${formatMXN(totalExpense)}. ¿Desea proceder con saldo negativo en caja?`)) {
        return;
      }
    }

    setIsSavingRestock(true);
    try {
      await commitRestockAtomically({
        targetProduct: targetProd,
        displayProduct: prod,
        supplier: supp,
        supplierId,
        purchasedQuantity: q,
        stockQuantity: effectiveQ,
        unitCost: c,
        branchId: operationalBranchId,
      });
      setIsRestockOpen(false);
      const stockMsg = targetProd.id === prod.id
        ? `Se añadieron ${q} unidades de ${prod.name}`
        : `Se añadieron ${effectiveQ.toFixed(2)} unidades al fondo de ${targetProd.name} (por ${q}x ${prod.name})`;
      alert(`¡Reabastecimiento procesado! ${stockMsg} y se generó un egreso de ${formatMXN(totalExpense)} en Caja.`);
    } catch (error) {
      console.error('Error saving restock:', error);
      alert(`${describeCheckoutError(error).message}\n\nEl surtido y el egreso no se aplicaron.`);
    } finally {
      setIsSavingRestock(false);
    }
  };


  // Customer State & Forms
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [custForm, setCustForm] = useState({
    name: '',
    phone: '',
    email: ''
  });

  const handleOpenCustomerModal = (customer?: Customer) => {
    if (customer) {
      setEditingCustomer(customer);
      setCustForm({ name: customer.name, phone: customer.phone, email: customer.email });
    } else {
      setEditingCustomer(null);
      setCustForm({ name: '', phone: '', email: '' });
    }
    setIsCustomerModalOpen(true);
  };

  const handleSaveCustomer = async (e: FormEvent) => {
    e.preventDefault();
    if (!custForm.name) return;

    let updatedCustomers: Customer[];
    if (editingCustomer) {
      updatedCustomers = customers.map(c => c.id === editingCustomer.id ? {
        ...c,
        name: custForm.name,
        phone: custForm.phone,
        email: custForm.email
      } : c);
    } else {
      const newCust: Customer = {
        id: createDocumentId('C'),
        name: custForm.name,
        phone: custForm.phone,
        email: custForm.email,
        unpaidBalance: 0,
        registeredDate: new Date().toISOString().substring(0, 10)
      };
      updatedCustomers = [...customers, newCust];
    }

    try {
      await saveAllData(products, updatedCustomers, sales, cashRegister);
      setIsCustomerModalOpen(false);
    } catch {
      alert('No se pudo confirmar el guardado del cliente.');
    }
  };

  const handlePayBalance = async (custId: string, amountToPay: number) => {
    if (amountToPay <= 0) return;
    const target = customers.find(c => c.id === custId);
    if (!target) return;

    if (target.unpaidBalance <= 0) {
      alert('Este cliente no tiene saldo pendiente.');
      return;
    }

    try {
      const actualPayAmount = await applyCustomerPaymentAtomically(custId, amountToPay);
      if (actualPayAmount <= 0) {
        alert('Este cliente ya no tiene saldo pendiente.');
        return;
      }
      alert(`Abono aplicado con éxito: ${formatMXN(actualPayAmount)}`);
    } catch (error) {
      console.error('Error applying customer payment:', error);
      alert(`${describeCheckoutError(error).message}\n\nEl abono no se aplicó.`);
    }
  };

  // Refund Venta. Sale status, returned stock, customer credit and cash ledger are one
  // Firestore transaction, so a retry cannot duplicate a refund or leave partial state.
  const handleRefundSale = async (saleId: string) => {
    if (!canRefundSales) {
      alert('Solo el Propietario o el Encargado de la sucursal puede reembolsar ventas.');
      return;
    }
    if (!canViewSalesHistory) {
      alert('Tu cuenta no tiene permiso para consultar el historial de ventas.');
      return;
    }
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return;
    // An Encargado refunds only sales of its own branch (the rules enforce the same limit);
    // the owner may refund in any branch.
    if (!isOwner && sale.branchId !== operationalBranchId) {
      alert('Solo puedes reembolsar ventas de tu sucursal asignada.');
      return;
    }
    if (!confirm('¿Está seguro de que desea REEMBOLSAR esta venta? Se restituirá el inventario.')) return;

    try {
      await refundSaleAtomically(sale);
      alert('Venta reembolsada con éxito.');
    } catch (error) {
      console.error('Error refunding sale:', error);
      const failure = describeCheckoutError(error);
      alert(`${failure.message}\n\nNo se aplicó ningún cambio; puedes intentarlo nuevamente.`);
    }
  };

  // Cash Management State
  const [cashFlowAmount, setCashFlowAmount] = useState('');
  const [cashFlowDesc, setCashFlowDesc] = useState('');
  const [historySubTab, setHistorySubTab] = useState<'sales' | 'cashLog' | 'inventory'>('sales');
  // The sub-tab buttons are hidden without access, but the selection can outlive it (shared
  // device, a grant revoked live): never render a view the current user cannot open.
  const visibleHistorySubTab =
    (historySubTab === 'cashLog' && !canViewCashAudit) || (historySubTab === 'inventory' && !canViewInventoryLog)
      ? 'sales'
      : historySubTab;

  // Statistics month scope: 'all' shows all-time totals, otherwise a specific "YYYY-MM"
  const [statsMonth, setStatsMonth] = useState<string>(getCurrentMonthKey());
  // Corte Diario: a specific "YYYY-MM-DD" day, or '' to fall back to statsMonth/histórico.
  // Takes priority over statsMonth in the `stats` useMemo below whenever it's set.
  const [statsDay, setStatsDay] = useState<string>('');
  // Month scope for the "Corte Mensual (PDF)" export in Historial/Caja
  const [pdfCutMonth, setPdfCutMonth] = useState<string>(getCurrentMonthKey());
  const [isHistoricalLoading, setIsHistoricalLoading] = useState(false);
  const [historicalLimitWarning, setHistoricalLimitWarning] = useState(false);
  const historicalLoadLimit = 2000;

  // Keep the real-time streams operational and small. Older months (or all history) are
  // fetched once only when a report screen requests them, then merged by document id.
  useEffect(() => {
    if (!user || !activeCompanyId || !operationalBranchId) return;
    if (activeTab !== 'analytics' && activeTab !== 'history') return;
    // A plain cashier only sees today's live stream; it never triggers period or legacy reads.
    if (salesWindow === 'today') return;

    const requestedKey = activeTab === 'history'
      ? pdfCutMonth
      : statsDay || statsMonth;
    if (!requestedKey) return;
    const range = requestedKey === 'all'
      ? null
      : requestedKey.length === 10
        ? getDayRange(requestedKey)
        : getMonthRange(requestedKey);
    if (requestedKey !== 'all' && !range) return;
    // Old sales with no branchId can only be read by the owner (see the legacy leg below).
    const readsLegacySales = isOwner && (branches.find(branch => branch.id === operationalBranchId)?.isMatriz ?? false);
    setHistoricalLimitWarning(false);
    // The current-month live stream is enough for migrated branches. Matriz still performs
    // the compatibility read because old sales with no branchId cannot be expressed as a query.
    if (requestedKey === getCurrentMonthKey() && activeTab === 'history' && !readsLegacySales) return;

    let cancelled = false;
    const compId = activeCompanyId;
    const branchId = operationalBranchId;
    setIsHistoricalLoading(true);

    const withPeriod = (collectionRef: ReturnType<typeof collection>, branchScoped: boolean) => {
      const filters = branchScoped ? [where('branchId', '==', branchId)] : [];
      if (range) {
        return query(
          collectionRef,
          ...filters,
          where('createdAt', '>=', range.start),
          where('createdAt', '<', range.end),
          orderBy('createdAt', 'desc'),
          limit(historicalLoadLimit + 1)
        );
      }
      return query(collectionRef, ...filters, orderBy('createdAt', 'desc'), limit(historicalLoadLimit + 1));
    };

    void (async () => {
      try {
        // Inventory and cash legs are only read for whoever can see those views (the live
        // listeners above follow the same gates).
        const [salesSnapshot, stockSnapshot, cashSnapshot, legacySalesSnapshot] = await Promise.all([
          getDocs(withPeriod(collection(db, 'companies', compId, 'sales'), true)),
          canViewInventoryLog ? getDocs(withPeriod(collection(db, 'companies', compId, 'stockMovements'), true)) : Promise.resolve(null),
          canViewCashAudit ? getDocs(withPeriod(collection(db, 'companies', compId, 'cashRegisters', branchId, 'transactions'), false)) : Promise.resolve(null),
          // Firestore cannot query for a missing field. This intentionally expensive fallback
          // runs only on-demand for Matriz reports until the migration script is executed.
          // Owner only: the rules never let a non-owner list sales without its branch filter, and
          // a denied leg would fail this whole Promise.all (a Matriz Encargado got no reports).
          readsLegacySales ? getDocs(query(collection(db, 'companies', compId, 'sales'), limit(historicalLoadLimit + 1))) : Promise.resolve(null),
        ]);
        if (cancelled) return;

        const wasLimited = salesSnapshot.size > historicalLoadLimit
          || Boolean(stockSnapshot && stockSnapshot.size > historicalLoadLimit)
          || Boolean(cashSnapshot && cashSnapshot.size > historicalLoadLimit)
          || Boolean(legacySalesSnapshot && legacySalesSnapshot.size > historicalLoadLimit);
        setHistoricalLimitWarning(wasLimited);

        const loadedSales = salesSnapshot.docs.slice(0, historicalLoadLimit).map(snapshot => snapshot.data() as Sale);
        if (legacySalesSnapshot) {
          legacySalesSnapshot.docs.slice(0, historicalLoadLimit).forEach(snapshot => {
            const sale = snapshot.data() as Sale;
            const createdAt = sale.createdAt ?? 0;
            const inRange = !range || (createdAt >= range.start && createdAt < range.end) || (
              !sale.createdAt && (requestedKey === 'all' || getSaleMonthKey(sale) === requestedKey || getSaleDayKey(sale) === requestedKey)
            );
            if (!sale.branchId && inRange) loadedSales.push(sale);
          });
        }
        setSales(previous => {
          const merged = new Map<string, Sale>(previous.map(sale => [sale.id, sale]));
          loadedSales.forEach(sale => merged.set(sale.id, sale));
          return Array.from(merged.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        });

        if (stockSnapshot) {
          setStockMovements(previous => {
            const merged = new Map<string, StockMovement>(previous.map(movement => [movement.id, movement]));
            stockSnapshot.docs.slice(0, historicalLoadLimit).forEach(snapshot => {
              const movement = snapshot.data() as StockMovement;
              merged.set(movement.id, movement);
            });
            return Array.from(merged.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
          });
        }

        if (cashSnapshot) {
          setCashTransactions(previous => {
            const merged = new Map<string, CashTransaction>(previous.filter(entry => entry.id).map(entry => [entry.id!, entry]));
            cashSnapshot.docs.slice(0, historicalLoadLimit).forEach(snapshot => merged.set(snapshot.id, { id: snapshot.id, ...snapshot.data() } as CashTransaction));
            return Array.from(merged.values()).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
          });
        }
      } catch (error) {
        console.error('Historical period load failed:', error);
      } finally {
        if (!cancelled) setIsHistoricalLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeTab, user, activeCompanyId, operationalBranchId, pdfCutMonth, statsMonth, statsDay, branches, salesWindow, isOwner, canViewInventoryLog, canViewCashAudit]);
  
  const handleRecordCashFlow = async (type: 'Ingreso' | 'Egreso') => {
    if (!canCloseCash) {
      alert('Tu cuenta no tiene permiso para registrar movimientos o cerrar la caja.');
      return;
    }
    if (!operationalBranchId) {
      alert('No hay una sucursal operativa confirmada.');
      return;
    }
    const val = parseFloat(cashFlowAmount);
    if (isNaN(val) || val <= 0) {
      alert('Ingresa un valor válido.');
      return;
    }
    if (!cashFlowDesc) {
      alert('Ingresa una descripción.');
      return;
    }

    const valueSigned = type === 'Ingreso' ? val : -val;
    try {
      await applyCashDelta(operationalBranchId, valueSigned, [{
        type,
        amount: val,
        description: cashFlowDesc,
        time: new Date().toLocaleTimeString(),
        createdAt: Date.now(),
        branchId: operationalBranchId
      }]);
      setCashFlowAmount('');
      setCashFlowDesc('');
      alert(`Registro de ${type} en caja de ${formatMXN(val)} guardado.`);
    } catch (err) {
      console.error('Error recording cash flow:', err);
      alert(`No se pudo guardar el ${type.toLowerCase()} en caja. Verifica tu conexión e intenta de nuevo.`);
    }
  };


  // Sales/transactions scoped to the currently selected branch — shared by the POS
  // terminal's quick history, the Historial/Caja tab, and the analytics below, so
  // switching branches consistently filters everything derived from `sales`.
  const isSelectedBranchMatriz = useMemo(() => branches.find(b => b.id === operationalBranchId)?.isMatriz ?? false, [branches, operationalBranchId]);
  const branchScopedSales = useMemo(() =>
    sales.filter(s => s.branchId === operationalBranchId || (!s.branchId && isSelectedBranchMatriz)),
    [sales, operationalBranchId, isSelectedBranchMatriz]
  );
  // `cashRegister` is now the selected branch's own document (see the dedicated
  // onSnapshot effect above), so every entry in it already belongs to this branch —
  // no filtering needed here anymore, unlike branchScopedSales above.
  const branchScopedTransactions = allCashTransactions;
  const currentShiftTransactions = useMemo(() => {
    if (cashRegister.currentShiftId) {
      return allCashTransactions.filter(transaction => transaction.shiftId === cashRegister.currentShiftId);
    }
    return allCashTransactions.filter(transaction =>
      transaction.createdAt !== undefined && transaction.createdAt >= (cashRegister.openedAt || 0)
    );
  }, [allCashTransactions, cashRegister.currentShiftId, cashRegister.openedAt]);

  // Inventory movements (surtidos + transfers) that touch the active branch.
  const branchScopedStockMovements = useMemo(
    () => stockMovements.filter(m => m.branchId === operationalBranchId),
    [stockMovements, operationalBranchId]
  );

  // 'Transferencia' entries carry a unit count in `amount`, not a currency value —
  // formatMXN would misleadingly render "5" as "$5.00 MXN".
  const formatTxAmount = (tx: CashRegister['transactions'][number]) =>
    tx.type === 'Transferencia' ? `${tx.amount} unid.` : formatMXN(tx.amount);

  // Analytics helper metrics
  const availableStatsMonths = useMemo(() => {
    const keys = new Set(getAvailableMonths(sales));
    const now = new Date();
    for (let offset = 0; offset < 60; offset++) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      keys.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
    }
    return Array.from(keys).sort((a, b) => b.localeCompare(a));
  }, [sales]);

  const stats = useMemo(() => {
    const isSelectedMatriz = branches.find(b => b.id === operationalBranchId)?.isMatriz ?? false;
    // Corte Diario: statsDay takes priority over statsMonth whenever it's set. Leaving it
    // empty ('') keeps the existing month/histórico behavior completely unchanged.
    const activeSales = sales.filter(s =>
      s.status === 'Completed' &&
      (s.branchId === operationalBranchId || (!s.branchId && isSelectedMatriz)) &&
      (statsDay ? getSaleDayKey(s) === statsDay : (statsMonth === 'all' || getSaleMonthKey(s) === statsMonth))
    );
    const grossRevenue = activeSales.reduce((acc, s) => acc + s.total, 0);
    const cost = activeSales.reduce((acc, s) => {
      // For each sale item, calculate cost
      return acc + s.items.reduce((itemCost, item) => {
        const prod = products.find(p => p.id === item.productId);
        const singleCost = prod ? prod.costPrice : 0;
        return itemCost + (singleCost * item.quantity);
      }, 0);
    }, 0);
    
    // Profit margin calculation
    const profit = Math.max(0, grossRevenue - cost);
    const averageTicket = activeSales.length > 0 ? grossRevenue / activeSales.length : 0;
    
    // Low stocks counts
    // Linked ("child") products are excluded here — their derived stock is just the same pool
    // viewed at a different scale, so counting the pool AND every child as separate "low stock"
    // alerts would inflate this number for one real shortage. The pool itself still shows up
    // when it crosses its own threshold, which is the actionable signal.
    const lowStockItems = products.filter(p => !p.linkedStockProductId && getProductStock(p, operationalBranchId, products) <= p.minStock);

    // Group sales by Category
    const categoryPopularity: { [key: string]: number } = {};
    activeSales.forEach(s => {
      s.items.forEach(item => {
        const p = products.find(prod => prod.id === item.productId);
        const cat = p ? p.category : 'Otros';
        categoryPopularity[cat] = (categoryPopularity[cat] || 0) + item.quantity;
      });
    });

    return { grossRevenue, profit, averageTicket, lowStockItems, categoryPopularity, activeSalesCount: activeSales.length, activeSales };
  }, [sales, products, operationalBranchId, branches, statsMonth, statsDay]);

  // Corte Diario — manual cash movements (Ingreso/Egreso) for the selected day, from the
  // currently-displayed branch's register. Only computed when a day is actually selected.
  const dailyCashFlow = useMemo(() => {
    if (!statsDay) return null;
    const movements = allCashTransactions.filter((tx): tx is typeof tx & { createdAt: number } =>
      (tx.type === 'Ingreso' || tx.type === 'Egreso') &&
      tx.createdAt !== undefined && msToDayKey(tx.createdAt) === statsDay
    );
    const totalIngresos = movements.filter(t => t.type === 'Ingreso').reduce((acc, t) => acc + t.amount, 0);
    const totalEgresos = movements.filter(t => t.type === 'Egreso').reduce((acc, t) => acc + t.amount, 0);
    return { movements, totalIngresos, totalEgresos, net: totalIngresos - totalEgresos };
  }, [allCashTransactions, statsDay]);

  // Corte Diario — top 5 best-selling products for the selected day (by units), from
  // stats.activeSales (already day-filtered above). Day-only per product decision; the
  // month/histórico view doesn't have an equivalent card.
  const dailyTopProducts = useMemo(() => {
    if (!statsDay) return [];
    const totals = new Map<string, { productId: string; name: string; quantity: number }>();
    stats.activeSales.forEach(s => {
      s.items.forEach(item => {
        const existing = totals.get(item.productId);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          totals.set(item.productId, { productId: item.productId, name: item.name, quantity: item.quantity });
        }
      });
    });
    return Array.from(totals.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  }, [stats.activeSales, statsDay]);

  // Inline style for active nav buttons — adapts to brand palette
  const navActiveStyle: React.CSSProperties = {
    backgroundColor: `color-mix(in srgb, var(--brand-primary) 14%, white)`,
    color: `var(--brand-primary)`,
    borderColor: `color-mix(in srgb, var(--brand-primary) 22%, transparent)`,
  };
  const navBaseClass = 'flex flex-row items-center space-x-3 px-4 py-2.5 rounded-xl transition duration-150 font-semibold text-sm w-full cursor-pointer flex-shrink-0';
  const navInactiveClass = `${navBaseClass} text-slate-600 hover:bg-slate-50 hover:text-slate-900`;
  const navActiveClass = `${navBaseClass} shadow-sm border`;

  // Hard login gate: nothing below this point (catalog, sales, sucursales, estadisticas,
  // caja, etc.) mounts until Firebase Auth resolves to a real user. There used to be a
  // "Modo Local" that ran the whole POS off localStorage without any login. Historical
  // devices may still contain those old keys, so gating the entire render on `user` prevents
  // a logged-out session from surfacing operational data left by an older application build.
  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex items-center gap-2 text-slate-400 text-sm font-bold">
          <ShoppingCart className="w-5 h-5 animate-pulse" />
          Conectando...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-5 text-left animate-slide-up">
          <div className="text-center pb-2.5 border-b border-slate-100 space-y-2">
            <div className="w-12 h-12 mx-auto bg-indigo-50 rounded-2xl flex items-center justify-center">
              <ShoppingCart className="w-6 h-6 text-indigo-500" />
            </div>
            <div>
              <h3 className="font-extrabold text-base text-slate-800">TAMALES CASTILLO POS</h3>
              <p className="text-[9px] text-slate-400 -mt-0.5 font-semibold tracking-wide">powered by XAMU POS</p>
              <p className="text-[10px] text-slate-400 mt-0.5">Ingresa con tu número de empleado o cuenta de propietario.</p>
            </div>
          </div>

          <div className="space-y-4">
            {/* EMPLOYEE CODE LOGIN */}
            <form onSubmit={handleCredentialSignIn} className="space-y-3.5">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-left">
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Ingresa el <strong className="text-slate-700">Código de Comercio</strong> y tu <strong className="text-slate-700">Número de Empleado</strong> asignado por tu encargado.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] text-slate-500 font-bold block">Código de Comercio *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: comp_123456"
                  value={authCompanyId}
                  onChange={(e) => setAuthCompanyId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-bold text-slate-700 placeholder-slate-300 text-xs font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] text-slate-500 font-bold block">Número de Empleado *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: 1001"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-bold text-slate-700 placeholder-slate-300 text-xs font-mono"
                />
              </div>

              <button
                type="submit"
                disabled={isSignInLoading}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition select-none tracking-wide text-center disabled:opacity-50 mt-1 flex items-center justify-center gap-1.5"
              >
                {isSignInLoading ? 'Verificando...' : <>Entrar al Sistema <Key className="w-3.5 h-3.5" /></>}
              </button>
            </form>

            {authError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[11px] text-red-700 font-semibold whitespace-pre-line">
                {authError}
              </div>
            )}

            {/* SEPARATOR */}
            <div className="relative flex py-1 items-center">
              <div className="flex-grow border-t border-slate-200"></div>
              <span className="flex-shrink mx-3 text-[9px] text-slate-400 font-extrabold uppercase tracking-wide bg-white px-1">propietarios</span>
              <div className="flex-grow border-t border-slate-200"></div>
            </div>

            {/* GOOGLE OPTION - owners only */}
            <button
              type="button"
              onClick={async () => {
                setAuthError('');
                try {
                  await signInWithGoogle();
                } catch (err: any) {
                  console.error(err);
                  setAuthError("Error al conectar con Google: " + (err.message || String(err)));
                }
              }}
              className="w-full py-2.5 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl shadow-sm cursor-pointer transition flex items-center justify-center gap-2 select-none border border-slate-200"
            >
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <span>Acceso con Google (Propietario)</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="logic-main-container" className="min-h-screen bg-slate-50 flex flex-col font-sans">
      
      {/* Top Brand Banner */}
      <header className="text-white shadow-md px-3 lg:px-6 py-3 lg:py-4 flex justify-between items-center z-10 border-b relative gap-2"
        style={{ backgroundColor: 'var(--brand-dark)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
        <div className="flex items-center gap-2 lg:gap-3 shrink min-w-0 flex-1">
          <button
            className="lg:hidden p-1.5 rounded-xl transition flex-shrink-0"
            style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 55%, black)', border: '1px solid color-mix(in srgb, var(--brand-primary) 30%, transparent)', color: 'color-mix(in srgb, var(--brand-primary) 70%, white)' }}
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            <Menu className="w-5 h-5" />
          </button>
          {branding.logoUrl ? (
            <img src={branding.logoUrl} alt="Logo" className="w-9 h-9 lg:w-10 lg:h-10 rounded-xl object-contain hidden md:block flex-shrink-0 bg-white/10 p-0.5" />
          ) : (
            <div className="p-2 lg:p-2.5 rounded-xl shadow-inner hidden md:block flex-shrink-0"
              style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 55%, black)', border: '1px solid color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
              <ShoppingCart id="logic-banner-logo" className="w-5 h-5 lg:w-6 lg:h-6 animate-pulse" style={{ color: 'color-mix(in srgb, var(--brand-primary) 60%, white)' } as React.CSSProperties} />
            </div>
          )}
          <div className="flex flex-col min-w-0 shrink">
            <div className="flex items-center space-x-2">
              <span className="text-lg lg:text-xl font-black tracking-wider truncate" style={{ color: 'var(--brand-primary)' }}>
                {branding.displayName || (user && activeCompanyId ? userCompanies[activeCompanyId]?.name : 'POS Cloud')}
              </span>
              {user && activeCompanyId ? (
                <span className="hidden md:inline-block px-2 py-0.5 text-white font-bold text-[10px] rounded-full shadow-sm uppercase shrink-0" style={{ backgroundColor: 'var(--brand-primary)' }}>
                  {userCompanies[activeCompanyId]?.role === 'owner' ? 'Propietario' : userCompanies[activeCompanyId]?.role === 'admin' ? 'Admin' : 'Empleado'}
                </span>
              ) : (
                <span className="hidden md:inline-block px-2 py-0.5 text-white font-bold text-[10px] rounded-full shadow-sm shrink-0" style={{ backgroundColor: 'var(--brand-primary)' }}>TAMALES CASTILLO POS</span>
              )}
            </div>
             {/* Active Branch Switching Selector in Header */}
            {branches.length > 0 && (
              <div className="mt-1 flex items-center space-x-1 overflow-hidden shrink min-w-0">
                <span className="text-[9px] lg:text-[10px] font-extrabold uppercase tracking-wider hidden sm:block" style={{ color: 'color-mix(in srgb, var(--brand-primary) 65%, white)' }}>Sucursal:</span>
                {isBranchLocked ? (
                  <span className="border rounded px-1.5 lg:px-2 py-0.5 text-[9px] lg:text-[10px] font-bold truncate text-white" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 80%, black)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
                    <MapPin className="w-2.5 h-2.5 inline mr-0.5" />{branches.find(b => b.id === operationalBranchId)?.name || 'Sucursal no asignada'}
                  </span>
                ) : (
                  <select
                    value={selectedBranchId}
                    onChange={(e) => handleSelectBranch(e.target.value)}
                    className="text-white text-[9px] lg:text-[10px] font-bold rounded px-1 lg:px-1.5 py-0.5 outline-none cursor-pointer transition truncate max-w-[100px] sm:max-w-xs border"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 70%, black)', borderColor: 'color-mix(in srgb, var(--brand-primary) 35%, transparent)' }}
                  >
                    {branches.map(b => (
                      <option key={b.id} value={b.id} className="bg-slate-900 text-white font-semibold">{b.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        </div>
        
        {/* Real-time Clock and Auth on right */}
        <div className="flex items-center space-x-2 lg:space-x-4 flex-shrink-0">
          {firestoreConnectionState !== 'ready' && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span
                className={`px-2 lg:px-2.5 py-1 rounded-md border font-bold text-[10px] lg:text-xs text-white flex items-center gap-1 ${
                  firestoreConnectionState === 'checking'
                    ? 'bg-amber-500 border-amber-300 animate-pulse'
                    : 'bg-rose-600 border-rose-400'
                }`}
                title="El cobro y las transferencias se habilitan únicamente después de confirmar acceso al servidor de Firestore."
              >
                <AlertCircle className="w-3 h-3" />
                <span>
                  {firestoreConnectionState === 'checking'
                    ? 'Reconectando…'
                    : firestoreConnectionState === 'offline'
                    ? 'Sin conexión'
                    : 'Revisar acceso'}
                </span>
              </span>
              {firestoreConnectionState !== 'checking' && (
                <button
                  type="button"
                  onClick={() => connectionController.retry()}
                  className="px-2 py-1 text-[10px] lg:text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-md shadow-sm transition flex items-center gap-1 cursor-pointer"
                  title="Reintentar verificación de conexión con el servidor"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  <span>Reintentar conexión</span>
                </button>
              )}
            </div>
          )}
          <div className="hidden lg:flex items-center space-x-2 text-sm font-medium opacity-90">
            <span className="px-2.5 py-1 rounded-md border font-bold text-white text-xs" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 60%, transparent)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
              Caja Registradora: {formatMXN(displayedCash)}
            </span>
            <span className="text-xs px-2 py-1 rounded border font-semibold text-white" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 50%, transparent)', borderColor: 'color-mix(in srgb, var(--brand-primary) 25%, transparent)' }}>
              {nowStr}
            </span>
          </div>

          {/* Authentication Status UI — `user` is always set here: the login gate above
              already returned early otherwise. */}
          <div className="flex items-center space-x-1.5 lg:space-x-2.5 px-2 lg:px-3 py-1 lg:py-1.5 rounded-xl border" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 45%, transparent)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
            {user.photoURL ? (
              <img src={user.photoURL} alt={user.displayName || ''} className="hidden sm:block w-5 h-5 lg:w-6 lg:h-6 rounded-full border-2" style={{ borderColor: 'var(--brand-primary)' }} referrerPolicy="no-referrer" />
            ) : (
              <div className="hidden sm:flex w-5 h-5 lg:w-6 lg:h-6 rounded-full font-black text-xs text-center leading-6 text-white items-center justify-center" style={{ backgroundColor: 'var(--brand-primary)' }}>
                {user.displayName ? user.displayName[0].toUpperCase() : 'U'}
              </div>
            )}
            <div className="hidden xl:block text-left">
              <p className="text-[11px] font-bold text-white leading-tight truncate max-w-[120px]">{user.displayName || 'Comerciante'}</p>
              <p className="text-[9px] leading-none truncate max-w-[120px]" style={{ color: 'color-mix(in srgb, var(--brand-primary) 70%, white)' }}>{user.email}</p>
            </div>
            <div className="flex space-x-1 lg:space-x-1.5 flex-shrink-0">
              <button
                onClick={() => { safeLocalStorageRemove(`logic_active_company_${user.uid}`); setActiveCompanyId(null); }}
                className="text-[9px] lg:text-[10px] text-white font-bold px-2 lg:px-2.5 py-1 rounded-lg cursor-pointer transition select-none border"
                style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 70%, black)', borderColor: 'color-mix(in srgb, var(--brand-primary) 35%, transparent)' }}
                title="Cambiar de comercio / empresa"
              >
                <span className="hidden sm:inline">Empresas</span>
                <span className="sm:hidden">Emp</span>
              </button>
              <button
                onClick={() => signOut(auth)}
                className="text-[9px] lg:text-[10px] bg-red-700 hover:bg-red-600 border border-red-600 text-white font-bold px-2 lg:px-2.5 py-1 rounded-lg cursor-pointer transition select-none"
              >
                Salir
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Alert Warn: Unclosed cash register from previous day */}
      {showOvernightWarning && (
        <div className="bg-gradient-to-r from-amber-500 via-amber-600 to-red-600 text-white px-6 py-3 shadow-md flex justify-between items-center space-x-4 animate-pulse z-10 border-b border-amber-500/10">
          <div className="flex items-center space-x-3 text-xs leading-relaxed">
            <AlertCircle className="w-5 h-5 flex-shrink-0 animate-bounce text-white" />
            <div>
              <span className="font-black text-xs block tracking-wider uppercase opacity-90">Alerta Contable</span>
              El sistema detectó que <strong className="underline">no se realizó el corte de caja</strong> el día anterior (<span className="font-mono">{warningOperationalDate || 'ayer'}</span>). Por favor, realiza el corte antes de registrar ventas hoy para mantener la contabilidad exacta y organizada.
            </div>
          </div>
          <div className="flex items-center space-x-2.5 flex-shrink-0">
            {canCloseCash && <button
              onClick={() => {
                setRealCashInput(cashRegister.currentCash.toString());
                setIsCorteModalOpen(true);
              }}
              className="bg-white text-amber-900 hover:bg-amber-50 font-extrabold text-[10px] px-3.5 py-1.5 rounded-lg shadow-sm cursor-pointer border border-amber-200 transition uppercase tracking-wider inline-flex items-center gap-1"
            >
              Hacer Corte Ahora <FileText className="w-3 h-3" />
            </button>}
            <button
              onClick={() => setShowOvernightWarning(false)}
              className="text-white hover:text-slate-100 font-bold p-1 hover:bg-white/10 rounded-full cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Alert Warn: Cash register closed — needs opening before selling */}
      {!cashRegister.isOpen && showClosedCajaBanner && (
        <div className="bg-gradient-to-r from-amber-500 via-amber-600 to-red-600 text-white px-6 py-3 shadow-md flex justify-between items-center space-x-4 animate-pulse z-10 border-b border-amber-500/10">
          <div className="flex items-center space-x-3 text-xs leading-relaxed">
            <AlertCircle className="w-5 h-5 flex-shrink-0 animate-bounce text-white" />
            <div>
              <span className="font-black text-xs block tracking-wider uppercase opacity-90">Caja Cerrada</span>
              La caja registradora está <strong className="underline">cerrada</strong>. Por favor, realiza la apertura de caja antes de registrar ventas.
            </div>
          </div>
          <div className="flex items-center space-x-2.5 flex-shrink-0">
             <button
               onClick={() => {
                 setOpeningCashInput('500');
                 setIsOpeningCajaModalOpen(true);
               }}
               className="bg-white text-amber-900 hover:bg-amber-50 font-extrabold text-[10px] px-3.5 py-1.5 rounded-lg shadow-sm cursor-pointer border border-amber-200 transition uppercase tracking-wider inline-flex items-center gap-1"
             >
               Abrir Caja Ahora <Rocket className="w-3 h-3" />
             </button>
            <button
              onClick={() => setShowClosedCajaBanner(false)}
              className="text-white hover:text-slate-100 font-bold p-1 hover:bg-white/10 rounded-full cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Panel Content */}
      <div className="flex-grow flex flex-col lg:flex-row relative">
        
        {/* Mobile Menu Overlay */}
        {isMobileMenuOpen && (
          <div 
            className="lg:hidden fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        {/* Sleek Sidebar Navigation */}
        <nav className={`${
          isMobileMenuOpen ? 'flex' : 'hidden'
        } lg:flex flex-col bg-white border-r border-slate-200/80 w-64 justify-start py-6 space-y-1.5 px-2 overflow-y-auto scrollbar-none absolute lg:relative z-50 h-full lg:h-auto shadow-2xl lg:shadow-none top-0 left-0 transition-transform`}>
          
          {[
            { id: 'pos',        label: 'Terminal POS',       icon: <ShoppingCart className="w-5 h-5" /> },
            { id: 'products',   label: 'Inventario',          icon: <Package className="w-5 h-5" /> },
            { id: 'customers',  label: 'Clientes',            icon: <Users className="w-5 h-5" /> },
          ].map(({ id, label, icon }) => (
            <button key={id} id={`nav-${id}`}
              onClick={() => { setActiveTab(id as typeof activeTab); setIsMobileMenuOpen(false); }}
              className={activeTab === id ? navActiveClass : navInactiveClass}
              style={activeTab === id ? navActiveStyle : {}}
            >
              {icon}<span className="mt-1 md:mt-0">{label}</span>
            </button>
          ))}

          {[
            { id: 'branches',   label: 'Sucursales',          icon: <Store className="w-5 h-5" /> },
            { id: 'suppliers',  label: 'Proveedores',         icon: <Truck className="w-5 h-5" /> },
            { id: 'invoicing',  label: 'Facturación',         icon: <FileText className="w-5 h-5" /> },
            { id: 'history',    label: 'Historial / Caja',    icon: <Receipt className="w-5 h-5" /> },
            { id: 'analytics',  label: 'Estadísticas',        icon: <BarChart3 className="w-5 h-5" /> },
          ].filter(item =>
            item.id === 'branches' ? isOwner
              : item.id === 'suppliers' ? canViewSuppliers
                : item.id === 'invoicing' ? canManageInvoicing
                  : item.id === 'analytics' ? canViewAnalytics
                    : canViewSalesHistory
          ).map(({ id, label, icon }) => (
            <button key={id} id={`nav-${id}`}
              onClick={() => { setActiveTab(id as typeof activeTab); setIsMobileMenuOpen(false); }}
              className={activeTab === id ? navActiveClass : navInactiveClass}
              style={activeTab === id ? navActiveStyle : {}}
            >
              {icon}<span className="mt-1 md:mt-0">{label}</span>
            </button>
          ))}

          {isOwner && (
            <button id="nav-settings"
              onClick={() => { if (!isOwner) return; setActiveTab('settings'); setIsMobileMenuOpen(false); }}
              className={activeTab === 'settings' ? navActiveClass : navInactiveClass}
              style={activeTab === 'settings' ? navActiveStyle : {}}
            >
              <Settings className="w-5 h-5" /><span className="mt-1 md:mt-0">Mi Empresa / Equipo</span>
            </button>
          )}
        </nav>

        {/* Dynamic Frame Screen Views */}
        <main className="flex-grow p-4 md:p-6 select-none overflow-y-auto max-w-7xl mx-auto w-full">
          {historicalLimitWarning && (activeTab === 'history' || activeTab === 'analytics') && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900 break-words">
              Este período supera 2,000 registros por tipo. Se muestran los 2,000 más recientes para evitar que el equipo se bloquee; selecciona un mes o día más específico para obtener un reporte completo.
            </div>
          )}
          
          {/* SCREEN: TERMINAL POS */}
          {activeTab === 'pos' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              
              {/* Product Catalog Column */}
              <div className="lg:col-span-8 space-y-4">
                
                {/* Switcher selector in POS (Catalog vs History vs Cashier) */}
                <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setPosSubTab('catalog')}
                    className={`flex-1 py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                      posSubTab === 'catalog'
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <ShoppingCart className="w-3.5 h-3.5 inline mr-1" /><span>Catálogo</span>
                  </button>
                  {canViewSalesHistory && <button
                    type="button"
                    onClick={() => { if (canViewSalesHistory) setPosSubTab('history'); }}
                    className={`flex-1 py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                      posSubTab === 'history'
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <History className="w-3.5 h-3.5" /><span>Historial ({branchScopedSales.length})</span>
                  </button>}
                  <button
                    type="button"
                    onClick={() => setPosSubTab('cashier')}
                    className={`flex-1 py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                      posSubTab === 'cashier'
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <DollarSign className="w-3.5 h-3.5 inline mr-1" /><span>Caja y Corte {!cashRegister.isOpen && <X className="w-3 h-3 inline text-red-500" />}</span>
                  </button>
                </div>

                {posSubTab === 'catalog' && (
                  <>
                    {/* Search & Category Header */}
                    <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1 min-w-0">
                          <Search className="absolute left-3.5 top-3.5 w-5 h-5 text-slate-400" />
                          <input
                            type="text"
                            placeholder="Pesquisa por nombre de producto o categoría..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-sm font-medium transition"
                          />
                        </div>
                        {/* View toggle: cards vs compact list — helps a lot once the
                            catalog has many products, since list rows pack far more of
                            them on screen without scrolling. */}
                        <div className="flex bg-slate-100 border border-slate-200 rounded-xl p-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => { setPosCatalogView('grid'); safeLocalStorageSet('logic_pos_catalog_view', 'grid'); }}
                            className={`p-2.5 rounded-lg transition cursor-pointer ${posCatalogView === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                            title="Vista de tarjetas"
                            aria-label="Vista de tarjetas"
                          >
                            <LayoutGrid className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setPosCatalogView('list'); safeLocalStorageSet('logic_pos_catalog_view', 'list'); }}
                            className={`p-2.5 rounded-lg transition cursor-pointer ${posCatalogView === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                            title="Vista de lista"
                            aria-label="Vista de lista"
                          >
                            <List className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
     
                      {/* Horizontal Category Slider */}
                      <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-none">
                        <Filter className="w-4 h-4 text-slate-500 flex-shrink-0" />
                        {uniqueCategories.map(cat => (
                          <button
                            key={cat}
                            onClick={() => setSelectedCategory(cat)}
                            className={`px-3.5 py-1.5 text-xs font-bold rounded-full cursor-pointer transition flex-shrink-0 border ${
                              selectedCategory === cat
                                ? 'text-white shadow-sm'
                                : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
                            }`}
                            style={selectedCategory === cat ? { backgroundColor: 'var(--brand-primary)', borderColor: 'var(--brand-primary)' } : undefined}
                          >
                            {cat}
                          </button>
                        ))}
                      </div>
                    </div>
     
                    {/* Main Product Catalog Grid */}
                    {filteredProducts.length === 0 ? (
                      <div className="bg-white border rounded-xl p-12 text-center text-slate-500">
                        {outOfStockHiddenCount > 0 ? (
                          <>
                            <p className="font-medium text-lg">Sin productos disponibles para vender</p>
                            <p className="text-sm text-slate-400 mt-1">
                              {outOfStockHiddenCount} producto{outOfStockHiddenCount > 1 ? 's están ocultos' : ' está oculto'} por no tener stock en esta sucursal. Agrega stock (Surtir o Transferir) para venderlos.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="font-medium text-lg">No se encontraron productos coincidentes o vacíos</p>
                            <button
                              onClick={() => handleOpenProductModal()}
                              className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl shadow cursor-pointer transition"
                            >
                              + Crear Nuevo Producto
                            </button>
                          </>
                        )}
                      </div>
                    ) : posCatalogView === 'grid' ? (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        {filteredProducts.map(prod => {
                          const inCartItem = cart.find(ci => ci.product.id === prod.id);
                          return (
                            <div
                               key={prod.id}
                               onClick={() => addToCart(prod)}
                               className="bg-white border border-slate-200/80 hover:border-indigo-500 rounded-2xl p-3 sm:p-4 flex flex-col justify-between cursor-pointer transition-all hover:shadow-md relative group duration-150"
                            >
                              {/* Stock Badges */}
                              <div className="flex flex-wrap gap-1 justify-between items-start mb-2">
                                <span className="text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200/50 truncate max-w-[60%]">
                                  {prod.category}
                                </span>
                                <span className={`text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full shrink-0 ${
                                  getProductStock(prod, operationalBranchId, products) <= prod.minStock
                                    ? 'bg-amber-100 text-amber-700 font-extrabold animate-pulse'
                                    : 'bg-slate-50 text-slate-600'
                                }`}>
                                  Stock: {getProductStock(prod, operationalBranchId, products)}
                                </span>
                              </div>

                              <div className="h-24 rounded-xl mb-3 flex items-center justify-center transition group-hover:opacity-80"
                                style={{ backgroundColor: 'color-mix(in srgb, var(--brand-primary) 8%, white)', border: '1px solid color-mix(in srgb, var(--brand-primary) 15%, transparent)' }}>
                                <Package className="w-10 h-10 group-hover:scale-110 transition duration-200" style={{ color: 'color-mix(in srgb, var(--brand-primary) 50%, #94a3b8)' }} />
                              </div>

                              <div>
                                <h4 className="font-bold text-slate-800 text-sm truncate">{prod.name}</h4>
                                <div className="flex justify-between items-center mt-2.5 gap-2">
                                  <span className="text-[13px] sm:text-base font-extrabold text-indigo-600 truncate flex-1 min-w-0" title={formatMXN(prod.salePrice)}>{formatMXN(prod.salePrice)}</span>

                                  {inCartItem ? (
                                    <span className="bg-indigo-600 text-white w-6 h-6 shrink-0 rounded-full flex items-center justify-center font-bold text-xs shadow-sm">
                                      {inCartItem.quantity}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400 group-hover:text-indigo-600 shrink-0 bg-slate-50 group-hover:bg-indigo-50 p-1.5 rounded-full duration-150 border border-transparent group-hover:border-indigo-100">
                                      <Plus className="w-4 h-4" />
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      /* Compact list — same tap-to-add behavior as the cards, but one
                         product per row so far more of the catalog fits without scrolling. */
                      <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
                        {filteredProducts.map(prod => {
                          const inCartItem = cart.find(ci => ci.product.id === prod.id);
                          const low = getProductStock(prod, operationalBranchId, products) <= prod.minStock;
                          return (
                            <div
                              key={prod.id}
                              onClick={() => addToCart(prod)}
                              className="flex items-center gap-3 p-3 hover:bg-slate-50 active:bg-indigo-50/60 cursor-pointer transition"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h4 className="font-bold text-slate-800 text-sm truncate">{prod.name}</h4>
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 shrink-0">{prod.category}</span>
                                </div>
                                <div className="flex items-center gap-3 text-[11px] mt-0.5">
                                  <span className="font-extrabold" style={{ color: 'var(--brand-primary)' }}>{formatMXN(prod.salePrice)}</span>
                                  <span className={`font-bold ${low ? 'text-amber-600' : 'text-slate-500'}`}>
                                    {low && <AlertCircle className="w-3 h-3 inline mr-0.5" />}Stock: {getProductStock(prod, operationalBranchId, products)}
                                  </span>
                                </div>
                              </div>
                              {inCartItem ? (
                                <span className="bg-indigo-600 text-white w-7 h-7 shrink-0 rounded-full flex items-center justify-center font-bold text-xs shadow-sm">
                                  {inCartItem.quantity}
                                </span>
                              ) : (
                                <span className="text-indigo-600 shrink-0 bg-indigo-50 p-2 rounded-full border border-indigo-100">
                                  <Plus className="w-4 h-4" />
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {posSubTab === 'history' && canViewSalesHistory && (
                  /* Terminal-Integrated Sales History */
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
                    <div className="flex justify-between items-center border-b pb-3">
                      <div>
                        <h3 className="font-extrabold text-slate-800 text-sm">Ventas del Turno / Recientes</h3>
                        <p className="text-[10px] text-slate-500">Últimas transacciones del comercio actual registradas en tu terminal POS.</p>
                      </div>
                    </div>

                    {branchScopedSales.length === 0 ? (
                      <div className="border border-dashed rounded-2xl p-10 text-center text-slate-400">
                        <Receipt className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                        <p className="text-xs font-bold">Sin transacciones registradas hoy.</p>
                      </div>
                    ) : (
                      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                        {branchScopedSales.map(sale => (
                          <div key={sale.id} className="border border-slate-200 rounded-xl p-3 bg-slate-50 hover:bg-white transition duration-150 space-y-2 overflow-hidden">
                            <div className="flex justify-between items-center gap-2 text-xs">
                              <span className="font-black text-slate-800 bg-slate-100 border px-2 py-0.5 rounded text-[10px] truncate min-w-0">{sale.id}</span>
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">{sale.timestamp}</span>
                            </div>

                            <div className="flex justify-between items-start gap-2">
                              <div className="text-xs flex-1 min-w-0">
                                <p className="font-bold text-slate-700">Artículos ({sale.items.length}):</p>
                                <p className="text-[10px] text-slate-500 truncate">
                                  {sale.items.map(it => `${it.quantity}x ${it.name}`).join(', ')}
                                </p>
                                {sale.customerName && (
                                  <p className="text-[10px] text-indigo-600 font-semibold mt-1 truncate flex items-center gap-1"><Tag className="w-2.5 h-2.5 shrink-0" /> Cliente: {sale.customerName}</p>
                                )}
                                {sale.employeeName && (
                                  <p className="text-[10px] text-slate-500 font-semibold mt-0.5 truncate flex items-center gap-1"><UserIcon className="w-2.5 h-2.5 shrink-0" /> Atendido por: {sale.employeeName}</p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-extrabold text-indigo-700 text-xs">{formatMXN(sale.total)}</p>
                                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full border block mt-1 ${
                                  sale.status === 'Completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'
                                }`}>
                                  {sale.status === 'Completed' ? 'Exitosa' : 'Reembolsada'}
                                </span>
                              </div>
                            </div>

                            {/* Options block for completed terminal sale */}
                            <div className="pt-2 border-t border-slate-100 flex justify-between items-center gap-2">
                              {sale.status === 'Completed' ? (
                                canRefundSales ? (
                                  <button
                                    type="button"
                                    onClick={() => handleRefundSale(sale.id)}
                                    className="text-[9px] font-black text-pink-600 hover:text-white hover:bg-pink-600 border border-pink-100 px-2 py-1 rounded transition cursor-pointer"
                                  >
                                    Reembolsar Venta
                                  </button>
                                ) : (
                                  <span className="text-[9px] font-medium text-slate-300">Solo Propietario/Admin puede reembolsar</span>
                                )
                              ) : (
                                <span className="text-[9px] font-medium text-slate-300">Venta Cancelada</span>
                              )}

                              <button
                                type="button"
                                onClick={() => {
                                  setLastCompletedSale(sale);
                                  setLastReceivedAmount(0); // non-cash popup
                                }}
                                className="text-[9px] font-black bg-indigo-50 border border-indigo-100 hover:bg-indigo-600 hover:text-white px-2.5 py-1 rounded text-indigo-600 transition cursor-pointer inline-flex items-center gap-1"
                              >
                                <Download className="w-2.5 h-2.5" /> Compartir / Recibo
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {posSubTab === 'cashier' && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-5">
                    <div className="flex justify-between items-center border-b pb-3">
                      <div>
                        <h3 className="font-extrabold text-slate-800 text-sm">Control Administrativo de Caja</h3>
                        <p className="text-[10px] text-slate-400">Verifica montos físicos, realiza entradas y egresos, y haz cortes.</p>
                      </div>
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider inline-flex items-center gap-1 ${
                        cashRegister.isOpen ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-rose-100 text-rose-800 border border-rose-200 animate-pulse'
                      }`}>
                        Estado: {cashRegister.isOpen ? <>Caja Abierta <Check className="w-3 h-3" /></> : <>Caja Cerrada <X className="w-3 h-3" /></>}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-2 gap-4">
                      <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl space-y-1 text-left">
                        <span className="text-[9px] text-slate-400 font-black uppercase">Saldo Inicial de Turno</span>
                        <p className="text-sm font-black text-slate-700 font-mono">{formatMXN(cashRegister.initialCash)}</p>
                      </div>
                      <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-2xl space-y-1 text-left">
                        <span className="text-[9px] text-indigo-500 font-black uppercase">Efectivo Sugerido (Sistema)</span>
                        <p className="text-sm font-black text-indigo-700 font-mono">{formatMXN(displayedCash)}</p>
                      </div>
                    </div>

                    <div className="flex justify-center pt-1">
                      {cashRegister.isOpen && canCloseCash ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRealCashInput(cashRegister.currentCash.toString());
                            setIsCorteModalOpen(true);
                          }}
                          className="w-full py-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition uppercase tracking-wider inline-flex items-center justify-center gap-1.5"
                        >
                          Corte de Caja (Cierre de Turno) <FileText className="w-3.5 h-3.5" />
                        </button>
                      ) : !cashRegister.isOpen ? (
                        <button
                          type="button"
                          onClick={() => {
                            setOpeningCashInput('500');
                            setIsOpeningCajaModalOpen(true);
                          }}
                          className="w-full py-3 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition uppercase tracking-wider animate-pulse inline-flex items-center justify-center gap-1.5"
                        >
                          Realizar Apertura de Caja <Rocket className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <p className="text-center text-[10px] text-slate-400 font-bold">Tu cuenta no tiene permiso para cerrar caja.</p>
                      )}
                    </div>

                    {cashRegister.isOpen && canCloseCash && (
                      <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl space-y-4 text-left">
                        <h4 className="font-extrabold text-slate-700 text-xs flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" /> Movimiento de Caja Manual</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1/2">
                            <label className="text-[10px] text-slate-400 font-bold block">Concepto o Descripción *</label>
                            <input
                              type="text"
                              placeholder="Ej: Pago de gas, Propina"
                              value={cashFlowDesc}
                              onChange={e => setCashFlowDesc(e.target.value)}
                              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none font-bold text-xs"
                            />
                          </div>
                          <div className="space-y-1/2">
                            <label className="text-[10px] text-slate-400 font-bold block">Monto ($ MXN) *</label>
                            <div className="flex gap-2">
                              <input
                                type="number"
                                placeholder="0.00"
                                value={cashFlowAmount}
                                onChange={e => setCashFlowAmount(e.target.value)}
                                className="w-1/2 bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none font-bold text-xs"
                              />
                              <button
                                type="button"
                                onClick={() => handleRecordCashFlow('Ingreso')}
                                className="w-1/4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[10px] rounded-xl text-center shadow cursor-pointer transition uppercase"
                              >
                                entrada
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRecordCashFlow('Egreso')}
                                className="w-1/4 bg-rose-600 hover:bg-rose-700 text-white font-black text-[10px] rounded-xl text-center shadow cursor-pointer transition uppercase"
                              >
                                salida
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* The shift ledger is only streamed for whoever can audit cash (see the
                        ledger listener); without it this list would always read "empty". */}
                    {canViewCashAudit && (
                    <div className="space-y-2 text-left">
                      <h4 className="font-extrabold text-xs text-slate-600 flex items-center gap-1"><History className="w-3.5 h-3.5" /> Transacciones del Turno</h4>
                      <div className="border border-slate-200 rounded-2xl bg-white divide-y divide-slate-100 max-h-48 overflow-y-auto pr-1">
                        {currentShiftTransactions.slice().reverse().map((tx, idx) => (
                          <div key={idx} className="p-3 flex justify-between items-center text-xs">
                            <div className="space-y-0.5">
                              <p className="font-extrabold text-slate-700">{tx.description}</p>
                              <p className="text-[9px] text-slate-400 font-mono italic">{tx.time}</p>
                            </div>
                            <span className={`font-mono font-black text-[10px] px-2 py-0.5 rounded ${
                              tx.type === 'Ingreso' || tx.type === 'Venta' ? 'bg-emerald-50 text-emerald-800' : tx.type === 'Transferencia' ? 'bg-sky-50 text-sky-700' : 'bg-rose-50 text-rose-800'
                            }`}>
                              {tx.type === 'Egreso' ? '-' : tx.type === 'Transferencia' ? '' : '+'}{formatTxAmount(tx)}
                            </span>
                          </div>
                        ))}
                        {currentShiftTransactions.length === 0 && (
                          <p className="text-center text-[10px] text-slate-400 py-6">Ninguna transacción registrada en la sesión actual.</p>
                        )}
                      </div>
                    </div>
                    )}
                  </div>
                )}
              </div>
 
              {/* Dynamic Drawer Basket (Right Column) */}
              <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200/80 shadow-md p-4 flex flex-col justify-between h-[max-content] min-h-[500px]">
                <div>
                  <div className="flex justify-between items-center pb-3 border-b mb-4">
                    <div className="flex items-center space-x-2">
                      <ShoppingCart className="w-5 h-5 text-indigo-600" />
                      <h3 className="font-extrabold text-slate-800 text-base">Carrito de Ventas</h3>
                    </div>
                    {cart.length > 0 && (
                      <button 
                        onClick={() => setCart([])} 
                        className="text-xs text-slate-400 hover:text-indigo-600 font-semibold cursor-pointer"
                      >
                        Vaciar
                      </button>
                    )}
                  </div>
 
                  {/* Customer Selector inside Cart */}
                  <div className="bg-indigo-50/10 p-3 rounded-xl border border-dashed border-indigo-200/55 mb-4">
                    {selectedCustomer ? (
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-xs text-slate-400 uppercase tracking-widest font-extrabold">Cliente Seleccionado</p>
                          <p className="font-extrabold text-sm text-slate-800 mt-0.5">{selectedCustomer.name}</p>
                          <p className="text-xs text-slate-500">Saldo "Fiado" Pendiente: <span className="font-bold text-purple-600">{formatMXN(selectedCustomer.unpaidBalance)}</span></p>
                        </div>
                        <button 
                          onClick={() => setSelectedCustomer(null)}
                          className="p-1 text-slate-400 hover:text-purple-600 bg-white shadow rounded-full"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 block">Asignar Cliente a la Venta</label>
                        <select 
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'new') handleOpenCustomerModal();
                            else {
                              const found = customers.find(c => c.id === val);
                              if (found) setSelectedCustomer(found);
                            }
                          }}
                          value={selectedCustomer ? selectedCustomer.id : ''}
                          className="w-full text-xs font-medium bg-white border border-slate-200 rounded-lg p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value="">-- Cliente Casual --</option>
                          {customers.map(c => (
                            <option key={c.id} value={c.id}>{c.name} {c.phone ? `(${c.phone})` : ''}</option>
                          ))}
                          <option value="new" className="text-purple-600 font-bold">+ Registrar Nuevo Cliente...</option>
                        </select>
                      </div>
                    )}
                  </div>
 
                  {/* Cart Items List */}
                  {cart.length === 0 ? (
                    <div className="text-center py-12 text-slate-400 space-y-3">
                      <div className="w-12 h-12 rounded-full bg-slate-50 border flex items-center justify-center mx-auto text-slate-300">
                        <ShoppingCart className="w-6 h-6" />
                      </div>
                      <p className="text-xs font-medium">Pulsa sobre los artículos del catálogo de la izquierda para llenar el carrito.</p>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1">
                      {cart.map(item => (
                        <div key={item.product.id} className="flex justify-between items-center bg-slate-50 border p-2 rounded-xl border-slate-100">
                          <div className="truncate mr-2 flex-grow">
                            <p className="text-xs font-bold text-slate-800 truncate">{item.product.name}</p>
                            <p className="text-[10px] text-slate-400">{formatMXN(item.product.salePrice)} unitario</p>
                          </div>
                          <div className="flex items-center space-x-2 flex-shrink-0">
                            <button 
                              onClick={() => updateCartQty(item.product.id, -1)}
                              className="w-6 h-6 rounded bg-white hover:bg-slate-200 border flex items-center justify-center text-slate-600 text-xs font-bold cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="text-xs font-bold text-slate-800 w-4 text-center">{item.quantity}</span>
                            <button 
                              onClick={() => updateCartQty(item.product.id, 1)}
                              className="w-6 h-6 rounded bg-white hover:bg-slate-200 border flex items-center justify-center text-slate-600 text-xs font-bold cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                            <button 
                              onClick={() => removeFromCart(item.product.id)}
                              className="text-slate-300 hover:text-indigo-600 ml-1 cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
 
                  {/* Cart Discount Tool Panel */}
                  {cart.length > 0 && canApplyDiscount && (
                    <div className="mt-4 pt-4 border-t border-slate-100 space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-500 flex items-center">
                          <Tag className="w-3.5 h-3.5 mr-1 text-slate-400" />
                          Aplicar Descuento
                        </span>
                        <div className="flex border rounded-lg overflow-hidden text-[10px]">
                          <button
                            onClick={() => { setDiscountType('pct'); setDiscountVal(0); }}
                            className={`px-2 py-1 font-bold ${discountType !== 'pct' ? 'bg-slate-100 text-slate-600' : 'text-white'}`}
                            style={discountType === 'pct' ? { backgroundColor: 'var(--brand-primary)' } : undefined}
                          >
                            %
                          </button>
                          <button
                            onClick={() => { setDiscountType('val'); setDiscountVal(0); }}
                            className={`px-2 py-1 font-bold ${discountType !== 'val' ? 'bg-slate-100 text-slate-600' : 'text-white'}`}
                            style={discountType === 'val' ? { backgroundColor: 'var(--brand-primary)' } : undefined}
                          >
                            $MXN
                          </button>
                        </div>
                      </div>
                      <div className="relative">
                        <input 
                          type="number" 
                          min="0"
                          value={discountVal || ''}
                          onChange={(e) => {
                            if (!canApplyDiscount) {
                              setDiscountVal(0);
                              alert('Tu cuenta no tiene permiso para aplicar descuentos.');
                              return;
                            }
                            setDiscountVal(Math.max(0, parseFloat(e.target.value) || 0));
                          }}
                          placeholder={discountType === 'pct' ? "Porcentaje de descuento (ej. 10)" : "Valor del descuento (ej 5)"}
                          className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:border-indigo-400"
                        />
                      </div>
                    </div>
                  )}
                </div>
 
                {/* Totals & Submit Section */}
                {cart.length > 0 && (
                  <div className="mt-6 pt-4 border-t border-slate-200 space-y-3">
                    <div className="space-y-1.5 text-xs text-slate-500">
                      <div className="flex justify-between">
                        <span>Subtotal:</span>
                        <span className="font-bold text-slate-700">{formatMXN(cartValues.subtotal)}</span>
                      </div>
                      {cartValues.calculatedDiscount > 0 && (
                        <div className="flex justify-between text-emerald-600">
                          <span>Descuento Aplicado:</span>
                          <span className="font-bold">-{formatMXN(cartValues.calculatedDiscount)}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span>Impuesto ({taxPct}%):</span>
                        <span className="font-bold text-slate-700">{formatMXN(cartValues.taxValue)}</span>
                      </div>
                      <div className="flex justify-between text-base font-extrabold text-slate-800 pt-1.5 border-t border-slate-100">
                        <span>Total neto:</span>
                        <span className="text-indigo-600 font-extrabold">{formatMXN(cartValues.total)}</span>
                      </div>
                    </div>
 
                    {/* Quick Payment Selection */}
                    <div className="flex items-center space-x-2 py-1">
                      <input 
                        type="checkbox" 
                        id="requiresInvoice" 
                        checked={requiresInvoice} 
                        onChange={(e) => {
                          setRequiresInvoice(e.target.checked);
                          setTaxPct(e.target.checked ? 16 : 0);
                        }}
                        className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500 cursor-pointer"
                      />
                      <label htmlFor="requiresInvoice" className="text-[10px] font-bold text-slate-600 cursor-pointer">
                        Requiere Factura (+16% IVA)
                      </label>
                    </div>
                    <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 space-y-2">
                      <label className="text-[10px] font-extrabold text-slate-400 block uppercase tracking-wider">Método de Pago</label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {[
                          { id: 'Cash', label: 'Efectivo' },
                          { id: 'Card', label: 'T. Déb/Cr' },
                          { id: 'Transfer', label: 'Transf.' },
                          { id: 'Credit', label: 'Fiado' }
                        ].map(pm => (
                          <button
                            key={pm.id}
                            onClick={() => setPaymentMethod(pm.id as any)}
                            className={`py-1.5 px-0.5 text-[9px] font-bold rounded-lg border cursor-pointer transition text-center ${
                              paymentMethod === pm.id 
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' 
                                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                            }`}
                          >
                            {pm.label}
                          </button>
                        ))}
                      </div>
 
                      {/* Cash Drawer Calculator Helper */}
                      {paymentMethod === 'Cash' && (
                        <div className="pt-2 border-t border-slate-200/50 flex items-center justify-between">
                          <label className="text-[10px] text-slate-500 font-bold">Efectivo Recibido:</label>
                          <div className="flex items-center space-x-1 w-2/3">
                            <span className="text-xs font-bold text-slate-400">$</span>
                            <input 
                              type="number"
                              placeholder="Ej: 20"
                              value={receivedCashAmount}
                              onChange={e => setReceivedCashAmount(e.target.value)}
                              className="w-full bg-white border border-slate-200 text-xs rounded p-1 outline-none text-right font-bold"
                            />
                          </div>
                        </div>
                      )}
 
                      {/* Cash Change Math */}
                      {paymentMethod === 'Cash' && parseFloat(receivedCashAmount) > cartValues.total && (
                        <div className="flex justify-between text-[11px] font-bold bg-amber-50 text-amber-800 p-1.5 rounded border border-amber-100">
                          <span>Cambio para Cliente:</span>
                          <span>{formatMXN(parseFloat(receivedCashAmount) - cartValues.total)}</span>
                        </div>
                      )}

                      {/* Card or Transfer transaction folio input */}
                      {(paymentMethod === 'Card' || paymentMethod === 'Transfer') && (
                        <div className="pt-2 border-t border-slate-200/50 space-y-1 text-left">
                          <label className="text-[10px] text-slate-500 font-bold block uppercase tracking-wider">Número de Folio *</label>
                          <input 
                            type="text"
                            required
                            placeholder="Ej: FOL-99238A"
                            value={folioNumber}
                            onChange={e => setFolioNumber(e.target.value)}
                            className="w-full bg-white border border-slate-200 text-xs rounded-lg p-2.5 outline-none font-bold text-slate-700 placeholder-slate-400 focus:border-indigo-500"
                          />
                          <p className="text-[9px] text-slate-400 font-medium">Por favor registre la clave o identificador de la transacción.</p>
                        </div>
                      )}
                    </div>
 
                    <button
                      onClick={completeTransaction}
                      disabled={isProcessingSale || firestoreConnectionState !== 'ready' || !cashRegister.isOpen}
                      className={`w-full py-3.5 text-white font-extrabold text-center rounded-xl shadow-lg transition-all duration-150 flex items-center justify-center space-x-2 ${isProcessingSale || firestoreConnectionState !== 'ready' || !cashRegister.isOpen ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:shadow-xl'}`}
                      style={{ backgroundColor: 'var(--brand-primary)', filter: 'none' }}
                      onMouseEnter={e => { if (!isProcessingSale && firestoreConnectionState === 'ready' && cashRegister.isOpen) e.currentTarget.style.filter = 'brightness(1.1)'; }}
                      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}
                    >
                      <CircleDollarSign className="w-5 h-5 text-white animate-spin" style={{ animationDuration: isProcessingSale ? '0.8s' : '4s' }} />
                      <span>{isProcessingSale ? 'GUARDANDO / CONFIRMANDO...' : firestoreConnectionState === 'checking' ? 'RECONECTANDO FIRESTORE...' : !cashRegister.isOpen ? 'ABRE CAJA PARA COBRAR' : `PROCESAR VENTA (${formatMXN(cartValues.total)})`}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}

          {/* SCREEN: INVENTARIO DE PRODUCTOS */}
          {activeTab === 'products' && (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-800">Catálogo de Productos ({products.length})</h2>
                  <p className="text-sm text-slate-500 mt-1">Monitorea el catálogo, ajusta precios y controla el stock por sucursal.</p>
                </div>
                <div className="flex gap-2 self-start flex-wrap items-center">
                  {/* View toggle: cards vs compact list */}
                  <div className="flex bg-slate-100 border border-slate-200 rounded-xl p-0.5">
                    <button
                      onClick={() => { setInventoryView('grid'); safeLocalStorageSet('logic_inventory_view', 'grid'); }}
                      className={`p-2 rounded-lg transition cursor-pointer ${inventoryView === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                      title="Vista de tarjetas"
                      aria-label="Vista de tarjetas"
                    >
                      <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { setInventoryView('list'); safeLocalStorageSet('logic_inventory_view', 'list'); }}
                      className={`p-2 rounded-lg transition cursor-pointer ${inventoryView === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                      title="Vista de lista"
                      aria-label="Vista de lista"
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                {(canEditProducts || canRestock || canTransferStock || canViewSalesHistory) && (
                  <div className="flex gap-2 flex-wrap">
                    {canEditProducts && (
                      <button
                        onClick={handleExportProducts}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                        title={isOwner ? 'Exportar catálogo completo con existencias multisuccursal a CSV' : 'Exportar catálogo con existencias de tu sucursal a CSV'}
                      >
                        <Download className="w-4 h-4" /> Exportar Inventario (CSV)
                      </button>
                    )}
                    {canEditProducts && (
                      <button
                        onClick={() => setIsCategoryModalOpen(true)}
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                      >
                        <Layers className="w-4 h-4 text-slate-500" />
                        Editar Categorías
                      </button>
                    )}
                    {canTransferStock && operationalBranchId !== matrizBranch?.id && (
                      <button
                        type="button"
                        onClick={handleOpenMoveAllToMatrizModal}
                        className="bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                        title="Envía todo el stock actual de esta sucursal a la Matriz en un solo traspaso"
                      >
                        <Package className="w-4 h-4" />
                        Mover Todo a Matriz
                      </button>
                    )}
                    {canEditProducts && (
                      <button
                        onClick={() => handleOpenProductModal()}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                      >
                        <Plus className="w-4 h-4" />
                        Nuevo Producto
                      </button>
                    )}
                    {canEditProducts && (
                      <button
                        onClick={handleOpenBulkProductModal}
                        className="bg-violet-600 hover:bg-violet-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                        title="Crea un producto que funciona como fondo de stock compartido y sus presentaciones (las variantes que sí se venden) en un solo paso"
                      >
                        <Plus className="w-4 h-4" />
                        Producto con Presentaciones
                      </button>
                    )}
                  </div>
                )}
                </div>
              </div>

              {/* Inventario search — matches by name, category or SKU; unlike the Terminal
                  POS search, out-of-stock items stay visible since managing stock is the point. */}
              <div className="relative">
                <Search className="absolute left-3.5 top-3.5 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Buscar producto por nombre, categoría o SKU..."
                  value={inventorySearchTerm}
                  onChange={e => setInventorySearchTerm(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-sm font-medium transition"
                />
              </div>

              {/* Inventory: card grid or compact list depending on the user's toggle */}
              {inventoryView === 'grid' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {topLevelInventoryProducts.length === 0 && (
                  <p className="col-span-full text-center text-sm text-slate-400 py-10">
                    {products.length === 0 ? 'No hay productos en el catálogo.' : 'Ningún producto coincide con la búsqueda.'}
                  </p>
                )}
                {topLevelInventoryProducts.map(prod => (
                  <div key={prod.id} className="border border-slate-200/80 rounded-2xl p-4 flex flex-col justify-between hover:border-indigo-50 shadow-sm duration-150">
                    <div className="space-y-2.5">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                          {prod.category}
                        </span>
                        {getProductStock(prod, operationalBranchId, products) <= prod.minStock && (
                          <span className="text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 flex items-center animate-pulse">
                            <AlertCircle className="w-3 h-3 mr-1" />
                            Stock en Alerta
                          </span>
                        )}
                      </div>

                      <div className="flex space-x-3 items-center">
                        <span className="p-2 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-primary) 10%, white)' }}>
                          <Package className="w-6 h-6" style={{ color: 'color-mix(in srgb, var(--brand-primary) 60%, #94a3b8)' }} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h4 className="font-extrabold text-slate-800 text-sm leading-tight break-words">{prod.name}</h4>
                          <p className="text-[10px] text-slate-400 font-mono truncate" title={`ID: ${prod.id}${prod.sku ? ` | SKU: ${prod.sku}` : ''}`}>ID: {prod.id} {prod.sku ? `| SKU: ${prod.sku}` : ''}</p>
                          {prod.supplierId && (
                            <p className="text-[9px] text-amber-600 font-extrabold tracking-wide uppercase mt-1">
                              <Truck className="w-2.5 h-2.5 inline mr-0.5" />Prov: {suppliers.find(s => s.id === prod.supplierId)?.name || 'Desconocido'}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Costs and Prices */}
                      <div className="grid grid-cols-3 gap-2 py-2 border-y border-slate-100 text-xs">
                        <div className="text-center bg-slate-50 p-1.5 rounded">
                          <p className="text-slate-400 font-medium">Margen</p>
                          <p className="font-bold text-slate-800">
                            {prod.salePrice > 0
                              ? (prod.costPrice > 0 ? `${(((prod.salePrice - prod.costPrice) / prod.salePrice) * 100).toFixed(0)}%` : '100%')
                              : '—'}
                          </p>
                        </div>
                        <div className="text-center bg-slate-50 p-1.5 rounded">
                          <p className="text-slate-400 font-medium">Costo</p>
                          <p className="font-bold text-slate-700">{formatMXN(prod.costPrice)}</p>
                        </div>
                        <div className="text-center bg-indigo-50/10 p-1.5 rounded">
                          <p className="text-indigo-400 font-medium">Precio</p>
                          <p className="font-bold text-indigo-700">{formatMXN(prod.salePrice)}</p>
                        </div>
                      </div>

                      <div className="flex justify-between text-xs font-semibold text-slate-600 pt-1">
                        <span>Cant. en Inventario:</span>
                        <span className={`font-bold ${getProductStock(prod, operationalBranchId, products) <= prod.minStock ? 'text-purple-600' : 'text-slate-800'}`}>{getProductStock(prod, operationalBranchId, products)} u.</span>
                      </div>

                      {activeCompanyRole !== 'employee' && branches.length > 1 && (
                        <div className="mt-2 bg-slate-50 p-2 rounded-lg border border-slate-100 text-[10px] space-y-1 text-left">
                          <p className="font-extrabold text-slate-400 uppercase tracking-wider">Stock por Sucursal:</p>
                          <div className="space-y-0.5 max-h-20 overflow-y-auto">
                            {branches.map(b => (
                              <div key={b.id} className="flex justify-between items-center text-slate-600 font-bold">
                                <span className="truncate">{b.name}:</span>
                                <span className={getProductStock(prod, b.id, products) <= prod.minStock ? 'text-amber-600' : 'text-slate-800'}>
                                  {getProductStock(prod, b.id, products)} u.
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {getLinkedChildren(prod.id).length > 0 && (
                        <div className="mt-2 bg-violet-50 p-2 rounded-lg border border-violet-100 text-[10px] space-y-1 text-left">
                          <p className="font-extrabold text-violet-400 uppercase tracking-wider">Presentaciones Vinculadas:</p>
                          <div className="space-y-0.5">
                            {getLinkedChildren(prod.id).map(child => (
                              <div key={child.id} className="flex justify-between items-center text-violet-700 font-bold gap-1.5">
                                <span className="truncate flex-1">{child.name.replace(prod.name, '').trim() || child.name}:</span>
                                <span className="shrink-0">{formatMXN(child.salePrice)} · {getProductStock(child, operationalBranchId, products)} u.</span>
                                {canEditProducts && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenProductModal(child)}
                                    className="shrink-0 p-1 -m-1 text-violet-500 hover:text-violet-800 cursor-pointer"
                                    title={`Editar ${child.name}`}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {(canEditProducts || canRestock || canTransferStock) ? (
                      <div className="mt-4 pt-4 border-t border-slate-100">
                        {canTransferStock && branches.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleOpenTransferModal(prod.id)}
                            className="w-full py-2 mb-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 text-xs font-black rounded-xl cursor-pointer transition text-center flex items-center justify-center space-x-1"
                          >
                            <Package className="w-3.5 h-3.5 inline mr-1" /><span>Transferir / Repartir Stock</span>
                          </button>
                        )}
                        {canRestock && (
                          <button
                            type="button"
                            onClick={() => { setQuickStockProduct(prod); setQuickStockAmount(''); }}
                            className="w-full py-2 mb-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 text-emerald-700 text-xs font-black rounded-xl cursor-pointer transition text-center flex items-center justify-center"
                            title={`Sumar unidades al stock de ${branches.find(b => b.id === operationalBranchId)?.name || 'esta sucursal'}`}
                          >
                            <Plus className="w-3.5 h-3.5 inline mr-1" /><span>Surtir Stock</span>
                          </button>
                        )}
                        {canEditProducts ? (
                          <div className="flex space-x-2">
                            <button
                              onClick={() => handleOpenProductModal(prod)}
                              className="w-1/2 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer transition text-center"
                            >
                              Editar Art.
                            </button>
                            <button
                              onClick={() => handleDeleteProduct(prod.id)}
                              className="w-1/2 py-2 hover:bg-purple-50 text-purple-600 text-xs font-bold rounded-xl border border-transparent hover:border-purple-200 cursor-pointer transition text-center"
                            >
                              Eliminar
                            </button>
                          </div>
                        ) : (
                          <p className="text-center text-[10px] text-slate-400 font-semibold select-none py-1 flex items-center justify-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> Tu cuenta no puede editar o eliminar artículos
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="mt-4 pt-3 border-t border-slate-50 text-center text-[10px] text-slate-400 font-semibold select-none flex items-center justify-center gap-1">
                        <Settings className="w-2.5 h-2.5" /> Tu cuenta no tiene permisos para gestionar stock
                      </div>
                    )}
                  </div>
                ))}
              </div>
              ) : (
              <div className="border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100">
                {topLevelInventoryProducts.length === 0 && (
                  <p className="text-center text-sm text-slate-400 py-10">
                    {products.length === 0 ? 'No hay productos en el catálogo.' : 'Ningún producto coincide con la búsqueda.'}
                  </p>
                )}
                {topLevelInventoryProducts.map(prod => {
                  const branchStock = getProductStock(prod, operationalBranchId, products);
                  const low = branchStock <= prod.minStock;
                  const linkedChildren = getLinkedChildren(prod.id);
                  return (
                    <div key={prod.id} className="flex items-center gap-3 p-3 hover:bg-slate-50/70 transition">
                      <span className="p-2 rounded-lg shrink-0 hidden sm:flex items-center justify-center" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-primary) 10%, white)' }}>
                        <Package className="w-4 h-4" style={{ color: 'color-mix(in srgb, var(--brand-primary) 60%, #94a3b8)' }} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-extrabold text-slate-800 text-sm truncate">{prod.name}</p>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 shrink-0">{prod.category}</span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-0.5">
                          <span className="font-bold" style={{ color: 'var(--brand-primary)' }}>{formatMXN(prod.salePrice)}</span>
                          <span className={`font-bold ${low ? 'text-amber-600' : 'text-slate-600'}`}>
                            {low && <AlertCircle className="w-3 h-3 inline mr-0.5" />}Stock: {branchStock} u.
                          </span>
                        </div>
                        {linkedChildren.length > 0 && (
                          <p className="text-[10px] text-violet-600 font-bold mt-0.5 truncate flex items-center gap-1">
                            <Link2 className="w-2.5 h-2.5 shrink-0" /> {linkedChildren.map(child => `${child.name.replace(prod.name, '').trim() || child.name}: ${getProductStock(child, operationalBranchId, products)} u.`).join(' · ')}
                          </p>
                        )}
                      </div>
                      {(canEditProducts || canRestock || canTransferStock) && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          {canRestock && (
                            <button
                              type="button"
                              onClick={() => { setQuickStockProduct(prod); setQuickStockAmount(''); }}
                              className="p-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 text-emerald-700 rounded-lg cursor-pointer transition"
                              title="Surtir stock"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canTransferStock && branches.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleOpenTransferModal(prod.id)}
                              className="p-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 rounded-lg cursor-pointer transition shrink-0"
                              title="Transferir / repartir stock"
                            >
                              <Package className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canEditProducts ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleOpenProductModal(prod)}
                                className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold rounded-lg cursor-pointer transition shrink-0"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteProduct(prod.id)}
                                className="p-2 hover:bg-rose-50 text-rose-500 rounded-lg cursor-pointer transition"
                                title="Eliminar"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <span className="text-slate-400 select-none px-1" title="Solo el Dueño puede editar o eliminar artículos">
                              <Lock className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}

          {/* SCREEN: CLIENTES / CRM */}
          {activeTab === 'customers' && (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-800">Manejo de Clientes y Cobranza ({customers.length})</h2>
                  <p className="text-sm text-slate-500 mt-1">Registra cuentas abiertas, gestiona saldos acumulados de clientes fiados ("Crédito LOGIC") y fomenta la lealtad.</p>
                </div>
                <button
                  onClick={() => handleOpenCustomerModal()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 self-start cursor-pointer shadow-sm transition"
                >
                  <UserPlus className="w-4 h-4" />
                  + Registrar Cliente
                </button>
              </div>

              {/* Customer table / profiles list */}
              <div className="space-y-4">
                {customers.map(cust => (
                  <div key={cust.id} className="border border-slate-200/80 hover:border-slate-300 rounded-2xl p-4 md:p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white shadow-sm transition">
                    <div className="space-y-1.5 flex-grow min-w-0 w-full md:w-auto">
                      <div className="flex items-start gap-2 min-w-0">
                        <h4 className="font-extrabold text-lg text-slate-800 leading-tight break-words min-w-0">{cust.name}</h4>
                        <span className="text-[10px] bg-slate-100 border text-slate-400 font-mono py-0.5 px-2 rounded-full truncate max-w-[45%] shrink-0" title={`ID: ${cust.id}`}>ID: {cust.id}</span>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-semibold text-slate-600">
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Contacto Tel.</p>
                          <p className="text-slate-800 font-bold">{cust.phone || 'Vacio'}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Correo Electrónico</p>
                          <p className="text-slate-800 font-bold truncate" title={cust.email}>{cust.email || 'Vacio'}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Registro</p>
                          <p className="text-slate-800 font-medium">{cust.registeredDate}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Puntos Fidelidad</p>
                          <p className="text-indigo-600 font-bold">120 pt.</p>
                        </div>
                      </div>
                    </div>

                    {/* Pending loan (fiado) actions on right */}
                    <div className="w-full md:w-auto p-4 bg-slate-50 border rounded-xl flex flex-col justify-between space-y-3 min-w-[220px]">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-500 font-bold">Saldo Fiado:</span>
                        <span className={`text-sm font-extrabold ${cust.unpaidBalance > 0 ? 'text-purple-600 animate-pulse' : 'text-emerald-600'}`}>
                          {formatMXN(cust.unpaidBalance)}
                        </span>
                      </div>
                      
                      {cust.unpaidBalance > 0 ? (
                        <div className="space-y-2">
                          {paymentPrompt?.customerId === cust.id ? (
                            <div className="flex bg-slate-50 border border-emerald-100 rounded-lg p-1.5 shadow-inner items-center gap-1.5 flex-1">
                              <input 
                                type="number" 
                                placeholder="Monto" 
                                value={paymentAmount} 
                                onChange={e => setPaymentAmount(e.target.value)} 
                                className="w-full bg-white border border-slate-200 text-xs px-2 py-1 rounded outline-none" 
                                autoFocus 
                              />
                              <button
                                onClick={() => {
                                  const p = parseFloat(paymentAmount);
                                  if (!isNaN(p) && p > 0) {
                                    handlePayBalance(cust.id, p);
                                    setPaymentPrompt(null);
                                  }
                                }}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3 py-1 rounded transition inline-flex items-center justify-center"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setPaymentPrompt(null)}
                                className="bg-red-50 text-red-500 hover:bg-red-100 font-bold text-xs px-2 py-1 rounded transition"
                              >
                                X
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setPaymentPrompt({customerId: cust.id, customerName: cust.name, unpaidBalance: cust.unpaidBalance});
                                setPaymentAmount('');
                              }}
                              className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-lg cursor-pointer transition text-center shadow-inner"
                            >
                              Registrar Abono
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-center bg-emerald-50 text-emerald-700 font-semibold p-1.5 rounded flex items-center justify-center gap-1">
                          <Check className="w-3 h-3" /> Cuenta al día
                        </span>
                      )}

                      <div className="flex space-x-1 justify-end">
                        <button 
                          onClick={() => handleOpenCustomerModal(cust)} 
                          className="w-full py-1 bg-white hover:bg-slate-100 text-[10px] text-slate-500 font-bold border rounded"
                        >
                          Modificar Perfil
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SCREEN: HISTORIAL DE VENTAS & CONTROL DE CAJA */}
          {activeTab === 'history' && canViewSalesHistory && (
            <div className="space-y-6">

              {/* Cash panel + monthly cut: not offered to a plain cashier, who only reads the sales list below */}
              {canViewCashAudit && (<>
              {/* Cash Register Control Card */}
              <div className="rounded-3xl p-6 text-white shadow-md grid grid-cols-1 md:grid-cols-12 gap-6 items-center border" style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--brand-dark) 95%, black), color-mix(in srgb, var(--brand-dark) 82%, black), color-mix(in srgb, var(--brand-dark) 70%, black))', borderColor: 'color-mix(in srgb, var(--brand-dark) 55%, black)' }}>
                <div className="md:col-span-4 space-y-1">
                  <span className="text-[10px] font-extrabold py-1 px-3 rounded-full uppercase tracking-wider" style={{ color: 'color-mix(in srgb, var(--brand-primary) 45%, white)', backgroundColor: 'color-mix(in srgb, var(--brand-dark) 40%, black)' }}>
                    {cashRegister.isOpen ? 'Caja activa (flujo del día)' : 'Caja cerrada (último turno)'}
                  </span>
                  <p className="text-2xl font-extrabold">Efectivo en Caja</p>
                  <p className="text-3xl font-black text-yellow-400">{formatMXN(displayedCash)}</p>
                  {editInitialCashPrompt ? (
                    <div className="flex items-center gap-2 mt-2">
                       <span className="text-xs text-white/60">Monto apertura: $</span>
                       <input 
                         type="number"
                         value={newInitialCash}
                         onChange={(e) => setNewInitialCash(e.target.value)}
                         className="w-20 px-1.5 py-0.5 text-xs bg-white text-slate-800 rounded outline-none font-bold"
                         autoFocus
                       />
                       <button
                           onClick={async () => {
                             if (!isOwner || !canCloseCash || !operationalBranchId) {
                               alert('Solo el Dueño con permiso de cierre puede ajustar la apertura de una sucursal asignada.');
                               return;
                             }
                             const val = parseFloat(newInitialCash);
                            if (!isNaN(val) && val >= 0) {
                              const diff = val - cashRegister.initialCash;
                              try {
                                await writeCashRegisterForBranch(operationalBranchId, {
                                  ...cashRegister,
                                  initialCash: val,
                                  currentCash: cashRegister.currentCash + diff,
                                  transactions: [],
                                }, {
                                  type: diff >= 0 ? 'Ingreso' : 'Egreso',
                                  amount: Math.abs(diff),
                                  cashDelta: diff,
                                  description: `Ajuste de monto de apertura: ${formatMXN(cashRegister.initialCash)} → ${formatMXN(val)}`,
                                  time: new Date().toLocaleTimeString(),
                                  createdAt: Date.now(),
                                  shiftId: cashRegister.currentShiftId,
                                  balanceAfter: cashRegister.currentCash + diff,
                                });
                                setEditInitialCashPrompt(false);
                              } catch (error) {
                                console.error('Opening amount adjustment failed:', error);
                                alert('No se pudo confirmar el ajuste del monto de apertura.');
                              }
                            }
                          }}
                         className="bg-emerald-500 hover:bg-emerald-600 text-white px-2 py-0.5 text-[10px] rounded font-bold transition shadow-sm inline-flex items-center gap-1"
                       ><Check className="w-3 h-3" /> Guardar
                       </button>
                       <button
                         onClick={() => setEditInitialCashPrompt(false)}
                         className="bg-red-500 hover:bg-red-600 text-white px-2 py-0.5 text-[10px] rounded font-bold transition shadow-sm"
                       >X
                       </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mt-2">
                      <p className="text-xs text-white/60">Monto de apertura: {formatMXN(cashRegister.initialCash)}</p>
                       {isOwner && canCloseCash && operationalBranchId && (
                        <button
                          onClick={() => {
                            setEditInitialCashPrompt(true);
                            setNewInitialCash(cashRegister.initialCash.toString());
                          }}
                          className="text-[10px] bg-white/10 hover:bg-white/20 px-2 py-0.5 rounded text-white transition border border-white/20 shadow-sm cursor-pointer ml-1"
                        >
                          Editar
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="md:col-span-4 bg-white/10 backdrop-blur-sm p-4 rounded-2xl border border-white/15 space-y-3 text-xs flex flex-col justify-between">
                  <p className="font-extrabold text-white/90">Registrar flujo especial en Caja</p>
                  
                  <div className="flex space-x-2">
                    <input 
                      type="number"
                      placeholder="$ Monto"
                      value={cashFlowAmount}
                      onChange={e => setCashFlowAmount(e.target.value)}
                      className="bg-white/10 border border-white/20 rounded-lg p-1.5 focus:bg-white focus:text-slate-900 focus:outline-none w-1/3 text-xs text-white font-bold"
                    />
                    <input 
                      type="text"
                      placeholder="Ej: Pago de Luz / Vuelto"
                      value={cashFlowDesc}
                      onChange={e => setCashFlowDesc(e.target.value)}
                      className="bg-white/10 border border-white/20 rounded-lg p-1.5 focus:bg-white focus:text-slate-900 focus:outline-none w-2/3 text-xs text-white font-medium"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button 
                      onClick={() => handleRecordCashFlow('Ingreso')}
                      className="py-1.5 bg-emerald-500 hover:bg-emerald-600 font-bold text-[10px] rounded text-white flex items-center justify-center cursor-pointer"
                    >
                      + Registrar Ingreso
                    </button>
                    <button 
                      onClick={() => handleRecordCashFlow('Egreso')}
                      className="py-1.5 bg-pink-800 hover:bg-pink-900 font-bold text-[10px] rounded text-white flex items-center justify-center cursor-pointer"
                    >
                      - Registrar Egreso
                    </button>
                  </div>
                </div>

                {/* Cash Transactions Logs inside card */}
                <div className="md:col-span-4 p-4 rounded-2xl border h-[110px] overflow-y-auto text-[10px] space-y-1.5 font-mono" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 40%, black)', borderColor: 'color-mix(in srgb, var(--brand-dark) 30%, transparent)' }}>
                  <p className="font-bold tracking-wider uppercase pb-0.5" style={{ color: 'color-mix(in srgb, var(--brand-primary) 45%, white)', borderBottom: '1px solid color-mix(in srgb, var(--brand-dark) 30%, transparent)' }}>Auditoría rápida de movimientos</p>
                  {currentShiftTransactions.map((tx, idx) => (
                    <div key={idx} className="flex justify-between items-center text-white/80 gap-2">
                      <span className="truncate">{tx.time} - {tx.description}</span>
                      <span className={`font-bold ${tx.type === 'Ingreso' || tx.type === 'Venta' ? 'text-emerald-400' : tx.type === 'Transferencia' ? 'text-sky-300' : 'text-pink-400'}`}>
                        {tx.type === 'Egreso' ? '-' : tx.type === 'Transferencia' ? '' : '+'}{formatTxAmount(tx)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Monthly Cut / Statement PDF export */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 text-left">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-2">
                      <FileText className="w-4 h-4" style={{ color: 'var(--brand-primary)' }} />
                      Corte Mensual (PDF)
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">Descarga el estado de cuenta de ventas de un mes completo — incluye cualquier mes anterior con historial disponible.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={pdfCutMonth}
                      onChange={(e) => setPdfCutMonth(e.target.value)}
                      className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 outline-none focus:border-indigo-400 cursor-pointer"
                    >
                      {availableStatsMonths.map(m => (
                        <option key={m} value={m}>{getMonthLabel(m)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleDownloadMonthlyCutPdf}
                      disabled={isHistoricalLoading}
                      className="px-4 py-2.5 text-white font-black text-xs rounded-xl shadow-md flex items-center space-x-2 transition cursor-pointer whitespace-nowrap"
                      style={{ backgroundColor: 'var(--brand-primary)' }}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{isHistoricalLoading ? 'Cargando período…' : 'Descargar PDF'}</span>
                    </button>
                  </div>
                </div>
              </div>

              </>)}

              {/* Sales Invoice history list and Cash register details */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-6 text-left">
                <div className="flex flex-col md:flex-row md:items-center justify-between pb-3 border-b border-slate-100 gap-4">
                  <div>
                    <h2 className="text-xl font-extrabold text-slate-800">{canViewCashAudit ? 'Historial & Control de Caja' : 'Historial de ventas de hoy'}</h2>
                    <p className="text-xs text-slate-500 mt-1">{canViewCashAudit
                      ? 'Inspecciona y revisa el listado completo de flujos de efectivo, ventas, egresos y cancelaciones correspondientes a esta sucursal.'
                      : 'Consulta las ventas registradas hoy en tu sucursal.'}</p>
                  </div>

                  <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-xl w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={() => setHistorySubTab('sales')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        visibleHistorySubTab === 'sales'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={visibleHistorySubTab === 'sales' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <Receipt className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span>Ventas ({branchScopedSales.length})</span>
                    </button>
                    {canViewCashAudit && <button
                      type="button"
                      onClick={() => setHistorySubTab('cashLog')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        visibleHistorySubTab === 'cashLog'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={visibleHistorySubTab === 'cashLog' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <CircleDollarSign className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span className="sm:hidden">Caja ({branchScopedTransactions.length})</span>
                      <span className="hidden sm:inline">Auditoría de Caja ({branchScopedTransactions.length})</span>
                    </button>}
                    {canViewInventoryLog && <button
                      type="button"
                      onClick={() => setHistorySubTab('inventory')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        visibleHistorySubTab === 'inventory'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={visibleHistorySubTab === 'inventory' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <Package className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span>Inventario ({branchScopedStockMovements.length})</span>
                    </button>}
                  </div>
                </div>

                {visibleHistorySubTab === 'sales' ? (
                  branchScopedSales.length === 0 ? (
                    <div className="border border-dashed rounded-xl p-12 text-center text-slate-400">
                      <Receipt className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-sm font-semibold">Aún no hay transacciones de ventas registradas hoy en esta sucursal.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {branchScopedSales.map(sale => (
                        <div key={sale.id} className="border border-slate-200 rounded-2xl p-4 bg-slate-50/10 hover:border-slate-300 transition duration-150">
                          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-100 gap-2 mb-3">
                            <div className="flex items-center space-x-2.5 flex-wrap gap-y-1">
                              <span className="text-xs font-black text-slate-800 bg-slate-100 border px-2.5 py-1 rounded-md">{sale.id}</span>
                              <span className="text-xs text-slate-500 font-medium">{sale.timestamp}</span>
                              {sale.folio && (
                                <span className="text-[10px] font-bold bg-amber-50 text-indigo-800 border border-indigo-200 px-2 py-0.5 rounded-md">
                                  Folio: {sale.folio}
                                </span>
                              )}
                            </div>
                            
                            <div className="flex items-center space-x-2">
                              <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${
                                sale.status === 'Completed' 
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                                  : 'bg-pink-50 text-pink-700 border-pink-200'
                              }`}>
                                {sale.status === 'Completed' ? 'Venta Exitosa' : 'Reembolsada'}
                              </span>
                              <span className="text-xs font-bold bg-slate-100 border text-slate-600 px-2 py-1 rounded">
                                Método: {sale.paymentMethod === 'Cash' ? 'Efectivo' : sale.paymentMethod === 'Card' ? 'Tarjeta' : sale.paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito/Fiado'}
                              </span>
                            </div>
                          </div>

                          {/* Invoice detailed articles list */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <p className="text-[10px] text-slate-400 font-extrabold uppercase">Artículos Incluidos</p>
                              {sale.items.map((it, idx) => (
                                <div key={idx} className="flex justify-between gap-2 text-xs text-slate-700 font-semibold">
                                  <span className="min-w-0 break-words">{it.quantity}x {it.name}</span>
                                  <span className="text-slate-500 shrink-0">{formatMXN(it.salePrice * it.quantity)}</span>
                                </div>
                              ))}
                            </div>

                            <div className="space-y-2 md:text-right bg-slate-50 p-3 rounded-xl border border-slate-100">
                              {sale.customerName && (
                                <p className="text-xs text-slate-600 font-bold">Cliente: <span style={{ color: 'var(--brand-primary)' }}>{sale.customerName}</span></p>
                              )}
                              {sale.employeeName && (
                                <p className="text-xs text-slate-600 font-bold">Atendido por: <span style={{ color: 'var(--brand-primary)' }}>{sale.employeeName}</span></p>
                              )}
                              <div className="text-xs text-slate-500 font-medium leading-relaxed">
                                <p>Subtotal: {formatMXN(sale.subtotal)}</p>
                                {sale.discount > 0 && <p className="text-emerald-600">Descuento: -{formatMXN(sale.discount)}</p>}
                                <p>Impuesto: {formatMXN(sale.tax)}</p>
                                <p className="text-base font-black text-slate-800 mt-1">Total Generado: {formatMXN(sale.total)}</p>
                              </div>

                              {sale.status === 'Completed' && canRefundSales && (
                                <button
                                  type="button"
                                  onClick={() => handleRefundSale(sale.id)}
                                  className="mt-2.5 px-3 py-1 text-[10px] hover:bg-pink-600 hover:text-white border border-pink-200 rounded text-pink-600 font-bold cursor-pointer transition align-middle"
                                >
                                  Devolución / Reembolso
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : visibleHistorySubTab === 'cashLog' ? (
                  /* Cash audits view */
                  branchScopedTransactions.length === 0 ? (
                    <div className="border border-dashed rounded-xl p-12 text-center text-slate-400">
                      <CircleDollarSign className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-sm font-semibold">No se han registrado movimientos de flujo de caja para esta sucursal hoy.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 flex justify-between items-center text-xs">
                        <span className="text-slate-500 font-extrabold uppercase tracking-wider">Monto Efectivo Estimado en Caja Física:</span>
                        <span className="font-extrabold text-indigo-700 text-sm">{formatMXN(displayedCash)}</span>
                      </div>
                      <div className="space-y-2.5">
                        {branchScopedTransactions.map((tx, idx) => {
                          const isGreen = tx.type === 'Ingreso' || tx.type === 'Venta';
                          const isTransfer = tx.type === 'Transferencia';
                          return (
                            <div key={idx} className="flex justify-between items-center border border-slate-100 rounded-xl p-3 bg-white hover:bg-slate-50/50 transition duration-150">
                              <div className="flex items-center space-x-3 text-left">
                                <span className={`p-2 rounded-lg font-black text-sm flex items-center justify-center ${
                                  tx.type === 'Venta'
                                    ? 'bg-blue-50 text-blue-600'
                                    : tx.type === 'Ingreso'
                                    ? 'bg-emerald-50 text-emerald-600'
                                    : isTransfer
                                    ? 'bg-sky-50 text-sky-600'
                                    : 'bg-rose-50 text-rose-600'
                                }`}>
                                  {tx.type === 'Venta' ? <Receipt className="w-4 h-4" /> : tx.type === 'Ingreso' ? <Download className="w-4 h-4" /> : isTransfer ? <RotateCcw className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                                </span>
                                <div>
                                  <p className="text-xs font-bold text-slate-800">{tx.description}</p>
                                  <div className="flex items-center space-x-2 text-[10px] text-slate-400 font-semibold mt-0.5">
                                    <span>Hora: {tx.time}</span>
                                    <span>•</span>
                                    <span className="uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded text-slate-500">
                                      {tx.type === 'Venta' ? 'Venta' : tx.type === 'Ingreso' ? 'Entrada' : isTransfer ? 'Transferencia' : 'Salida'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div className="text-right">
                                <span className={`font-black text-xs ${isGreen ? 'text-emerald-600' : isTransfer ? 'text-sky-600' : 'text-rose-600'}`}>
                                  {tx.type === 'Egreso' ? '-' : isTransfer ? '' : '+'}{formatTxAmount(tx)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )
                ) : (
                  /* Inventory movements view (surtidos + transfers) */
                  branchScopedStockMovements.length === 0 ? (
                    <div className="border border-dashed rounded-xl p-12 text-center text-slate-400">
                      <Package className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-sm font-semibold">Aún no hay movimientos de inventario (surtidos o traspasos) en esta sucursal.</p>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {branchScopedStockMovements.map(mv => {
                        const isIn = mv.type === 'surtido' || mv.type === 'transfer_in';
                        const typeLabel = mv.type === 'surtido' ? 'Surtido' : mv.type === 'merma' ? 'Merma / Ajuste' : mv.type === 'transfer_in' ? 'Traspaso (entrada)' : 'Traspaso (salida)';
                        const MovementIcon = mv.type === 'surtido' ? Download : mv.type === 'merma' ? TrendingDown : RotateCcw;
                        return (
                          <div key={mv.id} className="flex justify-between items-center border border-slate-100 rounded-xl p-3 bg-white hover:bg-slate-50/50 transition duration-150">
                            <div className="flex items-center space-x-3 text-left min-w-0">
                              <span className={`p-2 rounded-lg font-black text-sm flex items-center justify-center shrink-0 ${
                                mv.type === 'surtido' ? 'bg-emerald-50 text-emerald-600' : mv.type === 'merma' ? 'bg-rose-50 text-rose-600' : 'bg-sky-50 text-sky-600'
                              }`}>
                                <MovementIcon className="w-4 h-4" />
                              </span>
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-800 truncate">{mv.productName}</p>
                                <div className="flex items-center gap-2 text-[10px] text-slate-400 font-semibold mt-0.5 flex-wrap">
                                  <span className="uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded text-slate-500">{typeLabel}</span>
                                  {mv.counterpartBranchName && <span>{isIn ? 'desde' : 'hacia'} {mv.counterpartBranchName}</span>}
                                  <span>{mv.timestamp}</span>
                                  {mv.userName && <span>· {mv.userName}</span>}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                              <span className={`font-black text-xs ${isIn ? 'text-emerald-600' : 'text-rose-600'}`}>
                                {isIn ? '+' : '-'}{mv.quantity} u.
                              </span>
                              {(mv.type === 'transfer_in' || mv.type === 'transfer_out') && mv.transferId && (
                                <button
                                  type="button"
                                  onClick={() => handleReprintTransfer(mv.transferId!)}
                                  title="Reimprimir ticket de traspaso"
                                  className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition cursor-pointer"
                                >
                                  <Printer className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {activeTab === 'analytics' && canViewAnalytics && (
            activeCompanyRole === 'employee' ? (
              <div className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-6 max-w-2xl mx-auto mt-6 text-center select-none">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto border border-rose-100">
                  <ShieldCheck className="w-8 h-8 text-rose-500 animate-pulse" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-2xl font-black text-slate-800 tracking-tight">Acceso Limitado a Estadísticas</h3>
                  <p className="text-slate-500 text-sm max-w-md mx-auto">
                    El reporte detallado de estadísticas de ganancias, ticket promedio e informes contables generales está restringido para cuentas de tipo <strong>Empleado</strong>.
                  </p>
                </div>

                <div className="p-4 bg-slate-50 rounded-2xl border text-left max-w-md mx-auto">
                  <p className="text-xs text-slate-500 leading-relaxed text-center font-medium flex items-start justify-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>Si necesitas acceso para reabastecimientos, reportajes o auditorías, por favor solicita a tu Administrador o Propietario que actualice tus privilegios de acceso desde la pestaña de <strong>Mi Empresa / Equipo</strong>.</span>
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
              
              {/* Core Analytics Header with Download button */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white border border-slate-200 p-6 rounded-3xl shadow-xs text-left">
                <div>
                  <h2 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" style={{ color: 'var(--brand-primary)' }} /> Centro de Estadísticas de {userCompanies[activeCompanyId || '']?.name || 'Mi Comercio'}
                  </h2>
                  <p className="text-xs text-slate-500">Métricas completas, ganancias aproximadas y tickets logrados por mes.</p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto flex-wrap">
                  <select
                    value={statsMonth}
                    onChange={(e) => setStatsMonth(e.target.value)}
                    disabled={!!statsDay}
                    className="w-full sm:w-auto text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 outline-none focus:border-indigo-400 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="all">Todo el histórico</option>
                    {availableStatsMonths.map(m => (
                      <option key={m} value={m}>{getMonthLabel(m)}</option>
                    ))}
                  </select>
                  {/* Corte Diario: selecting a day takes priority over the month select above
                      (see the `stats` useMemo) — "Limpiar" drops back to the month/histórico view. */}
                  <input
                    type="date"
                    value={statsDay}
                    onChange={(e) => setStatsDay(e.target.value)}
                    className="w-full sm:w-auto text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 outline-none focus:border-indigo-400 cursor-pointer"
                  />
                  {statsDay && (
                    <button
                      type="button"
                      onClick={() => setStatsDay('')}
                      className="w-full sm:w-auto px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-xs rounded-xl transition cursor-pointer"
                    >
                      Limpiar
                    </button>
                  )}
                  {statsDay ? (
                    <button
                      type="button"
                      onClick={handleDownloadDailyCutPdf}
                      disabled={isHistoricalLoading}
                      className="w-full sm:w-auto px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /><span>Descargar Corte del Día (PDF)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleDownloadDashboard}
                      className="w-full sm:w-auto px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /><span>Descargar Reporte (CSV)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Core Analytics Dashboard summary header */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                
                <div className="bg-white rounded-2xl p-4 border shadow-sm">
                  <div className="text-slate-400 font-bold text-xs uppercase tracking-wider flex items-center justify-between">
                    Ingreso Bruto
                    <TrendingUp className="w-4 h-4 text-emerald-500" />
                  </div>
                  <p className="text-2xl font-extrabold text-slate-800 mt-2">{formatMXN(stats.grossRevenue)}</p>
                  <p className="text-[10px] text-slate-600 mt-2">Ventas finalizadas con éxito</p>
                </div>

                <div className="bg-white rounded-2xl p-4 border shadow-sm">
                  <div className="text-slate-400 font-bold text-xs uppercase tracking-wider flex items-center justify-between">
                    Ganancia Est.
                    <CircleDollarSign className="w-4 h-4 text-purple-500" />
                  </div>
                  <p className="text-2xl font-extrabold text-emerald-600 mt-2">{formatMXN(stats.profit)}</p>
                  <p className="text-[10px] text-slate-500 mt-2">Diferencia entre Costo y Cierre</p>
                </div>

                <div className="bg-white rounded-2xl p-4 border shadow-sm">
                  <div className="text-slate-400 font-bold text-xs uppercase tracking-wider flex items-center justify-between">
                    Ticket Promedio
                    <ShoppingCart className="w-4 h-4 text-slate-400" />
                  </div>
                  <p className="text-2xl font-extrabold text-slate-800 mt-2">{formatMXN(stats.averageTicket)}</p>
                  <p className="text-[10px] text-slate-500 mt-2">Total dividido nro ventas</p>
                </div>

                <div className="bg-white rounded-2xl p-4 border border-dashed border-amber-200 bg-amber-50/10">
                  <div className="text-amber-600 font-bold text-xs uppercase tracking-wider flex items-center justify-between">
                    Riesgo Stock Bajo
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                  </div>
                  <p className="text-2xl font-extrabold text-amber-700 mt-2">{stats.lowStockItems.length} Prod.</p>
                  <p className="text-[10px] text-slate-500 mt-2">Artículos por debajo del mínimo</p>
                </div>

              </div>

              {/* Corte Diario — only shown once a specific day is selected above */}
              {statsDay && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white rounded-2xl border p-5 shadow-sm space-y-4">
                    <div>
                      <h3 className="font-extrabold text-slate-800 text-sm">Flujo de Efectivo del Día</h3>
                      <p className="text-slate-400 text-xs mt-0.5">Entradas y retiros manuales de caja registrados el {statsDay}.</p>
                    </div>
                    {!dailyCashFlow || dailyCashFlow.movements.length === 0 ? (
                      <p className="text-xs text-slate-500 font-semibold py-6 text-center">Sin movimientos manuales de caja este día.</p>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex justify-between text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl p-2.5">
                          <span>Entradas (Ingreso)</span>
                          <span>+{formatMXN(dailyCashFlow.totalIngresos)}</span>
                        </div>
                        <div className="flex justify-between text-xs font-bold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl p-2.5">
                          <span>Retiros (Egreso)</span>
                          <span>-{formatMXN(dailyCashFlow.totalEgresos)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-black text-slate-800 border-t pt-2.5">
                          <span>Neto del día</span>
                          <span>{formatMXN(dailyCashFlow.net)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl border p-5 shadow-sm space-y-4">
                    <div>
                      <h3 className="font-extrabold text-slate-800 text-sm">Artículos Más Vendidos</h3>
                      <p className="text-slate-400 text-xs mt-0.5">Top 5 productos por unidades vendidas el {statsDay}.</p>
                    </div>
                    {dailyTopProducts.length === 0 ? (
                      <p className="text-xs text-slate-500 font-semibold py-6 text-center">Sin ventas registradas este día.</p>
                    ) : (
                      <div className="space-y-2">
                        {dailyTopProducts.map((p, idx) => (
                          <div key={p.productId} className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-xl p-2.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] font-black text-slate-400 w-4 shrink-0">#{idx + 1}</span>
                              <span className="text-xs font-bold text-slate-700 truncate">{p.name}</span>
                            </div>
                            <span className="text-xs font-black shrink-0" style={{ color: 'var(--brand-primary)' }}>{p.quantity} uds.</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Graphical Charts Section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Sale split by Category Bar graphical card */}
                <div className="bg-white rounded-2xl border p-5 shadow-sm space-y-4">
                  <div>
                    <h3 className="font-extrabold text-slate-800 text-sm">Distribución de Ventas por Categoría</h3>
                    <p className="text-slate-400 text-xs mt-0.5">Demanda acumulada según las categorías de productos.</p>
                  </div>

                  {Object.keys(stats.categoryPopularity).length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">Sin datos de transacciones para diagramar barras de popularidad</div>
                  ) : (
                    <div className="space-y-3">
                      {Object.entries(stats.categoryPopularity).map(([cat, val]) => {
                        const valuesArray = Object.values(stats.categoryPopularity) as number[];
                        const maxVal = Math.max(...valuesArray);
                        const numVal = val as number;
                        const pctWidth = maxVal > 0 ? (numVal / maxVal) * 100 : 0;
                        return (
                          <div key={cat} className="space-y-1">
                            <div className="flex justify-between text-xs font-bold text-slate-700">
                              <span>{cat}</span>
                              <span className="text-indigo-600">{val} uds. vendidas</span>
                            </div>
                            <div className="w-full bg-slate-100 rounded-lg h-2.5 overflow-hidden">
                              <div 
                                className="bg-indigo-600 h-2.5 rounded-lg transition-all duration-500"
                                style={{ width: `${pctWidth}%` }}
                              ></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* List Low Stock Alerts with action shortcut */}
                <div className="bg-white rounded-2xl border p-5 shadow-sm space-y-4">
                  <div>
                    <h3 className="font-extrabold text-purple-600 text-sm flex items-center">
                      <AlertCircle className="w-4 h-4 mr-1 text-purple-500 animate-bounce" />
                      Alertas de Reabastecimiento Crítico
                    </h3>
                    <p className="text-slate-400 text-xs mt-0.5">Surtidos indispensables por debajo del umbral mínimo de reserva.</p>
                  </div>

                  {stats.lowStockItems.length === 0 ? (
                    <p className="text-xs text-slate-500 font-semibold py-8 text-center flex items-center justify-center gap-1"><Check className="w-3.5 h-3.5" /> El almacén está perfectamente abastecido de mercancías.</p>
                  ) : (
                    <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                      {stats.lowStockItems.map(p => (
                        <div key={p.id} className="bg-slate-50 border border-slate-100 flex justify-between items-center p-2.5 rounded-xl">
                          <div>
                            <p className="text-xs font-bold text-slate-800">{p.name}</p>
                            <p className="text-[9px] text-slate-400">Mínimo sugerido: {p.minStock}</p>
                          </div>
                          <div className="text-right">
                            <span className="px-2 py-0.5 font-extrabold text-[10px] rounded-full text-white" style={{ backgroundColor: 'var(--brand-primary)' }}>
                              Stock: {getProductStock(p, operationalBranchId, products)}
                            </span>
                            <button
                              onClick={() => handleOpenRestock(undefined, p.id)}
                              className="text-[9px] underline block mt-1 font-bold font-mono"
                              style={{ color: 'var(--brand-primary)' }}
                            >
                              Surtir +
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

            </div>
            )
          )}

          {/* SCREEN: SUCURSALES (BRANCH OFFICES) */}
          {activeTab === 'branches' && isOwner && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-3xl border shadow-sm">
                <div>
                  <h2 className="text-xl font-black text-slate-800 tracking-tight flex items-center">
                    <Store className="w-5 h-5 mr-2 text-teal-600" />
                    Control de Sucursales y Oficinas
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Administra múltiples ubicaciones físicas o móviles, asigna gerentes, y monitorea el rendimiento individual.
                  </p>
                </div>
                {isOwner && (
                  <div className="flex gap-2.5 w-full md:w-auto self-start flex-wrap">
                    {canTransferStock && branches.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleOpenTransferModal()}
                        className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                        title="Distribuir existencias desde casa matriz o de una sucursal a otra"
                      >
                        <Package className="w-3.5 h-3.5" /><span>Transferir / Repartir Stock</span>
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenBranchModal()}
                      className="px-5 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Registrar Sucursal</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Grid of branches cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {branches.map(branch => {
                  const isActive = selectedBranchId === branch.id;
                  const totalBranchRevenue = branchRevenueStats[branch.id]?.revenue ?? 0;
                  const branchSalesCount = branchRevenueStats[branch.id]?.count ?? 0;

                  return (
                    <div 
                      key={branch.id} 
                      className={`relative bg-white rounded-3xl p-5 border shadow-sm flex flex-col justify-between transition group hover:shadow-md ${
                        isActive ? 'border-teal-500 ring-4 ring-teal-500/10' : 'border-slate-200'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute top-4 right-4 bg-teal-100 border border-teal-200 text-teal-800 text-[9px] font-black uppercase px-2 py-0.5 rounded-full select-none">
                          Trabajando Aquí
                        </span>
                      )}

                      <div className="space-y-4">
                        <div className="flex items-start space-x-3">
                          <div className={`p-2.5 rounded-2xl ${isActive ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
                            <Building2 className="w-5 h-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="font-extrabold text-slate-800 text-sm group-hover:text-teal-700 transition break-words">{branch.name}</h3>
                            <p className="text-slate-400 text-[10px] mt-0.5 font-mono truncate" title={`ID: ${branch.id}`}>ID: {branch.id}</p>
                          </div>
                        </div>

                        <div className="space-y-2 border-t border-slate-100 pt-3 text-xs leading-relaxed">
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Dirección:</span>
                            <span className="font-semibold text-slate-700 max-w-[150px] truncate" title={branch.address}>{branch.address || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Teléfono:</span>
                            <span className="font-semibold text-slate-700 max-w-[150px] truncate" title={branch.phone}>{branch.phone || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Gerente / Resp:</span>
                            <span className="font-semibold text-teal-700 max-w-[150px] truncate" title={branch.manager}>{branch.manager || 'No asignado'}</span>
                          </div>
                        </div>

                        {/* Performance metrics inside each card */}
                        <div className="bg-slate-50 border border-slate-100 p-3 rounded-2xl space-y-1.5">
                          <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase">
                            <span>Ingresos Sucursal:</span>
                            <span className="text-slate-800 font-mono">{formatMXN(totalBranchRevenue)}</span>
                          </div>
                          <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                            <div 
                              className="bg-teal-500 h-1.5 rounded-full" 
                              style={{ width: `${Math.min(100, (totalBranchRevenue / (stats.grossRevenue || 1)) * 100)}%` }}
                            ></div>
                          </div>
                          <p className="text-[9px] text-slate-400 text-right mt-1 font-semibold">{branchSalesCount} transacciones exitosas</p>
                        </div>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                        {!isActive && !isBranchLocked ? (
                          <button
                            onClick={() => handleSelectBranch(branch.id)}
                            className="px-3 py-1.5 bg-slate-100 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 hover:border-teal-200 text-slate-700 font-bold rounded-lg cursor-pointer transition text-[10px]"
                          >
                            Hacer Activa
                          </button>
                        ) : !isActive ? (
                          <span className="text-[9px] text-slate-400 font-bold select-none py-1 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> Solo el Dueño
                          </span>
                        ) : (
                          <span className="text-teal-600 font-bold text-[10px] flex items-center">
                            <Check className="w-3.5 h-3.5 mr-1 bg-teal-100 rounded-full p-0.5" /> Selección Actual
                          </span>
                        )}

                        {isOwner ? (
                          <div className="flex space-x-1">
                            <button
                              onClick={() => handleOpenBranchModal(branch)}
                              className="p-1 px-2.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition font-semibold text-[10px] border border-transparent hover:border-slate-200"
                            >
                              Editar
                            </button>
                            {activeCompanyRole === 'owner' && (
                              <button
                                onClick={() => handleDeleteBranch(branch.id)}
                                className="p-1 px-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition font-semibold text-[10px]"
                                title="Eliminar Sucursal"
                              >
                                Eliminar
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-[9px] text-slate-400 font-bold select-none py-1 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> Solo el Dueño
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SCREEN: PROVEEDORES (SUPPLIERS CATALOG) */}
          {activeTab === 'suppliers' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-3xl border shadow-sm">
                <div>
                  <h2 className="text-xl font-black text-slate-800 tracking-tight flex items-center">
                    <Truck className="w-5 h-5 mr-2 text-amber-600 animate-bounce" />
                    Catálogo de Proveedores de Insumos
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Gobernanza de distribuidores. Contacta proveedores directos y reabastece stock registrando egresos en caja.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                  {canRestock && <button
                    onClick={() => handleOpenRestock()}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                  >
                    <ArrowLeft className="w-4 h-4 rotate-180" />
                    <span>Reabastecer / Surtir Almacén</span>
                  </button>}
                  {canManageSuppliers && (
                    <button
                      onClick={() => handleOpenSupplierModal()}
                      className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Registrar Proveedor</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Grid of Suppliers cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {suppliers.map(supplier => {
                  const linkedProducts = products.filter(p => p.supplierId === supplier.id);

                  return (
                    <div key={supplier.id} className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between hover:shadow-md transition group">
                      <div className="space-y-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start space-x-3">
                            <div className="p-2.5 bg-amber-50 text-amber-700 rounded-2xl group-hover:bg-amber-100 transition">
                              <Truck className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3 className="font-extrabold text-slate-800 text-sm group-hover:text-amber-700 transition break-words">{supplier.name}</h3>
                              <p className="text-slate-400 text-[9px] font-mono mt-0.5">Categoría: <span className="text-amber-700 font-bold bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded-md">{supplier.category}</span></p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2 border-t border-slate-100 pt-3 text-xs leading-relaxed">
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Contacto:</span>
                            <span className="font-semibold text-slate-700 max-w-[150px] truncate" title={supplier.contactName}>{supplier.contactName || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Teléfono:</span>
                            <span className="font-semibold text-slate-700 font-mono max-w-[150px] truncate" title={supplier.phone}>{supplier.phone || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Email:</span>
                            <span className="font-semibold text-indigo-600 font-mono truncate max-w-[140px]" title={supplier.email}>{supplier.email || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Dirección:</span>
                            <span className="font-semibold text-slate-700 max-w-[150px] truncate" title={supplier.address}>{supplier.address || 'Sin registrar'}</span>
                          </div>
                        </div>

                        {/* Associated Products metrics */}
                        <div className="bg-amber-50/20 border border-amber-100/40 p-3 rounded-2xl">
                          <div className="flex justify-between items-center text-xs font-bold text-slate-700">
                            <span>Productos Surtidos:</span>
                            <span className="text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full text-[10px] font-black">{linkedProducts.length} artículos</span>
                          </div>
                          {linkedProducts.length > 0 && (
                            <div className="mt-2 text-[10px] text-slate-500 leading-tight space-y-1">
                              <p className="font-bold border-b border-amber-100 pb-1 uppercase text-[8px] text-slate-400">Existencias Actuales:</p>
                              {linkedProducts.slice(0, 3).map(p => {
                                const displayStock = getProductStock(p, operationalBranchId, products);
                                return (
                                <div key={p.id} className="flex justify-between gap-2 font-medium min-w-0">
                                  <span className="min-w-0 truncate" title={p.name}>{p.name}</span>
                                  <span className={`font-mono font-bold shrink-0 ${displayStock <= p.minStock ? 'text-orange-500' : 'text-slate-700'}`}>Stock: {displayStock}</span>
                                </div>
                              );})}
                              {linkedProducts.length > 3 && (
                                <p className="text-[9px] text-indigo-500 font-bold select-none cursor-pointer hover:underline" onClick={() => setActiveTab('products')}>+ {linkedProducts.length - 3} artículos más...</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                        {canRestock && <button
                          onClick={() => {
                            if (linkedProducts.length === 0) {
                              alert('Registre o vincule productos a este proveedor en el Inventario antes de reabastecer.');
                              return;
                            }
                            handleOpenRestock(supplier.id, linkedProducts[0].id);
                          }}
                          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 font-bold rounded-lg text-white cursor-pointer transition text-[10px] shadow-sm"
                        >
                          Surtir Productos
                        </button>}

                        {canManageSuppliers ? (
                          <div className="flex space-x-1">
                            <button
                              onClick={() => handleOpenSupplierModal(supplier)}
                              className="p-1 px-2.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition font-semibold text-[10px] border border-transparent hover:border-slate-200"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => handleDeleteSupplier(supplier.id)}
                              className="p-1 px-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition font-semibold text-[10px]"
                              title="Eliminar Proveedor"
                            >
                              Eliminar
                            </button>
                          </div>
                        ) : (
                          <span
                            className="text-[9px] text-slate-400 font-bold select-none py-1 flex items-center gap-1"
                            title="Solo el Dueño, o quien tenga el permiso de proveedores, puede editar o eliminar proveedores"
                          >
                            <ShieldCheck className="w-2.5 h-2.5" /> Solo Dueño
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SCREEN: FACTURACION E HISTORIAL DE TICKETS (INVOICING) */}
          {activeTab === 'invoicing' && canManageInvoicing && (
            <div className="bg-white p-4 lg:p-6 rounded-3xl shadow-xl border border-slate-100 flex-grow animate-in fade-in slide-in-from-bottom-4 relative mb-24 lg:mb-8 mx-auto w-full max-w-7xl">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b pb-5 mb-5 space-y-3 sm:space-y-0 relative z-10 w-full">
                <div>
                  <h2 className="text-xl md:text-2xl font-black text-slate-800 bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600 flex items-center gap-2">
                    <FileText className="w-8 h-8 text-blue-600" />
                    Facturación Electrónica CFDI
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Gestiona las facturas pendientes por emitir y el historial de folios generados{isOwner ? '.' : ' de tu sucursal.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <select 
                    value={invoiceStatusFilter} 
                    onChange={e => setInvoiceStatusFilter(e.target.value as 'all' | 'pending' | 'completed')}
                    className="px-3 py-2 text-xs font-bold bg-slate-50 border border-slate-200 rounded-xl text-slate-700 outline-none flex-1 sm:flex-none cursor-pointer"
                  >
                    <option value="all">Ver Todas</option>
                    <option value="pending">Solo Pendientes</option>
                    <option value="completed">Realizadas</option>
                  </select>
                </div>
              </div>

              {/* Rendering list of sales that require invoice */}
              {invoiceSales.filter(s => invoiceStatusFilter === 'all' || s.invoiceStatus === invoiceStatusFilter).length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                  {invoiceSales.filter(s => invoiceStatusFilter === 'all' || s.invoiceStatus === invoiceStatusFilter).map(sale => (
                    <div key={sale.id} className="border border-slate-200 rounded-xl p-4 shadow-sm bg-white hover:border-indigo-200 transition">
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-bold text-slate-700 text-sm">{sale.id}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          sale.invoiceStatus === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {sale.invoiceStatus === 'completed' ? 'Facturado' : 'Pendiente'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mb-2">
                        <div>Cliente: <span className="font-bold">{sale.customerName || 'Público General'}</span></div>
                        <div>Fecha: {sale.timestamp}</div>
                        <div className="mt-1 font-bold">Conceptos:</div>
                        <div className="bg-slate-50 p-2 rounded truncate overflow-hidden text-[10px] border border-slate-100 mt-1">
                          {sale.items.map(i => `${i.quantity}x ${i.name}`).join(', ')}
                        </div>
                      </div>
                      <div className="flex justify-between items-center mt-3 pt-3 border-t border-slate-100">
                        <span className="text-xs font-black text-slate-800">Total: {formatMXN(sale.total)}</span>
                        {sale.invoiceStatus !== 'completed' && (
                          <button
                            onClick={() => handleSetInvoiceStatus(sale.id, 'completed')}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm"
                          >
                            Marcar Facturado
                          </button>
                        )}
                        {sale.invoiceStatus === 'completed' && (
                          <button
                            onClick={() => handleSetInvoiceStatus(sale.id, 'pending')}
                            className="text-slate-400 hover:text-slate-600 underline text-[10px] font-bold p-1"
                          >
                            Revertir
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-slate-50/50 rounded-2xl border border-slate-100 p-8 flex flex-col items-center justify-center text-center space-y-4 mt-6 min-h-[50vh]">
                  <FileText className="w-20 h-20 text-indigo-200" />
                  <h3 className="text-xl font-black text-slate-700 tracking-tight">Módulo de Facturación Electrónica</h3>
                  <p className="text-slate-500 text-sm max-w-md">
                    No hay facturas que coincidan con tu búsqueda.<br/>
                    Aquí aparecerán las ventas marcadas para facturar.
                  </p>
                  <div className="text-[11px] bg-amber-50 text-amber-700 px-4 py-3 rounded-xl border border-amber-200 mt-4 font-bold max-w-md shadow-sm flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>El proceso de timbrado CFDI (facturación) requerirá registrar las credenciales y certificados (CSD) del SAT en la configuración avanzada. Esta es la pre-vista del módulo de control interno.</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SCREEN: EMPRESA Y EQUIPO (SETTINGS) */}
          {activeTab === 'settings' && isOwner && (
            (!user || !activeCompanyId) ? (
              <div className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-6 max-w-2xl mx-auto mt-6 text-center">
                <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto border border-rose-100">
                  <Settings className="w-8 h-8 text-rose-500 animate-spin-slow" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-2xl font-black text-slate-800 tracking-tight">Configuración de Empresa y Nube</h3>
                  <p className="text-slate-500 text-sm max-w-md mx-auto">
                    Para activar la gestión de sucursales, control de roles (Propietario, Admin, Empleado) y sincronización de inventario con tu equipo, es necesario conectar tu cuenta.
                  </p>
                </div>

                <div className="p-5 bg-indigo-50/50 rounded-2xl border border-indigo-100/60 text-left space-y-3.5">
                  <h4 className="font-bold text-slate-800 text-xs sm:text-sm flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-indigo-500 animate-pulse" />
                    Beneficios de Activar la Sincronización en la Nube:
                  </h4>
                  <ul className="text-[11px] sm:text-xs text-slate-600 space-y-2.5 pl-1">
                    <li className="flex items-start gap-1.5">
                      <span className="text-indigo-600 font-bold"><Check className="w-3.5 h-3.5" /></span>
                      <span><strong>Multi-Sucursal</strong>: Configura sucursales físicas y asigna inventario de catálogo independiente de sucursales.</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-indigo-600 font-bold"><Check className="w-3.5 h-3.5" /></span>
                      <span><strong>Control de Roles</strong>: Propietario (dueño general), Administrador (edición/inventario), Empleado (ventas POS únicamente).</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-indigo-600 font-bold"><Check className="w-3.5 h-3.5" /></span>
                      <span><strong>Acceso con Código</strong>: Genera códigos únicos estilo invitación para que tus colaboradores entren con un clic.</span>
                    </li>
                  </ul>
                </div>

                <div className="flex flex-col sm:flex-row justify-center gap-3 pt-2">
                  {/* `user` is always set here — the login gate already returned early otherwise. */}
                  <div className="space-y-4 w-full">
                    <p className="text-xs text-amber-600 font-semibold bg-amber-50 rounded-lg p-2.5 inline-flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" /> Estás conectado como {user.email} pero no tienes ninguna Empresa activa.
                    </p>
                    <button
                      onClick={() => {
                        // Allow choosing / creating a company - clear any storage and let screen display selection
                        safeLocalStorageRemove(`logic_active_company_${user.uid}`);
                        setActiveCompanyId(null);
                      }}
                      className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-sm rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2 mx-auto"
                    >
                      <Building2 className="w-4 h-4" />
                      <span>Abrir Panel de Selección de Empresa</span>
                    </button>
                  </div>
                </div>

                {/* Local actions catalog */}
                <div className="pt-6 border-t border-slate-100 flex flex-col items-center gap-3">
                  <span className="text-[10px] text-slate-400 font-bold tracking-wider uppercase">Acciones Locales</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        if (confirm('¿Desea restablecer todos los productos y ventas locales a los valores por defecto del sistema?')) {
                          localStorage.clear();
                          window.location.reload();
                        }
                      }}
                      className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-800 text-xs font-bold rounded-lg cursor-pointer transition"
                    >
                      Restablecer Base de Datos Local
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              // When user is authenticated AND has an activeCompanyId successfully connected
              <CompanySettingsView
                companyId={activeCompanyId}
                companyName={userCompanies[activeCompanyId]?.name || 'Mi Comercio'}
                currentUserRole={activeCompanyRole}
                currentUserId={user.uid}
                userAvailableCompanies={userCompanies}
                onSwitchCompany={(id) => {
                  safeLocalStorageSet(`logic_active_company_${user.uid}`, id);
                  setActiveCompanyId(id);
                  setActiveTab('pos');
                }}
                onLogoutCompany={() => signOut(auth)}
                onCreateCompany={handleCreateCompany}
                branches={branches}
                products={products}
                sales={sales}
                suppliers={suppliers}
                customers={customers}
                customCategories={customCategories}
                onGoogleSignInForBackup={async () => {
                  try {
                    if (isNativePlatform) {
                      // On native, user is already signed in via redirect — return cached token
                      return getCachedAccessToken();
                    }
                    // Uses the Drive-scoped provider — this is the only place the app
                    // requests Google Drive access, kept separate from the everyday login.
                    const result = await signInWithPopup(auth, driveGoogleProvider);
                    const credential = GoogleAuthProvider.credentialFromResult(result);
                    if (credential?.accessToken) {
                      setCachedAccessToken(credential.accessToken);
                      return credential.accessToken;
                    }
                    return null;
                  } catch (e) {
                    console.error("Popup login error in setting sync:", e);
                    throw e;
                  }
                }}
                onRestoreCompanyData={handleRestoreCompanyData}
                branding={branding}
                onSaveBranding={async (newBranding: Branding) => {
                  if (!activeCompanyId) return;
                  const isValidHex = (v: unknown) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
                  // Strip undefined/empty values; also reject malformed hex colors
                  const cleaned = Object.fromEntries(
                    Object.entries(newBranding).filter(([k, v]) => {
                      if (v === undefined || v === '') return false;
                      if (['primaryColor','accentColor','darkColor'].includes(k)) return isValidHex(v);
                      return true;
                    })
                  );
                  await setDoc(doc(db, 'companies', activeCompanyId, 'settings', 'branding'), cleaned, { merge: true });
                }}
                printConfig={printConfig}
                onSavePrintConfig={async (newConfig: PrintConfig) => {
                  if (!activeCompanyId) return;
                  await setDoc(doc(db, 'companies', activeCompanyId, 'settings', 'printConfig'), newConfig, { merge: true });
                }}
                isNativePlatform={isNativePlatform}
                bluetoothPrinter={bluetoothPrinter}
                onScanBluetoothPrinters={handleScanBluetoothPrinters}
                onSelectBluetoothPrinter={saveBluetoothPrinter}
                onTestPrintBluetooth={handleTestPrintBluetooth}
                webUsbSupported={isWebUsbSupported()}
                webBluetoothSupported={isWebBluetoothSupported()}
                webPrinterInfo={webPrinterInfo}
                onConnectWebUsbPrinter={handleConnectWebUsbPrinter}
                onConnectWebBluetoothPrinter={handleConnectWebBluetoothPrinter}
                onForgetWebPrinter={handleForgetWebPrinter}
                onTestPrintWeb={handleTestPrintWeb}
                isCredentialEmployee={isCredentialEmployee}
              />
            )
          )}

        </main>
      </div>

      {/* MODAL WINDOW: CREAR/EDITAR PRODUCTO */}
      {quickStockProduct && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center gap-2">
                <Plus className="w-5 h-5 text-emerald-600" /> Surtir Stock
              </h3>
              <button
                onClick={() => { setQuickStockProduct(null); setQuickStockAmount(''); }}
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-sm space-y-1">
              <p className="font-extrabold text-slate-800">{quickStockProduct.name}</p>
              <p className="text-xs text-slate-500">
                Sucursal: <span className="font-bold text-slate-700">{branches.find(b => b.id === operationalBranchId)?.name || 'No asignada'}</span>
              </p>
              <p className="text-xs text-slate-500">
                Stock actual: <span className="font-bold text-slate-700">{getProductStock(quickStockProduct, operationalBranchId, products)} u.</span>
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 block">Unidades a agregar</label>
              <input
                type="number"
                step="0.01"
                autoFocus
                placeholder="Ej: 20"
                value={quickStockAmount}
                onChange={e => setQuickStockAmount(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !isSavingQuickStock) handleQuickAddStock(); }}
                className="w-full text-lg font-black text-center bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-slate-400 text-center">Se suma al stock existente (usa negativo para descontar una merma).</p>
            </div>

            {quickStockAmount && !isNaN(parseFloat(quickStockAmount)) && parseFloat(quickStockAmount) !== 0 && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-2.5 text-center text-xs font-bold text-emerald-800">
                Nuevo stock: {getProductStock(quickStockProduct, operationalBranchId, products)} → {Math.max(0, getProductStock(quickStockProduct, operationalBranchId, products) + parseFloat(quickStockAmount))} u.
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setQuickStockProduct(null); setQuickStockAmount(''); }}
                className="w-1/3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isSavingQuickStock}
                onClick={handleQuickAddStock}
                className="w-2/3 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black rounded-xl cursor-pointer transition disabled:opacity-50"
              >
                {isSavingQuickStock ? 'Guardando...' : 'Agregar al Stock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isProductModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-xl text-slate-800">
                {editingProduct ? 'Editar Producto del Catálogo' : 'Crear Nuevo Producto POS'}
              </h3>
              <button 
                onClick={() => setIsProductModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Nombre del Artículo *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ej: Sándwich de Pavita"
                    value={prodForm.name}
                    onChange={e => setProdForm({ ...prodForm, name: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Categoría de Alimento / General</label>
                  {newCatPrompt ? (
                    <div className="flex items-center gap-2">
                       <input 
                         autoFocus
                         type="text" 
                         value={newCatName}
                         onChange={e => setNewCatName(e.target.value)}
                         placeholder="Nueva categoría..."
                         className="w-full text-xs bg-white border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                       />
                       <button
                         type="button"
                         onClick={() => {
                           if (newCatName.trim()) {
                             setProdForm({ ...prodForm, category: newCatName.trim() });
                           }
                           setNewCatPrompt(false);
                         }}
                         className="bg-indigo-600 text-white px-3 py-2 rounded-lg font-bold text-xs hover:bg-indigo-700 inline-flex items-center justify-center"
                       >
                         <Check className="w-4 h-4" />
                       </button>
                       <button
                         type="button"
                         onClick={() => setNewCatPrompt(false)}
                         className="bg-slate-200 text-slate-600 px-3 py-2 rounded-lg font-bold text-xs"
                       >
                         X
                       </button>
                    </div>
                  ) : (
                    <select
                      value={prodForm.category || 'Generales'}
                      onChange={e => {
                        if (e.target.value === '__new__') {
                          setNewCatName('');
                          setNewCatPrompt(true);
                        } else {
                          setProdForm({ ...prodForm, category: e.target.value });
                        }
                      }}
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-50 font-bold text-slate-700"
                    >
                      {!prodForm.category && <option value="">-- Seleccionar Categoría --</option>}
                      {selectCategoriesList.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                      <option value="__new__" className="text-indigo-600 font-bold">+ Crear Nueva Categoría...</option>
                    </select>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Costo de Producción / Proveedor ($)</label>
                  <input 
                    type="number"
                    step="0.01"
                    placeholder="Ej: 1.50"
                    value={prodForm.costPrice}
                    onChange={e => setProdForm({ ...prodForm, costPrice: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Precio de Caja Registradora ($) *</label>
                  <input 
                    type="number"
                    step="0.01"
                    required
                    placeholder="Ej: 4.99"
                    value={prodForm.salePrice}
                    onChange={e => setProdForm({ ...prodForm, salePrice: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  {prodForm.linkedStockProductId ? (
                    <>
                      <label className="text-xs font-bold text-slate-500 block">Stock Inicial en Almacén</label>
                      <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                        Este producto usa el stock de{' '}
                        <strong>{products.find(p => p.id === prodForm.linkedStockProductId)?.name || '—'}</strong>.
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="text-xs font-bold text-slate-500 block">Stock Inicial en Almacén</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Ej: 20"
                        value={prodForm.stock}
                        onChange={e => setProdForm({ ...prodForm, stock: e.target.value })}
                        className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                      />
                    </>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Alerta de Stock Mínimo Crítico</label>
                  <input 
                    type="number"
                    placeholder="Ej: 5"
                    value={prodForm.minStock}
                    onChange={e => setProdForm({ ...prodForm, minStock: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-bold text-slate-500 block">Código SKU del Producto (Opcional)</label>
                  <input 
                    type="text"
                    placeholder="Ej: SKU-92813"
                    value={prodForm.sku}
                    onChange={e => setProdForm({ ...prodForm, sku: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-bold text-slate-500 block">Proveedor Vinculado (Surtido)</label>
                  <select
                    value={prodForm.supplierId}
                    onChange={e => setProdForm({ ...prodForm, supplierId: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-semibold text-slate-700"
                  >
                    <option value="">-- Sin Proveedor (Ninguno) --</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                    ))}
                  </select>
                </div>

                {!prodForm.isStockPool && (
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 block">Vincular Stock a Producto Padre</label>
                    <select
                      value={prodForm.linkedStockProductId}
                      onChange={e => setProdForm({ ...prodForm, linkedStockProductId: e.target.value })}
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-semibold text-slate-700"
                    >
                      <option value="">-- Sin Vincular (Stock Propio) --</option>
                      {products
                        .filter(p => p.id !== editingProduct?.id && !p.linkedStockProductId)
                        .map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                  </div>
                )}

                {prodForm.linkedStockProductId && (
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 block">Factor de Consumo (cuánto del fondo consume 1 unidad, ej. 0.5 = mitad, 1 = completo)</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      placeholder="Ej: 0.5"
                      value={prodForm.stockConsumptionFactor}
                      onChange={e => setProdForm({ ...prodForm, stockConsumptionFactor: e.target.value })}
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                    />
                  </div>
                )}

                {!prodForm.linkedStockProductId && (
                  <div className="space-y-1 md:col-span-2">
                    <label className="flex items-center gap-2 text-xs font-bold text-slate-500 cursor-pointer bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                      <input
                        type="checkbox"
                        checked={prodForm.isStockPool}
                        onChange={e => setProdForm({ ...prodForm, isStockPool: e.target.checked })}
                      />
                      Es un fondo de stock compartido — nunca se vende directo, pero otros productos pueden vincularse a su stock
                    </label>
                  </div>
                )}

              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button 
                  type="button" 
                  onClick={() => setIsProductModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer shadow"
                >
                  Guardar Artículo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: PRODUCTO CON PRESENTACIONES (asistente de alta rapida para stock compartido) */}
      {isBulkProductModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <div>
                <h3 className="font-extrabold text-xl text-slate-800">Producto con Presentaciones</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Crea un producto que funciona como fondo de stock compartido, junto con todas sus
                  presentaciones (las variantes que sí se venden por separado), en un solo paso.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsBulkProductModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveBulkProductGroup} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Nombre Base *</label>
                  <input
                    type="text"
                    required
                    placeholder="Nombre del producto principal"
                    value={bulkForm.baseName}
                    onChange={e => setBulkForm({ ...bulkForm, baseName: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Categoría *</label>
                  <input
                    type="text"
                    required
                    list="bulk-category-options"
                    placeholder="Categoría del producto"
                    value={bulkForm.category}
                    onChange={e => setBulkForm({ ...bulkForm, category: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                  <datalist id="bulk-category-options">
                    {selectCategoriesList.map(cat => <option key={cat} value={cat} />)}
                  </datalist>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Stock Inicial (unidades del fondo compartido)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Ej: 5"
                    value={bulkForm.initialStock}
                    onChange={e => setBulkForm({ ...bulkForm, initialStock: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Costo del Fondo ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Ej: 1.50"
                    value={bulkForm.costPrice}
                    onChange={e => setBulkForm({ ...bulkForm, costPrice: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Alerta de Stock Mínimo del Fondo</label>
                  <input
                    type="number"
                    placeholder="Ej: 5"
                    value={bulkForm.minStock}
                    onChange={e => setBulkForm({ ...bulkForm, minStock: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 block">Código SKU del Fondo (Opcional)</label>
                  <input
                    type="text"
                    placeholder="Ej: SKU-92813"
                    value={bulkForm.sku}
                    onChange={e => setBulkForm({ ...bulkForm, sku: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-bold text-slate-500 block">Proveedor Vinculado del Fondo (Surtido)</label>
                  <select
                    value={bulkForm.supplierId}
                    onChange={e => setBulkForm({ ...bulkForm, supplierId: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500 font-semibold text-slate-700"
                  >
                    <option value="">-- Sin Proveedor (Ninguno) --</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold text-slate-500 block">Presentaciones (lo que se vende) *</label>
                {bulkForm.presentations.map((pres, idx) => (
                  <div key={idx} className="border border-slate-200 rounded-xl p-3 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_auto] gap-2 items-center">
                      <input
                        type="text"
                        placeholder="Nombre de esta presentación"
                        value={pres.suffix}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], suffix: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="w-full min-w-0 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                      />
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Precio de venta"
                        value={pres.price}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], price: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="w-full min-w-0 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                      />
                      <input
                        type="number"
                        step="0.01"
                        title="Factor de consumo del fondo compartido"
                        placeholder="Factor"
                        value={pres.factor}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], factor: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="w-full min-w-0 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-violet-500"
                      />
                      <button
                        type="button"
                        disabled={bulkForm.presentations.length <= 1}
                        onClick={() => setBulkForm({ ...bulkForm, presentations: bulkForm.presentations.filter((_, i) => i !== idx) })}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
                      <input
                        type="number"
                        step="0.01"
                        placeholder="Costo ($)"
                        value={pres.costPrice}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], costPrice: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:border-violet-500"
                      />
                      <input
                        type="number"
                        placeholder="Alerta mínima"
                        value={pres.minStock}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], minStock: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:border-violet-500"
                      />
                      <input
                        type="text"
                        placeholder="SKU (opcional)"
                        value={pres.sku}
                        onChange={e => {
                          const next = [...bulkForm.presentations];
                          next[idx] = { ...next[idx], sku: e.target.value };
                          setBulkForm({ ...bulkForm, presentations: next });
                        }}
                        className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:border-violet-500"
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setBulkForm({ ...bulkForm, presentations: [...bulkForm.presentations, { suffix: '', price: '', factor: '1', costPrice: '', sku: '', minStock: '' }] })}
                  className="text-xs font-bold text-violet-600 hover:text-violet-700 cursor-pointer"
                >
                  + Agregar presentación
                </button>
                <p className="text-[10px] text-slate-400">
                  El "Factor" es cuánto del fondo compartido consume una unidad de esa presentación
                  (ej. 0.5 si media unidad de la presentación equivale a medio del fondo, 1 si equivale
                  a una unidad completa). Costo, Alerta mínima y SKU son opcionales por presentación.
                </p>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setIsBulkProductModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold rounded-xl cursor-pointer shadow"
                >
                  Crear Producto y Presentaciones
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: CREAR/EDITAR CLIENTE */}
      {isCustomerModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800">
                {editingCustomer ? 'Modificar Perfil del Cliente' : 'Registrar Nuevo Cliente'}
              </h3>
              <button onClick={() => setIsCustomerModalOpen(false)} className="p-1 text-slate-400 hover:text-slate-700 bg-slate-100 rounded-full">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCustomer} className="space-y-4 text-xs">
              <div className="space-y-3">
                <div>
                  <label className="font-bold text-slate-500 block mb-1">Nombre Completo *</label>
                  <input 
                    type="text"
                    required
                    placeholder="Ej: Daniel José"
                    value={custForm.name}
                    onChange={e => setCustForm({ ...custForm, name: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-semibold"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-500 block mb-1 font-sans">Número Telefónico (Contacto)</label>
                  <input 
                    type="text"
                    placeholder="Ej: 555-1202"
                    value={custForm.phone}
                    onChange={e => setCustForm({ ...custForm, phone: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-500 block mb-1">Correo Electrónico</label>
                  <input 
                    type="email"
                    placeholder="Ej: cliente@correo.com"
                    value={custForm.email}
                    onChange={e => setCustForm({ ...custForm, email: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t text-xs font-bold">
                <button 
                  type="button" 
                  onClick={() => setIsCustomerModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg cursor-pointer shadow"
                >
                  Guardar Cliente
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: TRANSFERENCIA MULTI-SUCURSAL / REPARTO DESDE MATRIZ */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <Store className="w-5 h-5 mr-2 text-indigo-600" />
                <Package className="w-3.5 h-3.5 inline mr-1" /><span>Transferencia e Inventario</span>
              </h3>
              <button
                onClick={() => { setIsTransferModalOpen(false); setTransferProductSearch(''); }}
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 max-h-[65vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3 text-left">
                <div>
                  <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">Origen:</label>
                  {isOwner ? (
                    <select
                      value={transferSourceBranchId}
                      onChange={(e) => setTransferSourceBranchId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 text-xs font-bold outline-none focus:border-indigo-500 transition mt-1.5"
                    >
                      <option value="">Selecciona origen...</option>
                      {branches.map(b => (
                        <option key={b.id} value={b.id}>
                          {b.name} {b.isMatriz ? '(Matriz)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 text-xs font-bold mt-1.5">
                      {branches.find(branch => branch.id === operationalBranchId)?.name || 'Sucursal no asignada'}
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">Destino / Reparto:</label>
                  <select
                    value={transferTargetBranchId}
                    onChange={(e) => setTransferTargetBranchId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 text-xs font-bold outline-none focus:border-indigo-500 transition mt-1.5"
                  >
                    <option value="">Selecciona destino...</option>
                    {branches.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.name} {b.isMatriz ? '(Matriz)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="text-left">
                <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">Agregar producto:</label>
                <div className="relative mt-1.5">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={transferProductSearch}
                    onChange={(e) => setTransferProductSearch(e.target.value)}
                    placeholder="Buscar por nombre o categoría..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-2.5 text-slate-800 text-xs font-bold outline-none focus:border-indigo-500 transition"
                  />
                </div>
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto pr-0.5">
                  {transferProductOptions.length === 0 && (
                    <p className="text-[10px] text-slate-400 font-semibold text-center py-3">Ningún producto coincide.</p>
                  )}
                  {transferProductOptions.map(p => {
                    const inList = transferItems.find(it => it.productId === p.id);
                    const available = getProductStock(p, transferSourceBranchId, products);
                    return (
                      <div
                        key={p.id}
                        onClick={() => inList ? removeTransferItem(p.id) : addTransferItem(p.id)}
                        className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition ${inList ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                      >
                        <input type="checkbox" checked={!!inList} readOnly className="pointer-events-none accent-indigo-600" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700 truncate">{p.name}</p>
                          <p className="text-[10px] text-slate-400">{available} u. disponibles | {p.category || 'Sin Cat'}</p>
                        </div>
                        {inList && (
                          <input
                            type="number"
                            min="1"
                            value={inList.quantity}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => updateTransferItemQty(p.id, parseInt(e.target.value) || 1)}
                            className="w-14 bg-white border border-slate-200 rounded-lg px-2 py-1 text-slate-800 text-xs font-black outline-none focus:border-indigo-500 transition text-center shrink-0"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {transferItems.length > 0 && (
                <div className="space-y-2 text-left">
                  <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">Productos a transferir ({transferItems.length}):</label>
                  {transferItems.map(item => {
                    const prod = products.find(p => p.id === item.productId);
                    const available = prod && transferSourceBranchId ? getProductStock(prod, transferSourceBranchId, products) : 0;
                    const exceeds = transferSourceBranchId ? item.quantity > available : false;
                    return (
                      <div key={item.productId} className={`flex items-center gap-2 p-2.5 rounded-xl border ${exceeds ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700 truncate">{prod?.name || 'Producto no encontrado'}</p>
                          {transferSourceBranchId && (
                            <p className={`text-[10px] font-bold ${exceeds ? 'text-red-600' : 'text-slate-400'}`}>
                              Disponible en origen: {available} u.
                            </p>
                          )}
                        </div>
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateTransferItemQty(item.productId, parseInt(e.target.value) || 1)}
                          className="w-16 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-800 text-xs font-black outline-none focus:border-indigo-500 transition text-center"
                        />
                        <button
                          type="button"
                          onClick={() => removeTransferItem(item.productId)}
                          className="p-1.5 text-red-500 hover:bg-red-100 rounded-lg transition cursor-pointer shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex gap-2.5 pt-3">
              <button
                type="button"
                onClick={() => { setIsTransferModalOpen(false); setTransferProductSearch(''); }}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition text-center cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleExecuteTransfer}
                disabled={transferItems.length === 0 || firestoreConnectionState !== 'ready'}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition text-center cursor-pointer shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {firestoreConnectionState === 'checking'
                  ? 'Verificando conexión...'
                  : firestoreConnectionState !== 'ready'
                  ? 'Sin conexión'
                  : 'Confirmar Traspaso'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: REGISTRAR/EDITAR SUCURSAL */}
      {isBranchModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <Store className="w-5 h-5 mr-2 text-teal-600" />
                {editingBranch ? 'Modificar Sucursal' : 'Registrar Nueva Sucursal'}
              </h3>
              <button 
                onClick={() => setIsBranchModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveBranch} className="space-y-4 text-xs font-semibold">
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Nombre de la Sucursal *</label>
                  <input 
                    type="text"
                    required
                    placeholder="Ej: Sucursal Oriente - Express"
                    value={branchForm.name}
                    onChange={e => setBranchForm({ ...branchForm, name: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-teal-500 font-bold text-slate-700"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Dirección Física</label>
                  <input 
                    type="text"
                    placeholder="Ej: Av. Central No. 420, Col. Centro"
                    value={branchForm.address}
                    onChange={e => setBranchForm({ ...branchForm, address: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-teal-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Teléfono / Contacto</label>
                  <input 
                    type="text"
                    placeholder="Ej: 555-9201"
                    value={branchForm.phone}
                    onChange={e => setBranchForm({ ...branchForm, phone: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-teal-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Gerente / Responsable de Sucursal</label>
                  <select 
                    value={branchForm.manager}
                    onChange={e => setBranchForm({ ...branchForm, manager: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-teal-500 font-bold text-slate-700 cursor-pointer"
                  >
                    <option value="">-- Selecciona un Gerente --</option>
                    {branchForm.manager && !members.filter(m => m.role === 'owner' || m.role === 'admin').some(m => m.name === branchForm.manager) && (
                      <option value={branchForm.manager}>{branchForm.manager}</option>
                    )}
                    {members.filter(m => m.role === 'owner' || m.role === 'admin').map(member => (
                      <option key={member.userId} value={member.name}>
                        {member.name} ({member.role === 'owner' ? 'Propietario' : 'Administrador'})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1 pt-1">
                  <div className="flex items-start space-x-2.5 p-3 bg-teal-50/40 border border-teal-100 rounded-xl">
                    <input 
                      type="checkbox" 
                      id="branch-is-matriz"
                      checked={branchForm.isMatriz}
                      onChange={e => setBranchForm({ ...branchForm, isMatriz: e.target.checked })}
                      className="w-4 h-4 text-teal-600 focus:ring-teal-500 border-slate-300 rounded cursor-pointer mt-0.5"
                    />
                    <div>
                      <label htmlFor="branch-is-matriz" className="text-slate-800 font-extrabold cursor-pointer flex items-center gap-1 text-xs">Definir como Matriz Principal <Building2 className="w-3.5 h-3.5" /></label>
                      <span className="text-[10px] text-slate-500 leading-tight block font-normal">Fabrica materia prima, almacena el inventario central y permite repartir stock a otras sucursales.</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t text-xs font-bold">
                <button 
                  type="button" 
                  onClick={() => setIsBranchModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer shadow-md"
                >
                  Guardar Sucursal
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: REGISTRAR/EDITAR PROVEEDOR */}
      {isSupplierModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <Truck className="w-5 h-5 mr-2 text-amber-600" />
                {editingSupplier ? 'Modificar Proveedor' : 'Registrar Nuevo Proveedor'}
              </h3>
              <button 
                onClick={() => setIsSupplierModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSupplier} className="space-y-4 text-xs font-semibold">
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Nombre de la Distribuidora / Marca *</label>
                  <input 
                    type="text"
                    required
                    placeholder="Ej: Carnes y Embutidos S.A."
                    value={supplierForm.name}
                    onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500 font-bold text-slate-700"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Nombre del Ejecutivo de Contacto</label>
                  <input 
                    type="text"
                    placeholder="Ej: Ing. Jorge Valdés"
                    value={supplierForm.contactName}
                    onChange={e => setSupplierForm({ ...supplierForm, contactName: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-slate-500 font-bold block">Teléfono de Surtido</label>
                    <input 
                      type="text"
                      placeholder="Ej: 555-8833"
                      value={supplierForm.phone}
                      onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-500 font-bold block">Giro / Categoría Comercial</label>
                    <select
                      value={supplierForm.category}
                      onChange={e => setSupplierForm({ ...supplierForm, category: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500 text-slate-700 font-bold"
                    >
                      <option value="General">General</option>
                      <option value="Alimentos">Alimentos</option>
                      <option value="Bebidas">Bebidas</option>
                      <option value="Postres">Postres</option>
                      <option value="Insumos">Insumos</option>
                      <option value="Empaque">Empaque</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Correo de Pedidos Corporativos</label>
                  <input 
                    type="email"
                    placeholder="Ej: pedidos@distribuidora.com"
                    value={supplierForm.email}
                    onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500 font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Ubicación / Almacén del Proveedor</label>
                  <input 
                    type="text"
                    placeholder="Ej: Parque Industrial No. 12"
                    value={supplierForm.address}
                    onChange={e => setSupplierForm({ ...supplierForm, address: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-amber-500"
                  />
                </div>

                <div className="space-y-1.5 pt-1.5 border-t border-slate-100">
                  <label className="text-slate-500 font-extrabold block">Productos que surten a este negocio:</label>
                  {products.length === 0 ? (
                    <p className="text-[10px] text-slate-400 font-medium">No hay productos registrados en el catálogo.</p>
                  ) : (
                    <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg p-2 bg-slate-50 space-y-1.5">
                      {products.map(prod => {
                        const isChecked = supplierProductIds.includes(prod.id);
                        return (
                          <label key={prod.id} className="flex items-center space-x-2 text-[11px] text-slate-700 font-bold cursor-pointer hover:text-indigo-600">
                            <input 
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                if (isChecked) {
                                  setSupplierProductIds(prev => prev.filter(id => id !== prod.id));
                                } else {
                                  setSupplierProductIds(prev => [...prev, prod.id]);
                                }
                              }}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                            />
                            <span>{prod.name} (Stock: {getProductStock(prod, operationalBranchId, products)})</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                    Selecciona los insumos o productos del catálogo que son provistos por esta distribuidora.
                  </p>
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t text-xs font-bold">
                <button 
                  type="button" 
                  onClick={() => setIsSupplierModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg cursor-pointer shadow-md"
                >
                  Guardar Proveedor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: SURTIDO / REABASTECIMIENTO DE PRODUCTOS */}
      {isRestockOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <ArrowLeft className="w-5 h-5 mr-2 text-indigo-600 rotate-180" />
                Registrar un Reabastecimiento
              </h3>
              <button 
                onClick={() => setIsRestockOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveRestock} className="space-y-4 text-xs font-semibold">
              <div className="space-y-3">
                {/* Supplier selection filter */}
                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Proveedor Suministrante *</label>
                  <select
                    value={restockForm.supplierId}
                    onChange={e => {
                      // Autopick first product of selected supplier
                      const matched = products.find(p => p.supplierId === e.target.value);
                      setRestockForm({
                        ...restockForm,
                        supplierId: e.target.value,
                        productId: matched ? matched.id : (products[0]?.id || '')
                      });
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 text-slate-700 font-bold"
                  >
                    <option value="">-- Seleccione proveedor --</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                    ))}
                  </select>
                </div>

                {/* Product choice selection, filtered or overall */}
                <div className="space-y-1">
                  <label className="text-slate-500 font-bold block">Producto a Surtir *</label>
                  <select
                    value={restockForm.productId}
                    onChange={e => {
                      const matchedProd = products.find(p => p.id === e.target.value);
                      setRestockForm({
                        ...restockForm,
                        productId: e.target.value,
                        // Autofill Cost price recorded on product catalog as suggestion
                        cost: matchedProd ? matchedProd.costPrice.toString() : ''
                      });
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 text-slate-700 font-bold"
                  >
                    <option value="">-- Seleccione el artículo --</option>
                    {(restockForm.supplierId
                      ? products.filter(p => p.supplierId === restockForm.supplierId)
                      : products
                    ).filter(p => !p.linkedStockProductId).map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} (Stock Actual: {getProductStock(p, operationalBranchId, products)})
                      </option>
                    ))}
                  </select>
                  {restockForm.supplierId && products.filter(p => p.supplierId === restockForm.supplierId).length === 0 && (
                    <p className="text-[10px] text-amber-600 font-bold mt-1">Este proveedor no tiene artículos dedicados. Se muestran todos los productos del catálogo.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-slate-500 font-bold block">Cantidad a Ingresar *</label>
                    <input 
                      type="number"
                      required
                      min="1"
                      placeholder="Ej: 24"
                      value={restockForm.qty}
                      onChange={e => setRestockForm({ ...restockForm, qty: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 text-slate-700 font-bold"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-500 font-bold block">Costo Unitario ($) *</label>
                    <input 
                      type="number"
                      step="0.01"
                      required
                      min="0.01"
                      placeholder="Ej: 1.50"
                      value={restockForm.cost}
                      onChange={e => setRestockForm({ ...restockForm, cost: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 text-slate-700 font-bold"
                    />
                  </div>
                </div>

                {/* Live total output layout */}
                {restockForm.qty && restockForm.cost && !isNaN(parseInt(restockForm.qty)) && !isNaN(parseFloat(restockForm.cost)) && (
                  <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-xl space-y-1">
                    <div className="flex justify-between items-center text-xs font-bold text-indigo-900">
                      <span>Total Egreso en Caja:</span>
                      <span className="text-sm font-black text-indigo-600">
                        {formatMXN(parseInt(restockForm.qty) * parseFloat(restockForm.cost))}
                      </span>
                    </div>
                    <p className="text-[9px] text-slate-500 leading-tight">El egreso se descontará automáticamente de la caja si hay suficiente saldo o con autorización de saldo negativo.</p>
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t text-xs font-bold">
                <button 
                  type="button" 
                  onClick={() => setIsRestockOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg cursor-pointer"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  disabled={isSavingRestock}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white rounded-lg cursor-pointer disabled:cursor-not-allowed shadow-md"
                >
                  {isSavingRestock ? 'Confirmando...' : 'Confirmar Egreso y Surtido'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: EDITAR CATEGORIAS GLOBALES */}
      {isCategoryModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <Layers className="w-5 h-5 mr-2 text-indigo-600 animate-pulse" />
                Editar Categorías
              </h3>
              <button 
                type="button"
                onClick={() => setIsCategoryModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Form to add a new category */}
              <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl space-y-2">
                <label className="text-indigo-800 font-extrabold flex items-center gap-1">Crear Nueva Categoría <Tag className="w-3.5 h-3.5" /></label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Ej: Snacks, Combos, Promos"
                    value={newCategoryInput}
                    onChange={e => setNewCategoryInput(e.target.value)}
                    className="flex-grow bg-white border border-slate-200 rounded-lg px-2 py-1.5 outline-none font-bold text-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddCategory(newCategoryInput)}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-lg text-center cursor-pointer transition"
                  >
                    Añadir
                  </button>
                </div>
              </div>

              <p className="text-slate-500 leading-relaxed font-semibold">
                Al renombrar una categoría, todos los artículos de tu catálogo pertenecientes a ella se actualizarán automáticamente.
              </p>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {selectCategoriesList.map(cat => (
                  <div key={cat} className="p-2 bg-slate-50 border border-slate-200 rounded-xl">
                    <CategorySelectorRowItem
                      cat={cat}
                      onRename={(oldName, newName) => {
                        handleRenameCategory(oldName, newName);
                      }}
                    />
                  </div>
                ))}
              </div>

              <div className="flex justify-end pt-4 border-t text-xs font-bold">
                <button 
                  type="button"
                  onClick={() => setIsCategoryModalOpen(false)}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-md cursor-pointer transition w-full text-center"
                >
                  Listo / Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUCCESS TRANSACTION RECEIPT & SHARE OPTIONS WINDOW */}
      {lastCompletedSale && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-5 text-slate-800 text-left relative">
            {/* Back / close — always available so the receipt is never a dead-end */}
            <button
              type="button"
              onClick={() => setLastCompletedSale(null)}
              aria-label="Regresar al POS"
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer z-10"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="text-center space-y-1">
              <span className="inline-flex items-center justify-center p-3 bg-indigo-50 border border-indigo-100 rounded-full text-indigo-600 animate-bounce"><Sparkles className="w-6 h-6" /></span>
              <h3 className="font-extrabold text-xl text-slate-800">¡Venta Registrada!</h3>
              <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Ticket {lastCompletedSale.id}</p>
              {lastCompletedSale.employeeName && (
                <p className="text-[11px] text-slate-500 font-bold">Atendido por: <span style={{ color: 'var(--brand-primary)' }}>{lastCompletedSale.employeeName}</span></p>
              )}
            </div>

            {/* Micro compact ticket receipt section */}
            <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl text-xs space-y-2.5 font-mono">
              <div className="flex justify-between font-bold border-b border-dashed pb-2">
                <span>Artículos</span>
                <span>Subtotal</span>
              </div>
              <div className="space-y-1 select-text max-h-24 overflow-y-auto pr-1">
                {lastCompletedSale.items.map((it, idx) => (
                  <div key={idx} className="flex justify-between gap-2 text-slate-600">
                    <span className="min-w-0 break-words">{it.quantity}x {it.name}</span>
                    <span className="shrink-0">{formatMXN(it.salePrice * it.quantity)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-dashed pt-2 space-y-1 text-slate-500">
                <div className="flex justify-between text-[11px]">
                  <span>Subtotal:</span>
                  <span>{formatMXN(lastCompletedSale.subtotal)}</span>
                </div>
                {lastCompletedSale.discount > 0 && (
                  <div className="flex justify-between text-[11px] text-emerald-600">
                    <span>Descuento:</span>
                    <span>-{formatMXN(lastCompletedSale.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-[11px]">
                  <span>Impuesto:</span>
                  <span>{formatMXN(lastCompletedSale.tax)}</span>
                </div>
                <div className="flex justify-between font-black text-slate-800 border-t pt-1.5 text-sm">
                  <span>Total Neto:</span>
                  <span className="text-indigo-600">{formatMXN(lastCompletedSale.total)}</span>
                </div>
              </div>

              {/* Cash transaction change details helper if cash paid */}
              {lastCompletedSale.paymentMethod === 'Cash' && lastReceivedAmount > lastCompletedSale.total && (
                <div className="bg-amber-50 rounded-xl p-2.5 border border-amber-100/60 mt-2 text-[10px] space-y-0.5">
                  <div className="flex justify-between text-amber-800 font-bold">
                    <span>Efectivo Recibido:</span>
                    <span>{formatMXN(lastReceivedAmount)}</span>
                  </div>
                  <div className="flex justify-between text-amber-900 font-black">
                    <span>Cambio Entregado:</span>
                    <span>{formatMXN(lastReceivedAmount - lastCompletedSale.total)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Actions share buttons */}
            <div className="space-y-2">
              <span className="text-[10px] font-extrabold text-slate-400 uppercase block tracking-wider text-center">Enviar o Descargar Recibo</span>
              
              <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                <a
                  href={(() => {
                    let text = `*ℹ️ TICKET DE COMPRA - ${businessName}*\n`;
                    text += `=========================\n`;
                    text += `*ID de Venta:* ${lastCompletedSale.id}\n`;
                    text += `*Fecha/Hora:* ${lastCompletedSale.timestamp}\n`;
                    text += `*Método de Pago:* ${lastCompletedSale.paymentMethod === 'Cash' ? 'Efectivo' : lastCompletedSale.paymentMethod === 'Card' ? 'Tarjeta De/Cr' : lastCompletedSale.paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito/Fiado'}\n`;
                    if (lastCompletedSale.customerName) {
                      text += `*Cliente:* ${lastCompletedSale.customerName}\n`;
                    }
                    text += `=========================\n`;
                    text += `*Artículos:* \n`;
                    lastCompletedSale.items.forEach(it => {
                      text += `- ${it.quantity}x ${it.name} (${formatMXN(it.salePrice)} c/u) = *${formatMXN(it.salePrice * it.quantity)}*\n`;
                    });
                    text += `=========================\n`;
                    text += `*Subtotal:* ${formatMXN(lastCompletedSale.subtotal)}\n`;
                    if (lastCompletedSale.discount > 0) {
                      text += `*Descuento:* -${formatMXN(lastCompletedSale.discount)}\n`;
                    }
                    text += `*Impuestos:* ${formatMXN(lastCompletedSale.tax)}\n`;
                    text += `*Total Neto:* *${formatMXN(lastCompletedSale.total)}*\n`;
                    text += `=========================\n`;
                    text += `¡Gracias por su compra!\n`;
                    return `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
                  })()}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2.5 bg-emerald-50 hover:bg-emerald-100/80 border border-emerald-200 text-emerald-800 rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-center duration-150"
                >
                  <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                </a>

                <a
                  href={(() => {
                    const subject = `Recibo de Venta Nro ${lastCompletedSale.id} - ${businessName}`;
                    let body = `Estimado cliente,\n\n`;
                    body += `Le adjuntamos el detalle de su compra realizada el ${lastCompletedSale.timestamp}:\n\n`;
                    body += `Ticket: ${lastCompletedSale.id}\n`;
                    body += `Monto Total: ${formatMXN(lastCompletedSale.total)}\n\n`;
                    body += `Detalle de Artículos:\n`;
                    lastCompletedSale.items.forEach(it => {
                      body += `- ${it.quantity}x ${it.name} - ${formatMXN(it.salePrice * it.quantity)}\n`;
                    });
                    body += `\n¡Gracias por preferir nuestros servicios!\n\n${businessName}`;
                    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                  })()}
                  className="p-2.5 bg-sky-50 hover:bg-sky-100/80 border border-sky-200 text-sky-800 rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-center duration-150"
                >
                  <Mail className="w-3.5 h-3.5" /> Correo
                </a>
              </div>

              <button
                type="button"
                onClick={() => handlePrintReceipt(lastCompletedSale)}
                className="w-full p-2.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition"
              >
                <Printer className="w-4 h-4" /> Imprimir Ticket / Guardar PDF
              </button>
            </div>

            <button
              type="button"
              onClick={() => setLastCompletedSale(null)}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition shadow hover:shadow-md"
            >
              <ArrowLeft className="w-4 h-4" /> Regresar al POS / Nueva Venta
            </button>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: TRASPASO REGISTRADO (success + print) */}
      {lastCompletedTransfer && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-5 text-slate-800 text-left relative">
            <button
              type="button"
              onClick={() => setLastCompletedTransfer(null)}
              aria-label="Cerrar"
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition cursor-pointer z-10"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="text-center space-y-1">
              <span className="inline-flex items-center justify-center p-3 bg-indigo-50 border border-indigo-100 rounded-full text-indigo-600 animate-bounce"><Package className="w-6 h-6" /></span>
              <h3 className="font-extrabold text-xl text-slate-800">¡Traspaso Registrado!</h3>
              <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Folio {lastCompletedTransfer.id}</p>
              {lastCompletedTransfer.initiatedByName && (
                <p className="text-[11px] text-slate-500 font-bold">Iniciado por: <span style={{ color: 'var(--brand-primary)' }}>{lastCompletedTransfer.initiatedByName}</span></p>
              )}
            </div>

            <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl text-xs space-y-2.5 font-mono">
              <div className="flex justify-between text-slate-600">
                <span className="font-bold">Origen:</span>
                <span className="text-right">{lastCompletedTransfer.sourceBranchName}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span className="font-bold">Destino:</span>
                <span className="text-right">{lastCompletedTransfer.targetBranchName}</span>
              </div>
              <div className="border-t border-dashed pt-2 space-y-1 select-text max-h-24 overflow-y-auto pr-1">
                {lastCompletedTransfer.items.map((it, idx) => (
                  <div key={idx} className="flex justify-between text-slate-600">
                    <span>{it.quantity}x {it.productName}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handlePrintTransferTicket(lastCompletedTransfer)}
              className="w-full p-2.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition"
            >
              <Printer className="w-4 h-4" /> Imprimir Ticket de Traspaso
            </button>

            <button
              type="button"
              onClick={() => setLastCompletedTransfer(null)}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition shadow hover:shadow-md"
            >
              <ArrowLeft className="w-4 h-4" /> Cerrar
            </button>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: CORTE DE CAJA (CLOSURE) */}
      {isCorteModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <AlertCircle className="w-5 h-5 mr-2 text-amber-600 animate-pulse" />
                Corte de Caja (Cierre)
              </h3>
              <button 
                onClick={() => setIsCorteModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-full cursor-pointer transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs font-semibold text-slate-700">
              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">Saldo Inicial:</span>
                  <span className="font-mono font-bold">{formatMXN(cashRegister.initialCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Efectivo Sugerido (Sistema):</span>
                  <span className="font-mono text-indigo-700 font-extrabold">{formatMXN(cashRegister.currentCash)}</span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-slate-600 font-extrabold block">Efectivo Físico Real en Almacén *</label>
                <input 
                  type="number"
                  placeholder="Ej: 1520"
                  step="0.01"
                  value={realCashInput}
                  onChange={e => setRealCashInput(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-bold text-slate-700"
                />
              </div>

              {realCashInput && !isNaN(parseFloat(realCashInput)) && (
                <div className={`p-3 rounded-xl border text-[11px] leading-tight ${
                  (parseFloat(realCashInput) - cashRegister.currentCash) === 0 
                  ? 'bg-emerald-50 border-emerald-100 text-emerald-800' 
                  : (parseFloat(realCashInput) - cashRegister.currentCash) > 0 
                    ? 'bg-blue-50 border-blue-100 text-blue-800'
                    : 'bg-rose-50 border-rose-100 text-rose-800'
                }`}>
                  <p className="font-bold">Diferencia Contable:</p>
                  <p className="text-xs font-black font-mono mt-0.5">
                    {formatMXN(parseFloat(realCashInput) - cashRegister.currentCash)} 
                    {((parseFloat(realCashInput) - cashRegister.currentCash) === 0) ? ' (Caja cuadra perfectamente)' : ((parseFloat(realCashInput) - cashRegister.currentCash) > 0) ? ' (Sobrante registrado)' : ' (Faltante registrado)'}
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t text-xs font-bold">
              <button 
                type="button" 
                onClick={() => setIsCorteModalOpen(false)}
                className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                type="button"
                onClick={() => {
                  const val = parseFloat(realCashInput);
                  if (isNaN(val) || val < 0) {
                    alert('Por favor ingresa un monto físico válido.');
                    return;
                  }
                  handleCloseCaja(val);
                }}
                className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl shadow cursor-pointer transition inline-flex items-center gap-1.5"
              >
                Proceder y Cerrar Caja <FileText className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: APERTURA DE CAJA (OPENING) */}
      {isOpeningCajaModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="pb-2 border-b flex justify-between items-start gap-2">
              <div>
                <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                  <Store className="w-5 h-5 mr-2 text-indigo-600 animate-pulse" />
                  Apertura de Turno y Caja
                </h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Define el monto inicial en efectivo para iniciar las operaciones del día.</p>
              </div>
              <button
                onClick={() => setIsOpeningCajaModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition shrink-0"
                title="Salir sin abrir caja"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs font-semibold text-slate-700">
              <div className="space-y-1">
                <label className="text-slate-600 font-extrabold block">Saldo Inicial de Apertura ($ MXN) *</label>
                <input 
                  type="number"
                  placeholder="Ej: 500.00"
                  step="0.01"
                  value={openingCashInput}
                  onChange={e => setOpeningCashInput(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500 font-bold text-slate-700"
                />
              </div>
            </div>

            <div className="pt-3 border-t text-xs font-bold w-full">
              <button 
                type="button"
                onClick={() => {
                  const val = parseFloat(openingCashInput);
                  if (isNaN(val) || val < 0) {
                    alert('Por favor de ingresar un monto inicial válido.');
                    return;
                  }
                  handleOpenCaja(val);
                }}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow cursor-pointer transition inline-flex items-center justify-center gap-1.5"
              >
                Abrir Caja Registradora <Rocket className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Company Selector — available to authenticated users with company membership */}
      {user && !isAuthLoading && !activeCompanyId && !isCredentialEmployee && (
        <CompanySelector
          companies={userCompanies}
          userDisplayName={user.displayName}
          userEmail={user.email}
          onCreateCompany={handleCreateCompany}
          onJoinWithCode={handleJoinCompanyWithCode}
          onSelectCompany={(id) => {
            safeLocalStorageSet(`logic_active_company_${user.uid}`, id);
            setActiveCompanyId(id);
          }}
          onDeleteCompany={handleDeleteCompany}
          onLogout={() => signOut(auth)}
        />
      )}

      {/* Waiting screen for credential employees while Firestore resolves their company */}
      {user && !isAuthLoading && !activeCompanyId && isCredentialEmployee && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
          {credentialBootstrapFailed ? (
            <>
              <div className="w-16 h-16 rounded-2xl bg-rose-900/40 border border-rose-700/30 flex items-center justify-center mb-5">
                <AlertCircle className="w-8 h-8 text-rose-400" />
              </div>
              <h2 className="text-xl font-black text-slate-100 mb-2">No pudimos verificar tu cuenta</h2>
              <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
                Revisa tu conexión a internet e intenta de nuevo. Si el problema sigue, avisa a tu encargado.
              </p>
              <button
                onClick={() => { setCredentialBootstrapFailed(false); setBootstrapRetryTrigger(n => n + 1); }}
                className="px-6 py-2.5 mb-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded-xl shadow cursor-pointer transition"
              >
                Reintentar
              </button>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-2xl bg-indigo-900/40 border border-indigo-700/30 flex items-center justify-center mb-5">
                <ShoppingCart className="w-8 h-8 text-indigo-400 animate-pulse" />
              </div>
              <h2 className="text-xl font-black text-slate-100 mb-2">Conectando al sistema...</h2>
              <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
                Estamos verificando tus credenciales y cargando tu sucursal asignada.
              </p>
              <div className="flex gap-1.5 mb-8">
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </>
          )}
          <button
            onClick={() => signOut(auth)}
            className="text-xs text-slate-500 hover:text-slate-300 underline cursor-pointer transition"
          >
            Salir e intentar de nuevo
          </button>
        </div>
      )}

      {/* Expired-session gate: the background revalidation above found the session is no
          longer valid server-side. Everything the cashier does from here on would fail to
          save, so block the POS outright rather than let sales pile up that never persist. */}
      {user && !isAuthLoading && sessionExpired && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-900/40 border border-rose-700/30 flex items-center justify-center mb-5">
            <AlertCircle className="w-8 h-8 text-rose-400" />
          </div>
          <h2 className="text-xl font-black text-slate-100 mb-2">Tu sesión expiró</h2>
          <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
            Por seguridad, tu sesión dejó de ser válida. Cierra sesión y vuelve a entrar para poder seguir cobrando —
            si sigues sin volver a entrar, las ventas no se guardarán.
          </p>
          <button
            onClick={() => signOut(auth)}
            className="px-6 py-2.5 mb-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded-xl shadow cursor-pointer transition"
          >
            Cerrar sesión y volver a entrar
          </button>
        </div>
      )}

      {/* Role-migration gate: the member's persisted role is not owner/admin/employee (e.g. a
          legacy master_admin not yet converted). Nothing below would work for them, so say
          exactly what has to happen instead of rendering an inert POS. Sits above the
          branch-sync gate because that one would otherwise show a misleading branch message. */}
      {user && !isAuthLoading && roleNeedsMigration && (
        <div className="fixed inset-0 z-[55] bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-amber-900/40 border border-amber-700/30 flex items-center justify-center mb-5">
            <AlertCircle className="w-8 h-8 text-amber-400" />
          </div>
          <h2 className="text-xl font-black text-slate-100 mb-2">Tu rol necesita actualizarse</h2>
          <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
            Tu cuenta tiene un rol que ya no existe en esta versión del sistema. Pide al Propietario que te asigne
            el rol de Encargado o Cajero y una sucursal desde Mi Empresa / Equipo. En cuanto lo haga, el punto de venta
            se habilitará automáticamente.
          </p>
          <button
            onClick={() => signOut(auth)}
            className="text-xs text-slate-500 hover:text-slate-300 underline cursor-pointer transition"
          >
            Cerrar sesión
          </button>
        </div>
      )}

      {/* Branch-sync gate: blocks the POS for branch-locked employees/admins until their real
          assigned branch is confirmed from companies/{id}/members/{uid} — prevents a sale/
          stock/cash entry from ever being filed under a stale or placeholder branchId while
          that document is still loading right after login (see branchSyncPending above). */}
      {user && !isAuthLoading && branchSyncPending && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
          {branchSyncTimedOut ? (
            <>
              <div className="w-16 h-16 rounded-2xl bg-rose-900/40 border border-rose-700/30 flex items-center justify-center mb-5">
                <AlertCircle className="w-8 h-8 text-rose-400" />
              </div>
              <h2 className="text-xl font-black text-slate-100 mb-2">
                {currentUserMember && !assignedBranchId
                  ? 'Tu cuenta no tiene sucursal asignada'
                  : currentUserMember && branches.length > 0 && !assignedBranchExists
                    ? 'Tu sucursal asignada ya no existe'
                    : 'No pudimos confirmar tu sucursal'}
              </h2>
              <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
                {currentUserMember && (!assignedBranchId || (branches.length > 0 && !assignedBranchExists))
                  ? 'Pide al Propietario que te asigne una sucursal válida desde Mi Empresa / Equipo. En cuanto lo haga, el punto de venta se habilitará automáticamente.'
                  : 'Revisa tu conexión a internet e intenta de nuevo. Si el problema sigue, avisa a tu encargado.'}
              </p>
              <button
                onClick={() => { setBranchSyncTimedOut(false); setBranchSyncRetryTrigger(n => n + 1); }}
                className="px-6 py-2.5 mb-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded-xl shadow cursor-pointer transition"
              >
                Reintentar
              </button>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-2xl bg-indigo-900/40 border border-indigo-700/30 flex items-center justify-center mb-5">
                <MapPin className="w-8 h-8 text-indigo-400 animate-pulse" />
              </div>
              <h2 className="text-xl font-black text-slate-100 mb-2">Cargando tu sucursal...</h2>
              <p className="text-slate-400 text-sm max-w-xs leading-relaxed mb-6">
                Estamos confirmando la sucursal asignada a tu cuenta antes de abrir el punto de venta.
              </p>
              <div className="flex gap-1.5 mb-8">
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </>
          )}
          <button
            onClick={() => signOut(auth)}
            className="text-xs text-slate-500 hover:text-slate-300 underline cursor-pointer transition"
          >
            Salir e intentar de nuevo
          </button>
        </div>
      )}

      {/* Descargar/Compartir choice for saveFileOnDevice — shown on every platform (web and
          native) so the flow can be tested on desktop instead of only on a phone. */}
      {pendingFileSave && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-5 space-y-4 text-center animate-slide-up">
            <p className="font-bold text-sm text-slate-800 break-all">{pendingFileSave.filename}</p>
            <p className="text-xs text-slate-500">¿Qué quieres hacer con este archivo?</p>
            <div className="space-y-2">
              <button
                type="button"
                onClick={confirmDownloadPendingFile}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition"
              >
                <Download className="w-3.5 h-3.5" /> Descargar
              </button>
              <button
                type="button"
                onClick={confirmSharePendingFile}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition"
              >
                <Share2 className="w-3.5 h-3.5" /> Compartir
              </button>
              <button
                type="button"
                onClick={() => setPendingFileSave(null)}
                className="w-full py-2 text-slate-400 hover:text-slate-600 font-bold text-xs cursor-pointer transition"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GLOBAL MOUNT CHECKPOINT: UNIFIED AUTHENTICATION SELECTION DIALOG (GOOGLE & DIRECT CREDENTIALS) */}
    </div>
  );
}

const CategorySelectorRowItem = ({ cat, onRename }: { cat: string; onRename: (oldName: string, newName: string) => void }) => {
  const [name, setName] = useState(cat);
  const [isEditing, setIsEditing] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 text-xs font-semibold">
      {isEditing ? (
        <input 
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="flex-grow bg-white border border-slate-200 px-2.5 py-1 rounded-lg text-slate-700 font-bold focus:ring-1 focus:ring-indigo-500 outline-none text-xs"
        />
      ) : (
        <span className="font-bold text-slate-700 px-1">{cat}</span>
      )}
      <div className="flex gap-1 flex-shrink-0 text-[10px] font-bold">
        {isEditing ? (
          <>
            <button
              onClick={() => {
                onRename(cat, name);
                setIsEditing(false);
              }}
              className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded cursor-pointer transition"
            >
              Guardar
            </button>
            <button
              onClick={() => {
                setName(cat);
                setIsEditing(false);
              }}
              className="px-2 py-1 text-slate-500 hover:bg-slate-100 rounded cursor-pointer transition"
            >
              Cancelar
            </button>
          </>
        ) : (
          <button
            onClick={() => setIsEditing(true)}
            className="px-2 py-1 text-indigo-600 hover:bg-indigo-50 border border-indigo-100 rounded cursor-pointer transition"
          >
            Renombrar
          </button>
        )}
      </div>
    </div>
  );
};

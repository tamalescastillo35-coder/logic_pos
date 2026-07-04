import React, { useState, useEffect, useMemo, FormEvent } from 'react';
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
  List
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

// Firebase integrations
import { auth, db, googleProvider, driveGoogleProvider, OperationType, handleFirestoreError, getCachedAccessToken, setCachedAccessToken } from './firebase';
import { onAuthStateChanged, signInWithPopup, signInWithCredential, signOut, User, signInWithEmailAndPassword, GoogleAuthProvider } from 'firebase/auth';
import { Capacitor, registerPlugin } from '@capacitor/core';

// Thin custom-plugin binding — see android/.../ReceiptPrinterPlugin.java. No npm package for
// this one; it's registered by name only, matching the @CapacitorPlugin("ReceiptPrinter")
// annotation on the native side.
const ReceiptPrinter = registerPlugin<{ print(options: { html: string; jobName?: string }): Promise<{ value: boolean }> }>('ReceiptPrinter');
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

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
  increment,
  arrayUnion,
  runTransaction
} from 'firebase/firestore';

// Custom Tenant Components
import CompanySelector from './components/CompanySelector';
import CompanySettingsView from './components/CompanySettingsView';

// UTF-8-safe string → base64 (plain btoa() mangles accented characters like á/é/í/ó/ú/ñ).
const utf8ToBase64 = (str: string): string =>
  btoa(Array.from(new TextEncoder().encode(str), b => String.fromCharCode(b)).join(''));

// Saves a generated file (CSV/PDF) so it actually reaches the user. In a real browser the
// classic Blob + <a download> click reliably triggers the browser's download flow. Inside
// Capacitor's Android WebView that same click does nothing visible — there's no Downloads-
// folder integration for it. On native we instead write the file to the app's cache dir
// (@capacitor/filesystem) and hand it to the OS share sheet (@capacitor/share), where the
// user picks "Guardar en Archivos" / Drive / WhatsApp / etc. Same entry point either way —
// callers just pass the filename, base64 payload, and mime type.
const saveFileOnDevice = async (filename: string, base64Data: string, mimeType: string) => {
  if (isNativePlatform) {
    try {
      const result = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Cache,
      });
      await Share.share({
        title: filename,
        url: result.uri,
        dialogTitle: `Guardar ${filename}`,
      });
    } catch (err) {
      console.error('Native file save error:', err);
      alert('No se pudo guardar/compartir el archivo. Intenta de nuevo.');
    }
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
};

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

interface CashRegister {
  isOpen: boolean;
  initialCash: number;
  currentCash: number;
  transactions: {
    type: 'Ingreso' | 'Egreso' | 'Venta' | 'Transferencia';
    amount: number;
    description: string;
    time: string;
    createdAt?: number; // epoch ms — lets the monthly PDF filter movements by period
    branchId?: string; // Associated Branch/Office
  }[];
  lastOperationalDate?: string; // e.g. '2026-05-20'
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
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'master_admin' | 'admin' | 'employee';
  joinedAt?: string;
  assignedBranchId?: string;
}

export const getProductStock = (prod: Product, branchId: string): number => {
  if (!prod.branchStocks) return prod.stock;
  return prod.branchStocks[branchId] !== undefined ? prod.branchStocks[branchId] : prod.stock;
};

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
  const ms = sale.createdAt ?? Date.parse(sale.timestamp);
  const d = isNaN(ms) ? new Date() : new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const getMonthLabel = (monthKey: string): string => {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES_ES[(m - 1 + 12) % 12]} ${y}`;
};

// Builds the descending list of month keys ("YYYY-MM") that have at least one sale,
// always including the current month even if it has no sales yet.
export const getAvailableMonths = (allSales: Sale[]): string[] => {
  const keys = new Set<string>([getCurrentMonthKey()]);
  allSales.forEach(s => keys.add(getSaleMonthKey(s)));
  return Array.from(keys).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
};

// Default Catalog to boost experience immediately (Kyte Demo Catalog)
const DEFAULT_PRODUCTS: Product[] = [];

const DEFAULT_CUSTOMERS: Customer[] = [];

const DEFAULT_BRANCHES: Branch[] = [];

const DEFAULT_SUPPLIERS: Supplier[] = [];

export default function App() {
  // Tabs: 'pos' | 'products' | 'customers' | 'history' | 'analytics' | 'branches' | 'suppliers' | 'settings' | 'invoicing'
  const [activeTab, setActiveTab] = useState<'pos' | 'products' | 'customers' | 'history' | 'analytics' | 'branches' | 'suppliers' | 'settings' | 'invoicing'>('pos');
  const [branding, setBranding] = useState<Branding>({});
  const [printConfig, setPrintConfig] = useState<PrintConfig>(DEFAULT_PRINT_CONFIG);

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

  // Unified Authentication Modal (Google & Credentials)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authCompanyId, setAuthCompanyId] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [isSignInLoading, setIsSignInLoading] = useState(false);

  const handleCredentialSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authCompanyId.trim() || !authUsername.trim()) {
      alert("Por favor completa el Código de Comercio y tu Número de Empleado.");
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
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error("Error signing in with employee credentials:", err);
      let errMsg = "Credenciales incorrectas o problemas de conexión.";
      if (err.code === 'auth/operation-not-allowed' || (err.message && err.message.includes('operation-not-allowed'))) {
        errMsg = "El método de inicio de sesión por Correo/Contraseña está deshabilitado en tu Firebase Console.\n\nPara habilitarlo:\n1. Entra a console.firebase.google.com y ve a tu proyecto.\n2. Ve a 'Authentication' -> pestaña 'Sign-in method'.\n3. Habilita y guarda el proveedor 'Correo electrónico/contraseña'.";
      } else if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        errMsg = "El ID de comercio, usuario o contraseña son incorrectos.";
      }
      alert("Error de inicio de sesión: " + errMsg);
    } finally {
      setIsSignInLoading(false);
    }
  };

  // Multi-Company States
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  const [userCompanies, setUserCompanies] = useState<{ [id: string]: { id: string; name: string; role: 'owner' | 'master_admin' | 'admin' | 'employee' } }>({});
  const [currentUserMember, setCurrentUserMember] = useState<any | null>(null);
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
    isOpen: true,
    initialCash: 2000,
    currentCash: 2000,
    transactions: [{ type: 'Ingreso', amount: 2000, description: 'Apertura de Caja', time: new Date().toLocaleTimeString() }]
  });

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
  // Mirrors firestore.rules isOwnerOrAdmin() — refunds/voids require this client-side too
  const isOwnerOrAdminRole = activeCompanyRole === 'owner' || activeCompanyRole === 'master_admin' || activeCompanyRole === 'admin';

  // True when the logged-in user authenticated with an employee code (virtual email), not Google
  const isCredentialEmployee = Boolean(user?.email?.includes('_') && user?.email?.endsWith('@logicpos.com'));

  // Handler to Create a new Company inside cloud & bootstrap default entities
  const handleCreateCompany = async (companyName: string) => {
    if (!companyName.trim()) return;
    if (!user) return;

    try {
      const companyId = 'comp_' + Math.floor(Math.random() * 900000 + 100000);
      const newCompany = {
        id: companyId,
        name: companyName,
        ownerId: user.uid,
        invitationCode: 'INV-' + Math.floor(Math.random() * 90000 + 10000),
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

      localStorage.setItem(`logic_active_company_${user.uid}`, companyId);
      setActiveCompanyId(companyId);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `companies_creation`);
    }
  };

  const handleRestoreCompanyData = async (backupData: any, onProgress: (msg: string) => void) => {
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
      localStorage.setItem('logic_custom_categories', JSON.stringify(backupData.customCategories));
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
      const usageType = inviteData.usageType || 'multiple';

      // Write user as employee member of company subcollection
      // `inviteCode` lets Firestore rules verify this join is backed by a real,
      // company-matching invitation (see firestore.rules: members.create)
      await setDoc(doc(db, 'companies', compId, 'members', user.uid), {
        userId: user.uid,
        name: user.displayName || 'Empleado',
        email: user.email || '',
        role: userRole,
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

      await setDoc(doc(db, 'users', user.uid), {
        companies: updatedCompanies,
        activeCompanyId: compId
      }, { merge: true });

      // If single use, delete invitation record from Firestore
      if (usageType === 'single') {
        try {
          await deleteDoc(doc(db, 'invitationCodes', cleanCode));
          await updateDoc(doc(db, 'companies', compId), {
            invitationCode: null
          });
        } catch (errDelete) {
          console.warn("Could not auto-delete single use invite code:", errDelete);
        }
      }

      localStorage.setItem(`logic_active_company_${user.uid}`, compId);
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
    try {
      // 1. Delete the root company doc first, while the caller's own owner membership
      // doc still exists (companies.delete requires isOwner(), which reads that doc).
      await deleteDoc(doc(db, 'companies', companyId));

      // 2. Delete every subcollection doc. `members` must go last: every other
      // subcollection's delete rule checks isMemberOfCompany/isOwnerOrAdmin, which reads
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
      localStorage.removeItem(`logic_active_company_${user.uid}`);
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

    const unsubUser = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data.companies) {
          setUserCompanies(data.companies);
        } else {
          setUserCompanies({});
        }

        const savedActiveCompanyId = localStorage.getItem(`logic_active_company_${user.uid}`);
        const cloudActiveCompanyId = data.activeCompanyId;
        const keys = Object.keys(data.companies || {});

        if (cloudActiveCompanyId && data.companies?.[cloudActiveCompanyId]) {
          setActiveCompanyId(cloudActiveCompanyId);
        } else if (savedActiveCompanyId && data.companies?.[savedActiveCompanyId]) {
          setActiveCompanyId(savedActiveCompanyId);
        } else if (keys.length > 0) {
          setActiveCompanyId(keys[0]);
        } else {
          setActiveCompanyId(null);
        }
      } else {
        // Initialize user document
        const isVirtualEmployee = user.email && user.email.includes('_') && user.email.endsWith('@logicpos.com');
        if (isVirtualEmployee) {
          const emailLocal = user.email!.split('@')[0];
          const firstUnderscore = emailLocal.indexOf('_');
          const secondUnderscore = emailLocal.indexOf('_', firstUnderscore + 1);
          if (secondUnderscore !== -1) {
            const parsedCompanyId = emailLocal.substring(0, secondUnderscore);
            getDoc(doc(db, 'companies', parsedCompanyId, 'members', user.uid)).then((memberSnap) => {
              if (memberSnap.exists()) {
                const mData = memberSnap.data();
                getDoc(doc(db, 'companies', parsedCompanyId)).then((compSnap) => {
                  const compName = compSnap.exists() ? compSnap.data().name : 'Mi Empresa';
                  
                  setDoc(doc(db, 'users', user.uid), {
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
                  }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
                }).catch(() => {
                  setDoc(doc(db, 'users', user.uid), {
                    uid: user.uid,
                    email: user.email || '',
                    name: mData.name || 'Empleado',
                    createdAt: new Date().toISOString(),
                    companies: {
                      [parsedCompanyId]: {
                        id: parsedCompanyId,
                        name: 'Mi Empresa',
                        role: mData.role || 'employee'
                      }
                    },
                    activeCompanyId: parsedCompanyId
                  }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
                });
              } else {
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
            }).catch(() => {
              setDoc(doc(db, 'users', user.uid), {
                uid: user.uid,
                email: user.email || '',
                name: user.displayName || 'Comerciante',
                createdAt: new Date().toISOString(),
                companies: {}
              }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
              setActiveCompanyId(null);
              setUserCompanies({});
            });
          } else {
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
        } else {
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
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    return () => unsubUser();
  }, [user]);

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
  }, [user, activeCompanyId, userCompanies]);

  // Lock the branch selector for employees
  useEffect(() => {
    if (!user || !activeCompanyId) return;
    
    // Check if the current user is an employee
    const isEmployee = activeCompanyRole === 'employee';
    if (isEmployee && currentUserMember?.assignedBranchId) {
      if (selectedBranchId !== currentUserMember.assignedBranchId) {
        setSelectedBranchId(currentUserMember.assignedBranchId);
        localStorage.setItem('logic_active_branch', currentUserMember.assignedBranchId);
      }
    }
  }, [currentUserMember, activeCompanyRole, selectedBranchId, activeCompanyId, user]);

  // Sync state from Firestore / Local Fallback
  useEffect(() => {
    if (!user) {
      setBranding({});
      // Local fallback loading
      const savedProducts = localStorage.getItem('logic_products') || localStorage.getItem('kyte_products');
      const savedCustomers = localStorage.getItem('logic_customers') || localStorage.getItem('kyte_customers');
      const savedSales = localStorage.getItem('logic_sales') || localStorage.getItem('kyte_sales');
      const savedCash = localStorage.getItem('logic_cash') || localStorage.getItem('kyte_cash');
      const savedBranches = localStorage.getItem('logic_branches');
      const savedSuppliers = localStorage.getItem('logic_suppliers');
      const savedActiveBranch = localStorage.getItem('logic_active_branch');

      if (savedProducts) setProducts(JSON.parse(savedProducts));
      else {
        setProducts(DEFAULT_PRODUCTS);
        localStorage.setItem('logic_products', JSON.stringify(DEFAULT_PRODUCTS));
      }

      if (savedCustomers) setCustomers(JSON.parse(savedCustomers));
      else {
        setCustomers(DEFAULT_CUSTOMERS);
        localStorage.setItem('logic_customers', JSON.stringify(DEFAULT_CUSTOMERS));
      }

      if (savedBranches) setBranches(JSON.parse(savedBranches));
      else {
        setBranches(DEFAULT_BRANCHES);
        localStorage.setItem('logic_branches', JSON.stringify(DEFAULT_BRANCHES));
      }

      if (savedSuppliers) setSuppliers(JSON.parse(savedSuppliers));
      else {
        setSuppliers(DEFAULT_SUPPLIERS);
        localStorage.setItem('logic_suppliers', JSON.stringify(DEFAULT_SUPPLIERS));
      }

      if (savedActiveBranch) setSelectedBranchId(savedActiveBranch);
      else setSelectedBranchId('b-ideal');

      if (savedSales) setSales(JSON.parse(savedSales));
      if (savedCash) setCashRegister(JSON.parse(savedCash));

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

    const unsubSales = onSnapshot(collection(db, 'companies', compId, 'sales'), (snapshot) => {
      const list: Sale[] = [];
      snapshot.forEach(d => {
        list.push(d.data() as Sale);
      });
      // `timestamp` is a locale display string (e.g. "30/6/2026, 4:55 p.m.") and isn't
      // reliably parseable by `new Date()` — sort by the numeric `createdAt` instead.
      // Older sales recorded before this field existed fall back to 0 (oldest last).
      const saleSortKey = (s: Sale) => s.createdAt ?? 0;
      list.sort((a, b) => saleSortKey(b) - saleSortKey(a));
      setSales(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/sales`);
    });

    const unsubStockMovements = onSnapshot(collection(db, 'companies', compId, 'stockMovements'), (snapshot) => {
      const list: StockMovement[] = [];
      snapshot.forEach(d => list.push(d.data() as StockMovement));
      list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      setStockMovements(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${compId}/stockMovements`);
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

    const savedActiveBranch = localStorage.getItem('logic_active_branch');
    if (savedActiveBranch) setSelectedBranchId(savedActiveBranch);

    return () => {
      unsubProducts();
      unsubCustomers();
      unsubBranches();
      unsubSuppliers();
      unsubMembers();
      unsubSales();
      unsubStockMovements();
      unsubBranding();
      unsubPrintConfig();
    };
  }, [user, activeCompanyId]);

  // Cash register is scoped per-branch (companies/{id}/cashRegisters/{branchId}), not one
  // shared document — otherwise switching branches shows the same balance everywhere.
  // Kept in its own effect (instead of the big listener effect above) so it re-subscribes
  // only when the branch actually changes, not on every unrelated company-level update.
  useEffect(() => {
    if (!user || !activeCompanyId || !selectedBranchId) return;
    const compId = activeCompanyId;
    const branchId = selectedBranchId;

    const unsubCash = onSnapshot(doc(db, 'companies', compId, 'cashRegisters', branchId), (snapshot) => {
      if (snapshot.exists()) {
        // Defaults first, then the doc's own fields — a register doc can exist with only
        // currentCash/transactions if it was auto-created by a sale/transfer delta before
        // anyone ever pressed "abrir caja" (isOpen/initialCash would otherwise be missing).
        setCashRegister({ isOpen: false, initialCash: 0, currentCash: 0, transactions: [], ...snapshot.data() } as CashRegister);
      } else {
        // No register doc yet for this branch (brand-new branch, never opened) — show a
        // clean closed state instead of leaking whatever the previous branch had cached.
        setCashRegister({ isOpen: false, initialCash: 0, currentCash: 0, transactions: [] });
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `companies/${compId}/cashRegisters/${branchId}`);
    });

    return () => unsubCash();
  }, [user, activeCompanyId, selectedBranchId]);

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
        localStorage.setItem('logic_cash', JSON.stringify(updated));
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

  // Opening/closing the register is a deliberate single-actor action (not a concurrent
  // delta like a sale), so it writes the whole branch-scoped doc directly instead of
  // going through applyCashDelta's increment/arrayUnion.
  const writeCashRegisterForBranch = async (branchId: string, newCash: CashRegister) => {
    setCashRegister(newCash);
    localStorage.setItem('logic_cash', JSON.stringify(newCash));
    if (user && activeCompanyId) {
      try {
        await setDoc(doc(db, 'companies', activeCompanyId, 'cashRegisters', branchId), sanitize(newCash));
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `companies/${activeCompanyId}/cashRegisters/${branchId}`);
      }
    }
  };

  const handleCloseCaja = (realCashValue: number) => {
    const expected = cashRegister.currentCash;
    const diff = realCashValue - expected;
    const diffText = diff === 0
      ? 'Caja Cuadrada'
      : diff > 0
        ? `Sobrante de ${formatMXN(diff)}`
        : `Faltante de ${formatMXN(Math.abs(diff))}`;

    const newTx = {
      type: 'Egreso' as const,
      amount: Math.abs(diff),
      description: `Cierre de Caja - Real: ${formatMXN(realCashValue)} | Esp: ${formatMXN(expected)} (${diffText})`,
      time: new Date().toLocaleTimeString(),
      createdAt: Date.now()
    };

    const closedCash: CashRegister = {
      ...cashRegister,
      isOpen: false,
      currentCash: realCashValue,
      transactions: [...cashRegister.transactions, newTx]
    };

    writeCashRegisterForBranch(selectedBranchId, closedCash);
    setShowOvernightWarning(false);
    setIsCorteModalOpen(false);
    alert(`¡Caja cerrada correctamente! Total esperado: ${formatMXN(expected)} | Físico: ${formatMXN(realCashValue)} (${diffText}).`);

    setIsOpeningCajaModalOpen(true);
  };

  const handleOpenCaja = (initialCashValue: number) => {
    const todayStr = getTodayDateString();
    const newCash: CashRegister = {
      isOpen: true,
      initialCash: initialCashValue,
      currentCash: initialCashValue,
      lastOperationalDate: todayStr,
      transactions: [{
        type: 'Ingreso',
        amount: initialCashValue,
        description: `Apertura de Caja - Saldo Inicial: ${formatMXN(initialCashValue)}`,
        time: new Date().toLocaleTimeString(),
        createdAt: Date.now()
      }]
    };

    writeCashRegisterForBranch(selectedBranchId, newCash);
    setIsOpeningCajaModalOpen(false);
    alert(`¡Caja abierta correctamente con un saldo inicial de ${formatMXN(initialCashValue)}!`);
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

    // 2. Offline persistent local state fallback storage
    localStorage.setItem('logic_products', JSON.stringify(newProds));
    localStorage.setItem('logic_customers', JSON.stringify(newCusts));
    localStorage.setItem('logic_sales', JSON.stringify(newSales));
    localStorage.setItem('logic_cash', JSON.stringify(newCash));
    localStorage.setItem('logic_branches', JSON.stringify(newBranches));
    localStorage.setItem('logic_suppliers', JSON.stringify(newSuppliers));

    // 3. Save directly to Cloud if logged into Firebase Auth — only the docs that changed
    if (user && activeCompanyId) {
      const compId = activeCompanyId;
      try {
        const batch = writeBatch(db);
        let opCount = 0;

        const diffInto = (prevArr: { id: string }[], nextArr: { id: string }[], col: string) => {
          const prevById = new Map(prevArr.map(item => [item.id, item]));
          nextArr.forEach(item => {
            if (prevById.get(item.id) !== item) {
              batch.set(doc(db, 'companies', compId, col, item.id), sanitize(item));
              opCount++;
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

        if (opCount > 0) {
          await batch.commit();
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `companies/${compId}/batch_sync`);
      }
    }
  };

  // Atomically applies a delta to a branch's cash register (currentCash + appended
  // transaction log entries) via Firestore's increment()/arrayUnion() field transforms.
  // Unlike saveAllData's overwrite, this is safe when multiple terminals post to the same
  // `cashRegisters/{branchId}` doc at the same time: each caller only describes the change
  // IT is contributing, so concurrent writers can never silently clobber each other's
  // totals. Uses setDoc+merge (not updateDoc) so it also works as an upsert — a branch
  // that has never had its register opened yet still gets a doc instead of erroring.
  const applyCashDelta = async (branchId: string, amountDelta: number, txEntries: CashRegister['transactions']) => {
    if (!user || !activeCompanyId || !branchId) return;
    try {
      await setDoc(doc(db, 'companies', activeCompanyId, 'cashRegisters', branchId), {
        currentCash: increment(amountDelta),
        transactions: arrayUnion(...txEntries.map(sanitize))
      }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/cashRegisters/${branchId}`);
    }
  };

  // Atomically applies a balance delta to a single customer (credit sales / "fiado" payments)
  const applyCustomerBalanceDelta = async (customerId: string, balanceDelta: number) => {
    if (!user || !activeCompanyId) return;
    try {
      await updateDoc(doc(db, 'companies', activeCompanyId, 'customers', customerId), {
        unpaidBalance: increment(balanceDelta)
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/customers/${customerId}`);
    }
  };

  // Atomically applies stock deltas (global + per-branch) to one or more products in a
  // single Firestore transaction. Reads the live server documents right before writing,
  // so two terminals selling the last units of the same product at the same time can
  // never both succeed in selling more stock than actually exists / silently overwrite
  // each other's stock count (the failure mode of the old computed-from-stale-local-state
  // overwrite approach).
  const applyStockDeltas = async (deltas: { productId: string; branchId: string; qtyDelta: number }[]) => {
    if (!user || !activeCompanyId || deltas.length === 0) return;
    const compId = activeCompanyId;
    try {
      await runTransaction(db, async (tx) => {
        const productIds = Array.from(new Set(deltas.map(d => d.productId)));
        const refs = productIds.map(id => doc(db, 'companies', compId, 'products', id));
        const snaps = await Promise.all(refs.map(ref => tx.get(ref)));

        snaps.forEach((snap, idx) => {
          if (!snap.exists()) return;
          const data = snap.data() as Product;
          const productId = productIds[idx];
          const branchStocks = { ...(data.branchStocks || {}) };
          let stockTotal = data.stock;

          deltas.filter(d => d.productId === productId).forEach(d => {
            const currentBranchStock = branchStocks[d.branchId] !== undefined ? branchStocks[d.branchId] : data.stock;
            branchStocks[d.branchId] = Math.max(0, currentBranchStock + d.qtyDelta);
            stockTotal = Math.max(0, stockTotal + d.qtyDelta);
          });

          tx.update(refs[idx], { stock: stockTotal, branchStocks });
        });
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${compId}/products/stock_transaction`);
    }
  };

  // Writes append-only entries to the inventory audit log (surtidos / transfers). Each
  // caller passes the meaningful fields; id/user/timestamps are filled in here. Best-effort:
  // a logging failure must not block the actual stock change that already succeeded.
  const logStockMovements = async (
    entries: Pick<StockMovement, 'type' | 'productId' | 'productName' | 'quantity' | 'branchId' | 'branchName' | 'counterpartBranchId' | 'counterpartBranchName'>[]
  ) => {
    if (!user || !activeCompanyId || entries.length === 0) return;
    const compId = activeCompanyId;
    const now = Date.now();
    const userName = currentUserMember?.name || user.displayName || 'Sistema';
    const timestamp = new Date().toLocaleString();
    await Promise.all(entries.map((e, i) => {
      const id = `SM-${now}-${i}-${Math.floor(Math.random() * 10000)}`;
      return setDoc(doc(db, 'companies', compId, 'stockMovements', id), sanitize({ ...e, id, userName, timestamp, createdAt: now }))
        .catch(err => handleFirestoreError(err, OperationType.CREATE, `companies/${compId}/stockMovements/${id}`));
    }));
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
    if (!newName.trim()) return;
    const clean = newName.trim();
    if (selectCategoriesList.includes(clean)) {
      alert("Esta categoría ya existe.");
      return;
    }
    const updated = [...customCategories, clean];
    setCustomCategories(updated);
    localStorage.setItem('logic_custom_categories', JSON.stringify(updated));
    setNewCategoryInput('');
    alert(`Categoría "${clean}" agregada con éxito.`);
  };

  const handleRenameCategory = async (oldName: string, newName: string) => {
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

  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCat = selectedCategory === 'Todos' || p.category === selectedCategory;
      // Terminal POS only sells what's physically in the active branch: products at 0
      // stock are hidden so a cashier can't oversell. They reappear automatically once
      // stock is added (surtido / transfer). This is per-branch, not global.
      const hasStock = getProductStock(p, selectedBranchId) >= 1;
      return matchesSearch && matchesCat && hasStock;
    });
  }, [products, searchTerm, selectedCategory, selectedBranchId]);

  // Count of catalogue items hidden from the terminal purely because they're out of stock
  // in the active branch (used to explain an empty grid instead of implying "no products").
  const outOfStockHiddenCount = useMemo(() => {
    return products.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCat = selectedCategory === 'Todos' || p.category === selectedCategory;
      return matchesSearch && matchesCat && getProductStock(p, selectedBranchId) < 1;
    }).length;
  }, [products, searchTerm, selectedCategory, selectedBranchId]);

  // Cart helper functions.
  // Cart quantities are hard-capped at the active branch's available stock so a sale can
  // never exceed physical inventory (no oversell). Stock is read live from `products`
  // (not the cart's product snapshot) in case it changed since the item was added.
  const addToCart = (product: Product) => {
    const available = getProductStock(product, selectedBranchId);
    const idx = cart.findIndex(item => item.product.id === product.id);
    const currentQty = idx > -1 ? cart[idx].quantity : 0;
    if (currentQty + 1 > available) {
      alert(`No hay stock suficiente de "${product.name}" en esta sucursal.\nDisponible: ${available} u.${currentQty > 0 ? ` · Ya tienes ${currentQty} en el carrito.` : ''}`);
      return;
    }
    if (idx > -1) {
      const newCart = [...cart];
      newCart[idx].quantity += 1;
      setCart(newCart);
    } else {
      setCart([...cart, { product, quantity: 1 }]);
    }
  };

  const updateCartQty = (productId: string, val: number) => {
    const item = cart.find(i => i.product.id === productId);
    if (!item) return;
    const newQty = item.quantity + val;
    if (newQty <= 0) {
      setCart(cart.filter(i => i.product.id !== productId));
      return;
    }
    if (val > 0) {
      const liveProduct = products.find(p => p.id === productId) || item.product;
      const available = getProductStock(liveProduct, selectedBranchId);
      if (newQty > available) {
        alert(`No hay stock suficiente de "${item.product.name}" en esta sucursal.\nDisponible: ${available} u.`);
        return;
      }
    }
    setCart(cart.map(i => i.product.id === productId ? { ...i, quantity: newQty } : i));
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter(i => i.product.id !== productId));
  };

  // Cart Metrics
  const cartValues = useMemo(() => {
    const subtotal = cart.reduce((acc, item) => acc + (item.product.salePrice * item.quantity), 0);
    const calculatedDiscount = discountType === 'pct' 
      ? (subtotal * discountVal / 100) 
      : discountVal;
    const discountedTotal = Math.max(0, subtotal - calculatedDiscount);
    const taxValue = discountedTotal * taxPct / 100;
    const total = discountedTotal + taxValue;
    return { subtotal, calculatedDiscount, taxValue, total };
  }, [cart, discountType, discountVal, taxPct]);

  // Execute Checkout Payment
  const completeTransaction = () => {
    if (cart.length === 0) return;
    
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
        const available = liveProduct ? getProductStock(liveProduct, selectedBranchId) : 0;
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

    // 1. New Sale structure
    const newSale: Sale = {
      id: 'S-' + Math.floor(Math.random() * 900000 + 100000),
      items: cart.map(item => ({
        productId: item.product.id,
        name: item.product.name,
        quantity: item.quantity,
        salePrice: item.product.salePrice
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
      branchId: selectedBranchId, // Associate sale with the active branch!
      folio: (paymentMethod === 'Card' || paymentMethod === 'Transfer') ? folioNumber.trim() : undefined,
      requiresInvoice,
      invoiceStatus: requiresInvoice ? 'pending' : undefined,
      // `currentUserMember.name` covers owner/encargado/cajero alike (all are member docs);
      // falls back to the Auth display name for the rare case the member doc hasn't synced yet.
      employeeName: currentUserMember?.name || user?.displayName || undefined
    };

    // 2. Adjust Product Inventory atomically (per-product Firestore transaction — see
    // applyStockDeltas). Avoids two terminals selling concurrently from silently
    // clobbering each other's stock count.
    applyStockDeltas(cart.map(item => ({
      productId: item.product.id,
      branchId: selectedBranchId,
      qtyDelta: -item.quantity
    })));

    // 3. Adjust Customer credit balance if credit payment (atomic increment)
    if (selectedCustomer && paymentMethod === 'Credit') {
      applyCustomerBalanceDelta(selectedCustomer.id, cartValues.total);
    }

    // 4. Record Cash/Finance/Card/Transfer transaction in audit log (atomic — see applyCashDelta)
    const activeBranch = branches.find(b => b.id === selectedBranchId);
    const branchNameSuffix = activeBranch ? ` (${activeBranch.name})` : '';
    const paymentLabel = paymentMethod === 'Cash' ? 'Efectivo' : paymentMethod === 'Card' ? 'Tarjeta' : paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito';
    const descFolio = (paymentMethod === 'Card' || paymentMethod === 'Transfer') && folioNumber.trim() ? ` [Folio: ${folioNumber.trim()}]` : '';

    applyCashDelta(selectedBranchId, paymentMethod === 'Cash' ? cartValues.total : 0, [{
      type: 'Venta',
      amount: cartValues.total,
      description: `Venta ${newSale.id} - ${paymentLabel}${descFolio}${branchNameSuffix}`,
      time: new Date().toLocaleTimeString(),
      createdAt: Date.now(),
      branchId: selectedBranchId
    }]);

    // 5. Save the new sale record (only this single new doc gets written/diffed)
    const newSales = [newSale, ...sales];
    saveAllData(products, customers, newSales, cashRegister);

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
  };

  const handleSelectBranch = (branchId: string) => {
    setSelectedBranchId(branchId);
    localStorage.setItem('logic_active_branch', branchId);
  };

  // Prints a receipt via a hidden iframe instead of window.open(). The old approach opened
  // a new tab/window and self-closed it — in the Android WebView that spawned an in-app
  // view the user couldn't back out of (had to kill the app). A hidden iframe calls the
  // host's own print dialog (Android's system print → Bluetooth/WiFi printers or Save-as-PDF;
  // the OS handles printer selection), keeps the user in the app, and cleans itself up.
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

    const ticketText = `
      <html>
        <head>
          <title>Ticket ${sale.id}</title>
          <style>
            * { box-sizing: border-box; }
            body { font-family: 'Courier New', Courier, monospace; font-size: ${baseFontSize}; line-height: 1.45; color: #000; padding: ${bodyPadding}; max-width: ${bodyMaxWidth}; margin: 0 auto; background: #fff; }
            .header { text-align: center; margin-bottom: 6px; }
            .logo { display: block; margin: 0 auto 6px; width: 64px; height: 64px; object-fit: contain; filter: grayscale(1) contrast(1.1); }
            .biz-name { font-size: ${isA4 ? '20px' : '15px'}; font-weight: 900; letter-spacing: 0.5px; margin: 0 0 2px; text-transform: uppercase; }
            .tagline { font-size: 9px; margin: 0 0 4px; color: #555; }
            .txn-id { font-size: 9px; color: #666; margin: 0; }
            p { margin: 0 0 4px; }
            .sep { border: none; border-top: 1px dashed #555; margin: 6px 0; }
            .row { display: flex; justify-content: space-between; margin-bottom: 2px; }
            .bold { font-weight: bold; }
            .total-row { font-size: ${isA4 ? '16px' : '13px'}; font-weight: 900; border-top: 2px solid #000; padding-top: 4px; margin-top: 4px; }
            .footer { text-align: center; margin-top: 8px; }
            .footer .thanks { font-weight: 900; font-size: ${isA4 ? '14px' : '12px'}; }
            .footer .legal { font-size: 9px; color: #777; margin-top: 3px; }
            @media print {
              @page { size: ${pageSize}; margin: ${pageMargin}; }
              body { padding: 0; margin: 0 auto; }
            }
          </style>
        </head>
        <body>
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
        </body>
      </html>
    `;

    if (isNativePlatform) {
      // Android's WebView never shows a print dialog on window.print() by itself — it needs
      // native support wired up (see ReceiptPrinterPlugin.java), which loads this HTML into
      // its own offscreen WebView and hands it to android.print.PrintManager. That's the
      // native "elige tu impresora" dialog: Bluetooth/WiFi printers or Guardar como PDF.
      ReceiptPrinter.print({ html: ticketText, jobName: `Ticket ${sale.id}` }).catch(err => {
        console.error('Native print error:', err);
        alert('No se pudo abrir el diálogo de impresión. Intenta de nuevo.');
      });
      return;
    }

    // Web: a hidden iframe + its own print() reliably triggers the browser's print dialog,
    // scoped correctly to just this iframe's content (real browsers, unlike Android's WebView,
    // handle window.print() out of the box — no native bridge needed here).
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    const idoc = iframe.contentWindow?.document;
    if (!idoc) { cleanup(); return; }
    idoc.open();
    idoc.write(ticketText);
    idoc.close();

    // Print once content (incl. logo) has had a moment to render. `afterprint` cleans up
    // right away; a long fallback covers browsers that never fire it (the hidden 0×0 iframe
    // is harmless in the meantime).
    if (iframe.contentWindow) iframe.contentWindow.onafterprint = cleanup;
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (err) {
        console.error('Print error:', err);
        cleanup();
      }
      setTimeout(cleanup, 120000);
    }, 500);
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
    supplierId: '' // Associated supplier link
  });

  // Quick add-stock ("Surtir") — adds units to the ACTIVE branch instead of overwriting
  // the total. Faster than editing the article (no need to read the current number and
  // do mental math). Goes through applyStockDeltas so it's atomic and per-branch.
  const [quickStockProduct, setQuickStockProduct] = useState<Product | null>(null);
  const [quickStockAmount, setQuickStockAmount] = useState('');
  const [isSavingQuickStock, setIsSavingQuickStock] = useState(false);

  const handleQuickAddStock = async () => {
    if (!quickStockProduct) return;
    const qty = parseInt(quickStockAmount);
    if (isNaN(qty) || qty === 0) {
      alert('Ingresa una cantidad válida (mayor a 0 para sumar, negativa para restar).');
      return;
    }
    setIsSavingQuickStock(true);
    try {
      // Positive = surtido (entrada); negative = merma/ajuste. Per-branch + atomic.
      await applyStockDeltas([{ productId: quickStockProduct.id, branchId: selectedBranchId, qtyDelta: qty }]);
      // Record it in the inventory audit log so it shows in Historial and the PDF.
      const branchName = branches.find(b => b.id === selectedBranchId)?.name;
      await logStockMovements([{
        type: qty > 0 ? 'surtido' : 'merma',
        productId: quickStockProduct.id,
        productName: quickStockProduct.name,
        quantity: Math.abs(qty),
        branchId: selectedBranchId,
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
    if (product) {
      setEditingProduct(product);
      setProdForm({
        name: product.name,
        category: product.category,
        costPrice: product.costPrice.toString(),
        salePrice: product.salePrice.toString(),
        stock: getProductStock(product, selectedBranchId).toString(),
        minStock: product.minStock.toString(),
        sku: product.sku || '',
        supplierId: product.supplierId || ''
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
        supplierId: ''
      });
    }
    setIsProductModalOpen(true);
  };

  const handleSaveProduct = (e: FormEvent) => {
    e.preventDefault();
    if (!prodForm.name || !prodForm.salePrice) {
      alert('Nombre y Precio de Venta son obligatorios.');
      return;
    }

    const salePriceNum = parseFloat(prodForm.salePrice);
    const costPriceNum = parseFloat(prodForm.costPrice) || 0;
    const stockNum = parseInt(prodForm.stock) || 0;
    const minStockNum = parseInt(prodForm.minStock) || 0;

    let updatedProducts: Product[];
    if (editingProduct) {
      updatedProducts = products.map(p => {
        if (p.id === editingProduct.id) {
          const branchStocks = { ...(p.branchStocks || {}) };
          branchStocks[selectedBranchId] = stockNum;
          return {
            ...p,
            name: prodForm.name,
            category: prodForm.category || 'Varios',
            costPrice: costPriceNum,
            salePrice: salePriceNum,
            stock: stockNum,
            minStock: minStockNum,
            sku: prodForm.sku,
            supplierId: prodForm.supplierId || undefined,
            branchStocks
          };
        }
        return p;
      });
    } else {
      const newProd: Product = {
        id: 'P-' + Math.floor(Math.random() * 90000 + 10000),
        name: prodForm.name,
        category: prodForm.category || 'Varios',
        costPrice: costPriceNum,
        salePrice: salePriceNum,
        stock: stockNum,
        minStock: minStockNum,
        sku: prodForm.sku || 'SKU-' + Math.floor(Math.random() * 900000),
        supplierId: prodForm.supplierId || undefined,
        branchStocks: { [selectedBranchId]: stockNum }
      };
      updatedProducts = [...products, newProd];
    }

    saveAllData(updatedProducts, customers, sales, cashRegister);
    setIsProductModalOpen(false);
  };

  const handleDeleteProduct = async (prodId: string) => {
    if (confirm('¿Está seguro de que desea eliminar este producto del catálogo?')) {
      const updated = products.filter(p => p.id !== prodId);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'products', prodId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/products/${prodId}`);
        }
      }
      saveAllData(updated, customers, sales, cashRegister);
    }
  };

  const handleDownloadDashboard = async () => {
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
    branches.forEach(b => {
      const bSales = sales.filter(s =>
        s.status === 'Completed' &&
        (s.branchId === b.id || (!s.branchId && !!b.isMatriz)) &&
        (statsMonth === 'all' || getSaleMonthKey(s) === statsMonth)
      );
      const bTotal = bSales.reduce((acc, curr) => acc + curr.total, 0);
      csvContent += `${b.name.replace(/,/g, ' ')},${bTotal.toFixed(2)} MXN\n`;
    });

    await saveFileOnDevice(`informe_dashboard_${new Date().toISOString().split('T')[0]}.csv`, utf8ToBase64(csvContent), 'text/csv');
  };

  const handleExportProducts = async () => {
    let csvContent = "\uFEFF";
    csvContent += "REPORTE DE CATALOGO E INVENTARIO GENERAL\n";
    csvContent += `Fecha de exportacion: ${new Date().toLocaleDateString()}\n`;
    csvContent += `Comercio: ${userCompanies[activeCompanyId || '']?.name || 'Empresa'}\n\n`;

    // Headers with specific Branch stocks
    let headers = "ID,Nombre,Categoria,PRECIO COMPRA (Costo),PRECIO VENTA,STOCK TOTAL,ALERTA MINIMA,SKU";
    branches.forEach(b => {
      headers += `,Stock - ${b.name.replace(/,/g, ' ')}`;
    });
    csvContent += headers + "\n";

    products.forEach(p => {
      let row = `"${p.id}","${p.name.replace(/"/g, '""')}",` +
                `"${(p.category || 'General').replace(/"/g, '""')}",` +
                `${p.costPrice || 0},${p.salePrice || 0},${p.stock || 0},${p.minStock || 0},` +
                `"${p.sku || ''}"`;
      
      branches.forEach(b => {
        const val = p.branchStocks && p.branchStocks[b.id] !== undefined ? p.branchStocks[b.id] : p.stock;
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
    const isSelectedMatriz = branches.find(b => b.id === selectedBranchId)?.isMatriz ?? false;
    const branchName = branches.find(b => b.id === selectedBranchId)?.name || 'Sucursal';
    const companyName = branding.displayName || userCompanies[activeCompanyId || '']?.name || 'Mi Comercio';

    const monthSales = sales
      .filter(s =>
        (s.branchId === selectedBranchId || (!s.branchId && isSelectedMatriz)) &&
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
    const monthCashMovements = cashRegister.transactions
      .filter((tx): tx is typeof tx & { createdAt: number } =>
        (tx.type === 'Ingreso' || tx.type === 'Egreso') &&
        tx.createdAt !== undefined && msToMonthKey(tx.createdAt) === pdfCutMonth
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const totalIngresos = monthCashMovements.filter(t => t.type === 'Ingreso').reduce((acc, t) => acc + t.amount, 0);
    const totalEgresos = monthCashMovements.filter(t => t.type === 'Egreso').reduce((acc, t) => acc + t.amount, 0);

    // Inventory movements (surtidos + transfers) for this branch and month.
    const monthStockMovements = stockMovements
      .filter(m => m.branchId === selectedBranchId && msToMonthKey(m.createdAt) === pdfCutMonth)
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
  const [transferProductId, setTransferProductId] = useState('');
  const [transferSourceBranchId, setTransferSourceBranchId] = useState('');
  const [transferTargetBranchId, setTransferTargetBranchId] = useState('');
  const [transferQuantity, setTransferQuantity] = useState(1);

  const handleOpenTransferModal = (prodId?: string) => {
    setTransferProductId(prodId || (products[0]?.id || ''));
    // Set default source and target if branches exist
    if (branches.length > 0) {
      const matriz = branches.find(b => b.isMatriz) || branches[0];
      setTransferSourceBranchId(matriz.id);
      const other = branches.find(b => b.id !== matriz.id) || branches[0];
      setTransferTargetBranchId(other.id);
    }
    setTransferQuantity(1);
    setIsTransferModalOpen(true);
  };

  const handleExecuteTransfer = async () => {
    if (!transferProductId || !transferSourceBranchId || !transferTargetBranchId) {
      alert("Por favor selecciona el producto, la sucursal origen y la sucursal destino.");
      return;
    }
    if (transferSourceBranchId === transferTargetBranchId) {
      alert("La sucursal de origen y destino no pueden ser la misma.");
      return;
    }
    if (transferQuantity <= 0) {
      alert("La cantidad a transferir debe ser mayor que cero.");
      return;
    }

    const prod = products.find(p => p.id === transferProductId);
    if (!prod) {
      alert("Producto no encontrado.");
      return;
    }

    // Source values (early UX-level check; the transfer itself re-applies atomically below)
    const sourceStocks = { ...(prod.branchStocks || {}) };
    const sourceStockVal = sourceStocks[transferSourceBranchId] !== undefined ? sourceStocks[transferSourceBranchId] : prod.stock;

    if (sourceStockVal < transferQuantity) {
      alert(`La sucursal de origen no tiene suficientes existencias. Stock disponible: ${sourceStockVal} unidades.`);
      return;
    }

    if (user && activeCompanyId) {
      try {
        // Single Firestore transaction: decrements source + increments target together,
        // reading the live document instead of a possibly-stale local copy.
        await applyStockDeltas([
          { productId: transferProductId, branchId: transferSourceBranchId, qtyDelta: -transferQuantity },
          { productId: transferProductId, branchId: transferTargetBranchId, qtyDelta: transferQuantity }
        ]);

        // Record both sides in the inventory audit log (dedicated collection, not the cash
        // register): an "out" entry for the source branch and an "in" entry for the target.
        const sourceBranchName = branches.find(b => b.id === transferSourceBranchId)?.name || 'Sucursal';
        const targetBranchName = branches.find(b => b.id === transferTargetBranchId)?.name || 'Sucursal';
        await logStockMovements([
          {
            type: 'transfer_out',
            productId: transferProductId,
            productName: prod.name,
            quantity: transferQuantity,
            branchId: transferSourceBranchId,
            branchName: sourceBranchName,
            counterpartBranchId: transferTargetBranchId,
            counterpartBranchName: targetBranchName,
          },
          {
            type: 'transfer_in',
            productId: transferProductId,
            productName: prod.name,
            quantity: transferQuantity,
            branchId: transferTargetBranchId,
            branchName: targetBranchName,
            counterpartBranchId: transferSourceBranchId,
            counterpartBranchName: sourceBranchName,
          },
        ]);

        alert(`¡Transferencia exitosa! Se movieron ${transferQuantity} unidades de "${prod.name}" desde sucursal origen a destino.`);
        setIsTransferModalOpen(false);
        setTransferProductId('');
        setTransferQuantity(1);
      } catch (err) {
        console.error("Error executing branch transfer:", err);
        alert("Ocurrió un error al guardar los cambios en la base de datos de Firebase.");
      }
    } else {
      const targetStocks = { ...(prod.branchStocks || {}) };
      const targetStockVal = targetStocks[transferTargetBranchId] !== undefined ? targetStocks[transferTargetBranchId] : prod.stock;
      sourceStocks[transferSourceBranchId] = sourceStockVal - transferQuantity;
      sourceStocks[transferTargetBranchId] = targetStockVal + transferQuantity;
      const updatedProducts = products.map(p => p.id === transferProductId ? { ...p, branchStocks: sourceStocks } : p);
      saveAllData(updatedProducts, customers, sales, cashRegister);
      alert(`¡Transferencia exitosa (Modo Offline)!`);
      setIsTransferModalOpen(false);
    }
  };

  const handleOpenBranchModal = (branch?: Branch) => {
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

  const handleSaveBranch = (e: FormEvent) => {
    e.preventDefault();
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
        id: 'B-' + Math.floor(Math.random() * 9000 + 1000),
        name: branchForm.name,
        address: branchForm.address,
        phone: branchForm.phone,
        manager: branchForm.manager,
        isMatriz: !!branchForm.isMatriz
      };
      updated = [...branches, newB];
    }
    saveAllData(products, customers, sales, cashRegister, updated, suppliers);
    setIsBranchModalOpen(false);
  };

  const handleDeleteBranch = async (bId: string) => {
    if (branches.length <= 1) {
      alert('Debe haber al menos una sucursal registrada en el sistema.');
      return;
    }
    if (confirm('¿Está seguro de eliminar esta sucursal?')) {
      const updated = branches.filter(b => b.id !== bId);
      const nextActive = selectedBranchId === bId ? updated[0].id : selectedBranchId;
      setSelectedBranchId(nextActive);
      localStorage.setItem('logic_active_branch', nextActive);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'branches', bId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/branches/${bId}`);
        }
      }
      saveAllData(products, customers, sales, cashRegister, updated, suppliers);
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

  const handleSaveSupplier = (e: FormEvent) => {
    e.preventDefault();
    if (!supplierForm.name) {
      alert('El nombre del proveedor es obligatorio.');
      return;
    }

    const targetSupplierId = editingSupplier ? editingSupplier.id : ('prov-' + Math.floor(Math.random() * 90000 + 10000));

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

    // Link/unlink products on firebase/localStorage
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

    saveAllData(processedProducts, customers, sales, cashRegister, branches, updated);
    setIsSupplierModalOpen(false);
  };

  const handleDeleteSupplier = async (sId: string) => {
    if (confirm('¿Está seguro de eliminar este proveedor? Los artículos correspondientes se desvincularán del proveedor.')) {
      const updated = suppliers.filter(s => s.id !== sId);
      const updatedProducts = products.map(p => p.supplierId === sId ? { ...p, supplierId: undefined } : p);
      if (user && activeCompanyId) {
        try {
          await deleteDoc(doc(db, 'companies', activeCompanyId, 'suppliers', sId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `companies/${activeCompanyId}/suppliers/${sId}`);
        }
      }
      saveAllData(updatedProducts, customers, sales, cashRegister, branches, updated);
    }
  };

  // Supplier Supply Order (Surtido / Compra) State & Handler
  const [isRestockOpen, setIsRestockOpen] = useState(false);
  const [restockForm, setRestockForm] = useState({
    supplierId: '',
    productId: '',
    qty: '',
    cost: ''
  });

  const handleOpenRestock = (supplierId?: string, productId?: string) => {
    setRestockForm({
      supplierId: supplierId || '',
      productId: productId || '',
      qty: '',
      cost: ''
    });
    setIsRestockOpen(true);
  };

  const handleSaveRestock = (e: FormEvent) => {
    e.preventDefault();
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

    const totalExpense = q * c;

    // Optional confirmation if register is low on cash
    if (cashRegister.currentCash < totalExpense) {
      if (!confirm(`La caja actual tiene ${formatMXN(cashRegister.currentCash)} y el gasto total es de ${formatMXN(totalExpense)}. ¿Desea proceder con saldo negativo en caja?`)) {
        return;
      }
    }

    // Stock increment is atomic (transaction); cost/supplier metadata is a plain field set
    applyStockDeltas([{ productId, branchId: selectedBranchId, qtyDelta: q }]);
    if (user && activeCompanyId) {
      updateDoc(doc(db, 'companies', activeCompanyId, 'products', productId), {
        costPrice: c, // Record new supplier cost price automatically!
        supplierId
      }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/products/${productId}`));
    }

    // Outflow Egreso in Register (atomic — see applyCashDelta)
    applyCashDelta(selectedBranchId, -totalExpense, [{
      type: 'Egreso',
      amount: totalExpense,
      description: `Surtido de Stock: ${q}x ${prod.name} (Ref: ${supp.name})`,
      time: new Date().toLocaleTimeString(),
      createdAt: Date.now()
    }]);

    setIsRestockOpen(false);
    alert(`¡Reabastecimiento procesado! Se añadieron ${q} unidades de ${prod.name} y se generó un egreso de ${formatMXN(totalExpense)} en Caja.`);
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

  const handleSaveCustomer = (e: FormEvent) => {
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
        id: 'C-' + Math.floor(Math.random() * 90000 + 10000),
        name: custForm.name,
        phone: custForm.phone,
        email: custForm.email,
        unpaidBalance: 0,
        registeredDate: new Date().toISOString().substring(0, 10)
      };
      updatedCustomers = [...customers, newCust];
    }

    saveAllData(products, updatedCustomers, sales, cashRegister);
    setIsCustomerModalOpen(false);
  };

  const handlePayBalance = (custId: string, amountToPay: number) => {
    if (amountToPay <= 0) return;
    const target = customers.find(c => c.id === custId);
    if (!target) return;

    const actualPayAmount = Math.min(target.unpaidBalance, amountToPay);
    if (actualPayAmount <= 0) {
      alert('Este cliente no tiene saldo pendiente.');
      return;
    }

    applyCustomerBalanceDelta(custId, -actualPayAmount);
    applyCashDelta(selectedBranchId, actualPayAmount, [{
      type: 'Ingreso',
      amount: actualPayAmount,
      description: `Abono "Fiado" de ${target.name}`,
      time: new Date().toLocaleTimeString(),
      createdAt: Date.now()
    }]);
    alert(`Abono aplicado con éxito: ${formatMXN(actualPayAmount)}`);
  };

  // Refund Venta
  const handleRefundSale = (saleId: string) => {
    if (confirm('¿Está seguro de que desea REEMBOLSAR esta venta? Se restituirá el inventario.')) {
      const sale = sales.find(s => s.id === saleId);
      if (!sale) return;

      // Restore inventories atomically (per-product Firestore transaction)
      applyStockDeltas(sale.items.map(item => ({
        productId: item.productId,
        branchId: sale.branchId || selectedBranchId,
        qtyDelta: item.quantity
      })));

      // Adjust customer balance if it was Credit (atomic)
      if (sale.customerId && sale.paymentMethod === 'Credit') {
        applyCustomerBalanceDelta(sale.customerId, -sale.total);
      }

      // Deduct from cash if it was Cash, but always log in transactions audit history (atomic)
      const refundPaymentLabel = sale.paymentMethod === 'Cash' ? 'Efectivo' : sale.paymentMethod === 'Card' ? 'Tarjeta' : sale.paymentMethod === 'Transfer' ? 'Transferencia' : 'Crédito';
      const refundBranchId = sale.branchId || selectedBranchId;
      applyCashDelta(refundBranchId, sale.paymentMethod === 'Cash' ? -sale.total : 0, [{
        type: 'Egreso',
        amount: sale.total,
        description: `Cancelación/Reembolso Venta ${sale.id} (${refundPaymentLabel})`,
        time: new Date().toLocaleTimeString(),
        createdAt: Date.now(),
        branchId: refundBranchId
      }]);

      // Status change (only this single sale doc gets written/diffed)
      const updatedSales = sales.map(s => s.id === saleId ? { ...s, status: 'Refunded' as const } : s);
      saveAllData(products, customers, updatedSales, cashRegister);
      alert('Venta reembolsada con éxito.');
    }
  };

  // Cash Management State
  const [cashFlowAmount, setCashFlowAmount] = useState('');
  const [cashFlowDesc, setCashFlowDesc] = useState('');
  const [historySubTab, setHistorySubTab] = useState<'sales' | 'cashLog' | 'inventory'>('sales');

  // Statistics month scope: 'all' shows all-time totals, otherwise a specific "YYYY-MM"
  const [statsMonth, setStatsMonth] = useState<string>(getCurrentMonthKey());
  // Month scope for the "Corte Mensual (PDF)" export in Historial/Caja
  const [pdfCutMonth, setPdfCutMonth] = useState<string>(getCurrentMonthKey());
  
  const handleRecordCashFlow = (type: 'Ingreso' | 'Egreso') => {
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
    applyCashDelta(selectedBranchId, valueSigned, [{
      type,
      amount: val,
      description: cashFlowDesc,
      time: new Date().toLocaleTimeString(),
      createdAt: Date.now(),
      branchId: selectedBranchId
    }]);
    setCashFlowAmount('');
    setCashFlowDesc('');
    alert(`Registo de ${type} en caja de ${formatMXN(val)} guardado.`);
  };


  // Sales/transactions scoped to the currently selected branch — shared by the POS
  // terminal's quick history, the Historial/Caja tab, and the analytics below, so
  // switching branches consistently filters everything derived from `sales`.
  const isSelectedBranchMatriz = useMemo(() => branches.find(b => b.id === selectedBranchId)?.isMatriz ?? false, [branches, selectedBranchId]);
  const branchScopedSales = useMemo(() =>
    sales.filter(s => s.branchId === selectedBranchId || (!s.branchId && isSelectedBranchMatriz)),
    [sales, selectedBranchId, isSelectedBranchMatriz]
  );
  // `cashRegister` is now the selected branch's own document (see the dedicated
  // onSnapshot effect above), so every entry in it already belongs to this branch —
  // no filtering needed here anymore, unlike branchScopedSales above.
  const branchScopedTransactions = cashRegister.transactions;

  // Inventory movements (surtidos + transfers) that touch the active branch.
  const branchScopedStockMovements = useMemo(
    () => stockMovements.filter(m => m.branchId === selectedBranchId),
    [stockMovements, selectedBranchId]
  );

  // 'Transferencia' entries carry a unit count in `amount`, not a currency value —
  // formatMXN would misleadingly render "5" as "$5.00 MXN".
  const formatTxAmount = (tx: CashRegister['transactions'][number]) =>
    tx.type === 'Transferencia' ? `${tx.amount} unid.` : formatMXN(tx.amount);

  // Analytics helper metrics
  const availableStatsMonths = useMemo(() => getAvailableMonths(sales), [sales]);

  const stats = useMemo(() => {
    const isSelectedMatriz = branches.find(b => b.id === selectedBranchId)?.isMatriz ?? false;
    const activeSales = sales.filter(s =>
      s.status === 'Completed' &&
      (s.branchId === selectedBranchId || (!s.branchId && isSelectedMatriz)) &&
      (statsMonth === 'all' || getSaleMonthKey(s) === statsMonth)
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
    const lowStockItems = products.filter(p => getProductStock(p, selectedBranchId) <= p.minStock);

    // Group sales by Category
    const categoryPopularity: { [key: string]: number } = {};
    activeSales.forEach(s => {
      s.items.forEach(item => {
        const p = products.find(prod => prod.id === item.productId);
        const cat = p ? p.category : 'Otros';
        categoryPopularity[cat] = (categoryPopularity[cat] || 0) + item.quantity;
      });
    });

    return { grossRevenue, profit, averageTicket, lowStockItems, categoryPopularity, activeSalesCount: activeSales.length };
  }, [sales, products, selectedBranchId, branches, statsMonth]);

  // Inline style for active nav buttons — adapts to brand palette
  const navActiveStyle: React.CSSProperties = {
    backgroundColor: `color-mix(in srgb, var(--brand-primary) 14%, white)`,
    color: `var(--brand-primary)`,
    borderColor: `color-mix(in srgb, var(--brand-primary) 22%, transparent)`,
  };
  const navBaseClass = 'flex flex-row items-center space-x-3 px-4 py-2.5 rounded-xl transition duration-150 font-semibold text-sm w-full cursor-pointer flex-shrink-0';
  const navInactiveClass = `${navBaseClass} text-slate-600 hover:bg-slate-50 hover:text-slate-900`;
  const navActiveClass = `${navBaseClass} shadow-sm border`;

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
                  {userCompanies[activeCompanyId]?.role === 'owner' ? 'Propietario' : userCompanies[activeCompanyId]?.role === 'master_admin' ? 'Master Admin' : userCompanies[activeCompanyId]?.role === 'admin' ? 'Admin' : 'Empleado'}
                </span>
              ) : (
                <span className="hidden md:inline-block px-2 py-0.5 text-white font-bold text-[10px] rounded-full shadow-sm shrink-0" style={{ backgroundColor: 'var(--brand-primary)' }}>LOGIC POS</span>
              )}
            </div>
             {/* Active Branch Switching Selector in Header */}
            {branches.length > 0 && (
              <div className="mt-1 flex items-center space-x-1 overflow-hidden shrink min-w-0">
                <span className="text-[9px] lg:text-[10px] font-extrabold uppercase tracking-wider hidden sm:block" style={{ color: 'color-mix(in srgb, var(--brand-primary) 65%, white)' }}>Sucursal:</span>
                {activeCompanyRole === 'employee' ? (
                  <span className="border rounded px-1.5 lg:px-2 py-0.5 text-[9px] lg:text-[10px] font-bold truncate text-white" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 80%, black)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
                    <MapPin className="w-2.5 h-2.5 inline mr-0.5" />{branches.find(b => b.id === selectedBranchId)?.name || 'Sucursal Principal'}
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
          <div className="hidden lg:flex items-center space-x-2 text-sm font-medium opacity-90">
            <span className="px-2.5 py-1 rounded-md border font-bold text-white text-xs" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 60%, transparent)', borderColor: 'color-mix(in srgb, var(--brand-primary) 30%, transparent)' }}>
              Caja Registradora: {formatMXN(cashRegister.currentCash)}
            </span>
            <span className="text-xs px-2 py-1 rounded border font-semibold text-white" style={{ backgroundColor: 'color-mix(in srgb, var(--brand-dark) 50%, transparent)', borderColor: 'color-mix(in srgb, var(--brand-primary) 25%, transparent)' }}>
              {nowStr}
            </span>
          </div>

          {/* Authentication Status UI */}
          {isAuthLoading ? (
            <div className="text-xs text-white/70">Conectando...</div>
          ) : user ? (
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
                  onClick={() => { localStorage.removeItem(`logic_active_company_${user.uid}`); setActiveCompanyId(null); }}
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
          ) : (
            <button
              onClick={() => setIsAuthModalOpen(true)}
              className="flex items-center space-x-1.5 text-white font-extrabold text-[10px] lg:text-xs px-2 lg:px-3.5 py-1.5 lg:py-2 rounded-xl shadow-md cursor-pointer transition group whitespace-nowrap"
              style={{ backgroundColor: 'var(--brand-primary)' }}
            >
              <Sparkles className="w-3.5 h-3.5 text-white/80 group-hover:rotate-12 transition duration-200" />
              <span>Conectar Nube</span>
            </button>
          )}
        </div>
      </header>

      {/* Alert Warn: Unclosed cash register from previous day */}
      {showOvernightWarning && (
        <div className="bg-gradient-to-r from-amber-500 via-amber-655 to-red-600 text-white px-6 py-3 shadow-md flex justify-between items-center space-x-4 animate-pulse z-10 border-b border-amber-500/10">
          <div className="flex items-center space-x-3 text-xs leading-relaxed">
            <AlertCircle className="w-5 h-5 flex-shrink-0 animate-bounce text-white" />
            <div>
              <span className="font-black text-xs block tracking-wider uppercase opacity-90">⚠️ Alerta Contable</span>
              El sistema detectó que <strong className="underline">no se realizó el corte de caja</strong> el día anterior (<span className="font-mono">{warningOperationalDate || 'ayer'}</span>). Por favor, realiza el corte antes de registrar ventas hoy para mantener la contabilidad exacta y organizada.
            </div>
          </div>
          <div className="flex items-center space-x-2.5 flex-shrink-0">
            <button
              onClick={() => {
                setRealCashInput(cashRegister.currentCash.toString());
                setIsCorteModalOpen(true);
              }}
              className="bg-white text-amber-900 hover:bg-amber-50 font-extrabold text-[10px] px-3.5 py-1.5 rounded-lg shadow-sm cursor-pointer border border-amber-200 transition uppercase tracking-wider"
            >
              Hacer Corte Ahora 📝
            </button>
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
        <div className="bg-gradient-to-r from-amber-500 via-amber-655 to-red-600 text-white px-6 py-3 shadow-md flex justify-between items-center space-x-4 animate-pulse z-10 border-b border-amber-500/10">
          <div className="flex items-center space-x-3 text-xs leading-relaxed">
            <AlertCircle className="w-5 h-5 flex-shrink-0 animate-bounce text-white" />
            <div>
              <span className="font-black text-xs block tracking-wider uppercase opacity-90">⚠️ Caja Cerrada</span>
              La caja registradora está <strong className="underline">cerrada</strong>. Por favor, realiza la apertura de caja antes de registrar ventas.
            </div>
          </div>
          <div className="flex items-center space-x-2.5 flex-shrink-0">
            <button
              onClick={() => {
                setOpeningCashInput('500');
                setIsOpeningCajaModalOpen(true);
              }}
              className="bg-white text-amber-900 hover:bg-amber-50 font-extrabold text-[10px] px-3.5 py-1.5 rounded-lg shadow-sm cursor-pointer border border-amber-200 transition uppercase tracking-wider"
            >
              Abrir Caja Ahora 🚀
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

          {activeCompanyRole !== 'employee' && [
            { id: 'branches',   label: 'Sucursales',          icon: <Store className="w-5 h-5" /> },
            { id: 'suppliers',  label: 'Proveedores',         icon: <Truck className="w-5 h-5" /> },
            { id: 'invoicing',  label: 'Facturación',         icon: <FileText className="w-5 h-5" /> },
            { id: 'history',    label: 'Historial / Caja',    icon: <Receipt className="w-5 h-5" /> },
            { id: 'analytics',  label: 'Estadísticas',        icon: <BarChart3 className="w-5 h-5" /> },
          ].map(({ id, label, icon }) => (
            <button key={id} id={`nav-${id}`}
              onClick={() => { setActiveTab(id as typeof activeTab); setIsMobileMenuOpen(false); }}
              className={activeTab === id ? navActiveClass : navInactiveClass}
              style={activeTab === id ? navActiveStyle : {}}
            >
              {icon}<span className="mt-1 md:mt-0">{label}</span>
            </button>
          ))}

          <button id="nav-settings"
            onClick={() => { setActiveTab('settings'); setIsMobileMenuOpen(false); }}
            className={activeTab === 'settings' ? navActiveClass : navInactiveClass}
            style={activeTab === 'settings' ? navActiveStyle : {}}
          >
            <Settings className="w-5 h-5" /><span className="mt-1 md:mt-0">Mi Empresa / Equipo</span>
          </button>
        </nav>

        {/* Dynamic Frame Screen Views */}
        <main className="flex-grow p-4 md:p-6 select-none overflow-y-auto max-w-7xl mx-auto w-full">
          
          {/* SCREEN: TERMINAL POS */}
          {activeTab === 'pos' && (
            <div className="space-y-4">
              {!user && (
                <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white p-4 rounded-2xl border border-indigo-900 shadow-md flex flex-col md:flex-row justify-between items-center space-y-3 md:space-y-0 md:space-x-4">
                  <div className="flex items-center space-x-3.5 text-left">
                    <div className="p-3 bg-indigo-900/40 rounded-xl border border-indigo-850">
                      <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                    </div>
                    <div>
                      <h4 className="font-extrabold text-xs sm:text-sm text-slate-100">¡Sincroniza tu POS en la Nube con Google Cloud / Firebase!</h4>
                      <p className="text-[11px] text-indigo-300">Estás operando en modo Local. Conecta tu cuenta Google para respaldar tu catálogo de ventas, clientes, sucursales y proveedores en base de datos segura de tiempo real.</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setIsAuthModalOpen(true)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center space-x-1.5 whitespace-nowrap"
                  >
                    <Check className="w-4 h-4" />
                    <span>Conectar Google Cloud</span>
                  </button>
                </div>
              )}
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
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-150'
                        : 'text-slate-505 hover:text-slate-800'
                    }`}
                  >
                    <ShoppingCart className="w-3.5 h-3.5 inline mr-1" /><span>Catálogo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPosSubTab('history')}
                    className={`flex-1 py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                      posSubTab === 'history'
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-150'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <span>📜 Historial ({branchScopedSales.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPosSubTab('cashier')}
                    className={`flex-1 py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center space-x-2 cursor-pointer ${
                      posSubTab === 'cashier'
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-150'
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
                            className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-505 text-sm font-medium transition"
                          />
                        </div>
                        {/* View toggle: cards vs compact list — helps a lot once the
                            catalog has many products, since list rows pack far more of
                            them on screen without scrolling. */}
                        <div className="flex bg-slate-100 border border-slate-200 rounded-xl p-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => { setPosCatalogView('grid'); localStorage.setItem('logic_pos_catalog_view', 'grid'); }}
                            className={`p-2.5 rounded-lg transition cursor-pointer ${posCatalogView === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                            title="Vista de tarjetas"
                            aria-label="Vista de tarjetas"
                          >
                            <LayoutGrid className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setPosCatalogView('list'); localStorage.setItem('logic_pos_catalog_view', 'list'); }}
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
                              className="mt-4 px-4 py-2 bg-indigo-605 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl shadow cursor-pointer transition"
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
                               className="bg-white border border-slate-200/80 hover:border-indigo-505 rounded-2xl p-3 sm:p-4 flex flex-col justify-between cursor-pointer transition-all hover:shadow-md relative group duration-150"
                            >
                              {/* Stock Badges */}
                              <div className="flex flex-wrap gap-1 justify-between items-start mb-2">
                                <span className="text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200/50 truncate max-w-[60%]">
                                  {prod.category}
                                </span>
                                <span className={`text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full shrink-0 ${
                                  getProductStock(prod, selectedBranchId) <= prod.minStock
                                    ? 'bg-amber-100 text-amber-700 font-extrabold animate-pulse'
                                    : 'bg-slate-50 text-slate-600'
                                }`}>
                                  Stock: {getProductStock(prod, selectedBranchId)}
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
                          const low = getProductStock(prod, selectedBranchId) <= prod.minStock;
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
                                    {low && <AlertCircle className="w-3 h-3 inline mr-0.5" />}Stock: {getProductStock(prod, selectedBranchId)}
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

                {posSubTab === 'history' && (
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
                          <div key={sale.id} className="border border-slate-150 rounded-xl p-3 bg-slate-50 hover:bg-white transition duration-150 space-y-2 overflow-hidden">
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
                                  <p className="text-[10px] text-indigo-600 font-semibold mt-1 truncate">🏷️ Cliente: {sale.customerName}</p>
                                )}
                                {sale.employeeName && (
                                  <p className="text-[10px] text-slate-500 font-semibold mt-0.5 truncate">👤 Atendido por: {sale.employeeName}</p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-extrabold text-indigo-700 text-xs">{formatMXN(sale.total)}</p>
                                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full border block mt-1 ${
                                  sale.status === 'Completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-750 border-red-200'
                                }`}>
                                  {sale.status === 'Completed' ? 'Exitosa' : 'Reembolsada'}
                                </span>
                              </div>
                            </div>

                            {/* Options block for completed terminal sale */}
                            <div className="pt-2 border-t border-slate-100 flex justify-between items-center gap-2">
                              {sale.status === 'Completed' ? (
                                isOwnerOrAdminRole ? (
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
                                className="text-[9px] font-black bg-indigo-50 border border-indigo-150 hover:bg-indigo-600 hover:text-white px-2.5 py-1 rounded text-indigo-600 transition cursor-pointer"
                              >
                                📥 Compartir / Recibo
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
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                        cashRegister.isOpen ? 'bg-emerald-100 text-emerald-850 border border-emerald-250' : 'bg-rose-105 text-rose-800 border border-rose-250 animate-pulse'
                      }`}>
                        Estado: {cashRegister.isOpen ? 'Caja Abierta ✓' : 'Caja Cerrada ✗'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-2 gap-4">
                      <div className="bg-slate-50 border border-slate-150 p-4 rounded-2xl space-y-1 text-left">
                        <span className="text-[9px] text-slate-400 font-black uppercase">Saldo Inicial de Turno</span>
                        <p className="text-sm font-black text-slate-700 font-mono">{formatMXN(cashRegister.initialCash)}</p>
                      </div>
                      <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-2xl space-y-1 text-left">
                        <span className="text-[9px] text-indigo-500 font-black uppercase">Efectivo Sugerido (Sistema)</span>
                        <p className="text-sm font-black text-indigo-750 font-mono">{formatMXN(cashRegister.currentCash)}</p>
                      </div>
                    </div>

                    <div className="flex justify-center pt-1">
                      {cashRegister.isOpen ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRealCashInput(cashRegister.currentCash.toString());
                            setIsCorteModalOpen(true);
                          }}
                          className="w-full py-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition uppercase tracking-wider"
                        >
                          Corte de Caja (Cierre de Turno) 📝
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setOpeningCashInput('500');
                            setIsOpeningCajaModalOpen(true);
                          }}
                          className="w-full py-3 bg-gradient-to-r from-indigo-600 to-indigo-750 hover:from-indigo-700 hover:to-indigo-800 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition uppercase tracking-wider animate-pulse"
                        >
                          Realizar Apertura de Caja 🚀
                        </button>
                      )}
                    </div>

                    {cashRegister.isOpen && (
                      <div className="bg-slate-50 border border-slate-150 p-4 rounded-2xl space-y-4 text-left">
                        <h4 className="font-extrabold text-slate-700 text-xs">💵 Movimiento de Caja Manual</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1/2">
                            <label className="text-[10px] text-slate-400 font-bold block">Concepto o Descripción *</label>
                            <input
                              type="text"
                              placeholder="Ej: Pago de gas, Propina"
                              value={cashFlowDesc}
                              onChange={e => setCashFlowDesc(e.target.value)}
                              className="w-full bg-white border border-slate-205 rounded-xl px-3 py-2 outline-none font-bold text-xs"
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
                                className="w-1/2 bg-white border border-slate-205 rounded-xl px-3 py-2 outline-none font-bold text-xs"
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

                    <div className="space-y-2 text-left">
                      <h4 className="font-extrabold text-xs text-slate-600">📜 Transacciones del Turno</h4>
                      <div className="border border-slate-150 rounded-2xl bg-white divide-y divide-slate-100 max-h-48 overflow-y-auto pr-1">
                        {cashRegister.transactions.slice().reverse().map((tx, idx) => (
                          <div key={idx} className="p-3 flex justify-between items-center text-xs">
                            <div className="space-y-0.5">
                              <p className="font-extrabold text-slate-700">{tx.description}</p>
                              <p className="text-[9px] text-slate-400 font-mono italic">{tx.time}</p>
                            </div>
                            <span className={`font-mono font-black text-[10px] px-2 py-0.5 rounded ${
                              tx.type === 'Ingreso' ? 'bg-emerald-50 text-emerald-800' : tx.type === 'Transferencia' ? 'bg-sky-50 text-sky-700' : 'bg-rose-50 text-rose-800'
                            }`}>
                              {tx.type === 'Ingreso' ? '+' : tx.type === 'Transferencia' ? '' : '-'}{formatTxAmount(tx)}
                            </span>
                          </div>
                        ))}
                        {cashRegister.transactions.length === 0 && (
                          <p className="text-center text-[10px] text-slate-400 py-6">Ninguna transacción registrada en la sesión actual.</p>
                        )}
                      </div>
                    </div>
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
                        className="text-xs text-slate-400 hover:text-indigo-650 font-semibold cursor-pointer"
                      >
                        Vaciar
                      </button>
                    )}
                  </div>
 
                  {/* Customer Selector inside Cart */}
                  <div className="bg-indigo-55/10 p-3 rounded-xl border border-dashed border-indigo-200/55 mb-4">
                    {selectedCustomer ? (
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-xs text-slate-400 uppercase tracking-widest font-extrabold">Cliente Seleccionado</p>
                          <p className="font-extrabold text-sm text-slate-800 mt-0.5">{selectedCustomer.name}</p>
                          <p className="text-xs text-slate-500">Saldo "Fiado" Pendiente: <span className="font-bold text-purple-650">{formatMXN(selectedCustomer.unpaidBalance)}</span></p>
                        </div>
                        <button 
                          onClick={() => setSelectedCustomer(null)}
                          className="p-1 text-slate-400 hover:text-purple-650 bg-white shadow rounded-full"
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
                  {cart.length > 0 && (
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
                          onChange={(e) => setDiscountVal(Math.max(0, parseFloat(e.target.value) || 0))}
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
                      className="w-full py-3.5 text-white font-extrabold text-center rounded-xl shadow-lg hover:shadow-xl transition-all duration-150 flex items-center justify-center space-x-2 cursor-pointer"
                      style={{ backgroundColor: 'var(--brand-primary)', filter: 'none' }}
                      onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(1.1)')}
                      onMouseLeave={e => (e.currentTarget.style.filter = 'none')}
                    >
                      <CircleDollarSign className="w-5 h-5 text-white animate-spin" style={{ animationDuration: '4s' }} />
                      <span>PROCESAR VENTA ({formatMXN(cartValues.total)})</span>
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
                      onClick={() => { setInventoryView('grid'); localStorage.setItem('logic_inventory_view', 'grid'); }}
                      className={`p-2 rounded-lg transition cursor-pointer ${inventoryView === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                      title="Vista de tarjetas"
                      aria-label="Vista de tarjetas"
                    >
                      <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { setInventoryView('list'); localStorage.setItem('logic_inventory_view', 'list'); }}
                      className={`p-2 rounded-lg transition cursor-pointer ${inventoryView === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                      title="Vista de lista"
                      aria-label="Vista de lista"
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                {activeCompanyRole !== 'employee' && (
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={handleExportProducts}
                      className="bg-emerald-600 hover:bg-emerald-705 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                      title="Exportar catálogo completo con existencias multisuccursal a CSV"
                    >
                      📥 Exportar Inventario (CSV)
                    </button>
                    <button
                      onClick={() => setIsCategoryModalOpen(true)}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-705 border border-slate-200 font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                    >
                      <Layers className="w-4 h-4 text-slate-500" />
                      Editar Categorías
                    </button>
                    <button
                      onClick={() => handleOpenProductModal()}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-sm px-4 py-2.5 rounded-xl flex items-center whitespace-nowrap gap-2 cursor-pointer shadow-sm transition"
                    >
                      <Plus className="w-4 h-4" />
                      + Nuevo Producto
                    </button>
                  </div>
                )}
                </div>
              </div>

              {/* Inventory: card grid or compact list depending on the user's toggle */}
              {inventoryView === 'grid' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {products.map(prod => (
                  <div key={prod.id} className="border border-slate-200/80 rounded-2xl p-4 flex flex-col justify-between hover:border-indigo-30 shadow-sm duration-150">
                    <div className="space-y-2.5">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                          {prod.category}
                        </span>
                        {getProductStock(prod, selectedBranchId) <= prod.minStock && (
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
                        <div>
                          <h4 className="font-extrabold text-slate-800 text-sm leading-tight">{prod.name}</h4>
                          <p className="text-[10px] text-slate-400 font-mono">ID: {prod.id} {prod.sku ? `| SKU: ${prod.sku}` : ''}</p>
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
                            {prod.costPrice > 0 ? `${(((prod.salePrice - prod.costPrice) / prod.salePrice) * 100).toFixed(0)}%` : '100%'}
                          </p>
                        </div>
                        <div className="text-center bg-slate-50 p-1.5 rounded">
                          <p className="text-slate-400 font-medium">Costo</p>
                          <p className="font-bold text-slate-700">{formatMXN(prod.costPrice)}</p>
                        </div>
                        <div className="text-center bg-indigo-55/10 p-1.5 rounded">
                          <p className="text-indigo-400 font-medium">Precio</p>
                          <p className="font-bold text-indigo-700">{formatMXN(prod.salePrice)}</p>
                        </div>
                      </div>

                      <div className="flex justify-between text-xs font-semibold text-slate-600 pt-1">
                        <span>Cant. en Inventario:</span>
                        <span className={`font-bold ${getProductStock(prod, selectedBranchId) <= prod.minStock ? 'text-purple-650' : 'text-slate-800'}`}>{getProductStock(prod, selectedBranchId)} u.</span>
                      </div>

                      {activeCompanyRole !== 'employee' && branches.length > 1 && (
                        <div className="mt-2 bg-slate-50 p-2 rounded-lg border border-slate-100 text-[10px] space-y-1 text-left">
                          <p className="font-extrabold text-slate-400 uppercase tracking-wider">Stock por Sucursal:</p>
                          <div className="space-y-0.5 max-h-20 overflow-y-auto">
                            {branches.map(b => (
                              <div key={b.id} className="flex justify-between items-center text-slate-600 font-bold">
                                <span className="truncate">{b.name}:</span>
                                <span className={getProductStock(prod, b.id) <= prod.minStock ? 'text-amber-600' : 'text-slate-800'}>
                                  {getProductStock(prod, b.id)} u.
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {activeCompanyRole !== 'employee' ? (
                      <div className="mt-4 pt-4 border-t border-slate-100">
                        {branches.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleOpenTransferModal(prod.id)}
                            className="w-full py-2 mb-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 text-xs font-black rounded-xl cursor-pointer transition text-center flex items-center justify-center space-x-1"
                          >
                            <Package className="w-3.5 h-3.5 inline mr-1" /><span>Transferir / Repartir Stock</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { setQuickStockProduct(prod); setQuickStockAmount(''); }}
                          className="w-full py-2 mb-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 text-emerald-700 text-xs font-black rounded-xl cursor-pointer transition text-center flex items-center justify-center"
                          title={`Sumar unidades al stock de ${branches.find(b => b.id === selectedBranchId)?.name || 'esta sucursal'}`}
                        >
                          <Plus className="w-3.5 h-3.5 inline mr-1" /><span>Surtir Stock</span>
                        </button>
                        <div className="flex space-x-2">
                          <button
                            onClick={() => handleOpenProductModal(prod)}
                            className="w-1/2 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer transition text-center"
                          >
                            Editar Art.
                          </button>
                          <button 
                            onClick={() => handleDeleteProduct(prod.id)}
                            className="w-1/2 py-2 hover:bg-purple-50 text-purple-605 text-xs font-bold rounded-xl border border-transparent hover:border-purple-200 cursor-pointer transition text-center"
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 pt-3 border-t border-slate-50 text-center text-[10px] text-slate-400 font-semibold select-none">
                        ⚙️ Solo Administradores pueden gestionar stock
                      </div>
                    )}
                  </div>
                ))}
              </div>
              ) : (
              <div className="border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100">
                {products.length === 0 && (
                  <p className="text-center text-sm text-slate-400 py-10">No hay productos en el catálogo.</p>
                )}
                {products.map(prod => {
                  const branchStock = getProductStock(prod, selectedBranchId);
                  const low = branchStock <= prod.minStock;
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
                      </div>
                      {activeCompanyRole !== 'employee' && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => { setQuickStockProduct(prod); setQuickStockAmount(''); }}
                            className="p-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 text-emerald-700 rounded-lg cursor-pointer transition"
                            title="Surtir stock"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                          {branches.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleOpenTransferModal(prod.id)}
                              className="p-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 rounded-lg cursor-pointer transition shrink-0"
                              title="Transferir / repartir stock"
                            >
                              <Package className="w-3.5 h-3.5" />
                            </button>
                          )}
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
                    <div className="space-y-1.5 flex-grow">
                      <div className="flex items-center space-x-2">
                        <h4 className="font-extrabold text-lg text-slate-800 leading-tight">{cust.name}</h4>
                        <span className="text-[10px] bg-slate-100 border text-slate-400 font-mono py-0.5 px-2 rounded-full">ID: {cust.id}</span>
                      </div>
                      
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-semibold text-slate-600">
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Contacto Tel.</p>
                          <p className="text-slate-850 font-bold">{cust.phone || 'Vacio'}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-[10px] uppercase">Correo Electrónico</p>
                          <p className="text-slate-800 font-bold truncate">{cust.email || 'Vacio'}</p>
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
                        <span className="text-slate-505 font-bold">Saldo Fiado:</span>
                        <span className={`text-sm font-extrabold ${cust.unpaidBalance > 0 ? 'text-purple-605 animate-pulse' : 'text-emerald-600'}`}>
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
                                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3 py-1 rounded transition"
                              >
                                ✓
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
                        <span className="text-[10px] text-center bg-emerald-50 text-emerald-700 font-semibold p-1.5 rounded block">
                          ✓ Cuenta al día
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
          {activeTab === 'history' && (
            <div className="space-y-6">

              {/* Cash Register Control Card */}
              <div className="rounded-3xl p-6 text-white shadow-md grid grid-cols-1 md:grid-cols-12 gap-6 items-center border" style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--brand-dark) 95%, black), color-mix(in srgb, var(--brand-dark) 82%, black), color-mix(in srgb, var(--brand-dark) 70%, black))', borderColor: 'color-mix(in srgb, var(--brand-dark) 55%, black)' }}>
                <div className="md:col-span-4 space-y-1">
                  <span className="text-[10px] font-extrabold py-1 px-3 rounded-full uppercase tracking-wider" style={{ color: 'color-mix(in srgb, var(--brand-primary) 45%, white)', backgroundColor: 'color-mix(in srgb, var(--brand-dark) 40%, black)' }}>Caja Activa (Flujo del día)</span>
                  <p className="text-2xl font-extrabold">Efectivo en Caja</p>
                  <p className="text-3xl font-black text-yellow-400">{formatMXN(cashRegister.currentCash)}</p>
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
                         onClick={() => {
                           const val = parseFloat(newInitialCash);
                           if (!isNaN(val) && val >= 0) {
                             const diff = val - cashRegister.initialCash;
                             if (user && activeCompanyId) {
                               setDoc(doc(db, 'companies', activeCompanyId, 'cashRegisters', selectedBranchId), {
                                 initialCash: val,
                                 currentCash: increment(diff)
                               }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `companies/${activeCompanyId}/cashRegisters/${selectedBranchId}`));
                             }
                             setEditInitialCashPrompt(false);
                           }
                         }}
                         className="bg-emerald-500 hover:bg-emerald-600 text-white px-2 py-0.5 text-[10px] rounded font-bold transition shadow-sm"
                       >✓ Guardar
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
                      {(activeCompanyRole === 'owner' || activeCompanyRole === 'master_admin') && (
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
                  {cashRegister.transactions.map((tx, idx) => (
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
                      className="px-4 py-2.5 text-white font-black text-xs rounded-xl shadow-md flex items-center space-x-2 transition cursor-pointer whitespace-nowrap"
                      style={{ backgroundColor: 'var(--brand-primary)' }}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Descargar PDF</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Sales Invoice history list and Cash register details */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-6 text-left">
                <div className="flex flex-col md:flex-row md:items-center justify-between pb-3 border-b border-slate-100 gap-4">
                  <div>
                    <h2 className="text-xl font-extrabold text-slate-800">Historial & Control de Caja</h2>
                    <p className="text-xs text-slate-500 mt-1">Inspecciona y revisa el listado completo de flujos de efectivo, ventas, egresos y cancelaciones correspondientes a esta sucursal.</p>
                  </div>

                  <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-xl w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={() => setHistorySubTab('sales')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        historySubTab === 'sales'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={historySubTab === 'sales' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <Receipt className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span>Ventas ({branchScopedSales.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistorySubTab('cashLog')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        historySubTab === 'cashLog'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={historySubTab === 'cashLog' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <CircleDollarSign className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span className="sm:hidden">Caja ({branchScopedTransactions.length})</span>
                      <span className="hidden sm:inline">Auditoría de Caja ({branchScopedTransactions.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistorySubTab('inventory')}
                      className={`px-3 sm:px-4 py-2 rounded-lg font-extrabold text-xs transition cursor-pointer flex items-center whitespace-nowrap ${
                        historySubTab === 'inventory'
                          ? 'bg-white shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={historySubTab === 'inventory' ? { color: 'var(--brand-primary)' } : {}}
                    >
                      <Package className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      <span>Inventario ({branchScopedStockMovements.length})</span>
                    </button>
                  </div>
                </div>

                {historySubTab === 'sales' ? (
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
                                <span className="text-[10px] font-bold bg-amber-50 text-indigo-805 border border-indigo-200 px-2 py-0.5 rounded-md">
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
                                <div key={idx} className="flex justify-between text-xs text-slate-700 font-semibold">
                                  <span>{it.quantity}x {it.name}</span>
                                  <span className="text-slate-500">{formatMXN(it.salePrice * it.quantity)}</span>
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

                              {sale.status === 'Completed' && isOwnerOrAdminRole && (
                                <button
                                  type="button"
                                  onClick={() => handleRefundSale(sale.id)}
                                  className="mt-2.5 px-3 py-1 text-[10px] hover:bg-pink-650 hover:text-white border border-pink-200 rounded text-pink-600 font-bold cursor-pointer transition align-middle"
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
                ) : historySubTab === 'cashLog' ? (
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
                        <span className="font-extrabold text-indigo-700 text-sm">{formatMXN(cashRegister.currentCash)}</span>
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
                                  {tx.type === 'Venta' ? '🧾' : tx.type === 'Ingreso' ? '📥' : isTransfer ? '🔄' : '📤'}
                                </span>
                                <div>
                                  <p className="text-xs font-bold text-slate-805">{tx.description}</p>
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
                        const icon = mv.type === 'surtido' ? '📥' : mv.type === 'merma' ? '📉' : '🔄';
                        return (
                          <div key={mv.id} className="flex justify-between items-center border border-slate-100 rounded-xl p-3 bg-white hover:bg-slate-50/50 transition duration-150">
                            <div className="flex items-center space-x-3 text-left min-w-0">
                              <span className={`p-2 rounded-lg font-black text-sm flex items-center justify-center shrink-0 ${
                                mv.type === 'surtido' ? 'bg-emerald-50 text-emerald-600' : mv.type === 'merma' ? 'bg-rose-50 text-rose-600' : 'bg-sky-50 text-sky-600'
                              }`}>
                                {icon}
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
                            <span className={`font-black text-xs shrink-0 ml-2 ${isIn ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {isIn ? '+' : '-'}{mv.quantity} u.
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {activeTab === 'analytics' && (
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
                  <p className="text-xs text-slate-500 leading-relaxed text-center font-medium">
                    ⚙️ Si necesitas acceso para reabastecimientos, reportajes o auditorías, por favor solicita a tu Administrador o Propietario que actualice tus privilegios de acceso desde la pestaña de <strong>Mi Empresa / Equipo</strong>.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
              
              {/* Core Analytics Header with Download button */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white border border-slate-200 p-6 rounded-3xl shadow-xs text-left">
                <div>
                  <h2 className="text-lg font-black text-slate-805 tracking-tight flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" style={{ color: 'var(--brand-primary)' }} /> Centro de Estadísticas de {userCompanies[activeCompanyId || '']?.name || 'Mi Comercio'}
                  </h2>
                  <p className="text-xs text-slate-500">Métricas completas, ganancias aproximadas y tickets logrados por mes.</p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                  <select
                    value={statsMonth}
                    onChange={(e) => setStatsMonth(e.target.value)}
                    className="w-full sm:w-auto text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 outline-none focus:border-indigo-400 cursor-pointer"
                  >
                    <option value="all">Todo el histórico</option>
                    {availableStatsMonths.map(m => (
                      <option key={m} value={m}>{getMonthLabel(m)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleDownloadDashboard}
                    className="w-full sm:w-auto px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" /><span>Descargar Reporte (CSV)</span>
                  </button>
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
                  <p className="text-[10px] text-slate-550 mt-2">Ventas finalizadas con éxito</p>
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
                            <div className="flex justify-between text-xs font-bold text-slate-705">
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
                    <h3 className="font-extrabold text-purple-650 text-sm flex items-center">
                      <AlertCircle className="w-4 h-4 mr-1 text-purple-500 animate-bounce" />
                      Alertas de Reabastecimiento Crítico
                    </h3>
                    <p className="text-slate-400 text-xs mt-0.5">Surtidos indispensables por debajo del umbral mínimo de reserva.</p>
                  </div>

                  {stats.lowStockItems.length === 0 ? (
                    <p className="text-xs text-slate-500 font-semibold py-8 text-center">✓ El almacén está perfectamente abastecido de mercancías.</p>
                  ) : (
                    <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                      {stats.lowStockItems.map(p => (
                        <div key={p.id} className="bg-slate-50 border border-slate-100 flex justify-between items-center p-2.5 rounded-xl">
                          <div>
                            <p className="text-xs font-bold text-slate-850">{p.name}</p>
                            <p className="text-[9px] text-slate-400">Mínimo sugerido: {p.minStock}</p>
                          </div>
                          <div className="text-right">
                            <span className="px-2 py-0.5 font-extrabold text-[10px] rounded-full text-white" style={{ backgroundColor: 'var(--brand-primary)' }}>
                              Stock: {getProductStock(p, selectedBranchId)}
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
          {activeTab === 'branches' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-3xl border shadow-sm">
                <div>
                  <h2 className="text-xl font-black text-slate-800 tracking-tight flex items-center">
                    <Store className="w-5 h-5 mr-2 text-teal-650" />
                    Control de Sucursales y Oficinas
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Administra múltiples ubicaciones físicas o móviles, asigna gerentes, y monitorea el rendimiento individual.
                  </p>
                </div>
                {activeCompanyRole !== 'employee' && (
                  <div className="flex gap-2.5 w-full md:w-auto self-start flex-wrap">
                    {branches.length > 1 && (
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
                  const branchSales = sales.filter(s => s.status === 'Completed' && (s.branchId === branch.id || (!s.branchId && branch.id === 'b1')));
                  const totalBranchRevenue = branchSales.reduce((sum, s) => sum + s.total, 0);

                  return (
                    <div 
                      key={branch.id} 
                      className={`relative bg-white rounded-3xl p-5 border shadow-sm flex flex-col justify-between transition group hover:shadow-md ${
                        isActive ? 'border-teal-500 ring-4 ring-teal-500/10' : 'border-slate-200'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute top-4 right-4 bg-teal-100 border border-teal-200 text-teal-850 text-[9px] font-black uppercase px-2 py-0.5 rounded-full select-none">
                          Trabajando Aquí
                        </span>
                      )}

                      <div className="space-y-4">
                        <div className="flex items-start space-x-3">
                          <div className={`p-2.5 rounded-2xl ${isActive ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
                            <Building2 className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-extrabold text-slate-800 text-sm group-hover:text-teal-700 transition">{branch.name}</h3>
                            <p className="text-slate-400 text-[10px] mt-0.5 font-mono">ID: {branch.id}</p>
                          </div>
                        </div>

                        <div className="space-y-2 border-t border-slate-100 pt-3 text-xs leading-relaxed">
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Dirección:</span>
                            <span className="font-semibold text-slate-705 max-w-[150px] truncate" title={branch.address}>{branch.address || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Teléfono:</span>
                            <span className="font-semibold text-slate-705">{branch.phone || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Gerente / Resp:</span>
                            <span className="font-semibold text-teal-700">{branch.manager || 'No asignado'}</span>
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
                          <p className="text-[9px] text-slate-400 text-right mt-1 font-semibold">{branchSales.length} transacciones exitosas</p>
                        </div>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                        {!isActive ? (
                          <button
                            onClick={() => handleSelectBranch(branch.id)}
                            className="px-3 py-1.5 bg-slate-100 hover:bg-teal-50 hover:text-teal-700 border border-slate-250 hover:border-teal-200 text-slate-700 font-bold rounded-lg cursor-pointer transition text-[10px]"
                          >
                            Hacer Activa
                          </button>
                        ) : (
                          <span className="text-teal-600 font-bold text-[10px] flex items-center">
                            <Check className="w-3.5 h-3.5 mr-1 bg-teal-100 rounded-full p-0.5" /> Selección Actual
                          </span>
                        )}

                        {activeCompanyRole !== 'employee' ? (
                          <div className="flex space-x-1">
                            <button
                              onClick={() => handleOpenBranchModal(branch)}
                              className="p-1 px-2.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition font-semibold text-[10px] border border-transparent hover:border-slate-200"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => handleDeleteBranch(branch.id)}
                              className="p-1 px-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition font-semibold text-[10px]"
                              title="Eliminar Sucursal"
                            >
                              Eliminar
                            </button>
                          </div>
                        ) : (
                          <span className="text-[9px] text-slate-400 font-bold select-none py-1">
                            🛡️ Solo Admins
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
                    <Truck className="w-5 h-5 mr-2 text-amber-653 animate-bounce" />
                    Catálogo de Proveedores de Insumos
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Gobernanza de distribuidores. Contacta proveedores directos y reabastece stock registrando egresos en caja.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                  <button
                    onClick={() => handleOpenRestock()}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                  >
                    <ArrowLeft className="w-4 h-4 rotate-180" />
                    <span>Reabastecer / Surtir Almacén</span>
                  </button>
                  {activeCompanyRole !== 'employee' && (
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
                            <div>
                              <h3 className="font-extrabold text-slate-800 text-sm group-hover:text-amber-700 transition">{supplier.name}</h3>
                              <p className="text-slate-400 text-[9px] font-mono mt-0.5">Categoría: <span className="text-amber-700 font-bold bg-amber-50 border border-amber-100 px-1.5 py-0.2 rounded-md">{supplier.category}</span></p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2 border-t border-slate-105 pt-3 text-xs leading-relaxed">
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Contacto:</span>
                            <span className="font-semibold text-slate-705">{supplier.contactName || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Teléfono:</span>
                            <span className="font-semibold text-slate-705 font-mono">{supplier.phone || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Email:</span>
                            <span className="font-semibold text-indigo-600 font-mono truncate max-w-[140px]" title={supplier.email}>{supplier.email || 'Sin registrar'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400 font-bold uppercase text-[9px]">Dirección:</span>
                            <span className="font-semibold text-slate-705 max-w-[150px] truncate" title={supplier.address}>{supplier.address || 'Sin registrar'}</span>
                          </div>
                        </div>

                        {/* Associated Products metrics */}
                        <div className="bg-amber-50/20 border border-amber-105/40 p-3 rounded-2xl">
                          <div className="flex justify-between items-center text-xs font-bold text-slate-705">
                            <span>Productos Surtidos:</span>
                            <span className="text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full text-[10px] font-black">{linkedProducts.length} artículos</span>
                          </div>
                          {linkedProducts.length > 0 && (
                            <div className="mt-2 text-[10px] text-slate-500 leading-tight space-y-1">
                              <p className="font-bold border-b border-amber-100 pb-1 uppercase text-[8px] text-slate-400">Existencias Actuales:</p>
                              {linkedProducts.slice(0, 3).map(p => (
                                <div key={p.id} className="flex justify-between font-medium">
                                  <span>{p.name}</span>
                                  <span className={`font-mono font-bold ${p.stock <= p.minStock ? 'text-orange-500' : 'text-slate-700'}`}>Stock: {p.stock}</span>
                                </div>
                              ))}
                              {linkedProducts.length > 3 && (
                                <p className="text-[9px] text-indigo-500 font-bold select-none cursor-pointer hover:underline" onClick={() => setActiveTab('products')}>+ {linkedProducts.length - 3} artículos más...</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                        <button
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
                        </button>

                        {activeCompanyRole !== 'employee' ? (
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
                          <span className="text-[9px] text-slate-400 font-bold select-none py-1">
                            🛡️ Solo Admins
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
          {activeTab === 'invoicing' && (
            <div className="bg-white p-4 lg:p-6 rounded-3xl shadow-xl border border-slate-100 flex-grow animate-in fade-in slide-in-from-bottom-4 relative mb-24 lg:mb-8 mx-auto w-full max-w-7xl">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b pb-5 mb-5 space-y-3 sm:space-y-0 relative z-10 w-full">
                <div>
                  <h2 className="text-xl md:text-2xl font-black text-slate-800 bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600 flex items-center gap-2">
                    <FileText className="w-8 h-8 text-blue-600" />
                    Facturación Electrónica CFDI
                  </h2>
                  <p className="text-slate-500 text-xs mt-1">
                    Gestiona las facturas pendientes por emitir y el historial de folios generados.
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
                    <option value="completed">Realizadas ✓</option>
                  </select>
                </div>
              </div>

              {/* Rendering list of sales that require invoice */}
              {sales.filter(s => s.requiresInvoice && (invoiceStatusFilter === 'all' || s.invoiceStatus === invoiceStatusFilter)).length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                  {sales.filter(s => s.requiresInvoice && (invoiceStatusFilter === 'all' || s.invoiceStatus === invoiceStatusFilter)).map(sale => (
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
                            onClick={() => {
                              const updatedSales = sales.map(s => s.id === sale.id ? { ...s, invoiceStatus: 'completed' as const } : s);
                              saveAllData(products, customers, updatedSales, cashRegister);
                            }}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm"
                          >
                            Marcar Facturado
                          </button>
                        )}
                        {sale.invoiceStatus === 'completed' && (
                          <button
                            onClick={() => {
                              const updatedSales = sales.map(s => s.id === sale.id ? { ...s, invoiceStatus: 'pending' as const } : s);
                              saveAllData(products, customers, updatedSales, cashRegister);
                            }}
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
                  <div className="text-[11px] bg-amber-50 text-amber-700 px-4 py-3 rounded-xl border border-amber-200 mt-4 font-bold max-w-md shadow-sm">
                    🚧 El proceso de timbrado CFDI (facturación) requerirá registrar las credenciales y certificados (CSD) del SAT en la configuración avanzada. Esta es la pre-vista del módulo de control interno.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SCREEN: EMPRESA Y EQUIPO (SETTINGS) */}
          {activeTab === 'settings' && (
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
                      <span className="text-indigo-600 font-bold">✓</span>
                      <span><strong>Multi-Sucursal</strong>: Configura sucursales físicas y asigna inventario de catálogo independiente de sucursales.</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-indigo-600 font-bold">✓</span>
                      <span><strong>Control de Roles</strong>: Propietario (dueño general), Administrador (edición/inventario), Empleado (ventas POS únicamente).</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-indigo-600 font-bold">✓</span>
                      <span><strong>Acceso con Código</strong>: Genera códigos únicos estilo invitación para que tus colaboradores entren con un clic.</span>
                    </li>
                  </ul>
                </div>

                <div className="flex flex-col sm:flex-row justify-center gap-3 pt-2">
                  {!user ? (
                    <button
                      onClick={() => setIsAuthModalOpen(true)}
                      className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-sm rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2"
                    >
                      <Sparkles className="w-4 h-4 text-indigo-200 animate-pulse" />
                      <span>Conectar Cuenta con Google</span>
                    </button>
                  ) : (
                    // User is signed in but has no active company
                    <div className="space-y-4 w-full">
                      <p className="text-xs text-amber-600 font-semibold bg-amber-50 rounded-lg p-2.5 inline-block">
                        ⚠️ Estás conectado como {user.email} pero no tienes ninguna Empresa activa.
                      </p>
                      <button
                        onClick={() => {
                          // Allow choosing / creating a company - clear any storage and let screen display selection
                          localStorage.removeItem(`logic_active_company_${user.uid}`);
                          setActiveCompanyId(null);
                        }}
                        className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-sm rounded-xl shadow-md cursor-pointer transition flex items-center justify-center space-x-2 mx-auto"
                      >
                        <Building2 className="w-4 h-4" />
                        <span>Abrir Panel de Selección de Empresa</span>
                      </button>
                    </div>
                  )}
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
                      className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-250 text-slate-600 hover:text-slate-800 text-xs font-bold rounded-lg cursor-pointer transition"
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
                  localStorage.setItem(`logic_active_company_${user.uid}`, id);
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
                Sucursal: <span className="font-bold text-slate-700">{branches.find(b => b.id === selectedBranchId)?.name || 'Actual'}</span>
              </p>
              <p className="text-xs text-slate-500">
                Stock actual: <span className="font-bold text-slate-700">{getProductStock(quickStockProduct, selectedBranchId)} u.</span>
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 block">Unidades a agregar</label>
              <input
                type="number"
                autoFocus
                placeholder="Ej: 20"
                value={quickStockAmount}
                onChange={e => setQuickStockAmount(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !isSavingQuickStock) handleQuickAddStock(); }}
                className="w-full text-lg font-black text-center bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-slate-400 text-center">Se suma al stock existente (usa negativo para descontar una merma).</p>
            </div>

            {quickStockAmount && !isNaN(parseInt(quickStockAmount)) && parseInt(quickStockAmount) !== 0 && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-2.5 text-center text-xs font-bold text-emerald-800">
                Nuevo stock: {getProductStock(quickStockProduct, selectedBranchId)} → {Math.max(0, getProductStock(quickStockProduct, selectedBranchId) + parseInt(quickStockAmount))} u.
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
                         className="bg-indigo-600 text-white px-3 py-2 rounded-lg font-bold text-xs hover:bg-indigo-700"
                       >
                         ✓
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
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-55 font-bold text-slate-700"
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
                  <label className="text-xs font-bold text-slate-500 block">Stock Inicial en Almacén</label>
                  <input 
                    type="number"
                    placeholder="Ej: 20"
                    value={prodForm.stock}
                    onChange={e => setProdForm({ ...prodForm, stock: e.target.value })}
                    className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-500"
                  />
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
                onClick={() => setIsTransferModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-705 bg-slate-105 hover:bg-slate-200 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block text-left">1. Seleccionar Artículo / Producto:</label>
                <select
                  value={transferProductId}
                  onChange={(e) => setTransferProductId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-xs font-bold outline-none focus:border-indigo-500 transition mt-1.5"
                >
                  <option value="">Selecciona un producto...</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} (Stock Global: {p.stock} u. | {p.category || 'Sin Cat'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3 text-left">
                <div>
                  <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">2. Origen:</label>
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
                </div>

                <div>
                  <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block">3. Destino / Reparto:</label>
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

              {transferProductId && transferSourceBranchId && (
                <div className="bg-slate-50 border border-slate-100 p-3 rounded-xl text-left text-xs font-bold text-slate-600">
                  📈 Existencia actual en Sucursal de Origen:{' '}
                  <span className="text-indigo-600 font-extrabold">
                    {(() => {
                      const p = products.find(prod => prod.id === transferProductId);
                      if (!p) return 0;
                      return p.branchStocks && p.branchStocks[transferSourceBranchId] !== undefined 
                        ? p.branchStocks[transferSourceBranchId] 
                        : p.stock;
                    })()}{' '}
                    unidades.
                  </span>
                </div>
              )}

              <div>
                <label className="text-xs uppercase font-extrabold text-slate-500 tracking-wider block text-left">4. Cantidad a Transferir / Repartir:</label>
                <input
                  type="number"
                  min="1"
                  value={transferQuantity}
                  onChange={(e) => setTransferQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-xs font-black outline-none focus:border-indigo-500 transition mt-1.5"
                />
              </div>
            </div>

            <div className="flex gap-2.5 pt-3">
              <button
                type="button"
                onClick={() => setIsTransferModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition text-center cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleExecuteTransfer}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition text-center cursor-pointer shadow-md"
              >
                Confirmar Reparto
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
                <Store className="w-5 h-5 mr-2 text-teal-650" />
                {editingBranch ? 'Modificar Sucursal' : 'Registrar Nueva Sucursal'}
              </h3>
              <button 
                onClick={() => setIsBranchModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-705 bg-slate-105 hover:bg-slate-200 rounded-full transition cursor-pointer"
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
                    {branchForm.manager && !members.filter(m => m.role === 'owner' || m.role === 'master_admin' || m.role === 'admin').some(m => m.name === branchForm.manager) && (
                      <option value={branchForm.manager}>{branchForm.manager}</option>
                    )}
                    {members.filter(m => m.role === 'owner' || m.role === 'master_admin' || m.role === 'admin').map(member => (
                      <option key={member.userId} value={member.name}>
                        {member.name} ({member.role === 'owner' ? 'Propietario' : member.role === 'master_admin' ? 'Master Admin' : 'Administrador'})
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
                      <label htmlFor="branch-is-matriz" className="text-slate-800 font-extrabold cursor-pointer block text-xs">Definir como Matriz Principal 🏢</label>
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
                <Truck className="w-5 h-5 mr-2 text-amber-653" />
                {editingSupplier ? 'Modificar Proveedor' : 'Registrar Nuevo Proveedor'}
              </h3>
              <button 
                onClick={() => setIsSupplierModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-705 bg-slate-105 hover:bg-slate-200 rounded-full transition cursor-pointer"
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
                              className="rounded border-slate-305 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                            />
                            <span>{prod.name} (Stock: {getProductStock(prod, selectedBranchId)})</span>
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
                className="p-1.5 text-slate-400 hover:text-slate-705 bg-slate-105 hover:bg-slate-200 rounded-full transition cursor-pointer"
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
                    ).map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} (Stock Actual: {p.stock})
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
                      <span className="text-sm font-black text-indigo-650">
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
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg cursor-pointer shadow-md"
                >
                  Confirmar Egreso y Surtido
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
                className="p-1.5 text-slate-400 hover:text-slate-705 bg-slate-50 hover:bg-slate-100 rounded-full transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Form to add a new category */}
              <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl space-y-2">
                <label className="text-indigo-800 font-extrabold block">Crear Nueva Categoría 🏷️</label>
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

              <p className="text-slate-505 leading-relaxed font-semibold">
                Al renombrar una categoría, todos los artículos de tu catálogo pertenecientes a ella se actualizarán automáticamente.
              </p>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {selectCategoriesList.map(cat => (
                  <div key={cat} className="p-2 bg-slate-50 border border-slate-150 rounded-xl">
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
              <span className="inline-block p-3 bg-indigo-50 border border-indigo-100 rounded-full text-indigo-600 text-2xl animate-bounce">🎉</span>
              <h3 className="font-extrabold text-xl text-slate-800">¡Venta Registrada!</h3>
              <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Ticket {lastCompletedSale.id}</p>
              {lastCompletedSale.employeeName && (
                <p className="text-[11px] text-slate-500 font-bold">Atendido por: <span style={{ color: 'var(--brand-primary)' }}>{lastCompletedSale.employeeName}</span></p>
              )}
            </div>

            {/* Micro compact ticket receipt section */}
            <div className="bg-slate-50 border border-slate-150 p-4 rounded-2xl text-xs space-y-2.5 font-mono">
              <div className="flex justify-between font-bold border-b border-dashed pb-2">
                <span>Artículos</span>
                <span>Subtotal</span>
              </div>
              <div className="space-y-1 select-text max-h-24 overflow-y-auto pr-1">
                {lastCompletedSale.items.map((it, idx) => (
                  <div key={idx} className="flex justify-between text-slate-600">
                    <span>{it.quantity}x {it.name}</span>
                    <span>{formatMXN(it.salePrice * it.quantity)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-dashed pt-2 space-y-1 text-slate-505">
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
                    let text = `*ℹ️ TICKET DE COMPRA - LOGIC POS*\n`;
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
                    text += `¡Gracias por su compra! 😃\n`;
                    return `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
                  })()}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2.5 bg-emerald-50 hover:bg-emerald-100/80 border border-emerald-200 text-emerald-800 rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-center duration-155"
                >
                  💬 WhatsApp
                </a>

                <a
                  href={(() => {
                    const subject = `Recibo de Venta Nro ${lastCompletedSale.id} - LOGIC POS`;
                    let body = `Estimado cliente,\n\n`;
                    body += `Le adjuntamos el detalle de su compra realizada el ${lastCompletedSale.timestamp}:\n\n`;
                    body += `Ticket: ${lastCompletedSale.id}\n`;
                    body += `Monto Total: ${formatMXN(lastCompletedSale.total)}\n\n`;
                    body += `Detalle de Artículos:\n`;
                    lastCompletedSale.items.forEach(it => {
                      body += `- ${it.quantity}x ${it.name} - ${formatMXN(it.salePrice * it.quantity)}\n`;
                    });
                    body += `\n¡Gracias por preferir nuestros servicios!\n\nLOGIC POS Cloud`;
                    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                  })()}
                  className="p-2.5 bg-sky-50 hover:bg-sky-100/80 border border-sky-200 text-sky-800 rounded-xl flex items-center justify-center gap-1.5 cursor-pointer text-center duration-155"
                >
                  ✉️ Correo
                </a>
              </div>

              <button
                type="button"
                onClick={() => handlePrintReceipt(lastCompletedSale)}
                className="w-full p-2.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-250 text-indigo-700 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition"
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
              <div className="bg-slate-50 border border-slate-150 p-3 rounded-xl space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">Saldo Inicial:</span>
                  <span className="font-mono font-bold">{formatMXN(cashRegister.initialCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Efectivo Sugerido (Sistema):</span>
                  <span className="font-mono text-indigo-750 font-extrabold">{formatMXN(cashRegister.currentCash)}</span>
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
                    ? 'bg-blue-50 border-blue-105 text-blue-800' 
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
                className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl shadow cursor-pointer transition"
              >
                Proceder y Cerrar Caja 📝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL WINDOW: APERTURA DE CAJA (OPENING) */}
      {isOpeningCajaModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="pb-2 border-b">
              <h3 className="font-extrabold text-lg text-slate-800 flex items-center">
                <Store className="w-5 h-5 mr-2 text-indigo-600 animate-pulse" />
                Apertura de Turno y Caja
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Define el monto inicial en efectivo para iniciar las operaciones del día.</p>
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
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-505 font-bold text-slate-700"
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
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow cursor-pointer transition text-center"
              >
                Abrir Caja Registradora 🚀
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Company Selector — only for Google-authenticated owners/admins */}
      {user && !isAuthLoading && !activeCompanyId && !isCredentialEmployee && (
        <CompanySelector
          companies={userCompanies}
          userDisplayName={user.displayName}
          userEmail={user.email}
          onCreateCompany={handleCreateCompany}
          onJoinWithCode={handleJoinCompanyWithCode}
          onSelectCompany={(id) => {
            localStorage.setItem(`logic_active_company_${user.uid}`, id);
            setActiveCompanyId(id);
          }}
          onDeleteCompany={handleDeleteCompany}
          onLogout={() => signOut(auth)}
        />
      )}

      {/* Waiting screen for credential employees while Firestore resolves their company */}
      {user && !isAuthLoading && !activeCompanyId && isCredentialEmployee && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
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
          <button
            onClick={() => signOut(auth)}
            className="text-xs text-slate-500 hover:text-slate-300 underline cursor-pointer transition"
          >
            Salir e intentar de nuevo
          </button>
        </div>
      )}

      {/* GLOBAL MOUNT CHECKPOINT: UNIFIED AUTHENTICATION SELECTION DIALOG (GOOGLE & DIRECT CREDENTIALS) */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[9999] animate-fade-in select-none">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-5 text-left transition duration-200 animate-slide-up">
            <div className="flex justify-between items-center pb-2.5 border-b border-slate-100">
              <div>
                <h3 className="font-extrabold text-base text-slate-800">
                  Acceso al Sistema
                </h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Ingresa con tu número de empleado o cuenta de propietario.</p>
              </div>
              <button 
                onClick={() => setIsAuthModalOpen(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-full cursor-pointer transition select-none"
              >
                <X className="w-4 h-4" />
              </button>
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
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition select-none tracking-wide text-center disabled:opacity-50 mt-1"
                >
                  {isSignInLoading ? 'Verificando...' : 'Entrar al Sistema 🔑'}
                </button>
              </form>

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
                  try {
                    await signInWithGoogle();
                    setIsAuthModalOpen(false);
                  } catch (err: any) {
                    console.error(err);
                    alert("Error al conectar con Google: " + (err.message || String(err)));
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
      )}

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
          className="flex-grow bg-white border border-slate-200 px-2.5 py-1 rounded-lg text-slate-750 font-bold focus:ring-1 focus:ring-indigo-505 outline-none text-xs"
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
            className="px-2 py-1 text-indigo-600 hover:bg-indigo-50 border border-indigo-150 rounded cursor-pointer transition"
          >
            Renombrar
          </button>
        )}
      </div>
    </div>
  );
};

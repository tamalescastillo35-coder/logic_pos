import React, { useState, useEffect, useRef } from 'react';
import {
  Building2,
  Users,
  Key,
  ChevronLeft,
  ChevronRight,
  Plus,
  Copy,
  ShieldCheck,
  RefreshCw,
  Trash2,
  UserCheck,
  AlertCircle,
  Briefcase,
  Layers,
  Sparkle,
  Check,
  Building,
  Share2,
  Palette,
  Printer,
  ClipboardList,
  MapPin as MapPinIcon
} from 'lucide-react';
import { db, handleFirestoreError, OperationType, createCredentialUser } from '../firebase';
import { collection, onSnapshot, doc, updateDoc, setDoc, deleteDoc, writeBatch } from 'firebase/firestore';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'master_admin' | 'admin' | 'employee';
  joinedAt?: string;
  assignedBranchId?: string;
  customRoleName?: string;
  permissions?: string[];
  isCredentialAccount?: boolean;
}

interface Branch {
  id: string;
  name: string;
  address: string;
  phone: string;
  manager: string;
  isMatriz?: boolean;
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

interface BluetoothPrinterDevice {
  name: string;
  address: string;
}

interface CompanySettingsViewProps {
  companyId: string;
  companyName: string;
  currentUserRole: 'owner' | 'master_admin' | 'admin' | 'employee';
  currentUserId: string;
  userAvailableCompanies: { [id: string]: { id: string; name: string; role: 'owner' | 'master_admin' | 'admin' | 'employee' } };
  onSwitchCompany: (id: string) => void;
  onLogoutCompany: () => void;
  onCreateCompany?: (name: string) => Promise<void>;
  branches: Branch[];
  products?: any[];
  sales?: any[];
  suppliers?: any[];
  customers?: any[];
  customCategories?: any[];
  onGoogleSignInForBackup?: () => Promise<string | null>;
  onRestoreCompanyData?: (backupData: any, onProgress: (msg: string) => void) => Promise<void>;
  branding?: Branding;
  onSaveBranding?: (branding: Branding) => Promise<void>;
  printConfig?: PrintConfig;
  onSavePrintConfig?: (config: PrintConfig) => Promise<void>;
  isNativePlatform?: boolean;
  bluetoothPrinter?: BluetoothPrinterDevice | null;
  onScanBluetoothPrinters?: () => Promise<BluetoothPrinterDevice[]>;
  onSelectBluetoothPrinter?: (device: BluetoothPrinterDevice | null) => void;
  onTestPrintBluetooth?: () => Promise<void>;
  webUsbSupported?: boolean;
  webBluetoothSupported?: boolean;
  webPrinterInfo?: { mode: 'usb' | 'bluetooth'; name: string } | null;
  onConnectWebUsbPrinter?: () => Promise<void>;
  onConnectWebBluetoothPrinter?: () => Promise<void>;
  onForgetWebPrinter?: () => void;
  onTestPrintWeb?: () => Promise<void>;
  isCredentialEmployee?: boolean;
}

export default function CompanySettingsView({
  companyId,
  companyName,
  currentUserRole,
  currentUserId,
  userAvailableCompanies,
  onSwitchCompany,
  onLogoutCompany,
  onCreateCompany,
  branches,
  products = [],
  sales = [],
  suppliers = [],
  customers = [],
  customCategories = [],
  onGoogleSignInForBackup,
  onRestoreCompanyData,
  branding = {},
  onSaveBranding,
  printConfig,
  onSavePrintConfig,
  isNativePlatform = false,
  bluetoothPrinter = null,
  onScanBluetoothPrinters,
  onSelectBluetoothPrinter,
  onTestPrintBluetooth,
  webUsbSupported = false,
  webBluetoothSupported = false,
  webPrinterInfo = null,
  onConnectWebUsbPrinter,
  onConnectWebBluetoothPrinter,
  onForgetWebPrinter,
  onTestPrintWeb,
  isCredentialEmployee = false
}: CompanySettingsViewProps) {
  const [activeSubTab, setActiveSubTab] = useState<'info' | 'team' | 'code' | 'branding' | 'print' | 'backup'>('team');

  // Real-time fetched members
  const [members, setMembers] = useState<Member[]>([]);

  // Horizontal tab bar scroll affordance: track whether there's hidden content to the
  // left/right so we can show arrow chevrons (users otherwise don't know it scrolls).
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabEdges, setTabEdges] = useState({ atStart: true, atEnd: false });
  const updateTabEdges = () => {
    const el = tabsRef.current;
    if (!el) return;
    setTabEdges({
      atStart: el.scrollLeft <= 2,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  };
  useEffect(() => {
    updateTabEdges();
    const el = tabsRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateTabEdges, { passive: true });
    window.addEventListener('resize', updateTabEdges);
    return () => {
      el.removeEventListener('scroll', updateTabEdges);
      window.removeEventListener('resize', updateTabEdges);
    };
  }, [members.length, currentUserRole]);
  const scrollTabs = (dir: number) => tabsRef.current?.scrollBy({ left: dir * 150, behavior: 'smooth' });
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);

  // Editable fields
  const [deleteConfirmMemberId, setDeleteConfirmMemberId] = useState<string | null>(null);
  const [editedCompanyName, setEditedCompanyName] = useState(companyName);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [activeCodeUsageType, setActiveCodeUsageType] = useState<'single' | 'multiple' | null>(null);
  const [selectedUsageType, setSelectedUsageType] = useState<'single' | 'multiple'>('multiple');

  // Inline company creation states
  const [showInlineCreateForm, setShowInlineCreateForm] = useState(false);
  const [newInlineCompanyName, setNewInlineCompanyName] = useState('');
  const [isCreatingInline, setIsCreatingInline] = useState(false);

  // Role Customizer Modal state
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [selectedRoleMember, setSelectedRoleMember] = useState<Member | null>(null);
  const [editedCustomRoleName, setEditedCustomRoleName] = useState('');
  const [editedRoleType, setEditedRoleType] = useState<'master_admin' | 'admin' | 'employee'>('employee');
  const [editedPermissions, setEditedPermissions] = useState<string[]>([]);

  // States for Programmatic Credential Creation (No Google Required)
  const [isCredModalOpen, setIsCredModalOpen] = useState(false);
  const [credName, setCredName] = useState('');
  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credRole, setCredRole] = useState<'master_admin' | 'admin' | 'employee'>('employee');
  const [credBranchId, setCredBranchId] = useState('');
  const [isCreatingCred, setIsCreatingCred] = useState(false);
  const [createdCredentialsShow, setCreatedCredentialsShow] = useState<{ companyId: string, name: string, username: string, password: string } | null>(null);
  const [copiedCredNotify, setCopiedCredNotify] = useState(false);

  // Backup & Restore states
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgressMsg, setRestoreProgressMsg] = useState('');

  // Branding form state
  const [brandDisplayName, setBrandDisplayName] = useState(branding.displayName || '');
  const [brandLogoUrl, setBrandLogoUrl] = useState(branding.logoUrl || '');
  const [brandPrimaryColor, setBrandPrimaryColor] = useState(branding.primaryColor || '#6366f1');
  const [brandAccentColor, setBrandAccentColor] = useState(branding.accentColor || '#a855f7');
  const [brandDarkColor, setBrandDarkColor] = useState(branding.darkColor || '#1e1b4b');
  const [brandTagline, setBrandTagline] = useState(branding.tagline || '');
  const [isSavingBranding, setIsSavingBranding] = useState(false);
  const [colorAutoExtracted, setColorAutoExtracted] = useState(false);
  const [isProcessingLogo, setIsProcessingLogo] = useState(false);

  // Print config form state
  const [printPaperWidth, setPrintPaperWidth] = useState<'58mm' | '80mm' | 'A4'>(printConfig?.paperWidth ?? '80mm');
  const [printShowLogo, setPrintShowLogo] = useState(printConfig?.showLogo ?? true);
  const [printShowTaxLine, setPrintShowTaxLine] = useState(printConfig?.showTaxLine ?? true);
  const [printFooterText, setPrintFooterText] = useState(printConfig?.footerText ?? '¡Gracias por su compra!');
  const [isSavingPrint, setIsSavingPrint] = useState(false);

  // Bluetooth thermal printer pairing (58/80mm ESC/POS, e.g. MERION PT-B1)
  const [btScanning, setBtScanning] = useState(false);
  const [btDevices, setBtDevices] = useState<BluetoothPrinterDevice[]>([]);
  const [btError, setBtError] = useState('');
  const [btTesting, setBtTesting] = useState(false);

  const handleScanBt = async () => {
    if (!onScanBluetoothPrinters) return;
    setBtScanning(true);
    setBtError('');
    try {
      const devices = await onScanBluetoothPrinters();
      setBtDevices(devices);
      if (devices.length === 0) {
        setBtError('No hay impresoras emparejadas. Empareja la impresora primero desde los ajustes de Bluetooth de Android.');
      }
    } catch (err: any) {
      setBtError(err?.message || 'No se pudo buscar impresoras Bluetooth.');
    } finally {
      setBtScanning(false);
    }
  };

  const handleTestBt = async () => {
    if (!onTestPrintBluetooth) return;
    setBtTesting(true);
    setBtError('');
    try {
      await onTestPrintBluetooth();
    } catch (err: any) {
      setBtError(err?.message || 'No se pudo imprimir la prueba.');
    } finally {
      setBtTesting(false);
    }
  };

  // Web printer (WebUSB / Web Bluetooth) connect flow — used when the POS runs in a plain
  // browser tab instead of the installed APK.
  const [webConnecting, setWebConnecting] = useState<'usb' | 'bluetooth' | null>(null);
  const [webTesting, setWebTesting] = useState(false);
  const [webError, setWebError] = useState('');

  const handleConnectWeb = async (mode: 'usb' | 'bluetooth') => {
    const connect = mode === 'usb' ? onConnectWebUsbPrinter : onConnectWebBluetoothPrinter;
    if (!connect) return;
    setWebConnecting(mode);
    setWebError('');
    try {
      await connect();
    } catch (err: any) {
      setWebError(err?.message || 'No se pudo conectar la impresora.');
    } finally {
      setWebConnecting(null);
    }
  };

  const handleTestWeb = async () => {
    if (!onTestPrintWeb) return;
    setWebTesting(true);
    setWebError('');
    try {
      await onTestPrintWeb();
    } catch (err: any) {
      setWebError(err?.message || 'No se pudo imprimir la prueba.');
    } finally {
      setWebTesting(false);
    }
  };

  React.useEffect(() => {
    setBrandDisplayName(branding.displayName || '');
    setBrandLogoUrl(branding.logoUrl || '');
    setBrandPrimaryColor(branding.primaryColor || '#6366f1');
    setBrandAccentColor(branding.accentColor || '#a855f7');
    setBrandDarkColor(branding.darkColor || '#1e1b4b');
    setBrandTagline(branding.tagline || '');
    setColorAutoExtracted(false);
  }, [branding]);

  React.useEffect(() => {
    if (!printConfig) return;
    setPrintPaperWidth(printConfig.paperWidth ?? '80mm');
    setPrintShowLogo(printConfig.showLogo ?? true);
    setPrintShowTaxLine(printConfig.showTaxLine ?? true);
    setPrintFooterText(printConfig.footerText ?? '¡Gracias por su compra!');
  }, [printConfig]);

  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (r: number, g: number, b: number) =>
    `#${clamp(r).toString(16).padStart(2,'0')}${clamp(g).toString(16).padStart(2,'0')}${clamp(b).toString(16).padStart(2,'0')}`;

  const extractPalette = (img: HTMLImageElement): { primary: string; accent: string; dark: string } => {
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 80, 80);
    const data = ctx.getImageData(0, 0, 80, 80).data;
    const saturated: Record<string, number> = {};
    const mids: Record<string, number> = {};
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 100) continue;
      const bri = (r + g + b) / 3;
      if (bri > 240 || bri < 10) continue;
      const max = Math.max(r,g,b), min = Math.min(r,g,b), sat = max - min;
      // Clamp quantized values to 0-255 to avoid out-of-range hex (e.g. round(255/20)*20 = 260)
      const qr = Math.min(255, Math.round(r/20)*20);
      const qg = Math.min(255, Math.round(g/20)*20);
      const qb = Math.min(255, Math.round(b/20)*20);
      const key = `${qr},${qg},${qb}`;
      if (sat >= 50) saturated[key] = (saturated[key]||0) + 1;
      else if (sat >= 20) mids[key] = (mids[key]||0) + 1;
    }
    const topN = (map: Record<string,number>, n: number) =>
      Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k]) => k.split(',').map(Number) as [number,number,number]);
    const sat1 = topN(saturated, 3);
    const mid1 = topN(mids, 2);
    const [pr, pg, pb] = sat1[0] ?? [99,102,241];
    const [ar, ag, ab] = sat1[1] ?? mid1[0] ?? [pr,pg,pb];
    const dr = Math.round(pr * 0.25), dg = Math.round(pg * 0.25), db = Math.round(pb * 0.25);
    return {
      primary: toHex(pr, pg, pb),
      accent:  toHex(ar, ag, ab),
      dark:    toHex(dr, dg, db),
    };
  };

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Por favor selecciona un archivo de imagen.'); return; }
    setIsProcessingLogo(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Keep max 128×128 and always JPEG to stay within Firestore 1MB doc limit
        const MAX = 128;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        // White background so transparent PNGs don't produce artifacts in JPEG
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const base64 = canvas.toDataURL('image/jpeg', 0.72);
        // Sanity check (~300KB max to be safe)
        if (base64.length > 400000) {
          alert('La imagen sigue siendo muy grande después de comprimirla. Usa una imagen más pequeña o de menor resolución.');
          setIsProcessingLogo(false);
          return;
        }
        const palette = extractPalette(img);
        setBrandLogoUrl(base64);
        setBrandPrimaryColor(palette.primary);
        setBrandAccentColor(palette.accent);
        setBrandDarkColor(palette.dark);
        setColorAutoExtracted(true);
        setIsProcessingLogo(false);
      };
      img.onerror = () => { alert('No se pudo leer la imagen.'); setIsProcessingLogo(false); };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleSaveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSaveBranding) return;
    setIsSavingBranding(true);
    try {
      await onSaveBranding({
        displayName: brandDisplayName.trim() || undefined,
        logoUrl: brandLogoUrl.trim() || undefined,
        primaryColor: brandPrimaryColor || undefined,
        accentColor: brandAccentColor || undefined,
        darkColor: brandDarkColor || undefined,
        tagline: brandTagline.trim() || undefined,
      });
      alert('¡Apariencia guardada correctamente!');
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('too large') || msg.includes('exceeds') || msg.includes('RESOURCE_EXHAUSTED')) {
        alert('El logo es demasiado grande para guardar. Usa una imagen más pequeña (menor de 200KB).');
      } else {
        alert('Error al guardar la apariencia: ' + msg);
      }
    } finally {
      setIsSavingBranding(false);
    }
  };

  const handleSavePrintConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSavePrintConfig) return;
    setIsSavingPrint(true);
    try {
      await onSavePrintConfig({
        paperWidth: printPaperWidth,
        showLogo: printShowLogo,
        showTaxLine: printShowTaxLine,
        footerText: printFooterText.trim() || '¡Gracias por su compra!',
      });
      alert('Configuración de impresión guardada.');
    } catch (err: any) {
      alert('Error al guardar: ' + (err?.message || err));
    } finally {
      setIsSavingPrint(false);
    }
  };

  const handleBackupToDrive = async () => {
    if (!onGoogleSignInForBackup) return;
    setIsBackingUp(true);
    try {
      const accessToken = await onGoogleSignInForBackup();
      if (!accessToken) throw new Error("No se pudo obtener acceso a Google Drive.");

      const backupData = {
        products,
        sales,
        suppliers,
        customers,
        customCategories,
        branches,
        branding: branding || {},
        timestamp: new Date().toISOString(),
        companyName,
        schemaVersion: 2,
      };

      const fileContent = JSON.stringify(backupData, null, 2);
      const file = new Blob([fileContent], { type: 'application/json' });
      const metadata = {
        name: `LOGICPOS_BACKUP_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.json`,
        mimeType: 'application/json'
      };

      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', file);

      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        body: form
      });

      if (!res.ok) throw new Error("Fallo al subir a Google Drive");
      
      alert("¡Copia de seguridad guardada exitosamente en Google Drive!");
    } catch (err) {
      console.error(err);
      alert("Error al respaldar la base de datos.");
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreFromDrive = async () => {
    if (!onGoogleSignInForBackup || !onRestoreCompanyData) return;
    try {
      const accessToken = await onGoogleSignInForBackup();
      if (!accessToken) throw new Error("Acceso a Google Drive denegado.");

      // Matches both the current "LOGICPOS_BACKUP" prefix and the legacy "KYTE_POS_BACKUP"
      // prefix, so backups made before the project rename can still be restored.
      const listRes = await fetch('https://www.googleapis.com/drive/v3/files?q=(name contains "LOGICPOS_BACKUP" or name contains "KYTE_POS_BACKUP") and mimeType="application/json"&orderBy=createdTime desc&pageSize=10', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!listRes.ok) throw new Error("No se pudo leer Google Drive.");
      const data = await listRes.json();

      if (!data.files || data.files.length === 0) {
        alert("No se encontraron copias de seguridad de LOGIC POS en tu cuenta de Google Drive.");
        return;
      }

      const filesOptions = data.files.map((f: any, i: number) => `${i + 1}: ${f.name}`).join('\\n');
      const ans = prompt(`Se encontraron ${data.files.length} backups. Ingresa el número de la versión a restaurar (1 = Más reciente):\\n\\n${filesOptions}`);
      if (!ans) return;
      const idx = parseInt(ans) - 1;
      
      if (isNaN(idx) || idx < 0 || idx >= data.files.length) return;

      const fileId = data.files[idx].id;
      setIsRestoring(true);
      setRestoreProgressMsg("Descargando respaldo desde Google Drive...");
      
      const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!fileRes.ok) throw new Error("Error al descargar el archivo de respaldo.");
      const backupData = await fileRes.json();

      await onRestoreCompanyData(backupData, (msg) => {
        setRestoreProgressMsg(msg);
      });

      alert("¡Restauración de negocio completada exitosamente!");
    } catch (err: any) {
      console.error(err);
      alert("Hubo un error durante la restauración. " + (err.message || ''));
    } finally {
      setIsRestoring(false);
      setRestoreProgressMsg('');
    }
  };

  const handleCreateCredentialEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!credName.trim() || !credUsername.trim()) {
      alert("Por favor completa todos los campos requeridos.");
      return;
    }
    const cleanUsername = credUsername.trim();
    if (cleanUsername.includes(' ')) {
      alert("El número de empleado no puede contener espacios.");
      return;
    }
    if (cleanUsername.length < 6) {
      alert("El número de empleado debe tener al menos 6 dígitos (es también la clave de acceso, no se rellena con ceros).");
      return;
    }
    // Password = employee number. Must be >= 6 real chars on its own — no zero-padding,
    // since padding a short number makes the password trivially guessable.
    const employeePassword = cleanUsername;

    // Verify if employee number is already taken
    const isTaken = members.some(m => {
      const parts = m.email ? m.email.split('@')[0].split('_') : [];
      const userPart = parts.length > 1 ? parts.slice(1).join('_') : '';
      return userPart === cleanUsername;
    });

    if (isTaken) {
      alert(`El número de empleado "${cleanUsername}" ya existe en esta empresa. Por favor usa un número diferente.`);
      return;
    }

    setIsCreatingCred(true);
    try {
      const virtualEmail = `${companyId}_${cleanUsername}@logicpos.com`;

      // 1. Create email/password user in secondary Firebase auth sandbox
      const uid = await createCredentialUser(virtualEmail, employeePassword);

      // 2. Set member record in the company subcollection
      const memberRef = doc(db, 'companies', companyId, 'members', uid);
      await setDoc(memberRef, {
        userId: uid,
        name: credName.trim(),
        email: virtualEmail,
        role: credRole,
        assignedBranchId: credBranchId || '',
        joinedAt: new Date().toISOString(),
        customRoleName: '',
        permissions: [],
        isCredentialAccount: true
      });

      // Show credentials in visual banner inside modal instead of standard annoying alert
      setCreatedCredentialsShow({
        companyId,
        name: credName.trim(),
        username: cleanUsername,
        password: employeePassword
      });

      // Reset Form fields
      setCredName('');
      setCredUsername('');
      setCredPassword('');
      setCredRole('employee');
      setCredBranchId('');
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/operation-not-allowed' || (err.message && err.message.includes('operation-not-allowed'))) {
        alert("⚠️ ATENCIÓN: El proveedor de Correo/Contraseña está deshabilitado en Firebase.\n\nPara habilitarlo y poder crear cuentas de empleados sin cuenta de Google, sigue estos pasos sencillos:\n1. Ve a console.firebase.google.com y selecciona tu proyecto.\n2. Haz clic en 'Authentication' en el menú lateral de la izquierda.\n3. Abre la pestaña 'Sign-in method' (Método de inicio de sesión).\n4. Haz clic en 'Agregar un proveedor nuevo' (O editar el existente) y activa 'Correo electrónico/contraseña'.\n5. Guarda los cambios.");
      } else {
        alert("No se pudo crear la cuenta de empleado. Código error de nube: " + (err.message || String(err)));
      }
    } finally {
      setIsCreatingCred(false);
    }
  };

  const handleOpenRoleModal = (member: Member) => {
    setSelectedRoleMember(member);
    setEditedPermissions(member.permissions || []);
    setIsRoleModalOpen(true);
  };

  const handleSaveRoleAndPermissions = async () => {
    if (!selectedRoleMember) return;
    if (currentUserRole !== 'owner' && currentUserRole !== 'master_admin' && currentUserRole !== 'admin') {
      alert("No tienes permisos suficientes para asignar tareas.");
      return;
    }

    setIsUpdating(true);
    try {
      await updateDoc(doc(db, 'companies', companyId, 'members', selectedRoleMember.userId), {
        permissions: editedPermissions
      });
      setIsRoleModalOpen(false);
    } catch (err) {
      alert("Error al guardar las tareas del empleado.");
    } finally {
      setIsUpdating(false);
    }
  };

  // Sync active code's usageType in real-time
  useEffect(() => {
    if (!activeCode) {
      setActiveCodeUsageType(null);
      return;
    }
    const unsubCode = onSnapshot(doc(db, 'invitationCodes', activeCode), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setActiveCodeUsageType(data.usageType || 'multiple');
      } else {
        setActiveCodeUsageType(null);
      }
    }, (error) => {
      console.warn("Error subscribing to invitation code usageType:", error);
    });
    return () => unsubCode();
  }, [activeCode]);

  // Read active company settings to get the invitationCode
  useEffect(() => {
    setEditedCompanyName(companyName);
    const unsubComp = onSnapshot(doc(db, 'companies', companyId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setActiveCode(data.invitationCode || null);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `companies/${companyId}`);
    });

    return () => unsubComp();
  }, [companyId, companyName]);

  // Read members list in real-time
  useEffect(() => {
    setIsLoadingMembers(true);
    const unsubMembers = onSnapshot(collection(db, 'companies', companyId, 'members'), (snapshot) => {
      const list: Member[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as Member);
      });
      setMembers(list);
      setIsLoadingMembers(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `companies/${companyId}/members`);
      setIsLoadingMembers(false);
    });

    return () => unsubMembers();
  }, [companyId]);

  const handleUpdateCompanyName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editedCompanyName.trim() || isUpdating) return;
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      alert("Solo el Propietario o Administrador puede renombrar la empresa.");
      return;
    }

    setIsUpdating(true);
    try {
      // 1. Update active company document name
      await updateDoc(doc(db, 'companies', companyId), {
        name: editedCompanyName.trim()
      });

      // 2. Update user profile's companies map
      const userDocRef = doc(db, 'users', currentUserId);
      const userCompaniesUpdate = { ...userAvailableCompanies };
      if (userCompaniesUpdate[companyId]) {
        userCompaniesUpdate[companyId].name = editedCompanyName.trim();
      }
      await updateDoc(userDocRef, {
        companies: userCompaniesUpdate
      });

      alert("¡Nombre de la empresa actualizado con éxito!");
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${companyId}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleGenerateInvoiceInvitationCode = async () => {
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      alert("Solo el Propietario o Administrador puede generar códigos de invitación.");
      return;
    }
    setIsUpdating(true);
    try {
      // Create random alphanumeric code
      const newCode = 'INV-' + Math.floor(Math.random() * 90000 + 10000);

      // Save invitationCode globally with configured usageType
      await setDoc(doc(db, 'invitationCodes', newCode), {
        code: newCode,
        companyId: companyId,
        companyName: companyName,
        role: 'employee',
        usageType: selectedUsageType
      });

      // Delete the old code if existed
      if (activeCode) {
        try {
          await deleteDoc(doc(db, 'invitationCodes', activeCode));
        } catch (_) {}
      }

      // Update company record
      await updateDoc(doc(db, 'companies', companyId), {
        invitationCode: newCode
      });

      alert(`¡Se ha generado un nuevo código de acceso (${selectedUsageType === 'single' ? 'un solo uso' : 'varios usos'}): ${newCode}! Compártelo con tu equipo.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `invitationCodes_creation`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRevokeInvitationCode = async () => {
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      return;
    }
    if (!activeCode) return;
    if (!confirm('¿Estás seguro de revocar este código de invitación? Los nuevos empleados ya no podrán usarlo para unirse.')) return;
    
    setIsUpdating(true);
    try {
      await deleteDoc(doc(db, 'invitationCodes', activeCode));
      await updateDoc(doc(db, 'companies', companyId), {
        invitationCode: null
      });
      alert('Código de invitación revocado con éxito.');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `invitationCodes/${activeCode}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleInlineCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInlineCompanyName.trim() || !onCreateCompany || isCreatingInline) return;
    setIsCreatingInline(true);
    try {
      await onCreateCompany(newInlineCompanyName.trim());
      setNewInlineCompanyName('');
      setShowInlineCreateForm(false);
      alert("¡Nuevo comercio registrado y activado con éxito!");
    } catch (err) {
      console.error("Error creating company inline:", err);
      alert("Ocurrió un error al registrar la empresa.");
    } finally {
      setIsCreatingInline(false);
    }
  };

  const copyToClipboard = () => {
    if (!activeCode) return;
    navigator.clipboard.writeText(activeCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyLinkToClipboard = () => {
    if (!activeCode) return;
    const inviteLink = window.location.origin + "/?invite=" + activeCode;
    navigator.clipboard.writeText(inviteLink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleChangeMemberRole = async (memberUserId: string, memberName: string, newRole: 'master_admin' | 'admin' | 'employee') => {
    if (currentUserRole !== 'owner' && currentUserRole !== 'master_admin') {
      alert("No tienes permisos suficientes para editar roles. Solo el Dueño o Master Admin pueden modificar roles.");
      return;
    }
    
    const memberToUpdate = members.find(m => m.userId === memberUserId);
    if (!memberToUpdate) return;
    if (memberToUpdate.role === 'owner') {
      alert("No se puede editar el rol del propietario del comercio.");
      return;
    }

    setIsUpdating(true);
    try {
      await updateDoc(doc(db, 'companies', companyId, 'members', memberUserId), {
        role: newRole
      });
      const roleLabel = newRole === 'master_admin' ? 'Master Admin' : newRole === 'admin' ? 'Administrador' : 'Empleado';
      alert(`Rol de ${memberName} actualizado exitosamente a ${roleLabel}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${companyId}/members/${memberUserId}`);
      alert("Ocurrió un error al actualizar el rol.");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleChangeMemberBranch = async (memberUserId: string, memberName: string, newBranchId: string) => {
    if (currentUserRole !== 'owner' && currentUserRole !== 'master_admin' && currentUserRole !== 'admin') {
      alert("No tienes permisos suficientes para asignar sucursales.");
      return;
    }

    const memberToUpdate = members.find(m => m.userId === memberUserId);
    if (!memberToUpdate) return;

    // Admin can only assign employees, Owner & Master Admin can assign any role
    if (currentUserRole === 'admin' && memberToUpdate.role !== 'employee') {
      alert("Como Administrador, solo puedes asignar sucursales a Empleados.");
      return;
    }

    setIsUpdating(true);
    try {
      await updateDoc(doc(db, 'companies', companyId, 'members', memberUserId), {
        assignedBranchId: newBranchId || null
      });
      alert(`Sucursal de ${memberName} actualizada exitosamente.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `companies/${companyId}/members/${memberUserId}`);
      alert("Ocurrió un error al asignar la sucursal.");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleTransferOwnership = async (targetMember: Member) => {
    if (currentUserRole !== 'owner') {
      alert("Solo el propietario actual puede transferir la propiedad del comercio.");
      return;
    }
    if (targetMember.isCredentialAccount) {
      alert("No se puede transferir la propiedad del comercio a un usuario sin cuenta de Google.");
      return;
    }

    const firstConfirm = confirm(
      `⚠️ ¡ALERTA DE SEGURIDAD MÁXIMA!\n\n¿Estás seguro de que deseas transferir la propiedad del comercio "${companyName}" a ${targetMember.name} (${targetMember.email})?\n\nAl hacer esto:\n- Perderás el control absoluto de la empresa.\n- Pasarás a ser un Administrador Master.\n- No podrás revertir esta acción ni eliminar este comercio.\n\n¿Deseas continuar?`
    );
    if (!firstConfirm) return;

    const secondConfirm = confirm(
      `Confirmación Final: ¿Estás completamente seguro de ceder los derechos de propiedad a ${targetMember.name}?`
    );
    if (!secondConfirm) return;

    setIsUpdating(true);
    try {
      const companyRef = doc(db, 'companies', companyId);
      const targetMemberRef = doc(db, 'companies', companyId, 'members', targetMember.userId);
      const currentMemberRef = doc(db, 'companies', companyId, 'members', currentUserId);

      const batch = writeBatch(db);
      
      // Update company owner
      batch.update(companyRef, { ownerId: targetMember.userId });
      
      // Target member role becomes owner
      batch.update(targetMemberRef, { role: 'owner' });
      
      // Current user role becomes master_admin
      batch.update(currentMemberRef, { role: 'master_admin' });

      await batch.commit();

      alert(`¡Felicidades! La propiedad de la empresa ha sido transferida a ${targetMember.name} de manera exitosa.`);
    } catch (err) {
      console.error("Error cediendo propiedad de la empresa:", err);
      alert("Ocurrió un error inesperado al transferir la propiedad del comercio. Revisa las reglas de seguridad.");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div id="company-settings-section" className="grid grid-cols-1 lg:grid-cols-12 gap-6 select-none">
      
      {/* LEFT SIDEBAR: Business Switching */}
      <div className="lg:col-span-4 space-y-6">
        
        {/* Company card info */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm text-center">
          {branding.logoUrl ? (
            <div className="mx-auto w-16 h-16 rounded-xl overflow-hidden border border-slate-200 bg-white flex items-center justify-center mb-3 shadow-sm">
              <img src={branding.logoUrl} alt="Logo" className="w-full h-full object-contain p-1" />
            </div>
          ) : (
            <div className="mx-auto w-12 h-12 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center mb-3">
              <Building2 className="w-6 h-6" />
            </div>
          )}
          <h3 className="font-extrabold text-base text-slate-800 truncate">{companyName}</h3>
          <p className="text-[11px] font-bold uppercase text-indigo-500 py-0.5 px-2 bg-indigo-50 inline-block rounded mt-1">
            Rol: {currentUserRole === 'owner' ? 'Dueño / Creador' : currentUserRole === 'admin' ? 'Administrador' : 'Empleado'}
          </p>
          <div className="border-t border-slate-100 my-4 pt-3 text-left">
            <p className="text-[11px] text-slate-500 font-medium">ID de Comercio:</p>
            <p className="font-mono text-xs text-slate-600 truncate p-1 bg-slate-50 border rounded mt-0.5 select-all">{companyId}</p>
          </div>
          <button 
            onClick={onLogoutCompany}
            className="w-full text-center py-2.5 bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 font-bold text-xs rounded-xl cursor-pointer transition border border-slate-200 hover:border-red-200"
          >
            Cambiar de Empresa / Salir
          </button>
        </div>

        {/* Switch Selector Panel */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">Tus Otras Empresas</h4>
              <p className="text-[11px] text-slate-500">Cambia entre ellas al instante:</p>
            </div>
            {onCreateCompany && !isCredentialEmployee && (
              <button
                type="button"
                onClick={() => setShowInlineCreateForm(!showInlineCreateForm)}
                className="p-1.5 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-lg transition"
                title="Registrar Nuevo Comercio"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Inline creation form — only for Google-authenticated owners */}
          {showInlineCreateForm && onCreateCompany && !isCredentialEmployee && (
            <form onSubmit={handleInlineCreateCompany} className="p-3 bg-slate-50 border rounded-xl space-y-2.5 text-left transition-all">
              <span className="text-[9px] font-black text-indigo-700 uppercase tracking-wider block">Registrar Nuevo Comercio</span>
              <input
                type="text"
                required
                placeholder="Nombre del Comercio"
                value={newInlineCompanyName}
                onChange={(e) => setNewInlineCompanyName(e.target.value)}
                className="w-full bg-white border border-slate-200 text-xs rounded-lg px-2.5 py-1.5 text-slate-700 outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="flex justify-end gap-1.5 text-[10px] font-bold">
                <button
                  type="button"
                  onClick={() => {
                    setShowInlineCreateForm(false);
                    setNewInlineCompanyName('');
                  }}
                  className="px-2.5 py-1 text-slate-500 hover:bg-slate-100 rounded"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isCreatingInline || !newInlineCompanyName.trim()}
                  className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-extrabold disabled:opacity-50"
                >
                  {isCreatingInline ? 'Creando...' : 'Crear'}
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {Object.values(userAvailableCompanies).map((comp) => {
              const isActive = comp.id === companyId;
              return (
                <button
                  key={comp.id}
                  disabled={isActive}
                  onClick={() => onSwitchCompany(comp.id)}
                  className={`w-full text-left p-2.5 rounded-xl border flex items-center justify-between text-xs transition ${
                    isActive
                       ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                       : 'bg-slate-50 border-slate-150 hover:bg-slate-100 text-slate-700 cursor-pointer'
                  }`}
                >
                  <div className="truncate">
                    <p className="font-bold truncate">{comp.name}</p>
                    <p className="text-[9px] text-slate-400 capitalize">{comp.role}</p>
                  </div>
                  {isActive ? (
                    <Check className="w-3.5 h-3.5 text-indigo-600" />
                  ) : (
                    <span className="text-[10px] text-slate-400 hover:text-indigo-500 font-bold">Activar</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT SIDEBAR: Content subtabs */}
      <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col">
        
        {/* Dynamic header control tabs */}
        <div className="relative border-b border-slate-150 bg-slate-50/50">
        {!tabEdges.atStart && (
          <button
            type="button"
            onClick={() => scrollTabs(-1)}
            aria-label="Ver pestañas anteriores"
            className="absolute left-0 top-0 bottom-0 z-10 flex items-center px-1 bg-gradient-to-r from-slate-100 via-slate-100/95 to-transparent cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 text-slate-600" />
          </button>
        )}
        {!tabEdges.atEnd && (
          <button
            type="button"
            onClick={() => scrollTabs(1)}
            aria-label="Ver más pestañas"
            className="absolute right-0 top-0 bottom-0 z-10 flex items-center px-1 bg-gradient-to-l from-slate-100 via-slate-100/95 to-transparent cursor-pointer animate-pulse"
          >
            <ChevronRight className="w-4 h-4 text-slate-600" />
          </button>
        )}
        <div ref={tabsRef} className="flex overflow-x-auto p-1 gap-0.5 scrollbar-none">
          <button
            onClick={() => setActiveSubTab('team')}
            className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              activeSubTab === 'team'
                ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Users className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            Equipo y Roles ({members.length})
          </button>

          <button
            onClick={() => setActiveSubTab('code')}
            className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              activeSubTab === 'code'
                ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Key className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            Invitaciones
          </button>

          <button
            onClick={() => setActiveSubTab('info')}
            className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              activeSubTab === 'info'
                ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Building2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            Ajustes
          </button>

          {(currentUserRole === 'owner' || currentUserRole === 'master_admin') && (
            <button
              onClick={() => setActiveSubTab('branding')}
              className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                activeSubTab === 'branding'
                  ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Palette className="w-3.5 h-3.5 text-violet-500 shrink-0" />
              Apariencia
            </button>
          )}

          {(currentUserRole === 'owner' || currentUserRole === 'master_admin') && (
            <button
              onClick={() => setActiveSubTab('print')}
              className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                activeSubTab === 'print'
                  ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Printer className="w-3.5 h-3.5 text-sky-500 shrink-0" />
              Impresora
            </button>
          )}

          <button
            onClick={() => setActiveSubTab('backup')}
            className={`shrink-0 px-3 py-2.5 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              activeSubTab === 'backup'
                ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className="text-blue-500 text-sm shrink-0">☁️</span>
            Respaldo
          </button>
        </div>
        </div>

        {/* Render area */}
        <div className="p-6">
          
          {/* TAB: TEAM & ROLES */}
          {activeSubTab === 'team' && (
            <div className="space-y-4">

              <div className="flex justify-between items-center">
                <div>
                  <h4 className="font-extrabold text-sm text-slate-850">Personal del Comercio</h4>
                  <p className="text-[11px] text-slate-500">Lista de usuarios, roles personalizados y permisos del negocio {companyName}:</p>
                </div>
                {(currentUserRole === 'owner' || currentUserRole === 'admin') && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setIsCredModalOpen(true)}
                      className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-[11px] rounded-lg tracking-wide shadow flex items-center space-x-1 cursor-pointer transition select-none"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Registrar Empleado Sin Google 🔑</span>
                    </button>
                    <button
                      onClick={() => setActiveSubTab('code')}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[11px] rounded-lg tracking-wide shadow flex items-center space-x-1 cursor-pointer transition select-none"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Invitar Empleado</span>
                    </button>
                  </div>
                )}
              </div>

              {isLoadingMembers ? (
                <div className="py-12 text-center text-xs text-slate-400">Cargando nómina de empleados...</div>
              ) : (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden bg-slate-50/40">
                  {members.map((member) => (
                    <div key={member.userId} className="flex flex-col lg:flex-row lg:items-center lg:justify-between p-5 gap-4 hover:bg-slate-100/50 transition">
                      <div className="flex items-start lg:items-center space-x-3 text-left">
                        <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center font-black text-sm ${
                          member.role === 'owner' 
                            ? 'bg-indigo-100 text-indigo-700' 
                            : member.role === 'admin' 
                            ? 'bg-emerald-100 text-emerald-700' 
                            : 'bg-slate-200 text-slate-700'
                        }`}>
                          {member.name ? member.name[0].toUpperCase() : 'U'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-black text-slate-800 text-sm flex flex-wrap items-center gap-1.5">
                            <span className="truncate">{member.name}</span>
                            {member.isCredentialAccount ? (
                              <span className="text-[10px] bg-teal-50 border border-teal-200 text-teal-700 px-1.5 py-0.5 rounded font-black select-none shrink-0">
                                🔐 Clave Dir
                              </span>
                            ) : member.role !== 'owner' ? (
                              <span className="text-[10px] bg-indigo-50 border border-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-black select-none shrink-0">
                                🌐 Google
                              </span>
                            ) : null}
                          </p>
                          <p className="text-[11px] text-slate-500 leading-tight truncate">{member.email}</p>
                          
                          {member.permissions && member.permissions.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {member.permissions.map(p => {
                                const labels: Record<string, string> = {
                                  sales_history: 'Historial', products_edit: 'Catálogo',
                                  stock_transfer: 'Transferir', suppliers_restock: 'Proveedores',
                                  cash_close: 'Cierre caja', apply_discount: 'Descuentos'
                                };
                                return (
                                  <span key={p} className="text-[9px] bg-indigo-50 text-indigo-700 font-bold px-1.5 py-0.5 rounded border border-indigo-100">
                                    +{labels[p] || p}
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Branch indicator and switching option */}
                          {member.role !== 'owner' && (currentUserRole === 'owner' || currentUserRole === 'admin') ? (
                            <div className="mt-2 flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg p-1.5 pr-2 max-w-full">
                              <span className="text-[10px] text-slate-500 font-bold uppercase shrink-0">Sucursal:</span>
                              <select
                                value={member.assignedBranchId || ''}
                                disabled={isUpdating || (currentUserRole === 'admin' && member.role !== 'employee')}
                                onChange={(e) => handleChangeMemberBranch(member.userId, member.name, e.target.value)}
                                className="flex-1 min-w-0 max-w-[180px] text-[11px] bg-white border border-slate-300 hover:border-indigo-400 rounded px-1.5 py-0.5 outline-none font-bold text-slate-700 cursor-pointer truncate"
                              >
                                <option value="">(Sin asignar - matriz default)</option>
                                {branches.map(b => (
                                  <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                              </select>
                            </div>
                          ) : member.assignedBranchId ? (
                            <p className="text-[11px] text-indigo-600 font-extrabold mt-2 bg-indigo-50 border border-indigo-100 rounded-lg p-1.5 max-w-full break-words">Sucursal: {branches.find(b => b.id === member.assignedBranchId)?.name || 'Matriz'}</p>
                          ) : (
                            member.role !== 'owner' && <p className="text-[11px] text-slate-500 font-bold mt-2 bg-slate-100 border border-slate-200 rounded-lg p-1.5 w-fit">Matriz Principal</p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-start lg:justify-end gap-2 w-full lg:w-auto mt-2 lg:mt-0 pt-3 lg:pt-0 border-t border-slate-100 lg:border-0 pl-12 lg:pl-0">
                        {member.role === 'owner' ? (
                          <span className="text-[11px] font-black uppercase py-1.5 px-3 rounded-full border bg-indigo-50 border-indigo-200 text-indigo-700 shrink-0 shadow-sm">
                            👑 Dueño
                          </span>
                        ) : (currentUserRole === 'owner' || currentUserRole === 'master_admin') ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Role badge (read-only) */}
                            <span className={`text-[11px] font-black uppercase py-1.5 px-3 rounded-full border shrink-0 ${
                              member.role === 'admin'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-slate-100 border-slate-200 text-slate-600'
                            }`}>
                              {member.role === 'admin' ? '🛡️ Encargado' : '💼 Cajero'}
                            </span>

                            {/* Assign extra tasks */}
                            <button
                              type="button"
                              onClick={() => handleOpenRoleModal(member)}
                              className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg font-black text-[11px] cursor-pointer transition flex items-center shrink-0 space-x-1.5 shadow-sm"
                              title="Asignar tareas adicionales a este empleado"
                            >
                              <ClipboardList className="w-3 h-3 inline mr-1" /><span>Asignar Tareas</span>
                            </button>

                            {currentUserRole === 'owner' && !member.isCredentialAccount && (
                              <button
                                type="button"
                                onClick={() => handleTransferOwnership(member)}
                                className="px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 rounded-lg font-black text-[11px] cursor-pointer transition flex items-center shrink-0 space-x-1.5 shadow-sm"
                                title="Transferir la propiedad completa de esta empresa"
                              >
                                <span>👑 Transf. Propiedad</span>
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-[11px] font-black uppercase py-1.5 px-3 rounded-full border shadow-sm shrink-0 ${
                              member.role === 'master_admin'
                                ? 'bg-purple-50 border-purple-200 text-purple-700'
                                : member.role === 'admin'
                                ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                                : 'bg-slate-50 border-slate-300 text-slate-700'
                            }`}>
                              {member.role === 'master_admin' ? '🧙 Master Admin' : member.role === 'admin' ? '🛡️ Admin' : '💼 Empleado'}
                            </span>
                          </div>
                        )}
                        
                        {/* Remove Employee button */}
                        {member.role !== 'owner' && (currentUserRole === 'owner' || currentUserRole === 'master_admin' || (currentUserRole === 'admin' && member.role === 'employee')) && (
                          deleteConfirmMemberId === member.userId ? (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await deleteDoc(doc(db, 'companies', companyId, 'members', member.userId));
                                  setDeleteConfirmMemberId(null);
                                } catch (e) {
                                  console.error("Error deleting member:", e);
                                }
                              }}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg cursor-pointer transition font-bold text-[11px] shadow-sm shrink-0 flex items-center gap-1.5"
                            >
                              <span>Eliminar</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmMemberId(member.userId)}
                              className="p-1.5 bg-white hover:bg-red-50 text-red-600 hover:text-red-700 rounded-lg cursor-pointer transition border border-slate-200 hover:border-red-200 shadow-sm shrink-0"
                              title="Remover de la Empresa"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: INVITATION CODES */}
          {activeSubTab === 'code' && (
            <div className="space-y-4 text-left">
              <div>
                <h4 className="font-extrabold text-sm text-slate-850">Invitaciones para Cuentas Google</h4>
                <p className="text-[11px] text-slate-500">Genera un código para que colaboradores con <strong>cuenta de Google</strong> se unan a '{companyName}'. Para empleados sin Google, usa "Crear Empleado" en la pestaña Equipo.</p>
              </div>

              {currentUserRole !== 'owner' && currentUserRole !== 'admin' ? (
                <div className="bg-red-50 border border-red-200/50 p-4 rounded-xl flex items-start space-x-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-extrabold text-xs text-red-800">Acceso Denegado</h5>
                    <p className="text-[11px] text-red-600 leading-relaxed">
                      El generador de códigos de ingreso de personal está estrictamente reservado para administradores y propietarios. Contáctate con tu gerente para modificar accesos.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Selector config section */}
                  <div className="bg-white border rounded-2xl p-4 space-y-3 shadow-none">
                    <h5 className="text-xs font-black text-slate-700 uppercase tracking-wider">Ajustes antes de generar nueva invitación</h5>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex-1 space-y-1">
                        <label className="text-[11px] font-bold text-slate-500 block">Tipo de Invitación:</label>
                        <select
                          value={selectedUsageType}
                          onChange={(e) => setSelectedUsageType(e.target.value as 'single' | 'multiple')}
                          className="w-full bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
                        >
                          <option value="multiple">♾️ Varios Usos (Ideal para registrar a todo tu personal con un solo código)</option>
                          <option value="single">🔑 Un Solo Uso (Expira y se auto-destruye automáticamente tras el primer ingreso exitoso)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {activeCode ? (
                    <div className="border border-slate-200 bg-slate-50 rounded-2xl p-6 text-center space-y-5">
                      {/* Active designation badge */}
                      <div className="flex justify-center">
                        {activeCodeUsageType === 'single' ? (
                          <span className="bg-amber-100/85 border border-amber-200 text-amber-800 font-black text-[10px] px-3.5 py-1.5 rounded-full uppercase flex items-center gap-1">
                            🔑 Invitación para UN SOLO USO (Temporal)
                          </span>
                        ) : (
                          <span className="bg-indigo-100/85 border border-indigo-200 text-indigo-800 font-black text-[10px] px-3.5 py-1.5 rounded-full uppercase flex items-center gap-1">
                            ♾️ Invitación para VARIOS USOS (Persistente)
                          </span>
                        )}
                      </div>

                      {/* Code display row */}
                      <div>
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Código de Acceso Corporativo</span>
                        <div className="flex items-center justify-center space-x-3 mt-1 px-4">
                          <span className="bg-white border text-center border-slate-200 rounded-xl px-5 py-3 font-mono text-2xl font-black text-indigo-700 tracking-wider shadow-inner select-all">
                            {activeCode}
                          </span>
                          <button
                            onClick={copyToClipboard}
                            className="p-3.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl cursor-pointer hover:shadow-sm text-slate-700 hover:text-indigo-600 transition"
                            title="Copiar Código"
                          >
                            {copied ? <Check className="w-5 h-5 text-emerald-500" /> : <Copy className="w-5 h-5" />}
                          </button>
                        </div>
                        {copied && <p className="text-[10px] text-emerald-600 font-extrabold mt-1">¡Código copiado al portapapeles!</p>}
                      </div>

                      {/* Direct LINK invitation row */}
                      <div className="border-t border-slate-200 pt-4 max-w-lg mx-auto text-left space-y-1.5">
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block text-center sm:text-left">Enlace Corto para Invitación Directa</span>
                        <div className="flex items-stretch space-x-2">
                          <input
                            type="text"
                            readOnly
                            value={window.location.origin + "/?invite=" + activeCode}
                            className="bg-white/80 border border-slate-250 rounded-xl px-3 py-2 font-mono text-xs text-slate-500 flex-grow select-all focus:outline-none"
                          />
                          <button
                            onClick={copyLinkToClipboard}
                            className="px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl flex items-center justify-center space-x-1.5 cursor-pointer transition shadow-sm"
                            title="Copiar Link de Invitación"
                          >
                            {copiedLink ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Copiado</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Copiar Link</span>
                              </>
                            )}
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400 leading-normal text-center sm:text-left">
                          Al hacer clic en este enlace, el colaborador ingresará directamente a registrarse para esta sucursal sin tener que escribir el código manualmente.
                        </p>
                      </div>

                      <div className="pt-2 border-t flex flex-col sm:flex-row justify-center items-center gap-3">
                        <button
                          onClick={handleGenerateInvoiceInvitationCode}
                          disabled={isUpdating}
                          className="px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-extrabold text-xs rounded-xl flex items-center space-x-2 cursor-pointer transition shadow-sm"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
                          <span>Guardar y Generar Nuevo Código</span>
                        </button>
                        
                        <button
                          onClick={handleRevokeInvitationCode}
                          disabled={isUpdating}
                          className="px-4 py-2 bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 font-extrabold text-xs rounded-xl flex items-center space-x-2 cursor-pointer transition shadow-sm"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Revocar e Inhabilitar</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="border border-dashed border-slate-300 rounded-2xl p-8 text-center space-y-4">
                      <div className="mx-auto w-10 h-10 bg-indigo-50 border border-indigo-150 rounded-lg flex items-center justify-center text-indigo-600">
                        <Key className="w-5 h-5" />
                      </div>
                      <div>
                        <h5 className="font-extrabold text-slate-850 text-sm">Sin Código de Invitación Activo</h5>
                        <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
                          No has generado un código de invitación activo para este comercio. Configura tus opciones de acceso arriba y genera una a continuación:
                        </p>
                      </div>
                      <button
                        onClick={handleGenerateInvoiceInvitationCode}
                        disabled={isUpdating}
                        className="mx-auto px-5 py-2.5 bg-indigo-600 hover:bg-indigo-750 text-white font-black text-xs rounded-xl shadow cursor-pointer transition flex items-center space-x-2"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
                        <span>Generar Código con las Opciones Seleccionadas</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB: COMPANY SETTINGS */}
          {activeSubTab === 'info' && (
            <div className="space-y-4 text-left">
              <div>
                <h4 className="font-extrabold text-sm text-slate-850">Ajustes de la Empresa</h4>
                <p className="text-[11px] text-slate-500">Configuración general de datos corporatorios de {companyName}:</p>
              </div>

              {currentUserRole !== 'owner' && currentUserRole !== 'admin' ? (
                <div className="bg-red-50 border border-red-200/50 p-4 rounded-xl flex items-start space-x-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-extrabold text-xs text-red-800">Acceso Restringido</h5>
                    <p className="text-[11px] text-red-600">
                      Solo el Propietario o Administrador de la tienda tiene privilegios para renombrar o configurar este comercio.
                    </p>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleUpdateCompanyName} className="space-y-4 max-w-md">
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-600 font-bold">Razón Social o Nombre Público</label>
                    <input
                      type="text"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-medium transition"
                      value={editedCompanyName}
                      onChange={(e) => setEditedCompanyName(e.target.value)}
                      required
                      disabled={isUpdating}
                    />
                  </div>
                  
                  <button
                    type="submit"
                    disabled={isUpdating || !editedCompanyName.trim() || editedCompanyName === companyName}
                    className="px-4 py-2.5 bg-indigo-650 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer transition flex items-center space-x-2 disabled:opacity-50"
                  >
                    <span>Guardar Cambios</span>
                  </button>
                </form>
              )}
            </div>
          )}

          {/* TAB: BACKUP & RESTORE */}
          {activeSubTab === 'branding' && (
            <form onSubmit={handleSaveBranding} className="space-y-5 text-left">
              <div>
                <h4 className="font-extrabold text-sm text-slate-800 flex items-center gap-2">
                  <Palette className="w-4 h-4 text-violet-500" />
                  Apariencia del Comercio
                </h4>
                <p className="text-[11px] text-slate-500 mt-1">
                  Personaliza el nombre, logo y colores que verán tus empleados al usar el POS.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-600 block">Nombre Comercial (en pantalla)</label>
                <input
                  type="text"
                  placeholder={companyName}
                  value={brandDisplayName}
                  onChange={e => setBrandDisplayName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-300 transition"
                />
                <p className="text-[10px] text-slate-400">Si lo dejas vacío se usará el nombre registrado de la empresa.</p>
              </div>

              {/* Logo upload */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-600 block">Logo del Comercio</label>
                <label className={`flex flex-col items-center justify-center w-full border-2 border-dashed rounded-xl cursor-pointer transition p-4 ${isProcessingLogo ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-slate-50 hover:border-violet-400 hover:bg-violet-50/50'}`}>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleLogoFileChange}
                    disabled={isProcessingLogo}
                  />
                  {isProcessingLogo ? (
                    <div className="flex flex-col items-center gap-2 py-2">
                      <div className="w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-[11px] text-violet-600 font-bold">Procesando imagen...</span>
                    </div>
                  ) : brandLogoUrl ? (
                    <div className="flex items-center gap-4 w-full">
                      <div className="w-16 h-16 rounded-xl bg-slate-900 flex items-center justify-center shrink-0 overflow-hidden">
                        <img src={brandLogoUrl} alt="Logo" className="w-full h-full object-contain p-1" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-700">Logo cargado</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Haz clic para cambiar el archivo</p>
                      </div>
                      <button
                        type="button"
                        onClick={e => { e.preventDefault(); setBrandLogoUrl(''); setColorAutoExtracted(false); }}
                        className="text-[10px] text-rose-500 hover:text-rose-700 font-bold shrink-0 px-2 py-1 rounded border border-rose-200 hover:bg-rose-50 transition"
                      >
                        Quitar
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 py-2 text-center">
                      <div className="w-10 h-10 rounded-xl bg-slate-200 flex items-center justify-center">
                        <Palette className="w-5 h-5 text-slate-400" />
                      </div>
                      <p className="text-xs font-bold text-slate-600">Subir logo</p>
                      <p className="text-[10px] text-slate-400">PNG, JPG, WebP · Máx 5MB</p>
                    </div>
                  )}
                </label>
              </div>

              {/* Color palette */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-slate-600 block">Paleta de Colores de Marca</label>
                  {colorAutoExtracted && (
                    <span className="text-[10px] text-violet-600 font-bold bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                      ✨ Extraída del logo
                    </span>
                  )}
                </div>

                {/* Preview strip */}
                <div className="flex rounded-xl overflow-hidden h-8 border border-slate-200">
                  <div className="flex-1" style={{ backgroundColor: brandDarkColor }} title="Oscuro (banner/header)" />
                  <div className="flex-1" style={{ backgroundColor: brandPrimaryColor }} title="Primario (botones/activos)" />
                  <div className="flex-1" style={{ backgroundColor: brandAccentColor }} title="Acento (badges/highlights)" />
                </div>

                {[
                  { label: 'Oscuro — Banner / Header', val: brandDarkColor, set: (v: string) => { setBrandDarkColor(v); setColorAutoExtracted(false); } },
                  { label: 'Primario — Botones / Activos', val: brandPrimaryColor, set: (v: string) => { setBrandPrimaryColor(v); setColorAutoExtracted(false); } },
                  { label: 'Acento — Badges / Destacados', val: brandAccentColor, set: (v: string) => { setBrandAccentColor(v); setColorAutoExtracted(false); } },
                ].map(({ label, val, set }) => (
                  <div key={label} className="flex items-center gap-2.5">
                    <input type="color" value={val} onChange={e => set(e.target.value)}
                      className="w-9 h-9 rounded-lg border border-slate-200 cursor-pointer p-0.5 bg-white shrink-0" />
                    <input type="text" value={val} onChange={e => set(e.target.value)}
                      className="w-24 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-[11px] font-mono outline-none focus:border-violet-400 transition" />
                    <span className="text-[10px] text-slate-500 font-medium">{label}</span>
                  </div>
                ))}

                {!brandLogoUrl && (
                  <p className="text-[10px] text-slate-400">Sube un logo para extraer la paleta automáticamente.</p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-600 block">Slogan / Tagline (opcional)</label>
                <input
                  type="text"
                  placeholder="Ej: El mejor sabor desde 1990"
                  value={brandTagline}
                  onChange={e => setBrandTagline(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-300 transition"
                />
              </div>

              {/* ID de comercio para empleados */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <p className="text-[11px] font-extrabold text-slate-600">Código de Comercio para Empleados</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 select-all">{companyId}</code>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(companyId); alert('Código copiado'); }}
                    className="p-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition cursor-pointer"
                  >
                    <Copy className="w-4 h-4 text-slate-500" />
                  </button>
                </div>
                <p className="text-[10px] text-slate-400">Comparte este código con tus empleados para que puedan ingresar al sistema.</p>
              </div>

              <button
                type="submit"
                disabled={isSavingBranding}
                className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition disabled:opacity-50"
              >
                {isSavingBranding ? 'Guardando...' : 'Guardar Apariencia'}
              </button>
            </form>
          )}

          {activeSubTab === 'print' && (
            <form onSubmit={handleSavePrintConfig} className="space-y-5 text-left">
              <div>
                <h4 className="font-extrabold text-sm text-slate-800 flex items-center gap-2">
                  <Printer className="w-4 h-4 text-sky-500" />
                  Configuración de Impresora
                </h4>
                <p className="text-[11px] text-slate-500 mt-1">
                  Ajusta el formato del ticket según tu impresora. Compatible con impresoras térmicas (58mm / 80mm) e impresoras de escritorio (Carta / A4).
                </p>
              </div>

              {/* Paper width selector */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-600 block">Ancho de papel</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['58mm', '80mm', 'A4'] as const).map(w => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setPrintPaperWidth(w)}
                      className={`py-3 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 ${
                        printPaperWidth === w
                          ? 'bg-sky-50 border-sky-400 text-sky-700'
                          : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <Printer className={`w-4 h-4 ${printPaperWidth === w ? 'text-sky-500' : 'text-slate-400'}`} />
                      {w}
                      <span className="text-[9px] font-medium text-slate-400">
                        {w === '58mm' ? 'Térmica chica' : w === '80mm' ? 'Térmica estándar' : 'Hoja carta'}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-400">
                  Funciona con cualquier impresora que el sistema operativo tenga instalada — Epson, Star, BIXOLON, MERION, HP, Brother, etc.
                </p>
              </div>

              {/* Bluetooth thermal printer (58/80mm ESC/POS, e.g. MERION PT-B1) */}
              {isNativePlatform && (
                <div className="space-y-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <label className="text-[11px] font-bold text-slate-600 block">Impresora térmica Bluetooth</label>
                  <p className="text-[10px] text-slate-400">
                    Para impresoras térmicas ESC/POS (MERION, Goojprt, Xprinter, etc.) que no aparecen en el diálogo normal de impresión. Primero empareja la impresora desde los ajustes de Bluetooth de Android, luego búscala aquí.
                  </p>

                  {bluetoothPrinter ? (
                    <div className="flex items-center justify-between p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                      <div>
                        <p className="text-xs font-bold text-emerald-800">{bluetoothPrinter.name || 'Impresora'}</p>
                        <p className="text-[10px] text-emerald-600">{bluetoothPrinter.address}</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleTestBt}
                          disabled={btTesting}
                          className="px-2.5 py-1.5 text-[10px] font-bold text-sky-700 bg-sky-100 hover:bg-sky-200 rounded-lg cursor-pointer transition disabled:opacity-50"
                        >
                          {btTesting ? 'Imprimiendo...' : 'Prueba'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectBluetoothPrinter?.(null)}
                          className="px-2.5 py-1.5 text-[10px] font-bold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg cursor-pointer transition"
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleScanBt}
                        disabled={btScanning}
                        className="w-full py-2 text-xs font-bold text-sky-700 bg-sky-100 hover:bg-sky-200 rounded-lg cursor-pointer transition disabled:opacity-50"
                      >
                        {btScanning ? 'Buscando...' : 'Buscar impresoras emparejadas'}
                      </button>
                      {btDevices.length > 0 && (
                        <div className="space-y-1.5 mt-2">
                          {btDevices.map(d => (
                            <button
                              key={d.address}
                              type="button"
                              onClick={() => onSelectBluetoothPrinter?.(d)}
                              className="w-full flex items-center justify-between p-2.5 bg-white border border-slate-200 hover:border-sky-400 rounded-lg text-left cursor-pointer transition"
                            >
                              <span className="text-xs font-bold text-slate-700">{d.name || 'Dispositivo sin nombre'}</span>
                              <span className="text-[10px] text-slate-400">{d.address}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {btError && <p className="text-[10px] text-red-500">{btError}</p>}
                </div>
              )}

              {/* Web printer (WebUSB / Web Bluetooth) — only relevant outside the APK, in a
                  plain browser tab, and only where the browser actually implements these APIs
                  (Chrome/Edge; not Safari/Firefox). */}
              {!isNativePlatform && (webUsbSupported || webBluetoothSupported) && (
                <div className="space-y-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <label className="text-[11px] font-bold text-slate-600 block">Impresora térmica (navegador)</label>
                  <p className="text-[10px] text-slate-400">
                    Para imprimir directo desde esta página web, sin instalar la app. Por USB funciona con cualquier impresora térmica conectada por cable. Por Bluetooth es experimental: solo funciona si el modelo de impresora también soporta Bluetooth de baja energía (BLE) — pruébalo con "Prueba" para confirmar.
                  </p>

                  {webPrinterInfo ? (
                    <div className="flex items-center justify-between p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                      <div>
                        <p className="text-xs font-bold text-emerald-800">{webPrinterInfo.name}</p>
                        <p className="text-[10px] text-emerald-600">{webPrinterInfo.mode === 'usb' ? 'Conectada por USB' : 'Conectada por Bluetooth (BLE)'}</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleTestWeb}
                          disabled={webTesting}
                          className="px-2.5 py-1.5 text-[10px] font-bold text-sky-700 bg-sky-100 hover:bg-sky-200 rounded-lg cursor-pointer transition disabled:opacity-50"
                        >
                          {webTesting ? 'Imprimiendo...' : 'Prueba'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onForgetWebPrinter?.()}
                          className="px-2.5 py-1.5 text-[10px] font-bold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg cursor-pointer transition"
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {webUsbSupported && (
                        <button
                          type="button"
                          onClick={() => handleConnectWeb('usb')}
                          disabled={webConnecting !== null}
                          className="flex-1 py-2 text-xs font-bold text-sky-700 bg-sky-100 hover:bg-sky-200 rounded-lg cursor-pointer transition disabled:opacity-50"
                        >
                          {webConnecting === 'usb' ? 'Conectando...' : 'Conectar por USB'}
                        </button>
                      )}
                      {webBluetoothSupported && (
                        <button
                          type="button"
                          onClick={() => handleConnectWeb('bluetooth')}
                          disabled={webConnecting !== null}
                          className="flex-1 py-2 text-xs font-bold text-indigo-700 bg-indigo-100 hover:bg-indigo-200 rounded-lg cursor-pointer transition disabled:opacity-50"
                        >
                          {webConnecting === 'bluetooth' ? 'Conectando...' : 'Conectar por Bluetooth'}
                        </button>
                      )}
                    </div>
                  )}

                  {webError && <p className="text-[10px] text-red-500">{webError}</p>}
                </div>
              )}

              {/* Toggles */}
              <div className="space-y-3">
                <label className="text-[11px] font-bold text-slate-600 block">Opciones del ticket</label>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <div>
                    <p className="text-xs font-bold text-slate-700">Mostrar logo en ticket</p>
                    <p className="text-[10px] text-slate-400">Imprime el logo del comercio en escala de grises</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPrintShowLogo(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition cursor-pointer ${printShowLogo ? 'bg-sky-500' : 'bg-slate-300'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${printShowLogo ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <div>
                    <p className="text-xs font-bold text-slate-700">Mostrar línea de impuestos</p>
                    <p className="text-[10px] text-slate-400">Incluye el desglose de IVA en el ticket</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPrintShowTaxLine(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition cursor-pointer ${printShowTaxLine ? 'bg-sky-500' : 'bg-slate-300'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${printShowTaxLine ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>

              {/* Footer text */}
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-600 block">Mensaje de pie de ticket</label>
                <input
                  type="text"
                  value={printFooterText}
                  onChange={e => setPrintFooterText(e.target.value)}
                  placeholder="¡Gracias por su compra!"
                  maxLength={80}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-300 transition"
                />
                <p className="text-[10px] text-slate-400">Aparece al final del ticket impreso. Máx. 80 caracteres.</p>
              </div>

              <button
                type="submit"
                disabled={isSavingPrint}
                className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-extrabold text-xs rounded-xl shadow cursor-pointer transition disabled:opacity-50"
              >
                {isSavingPrint ? 'Guardando...' : 'Guardar Configuración de Impresora'}
              </button>
            </form>
          )}

          {activeSubTab === 'backup' && (
            <div className="space-y-4 text-left">
              <div>
                <h4 className="font-extrabold text-sm text-slate-850">Respaldo en la Nube (Google Drive)</h4>
                <p className="text-[11px] text-slate-500">
                  Exporta e importa los datos de tus ventas, catálogo de productos, sucursales y clientes utilizando tu cuenta de Google Drive asociada.
                </p>
              </div>

              {currentUserRole !== 'owner' && currentUserRole !== 'master_admin' ? (
                <div className="bg-red-50 border border-red-200/50 p-4 rounded-xl flex items-start space-x-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-extrabold text-xs text-red-800">Acceso Restringido</h5>
                    <p className="text-[11px] text-red-600">
                      Solo el Propietario o Master Admin pueden gestionar los respaldos de la nube.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Backup Card */}
                  <div className="bg-slate-50 border border-slate-200 p-5 rounded-2xl flex flex-col items-center text-center space-y-3 shadow-sm">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 flex items-center justify-center rounded-xl shadow-inner border border-blue-200">
                      <span className="text-xl">☁️</span>
                    </div>
                    <div>
                      <h5 className="font-black text-xs text-slate-800">Generar Respaldo</h5>
                      <p className="text-[10px] text-slate-500 mt-1 max-w-[200px] mx-auto">
                        Crea un snapshot de toda tu base de datos y guárdala de manera segura en tu Google Drive.
                      </p>
                    </div>
                    <button
                      onClick={handleBackupToDrive}
                      disabled={isBackingUp || isRestoring}
                      className="mt-2 w-full max-w-[180px] bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[11px] px-3 py-2 rounded-lg transition disabled:opacity-50"
                    >
                      {isBackingUp ? 'Subiendo...' : 'Respaldar a Drive'}
                    </button>
                  </div>

                  {/* Restore Card */}
                  <div className="bg-slate-50 border border-slate-200 p-5 rounded-2xl flex flex-col items-center text-center space-y-3 shadow-sm">
                    <div className="w-12 h-12 bg-emerald-100 text-emerald-600 flex items-center justify-center rounded-xl shadow-inner border border-emerald-200">
                      <span className="text-xl">🔄</span>
                    </div>
                    <div>
                      <h5 className="font-black text-xs text-slate-800">Restaurar Sucursal</h5>
                      <p className="text-[10px] text-slate-500 mt-1 max-w-[200px] mx-auto">
                        Recupera un respaldo previo desde tu Google Drive. Esta es una operación de volcado total.
                      </p>
                    </div>
                    <button
                      onClick={handleRestoreFromDrive}
                      disabled={isBackingUp || isRestoring}
                      className="mt-2 w-full max-w-[180px] bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] px-3 py-2 rounded-lg transition disabled:opacity-50"
                    >
                      {isRestoring ? 'Recuperando...' : 'Restaurar de Drive'}
                    </button>
                    {isRestoring && restoreProgressMsg && (
                      <span className="text-[10px] font-bold text-emerald-600 block animate-pulse">
                        {restoreProgressMsg}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Custom Role & Permissions Modal */}
        {isRoleModalOpen && selectedRoleMember && (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-[2px] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-md p-6 shadow-xl space-y-5 text-left transition duration-200">
              <div className="flex justify-between items-center pb-3 border-b border-slate-150">
                <div>
                  <h3 className="text-base font-black text-slate-800">Tareas Adicionales</h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    {selectedRoleMember.name} · <span className={`font-black ${selectedRoleMember.role === 'admin' ? 'text-emerald-600' : 'text-indigo-600'}`}>{selectedRoleMember.role === 'admin' ? '🛡️ Encargado' : '💼 Cajero'}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRoleModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 font-extrabold text-sm"
                >
                  ✕
                </button>
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Activa las tareas extra que este empleado puede realizar además de las que ya incluye su rol base.
              </p>

              <div className="space-y-1.5">
                {[
                  { id: 'sales_history', label: 'Ver Historial de Ventas', desc: 'Puede consultar las ventas registradas en su sucursal' },
                  { id: 'products_edit', label: 'Registrar y Editar Productos', desc: 'Puede agregar o modificar productos del catálogo' },
                  { id: 'stock_transfer', label: 'Transferir Mercancía', desc: 'Puede redistribuir stock entre sucursales' },
                  { id: 'suppliers_restock', label: 'Gestión de Proveedores', desc: 'Puede registrar compras y gestionar proveedores' },
                  { id: 'cash_close', label: 'Cierre de Caja', desc: 'Puede realizar el corte y cierre de caja' },
                  { id: 'apply_discount', label: 'Aplicar Descuentos', desc: 'Puede aplicar descuentos en ventas' }
                ].map(perm => {
                  const isChecked = editedPermissions.includes(perm.id);
                  return (
                    <label key={perm.id} className="flex items-start gap-2.5 p-2.5 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-indigo-50 hover:border-indigo-200 transition">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          if (isChecked) {
                            setEditedPermissions(editedPermissions.filter(p => p !== perm.id));
                          } else {
                            setEditedPermissions([...editedPermissions, perm.id]);
                          }
                        }}
                        className="mt-0.5 accent-indigo-600 cursor-pointer w-4 h-4 shrink-0"
                      />
                      <div>
                        <p className="text-[12px] font-extrabold text-slate-800 leading-tight">{perm.label}</p>
                        <p className="text-[10px] text-slate-400 font-medium mt-0.5">{perm.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsRoleModalOpen(false)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-705 font-bold text-xs rounded-xl cursor-pointer transition text-center"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSaveRoleAndPermissions}
                  disabled={isUpdating}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl cursor-pointer transition text-center shadow-md disabled:opacity-50"
                >
                  {isUpdating ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal for Programmatic Credential Creation (No Google Required) */}
        {isCredModalOpen && (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-[2px] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-md p-6 shadow-xl space-y-5 text-left transition duration-205">
              
              {createdCredentialsShow ? (
                // SUCCESS STATE: Show created credentials to copy safely
                <div className="space-y-4">
                  <div className="text-center space-y-2">
                    <div className="w-12 h-12 bg-emerald-100 border border-emerald-200 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-xl font-bold animate-bounce">
                      ✓
                    </div>
                    <h3 className="text-base font-black text-slate-805">¡Cuenta Creada Con Éxito!</h3>
                    <p className="text-[11px] text-slate-500 font-medium">Guarda estos datos y envíaselos a tu colaborador <strong>{createdCredentialsShow.name}</strong> para que pueda iniciar sesión.</p>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3.5 text-xs">
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span>ID Comercio (Empresa)</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(createdCredentialsShow.companyId);
                            setCopiedCredNotify(true);
                            setTimeout(() => setCopiedCredNotify(false), 2000);
                          }}
                          className="text-indigo-600 hover:text-indigo-800 underline uppercase"
                        >
                          Copiar
                        </button>
                      </div>
                      <p className="font-mono text-slate-800 bg-slate-100/80 px-2.5 py-1.5 rounded-lg font-black tracking-wider break-all">{createdCredentialsShow.companyId}</p>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span>Usuario de Empleado</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(createdCredentialsShow.username);
                            setCopiedCredNotify(true);
                            setTimeout(() => setCopiedCredNotify(false), 2000);
                          }}
                          className="text-indigo-600 hover:text-indigo-800 underline uppercase"
                        >
                          Copiar
                        </button>
                      </div>
                      <p className="font-mono text-slate-800 bg-slate-100/80 px-2.5 py-1.5 rounded-lg font-black tracking-wider break-all">{createdCredentialsShow.username}</p>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span>Clave de Acceso (= Nº Empleado)</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(createdCredentialsShow.password);
                            setCopiedCredNotify(true);
                            setTimeout(() => setCopiedCredNotify(false), 2000);
                          }}
                          className="text-indigo-600 hover:text-indigo-800 underline uppercase"
                        >
                          Copiar
                        </button>
                      </div>
                      <p className="font-mono text-teal-750 bg-teal-50 border border-teal-100 px-2.5 py-1.5 rounded-lg font-black tracking-wider break-all">{createdCredentialsShow.password}</p>
                    </div>
                  </div>

                  {copiedCredNotify && (
                    <div className="bg-emerald-50 text-emerald-700 border border-emerald-150 p-2 rounded-lg text-center font-bold text-[10px] animate-fade-in">
                      <Check className="w-3.5 h-3.5 inline mr-1" />¡Copiado al portapapeles!
                    </div>
                  )}

                  {/* UNIFIED SHARING SECTION requested by user */}
                  <div className="space-y-2 pt-1 border-t border-slate-100">
                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Compartir con el Empleado</span>
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          const msg = `¡Hola, *${createdCredentialsShow.name}*! Te comparto tus credenciales de acceso para *LogicPOS*.\n\n🔑 *ID de Comercio / Empresa:* ${createdCredentialsShow.companyId}\n🔢 *Número de Empleado:* ${createdCredentialsShow.username}\n\n*Instrucciones para iniciar sesión:*\n1. Abre el sistema POS.\n2. Presiona "Acceso al Sistema" en la parte superior.\n3. Ingresa el *Código de Comercio* y tu *Número de Empleado*.\n4. ¡Listo! El número de empleado es tu acceso.`;
                          navigator.clipboard.writeText(msg);
                          setCopiedCredNotify(true);
                          setTimeout(() => setCopiedCredNotify(false), 2000);
                        }}
                        className="p-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl text-slate-700 font-extrabold text-[11px] flex items-center justify-center space-x-1.5 cursor-pointer transition select-none"
                      >
                        <Copy className="w-3.5 h-3.5 text-slate-500" />
                        <span>Copiar Mensaje</span><Copy className="w-3 h-3 inline ml-1" />
                      </button>

                      <a
                        href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                          `¡Hola, *${createdCredentialsShow.name}*! Te comparto tus credenciales de acceso para *LogicPOS*.\n\n🔑 *ID de Comercio / Empresa:* ${createdCredentialsShow.companyId}\n🔢 *Número de Empleado:* ${createdCredentialsShow.username}\n\n*Instrucciones para iniciar sesión:*\n1. Abre el sistema POS.\n2. Presiona "Acceso al Sistema" en la parte superior.\n3. Ingresa el *Código de Comercio* y tu *Número de Empleado*.\n4. ¡Listo! El número de empleado es tu acceso.`
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2.5 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-xl text-teal-800 font-extrabold text-[11px] flex items-center justify-center space-x-1.5 cursor-pointer transition select-none text-center"
                      >
                        <Share2 className="w-3.5 h-3.5 text-teal-600" />
                        <span>Enviar por WhatsApp 💬</span>
                      </a>
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCreatedCredentialsShow(null);
                        setIsCredModalOpen(false);
                      }}
                      className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs rounded-xl shadow cursor-pointer transition text-center"
                    >
                      Listo, Entendido 👍
                    </button>
                  </div>
                </div>
              ) : (
                // FORM STATE: To capture new account info
                <form onSubmit={handleCreateCredentialEmployee} className="space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b border-slate-150">
                    <div>
                      <h3 className="text-base font-black text-slate-800">Registrar Cuenta Sin Google 🔑</h3>
                      <p className="text-[11px] text-slate-500 font-medium">Crea cuentas de acceso directo (usuario + contraseña) para tus colaboradores.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsCredModalOpen(false)}
                      className="text-slate-400 hover:text-slate-600 font-extrabold text-sm"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-left mb-1">
                    <p className="text-[11px] text-amber-700 leading-relaxed">
                      El <strong>Número de Empleado</strong> servirá como usuario y contraseña de acceso. Comparte el <strong>Código de Comercio</strong> y el número al empleado.
                    </p>
                  </div>

                  <div className="space-y-3.5 text-xs font-semibold text-slate-700">
                    <div className="space-y-1">
                      <label className="text-slate-600 font-bold block">Nombre Completo del Empleado *</label>
                      <input
                        type="text"
                        required
                        placeholder="Ej: Juan Pérez"
                        value={credName}
                        onChange={(e) => setCredName(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-505 font-bold text-slate-705"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-600 font-bold block">Número de Empleado *</label>
                      <input
                        type="text"
                        required
                        placeholder="Ej: 1001"
                        value={credUsername}
                        onChange={(e) => {
                          setCredUsername(e.target.value);
                          setCredPassword(e.target.value);
                        }}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-505 font-bold text-slate-705 font-mono"
                      />
                      <p className="text-[9px] text-slate-400 leading-tight">Este número es el acceso. Se usa con el Código de Comercio para entrar al sistema.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-slate-600 font-bold block">Rol *</label>
                        <select
                          value={credRole}
                          onChange={(e) => setCredRole(e.target.value as 'master_admin' | 'admin' | 'employee')}
                          className="w-full bg-white border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-505 font-bold text-slate-705 cursor-pointer"
                        >
                          <option value="employee">💼 Cajero / Empleado</option>
                          <option value="admin">🛡️ Encargado / Gerente</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-600 font-bold block">Sucursal Asignada</label>
                        <select
                          value={credBranchId}
                          onChange={(e) => setCredBranchId(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-lg p-2.5 outline-none focus:border-indigo-505 font-bold text-slate-705 cursor-pointer"
                        >
                          <option value="">Matriz / General</option>
                          {branches.map(b => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2.5 pt-3 border-t">
                    <button
                      type="button"
                      onClick={() => setIsCredModalOpen(false)}
                      className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-705 font-bold text-xs rounded-xl cursor-pointer transition text-center"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={isCreatingCred}
                      className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs rounded-xl cursor-pointer transition text-center tracking-wide shadow-md disabled:opacity-50"
                    >
                      {isCreatingCred ? 'Registrando...' : 'Registrar Colaborador 🔑'}
                    </button>
                  </div>
                </form>
              )}

            </div>
          </div>
        )}

      </div>

    </div>
  );
}

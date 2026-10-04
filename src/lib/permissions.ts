export const APP_PERMISSIONS = [
  'sales_history',
  'products_edit',
  'stock_transfer',
  'stock_restock',
  'suppliers_restock',
  'cash_close',
  'apply_discount',
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];
export type CompanyRole = 'owner' | 'admin' | 'employee';

export const PERMISSION_OPTIONS: ReadonlyArray<{
  id: AppPermission;
  label: string;
  desc: string;
}> = [
  { id: 'sales_history', label: 'Ver Historial de Ventas', desc: 'Puede consultar las ventas registradas en su sucursal' },
  { id: 'products_edit', label: 'Registrar y Editar Productos', desc: 'Puede agregar o modificar productos del catálogo' },
  { id: 'stock_transfer', label: 'Transferir Mercancía', desc: 'Puede redistribuir stock entre sucursales' },
  { id: 'stock_restock', label: 'Surtir Inventario', desc: 'Puede reabastecer existencias en su sucursal' },
  { id: 'suppliers_restock', label: 'Administrar Proveedores', desc: 'Puede crear, editar y eliminar proveedores' },
  { id: 'cash_close', label: 'Cierre de Caja', desc: 'Puede realizar el corte y cierre de caja' },
  { id: 'apply_discount', label: 'Aplicar Descuentos', desc: 'Puede aplicar descuentos en ventas' },
];

// An Encargado (admin) runs its own branch end to end: history, cash close, discounts, transfers
// and restock. Catalogue and supplier administration (products_edit, suppliers_restock) stay
// with the owner and are only reachable through an explicit stored grant. A cashier (employee)
// sells and reads its own branch's history. Branch scoping is enforced separately
// (operationalBranchId in the client, canUseBranch in firestore.rules); these defaults must
// mirror hasPermission() in firestore.rules.
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<CompanyRole, readonly AppPermission[]>> = {
  owner: APP_PERMISSIONS,
  admin: ['sales_history', 'stock_transfer', 'stock_restock', 'cash_close', 'apply_discount'],
  employee: ['sales_history'],
};

export function getDefaultPermissions(role: CompanyRole): readonly AppPermission[] {
  return DEFAULT_ROLE_PERMISSIONS[role] ?? [];
}

export function hasAppPermission(
  role: CompanyRole,
  permissions: readonly string[] | undefined,
  permission: AppPermission,
): boolean {
  const defaultPermissions = DEFAULT_ROLE_PERMISSIONS[role];
  if (!defaultPermissions) return false;
  return defaultPermissions.includes(permission) || Boolean(permissions?.includes(permission));
}

export function isOwnerRole(role: CompanyRole): boolean {
  return role === 'owner';
}

// Refunding a sale is a role capability, not a grantable permission: the owner refunds in any
// branch and an admin (Encargado) refunds in its assigned branch. Reversing a sale also puts
// stock back, which only owners and admins may do, so it is deliberately not offered as an
// extra grant to employees. Mirrors canAdminRefundSale() in firestore.rules.
export function canRefundSalesRole(role: CompanyRole): boolean {
  return role === 'owner' || role === 'admin';
}

export interface HistoryAccess {
  /** Reads the sales of its own branch. */
  canViewHistory: boolean;
  /** Cash panel, cash audit log and monthly cut. */
  canViewCashAudit: boolean;
  /** Inventory movements log (restocks and transfers). */
  canViewInventoryLog: boolean;
  /** Statistics tab (it includes the estimated profit). */
  canViewAnalytics: boolean;
  /** How far back the live sales stream reaches: today only for a plain cashier. */
  salesWindow: 'today' | 'month';
}

// What the history screens offer. A plain cashier (employee) reads the sales of its own branch
// for today only: no statistics (they show profit), no cash audit, no inventory log and no older
// periods, which also keeps its Firestore reads small (the heaviest streams stay closed). A
// cashier explicitly granted cash_close or a stock permission gets the matching view back.
// Everyone else (owner, Encargado) keeps the full month-long views.
export function getHistoryAccess(
  role: CompanyRole,
  permissions: readonly string[] | undefined,
): HistoryAccess {
  const has = (permission: AppPermission) => hasAppPermission(role, permissions, permission);
  const canViewHistory = has('sales_history');
  const cashier = role === 'employee';
  const canViewCashAudit = canViewHistory && (!cashier || has('cash_close'));
  return {
    canViewHistory,
    canViewCashAudit,
    canViewInventoryLog: canViewHistory
      && (!cashier || has('stock_restock') || has('stock_transfer') || has('products_edit')),
    canViewAnalytics: canViewHistory && !cashier,
    salesWindow: cashier && !canViewCashAudit ? 'today' : 'month',
  };
}

// Invoicing (Facturación): the owner manages every branch, an Encargado only the sales of its
// own assigned branch. Mirrors canAdminInvoiceSale() in firestore.rules.
export function canManageInvoicingRole(role: CompanyRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function resolveAssignedBranchId(
  candidate: unknown,
  branches: readonly { id: string }[],
): string | null {
  const branchId = typeof candidate === 'string' ? candidate.trim() : '';
  return branchId && branches.some(branch => branch.id === branchId) ? branchId : null;
}

export function getInventoryExportBranches<T extends { id: string }>(
  role: CompanyRole,
  assignedBranchId: unknown,
  branches: readonly T[],
): readonly T[] {
  if (isOwnerRole(role)) return branches;
  const branchId = resolveAssignedBranchId(assignedBranchId, branches);
  return branchId ? branches.filter(branch => branch.id === branchId) : [];
}

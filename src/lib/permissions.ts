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

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<CompanyRole, readonly AppPermission[]>> = {
  owner: APP_PERMISSIONS,
  admin: ['stock_transfer', 'stock_restock'],
  employee: [],
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

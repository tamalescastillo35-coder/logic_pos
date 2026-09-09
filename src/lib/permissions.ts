export const APP_PERMISSIONS = [
  'sales_history',
  'products_edit',
  'stock_transfer',
  'suppliers_restock',
  'cash_close',
  'apply_discount',
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];
export type CompanyRole = 'owner' | 'master_admin' | 'admin' | 'employee';

export const PERMISSION_OPTIONS: ReadonlyArray<{
  id: AppPermission;
  label: string;
  desc: string;
}> = [
  { id: 'sales_history', label: 'Ver Historial de Ventas', desc: 'Puede consultar las ventas registradas en su sucursal' },
  { id: 'products_edit', label: 'Registrar y Editar Productos', desc: 'Puede agregar o modificar productos del catálogo' },
  { id: 'stock_transfer', label: 'Transferir Mercancía', desc: 'Puede redistribuir stock entre sucursales' },
  { id: 'suppliers_restock', label: 'Gestión de Proveedores', desc: 'Puede registrar compras y gestionar proveedores' },
  { id: 'cash_close', label: 'Cierre de Caja', desc: 'Puede realizar el corte y cierre de caja' },
  { id: 'apply_discount', label: 'Aplicar Descuentos', desc: 'Puede aplicar descuentos en ventas' },
];

export function hasAppPermission(
  role: CompanyRole,
  permissions: readonly string[] | undefined,
  permission: AppPermission,
): boolean {
  return role === 'owner' || role === 'master_admin' || role === 'admin' || Boolean(permissions?.includes(permission));
}

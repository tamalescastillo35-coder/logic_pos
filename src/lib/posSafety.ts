export interface DateBackedRecord {
  createdAt?: unknown;
  timestamp?: string;
}

export type CheckoutErrorKind =
  | 'session'
  | 'permission'
  | 'offline'
  | 'contention'
  | 'invalid-data'
  | 'quota'
  | 'register-closed'
  | 'stock'
  | 'unknown';

export interface CheckoutErrorDescription {
  kind: CheckoutErrorKind;
  message: string;
  retryable: boolean;
}

export class StockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockUnavailableError';
  }
}

export class CashRegisterClosedError extends Error {
  constructor(message = 'La caja de esta sucursal está cerrada.') {
    super(message);
    this.name = 'CashRegisterClosedError';
  }
}

export const isQuotaExceededError = (error: unknown): boolean => {
  const candidate = error as { name?: string; code?: number } | null;
  return candidate?.name === 'QuotaExceededError' || candidate?.code === 22 || candidate?.code === 1014;
};

// Local storage is a convenience cache/preferences layer. Its failure must never abort a
// Firestore operation, especially checkout.
export const safeLocalStorageSet = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    const reason = isQuotaExceededError(error) ? 'quota exceeded' : 'storage unavailable';
    console.warn(`[localStorage] ${reason}; ignored for key "${key}"`, error);
    return false;
  }
};

export const safeLocalStorageRemove = (key: string): boolean => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`[localStorage] remove failed; ignored for key "${key}"`, error);
    return false;
  }
};

// A select element visually falls back to its first option when its controlled value no
// longer exists, but React state keeps the stale value. Always resolve the real branch ID so
// stock, cash and sales cannot silently run against a deleted/legacy branch such as "b1".
export const resolveActiveBranchId = (currentId: string, availableIds: string[]): string => {
  if (availableIds.includes(currentId)) return currentId;
  return availableIds[0] ?? '';
};

// Parses only known legacy display formats. An invalid value returns null; it is never
// converted into "now", which would move historical records into today's reports.
export const parseLegacyLocalizedTimestamp = (value?: string): number | null => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();

  // ISO and RFC-like values are safe to hand to Date.parse. Regional numeric strings are
  // deliberately handled below because engines disagree on DD/MM/YYYY.
  if (/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/a\.?\s*m\.?/g, 'am')
    .replace(/p\.?\s*m\.?/g, 'pm');
  const match = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(am|pm)?)?$/
  );
  if (!match) return null;

  const [, dayText, monthText, yearText, hourText = '0', minuteText = '0', secondText = '0', meridiem] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
    date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
  ) return null;
  return date.getTime();
};

export const getRecordCreatedAtMs = (record: DateBackedRecord): number | null => {
  if (typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)) return record.createdAt;
  const timestampLike = record.createdAt as { toMillis?: () => number } | null;
  if (timestampLike && typeof timestampLike.toMillis === 'function') {
    const millis = timestampLike.toMillis();
    if (Number.isFinite(millis)) return millis;
  }
  return parseLegacyLocalizedTimestamp(record.timestamp);
};

export const getRecordMonthKey = (record: DateBackedRecord): string => {
  const millis = getRecordCreatedAtMs(record);
  if (millis === null) return '';
  const date = new Date(millis);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

export const getRecordDayKey = (record: DateBackedRecord): string => {
  const millis = getRecordCreatedAtMs(record);
  if (millis === null) return '';
  const date = new Date(millis);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const getMonthRange = (monthKey: string): { start: number; end: number } | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return {
    start: new Date(year, monthIndex, 1).getTime(),
    end: new Date(year, monthIndex + 1, 1).getTime(),
  };
};

export const getDayRange = (dayKey: string): { start: number; end: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const startDate = new Date(year, monthIndex, day);
  if (startDate.getFullYear() !== year || startDate.getMonth() !== monthIndex || startDate.getDate() !== day) return null;
  return { start: startDate.getTime(), end: new Date(year, monthIndex, day + 1).getTime() };
};

const normalizeFirebaseCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.replace(/^firestore\//, '') : '';
};

export const describeCheckoutError = (error: unknown): CheckoutErrorDescription => {
  if (error instanceof StockUnavailableError) {
    return { kind: 'stock', message: error.message, retryable: true };
  }
  if (error instanceof CashRegisterClosedError) {
    return { kind: 'register-closed', message: error.message, retryable: true };
  }
  if (isQuotaExceededError(error)) {
    return {
      kind: 'quota',
      message: 'El almacenamiento local del dispositivo está lleno, pero no se usó para confirmar la venta. Libera espacio y vuelve a intentar.',
      retryable: true,
    };
  }

  const code = normalizeFirebaseCode(error);
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return {
      kind: code === 'unauthenticated' ? 'session' : 'permission',
      message: code === 'unauthenticated'
        ? 'La sesión ya no es válida. La venta NO se registró. Vuelve a iniciar sesión.'
        : 'Firestore rechazó la operación por permisos. La venta NO se registró; solicita revisión de la cuenta y las reglas.',
      retryable: false,
    };
  }
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled') {
    return {
      kind: 'offline',
      message: 'No fue posible confirmar la venta con Firestore. La venta NO se registró; conserva el carrito y reintenta cuando la conexión se estabilice.',
      retryable: true,
    };
  }
  if (code === 'aborted' || code === 'failed-precondition') {
    return {
      kind: 'contention',
      message: 'Otra terminal modificó inventario o caja al mismo tiempo. La venta NO se registró; revisa el stock mostrado e intenta de nuevo.',
      retryable: true,
    };
  }
  if (code === 'invalid-argument' || code === 'out-of-range' || code === 'data-loss') {
    return {
      kind: 'invalid-data',
      message: 'Firestore rechazó datos inválidos. La venta NO se registró; anota el folio y reporta el incidente.',
      retryable: false,
    };
  }
  if (code === 'resource-exhausted') {
    return {
      kind: 'quota',
      message: 'Firestore alcanzó un límite de cuota o capacidad. La venta NO se registró; repórtalo al encargado.',
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    message: 'Ocurrió un error interno no identificado. La venta NO se registró y el carrito permanece intacto.',
    retryable: true,
  };
};

export class MatrixConfigurationError extends Error {
  constructor(message: string = 'Configuración de Matriz inválida') {
    super(message);
    this.name = 'MatrixConfigurationError';
  }
}

export interface StockOperationErrorDescription {
  kind: 'permission' | 'offline' | 'contention' | 'stock' | 'invalid-data' | 'session' | 'matrix-config' | 'unknown';
  message: string;
  retryable: boolean;
}

export const describeStockOperationError = (error: unknown): StockOperationErrorDescription => {
  if (error instanceof MatrixConfigurationError) {
    return {
      kind: 'matrix-config',
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof StockUnavailableError) {
    return {
      kind: 'stock',
      message: error.message,
      retryable: true,
    };
  }

  const code = normalizeFirebaseCode(error);
  if (code === 'permission-denied') {
    return {
      kind: 'permission',
      message: 'No tienes permisos suficientes o la transferencia viola las reglas de sucursal. Solicita autorización al Propietario.',
      retryable: false,
    };
  }
  if (code === 'unauthenticated') {
    return {
      kind: 'session',
      message: 'La sesión ya no es válida. La operación NO se aplicó; vuelve a iniciar sesión.',
      retryable: false,
    };
  }
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled') {
    return {
      kind: 'offline',
      message: 'No fue posible confirmar la operación con Firestore. Los datos se conservaron; reintenta cuando la conexión se estabilice.',
      retryable: true,
    };
  }
  if (code === 'aborted' || code === 'failed-precondition') {
    return {
      kind: 'contention',
      message: 'Otra terminal modificó el inventario al mismo tiempo. La operación NO se aplicó; revisa las existencias e intenta de nuevo.',
      retryable: true,
    };
  }
  if (code === 'invalid-argument' || code === 'out-of-range' || code === 'data-loss') {
    return {
      kind: 'invalid-data',
      message: 'Datos de la operación inválidos. Revisa las cantidades y sucursales seleccionadas.',
      retryable: false,
    };
  }
  return {
    kind: 'unknown',
    message: 'Ocurrió un error inesperado al aplicar la operación de stock. Los datos se conservaron.',
    retryable: true,
  };
};

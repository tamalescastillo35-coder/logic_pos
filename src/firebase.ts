import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, createUserWithEmailAndPassword } from 'firebase/auth';
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase SDK
const app = initializeApp(firebaseConfig);
// Persistent (IndexedDB) local cache: after a device's first sync, reloads/reconnects only
// re-read documents that actually changed instead of the full collections again — cuts
// Firestore read volume sharply on a POS device that gets reloaded/backgrounded often.
// persistentMultipleTabManager keeps this working even if the same branch has 2 tabs open.
// initializeFirestore() throws if Firestore was already initialized for this app instance —
// harmless in production (this module only runs once per page load) but Vite's HMR re-runs
// this file on every edit while the underlying app instance survives, so fall back to
// getFirestore() (which just returns the already-initialized instance) in that case.
// VITE_FIRESTORE_DATABASE_ID, when set, overrides only the database ID — never the rest of
// firebaseConfig — so a local sandbox Firestore database can be used during development without
// touching production. It's only ever defined in .env.development.local, a file that never
// leaves the developer's machine (gitignored, and Vite loads .env.[mode].local only in that
// mode), so production builds always fall back to firebaseConfig's real database ID unchanged.
const firestoreDatabaseId =
  (import.meta.env.VITE_FIRESTORE_DATABASE_ID as string | undefined) ||
  (firebaseConfig as any).firestoreDatabaseId;

let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  }, firestoreDatabaseId);
} catch {
  dbInstance = getFirestore(app, firestoreDatabaseId);
}
export const db = dbInstance; /* CRITICAL: The app will break without this line */
export const auth = getAuth(app);
// Plain login provider — only basic (non-sensitive) Google scopes. Keeping this free of
// sensitive scopes means the OAuth consent screen can be published immediately (no Google
// verification wait), so any Google account can sign in right away.
export const googleProvider = new GoogleAuthProvider();

// Separate provider carrying the Drive scope, used only for the "Respaldar/Restaurar a
// Drive" actions (e.g. migrating a company's data to a client-owned Firebase project) —
// never bundled into the everyday login. Until this scope is verified by Google, only
// accounts added as test users in the Google Cloud OAuth consent screen can grant it.
export const driveGoogleProvider = new GoogleAuthProvider();
driveGoogleProvider.addScope('https://www.googleapis.com/auth/drive.file');

// In-memory caching for Google Drive access token (highly secure, non-persistent)
let cachedAccessToken: string | null = null;

export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

export function setCachedAccessToken(token: string | null) {
  cachedAccessToken = token;
}

/**
 * Creates an email/password account in a secondary Auth instance in memory.
 * This prevents the current logged-in owner/admin user from being logged out on the main SDK app context.
 */
export async function createCredentialUser(email: string, password: string): Promise<string> {
  const secondaryAppName = "employee-manager";
  let secondaryApp;
  const existingApps = getApps();
  const existing = existingApps.find(a => a.name === secondaryAppName);
  if (existing) {
    secondaryApp = existing;
  } else {
    secondaryApp = initializeApp(firebaseConfig, secondaryAppName);
  }
  const secondaryAuth = getAuth(secondaryApp);
  const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
  const uid = userCredential.user.uid;
  // Sign out of the secondary auth sandbox so it is ready for the next usage and does not leak memory
  await secondaryAuth.signOut();
  return uid;
}

// Error handling types and helpers as required by prompt
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  code: string | null;
  operationType: OperationType;
  path: string | null;
}

export class CloudOperationError extends Error {
  readonly code: string | null;
  readonly operationType: OperationType;
  readonly path: string | null;

  constructor(info: FirestoreErrorInfo, options?: ErrorOptions) {
    super(info.error, options);
    this.name = 'CloudOperationError';
    this.code = info.code;
    this.operationType = info.operationType;
    this.path = info.path;
  }
}

/**
 * Records a sanitized Firestore failure and returns an Error for callers that need to
 * propagate it. Authentication identifiers and email addresses are intentionally excluded:
 * POS terminals are shared devices and their developer console must not become a PII log.
 */
export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): CloudOperationError {
  const rawCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: rawCode ? rawCode.replace(/^firestore\//, '') : null,
    operationType,
    path
  };
  console.error('Firestore operation failed:', errInfo);
  return new CloudOperationError(errInfo, error instanceof Error ? { cause: error } : undefined);
}

// Thrown by the shared write helpers in App.tsx (saveAllData / applyStockDeltas /
// applyCashDelta / applyCustomerBalanceDelta) when `user` or `activeCompanyId` are falsy at
// call time. Those used to just `return` silently, so a sale/stock/cash change made while the
// session was momentarily unresolved (shared device, shift handoff, company still loading)
// updated the screen and vanished without ever reaching Firestore — no error, no trace.
// Callers tell this apart from a generic network/Firestore failure via instanceof, which
// survives minification unlike sniffing error.message.
export class SessionInvalidError extends Error {
  constructor(message: string = 'SESSION_INVALID') {
    super(message);
    this.name = 'SessionInvalidError';
  }
}

export function isSessionInvalidError(err: unknown): err is SessionInvalidError {
  return err instanceof SessionInvalidError;
}



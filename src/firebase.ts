import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase SDK
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId); /* CRITICAL: The app will break without this line */
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
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}



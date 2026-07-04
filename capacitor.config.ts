import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'mx.einnovacion.swiftsalepos',
  appName: 'LOGIC POS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Reverted: pointing the WebView's own origin at Firebase's authDomain (tried
    // previously to fix signInWithRedirect) backfired — Capacitor then intercepts
    // EVERY request to that host locally, including `/__/auth/handler`, which Firebase
    // needs to serve for real over the network to complete the flow. Google login on
    // native now goes through @capacitor-firebase/authentication (native SDK, no WebView
    // redirect at all) instead, so this no longer needs to match authDomain.
  },
  android: {
    buildOptions: {
      releaseType: 'APK',
    },
  },
  plugins: {
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['google.com'],
    },
  },
};

export default config;

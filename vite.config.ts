import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
const isCapacitor = process.env.BUILD_TARGET === 'capacitor';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  base: isCapacitor ? './' : '/',
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});

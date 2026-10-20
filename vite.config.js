import { defineConfig } from 'vite';

// Honour a PORT from the environment when one is supplied (some dev harnesses
// assign the port themselves); otherwise fall back to Vite's usual 5173.
export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
});

import { defineConfig } from 'vite';

// Honour a PORT from the environment when one is supplied (some dev harnesses
// assign the port themselves); otherwise fall back to Vite's usual 5173.
//
// `base: './'` makes every built asset URL relative, so the same build works
// at the root of a host and under a GitHub Pages project path (/Taglite/).
export default defineConfig({
  base: './',
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
});

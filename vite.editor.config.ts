import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-editor',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'src/editor/flight-sim.ts',
      formats: ['es'],
      fileName: () => 'flight-sim.mjs',
    },
    rolldownOptions: {
      external: ['playcanvas'],
      output: {
        codeSplitting: false,
      },
    },
  },
});

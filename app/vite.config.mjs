import { defineConfig } from 'vite';
export default defineConfig({base:'./',build:{target:'es2022',outDir:'dist',chunkSizeWarningLimit:6000},server:{host:'127.0.0.1',port:8766,strictPort:true}});

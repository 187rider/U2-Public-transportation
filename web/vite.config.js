import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  envDir: "../",
  plugins: [react()],

  optimizeDeps: {
    exclude: ["maplibre-gl"]
  },

  server: {
    host: "0.0.0.0",

    proxy: {
      "/tiles": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true
      },
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      }
    }
  }
});

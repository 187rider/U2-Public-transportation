import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...loadEnv(mode, "../", "") };
  const targetApi = env.VITE_API_BASE_URL || "http://localhost:8000";

  return {
    envDir: "../",
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      proxy: {
        "/tiles": {
          target: targetApi,
          changeOrigin: true
        },
        "/api": {
          target: targetApi,
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: "../dist",
      emptyOutDir: true
    },
    preview: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/tiles": {
          target: targetApi,
          changeOrigin: true
        },
        "/api": {
          target: targetApi,
          changeOrigin: true
        }
      }
    }
  };
});

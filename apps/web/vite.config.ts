import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// apps/server listens on 8787. the browser only talks to /plan and /execute.
// the seed and every key stay on the server. SPIDEREUM_SERVER points the proxy elsewhere;
// it is read here, at dev time, and never reaches the browser
const server = process.env.SPIDEREUM_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      "/plan": { target: server, changeOrigin: true },
      "/execute": { target: server, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/plan": { target: server, changeOrigin: true },
      "/execute": { target: server, changeOrigin: true },
    },
  },
});

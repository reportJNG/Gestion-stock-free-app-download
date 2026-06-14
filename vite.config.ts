import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const appVersion = JSON.parse(readFileSync(resolve("package.json"), "utf-8"))
  .version as string;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve("electron/main.ts"),
        formats: ["cjs"],
        fileName: () => "main.cjs",
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve("electron/preload.ts"),
        formats: ["cjs"],
        fileName: () => "preload.cjs",
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        "@": resolve("src"),
      },
    },
    build: {
      target: "chrome110",
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          index: resolve("index.html"),
        },
        output: {
          format: "iife",
          inlineDynamicImports: true,
        },
      },
    },
  },
});

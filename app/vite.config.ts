import { defineConfig } from "vite";

// Tauri expects a fixed port (PORT overrides it for a browser-only preview) and must see Rust
// compile errors in the terminal. The frontend also imports the core's built-in profile/presets
// and the AI prompts from the repository root.
export default defineConfig({
  clearScreen: false,
  server: { port: Number(process.env.PORT) || 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] }, fs: { allow: [".."] } },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});

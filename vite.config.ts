// Vite dev server configuration for LocalGobe
import { defineConfig, type Plugin } from "vite";
import { createLocalGobeMiddleware } from "./src/server/http/router.ts";
import { startSmartFoxRuntime, type SmartFoxRuntimeHandle } from "./src/server/smartfox/smartfox-server.ts";

function localGobeServerPlugin(): Plugin {
  return {
    name: "localgobe-server",
    async configureServer(server) {
      let runtimeHandle: SmartFoxRuntimeHandle | null = null;
      let smartFoxReady = false;

      if (process.env.LOCALGOBE_NO_AUTO_SERVER !== "1") {
        try {
          runtimeHandle = await startSmartFoxRuntime();
          smartFoxReady = true;
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === "EADDRINUSE") {
            smartFoxReady = true;
          } else {
            console.warn("[localgobe] SmartFox server did not start:", err);
          }
        }
      }

      server.httpServer?.once("close", () => {
        void runtimeHandle?.close();
      });

      const middleware = createLocalGobeMiddleware({
        isSmartFoxReady: () => smartFoxReady,
      });

      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [localGobeServerPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});

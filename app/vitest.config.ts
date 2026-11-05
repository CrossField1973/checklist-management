import { defineConfig } from "vitest/config";

// Nur die Backend-Tests; die Tests der Oberfläche liegen in web/ und laufen mit deren eigener Konfiguration.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });

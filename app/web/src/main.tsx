import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import "./i18n";
import "./styles.css";

// Startet das Gerät ohne Verbindung, sollen Abfragen warten statt zu scheitern (React Query geht sonst zunächst von „online“ aus)
onlineManager.setOnline(navigator.onLine);

// Lange Haltezeit: Daten bleiben für den Offline-Betrieb im Speicher (und werden von offline/persist.ts in IndexedDB gesichert)
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, gcTime: 7 * 24 * 3600_000 } } });

// Service Worker (App-Oberfläche offline, F-72/F-74) – nur im Produktivbetrieb
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

// Datenrouter (statt BrowserRouter): nötig, um das Verlassen einer Seite mit ungespeicherten Änderungen abzufangen (useBlocker)
const router = createBrowserRouter([{ path: "*", element: <AuthProvider><App /></AuthProvider> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

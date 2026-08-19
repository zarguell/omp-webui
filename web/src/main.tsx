import { createRoot } from "react-dom/client";
import { App } from "./app";

// Ghostty WASM terminal emulator — loaded on demand by TerminalView
// (lazy-imported, not a top-level dependency)

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

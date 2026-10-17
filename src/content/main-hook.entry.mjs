import { installMainHook } from "./main-hook.mjs";

// Page-world (MAIN) content script entry point; bundled to content/main-hook.js.
installMainHook({ window: globalThis, document: globalThis.document });

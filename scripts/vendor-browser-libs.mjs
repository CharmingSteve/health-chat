import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Copies the two browser libraries from node_modules into public/vendor. Run before packaging and before local dev.
// exifr reads the camera's date and location from photos. libheif decodes HEIC (iPhone and Photos format) in the browser.
const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "public", "vendor");
mkdirSync(out, { recursive: true });
copyFileSync(resolve(root, "node_modules/exifr/dist/full.esm.mjs"), resolve(out, "exifr.mjs"));
copyFileSync(resolve(root, "node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs"), resolve(out, "libheif.mjs"));
console.info("Copied browser libraries to public/vendor");

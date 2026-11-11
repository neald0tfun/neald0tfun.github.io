import * as pawtect from "./pawtect/pawtect_wasm.js";
Object.defineProperty(window, "pawtect", {
  value: pawtect,
  writable: false,
  configurable: false,
  enumerable: false,
});

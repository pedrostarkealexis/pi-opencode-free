/**
 * Package entry point for Pi's extension discovery.
 *
 * Kept at the package root so Pi's startup Extensions list shows the label
 * "pi-opencode-free" (the loader collapses a root-level index.ts to the
 * package directory name; a nested path would display as "src").
 */
export { default } from "./src/index.js";

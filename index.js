// Root entrypoint for directory-path plugin loading.
//
// opencode resolves a `plugin` entry that is a directory by looking for
// `index.js`/`index.ts` at the directory root; it does NOT read package.json
// "main". Without this file the plugin is skipped silently, with no warning in
// the logs. The real implementation stays in dist/ (built from src/).
export { default } from "./dist/index.js";

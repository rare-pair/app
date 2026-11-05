// vite's `?raw` import: the file's text. wrangler.test.ts reads wrangler.jsonc this way. This
// file has no import or export, so the declaration is ambient (a wildcard name is refused in
// a module's augmentation).
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}

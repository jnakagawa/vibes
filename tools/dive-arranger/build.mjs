// esbuild bundling for the MV3 extension. `npm run build` → dist/.
// The project root (with manifest.json) is what you load unpacked.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

// recast pulls in a couple of Node builtins it never actually needs in our
// browser code path (custom parser, print-only). Stub them out.
writeFileSync(
  "dist/.shim-node.mjs",
  `export default {};
export const sep = "/";
export function join(...xs) { return xs.join("/"); }
export function relative(a, b) { return b; }
export function resolve(...xs) { return xs.join("/"); }
`,
);
writeFileSync(
  "dist/.shim-assert.mjs",
  `function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
assert.ok = assert;
assert.strictEqual = (a, b, m) => assert(a === b, m);
assert.notStrictEqual = (a, b, m) => assert(a !== b, m);
assert.deepEqual = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m);
export default assert;
export { assert as ok, assert as strict };
`,
);

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  logLevel: "info",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    assert: "./dist/.shim-assert.mjs",
    path: "./dist/.shim-node.mjs",
    fs: "./dist/.shim-node.mjs",
    os: "./dist/.shim-node.mjs",
    util: "./dist/.shim-node.mjs",
    process: "./dist/.shim-node.mjs",
  },
};

await build({ ...common, entryPoints: ["extension/content.js"], outfile: "dist/content.js" });
await build({ ...common, entryPoints: ["extension/frame.js"], outfile: "dist/frame.js" });
await build({ ...common, entryPoints: ["extension/md-main.js"], outfile: "dist/md-main.js" });
await build({ ...common, entryPoints: ["extension/background.js"], outfile: "dist/background.js" });

console.log("built → dist/  (load the project root as an unpacked extension)");

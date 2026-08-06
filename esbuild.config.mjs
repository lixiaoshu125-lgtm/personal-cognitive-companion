import esbuild from "esbuild";
import builtinModules from "builtin-modules";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", ...builtinModules],
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  sourcemap: false,
  logLevel: "info"
});

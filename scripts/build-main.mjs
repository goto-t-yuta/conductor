import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const watch = process.argv.includes("--watch");

const commonConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node-pty"],
};

async function run() {
  const mainCtx = await esbuild.context({
    ...commonConfig,
    entryPoints: [path.join(rootDir, "src/main/index.ts")],
    outfile: path.join(rootDir, "dist/main/index.cjs"),
  });

  const preloadCtx = await esbuild.context({
    ...commonConfig,
    entryPoints: [path.join(rootDir, "src/preload/index.ts")],
    outfile: path.join(rootDir, "dist/preload/index.cjs"),
  });

  if (watch) {
    await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
    console.log("[build-main] watching...");
  } else {
    await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
    await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
    console.log("[build-main] built dist/main/index.cjs and dist/preload/index.cjs");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

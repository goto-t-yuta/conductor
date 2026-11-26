import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const watch = process.argv.includes("--watch");

function resolveBuildMetadata() {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch {
    // ignore
  }

  let commitSha = "";
  const envSha = (process.env.GITHUB_SHA || process.env.CONDUCTOR_BUILD_SHA || "").trim();
  if (/^[0-9a-f]{7,40}$/i.test(envSha)) {
    commitSha = envSha.slice(0, 7).toLowerCase();
  } else {
    try {
      const gitSha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (/^[0-9a-f]{7,40}$/i.test(gitSha)) {
        commitSha = gitSha.slice(0, 7).toLowerCase();
      }
    } catch {
      // git not available
    }
  }

  const rawRunNumber = (
    process.env.GITHUB_RUN_NUMBER ||
    process.env.CONDUCTOR_BUILD_RUN_NUMBER ||
    ""
  ).trim();
  const runNumber = /^\d+$/.test(rawRunNumber) ? rawRunNumber : "";

  const explicitTag = (process.env.CONDUCTOR_BUILD_TAG || "").trim();
  const buildTag =
    explicitTag || (runNumber && commitSha ? `v${version}-${runNumber}-${commitSha}` : "");

  return { version, commitSha, runNumber, buildTag };
}

const buildMeta = resolveBuildMetadata();

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
    define: {
      "process.env.CONDUCTOR_BUILD_VERSION": JSON.stringify(buildMeta.version),
      "process.env.CONDUCTOR_BUILD_SHA": JSON.stringify(buildMeta.commitSha),
      "process.env.CONDUCTOR_BUILD_RUN_NUMBER": JSON.stringify(buildMeta.runNumber),
      "process.env.CONDUCTOR_BUILD_TAG": JSON.stringify(buildMeta.buildTag),
    },
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

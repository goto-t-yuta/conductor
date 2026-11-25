import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  // Build main + preload once first
  await new Promise((resolve, reject) => {
    const build = spawn("node", ["scripts/build-main.mjs"], { cwd: rootDir, stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-main failed (${code})`))));
  });

  const vite = spawn("pnpm", ["exec", "vite"], { cwd: rootDir, stdio: "inherit" });
  const watchMain = spawn("node", ["scripts/build-main.mjs", "--watch"], { cwd: rootDir, stdio: "inherit" });

  await waitForServer("http://127.0.0.1:5179");

  const electronBin = path.join(rootDir, "node_modules/.bin/electron");
  const electronProc = spawn(electronBin, ["."], {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CONDUCTOR_DEV_SERVER_URL: "http://127.0.0.1:5179",
    },
  });

  const cleanup = () => {
    vite.kill();
    watchMain.kill();
    electronProc.kill();
  };

  electronProc.on("exit", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

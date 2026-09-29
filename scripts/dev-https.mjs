import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");

// mkcert otherwise probes JAVA_HOME and may fail to write Java's protected
// cacerts store after successfully trusting the certificate in Windows.
// Next treats that failure as a reason to silently start over HTTP.
const child = spawn(
  process.execPath,
  [nextCli, "dev", "--experimental-https", ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(process.platform === "win32" ? { TRUST_STORES: "system" } : {}),
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("Unable to start the HTTPS dev server:", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});

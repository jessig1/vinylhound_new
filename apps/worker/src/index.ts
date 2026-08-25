const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

function shutdown(signal: (typeof shutdownSignals)[number]) {
  console.info(`[worker] received ${signal}; shutting down cleanly`);
  process.exitCode = 0;
}

for (const signal of shutdownSignals) {
  process.once(signal, () => shutdown(signal));
}

console.info(
  "[worker] VinylHound worker scaffold is ready; queue wiring is the next slice.",
);

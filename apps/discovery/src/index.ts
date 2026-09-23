import { loadDiscoveryServiceConfig } from "@vinylhound/config";

import { createDiscoveryServiceContext } from "./context.ts";
import { createRoutes } from "./routes.ts";
import { createDiscoveryServiceServer } from "./server.ts";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

const config = loadDiscoveryServiceConfig();
const context = createDiscoveryServiceContext(config);
const routes = createRoutes(context);
const server = createDiscoveryServiceServer(routes);

server.listen(config.DISCOVERY_SERVICE_PORT, () => {
  console.info("[discovery] started", {
    port: config.DISCOVERY_SERVICE_PORT,
    deploymentVersion: config.DEPLOYMENT_VERSION,
    environmentName: config.ENVIRONMENT_NAME,
    discoveryConfigured: context.discovery !== null,
    // P4.3 Task 4 independent-delivery marker: confirms a discovery-only
    // redeploy reached this service without a web/worker rebuild.
    independentDeliveryMarker: "p4.3-task4",
  });
});

async function shutdown(signal: (typeof shutdownSignals)[number]) {
  console.info(`[discovery] received ${signal}; shutting down cleanly`);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  console.info("[discovery] shutdown complete");
}

for (const signal of shutdownSignals) {
  process.once(signal, () => void shutdown(signal));
}

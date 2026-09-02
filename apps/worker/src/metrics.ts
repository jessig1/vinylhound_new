import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

import type { QueueWorkerConfig } from "@vinylhound/config";
import type { ScanQueue } from "@vinylhound/queue";

export function startQueueMetricsPublisher(
  queue: ScanQueue,
  config: QueueWorkerConfig,
) {
  if (!config.CLOUDWATCH_METRICS_ENABLED) {
    return { close: async () => undefined };
  }

  const client = new CloudWatchClient({});
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  async function publish() {
    try {
      const state = await queue.getOperationalState();
      const dimensions = [
        { Name: "Environment", Value: config.ENVIRONMENT_NAME },
      ];
      await client.send(
        new PutMetricDataCommand({
          Namespace: config.CLOUDWATCH_METRIC_NAMESPACE,
          MetricData: [
            {
              MetricName: "QueuePendingJobs",
              Unit: "Count",
              Value: state.waiting + state.active + state.delayed,
              Dimensions: dimensions,
            },
            {
              MetricName: "QueueOldestAgeSeconds",
              Unit: "Seconds",
              Value: state.oldestWaitingAgeSeconds,
              Dimensions: dimensions,
            },
            {
              MetricName: "QueueFailedJobs",
              Unit: "Count",
              Value: state.failed,
              Dimensions: dimensions,
            },
          ],
        }),
      );
    } catch (error) {
      console.error("[worker] queue metrics publication failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      if (!stopping) {
        timer = setTimeout(
          () => void publish(),
          config.CLOUDWATCH_METRICS_INTERVAL_MS,
        );
      }
    }
  }

  void publish();

  return {
    async close() {
      stopping = true;
      if (timer) clearTimeout(timer);
      client.destroy();
    },
  };
}

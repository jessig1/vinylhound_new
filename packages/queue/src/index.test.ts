import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";

import { createSqsScanQueue, parseSqsAnalyzeScanMessage } from "./index.ts";

const job = {
  jobVersion: 1 as const,
  scanId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  attemptNumber: 1,
  imageIds: ["00000000-0000-4000-8000-000000000003"],
  requestedAt: "2026-09-03T20:00:00.000Z",
};

describe("SQS scan queue", () => {
  it("encodes a FIFO message with stable deduplication and grouping IDs", async () => {
    const send = vi.fn(async (command: unknown) => {
      void command;
      return {};
    });
    const destroy = vi.fn();
    const client = { send, destroy } as unknown as SQSClient;
    const queue = createSqsScanQueue({
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123/scans.fifo",
      client,
    });

    await expect(queue.enqueueAnalyzeScan(job, "outbox-1")).resolves.toEqual({
      jobId: "outbox-1",
    });

    const command = send.mock.calls[0]![0] as SendMessageCommand;
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toMatchObject({
      MessageGroupId: job.scanId,
      MessageDeduplicationId: "outbox-1",
    });
    expect(JSON.parse(command.input.MessageBody!)).toEqual({
      idempotencyKey: "outbox-1",
      job,
    });

    await queue.close();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("maps source and dead-letter queue attributes to operational state", async () => {
    const send = vi.fn(async (command: GetQueueAttributesCommand) => ({
      Attributes: command.input.QueueUrl?.endsWith("dlq.fifo")
        ? { ApproximateNumberOfMessages: "2" }
        : {
            ApproximateNumberOfMessages: "3",
            ApproximateNumberOfMessagesNotVisible: "1",
            ApproximateNumberOfMessagesDelayed: "4",
          },
    }));
    const queue = createSqsScanQueue({
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123/scans.fifo",
      deadLetterQueueUrl:
        "https://sqs.us-east-1.amazonaws.com/123/scans-dlq.fifo",
      client: { send, destroy: vi.fn() } as unknown as SQSClient,
    });

    await expect(queue.getOperationalState()).resolves.toEqual({
      waiting: 3,
      active: 1,
      delayed: 4,
      failed: 2,
      oldestWaitingAgeSeconds: 0,
    });
    expect(send.mock.calls.map(([command]) => command)).toSatisfy(
      (commands: unknown[]) =>
        commands.every(
          (command) => command instanceof GetQueueAttributesCommand,
        ),
    );
  });

  it("parses and validates an analysis message", () => {
    expect(
      parseSqsAnalyzeScanMessage(
        JSON.stringify({ idempotencyKey: "outbox-1", job }),
      ),
    ).toEqual({ idempotencyKey: "outbox-1", job });

    expect(() =>
      parseSqsAnalyzeScanMessage(
        JSON.stringify({ job: { ...job, scanId: "bad" } }),
      ),
    ).toThrow();
  });
});

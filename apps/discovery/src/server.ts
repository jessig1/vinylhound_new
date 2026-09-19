import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { dispatch, type DiscoveryServiceRoutes } from "./routes.ts";

/**
 * Bridges Node's raw `http` request/response to the Fetch API `Request`/
 * `Response` objects every handler in this app is written against — the
 * same contract `apps/web`'s Next.js routes use, so route logic reads the
 * same way in both apps. Node 22 ships `Request`/`Response`/`Headers`
 * globally (undici), so no extra dependency is needed for this.
 */
function toFetchRequest(
  request: IncomingMessage,
  host: string,
): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : Buffer.concat(chunks);
      resolve(
        new Request(new URL(request.url ?? "/", `http://${host}`), {
          method: request.method,
          headers,
          body,
        }),
      );
    });
    request.on("error", reject);
  });
}

async function writeFetchResponse(
  response: Response,
  serverResponse: ServerResponse,
) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  serverResponse.writeHead(response.status, headers);
  const body = response.body ? await response.arrayBuffer() : null;
  serverResponse.end(body ? Buffer.from(body) : undefined);
}

export function createDiscoveryServiceServer(routes: DiscoveryServiceRoutes) {
  return createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const request = await toFetchRequest(
          incoming,
          incoming.headers.host ?? "localhost",
        );
        const response = await dispatch(request, routes);
        await writeFetchResponse(response, outgoing);
      } catch (error) {
        console.error("[discovery] request handling failed", {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        });
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "The request could not be completed.",
            },
          }),
        );
      }
    })();
  });
}

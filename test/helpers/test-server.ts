import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** The request body exactly as received, for binary uploads. */
  rawBody: Buffer;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void;

/** A tiny local http server for client tests. No real network, no mocking library. */
export class TestServer {
  private server: Server;
  readonly requests: RecordedRequest[] = [];
  private handlers: Handler[];
  baseUrl = "";

  constructor(handlers: Handler[]) {
    this.handlers = [...handlers];
    this.server = createServer((req, res) => this.handle(req, res));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const raw = rawBody.toString("utf-8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body,
        rawBody
      };
      this.requests.push(recorded);

      const handler = this.handlers.shift();
      if (!handler) {
        res.writeHead(500).end(JSON.stringify({ error: "no more handlers queued" }));
        return;
      }
      handler(recorded, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address && typeof address === "object") {
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function jsonHandler(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(body));
  };
}

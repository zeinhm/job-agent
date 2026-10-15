import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Db } from "@job-agent/core";
import { createApp, type AppOptions } from "./app.ts";
import { LOOPBACK } from "./guards.ts";

export interface RunningServer {
  port: number;
  /** Address the socket is actually bound to (always 127.0.0.1). */
  address: string;
  close: () => Promise<void>;
}

// The hostname is fixed: no option, flag or env var binds another interface.
export function startServer(
  db: Db,
  opts: { port: number } & Omit<AppOptions, "port">,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    let bound = opts.port;
    const app = createApp(db, { ...opts, port: () => bound });
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: LOOPBACK }, (info) => {
      bound = info.port;
      const addr = server.address() as AddressInfo;
      resolve({
        port: info.port,
        address: addr.address,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as HttpServer).closeAllConnections();
          }),
      });
    });
    server.once("error", reject);
  });
}

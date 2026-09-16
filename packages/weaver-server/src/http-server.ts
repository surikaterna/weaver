import type { AddressInfo, Socket } from "node:net";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { httpStatusForError } from "./types/errors";

type RequestHandler = (request: Request, response: Response) => Promise<void>;

export interface HttpServer {
  readonly port: number;
  stop(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonParseError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.status === 400 && error.type === "entity.parse.failed";
}

function sendClientError(error: unknown, res: Response): boolean {
  if (!(error instanceof WeaverErrorInstance)) return false;
  const status = httpStatusForError(error.code);
  if (status < 400) return false;
  res.status(status).json({
    error: { code: error.code, message: error.message },
  });
  return true;
}

export async function startHttpServer(options: {
  port: number;
  handleRequest: RequestHandler;
}): Promise<HttpServer> {
  const app = express();
  app.set("trust proxy", "loopback");

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(async (req, res, next) => {
    try {
      await options.handleRequest(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (isJsonParseError(error)) {
        res.status(400).json({ error: "invalid request body" });
        return;
      }
      if (sendClientError(error, res)) return;

      res.status(500).json({ error: "internal server error" });
    },
  );

  const server = await new Promise<ReturnType<typeof app.listen>>(
    (resolve, reject) => {
      const httpServer = app.listen(options.port, () => {
        httpServer.off("error", reject);
        resolve(httpServer);
      });
      httpServer.once("error", reject);
    },
  );

  const address = server.address() as AddressInfo | null;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    port: address?.port ?? options.port,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });

        server.closeAllConnections?.();
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}

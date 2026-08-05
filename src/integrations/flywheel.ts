export type FlywheelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FlywheelClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FlywheelFetch;
}

export interface FlywheelEvent {
  [key: string]: unknown;
}

export class FlywheelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FlywheelError";
  }
}

/** Dependency-free Connect/JSON client for Marina's Flywheel integration. */
export class FlywheelClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FlywheelFetch;

  constructor(options: FlywheelClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  createSession(): Promise<{ sessionId: string }> {
    return this.unary("CreateSession", {});
  }

  mintCapability(input: {
    scopes: string[];
    sessionId: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresAt: string }> {
    return this.unary("MintCapability", input);
  }

  createSandbox(input: {
    sessionId: string;
    image: string;
    keepAlive?: boolean;
  }): Promise<{ sandboxId: string; keepAlive: boolean }> {
    return this.unary("CreateSandbox", input);
  }

  publish(input: { sessionId: string; sandboxId: string; port: number }): Promise<{ url: string }> {
    return this.unary("Publish", input);
  }

  hibernate(input: { sessionId: string; sandboxId: string }): Promise<Record<string, never>> {
    return this.unary("Hibernate", input);
  }

  resume(input: { sessionId: string; sandboxId: string }): Promise<Record<string, never>> {
    return this.unary("Resume", input);
  }

  stopSandbox(input: { sessionId: string; sandboxId: string }): Promise<Record<string, never>> {
    return this.unary("StopSandbox", input);
  }

  async *exec(input: {
    sessionId: string;
    sandboxId: string;
    command: string;
    args?: string[];
    cwd?: string;
  }): AsyncGenerator<FlywheelEvent> {
    const response = await this.fetchImpl(this.url("Exec"), {
      method: "POST",
      headers: this.headers("application/connect+json"),
      body: envelope(input),
    });
    if (!response.ok) await this.throwResponse(response);
    if (!response.body) throw new FlywheelError("Flywheel returned an empty stream", 502);

    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for await (const chunk of response.body) {
      pending = concat(pending, chunk);
      while (pending.length >= 5) {
        const length = new DataView(pending.buffer, pending.byteOffset + 1, 4).getUint32(0);
        if (pending.length < length + 5) break;
        const flags = pending[0]!;
        const payload = pending.slice(5, length + 5);
        pending = pending.slice(length + 5);
        const message = JSON.parse(new TextDecoder().decode(payload));
        if ((flags & 0x02) !== 0) {
          if (message.error) {
            throw new FlywheelError(
              message.error.message ?? "Flywheel stream failed",
              502,
              message.error.code,
            );
          }
          return;
        }
        yield message as FlywheelEvent;
      }
    }
    if (pending.length !== 0) throw new FlywheelError("Flywheel returned a truncated stream", 502);
  }

  private async unary<T>(method: string, input: object): Promise<T> {
    const response = await this.fetchImpl(this.url(method), {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(input),
    });
    if (!response.ok) await this.throwResponse(response);
    return (await response.json()) as T;
  }

  private url(method: string): string {
    return `${this.baseUrl}/flywheel.v1.APIService/${method}`;
  }

  private headers(contentType: string): HeadersInit {
    return {
      authorization: `Bearer ${this.token}`,
      "connect-protocol-version": "1",
      "content-type": contentType,
    };
  }

  private async throwResponse(response: Response): Promise<never> {
    let body: { message?: string; code?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Preserve the HTTP status when an intermediary returns a non-JSON body.
    }
    throw new FlywheelError(
      body.message ?? `Flywheel request failed (${response.status})`,
      response.status,
      body.code,
    );
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function envelope(value: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(payload.length + 5);
  new DataView(result.buffer).setUint32(1, payload.length);
  result.set(payload, 5);
  return result;
}

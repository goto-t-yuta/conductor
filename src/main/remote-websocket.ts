import crypto from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_WRITE_BACKPRESSURE_BYTES = 2 * 1024 * 1024; // 2 MiB

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface WebSocketConnectionHandlers {
  onMessage?: (text: string) => void;
  onClose?: (code: number, reason: string) => void;
  onPong?: () => void;
  onError?: (err: Error) => void;
}

export function computeWebSocketAcceptKey(secWebSocketKey: string): string {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey.trim() + WS_GUID, "utf8")
    .digest("base64");
}

export function writeHttpUpgradeError(
  socket: Duplex,
  statusCode: number,
  statusText: string,
  body?: string,
): void {
  socket.on("error", () => {
    // ignore socket reset while flushing HTTP upgrade error
  });
  const payload = body ?? JSON.stringify({ ok: false, error: statusText });
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const response =
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${payloadBytes}\r\n` +
    `Connection: close\r\n\r\n` +
    payload;
  try {
    socket.end(response);
  } catch {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
}

export function encodeWebSocketFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return len === 0 ? header : Buffer.concat([header, payload]);
}

/**
 * Lightweight RFC 6455 server-side WebSocket connection using Node.js built-ins.
 */
export class RemoteWebSocketConnection {
  private readonly socket: Duplex;
  private readonly handlers: WebSocketConnectionHandlers;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private fragmentedOpcode: number | null = null;
  private fragmentedChunks: Buffer[] = [];
  private fragmentedLength = 0;
  private closed = false;
  private closeFrameSent = false;

  private readonly onDataBound: (chunk: Buffer) => void;
  private readonly onEndBound: () => void;
  private readonly onCloseBound: () => void;
  private readonly onErrorBound: (err: Error) => void;

  private constructor(socket: Duplex, handlers: WebSocketConnectionHandlers) {
    this.socket = socket;
    this.handlers = handlers;

    this.onDataBound = (chunk: Buffer) => this.handleIncomingChunk(chunk);
    this.onEndBound = () => this.finishClose(1006, "Connection ended");
    this.onCloseBound = () => this.finishClose(1006, "Connection closed");
    this.onErrorBound = (err: Error) => {
      this.handlers.onError?.(err);
      this.finishClose(1006, err.message || "Socket error");
    };

    socket.on("data", this.onDataBound);
    socket.on("end", this.onEndBound);
    socket.on("close", this.onCloseBound);
    socket.on("error", this.onErrorBound);
  }

  static acceptUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    handlers: WebSocketConnectionHandlers = {},
  ): RemoteWebSocketConnection | null {
    const upgradeHeader = String(req.headers.upgrade ?? "").toLowerCase();
    const secKey = typeof req.headers["sec-websocket-key"] === "string"
      ? req.headers["sec-websocket-key"].trim()
      : "";

    if (upgradeHeader !== "websocket" || !secKey) {
      writeHttpUpgradeError(socket, 400, "Bad Request", JSON.stringify({ ok: false, error: "Invalid WebSocket upgrade request" }));
      return null;
    }

    const acceptKey = computeWebSocketAcceptKey(secKey);
    const responseHeaders =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`;

    try {
      const netSocket = socket as Duplex & {
        setNoDelay?: (noDelay?: boolean) => void;
        setKeepAlive?: (enable?: boolean, initialDelay?: number) => void;
        setTimeout?: (timeout: number) => void;
      };
      netSocket.setNoDelay?.(true);
      netSocket.setKeepAlive?.(true, 20_000);
      netSocket.setTimeout?.(0);
      socket.write(responseHeaders);
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      return null;
    }

    const conn = new RemoteWebSocketConnection(socket, handlers);
    if (head && head.length > 0) {
      conn.handleIncomingChunk(head);
    }
    return conn;
  }

  public isOpen(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  public sendText(text: string): boolean {
    if (!this.isOpen()) return false;
    if (this.socket.writableLength > MAX_WRITE_BACKPRESSURE_BYTES) {
      this.close(1008, "Backpressure limit exceeded");
      return false;
    }
    try {
      const frame = encodeWebSocketFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
      this.socket.write(frame);
      return true;
    } catch {
      this.finishClose(1006, "Write failed");
      return false;
    }
  }

  public sendJson(payload: unknown): boolean {
    return this.sendText(JSON.stringify(payload));
  }

  public sendPing(data?: string): boolean {
    if (!this.isOpen()) return false;
    try {
      const payload = data ? Buffer.from(data, "utf8").subarray(0, 125) : Buffer.alloc(0);
      this.socket.write(encodeWebSocketFrame(OPCODE_PING, payload));
      return true;
    } catch {
      this.finishClose(1006, "Ping failed");
      return false;
    }
  }

  public close(code = 1000, reason = ""): void {
    if (this.closed) return;
    if (!this.closeFrameSent && !this.socket.destroyed && this.socket.writable) {
      this.closeFrameSent = true;
      try {
        const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 123);
        const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
        this.socket.end(encodeWebSocketFrame(OPCODE_CLOSE, payload));
      } catch {
        try {
          this.socket.destroy();
        } catch {
          // ignore
        }
      }
    } else {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.finishClose(code, reason);
  }

  private finishClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.receiveBuffer = Buffer.alloc(0);
    this.fragmentedChunks = [];
    this.fragmentedOpcode = null;
    this.fragmentedLength = 0;

    this.socket.off("data", this.onDataBound);
    this.socket.off("end", this.onEndBound);
    this.socket.off("close", this.onCloseBound);
    this.socket.off("error", this.onErrorBound);
    // Keep a silent error sink so late ECONNRESET packets during TCP teardown never crash the process
    this.socket.on("error", () => {});

    this.handlers.onClose?.(code, reason);
  }

  private handleIncomingChunk(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    this.receiveBuffer =
      this.receiveBuffer.length === 0 ? chunk : Buffer.concat([this.receiveBuffer, chunk]);

    while (!this.closed && this.receiveBuffer.length >= 2) {
      const byte0 = this.receiveBuffer[0];
      const byte1 = this.receiveBuffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.receiveBuffer.length < offset + 2) return;
        payloadLen = this.receiveBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.receiveBuffer.length < offset + 8) return;
        const bigLen = this.receiveBuffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
          this.close(1009, "Frame too large");
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
        this.close(1009, "Frame too large");
        return;
      }

      const maskLen = masked ? 4 : 0;
      const frameEnd = offset + maskLen + payloadLen;
      if (this.receiveBuffer.length < frameEnd) {
        return;
      }

      let payload: Buffer;
      if (masked) {
        const maskKey = this.receiveBuffer.subarray(offset, offset + 4);
        offset += 4;
        payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          payload[i] = this.receiveBuffer[offset + i] ^ maskKey[i & 3];
        }
      } else {
        payload = Buffer.from(this.receiveBuffer.subarray(offset, frameEnd));
      }

      this.receiveBuffer =
        frameEnd === this.receiveBuffer.length
          ? Buffer.alloc(0)
          : this.receiveBuffer.subarray(frameEnd);

      this.dispatchFrame(fin, opcode, payload);
    }
  }

  private dispatchFrame(fin: boolean, opcode: number, payload: Buffer): void {
    // Control frames
    if (opcode === OPCODE_PING) {
      if (this.isOpen()) {
        try {
          this.socket.write(encodeWebSocketFrame(OPCODE_PONG, payload.subarray(0, 125)));
        } catch {
          this.finishClose(1006, "Pong failed");
        }
      }
      return;
    }

    if (opcode === OPCODE_PONG) {
      this.handlers.onPong?.();
      return;
    }

    if (opcode === OPCODE_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.close(code, reason);
      return;
    }

    // Data frames (text / binary / continuation)
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (fin) {
        this.fragmentedOpcode = null;
        this.fragmentedChunks = [];
        this.fragmentedLength = 0;
        if (opcode === OPCODE_TEXT) {
          this.handlers.onMessage?.(payload.toString("utf8"));
        }
      } else {
        this.fragmentedOpcode = opcode;
        this.fragmentedChunks = [payload];
        this.fragmentedLength = payload.length;
      }
      return;
    }

    if (opcode === OPCODE_CONTINUATION) {
      if (this.fragmentedOpcode === null) {
        this.close(1002, "Unexpected continuation frame");
        return;
      }
      this.fragmentedLength += payload.length;
      if (this.fragmentedLength > MAX_MESSAGE_BYTES) {
        this.close(1009, "Message too large");
        return;
      }
      this.fragmentedChunks.push(payload);
      if (fin) {
        const merged = Buffer.concat(this.fragmentedChunks);
        const origOpcode = this.fragmentedOpcode;
        this.fragmentedOpcode = null;
        this.fragmentedChunks = [];
        this.fragmentedLength = 0;
        if (origOpcode === OPCODE_TEXT) {
          this.handlers.onMessage?.(merged.toString("utf8"));
        }
      }
      return;
    }

    this.close(1002, "Unsupported opcode");
  }
}

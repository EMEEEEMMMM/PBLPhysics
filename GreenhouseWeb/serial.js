"use strict";

(() => {
  const { LineBuffer } = globalThis.GreenhouseTelemetry;

  // No port is opened until the person using the page explicitly chooses one.
  class SerialTransport {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.port = null;
      this.writer = null;
      this.reader = null;
      this.readTask = null;
      this.closeTask = null;
      this.closing = false;
      this.disconnectEvent = (event) => {
        if (this.port && !this.closing && (event.target === this.port || event.port === this.port)) {
          this.callbacks.loss("USB 设备已拔出。");
        }
      };
    }

    static available() {
      return globalThis.isSecureContext && Boolean(navigator.serial?.requestPort);
    }

    async open(baudRate) {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate, bufferSize: 4096 });
      this.port = port;
      this.closing = false;
      this.closeTask = null;
      try {
        if (!port.readable || !port.writable) throw new Error("串口没有可用的读写流。");
        this.writer = port.writable.getWriter();
        navigator.serial.addEventListener("disconnect", this.disconnectEvent);
      } catch (error) {
        await this.close();
        throw error;
      }
    }

    listen() {
      const port = this.port;
      if (port && !this.readTask) this.readTask = this.read(port).catch((error) => {
        if (!this.closing) this.callbacks.loss(`无法读取串口（${error.name}）。请重新连接 USB。`);
      });
    }

    async read(port) {
      let faults = 0;
      while (this.port === port && !this.closing && port.readable) {
        const lines = new LineBuffer(this.callbacks.line, this.callbacks.overflow);
        const decoder = new TextDecoder();
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || this.closing) break;
            if (value?.length) {
              faults = 0;
              lines.push(decoder.decode(value, { stream: true }));
            }
          }
          break;
        } catch (error) {
          if (this.closing || !port.readable || ++faults > 4) break;
          this.callbacks.warning(`串口读取中断（${error.name}）。若持续出错，请检查波特率或 USB 线。`);
        } finally {
          reader.releaseLock();
          this.reader = null;
        }
      }
      if (!this.closing && this.port === port) this.callbacks.loss("串口读取已结束，请检查 USB 线并重新连接。");
    }

    write(text) {
      if (!this.writer || this.closing) throw new Error("串口已断开。");
      return this.writer.write(new TextEncoder().encode(text + "\n"));
    }

    close() {
      if (this.closeTask) return this.closeTask;
      if (!this.port) return Promise.resolve();
      const port = this.port;
      this.closing = true;
      this.closeTask = (async () => {
        try {
          await Promise.allSettled([this.reader?.cancel(), this.writer?.abort()]);
          await this.readTask;
        } finally {
          this.writer?.releaseLock();
          navigator.serial.removeEventListener("disconnect", this.disconnectEvent);
          this.writer = null;
          this.readTask = null;
          this.reader = null;
          this.port = null;
          try { await port.close(); } catch { /* OS may have already removed a disconnected port. */ }
        }
      })();
      return this.closeTask;
    }
  }

  globalThis.SerialTransport = SerialTransport;
})();

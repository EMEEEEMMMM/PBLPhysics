"use strict";

(() => {
  const { parseLine, parseKeyValueLine, demoSample } = globalThis.GreenhouseTelemetry;
  const IDS = ["A", "B"];
  const LOG_LIMIT = 300;
  const SAMPLE_LIMIT = 14_400;
  const boardState = () => ({
    latest: { A: null, B: null },
    mist: { A: null, B: null },
    sync: { A: true, B: true }, // State is still the firmware's estimate, never a physical readback.
    fan: null,
    target: { A: null, B: null },
    online: { A: null, B: null },
    fault: null,
  });

  function feed(profile = null) {
    return {
      profile, ready: profile === "dual", uncertain: false, single: false, pins: null, scan: null,
      state: boardState(), link: 0, points: [], logs: [], good: 0, rejected: 0, revision: 0, logRevision: 0,
    };
  }

  class GreenhouseDevice {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.mode = "live";
      this.connection = "idle";
      this.feeds = { live: feed(), demo: feed("dual") };
      this.pending = null;
      this.demoTimer = null;
      this.baud = 115200;
      this.serial = new SerialTransport({
        line: (line) => this.ingest(line),
        loss: (why) => void this.disconnect(why),
        overflow: () => {
          this.active.rejected++;
          this.log("sys", "忽略超长串口行（超过 512 字符）。");
        },
        warning: (why) => this.log("sys", why),
      });
    }

    get active() { return this.feeds[this.mode]; }
    get ids() { return this.active.profile === "school" || this.active.single ? ["A"] : IDS; }
    get canWrite() {
      return this.mode === "demo" || (this.connection === "connected" && this.active.profile === "dual" && this.active.ready);
    }
    get canProbe() {
      return this.canWrite || (this.connection === "connected" && this.active.profile !== "school");
    }

    log(kind, text, at = Date.now(), quiet = false) {
      const f = this.active;
      f.logs.push({ kind, text, time: at });
      if (f.logs.length > LOG_LIMIT) f.logs.shift();
      f.logRevision++;
      if (!quiet) this.callbacks.change();
    }

    ingest(raw, at = Date.now(), quiet = false) {
      const packet = parseLine(raw);
      if (packet.type === "blank") return;
      const f = this.active;
      this.log("rx", raw, at, true);
      switch (packet.type) {
        case "data": {
          f.profile = packet.protocol;
          f.ready = packet.protocol === "dual";
          const p = { ...packet.sample, time: at, link: f.link };
          if (p.chamber === "B") f.single = false;
          f.state.latest[p.chamber] = p;
          f.state.online[p.chamber] = true;
          f.state.fault = null;
          if (packet.protocol === "dual") {
            f.state.mist[p.chamber] = p.mist;
            f.state.fan = p.fan;
          }
          f.points.push(p);
          if (f.points.length > SAMPLE_LIMIT) f.points.shift();
          f.good++;
          f.revision++;
          if (!quiet) this.callbacks.sample(p);
          break;
        }
        case "state":
          f.profile = "dual";
          f.ready = true;
          for (const field of ["mist", "fan", "target", "online"]) f.state[field] = packet[field];
          if (packet.online.B) f.single = false;
          if (this.pending?.command.family === "STATUS") {
            f.uncertain = false; // Commands are processed in order. STATUS is the recovery barrier.
            this.settle(true);
          }
          break;
        case "event": {
          f.profile = "dual";
          f.ready = true;
          const { chamber, device, value, deviceMs, note } = packet;
          if (device === "FAN" && ["ON", "OFF"].includes(value)) f.state.fan = value === "ON";
          if (chamber !== "-") {
            if (device === "MIST") {
              if (["ON", "OFF", "SYNC_ON", "SYNC_OFF"].includes(value)) f.state.mist[chamber] = value.endsWith("ON");
              if (value === "PULSE") f.state.sync[chamber] = false;
              if (value.startsWith("SYNC_")) f.state.sync[chamber] = true;
            }
            if (device === "AUTO_RH" && (value === "OFF" || /^(?:[1-9]|[1-8]\d|9[0-5])$/.test(value))) {
              f.state.target[chamber] = value === "OFF" ? 0 : +value;
            }
            if (device === "SENSOR" && (value === "LOST" || value === "ONLINE")) {
              f.state.online[chamber] = value === "ONLINE";
              if (chamber === "B" && value === "ONLINE") f.single = false;
            }
          }
          if (!quiet) this.callbacks.event({ time: at, chamber, device, value, deviceMs, note });
          break;
        }
        case "info":
          if (/^# GreenhouseDual \S+ booting$/.test(packet.line) || packet.line === "SCD4x Example") {
            if (f.good || f.ready) {
              this.settle(false, "Arduino 已复位，命令未确认。");
              if (!quiet) this.callbacks.interrupted("Arduino 复位");
            }
            f.link++;
            f.state = boardState();
            f.pins = null;
            f.scan = null;
            f.profile = packet.line === "SCD4x Example" ? "school" : "dual";
            f.ready = false;
            f.uncertain = false;
            f.single = f.profile === "school";
          } else if (/^# TCA9548A NOT found: single-sensor mode/.test(packet.line)) {
            f.single = true;
          } else if (packet.line.startsWith("# PINS,")) {
            f.pins = parseKeyValueLine(packet.line, "# PINS,");
          } else if (packet.line.startsWith("# SCAN,")) {
            f.scan = parseKeyValueLine(packet.line, "# SCAN,");
            if (f.scan?.mux === "NONE") f.single = true;
            else if (f.scan?.mux && f.scan.mux !== "NONE") f.single = false;
          } else if (packet.line === "# ready" && f.profile === "dual") {
            f.ready = true;
          }
          if (packet.line.startsWith("# Commands (A/B optional") && this.pending?.command.family === "HELP") this.settle(true);
          break;
        case "sensor-error":
          f.profile = "school";
          f.state.fault = "未检测到 SCD40，请断电核对 I²C 接线。";
          f.state.online.A = false;
          break;
        case "ok":
          if (this.pending?.command.family === packet.command) this.settle(true);
          break;
        case "error":
          // STOP has no ERR response in GreenhouseDual; ignore an older command's error.
          if (this.pending?.command.family !== "STOP") this.settle(false, `Arduino 拒绝命令：${packet.message}`);
          break;
        case "unknown":
          f.rejected++;
          break;
      }
      if (!quiet) this.callbacks.change();
    }

    enterDemo(single = false) {
      if (this.connection !== "idle" || this.mode === "demo") return;
      this.mode = "demo";
      const f = this.feeds.demo = feed("dual");
      f.single = Boolean(single);
      f.pins = { profile: "SCHOOL_PPT", fan: "D2", mistA: "D3", mistB: "D6", i2c: "A4/A5", oled: "D13/D11/D9/D8" };
      const now = Date.now();
      Object.assign(f.state, { fan: false, mist: { A: false, B: false }, target: { A: 0, B: 0 } });
      this.demoIndex = 0;
      this.log("sys", single ? "模拟串口已开启（单传感器实验室模式），未连接物理设备。" : "模拟串口已开启，未连接物理设备。", now - 300_000, true);
      for (; this.demoIndex <= 60; this.demoIndex++) this.demoFrame(now - (60 - this.demoIndex) * 5000, true);
      f.logs = [f.logs[0], ...f.logs.slice(-6)];
      this.demoTimer = setInterval(() => {
        this.demoFrame(Date.now());
        this.demoIndex++;
      }, 5000);
      this.callbacks.change();
    }

    demoFrame(at, quiet = false) {
      const f = this.active;
      const state = f.state;
      const ids = f.single ? ["A"] : IDS;
      for (const id of ids) {
        const p = demoSample(id, this.demoIndex, at, state);
        this.ingest(`DATA,${p.deviceMs},${id},${p.co2},${p.temp.toFixed(2)},${p.rh.toFixed(1)},${+p.mist},${+p.fan}`, at, quiet);
        const target = state.target[id];
        if (target) {
          const next = p.rh < target - 2 || (p.rh < target && state.mist[id]);
          if (next !== state.mist[id]) this.ingest(`EVT,${p.deviceMs},MIST,${id},${next ? "ON" : "OFF"},SIM_AUTO`, at, quiet);
        }
      }
    }

    leaveDemo() {
      if (this.mode !== "demo") return;
      this.callbacks.interrupted("退出模拟");
      this.settle(false, "已退出模拟；未向硬件发送命令。");
      clearInterval(this.demoTimer);
      this.demoTimer = null;
      this.mode = "live";
      this.callbacks.change();
    }

    async connect(baud) {
      if (this.connection !== "idle") return;
      if (!SerialTransport.available()) {
        this.callbacks.notice("此浏览器不能访问串口。请用桌面版 Edge 或 Chrome，或用 localhost 方式打开网页。", true);
        return;
      }
      this.connection = "opening";
      this.callbacks.change();
      try {
        await this.serial.open(baud);
      } catch (e) {
        this.connection = "idle";
        const reason = e.name === "NotFoundError" ? "未选择串口。插好 USB 数据线后可再试。" :
          e.name === "SecurityError" ? "浏览器未授权串口。请从 Edge / Chrome 直接打开网页，或访问 localhost。" :
          "串口打开失败。请关闭 Arduino IDE 的串口监视器，检查 USB 线和 CH340/CH341 驱动后重试。";
        this.log("sys", `${reason} (${e.name})`);
        this.callbacks.notice(reason, e.name !== "NotFoundError");
        return;
      }
      this.leaveDemo();
      this.feeds.live = feed();
      this.baud = baud;
      this.connection = "connected";
      this.openedAt = Date.now();
      this.callbacks.notice("");
      this.log("sys", `串口已打开（${baud} baud），等待板端首帧；Nano 可能复位。`);
      this.serial.listen();
    }

    async disconnect(reason = "已手动断开串口。") {
      if (this.connection !== "connected") return;
      this.connection = "closing";
      this.settle(false, `${reason} 未确认的指令请现场核对。`);
      this.callbacks.interrupted("串口断开");
      this.log("sys", reason);
      if (reason !== "已手动断开串口。") this.callbacks.notice(reason, true);
      try {
        await this.serial.close();
      } finally {
        this.connection = "idle";
        this.callbacks.change();
      }
    }

    settle(ok, message) {
      const job = this.pending;
      if (!job) return;
      clearTimeout(job.timer);
      this.pending = null;
      const label = job.command.family === "STOP" ? "已受理全部停止请求。请现场确认风扇和雾化器；照明需手动关闭。" :
        job.command.family === "STATUS" ? "已收到 STATE 状态回报。" :
        job.command.family === "SCAN" ? `I²C 扫描完成${this.active.scan ? `（主总线：${this.active.scan.main}，多路器：${this.active.scan.mux}）` : ""}。` :
        job.command.family === "HELP" ? "已收到命令列表，见 RX 日志。" :
        `板端已受理：${job.command.text}。执行结果请见状态、事件及实物。`;
      this.callbacks.result(ok ? (this.mode === "demo" ? `模拟：${label}` : label) : message, !ok);
      if (ok && !["STATUS", "HELP", "SCAN"].includes(job.command.family)) {
        this.callbacks.event({ time: Date.now(), chamber: "-", device: "CMD", value: job.command.text, note: "OK：板端受理", deviceMs: null });
      }
      job.resolve(ok);
      this.callbacks.change();
    }

    send(command) {
      const polling = command.family === "STATUS";
      const stop = command.family === "STOP";
      if (!(polling ? this.canProbe : this.canWrite) || (this.pending && !stop)) return Promise.resolve(false);
      if (this.active.uncertain && !polling && !stop) {
        this.callbacks.result("前一条命令未确认。请先读取状态，再发送其他命令。", true);
        return Promise.resolve(false);
      }
      if (this.pending) {
        if (this.pending.command.family === "STOP") return Promise.resolve(false);
        this.active.uncertain = true;
        clearTimeout(this.pending.timer);
        this.pending.resolve(false);
        this.pending = null;
      }
      return new Promise((resolve) => {
        const job = { command, resolve };
        this.pending = job;
        job.timer = setTimeout(() => {
          if (this.pending !== job) return;
          this.active.uncertain = !["STATUS", "HELP", "SCAN"].includes(command.family) || this.active.uncertain;
          const note = `等待 ${command.family} 回应超时。请检查 RX 或读回状态，不要盲目重复开启。`;
          this.log("sys", note);
          this.settle(false, note);
        }, 4000);
        this.callbacks.result(`正在等待回应：${command.text}`, false);
        this.log("tx", command.text);
        if (this.mode === "demo") {
          setTimeout(() => { if (this.pending === job) this.demoReply(command); }, 180);
        } else {
          Promise.resolve().then(() => this.serial.write(command.text)).catch((e) => {
            if (this.pending === job) this.settle(false, `发送失败：${e.message || e.name}`);
          });
        }
      });
    }

    demoReply(command) {
      const f = this.active;
      const state = f.state;
      const ms = this.demoIndex * 5000;
      const [, first, second] = command.text.split(" ");
      const ids = IDS.includes(first) ? [first] : (f.single ? ["A"] : IDS);
      const value = second ?? first;
      const event = (device, id, val) => this.ingest(`EVT,${ms},${device},${id},${val},SIM`);
      const mist = (id, on) => { if (state.mist[id] !== on) event("MIST", id, on ? "ON" : "OFF"); };
      switch (command.family) {
        case "STATUS":
          this.ingest(`STATE,${ms},${+state.mist.A},${+state.mist.B},${+state.fan},${state.target.A},${state.target.B},1,${f.single ? 0 : 1}`);
          return;
        case "SCAN":
          this.ingest(f.single ? "# SCAN,mux=NONE,main=0x62" : "# SCAN,mux=0x70,main=0x70,CH0=0x62,CH1=0x62");
          break;
        case "HELP":
          for (const line of ["# Commands (A/B optional, default = all active chambers):", "# HELP | STATUS | SCAN | STOP",
            "# FAN ON|OFF", "# MIST [A|B] ON|OFF", "# RH [A|B] <1-95>|OFF", "# PULSE [A|B] | SYNC [A|B] ON|OFF"]) this.ingest(line);
          return;
        case "FAN": event("FAN", "-", value); break;
        case "MIST":
          for (const id of ids) {
            if (state.target[id]) event("AUTO_RH", id, "OFF");
            mist(id, value === "ON");
          }
          break;
        case "RH":
          for (const id of ids) {
            event("AUTO_RH", id, value);
            if (value === "OFF" || state.latest[id]?.rh >= +value) mist(id, false);
            else if (state.latest[id]?.rh < +value - 2) mist(id, true);
          }
          break;
        case "PULSE":
        case "SYNC":
          if (state.target[first]) event("AUTO_RH", first, "OFF");
          event("MIST", first, command.family === "PULSE" ? "PULSE" : `SYNC_${value}`);
          break;
        case "STOP":
          event("FAN", "-", "OFF");
          for (const id of IDS) {
            if (state.target[id]) event("AUTO_RH", id, "OFF");
            mist(id, false);
          }
          event("ALL", "-", "STOP");
          break;
      }
      this.ingest(`OK,${command.family}`);
    }
  }

  globalThis.GreenhouseDevice = GreenhouseDevice;
})();

"use strict";

// Pure protocol, experiment and CSV functions; shared by the page and Node tests.
(() => {
  const FRESH_MS = 15_000;
  const PAIR_MS = 8_000;
  const METRICS = {
    temp: { label: "温度", unit: "°C", decimals: 1, span: 1 },
    rh: { label: "相对湿度", unit: "%RH", decimals: 1, span: 6 },
    co2: { label: "二氧化碳", unit: "ppm", decimals: 0, span: 80 },
  };
  const CONDITIONS = { baseline: "无添加（对照）", mist: "加水雾", co2: "增加 CO₂", other: "其他条件" };
  const numberPattern = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const school = new RegExp(`^CO2\\(ppm\\):\\s*(\\d+)\\s+Temperature\\(C\\):\\s*(${numberPattern})\\s+Humidity\\(%RH\\):\\s*(${numberPattern})$`, "i");
  const numericToken = new RegExp(`^${numberPattern}$`);
  const within = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
  const integer = (v, lo, hi) => /^\d+$/.test(v ?? "") && within(Number(v), lo, hi);
  const isBit = (v) => v === "0" || v === "1";
  const chamberId = (v) => v === "A" || v === "B";
  const validSample = (co2, temp, rh) => integer(co2, 1, 65535) && numericToken.test(temp) &&
    within(Number(temp), -45, 130) && numericToken.test(rh) && within(Number(rh), 0, 100);

  function parseLine(raw) {
    const line = raw.trim();
    if (!line) return { type: "blank" };
    const legacy = school.exec(line);
    if (legacy && validSample(...legacy.slice(1))) {
      const [, co2, temp, rh] = legacy;
      return { type: "data", protocol: "school", sample: { chamber: "A", deviceMs: null, co2: +co2, temp: +temp, rh: +rh, mist: null, fan: null } };
    }
    if (line.startsWith("#") || line === "SCD4x Example") return { type: "info", line };
    if (line.startsWith("Sensor not detected")) return { type: "sensor-error", line };
    const f = line.split(",").map((part) => part.trim());
    const hasMs = integer(f[1], 0, 0xffffffff);
    if (f[0] === "DATA" && f.length === 8 && hasMs && chamberId(f[2]) &&
        validSample(f[3], f[4], f[5]) && isBit(f[6]) && isBit(f[7])) {
      return { type: "data", protocol: "dual", sample: {
        deviceMs: +f[1], chamber: f[2], co2: +f[3], temp: +f[4], rh: +f[5], mist: f[6] === "1", fan: f[7] === "1",
      } };
    }
    if (f[0] === "STATE" && f.length === 9 && hasMs && [f[2], f[3], f[4], f[7], f[8]].every(isBit) &&
        integer(f[5], 0, 95) && integer(f[6], 0, 95)) {
      return { type: "state", deviceMs: +f[1], mist: { A: f[2] === "1", B: f[3] === "1" },
        fan: f[4] === "1", target: { A: +f[5], B: +f[6] }, online: { A: f[7] === "1", B: f[8] === "1" } };
    }
    if (f[0] === "EVT" && f.length >= 5 && hasMs && /^[A-Z_]+$/.test(f[2]) && (chamberId(f[3]) || f[3] === "-") && f[4]) {
      return { type: "event", deviceMs: +f[1], device: f[2], chamber: f[3], value: f[4], note: f.slice(5).join(",") };
    }
    if (f[0] === "OK" && f.length === 2 && /^[A-Z]+$/.test(f[1])) return { type: "ok", command: f[1] };
    if (f[0] === "ERR" && f.length >= 2) return { type: "error", message: f.slice(1).join(", ") };
    return { type: "unknown", line };
  }

  function parseKeyValueLine(line, prefix) {
    if (!line.startsWith(prefix)) return null;
    const out = {};
    for (const part of line.slice(prefix.length).split(",")) {
      const idx = part.indexOf("=");
      if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return Object.keys(out).length ? out : null;
  }

  class LineBuffer {
    constructor(line, overflow, max = 512) {
      this.line = line;
      this.overflow = overflow;
      this.max = max;
      this.buffer = "";
      this.dropping = false;
    }

    push(text) {
      for (const ch of text) {
        if (ch === "\n") {
          if (!this.dropping) this.line(this.buffer.replace(/\r$/, ""));
          this.buffer = "";
          this.dropping = false;
        } else if (!this.dropping) {
          if (this.buffer.length >= this.max) {
            this.dropping = true;
            this.buffer = "";
            this.overflow();
          } else this.buffer += ch;
        }
      }
    }
  }

  function parseCommand(value) {
    if (/[^\x20-\x7e\t]/.test(value) || value.trim().length > 47) return null;
    const text = value.trim().toUpperCase().replace(/[ \t]+/g, " ");
    if (!/^(?:STATUS|HELP|SCAN|STOP|FAN (?:ON|OFF)|MIST(?: [AB])? (?:ON|OFF)|RH(?: [AB])? (?:OFF|[1-9]|[1-8]\d|9[0-5])|PULSE [AB]|SYNC [AB] (?:ON|OFF))$/.test(text)) return null;
    const family = text.split(" ", 1)[0];
    const confirm = text.endsWith(" ON") || family === "PULSE" || family === "SYNC" || (family === "RH" && !text.endsWith(" OFF"));
    return { text, family, confirm };
  }

  function fresh(sample, at) {
    return Boolean(sample && sample.time <= at && at - sample.time <= FRESH_MS);
  }

  function paired(a, b) {
    return Boolean(a && b && Math.abs(a.time - b.time) <= PAIR_MS);
  }

  // H = T + 5/9 (e - 10); e in hPa from the Magnus saturation formula and measured RH.
  function humidex(temp, rh) {
    if (!within(temp, 20, 50) || !within(rh, 0, 100)) return null;
    const e = rh / 100 * 6.112 * Math.exp(17.62 * temp / (243.12 + temp));
    return +(temp + 5 / 9 * (e - 10)).toFixed(1);
  }

  function baselineFor(latest, ids, at) {
    if (!ids.every((id) => fresh(latest[id], at))) return null;
    if (ids.length === 2 && !paired(latest.A, latest.B)) return null;
    return Object.fromEntries(ids.map((id) => [id, { ...latest[id] }]));
  }

  function resultFor(run, at) {
    const samples = {};
    for (let i = run.samples.length - 1; i >= 0; i -= 1) {
      const p = run.samples[i];
      if (!samples[p.chamber] && fresh(p, at) && p.time >= run.start) samples[p.chamber] = p;
      if (run.chambers.every((id) => samples[id])) break;
    }
    const rises = {};
    for (const id of run.chambers) {
      if (samples[id] && run.baseline[id]) rises[id] = samples[id].temp - run.baseline[id].temp;
    }
    return { samples, rises, diff: paired(samples.A, samples.B) ? rises.A - rises.B : null };
  }

  function runSummary(run, at) {
    const res = resultFor(run, at);
    const stats = {};
    for (const id of run.chambers) {
      const base = run.baseline[id];
      const list = run.samples.filter((s) => s.chamber === id);
      const temps = [base?.temp, ...list.map((s) => s.temp)].filter((v) => Number.isFinite(v));
      const rhs = list.map((s) => s.rh).filter((v) => Number.isFinite(v));
      const co2s = list.map((s) => s.co2).filter((v) => Number.isFinite(v));
      stats[id] = {
        t0: base?.temp ?? null,
        tEnd: res.samples[id]?.temp ?? null,
        rise: res.rises[id] ?? null,
        tMax: temps.length ? Math.max(...temps) : null,
        avgRh: rhs.length ? rhs.reduce((a, b) => a + b, 0) / rhs.length : base?.rh ?? null,
        avgCo2: co2s.length ? Math.round(co2s.reduce((a, b) => a + b, 0) / co2s.length) : base?.co2 ?? null,
        count: list.length,
      };
    }
    return { ...res, stats };
  }

  function iso(time) {
    return time == null ? "" : new Date(time).toISOString();
  }

  function csvCell(input) {
    if (input == null) return "";
    if (typeof input === "boolean") return input ? "1" : "0";
    if (typeof input === "number") return String(input);
    // Spreadsheet CSV can execute leading formula characters even inside a quoted cell.
    let text = String(input);
    if (/^\s*[=+\-@\t\r\n]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function runsCsv(runs) {
    const rows = [[
      "run_id", "source", "firmware", "condition", "setting", "run_outcome", "planned_duration_min", "run_start_utc",
      "run_end_utc", "ambient_temp_C", "ambient_rh_pct", "row_type", "timestamp_utc", "elapsed_s", "device_ms", "chamber",
      "co2_ppm", "temp_C", "rh_pct", "mist_board_state", "fan_board_state", "baseline_temp_C", "delta_temp_C",
      "delta_A_minus_B_C", "event_device", "event_value", "event_note", "humidex",
    ]];
    for (const run of runs) {
      const fields = [run.id, run.source, run.protocol, CONDITIONS[run.condition], run.setting, run.reason ?? "记录中",
        run.minutes, iso(run.start), iso(run.end), run.ambient.temp, run.ambient.rh];
      const at = run.end ?? Date.now();
      const result = resultFor(run, at);
      const sampleRow = (kind, p, diff = null) => [
        ...fields, kind, iso(p.time), (p.time - run.start) / 1000, p.deviceMs, p.chamber, p.co2, p.temp,
        p.rh, p.mist, p.fan, run.baseline[p.chamber]?.temp, +(p.temp - run.baseline[p.chamber].temp).toFixed(3), diff,
        null, null, null, humidex(p.temp, p.rh),
      ];
      const frames = [
        ...Object.values(run.baseline).map((p) => [p.time, sampleRow("BASELINE", p)]),
        ...run.samples.map((p) => [p.time, sampleRow("SAMPLE", p)]),
        ...run.events.map((e) => [e.time, [...fields, "EVENT", iso(e.time), (e.time - run.start) / 1000,
          e.deviceMs, e.chamber, null, null, null, null, null, null, null, null, e.device, e.value, e.note]]),
      ].sort((a, b) => a[0] - b[0]);
      rows.push(...frames.map(([, row]) => row));
      if (run.end != null) {
        for (const id of run.chambers) {
          if (result.samples[id]) rows.push(sampleRow("END_SAMPLE", result.samples[id]));
        }
        rows.push([...fields, "RUN_SUMMARY", iso(run.end), (run.end - run.start) / 1000, null, null, null, null, null,
          null, null, null, null, result.diff == null ? null : +result.diff.toFixed(3)]);
      }
    }
    return "\uFEFF" + rows.map((r) => Array.from({ length: rows[0].length }, (_, i) => csvCell(r[i])).join(",")).join("\r\n") + "\r\n";
  }

  function demoSample(chamber, index, time, state) {
    const isA = chamber === "A";
    const offset = isA ? 0 : .8;
    const t = index * 5;
    const temp = (isA ? 23.7 : 23.5) + (isA ? 3.1 : 4.75) * (1 - Math.exp(-t / (isA ? 137 : 152))) +
      Math.sin(index * .29 + offset) * .11 + Math.sin(index * 1.73) * .051;
    const rh = Math.min(98, (isA ? 74.6 : 60.0) - 6.2 * (1 - Math.exp(-t / 180)) + 1.4 * Math.sin(index / 7 + offset) + (state.mist[chamber] ? 2.4 : 0));
    const co2 = Math.round((isA ? 810 : 760) + Math.sin(.12 * index + offset) * 44 + Math.sin(.69 * index) * 7 + 63 * (1 - Math.exp(-t / 185)));
    return { chamber, deviceMs: index * 5000, time, temp: +temp.toFixed(2), rh: +rh.toFixed(1), co2, mist: state.mist[chamber], fan: state.fan };
  }

  const api = {
    FRESH_MS, PAIR_MS, CONDITIONS, METRICS, parseLine, parseKeyValueLine, LineBuffer,
    parseCommand, fresh, paired, baselineFor, resultFor, runSummary, runsCsv, demoSample, humidex,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.GreenhouseTelemetry = api;
})();

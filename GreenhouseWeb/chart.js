"use strict";

(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const localeTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const minuteTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const { METRICS, PAIR_MS } = globalThis.GreenhouseTelemetry;
  let nextId = 0;
  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

  function node(tag, attrs = {}, content = null) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (content !== null) el.textContent = content;
    return el;
  }

  function axis(points, key) {
    const metric = METRICS[key];
    const values = points.map((p) => p[key]).filter(Number.isFinite);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : metric.span;
    const middle = (min + max) / 2;
    const span = Math.max(metric.span, (max - min) * 1.16);
    const step0 = span / 4;
    const order = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((v) => v * order).find((v) => v >= step0);
    const lo = Math.floor((middle - span / 2) / step) * step;
    const hi = Math.ceil((middle + span / 2) / step) * step;
    return { lo, hi, step };
  }

  function timeLabel(time, start, showSeconds) {
    if (start == null) return (showSeconds ? localeTime : minuteTime).format(time);
    const elapsed = Math.round((time - start) / 1000);
    const magnitude = Math.abs(elapsed);
    return `${elapsed < 0 ? "−" : ""}${Math.floor(magnitude / 60)}:${String(magnitude % 60).padStart(2, "0")}`;
  }

  function eventTitle(event) {
    if (event.device === "LIGHT") return event.value === "ON" ? "开灯" : "关灯";
    if (event.device === "MIST") return "雾化";
    return "备注";
  }

  function paths(series, x, y) {
    const segments = [];
    for (const point of series) {
      const last = segments.at(-1);
      if (!last || last.at(-1).point.time + 18_000 < point.time || last.at(-1).point.link !== point.link) {
        segments.push([]);
      }
      segments.at(-1).push({ x: x(point.time), y: y(point), point });
    }
    return segments;
  }

  class ClimateChart {
    constructor(host) {
      this.host = host;
      this.id = `climate-${++nextId}`;
      this.model = null;
      this.tipTime = null;
      this.hoverPoints = [];
      this.tip = document.createElement("div");
      this.tip.className = "chart-tip";
      this.tip.hidden = true;
      this.sr = document.createElement("span");
      this.sr.className = "sr-only";
      this.sr.setAttribute("role", "status");
      host.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch" || !this.project) return;
        const rect = host.getBoundingClientRect();
        this.displayTip(this.project.unx(e.clientX - rect.left));
      });
      host.addEventListener("pointerleave", () => this.clearTip());
      host.addEventListener("click", (e) => {
        if (e.pointerType !== "touch" || !this.project) return;
        this.displayTip(this.project.unx(e.clientX - host.getBoundingClientRect().left));
      });
      host.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.clearTip();
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || !this.hoverPoints.length) return;
        e.preventDefault();
        const ts = this.hoverPoints;
        const current = ts.indexOf(this.tipTime);
        const next = e.key === "Home" ? 0 : e.key === "End" ? ts.length - 1 :
          current === -1 ? ts.length - 1 : clamp(current + (e.key === "ArrowLeft" ? -1 : 1), 0, ts.length - 1);
        this.displayTip(ts[next], true);
      });
      host.addEventListener("blur", () => this.clearTip());
      new ResizeObserver(() => this.draw()).observe(host);
    }

    set(model) {
      const old = this.model;
      if (old?.key === model.key && old?.points === model.points && old?.events === model.events &&
          old?.revision === model.revision && old?.from === model.from && old?.to === model.to &&
          old?.empty === model.empty && old?.source === model.source &&
          old?.compare?.id === model.compare?.id && old?.compare?.points?.length === model.compare?.points?.length) return;
      if (old?.key !== model.key) this.clearTip();
      this.model = model;
      this.draw();
    }

    palette(forExport = false) {
      if (forExport) {
        return {
          panel: "#ffffff",
          "plot-grid": "#d7dee2",
          ink: "#162126",
          muted: "#54646c",
          a: "#0d826c",
          b: "#c15824",
          compare: "#5c6bc0",
          "a-inset": "#e6f5f1",
          font: getComputedStyle(this.host).getPropertyValue("--font").trim() || "sans-serif",
        };
      }
      const css = getComputedStyle(this.host);
      return Object.fromEntries(
        ["panel", "plot-grid", "ink", "muted", "a", "b", "compare", "a-inset", "font"]
          .map((k) => [k, css.getPropertyValue(`--${k}`).trim()])
      );
    }

    draw() {
      if (!this.model || !this.host.clientWidth) return;
      const chart = this.build(this.host.clientWidth, this.host.clientHeight, false);
      chart.setAttribute("aria-hidden", "true");
      this.host.replaceChildren(chart, this.tip, this.sr);
      if (this.tipTime !== null && this.hoverPoints.includes(this.tipTime)) this.displayTip(this.tipTime);
      else this.clearTip();
    }

    build(width, height, forExport) {
      const m = this.model;
      const colors = this.palette(forExport);
      const d = METRICS[m.key];
      const latest = m.points.at(-1)?.time ?? Date.now();
      const cmpPoints = (m.compare && m.start != null)
        ? m.compare.points.map((p) => ({ ...p, time: m.start + (p.time - m.compare.start) }))
        : [];
      const t1 = Math.max(m.to ?? latest, cmpPoints.at(-1)?.time ?? 0);
      const t0 = m.from ?? Math.min(m.points[0]?.time ?? t1, t1 - 30_000);
      const end = Math.max(t0 + 1000, t1);
      const points = m.points.filter((p) => p.time >= t0 && p.time <= end);
      const cmpFiltered = cmpPoints.filter((p) => p.time >= t0 && p.time <= end);
      const aPoints = points.filter((p) => p.chamber === "A");
      const bPoints = points.filter((p) => p.chamber === "B");
      const compact = width < 560;
      const pad = { left: compact ? 48 : 58, right: compact ? 14 : 24, top: forExport ? 88 : 28, bottom: height - (forExport ? 50 : 42) };
      const innerWidth = Math.max(1, width - pad.right - pad.left);
      const innerHeight = Math.max(1, pad.bottom - pad.top);
      const a = axis([...points, ...cmpFiltered], m.key);
      const x = (time) => pad.left + (time - t0) / (end - t0) * innerWidth;
      const y = (p) => pad.top + (a.hi - p[m.key]) / (a.hi - a.lo) * innerHeight;
      const unx = (px) => t0 + clamp((px - pad.left) / innerWidth, 0, 1) * (end - t0);
      const chart = node("svg", { viewBox: `0 0 ${width} ${height}`, width, height, "font-family": colors.font });
      const txt = (atX, atY, content, attrs = {}) => node("text", {
        x: atX, y: atY, fill: colors.muted, "font-size": compact ? 11.5 : 12.5, ...attrs,
      }, content);
      const add = (...els) => chart.append(...els);
      if (forExport) {
        const stamp = m.source === "demo" ? "模拟数据，不用于实验报告" : "Arduino 实测";
        const shortTitle = m.title.length > 36 ? `${m.title.slice(0, 36)}…` : m.title;
        add(node("title", {}, `${m.title}：温度随光照时间变化`),
          node("desc", {}, `${stamp}。两舱共用横轴；实线 A 舱，虚线 B 舱。`),
          node("rect", { width, height, fill: colors.panel }),
          txt(24, 30, `${shortTitle} / 舱内温度`, { "font-size": 20, fill: colors.ink, "font-weight": 600 }),
          txt(24, 55, `${stamp}   ${m.names.A ?? ""}${m.names.B ? (m.names.A ? " 实线   /   " : "") + m.names.B + " 虚线" : ""}${m.compare ? `   /   对照：${m.compare.label}` : ""}`));
      }
      add(node("rect", { x: pad.left, y: pad.top, width: innerWidth, height: innerHeight, fill: "transparent" }));
      // Keep the unit text as the first SVG text node in interactive charts.
      add(txt(pad.left, pad.top - 10, d.unit, { "font-weight": 600 }));

      const ny = (points.length || cmpFiltered.length) ? Math.round((a.hi - a.lo) / a.step) : 4;
      for (let i = 0; i <= ny; i += 1) {
        const yy = pad.top + (i / ny) * innerHeight;
        const v = a.hi - i * a.step;
        add(node("path", { d: `M${pad.left} ${yy}h${innerWidth}`, stroke: colors["plot-grid"], "stroke-width": 1, opacity: i === ny ? .95 : .72 }));
        if (points.length || cmpFiltered.length) {
          add(txt(pad.left - 9, yy + 4, String(+v.toFixed(3)), { "text-anchor": "end" }));
        }
      }
      const nx = compact ? 3 : 6;
      for (let i = 0; i <= nx; i += 1) {
        const xx = pad.left + (i / nx) * innerWidth;
        add(node("path", { d: `M${xx} ${pad.top}v${innerHeight}`, stroke: colors["plot-grid"], "stroke-width": 1, "stroke-dasharray": "2 4", opacity: .52 }));
        if (points.length || cmpFiltered.length) {
          const label = timeLabel(t0 + i / nx * (end - t0), m.start, (end - t0) / nx < 60_000);
          add(txt(xx, pad.bottom + 22, label, { "text-anchor": i === 0 ? "start" : i === nx ? "end" : "middle" }));
        }
      }
      if (forExport) add(txt(width / 2, height - 8, "距开灯（分:秒）", { "text-anchor": "middle" }));
      if (!points.length && !cmpFiltered.length) {
        const empty = width < 265 && m.empty?.length > 12 ? "等待采样" : (m.empty ?? "等待第一组采样");
        add(txt((pad.left + width - pad.right) / 2, pad.top + innerHeight / 2 + 3, empty, {
          "text-anchor": "middle", fill: colors.ink, "font-size": compact ? 14 : 15,
        }));
      }

      const defs = node("defs");
      const fills = node("g");
      const traces = node("g");
      add(defs, fills, traces);

      if (cmpFiltered.length) {
        const cmpColor = colors.compare || "#64748b";
        for (const group of paths(cmpFiltered, x, y)) {
          if (group.length > 1) {
            const line = group.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
            traces.append(node("path", {
              d: line, fill: "none", stroke: cmpColor, "stroke-width": "2",
              "stroke-dasharray": "5 4", "stroke-linecap": "round", opacity: ".88",
            }));
          }
          const last = group.at(-1);
          if (group.length === 1 || last.point === cmpFiltered.at(-1)) {
            traces.append(node("circle", { cx: last.x, cy: last.y, r: 3.5, fill: cmpColor, stroke: colors.panel, "stroke-width": 1.2 }));
          }
        }
      }

      for (const [channel, series] of [["A", aPoints], ["B", bPoints]]) {
        if (!series.length) continue;
        const color = colors[channel.toLowerCase()];
        const gradient = node("linearGradient", { id: `${this.id}-${channel}`, x1: 0, x2: 0, y1: 0, y2: 1, gradientUnits: "objectBoundingBox" });
        gradient.append(
          node("stop", { offset: "0%", "stop-color": color, "stop-opacity": channel === "A" ? .16 : .11 }),
          node("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0.01 })
        );
        defs.append(gradient);
        for (const group of paths(series, x, y)) {
          const first = group[0];
          const last = group.at(-1);
          if (group.length > 1) {
            const line = group.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
            fills.append(node("path", { d: `${line} L${last.x},${pad.bottom} L${first.x},${pad.bottom} Z`, fill: `url(#${this.id}-${channel})` }));
            const props = { d: line, fill: "none", stroke: color, "stroke-width": "2.6", "stroke-linejoin": "round", "stroke-linecap": "round" };
            if (channel === "B") props["stroke-dasharray"] = "8 5";
            traces.append(node("path", props));
          }
          if (group.length === 1 || last.point === series.at(-1)) {
            if (!forExport) {
              traces.append(node("circle", { cx: last.x, cy: last.y, r: 8, fill: color, opacity: .16 }));
            }
            if (channel === "A") traces.append(node("circle", { cx: last.x, cy: last.y, r: 4.5, fill: color, stroke: colors.panel, "stroke-width": 1.8 }));
            else traces.append(node("rect", { x: last.x - 3.8, y: last.y - 3.8, width: 7.6, height: 7.6, rx: 1.5, fill: color, stroke: colors.panel, "stroke-width": 1.8 }));
          }
        }
      }

      const marks = (m.events ?? []).filter((e) => ["LIGHT", "MIST", "NOTE"].includes(e.device) && e.time >= t0 && e.time <= end);
      let previousMark = -Infinity;
      for (const e of marks) {
        const xx = x(e.time);
        add(node("path", { d: `M${xx} ${pad.top}V${pad.bottom}`, stroke: colors.muted, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: .68 }));
        if (xx - previousMark > 56) {
          const label = eventTitle(e);
          const left = xx > width - 64;
          const badgeW = label.length * 12 + 12;
          const bx = left ? xx - badgeW - 3 : xx + 3;
          add(node("rect", { x: bx, y: pad.top + 4, width: badgeW, height: 18, rx: 5, fill: colors.panel, stroke: colors["plot-grid"], "stroke-width": 1, opacity: .94 }));
          add(txt(bx + badgeW / 2, pad.top + 16.5, label, { "text-anchor": "middle", "font-size": 11, fill: colors.ink, "font-weight": 600 }));
          previousMark = xx;
        }
      }
      if (!forExport) {
        const cursor = node("path", { stroke: colors.ink, "stroke-width": 1, "stroke-dasharray": "3 4", visibility: "hidden", opacity: .65 });
        const dotA = node("circle", { r: 4.5, fill: colors.a, stroke: colors.panel, "stroke-width": 2, visibility: "hidden" });
        const dotB = node("circle", { r: 4.5, fill: colors.b, stroke: colors.panel, "stroke-width": 2, visibility: "hidden" });
        add(cursor, dotA, dotB);
        this.project = { x, y, unx, pad, cursor, dotA, dotB, width, aPoints, bPoints, cmpFiltered };
        this.hoverPoints = [...new Set([...points, ...cmpFiltered].map((p) => p.time))].sort((l, r) => l - r);
      }
      return chart;
    }

    displayTip(time, announce = false) {
      if (!this.hoverPoints.length || !this.project) return;
      const { x, y, pad, cursor, dotA, dotB, width, aPoints, bPoints, cmpFiltered } = this.project;
      const nearest = (items, at, value) => items.reduce((best, item) =>
        best == null || Math.abs(value(item) - at) <= Math.abs(value(best) - at) ? item : best, null);
      const actual = nearest(this.hoverPoints, time, (t) => t);
      this.tipTime = actual;
      const atX = x(actual);
      cursor.setAttribute("visibility", "visible");
      cursor.setAttribute("d", `M${atX} ${pad.top}V${pad.bottom}`);
      const labels = [];
      const timeNode = document.createElement("strong");
      timeNode.textContent = timeLabel(actual, this.model.start, true);
      this.tip.replaceChildren(timeNode);

      const dotFor = { A: dotA, B: dotB };
      for (const [id, data] of [["A", aPoints], ["B", bPoints]]) {
        const dot = dotFor[id];
        if (!this.model.names[id]) {
          dot.setAttribute("visibility", "hidden");
          continue;
        }
        const point = nearest(data, actual, (p) => p.time);
        const mt = METRICS[this.model.key];
        const match = point && Math.abs(point.time - actual) <= PAIR_MS;
        if (match) {
          dot.setAttribute("cx", x(point.time));
          dot.setAttribute("cy", y(point));
          dot.setAttribute("visibility", "visible");
        } else {
          dot.setAttribute("visibility", "hidden");
        }
        const val = match ? `${point[this.model.key].toFixed(mt.decimals)} ${mt.unit}` : "缺少同期采样";
        const row = document.createElement("div");
        const label = document.createElement("span");
        label.className = `trace-${id}`;
        label.textContent = this.model.names[id];
        const reading = document.createElement("span");
        reading.textContent = val;
        labels.push(`${label.textContent} ${val}`);
        row.append(label, reading);
        this.tip.append(row);
      }

      if (this.model.compare && cmpFiltered.length) {
        const point = nearest(cmpFiltered, actual, (p) => p.time);
        const mt = METRICS[this.model.key];
        const val = point && Math.abs(point.time - actual) <= PAIR_MS ? `${point[this.model.key].toFixed(mt.decimals)} ${mt.unit}` : "—";
        const row = document.createElement("div");
        const label = document.createElement("span");
        label.className = "trace-cmp";
        label.textContent = "对照";
        const reading = document.createElement("span");
        reading.textContent = val;
        row.append(label, reading);
        this.tip.append(row);
      }

      this.tip.style.left = `${clamp(atX + 12 > width - 196 ? atX - 208 : atX + 12, 0, Math.max(0, width - 196))}px`;
      this.tip.style.top = `${pad.top + 24}px`;
      this.tip.hidden = false;
      if (announce) this.sr.textContent = [timeNode.textContent, ...labels].join("，");
    }

    clearTip() {
      this.tipTime = null;
      this.tip.hidden = true;
      this.project?.cursor.setAttribute("visibility", "hidden");
      this.project?.dotA.setAttribute("visibility", "hidden");
      this.project?.dotB.setAttribute("visibility", "hidden");
      this.sr.textContent = "";
    }

    exportSvg() {
      return new XMLSerializer().serializeToString(this.build(960, 430, true));
    }
  }

  globalThis.ClimateChart = ClimateChart;
})();

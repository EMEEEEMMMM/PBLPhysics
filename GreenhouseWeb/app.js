"use strict";

(() => {
  const T = globalThis.GreenhouseTelemetry;
  const $ = (id) => document.getElementById(id);
  const put = (id, value) => { const el = $(id); if (el && el.textContent !== String(value)) el.textContent = value; };
  const show = (id, yes) => { const el = $(id); if (el) el.hidden = !yes; };
  const fmtTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const fmtDate = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const clock = (at) => at == null ? "—" : fmtTime.format(at);
  const STORE = "thermarium.runs.v1";
  const MODE = "thermarium.source";
  const THEME = "thermarium.theme";
  const SINGLE_SLOT = "thermarium.singleSlot";
  const ROOM_IDS = ["A", "B"];
  const realName = { A: "A 湿海绵", B: "B 混凝土" };
  const CONDITION_PRESETS = {
    mist: ["40 %RH", "50 %RH", "60 %RH", "70 %RH", "80 %RH"],
    co2: ["600 ppm", "1200 ppm", "2500 ppm", "4000 ppm", "6000 ppm"],
    other: ["加遮光网", "对照通风", "40% 镜面"],
  };
  const charts = { observe: new ClimateChart($("live-chart")), records: new ClimateChart($("record-chart")) };
  let route = "observe";
  let metric = "temp";
  let singleSlot = loadPref(SINGLE_SLOT) === "B" ? "B" : "A";
  let theme = loadPref(THEME) === "dark" ? "dark" : "light";
  let compareRunId = "";
  let archiveKey = "";
  let detailKey = "";
  let presetCondition = "";
  let chartCache = {};
  let logFilter = "all";
  let logFollow = true;
  let logKey = "";
  let renderRequest = null;
  let storageIssue = "";
  let observeLastFeed;
  let pendingDialog = false;
  const runRuleEdited = new Set();
  const storedRuns = { live: loadRuns(), demo: [] };
  const selected = { live: null, demo: null };
  const device = new GreenhouseDevice({
    change: scheduleRender,
    notice: notify,
    result: commandResult,
    sample: saveSample,
    event: saveEvent,
    interrupted: (reason) => finishRun(reason),
  });

  function loadPref(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function savePref(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Optional UI pref. */ }
  }

  function applyTheme(next) {
    theme = next === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b141b" : "#f4f7f6");
    const btn = $("theme-toggle");
    if (btn) {
      btn.setAttribute("aria-pressed", String(theme === "dark"));
      btn.title = theme === "dark" ? "切换到浅色实验室界面" : "切换到深色控制台界面";
      const lbl = btn.querySelector("span");
      if (lbl) lbl.textContent = theme === "dark" ? "浅色" : "深色";
    }
    savePref(THEME, theme);
    charts.observe.draw();
    charts.records.draw();
  }

  function loadRuns() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return [];
      const runs = JSON.parse(raw);
      if (!Array.isArray(runs)) throw new Error("invalid archive");
      return runs.filter((r) => r?.source === "live" && typeof r.id === "string" && Number.isFinite(r.start) &&
          Array.isArray(r.chambers) && Array.isArray(r.samples) && Array.isArray(r.events) && r.baseline && r.ambient)
        .map((r) => r.end == null ? { ...r, end: r.samples.at(-1)?.time ?? r.start, reason: "页面关闭或刷新（中断）" } : r);
    } catch {
      storageIssue = "无法读取此浏览器的实验存档。可以继续采样，结束后请导出 CSV。";
      return [];
    }
  }

  function persist() {
    if (device.mode !== "live") return;
    try {
      localStorage.setItem(STORE, JSON.stringify(storedRuns.live));
      storageIssue = "";
    } catch {
      storageIssue = "浏览器未能保存实验；本页仍保留记录，请立即导出 CSV，刷新会丢失未保存内容。";
    }
  }

  function saveSource() {
    savePref(MODE, device.mode);
  }

  function notify(text, error = false) {
    put("notice", text);
    $("notice").dataset.tone = error ? "error" : "muted";
    show("notice", Boolean(text));
  }

  function scheduleRender() {
    if (renderRequest == null) renderRequest = requestAnimationFrame(() => {
      renderRequest = null;
      render();
    });
  }

  function activeRun() { return storedRuns[device.mode].find((r) => r.end == null); }
  function openedRun() {
    const runs = storedRuns[device.mode];
    return runs.find((r) => r.id === selected[device.mode]) ?? activeRun() ?? runs.at(-1);
  }
  function unmarkedLamp() {
    return storedRuns[device.mode].findLast((r) => r.end != null && !r.events.some((e) => e.device === "LIGHT" && e.value === "OFF"));
  }
  function isSingleMode(f = device.active) {
    return f.profile === "school" || f.single;
  }
  function logicalSlot(f = device.active) {
    return isSingleMode(f) ? singleSlot : null;
  }
  function activeIds(f = device.active) {
    return isSingleMode(f) ? [singleSlot] : ROOM_IDS;
  }
  function nameFor(id, protocol) {
    if (id === "A" && protocol === "school" && singleSlot === "A") return "学校单舱";
    return realName[id];
  }
  function mapSampleForSlot(p, f = device.active) {
    if (!p) return null;
    if (isSingleMode(f) && p.chamber === "A" && singleSlot === "B") return { ...p, chamber: "B" };
    return p;
  }
  function latestForLogical(f, now) {
    if (!isSingleMode(f)) return f.state.latest;
    const p = f.state.latest.A;
    if (!p) return { A: null, B: null };
    return singleSlot === "B" ? { A: null, B: { ...p, chamber: "B" } } : { A: p, B: null };
  }

  function deadline(run) { return run.start + run.minutes * 60_000; }
  function elapsedLabel(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }
  function signed(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const str = (Math.round(Math.abs(n) * 10 + 1e-9) / 10).toFixed(1);
    return `${str === "0.0" ? "" : n < 0 ? "−" : "+"}${str} °C`;
  }

  function render() {
    const now = Date.now();
    renderHeader(now);
    if (route === "observe") renderObserve(now);
    if (route === "records") renderRecords(now);
    if (route === "debug") renderDebug();
  }

  function renderHeader(now) {
    const demo = device.mode === "demo";
    const phase = device.connection;
    const f = device.active;
    const hasRecent = device.ids.some((id) => f.state.online[id] !== false && T.fresh(f.state.latest[id], now));
    const status = demo ? ["模拟数据", "demo"] :
      phase === "connected" ? hasRecent ? ["实测数据", "good"] :
        now - device.openedAt > T.FRESH_MS ? ["等待有效数据", "warn"] : ["等待采样", "muted"] :
      ["未连接", "muted"];
    put("source-text", status[0]);
    $("demo-toggle").dataset.tone = status[1];
    $("demo-toggle").setAttribute("aria-pressed", String(demo));
    $("demo-toggle").setAttribute("aria-disabled", String(phase !== "idle" || document.body.classList.contains("presenting")));
    $("demo-toggle").setAttribute("aria-label", phase === "idle" ? `${status[0]}，${demo ? "退出模拟" : "打开模拟"}` : status[0]);
    $("demo-toggle").title = phase === "idle" ? (demo ? "退出模拟" : "打开模拟") : status[0];
    const label = { idle: "连接 Arduino", opening: "正在选择…", connected: "断开串口", closing: "正在断开…" }[phase];
    put("connect-label", label);
    $("connect").disabled = phase === "opening" || phase === "closing";
    $("connect").classList.toggle("primary", phase !== "connected");
    $("connect").classList.toggle("secondary", phase === "connected");
    put("footer-source", demo ? "模拟数据仅供演示" : `${device.baud} baud / 数据只保存在本机`);
  }

  function renderObserve(now) {
    const f = device.active;
    const demo = device.mode === "demo";
    const connected = device.connection === "connected";
    const single = isSingleMode(f);
    const school = f.profile === "school";
    const ids = activeIds(f);
    const showA = ids.includes("A");
    const showB = ids.includes("B");

    $("bay-grid").classList.toggle("single", single);
    show("bay-A", showA);
    show("bay-B", showB);
    show("single-toolbar", single || demo);
    show("single-slot-group", single);
    show("single-toolbar-note", !single && demo);
    show("demo-single-btn", demo);
    if (demo) {
      $("demo-single-btn").setAttribute("aria-pressed", String(f.single));
      put("demo-single-btn", f.single ? "切回双舱模拟" : "切换单传感器模拟");
    }
    for (const btn of document.querySelectorAll("[data-slot]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.slot === singleSlot));
    }

    put("title-A", school && singleSlot === "A" ? "学校单舱" : "湿海绵舱");
    put("sub-A", school ? "单传感器 / SCD40 (A4/A5)" : single ? "单传感接线 / SCD40 (A4/A5)" : "左舱 / SCD40 (CH0)");
    put("title-B", "混凝土舱");
    put("sub-B", single ? "单传感移测至此侧 / SCD40 (A4/A5)" : "右舱 / SCD40 (CH1)");

    show("legend-A-wrap", showA);
    show("legend-B", showB);
    show("delta-a", showA);
    show("delta-b", showB);
    show("difference-row", !single);
    show("humidex-row-A", showA);
    show("humidex-row-B", showB);
    put("humidex-label-A", school ? "单舱 Humidex" : "A 舱 Humidex");
    put("legend-A", nameFor("A", f.profile));
    put("legend-B-text", realName.B);
    $("delta-a-label").textContent = school ? "学校单舱" : "湿海绵";
    put("observe-sub", school ? "已识别学校示例程序，按单舱方式监看温度、湿度与二氧化碳。" :
      single ? `单传感器模式（当前测试：${realName[singleSlot]}）。硬件接物理 A 通道（A4/A5 · D2 风扇 · D3 雾化）。` :
      "相同光照下，比较湿海绵与混凝土的升温过程。");

    const hasBoard = connected || demo;
    for (const id of ids) {
      const physId = single ? "A" : id;
      const p = f.state.latest[physId];
      const health = demo ? ["模拟采样", "demo"] : !connected ? [p ? "上次读数" : "未连接", "muted"] :
        f.state.online[physId] === false ? ["传感器离线", "error"] : T.fresh(p, now) ? ["采样中", "good"] :
        p || now - device.openedAt > T.FRESH_MS ? ["等待新读数", "warn"] : ["等待首帧", "muted"];
      $(`bay-${id}`).dataset.fresh = String(health[1] === "good" || demo);
      $(`health-${id}`).dataset.tone = health[1];
      $(`health-${id}`).lastElementChild.textContent = health[0];
      for (const [key, meta] of Object.entries(T.METRICS)) {
        put(`${key}-${id}`, p ? p[key].toFixed(meta.decimals) : "—");
      }
      show(`co2-ext-${id}`, Boolean(p && p.co2 > 2000));
      put(`humidex-${id}`, p && (demo || (connected && f.state.online[physId] !== false && T.fresh(p, now))) ?
        (T.humidex(p.temp, p.rh)?.toFixed(1) ?? "—") : "—");

      const mistOn = hasBoard ? f.state.mist[physId] : null;
      const rhTarget = hasBoard ? f.state.target[physId] : 0;
      const mistEl = $(`bay-mist-${id}`);
      if (mistEl) {
        mistEl.textContent = f.profile === "school" ? "只读固件" :
          !hasBoard || mistOn == null ? "雾化 —" :
          !f.state.sync[physId] ? "雾化 需同步" :
          mistOn ? "雾化 开启" : "雾化 关闭";
        mistEl.dataset.active = String(Boolean(mistOn && hasBoard));
      }
      const rhEl = $(`bay-rh-${id}`);
      if (rhEl) {
        rhEl.textContent = rhTarget ? `自动 ${rhTarget}%` : "手动";
        rhEl.dataset.active = String(Boolean(rhTarget && hasBoard));
      }
    }

    const fanBadge = $("observe-fan-pill");
    if (fanBadge) {
      const fanState = f.profile === "school" ? "只读固件" :
        !hasBoard || f.state.fan == null ? "风扇 —" :
        f.state.fan ? "风扇 开启" : "风扇 关闭";
      fanBadge.textContent = fanState;
      fanBadge.dataset.active = String(Boolean(f.state.fan && hasBoard));
    }

    const chartPoints = single && singleSlot === "B"
      ? f.points.map((p) => (p.chamber === "A" ? { ...p, chamber: "B" } : p))
      : f.points;
    const run = activeRun();
    const recent = storedRuns[device.mode].at(-1);
    const summaryRun = run ?? (!!recent && recent.protocol === f.profile ? recent : null);
    const latest = f.points.at(-1)?.time;
    const span = $("chart-range").value;
    const plottedRun = run ?? recent;
    const to = latest == null ? undefined : Math.max(latest, Math.min(latest + 15_000, plottedRun?.events.at(-1)?.time ?? latest));
    charts.observe.set({
      key: metric, points: chartPoints, events: plottedRun?.events,
      revision: `${f.revision}:${plottedRun?.events.length ?? 0}:${singleSlot}`,
      from: span === "all" || to == null ? undefined : to - Number(span) * 60_000, to,
      names: { A: showA ? nameFor("A", f.profile) : null, B: showB ? realName.B : null },
      empty: f.state.fault ? "未检测到 SCD40" : connected ? "等待 Arduino 发送有效采样" : "连接 Arduino，开始采样",
    });

    let comparison = { rises: {}, diff: null };
    let baseline = "开始记录时设置基线";
    if (summaryRun) {
      baseline = run ? "相对于本次开灯前的基线" : "最近一次实验的温升";
      comparison = T.resultFor(summaryRun, summaryRun.end ?? now);
      if (run && !demo) for (const id of run.chambers) {
        const physId = single ? "A" : id;
        if (f.state.online[physId] === false) { delete comparison.rises[id]; comparison.diff = null; }
      }
    } else if (demo && chartPoints.length) {
      for (const id of ids) {
        const first = chartPoints.find((p) => p.chamber === id);
        const last = chartPoints.findLast((p) => p.chamber === id);
        if (first && last) comparison.rises[id] = last.temp - first.temp;
      }
      if (ids.length === 2 && comparison.rises.A != null && comparison.rises.B != null) {
        comparison.diff = comparison.rises.A - comparison.rises.B;
      }
      baseline = "相对于模拟曲线起点";
    }
    put("baseline-caption", baseline);
    put("rise-A", signed(comparison.rises.A));
    put("rise-B", signed(comparison.rises.B));
    put("rise-diff", signed(comparison.diff));
    put("trend-caption", single ? `单传感实时趋势（${realName[singleSlot]}）` : "两舱数据共用同一时间轴");
    put("sample-summary", f.state.fault ?? (latest == null ? "尚无采样" : `${f.good.toLocaleString("zh-CN")} 条采样${demo ? " / 模拟" : connected ? "" : " / 历史"}`));
    put("sample-time", `最近采样 ${clock(latest)}`);
    put("quick-state", run ? "正在记录" : recent ? (recent.reason === "到时结束" ? "已完成" : "已结束") : "未开始");
    put("quick-timer", run ? `${elapsedLabel(now - run.start)} / ${run.minutes}:00` :
      recent ? `${T.CONDITIONS[recent.condition]}` : "10 分钟 / 默认");
    if (observeLastFeed !== f) {
      observeLastFeed = f;
      charts.observe.clearTip();
    }
  }

  function readiness(now) {
    const f = device.active;
    if (device.mode === "live" && device.connection !== "connected") return { message: "请先连接 Arduino。" };
    if (unmarkedLamp()) return { message: "上一轮未标记关灯，请先记录关灯。" };
    const single = isSingleMode(f);
    const logicalIds = activeIds(f);
    const physIds = single ? ["A"] : ROOM_IDS;
    const offline = physIds.filter((id) => f.state.online[id] === false || !T.fresh(f.state.latest[id], now));
    if (offline.length) return { message: `等待 ${offline.join("、")} 舱的有效数据。` };
    const latest = latestForLogical(f, now);
    const baseline = T.baselineFor(latest, logicalIds, now);
    if (!baseline) return { message: "等待 A、B 两舱时间相近的基线读数。" };
    return {
      baseline,
      chambers: logicalIds,
      message: logicalIds.length === 1 ? `单传感基线就绪（记作 ${realName[logicalIds[0]]}）。` : "两舱基线就绪。",
    };
  }

  function fieldError(id, fieldIds, text) {
    put(id, text);
    show(id, Boolean(text));
    for (const key of fieldIds) $(key).setAttribute("aria-invalid", String(Boolean(text)));
  }

  function validateRun(field) {
    if (field === "setting") {
      const ok = $("condition").value === "baseline" || Boolean($("setting").value.trim());
      fieldError("setting-error", ["setting"], ok ? "" : "填写这一轮的设定值或处理条件。");
      return ok;
    }
    if (field === "duration") {
      const ok = $("duration").validity.valid;
      fieldError("duration-error", ["duration"], ok ? "" : "填写 1–60 分钟内的整数。");
      return ok;
    }
    const ids = ["ambient-temp", "ambient-rh"];
    const invalid = ids.filter((id) => !$(id).validity.valid);
    fieldError("ambient-error", invalid, invalid.length ? "核对舱外温度（−30 到 70）和湿度（0 到 100），最多一位小数。" : "");
    ids.filter((id) => !invalid.includes(id)).forEach((id) => $(id).setAttribute("aria-invalid", "false"));
    return !invalid.length;
  }

  function renderConditionPresets() {
    const cond = $("condition").value;
    if (cond === presetCondition) return;
    presetCondition = cond;
    const host = $("setting-presets");
    if (!host) return;
    const items = CONDITION_PRESETS[cond] ?? [];
    host.hidden = items.length === 0;
    host.replaceChildren(...items.map((label) => {
      const b = element("button", label, "preset-chip");
      b.type = "button";
      b.dataset.preset = label;
      return b;
    }));
  }

  function beginRun(e) {
    e.preventDefault();
    if (activeRun()) return;
    for (const field of ["setting", "duration", "ambient"]) runRuleEdited.add(field);
    const valid = [...runRuleEdited].map(validateRun).every(Boolean);
    if (!valid) { $("run-form").querySelector('[aria-invalid="true"]')?.focus(); return; }
    const start = Date.now();
    const r = readiness(start);
    if (!r.baseline) { put("run-error", r.message); show("run-error", true); return; }
    const f = device.active;
    const slug = start.toString(36);
    const run = {
      id: `${device.mode}-${slug}`, source: device.mode, protocol: f.profile, chambers: [...r.chambers],
      condition: $("condition").value, setting: $("setting").value.trim(), minutes: Number($("duration").value),
      start, end: null, reason: null, baseline: r.baseline, samples: [], events: [],
      ambient: { temp: Number.isFinite($("ambient-temp").valueAsNumber) ? $("ambient-temp").valueAsNumber : null,
        rh: Number.isFinite($("ambient-rh").valueAsNumber) ? $("ambient-rh").valueAsNumber : null },
    };
    run.events.push({ time: start, device: "LIGHT", chamber: "-", value: "ON", note: "手动标记开灯", deviceMs: null });
    storedRuns[device.mode].push(run);
    selected[device.mode] = run.id;
    persist();
    show("run-error", false);
    render();
    $("annotation").focus({ preventScroll: true });
  }

  function finishRun(reason, at = Date.now()) {
    const run = activeRun();
    if (!run) return;
    const timed = at >= deadline(run);
    run.end = timed ? deadline(run) : Math.max(run.start, at);
    run.reason = timed ? "到时结束" : reason;
    run.events.push({ time: run.end, device: "RUN", chamber: "-", value: "END", note: run.reason, deviceMs: null });
    persist();
    scheduleRender();
  }

  function recordLampOff(run) {
    if (!run || run.events.some((e) => e.device === "LIGHT" && e.value === "OFF")) return;
    const now = Date.now();
    run.events.push({ time: now, device: "LIGHT", chamber: "-", value: "OFF", note: "手动标记关灯", deviceMs: null });
    if (run.end == null) finishRun("提前结束（已标记关灯）", now);
    else persist();
    scheduleRender();
  }

  function saveSample(p) {
    const run = activeRun();
    if (!run) return;
    if (p.time > deadline(run)) { finishRun("到时结束", p.time); return; }
    const mapped = (run.chambers.length === 1 && run.chambers[0] === "B" && p.chamber === "A")
      ? { ...p, chamber: "B" }
      : p;
    if (run.chambers.includes(mapped.chamber)) {
      if (run.samples.length >= 5000) { finishRun("达到采样记录上限"); return; }
      run.samples.push(mapped);
      persist();
    }
  }

  function saveEvent(e) {
    const run = activeRun();
    if (!run) return;
    if (e.time > deadline(run)) { finishRun("到时结束", e.time); return; }
    if (run.events.length >= 1000) { finishRun("达到事件记录上限"); return; }
    run.events.push(e);
    persist();
    scheduleRender();
  }

  function readableEvent(e) {
    if (e.device === "LIGHT" || e.device === "RUN" || e.device === "NOTE") return e.note;
    if (e.device === "MIST") {
      const name = { ON: "开启（板端）", OFF: "关闭（板端）", PULSE: "按键测试", SYNC_ON: "校正为开启", SYNC_OFF: "校正为关闭" }[e.value] ?? e.value;
      return `${e.chamber} 舱雾化：${name}`;
    }
    if (e.device === "FAN") return `两舱风扇：${e.value === "ON" ? "开启" : "关闭"}（板端）`;
    if (e.device === "AUTO_RH") return `${e.chamber} 舱湿度反馈：${e.value === "OFF" ? "取消" : `${e.value} %RH`}`;
    if (e.device === "SENSOR") return `${e.chamber} 舱传感器${e.value === "LOST" ? "离线" : "上线"}`;
    if (e.device === "CMD") return `收到命令回执：${e.value}`;
    if (e.device === "ALL") return "板端收到全部停止请求";
    return [e.device, e.chamber, e.value, e.note].filter(Boolean).join(" / ");
  }

  function renderRecords(now) {
    const run = activeRun();
    const viewed = openedRun();
    const demo = device.mode === "demo";
    renderConditionPresets();
    put("records-source", demo ? "模拟记录 / 不用于报告" : "Arduino 实测 / 本机保存");
    put("run-setup-title", run ? "正在记录光照实验" : "开始一次实验");
    put("run-guide", run ? "光照计时从手动标记开灯开始；到时结束记录，不会关闭实体灯。" :
      "等基线稳定后手动开灯，立即做标记。网页只记录时刻，不控制照明。");
    show("run-form", !run);
    show("run-active", Boolean(run));
    if (run) {
      put("run-elapsed", elapsedLabel(Math.min(now, deadline(run)) - run.start));
      put("run-goal", `/ ${elapsedLabel(run.minutes * 60_000)}`);
      $("run-progress").max = run.minutes * 60;
      $("run-progress").value = (now - run.start) / 1000;
    }
    const r = readiness(now);
    put("baseline-ready", r.message);
    $("run-start").disabled = !r.baseline;

    const late = unmarkedLamp();
    const note = $("lamp-reminder");
    const text = late ? `${demo ? "模拟记录" : "上一轮记录"}未标记关灯。${demo ? "" : "请现场关灯后补记。"}`
      : storageIssue && !demo ? storageIssue : "";
    if (note.dataset.key !== `${late?.id ?? ""}:${text}`) {
      note.dataset.key = `${late?.id ?? ""}:${text}`;
      note.replaceChildren(document.createTextNode(text));
      if (late) {
        const button = element("button", "补记关灯", "button secondary");
        button.type = "button";
        button.addEventListener("click", () => recordLampOff(late));
        note.append(button);
        if (storageIssue && !demo) note.append(document.createTextNode(` ${storageIssue}`));
      }
    }
    note.hidden = !text;
    put("archive-notice", demo ? "模拟记录不进入实测档案；退出模拟可查实测。" :
      storageIssue || "实测记录保存在本浏览器，请定期导出 CSV。");
    const runs = storedRuns[device.mode];
    const signature = [device.mode, viewed?.id, ...runs.map((rItem) => `${rItem.id}:${rItem.end}:${rItem.reason}`)].join("|");
    if (signature !== archiveKey) {
      archiveKey = signature;
      const list = $("archive-list");
      if (runs.length) list.replaceChildren(...runs.slice().reverse().map((rItem) => {
        const btn = element("button", null, "archive-item");
        btn.type = "button";
        btn.dataset.run = rItem.id;
        btn.setAttribute("aria-pressed", String(viewed === rItem));
        const tag = rItem.chambers.length === 1 ? ` [${rItem.chambers[0]}]` : "";
        btn.append(
          element("strong", T.CONDITIONS[rItem.condition] + (rItem.setting ? ` / ${rItem.setting}` : "") + tag),
          element("small", `${fmtDate.format(rItem.start)}　${rItem.reason ?? "记录中"}`)
        );
        return btn;
      }));
      else list.replaceChildren(element("p", "暂无记录。每轮实验保留曲线、数据与事件。", "hint"));

      const cmpSelect = $("compare-run");
      if (cmpSelect) {
        const others = runs.filter((item) => item.id !== viewed?.id);
        if (compareRunId && !others.some((o) => o.id === compareRunId)) compareRunId = "";
        cmpSelect.replaceChildren(
          element("option", "不叠加对照", null),
          ...others.slice().reverse().map((o) => {
            const opt = element("option", `${T.CONDITIONS[o.condition]}${o.setting ? ` / ${o.setting}` : ""} (${o.chambers.join("+")})`, null);
            opt.value = o.id;
            return opt;
          })
        );
        cmpSelect.options[0].value = "";
        cmpSelect.value = compareRunId;
        cmpSelect.disabled = others.length === 0;
      }
    }
    $("archive-export").disabled = !runs.length;
    $("export-csv").disabled = !viewed;
    $("export-chart").disabled = !viewed;
    if ($("delete-run")) $("delete-run").disabled = !viewed || viewed.end == null;
    show("record-content", Boolean(viewed));
    if (!viewed) {
      put("record-detail-title", "采样与事件");
      put("record-detail-sub", "开始记录后，温度曲线和带时间戳的数据表会出现在这里。");
      return;
    }
    renderDetail(viewed, now);
  }

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function renderDetail(run, now) {
    const name = T.CONDITIONS[run.condition] + (run.setting ? ` / ${run.setting}` : "");
    put("record-detail-title", name);
    put("record-detail-sub", `${run.source === "demo" ? "模拟演练" : "Arduino 实测"} / ${fmtDate.format(run.start)} 开灯 / ${run.reason ?? "正在记录"}`);
    const rev = `${run.id}:${run.samples.length}`;
    if (chartCache.rev !== rev) {
      chartCache = { rev, points: [...Object.values(run.baseline), ...run.samples].sort((a, b) => a.time - b.time) };
    }
    const points = chartCache.points;
    const compareRun = compareRunId && compareRunId !== run.id
      ? storedRuns[device.mode].find((item) => item.id === compareRunId)
      : null;
    const compareModel = compareRun ? {
      id: compareRun.id,
      label: T.CONDITIONS[compareRun.condition] + (compareRun.setting ? ` / ${compareRun.setting}` : ""),
      start: compareRun.start,
      points: [...Object.values(compareRun.baseline), ...compareRun.samples].sort((a, b) => a.time - b.time),
    } : null;

    show("record-legend-A-wrap", run.chambers.includes("A"));
    put("record-legend-A", nameFor("A", run.protocol));
    show("record-legend-B", run.chambers.includes("B"));
    show("record-legend-cmp", Boolean(compareModel));
    if (compareModel) put("record-legend-cmp-text", `对照：${compareModel.label}`);

    charts.records.set({
      key: "temp", source: run.source, points, events: run.events,
      revision: `${rev}:${run.events.length}:${compareModel?.id ?? ""}:${compareModel?.points.length ?? 0}`,
      from: points[0].time, to: Math.max(run.start + 30_000, run.end ?? points.at(-1).time), start: run.start, title: name,
      names: {
        A: run.chambers.includes("A") ? nameFor("A", run.protocol) : null,
        B: run.chambers.includes("B") ? realName.B : null,
      },
      compare: compareModel,
    });

    const summary = T.runSummary(run, run.end ?? now);
    const key = `${rev}:${run.events.length}:${run.end}:${Object.keys(summary.rises).join("")}:${summary.diff}:${compareRunId}`;
    if (detailKey === key) return;
    detailKey = key;
    const stats = run.chambers.map((id) => [`${id} 舱温升`, signed(summary.rises[id])]);
    if (run.chambers.includes("B") && run.chambers.includes("A")) stats.push(["A − B", signed(summary.diff)]);
    for (const id of run.chambers) {
      const s = summary.stats[id];
      if (!s) continue;
      if (s.tMax != null) stats.push([`${id} 峰值`, `${s.tMax.toFixed(2)} °C`]);
      if (s.avgRh != null) stats.push([`${id} 均湿`, `${s.avgRh.toFixed(1)} %RH`]);
      if (s.avgCo2 != null) stats.push([`${id} 均 CO₂`, `${s.avgCo2} ppm`]);
    }
    if (compareRun) {
      const cmpSummary = T.runSummary(compareRun, compareRun.end ?? now);
      const curId = run.chambers[0];
      const cmpId = compareRun.chambers[0];
      if (summary.rises[curId] != null && cmpSummary.rises[cmpId] != null) {
        stats.push([`较对照 ΔT (${curId}−${cmpId})`, signed(summary.rises[curId] - cmpSummary.rises[cmpId])]);
      }
    }
    if (run.ambient.temp != null) stats.push(["舱外温度", `${run.ambient.temp} °C`]);
    if (run.ambient.rh != null) stats.push(["舱外湿度", `${run.ambient.rh} %RH`]);
    if (run.end != null && run.chambers.some((id) => !summary.samples[id])) stats.push(["结果", "缺少结束前的有效采样"]);
    else if (run.end != null && run.chambers.length === 2 && summary.diff == null) stats.push(["双舱结果", "结束样本未对齐"]);
    $("record-stats").replaceChildren(...stats.map(([label, value]) => {
      const item = document.createElement("div");
      item.append(element("dt", label), element("dd", value));
      return item;
    }));
    put("table-count", points.length > 60 ? `最近 60 / ${points.length} 条` : `${points.length} 条（含基线）`);
    $("sample-table").replaceChildren(...points.slice(-60).reverse().map((p) => {
      const row = document.createElement("tr");
      for (const value of [clock(p.time), `${p.chamber}${p === run.baseline[p.chamber] ? "（基线）" : ""}`,
        p.temp.toFixed(2), p.rh.toFixed(1), String(p.co2)]) row.append(element("td", value));
      return row;
    }));
    $("event-list").replaceChildren(...run.events.slice().reverse().map((event) => {
      const li = document.createElement("li");
      const time = element("time", clock(event.time));
      time.dateTime = new Date(event.time).toISOString();
      li.append(time, document.createTextNode(readableEvent(event)));
      return li;
    }));
  }

  function renderDebug() {
    const f = device.active;
    const demo = device.mode === "demo";
    const connected = device.connection === "connected";
    const stage = { idle: "未连接", opening: "等待选择端口", connected: "USB 已打开", closing: "正在断开" }[device.connection];
    put("port-state", demo && device.connection !== "opening" ? "模拟串口" : stage);
    put("debug-profile", demo ? `模拟器 / ${f.single ? "单侧实验" : "双舱协议"}` : f.profile === "school" ? "学校原版 / 只读" :
      f.profile === "dual" ? "GreenhouseDual / " + (f.single ? "单传感器台架" : "双舱") : connected ? "正在识别固件" : "未连接 Arduino");
    put("rx-count", f.good);
    put("bad-count", f.rejected);
    if ($("pins-summary")) {
      const p = f.pins;
      put("pins-summary", p ? `方案 ${p.profile ?? "—"}：风扇 ${p.fan ?? "D2"} · 雾化A ${p.mistA ?? "D3"} · 雾化B ${p.mistB ?? "D6"} · I²C ${p.i2c ?? "A4/A5"}` :
        "未收到板端引脚回执（烧录 GreenhouseDual v1.1 后自动显示）");
    }
    if ($("scan-summary")) {
      const s = f.scan;
      put("scan-summary", s ? `多路器 ${s.mux ?? "—"} · 主总线 ${s.main ?? "—"}${s.CH0 ? ` · CH0:${s.CH0} CH1:${s.CH1}` : ""}` : "未执行 I²C 扫描");
    }
    $("baud").disabled = device.connection !== "idle";
    const can = device.canWrite;
    const busy = Boolean(device.pending);
    put("command-help", demo ? "发送给本页模拟器，不会触发任何实物。" :
      can ? (f.uncertain ? "仅允许读取状态或请求全部停止，直到收到 STATE。" : "支持 STATUS、HELP、SCAN、STOP、FAN、MIST、RH、PULSE 和 SYNC。") :
        f.profile === "school" ? "学校原程序只发送读数，不接收控制命令。刷入 GreenhouseDual 才能控制。" :
          "连接并识别 GreenhouseDual 后才能发送命令。");
    put("control-profile", demo ? "模拟命令不会发到 Arduino。" :
      can ? (f.uncertain ? "有命令未确认；请先读取状态。" :
        f.single ? "单传感器模式：物理控制对应 A 通道（D2 风扇 / D3 雾化）。" : "显示由固件回报；按键式雾化器需现场核对。") :
        f.profile === "school" ? "学校原程序没有命令接收接口。" : "尚未识别可控的双舱固件。");
    for (const btn of document.querySelectorAll("[data-command], [data-mist], [data-mist-action]")) {
      btn.disabled = !(btn.dataset.command === "STATUS" ? device.canProbe : can) ||
        (busy && (btn.dataset.command !== "STOP" || device.pending.command.family === "STOP")) ||
        (f.uncertain && !["STOP", "STATUS"].includes(btn.dataset.command));
    }
    for (const id of ["scope", "rh-target", "rh-off", "rh-apply"]) $(id).disabled = !can || busy || f.uncertain;
    $("send-command").disabled = !can || busy;
    $("command").disabled = !can;
    put("send-command", busy ? "等待回执" : "发送");
    if (f.single && $("scope").value !== "A") $("scope").value = "A";
    for (const option of $("scope").options) option.disabled = f.single && option.value !== "A";
    const labels = { true: "板端：开", false: "板端：关", null: "未知" };
    const hasBoard = connected || demo;
    put("fan-state", labels[hasBoard ? f.state.fan : null]);
    for (const id of ROOM_IDS) {
      const target = f.state.target[id];
      const mist = f.single && id === "B" ? "未接入" : !hasBoard ? "未知" : !f.state.sync[id] ? "需同步（SYNC）" : labels[f.state.mist[id]];
      put(`mist-${id}`, mist + (target && hasBoard ? ` / 目标 ${target} %RH` : ""));
    }
    put("stop-hint", demo ? "仅停止模拟状态。实体设备始终需要现场确认。" :
      "停机请求不切断电源，也不控制照明。断开串口不会可靠关闭执行器，请现场核对。");
    const newLogKey = `${device.mode}:${f.logRevision}:${logFilter}:${logFollow}`;
    if (newLogKey === logKey && renderDebug.feed === f) return;
    logKey = newLogKey;
    renderDebug.feed = f;
    const list = $("serial-log");
    const scroll = list.scrollTop;
    const entries = f.logs.filter((l) => logFilter === "all" || l.kind === logFilter);
    if (!entries.length) list.replaceChildren(element("li", f.logs.length ? "当前过滤下没有消息。" : "等待串口消息。", "log-empty"));
    else list.replaceChildren(...entries.map((entry) => {
      const row = document.createElement("li");
      const textClass = entry.text.startsWith("ERR,") ? "log-error" :
        entry.text.startsWith("EVT,") ? "log-evt" :
        entry.text.startsWith("STATE,") ? "log-state" : null;
      row.append(
        element("span", clock(entry.time), "log-time"),
        element("span", entry.kind.toUpperCase(), `log-${entry.kind}`),
        element("span", entry.text, textClass)
      );
      return row;
    }));
    list.scrollTop = logFollow ? list.scrollHeight : scroll;
    for (const id of ["log-save", "log-clear"]) $(id).disabled = !f.logs.length;
  }

  function commandResult(text, error = false) {
    put("command-result", text);
    $("command-result").dataset.tone = error ? "error" : "muted";
  }

  function confirmation(command) {
    const dialog = $("confirm-command");
    if (pendingDialog) return Promise.resolve(false);
    pendingDialog = true;
    const explanation = command.family === "RH" ? "Nano 会根据读数自动启停所选雾化器，即使网页断开也可能继续。请先确认水位和接线。" :
      command.family === "SYNC" ? "仅修正程序记住的状态，不会按键。请先确认雾化器的实际状态。" :
      command.family === "PULSE" ? "这会实按一次模块按键，可能改变喷雾挡位；之后请检查实际状态并用 SYNC 同步。" :
      command.family === "MIST" ? "可能立即启动所选雾化器，并取消对应舱的自动湿度反馈。请确认水位和接线。" :
      "风扇继电器将吸合通电。请确认风扇周围没有阻挡。";
    put("confirm-detail", `${command.text}。${explanation}`);
    dialog.returnValue = "cancel";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        pendingDialog = false;
        resolve(dialog.returnValue === "send");
      }, { once: true });
      dialog.showModal();
    });
  }

  async function send(value, raw = false) {
    const command = T.parseCommand(value);
    if (!command) {
      if (raw) {
        fieldError("command-error", ["command"], "检查命令格式，例如 STATUS、SCAN、FAN OFF 或 RH A 75（1–95）。");
        $("command").focus();
      }
      return false;
    }
    if (!(command.family === "STATUS" ? device.canProbe : device.canWrite)) return false;
    const channel = command.text.split(" ")[1];
    if (device.active.single && ["RH", "MIST", "PULSE", "SYNC"].includes(command.family) &&
        (channel === "B" || (channel !== "A" && !command.text.endsWith(" OFF")))) {
      commandResult("当前仅 A 舱接入。请选择 A 或在命令中写明 A 舱。", true);
      return false;
    }
    if (raw) fieldError("command-error", ["command"], "");
    if (device.mode === "live" && command.confirm && !device.active.uncertain && !await confirmation(command)) return false;
    return device.send(command);
  }

  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = element("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csv(runs, token) {
    const source = device.mode === "demo" ? "SIMULATED" : "ARDUINO";
    download(`Thermarium-${source}-${token}.csv`, "text/csv;charset=utf-8", T.runsCsv(runs));
  }

  function updateRoute(focus = false) {
    const target = location.hash.slice(1);
    if (target === "workspace") return;
    route = ["observe", "records", "debug"].includes(target) ? target : "observe";
    if (route !== "observe" && document.body.classList.contains("presenting")) void setPresentation(false);
    for (const id of ["observe", "records", "debug"]) show(id, id === route);
    for (const a of document.querySelectorAll(".top-nav [data-view]")) {
      if (a.dataset.view === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (focus) {
      window.scrollTo(0, 0);
      $(`${route}-title`).focus({ preventScroll: true });
    }
    render();
  }

  async function setPresentation(on, native = true) {
    document.body.classList.toggle("presenting", on);
    $("present").setAttribute("aria-pressed", String(on));
    $("present").lastElementChild.textContent = on ? "退出投屏" : "投屏模式";
    renderHeader(Date.now());
    if (native) {
      try {
        if (on) await document.documentElement.requestFullscreen?.();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch { /* Presentation layout is available without the fullscreen permission. */ }
    }
  }

  $("present").addEventListener("click", () => void setPresentation(!document.body.classList.contains("presenting")));
  $("theme-toggle")?.addEventListener("click", () => applyTheme(theme === "dark" ? "light" : "dark"));
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("presenting")) void setPresentation(false, false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("presenting") && !document.fullscreenElement) void setPresentation(false, false);
  });
  $("connect").addEventListener("click", async () => {
    if (device.connection === "connected") {
      const hadControl = device.active.profile === "dual";
      await device.disconnect();
      if (hadControl) notify("串口已断开；这不保证风扇和雾化器已关闭，请现场确认。");
    } else {
      await device.connect(Number($("baud").value));
      if (device.connection === "connected") commandResult("等待板端输出；识别到双舱固件后可读取状态或扫描 I²C。");
    }
    saveSource();
    scheduleRender();
  });
  $("demo-toggle").addEventListener("click", () => {
    if (device.connection !== "idle" || document.body.classList.contains("presenting")) return;
    if (device.mode === "demo") device.leaveDemo(); else device.enterDemo(false);
    saveSource();
    notify("");
    commandResult(device.mode === "demo" ? "可向模拟器发送 STATUS 或 SCAN，查看状态回报。" : "请先连接 Arduino。");
    scheduleRender();
  });
  $("demo-single-btn")?.addEventListener("click", () => {
    if (device.mode !== "demo") return;
    const nextSingle = !device.active.single;
    device.leaveDemo();
    device.enterDemo(nextSingle);
    scheduleRender();
  });
  $("single-slot-group")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slot]");
    if (!btn) return;
    singleSlot = btn.dataset.slot === "B" ? "B" : "A";
    savePref(SINGLE_SLOT, singleSlot);
    scheduleRender();
  });
  $("metrics").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-metric]");
    if (!btn) return;
    metric = btn.dataset.metric;
    for (const child of $("metrics").children) child.setAttribute("aria-pressed", String(child === btn));
    scheduleRender();
  });
  $("chart-range").addEventListener("change", scheduleRender);
  $("run-form").addEventListener("submit", beginRun);
  for (const [id, field] of [["setting", "setting"], ["duration", "duration"], ["ambient-temp", "ambient"], ["ambient-rh", "ambient"]]) {
    $(id).addEventListener("blur", () => { runRuleEdited.add(field); validateRun(field); });
    $(id).addEventListener("input", () => { if (runRuleEdited.has(field)) validateRun(field); });
  }
  $("condition").addEventListener("change", () => {
    const text = { baseline: "可选，例如第一轮", mist: "例如 60 %RH", co2: "例如 1200 ppm", other: "例如 40% 镜面覆盖" };
    $("setting").placeholder = text[$("condition").value];
    renderConditionPresets();
    if (runRuleEdited.has("setting")) validateRun("setting");
  });
  $("setting-presets")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    $("setting").value = btn.dataset.preset;
    runRuleEdited.add("setting");
    validateRun("setting");
  });
  $("annotation-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("annotation").value.trim();
    if (!text || !activeRun()) return;
    saveEvent({ time: Date.now(), device: "NOTE", chamber: "-", value: "MARK", note: text, deviceMs: null });
    $("annotation").value = "";
  });
  $("finish-run").addEventListener("click", () => finishRun("提前结束（只结束记录）"));
  $("mark-off").addEventListener("click", () => recordLampOff(activeRun()));
  $("archive-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-run]");
    if (!btn) return;
    selected[device.mode] = btn.dataset.run;
    for (const node of $("archive-list").children) node.setAttribute("aria-pressed", String(node === btn));
    archiveKey = [device.mode, btn.dataset.run, ...storedRuns[device.mode].map((r) => `${r.id}:${r.end}:${r.reason}`)].join("|");
    scheduleRender();
  });
  $("compare-run")?.addEventListener("change", () => {
    compareRunId = $("compare-run").value;
    scheduleRender();
  });
  $("delete-run")?.addEventListener("click", () => {
    const run = openedRun();
    if (!run || run.end == null) return;
    const list = storedRuns[device.mode];
    const idx = list.findIndex((r) => r.id === run.id);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (selected[device.mode] === run.id) selected[device.mode] = list.at(-1)?.id ?? null;
    if (compareRunId === run.id) compareRunId = "";
    persist();
    scheduleRender();
  });
  $("export-csv").addEventListener("click", () => { const r = openedRun(); if (r) csv([r], r.id); });
  $("archive-export").addEventListener("click", () => csv(storedRuns[device.mode], "all"));
  $("export-chart").addEventListener("click", () => {
    const r = openedRun();
    if (!r) return;
    renderDetail(r, Date.now());
    download(`Thermarium-${r.source === "demo" ? "SIMULATED" : "ARDUINO"}-${r.id}.svg`, "image/svg+xml", charts.records.exportSvg());
  });
  $("log-mode").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-log]");
    if (!btn) return;
    logFilter = btn.dataset.log;
    for (const child of $("log-mode").children) child.setAttribute("aria-pressed", String(child === btn));
    scheduleRender();
  });
  $("log-follow").addEventListener("click", () => {
    logFollow = !logFollow;
    $("log-follow").setAttribute("aria-pressed", String(logFollow));
    put("log-follow", logFollow ? "跟随开启" : "跟随暂停");
    scheduleRender();
  });
  $("log-clear").addEventListener("click", () => {
    device.active.logs.length = 0;
    device.active.logRevision++;
    commandResult("已清空显示日志，不影响采样和实验记录。");
    scheduleRender();
  });
  $("log-save").addEventListener("click", () => {
    const lines = device.active.logs.map((l) => `${new Date(l.time).toISOString()} ${l.kind.toUpperCase()} ${l.text}`);
    const simulated = device.mode === "demo";
    download(`Thermarium-${simulated ? "SIMULATED" : "ARDUINO"}-serial.txt`, "text/plain;charset=utf-8",
      `${simulated ? "模拟串口" : "Arduino 串口"} / ${device.baud} baud\r\n${lines.join("\r\n")}\r\n`);
  });
  $("command-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = $("command").value;
    if (await send(value, true) && $("command").value === value) $("command").value = "";
  });
  $("command").addEventListener("input", () => {
    if (!$("command-error").hidden && T.parseCommand($("command").value)) fieldError("command-error", ["command"], "");
  });
  $("debug").addEventListener("click", (e) => {
    const direct = e.target.closest("[data-command]")?.dataset.command;
    const mist = e.target.closest("[data-mist]")?.dataset.mist;
    const mistAction = e.target.closest("[data-mist-action]")?.dataset.mistAction;
    if (direct) void send(direct);
    if (mist) void send(scoped("MIST", mist));
    if (mistAction) {
      const ch = device.active.single ? "A" : $("scope").value;
      if (!ch) {
        commandResult("请先在控制范围选择「仅 A 舱」或「仅 B 舱」，再执行按键测试或状态校正。", true);
        return;
      }
      void send(`${mistAction.replace(" ", ` ${ch} `)}${mistAction === "PULSE" ? ` ${ch}` : ""}`);
    }
  });
  const scoped = (cmd, value) => [cmd, $("scope").value, value].filter(Boolean).join(" ");
  function validateRh() {
    const good = $("rh-target").validity.valid;
    fieldError("rh-error", ["rh-target"], good ? "" : "请填写 1–95 之间的整数。");
    return good;
  }
  $("rh-target").addEventListener("blur", validateRh);
  $("rh-target").addEventListener("input", () => { if (!$("rh-error").hidden) validateRh(); });
  $("rh-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateRh()) { $("rh-target").focus(); return; }
    void send(scoped("RH", String($("rh-target").valueAsNumber)));
  });
  $("rh-off").addEventListener("click", () => void send(scoped("RH", "OFF")));
  window.addEventListener("hashchange", () => updateRoute(true));
  window.addEventListener("beforeunload", (e) => {
    if (device.mode === "live" && activeRun()) {
      persist();
      e.preventDefault();
      e.returnValue = "";
    }
  });
  setInterval(() => {
    const run = activeRun();
    if (run && Date.now() >= deadline(run)) finishRun("到时结束");
    scheduleRender();
  }, 1000);
  for (const decoration of document.querySelectorAll(".icon, .status-dot")) decoration.setAttribute("aria-hidden", "true");
  applyTheme(theme);
  let preferLive = false;
  try { preferLive = localStorage.getItem(MODE) === "live"; } catch { /* Default to a clearly labeled preview. */ }
  if (!preferLive) device.enterDemo();
  updateRoute();
})();

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const T = require("../telemetry.js");

test("parses actual dual and school readouts without inventing actuator state", () => {
  assert.deepEqual(T.parseLine("DATA,18050,B,812,-2.05,64.1,1,0\r").sample,
    { deviceMs: 18050, chamber: "B", co2: 812, temp: -2.05, rh: 64.1, mist: true, fan: false });
  const school = T.parseLine("CO2(ppm):647\tTemperature(C):25.2\tHumidity(%RH):43.1");
  assert.equal(school.protocol, "school");
  assert.equal(school.sample.chamber, "A");
  assert.equal(school.sample.fan, null);
  assert.equal(school.sample.deviceMs, null);
  assert.equal(T.parseLine("Sensor not detected. Please check wiring. Freezing...").type, "sensor-error");
  assert.equal(T.parseLine("DATA,100,B,0,25.12,46.0,0,0").type, "unknown");
  assert.equal(T.parseLine("DATA,100,A,560,NaN,46.0,0,0").type, "unknown");
  assert.equal(T.parseLine("DATA,100,A,560,25.12,101.0,0,0").type, "unknown");
  assert.equal(T.parseLine("DATA,100,B,560,25.12,64.0,1").type, "unknown");
});

test("parses state, ACK, rejected commands, and event notes", () => {
  const state = T.parseLine("STATE,33300,1,0,1,80,0,1,0");
  assert.deepEqual(state.target, { A: 80, B: 0 });
  assert.deepEqual(state.online, { A: true, B: false });
  assert.equal(T.parseLine("OK,MIST").command, "MIST");
  assert.equal(T.parseLine("ERR,mist busy, try again").message, "mist busy, try again");
  assert.equal(T.parseLine("EVT,400,MIST,A,PULSE,use SYNC if state changed").note, "use SYNC if state changed");
});

test("reassembles CRLF and skips whole oversize packets", () => {
  const got = [];
  let discarded = 0;
  const buffer = new T.LineBuffer((v) => got.push(v), () => discarded++, 24);
  buffer.push("OK,MI");
  buffer.push("ST\r");
  buffer.push("\n" + "x".repeat(40) + "OK,RH");
  buffer.push("\nOK,FAN\n");
  assert.deepEqual(got, ["OK,MIST", "OK,FAN"]);
  assert.equal(discarded, 1);
});

test("restricts commands to the existing firmware syntax", () => {
  assert.deepEqual(T.parseCommand(" rh b\t75 "), { text: "RH B 75", family: "RH", confirm: true });
  assert.deepEqual(T.parseCommand(" scan "), { text: "SCAN", family: "SCAN", confirm: false });
  assert.equal(T.parseCommand("FAN OFF").confirm, false);
  assert.equal(T.parseCommand("PULSE A").confirm, true);
  assert.equal(T.parseCommand("SYNC A OFF").confirm, true);
  for (const value of ["FAN ON\nSTOP", "RH ALL 20", "RH A 96", "PIN D3 HIGH", "RH B 80garbage", "MIST ON A"]) {
    assert.equal(T.parseCommand(value), null, value);
  }
});

test("parses boot pin map and computes run summary statistics", () => {
  assert.deepEqual(T.parseKeyValueLine("# PINS,profile=SCHOOL_PPT,fan=D2,mistA=D3", "# PINS,"),
    { profile: "SCHOOL_PPT", fan: "D2", mistA: "D3" });
  const baseline = { B: { chamber: "B", time: 1000, co2: 700, temp: 24.0, rh: 50.0 } };
  const run = {
    start: 2000, chambers: ["B"], baseline,
    samples: [
      { chamber: "B", time: 7000, co2: 720, temp: 25.5, rh: 51.0 },
      { chamber: "B", time: 12000, co2: 740, temp: 25.2, rh: 53.0 },
    ],
  };
  const summary = T.runSummary(run, 15000);
  assert.ok(Math.abs(summary.rises.B - 1.2) < 1e-9);
  assert.equal(summary.stats.B.tMax, 25.5);
  assert.equal(summary.stats.B.avgRh, 52.0);
  assert.equal(summary.stats.B.avgCo2, 730);
});

test("requires fresh paired baselines and ends with the latest timely sensor data", () => {
  const sample = (chamber, time, temp) => ({ chamber, time, temp, co2: 600, rh: 60 });
  const b = { A: sample("A", 1000, 25), B: sample("B", 1800, 24) };
  assert.equal(T.baselineFor(b, ["A", "B"], 2000).A.temp, 25);
  assert.equal(T.baselineFor({ ...b, B: sample("B", 15_000, 24) }, ["A", "B"], 15_000), null);
  assert.equal(T.baselineFor(b, ["A", "B"], 30_000), null);
  const run = { start: 2000, chambers: ["A", "B"], baseline: b, samples: [sample("A", 61_000, 28), sample("B", 61_500, 29), sample("A", 62_005, 30)] };
  const result = T.resultFor(run, 62_000);
  assert.deepEqual(result.rises, { A: 3, B: 5 });
  assert.equal(result.diff, -2);
  assert.equal(T.resultFor(run, 90_000).diff, null);
  assert.equal(T.resultFor({ ...run, samples: [sample("A", 57_000, 28), sample("B", 47_500, 29)] }, 62_000).diff, null);
});

test("reports the Humidex reference example and honors its display range", () => {
  assert.equal(Math.round(T.humidex(30, 70)), 41);
  assert.equal(T.humidex(19, 40), null);
  assert.equal(T.humidex(30, 102), null);
});

test("CSV labels simulated samples and escapes formulas and quotes", () => {
  const baseline = { A: { chamber: "A", time: 1000, co2: 600, temp: 26.3, rh: 75, deviceMs: 1000, mist: false, fan: false } };
  const csv = T.runsCsv([{
    id: "demo-test", source: "demo", protocol: "dual", condition: "mist", setting: '=HYPERLINK("x")',
    start: 2000, end: 10_000, minutes: 10, reason: "提前结束", baseline,
    chambers: ["A"], ambient: { temp: null, rh: null }, samples: [{ ...baseline.A, time: 6000, temp: 26.9 }],
    events: [{ time: 2500, device: "NOTE", chamber: "-", value: "MARK", note: '20%, "设置"' }],
  }]);
  assert.ok(csv.startsWith('\uFEFF"run_id"'));
  for (const text of [',"demo",', '"BASELINE"', '"SAMPLE"', '"END_SAMPLE"', '"RUN_SUMMARY"', `"\'=`,
    'HYPERLINK(""x"")', '"20%, ""设置"""', '"humidex"', ",-1,1000,"]) assert.ok(csv.includes(text), text);
});

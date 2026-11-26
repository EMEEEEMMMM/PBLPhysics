"""Optional browser tests. Install Python Playwright and use installed desktop Edge."""

import argparse
import csv
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

from playwright.sync_api import expect, sync_playwright

ENTRY = Path(__file__).resolve().parents[1].joinpath("index.html").as_uri()
TEST_TIME = datetime(2026, 11, 25, 14, 30)
MOCK_SERIAL = r"""
(() => {
  const serial = new EventTarget();
  let input, port;
  const fake = window.mockSerial = { sent: [], baud: null, condition: "dual", ack: true, closeCount: 0 };
  fake.feed = text => input.enqueue(new TextEncoder().encode(text));
  fake.drop = () => {
    const event = new Event("disconnect");
    Object.defineProperty(event, "port", { value: port });
    serial.dispatchEvent(event);
  };
  serial.requestPort = async () => {
    if (fake.condition === "cancel") throw new DOMException("No port selected", "NotFoundError");
    if (fake.condition === "busy") throw new DOMException("Failed to open serial port", "NetworkError");
    return port = {
      async open(options) {
        fake.baud = options.baudRate;
        this.readable = new ReadableStream({ start(controller) { input = controller; } });
        this.writable = new WritableStream({ write(bytes) {
          const text = new TextDecoder().decode(bytes);
          fake.sent.push(text);
          if (!fake.ack) return;
          if (text === "STATUS\n")
            fake.feed("STATE,19000,0,0,0,0,0,1,1\r\n");
          else if (text === "SCAN\n")
            fake.feed("# SCAN,mux=0x70,main=0x70,CH0=0x62,CH1=0x62\r\nOK,SCAN\r\n");
          else if (text === "PULSE A\n") {
            fake.feed("EVT,19200,MIST,A,PULSE,use SYNC if state changed\r\n");
            fake.feed("OK,PULSE\r\n");
          } else if (text === "SYNC A ON\n") {
            fake.feed("EVT,19300,MIST,A,SYNC_ON,\r\n");
            fake.feed("OK,SYNC\r\n");
          } else if (text === "FAN ON\n") {
            fake.feed("EVT,19110,FAN,-,ON,\r\n");
            fake.feed("OK,FAN\r\n");
          } else if (text === "STOP\n")
            fake.feed("EVT,20000,FAN,-,OFF,\r\nEVT,20000,ALL,-,STOP,\r\nOK,STOP\r\n");
          else if (text === "MIST A ON\n")
            fake.feed("ERR,mist busy, try again\r\n");
        } });
      },
      async close() {
        if (this.readable.locked || this.writable.locked) throw Error("streams still locked");
        fake.closeCount++;
      }
    };
  };
  Object.defineProperty(navigator, "serial", { value: serial });
})();
"""


def go(page, view):
    page.locator(f".top-nav a[href='#{view}']").click()
    expect(page.locator(f"#{view}")).to_be_visible()


def send_from_mock(page, line):
    page.evaluate("(line) => mockSerial.feed(line)", line)


def setup(context, mock=False):
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    if mock:
        page.add_init_script(MOCK_SERIAL)
    page.clock.install(time=TEST_TIME)
    page.goto(ENTRY)
    expect(page.locator("#temp-A")).to_have_text("26.3")
    return page, errors


def demo_journey(browser, out):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    page, errors = setup(context)
    expect(page.locator("#source-text")).to_have_text("模拟数据")
    page.locator("#live-chart").focus()
    page.keyboard.press("End")
    expect(page.locator("#live-chart .chart-tip")).to_contain_text("B 混凝土")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Escape")
    expect(page.locator("#live-chart .chart-tip")).to_be_hidden()
    page.get_by_role("button", name="湿度", exact=True).click()
    expect(page.locator("#live-chart svg text").first).to_have_text("%RH")
    page.get_by_role("button", name="CO₂", exact=True).click()
    expect(page.locator("#live-chart svg text").first).to_have_text("ppm")
    page.get_by_role("button", name="温度", exact=True).click()
    page.locator("#present").click()
    expect(page.locator("body")).to_have_class("presenting")
    expect(page.locator(".top-nav")).to_be_hidden()
    expect(page.locator("#source-text")).to_have_text("模拟数据")
    assert page.locator("#difference-row").evaluate("e => e.getBoundingClientRect().bottom <= innerHeight")
    assert page.locator(".chart-footer").evaluate("e => e.getBoundingClientRect().bottom <= innerHeight")
    if out:
        page.screenshot(path=out / "presentation.png")
    page.locator("#present").click()
    go(page, "records")
    page.locator("#condition").select_option("mist")
    page.locator("#duration").fill("1")
    page.locator("#run-start").click()
    expect(page.locator("#setting-error")).to_be_visible()
    expect(page.locator("#setting")).to_be_focused()
    page.locator("#setting-presets [data-preset='60 %RH']").click()
    expect(page.locator("#setting")).to_have_value("60 %RH")
    page.locator("#ambient-temp").fill("24.3")
    page.locator("#ambient-rh").fill("52.0")
    page.locator("#run-start").click()
    expect(page.locator("#run-active")).to_be_visible()
    page.locator("#annotation").fill("调整湿度")
    page.locator("#annotation").press("Enter")
    go(page, "debug")
    page.locator("#command").fill("INVALID")
    page.locator("#command").press("Enter")
    expect(page.locator("#command-error")).to_be_visible()
    page.locator("#command").fill("STATUS")
    page.locator("#command").press("Enter")
    page.clock.run_for(250)
    expect(page.locator("#command-result")).to_contain_text("STATE 状态回报")
    page.locator("[data-command='SCAN']").click()
    page.clock.run_for(250)
    expect(page.locator("#scan-summary")).to_contain_text("0x62")
    page.locator("#rh-target").fill("96")
    page.locator("#rh-apply").click()
    expect(page.locator("#rh-error")).to_be_visible()
    page.locator("#rh-target").fill("75")
    page.locator("#scope").select_option("A")
    page.locator("#rh-apply").click()
    page.clock.run_for(250)
    expect(page.locator("#mist-A")).to_contain_text("目标 75 %RH")
    expect(page.locator("#mist-B")).not_to_contain_text("目标")
    page.locator("#stop-all").click()
    page.clock.run_for(250)
    expect(page.locator("#mist-A")).to_have_text("板端：关")
    page.locator("[data-log=tx]").click()
    expect(page.locator("#serial-log")).to_contain_text("RH A 75")
    expect(page.locator("#serial-log")).not_to_contain_text("DATA,")
    with page.expect_download() as info:
        page.locator("#log-save").click()
    assert "SIMULATED" in info.value.suggested_filename
    page.clock.run_for(63_000)
    go(page, "records")
    expect(page.locator("#run-active")).to_be_hidden()
    expect(page.locator("#record-detail-sub")).to_contain_text("到时结束")
    expect(page.locator("#lamp-reminder")).to_contain_text("未标记关灯")
    assert page.locator("#sample-table tr").count() > 4
    expect(page.locator("#event-list")).to_contain_text("调整湿度")
    page.get_by_role("button", name="补记关灯").click()
    expect(page.locator("#lamp-reminder")).to_be_hidden()
    with page.expect_download() as info:
        page.locator("#export-csv").click()
    path = info.value.path()
    assert "SIMULATED" in info.value.suggested_filename
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    assert all(row["source"] == "demo" and row["ambient_temp_C"] == "24.3" for row in rows)
    assert {row["row_type"] for row in rows} == {"BASELINE", "EVENT", "SAMPLE", "END_SAMPLE", "RUN_SUMMARY"}
    assert any(row["row_type"] == "RUN_SUMMARY" and row["elapsed_s"] == "60" and row["delta_A_minus_B_C"] for row in rows)
    assert any(row["event_device"] == "LIGHT" and row["event_value"] == "OFF" for row in rows)
    with page.expect_download() as info:
        page.locator("#export-chart").click()
    svg = ET.parse(info.value.path()).getroot()
    assert "模拟数据" in svg.find("{http://www.w3.org/2000/svg}desc").text
    if out:
        page.screenshot(path=out / "record-complete.png", full_page=True)
    go(page, "observe")
    page.locator("#demo-single-btn").click()
    expect(page.locator("#bay-B")).to_be_hidden()
    page.locator("[data-slot='B']").click()
    expect(page.locator("#bay-A")).to_be_hidden()
    expect(page.locator("#bay-B")).to_be_visible()
    page.locator("#theme-toggle").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    if out:
        page.screenshot(path=out / "observe-single-dark.png")
    page.locator("#theme-toggle").click()
    page.locator("[data-slot='A']").click()
    page.locator("#demo-single-btn").click()
    page.locator("#demo-toggle").click()
    expect(page.locator("#source-text")).to_have_text("未连接")
    go(page, "records")
    expect(page.locator("#archive-list")).to_contain_text("暂无记录")
    assert not errors, errors
    context.close()


def serial_journey(browser, out):
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page, errors = setup(context, mock=True)
    go(page, "debug")
    page.evaluate("mockSerial.condition = 'cancel'")
    page.locator("#connect").click()
    expect(page.locator("#notice")).to_contain_text("未选择串口")
    page.evaluate("mockSerial.condition = 'busy'")
    page.locator("#connect").click()
    expect(page.locator("#notice")).to_contain_text("串口打开失败")
    page.evaluate("mockSerial.condition = 'dual'")
    page.locator("#connect").click()
    expect(page.locator("#port-state")).to_have_text("USB 已打开")
    assert page.evaluate("mockSerial.baud") == 115200
    expect(page.locator("[data-command='FAN ON']")).to_be_disabled()
    for chunk in ["# GreenhouseDual v1.1 booting\r\n# PINS,profile=SCHOOL_PPT,fan=D2,mistA=D3,mistB=D6,i2c=A4/A5,oled=D13/D11/D9/D8\r\n# TCA9548A found at 0x70\r\n# ready\r\nDATA,5000,A,906,25.", "35,53.5,0,0\r", "\nDATA,5000,B,870,27.10,41.5,0,0\r\n", "garbled\r\n"]:
        send_from_mock(page, chunk)
    expect(page.locator("#pins-summary")).to_contain_text("SCHOOL_PPT")
    expect(page.locator("#rx-count")).to_have_text("2")
    expect(page.locator("#bad-count")).to_have_text("1")
    go(page, "observe")
    expect(page.locator("#temp-A")).to_have_text("25.4")
    expect(page.locator("#temp-B")).to_have_text("27.1")
    expect(page.locator("#source-text")).to_have_text("实测数据")
    go(page, "debug")
    page.locator("[data-command='FAN ON']").click()
    expect(page.get_by_role("dialog")).to_be_visible()
    expect(page.get_by_role("button", name="返回", exact=True)).to_be_focused()
    if out:
        page.screenshot(path=out / "confirm-fan.png")
    page.keyboard.press("Escape")
    assert page.evaluate("mockSerial.sent") == []
    page.locator("[data-command='FAN ON']").click()
    page.locator("#confirm-send").click()
    expect(page.locator("#fan-state")).to_have_text("板端：开")
    expect(page.locator("#command-result")).to_contain_text("板端已受理：FAN ON")
    assert page.evaluate("mockSerial.sent")[-1] == "FAN ON\n"
    page.locator("#scope").select_option("A")
    page.locator("[data-mist='ON']").click()
    page.locator("#confirm-send").click()
    expect(page.locator("#command-result")).to_contain_text("Arduino 拒绝命令")
    page.evaluate("mockSerial.ack = false")
    page.locator("[data-command='FAN OFF']").click()
    page.clock.run_for(4200)
    expect(page.locator("#command-result")).to_contain_text("回应超时")
    expect(page.locator("[data-mist='ON']")).to_be_disabled()
    page.evaluate("mockSerial.ack = true")
    page.locator("#stop-all").click()
    expect(page.locator("#command-result")).to_contain_text("已受理全部停止请求")
    expect(page.locator("#fan-state")).to_have_text("板端：关")
    page.locator("[data-command='STATUS']").click()
    expect(page.locator("#command-result")).to_contain_text("STATE 状态回报")
    expect(page.locator("[data-mist='ON']")).to_be_enabled()
    page.locator("[data-command='SCAN']").click()
    expect(page.locator("#scan-summary")).to_contain_text("CH0:0x62")
    page.locator("[data-mist-action='PULSE']").click()
    page.locator("#confirm-send").click()
    expect(page.locator("#mist-A")).to_contain_text("需同步")
    page.locator("[data-mist-action='SYNC ON']").click()
    page.locator("#confirm-send").click()
    expect(page.locator("#mist-A")).to_contain_text("板端：开")
    go(page, "records")
    page.locator("#run-start").click()
    page.clock.run_for(5500)
    send_from_mock(page, "DATA,10000,A,930,26.30,54.5,0,0\r\nDATA,10000,B,881,28.23,43.0,0,0\r\n")
    expect(page.locator("#record-stats")).to_contain_text("+1.0 °C")
    page.evaluate("mockSerial.drop()")
    expect(page.locator("#notice")).to_contain_text("USB 设备已拔出")
    expect(page.locator("#record-detail-sub")).to_contain_text("串口断开")
    assert page.evaluate("mockSerial.closeCount") == 1
    page.reload()
    expect(page.locator("#archive-list")).to_contain_text("串口断开")
    expect(page.locator("#records-source")).to_contain_text("实测")
    with page.expect_download() as info:
        page.locator("#export-csv").click()
    assert "ARDUINO" in info.value.suggested_filename and '"live"' in info.value.path().read_text(encoding="utf-8-sig")
    # School firmware remains read-only, including after a new connection from an existing record.
    page.locator("#connect").click()
    expect(page.locator("#source-text")).to_have_text("等待采样")
    send_from_mock(page, "SCD4x Example\r\n\r\nCO2(ppm):647\tTemperature(C):25.2\tHumidity(%RH):43.1\r\n")
    go(page, "observe")
    expect(page.locator("#temp-A")).to_have_text("25.2")
    expect(page.locator("#bay-B")).to_be_hidden()
    go(page, "debug")
    expect(page.locator("#debug-profile")).to_contain_text("学校原版 / 只读")
    expect(page.locator("#send-command")).to_be_disabled()
    expect(page.locator("#stop-all")).to_be_disabled()
    go(page, "observe")
    page.clock.run_for(16_000)
    expect(page.locator("#health-A")).to_contain_text("等待新读数")
    expect(page.locator("#bay-A")).to_have_attribute("data-fresh", "false")
    go(page, "debug")
    page.locator("#connect").click()
    expect(page.locator("#port-state")).to_have_text("未连接")
    assert not errors, errors
    context.close()


def viewports(browser, out):
    for name, w, h in [("desktop", 1440, 900), ("laptop", 1366, 768), ("mobile", 390, 844), ("small", 320, 760)]:
        context = browser.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce")
        page, errors = setup(context)
        for view in ["observe", "records", "debug"]:
            if view != "observe":
                go(page, view)
            assert page.evaluate("innerWidth") == w
            assert page.evaluate("document.documentElement.scrollWidth") == w
            assert page.evaluate("matchMedia('(max-width: 520px)').matches") == (w <= 520)
            if out and name != "small":
                page.screenshot(path=out / f"{view}-{name}.png", full_page=name == "mobile")
        assert not errors, errors
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        demo_journey(browser, args.screenshots)
        serial_journey(browser, args.screenshots)
        viewports(browser, args.screenshots)
        browser.close()
    print("Browser checks passed: demo, downloads, mock serial, reconnect, archive, and four viewport widths.")


if __name__ == "__main__":
    main()

/*
 * =====================================================================
 *  双舱温室控制程序  GreenhouseDual  v1.1（兼容学校 PPT 单侧接线 & 双舱扩展）
 * =====================================================================
 *  主板：Arduino Nano v3.0（ATmega328P，5 V，CH340 串口芯片）
 *  依据：学校课件《Arduino - 2026版.pptx》/ greenHouse.ino、《双舱温室电路设计最终稿》
 *
 *  接线模式选择（见下方 1.1 配置区 WIRING_PROFILE）：
 *   1) WIRING_SCHOOL_PPT（默认，明天实验室单侧测试按此接线）：
 *      - SCD40 (单颗) → A4 (SDA) / A5 (SCL)，5 V，GND
 *      - 0.96 寸六针 OLED（无 CS）→ D13 (SCK), D11 (SDA/MOSI), D8 (RES), D9 (DC)
 *      - 风扇继电器 CH1 → D2
 *      - 雾化器三极管 B → D3（经基极限流电阻）
 *      - 预留雾化器 B   → D6（暂不接）
 *   2) WIRING_FINAL_PDF（双舱完整器材到齐后可切换，或沿用 D2/D3/D6）：
 *      - TCA9548A (0x70) → A4 / A5，CH0=A 舱 SCD40，CH1=B 舱 SCD40
 *      - 风扇继电器 K1 → D3，雾化器 A → D4，雾化器 B → D6
 *   * 没接 TCA9548A 时自动进入“单传感器模式”：主总线上的 SCD40 作为 A 通道，
 *     OLED 自动切换为全屏单区大字排版；接上 TCA9548A 后自动切换为双舱分栏。
 *
 *  需要的库（库管理器安装）：SparkFun SCD4x Arduino Library、U8g2（Wire、SPI 为自带库）
 *
 *  ---------------- 串口协议（115200 波特率，每条命令以换行结束） ----------------
 *  串口监视器右下角请选 “换行 / New Line”。命令不区分大小写，A/B 不写 = 全部可用舱。
 *    HELP                        显示命令列表
 *    STATUS                      输出一行 STATE 状态
 *    SCAN                        扫描 I2C 总线（排查 0x62 / 0x70 接线）
 *    STOP                        全部关闭：关雾化、关风扇、取消自动加湿
 *    MIST [A|B] ON|OFF           雾化器（手动命令会取消该舱的自动加湿）
 *    FAN  ON|OFF                 风扇继电器开关
 *    RH   [A|B] <目标%> | OFF    自动加湿：低于 目标-回差 开雾化，达到目标关
 *    PULSE [A|B]                 （按键式雾化器）手动“按一下”，单传感模式可省略 A
 *    SYNC  [A|B] ON|OFF          （按键式雾化器）告诉程序雾化器的实际状态（不发脉冲）
 *
 *  输出行（以第一个字段区分，电脑端按逗号拆分即可；以 # 开头的是给人看的说明）
 *    DATA,ms,chamber,co2_ppm,temp_C,rh_pct,mist,fan
 *    EVT,ms,device,chamber,value,note
 *    STATE,ms,mistA,mistB,fan,rhTargetA,rhTargetB,onlineA,onlineB
 *    OK,<命令> / ERR,<原因>
 *  注意：电脑每次打开串口都会让 Nano 复位，复位后所有设备回到关闭状态。
 * =====================================================================
 */

#include <Wire.h>
#include <SPI.h>
#include <U8g2lib.h>
#include <SparkFun_SCD4x_Arduino_Library.h>

// ============================ 1. 配置区（按实物修改） ============================

// ---- 1.1 接线方案选择：默认按学校 PPT 接线（风扇 D2、雾化 D3） ----
#define WIRING_SCHOOL_PPT  1   // 学校 PPT 接线：风扇 D2，雾化 A D3，雾化 B 预留 D6
#define WIRING_FINAL_PDF   2   // 最终双舱稿接线：风扇 D3，雾化 A D4，雾化 B D6
#define WIRING_PROFILE     WIRING_SCHOOL_PPT

#if WIRING_PROFILE == WIRING_SCHOOL_PPT
  #define PIN_FAN          2
  #define PIN_MIST_A       3
  #define PIN_MIST_B       6
  #define WIRING_TAG       "SCHOOL_PPT"
#elif WIRING_PROFILE == WIRING_FINAL_PDF
  #define PIN_FAN          3
  #define PIN_MIST_A       4
  #define PIN_MIST_B       6
  #define WIRING_TAG       "FINAL_PDF"
#else
  #error "Unknown WIRING_PROFILE"
#endif

#define PIN_OLED_DC   9
#define PIN_OLED_RST  8

// ---- 1.2 输出的“开”电平 ----
// 学校单路继电器与 S9013 三极管均为高电平触发 → HIGH；若换低电平触发继电器 → 改成 LOW
#define FAN_ON_LEVEL   HIGH
#define MIST_ON_LEVEL  HIGH   // 按键模式下表示“按下”的电平

// ---- 1.3 雾化器控制方式 ----
#define MIST_MODE_BUTTON  0   // 模拟按键（课件做法）：三极管 C/E 并在模块按键两端，发脉冲切换
#define MIST_MODE_LEVEL   1   // 电平控制：接驱动板 EN 或继电器通断供电，开=高 关=低
#define MIST_MODE  MIST_MODE_BUTTON

#define MIST_PULSES_TO_ON   1     // 关→开 要按几下（课件：1 下）
#define MIST_PULSES_TO_OFF  2     // 开→关 要按几下（课件：2 下，中间经过“间歇喷雾”档）
#define MIST_PRESS_MS       200   // 每次按下保持时间
#define MIST_RELEASE_MS     200   // 两次按键之间松开的时间
#define MIST_MIN_SWITCH_MS  3000  // 两次开关动作之间的最短间隔，防止反复切换

// ---- 1.4 传感器 ----
#define MUX_ADDR         0x70     // TCA9548A
#define SCD4X_ADDR       0x62     // SCD40 固定地址
#define MUX_CH_A         0        // 左舱 A 接 TCA9548A 的通道
#define MUX_CH_B         1        // 右舱 B
// 自动自校准（ASC）会假设传感器定期接触 400 ppm 室外空气。实验中会往舱内加 CO2，
// 为了传感器在实验期间不“漂移校准”，默认关闭（只改传感器 RAM，不写入 EEPROM）。
#define SCD_AUTO_CALIBRATION  false
#define SENSOR_POLL_MS   1000     // 每 1 s 查询一次是否有新数据（SCD40 每 5 s 出一组）
#define SENSOR_STALE_MS  15000    // 超过 15 s 没有新数据 → 判定该舱传感器掉线
#define SENSOR_RETRY_MS  10000    // 掉线后每 10 s 尝试重新连接

// ---- 1.5 自动加湿 ----
#define RH_HYSTERESIS    2.0      // 回差：RH < 目标-2 开雾化，RH >= 目标 关雾化

// ---- 1.6 显示 ----
#define USE_OLED         1        // 不接 OLED 可改成 0
#define OLED_ROTATE_180  1        // 课件程序把屏幕旋转了 180°
#define OLED_REFRESH_MS  1000
#define LABEL_A          "WET"    // 屏幕上的舱名：A=湿海绵
#define LABEL_B          "CONC"   // B=混凝土

#define SERIAL_BAUD      115200

// ============================ 2. 全局对象与状态 ============================

#if USE_OLED
// 学校 0.96 寸六针屏无 CS：D13=SCK，D11=MOSI，D9=DC，D8=RES
U8G2_SSD1306_128X64_NONAME_1_4W_HW_SPI u8g2(
    U8G2_R0, U8X8_PIN_NONE, PIN_OLED_DC, PIN_OLED_RST);
#endif

struct Chamber {
  char     id;              // 'A' 或 'B'
  uint8_t  muxCh;
  uint8_t  mistPin;
  SCD4x    sensor;

  bool     online;          // 传感器已启动周期测量且未超时
  bool     hasData;         // 已经收到至少一组有效数据
  uint16_t co2;
  float    temp, rh;
  unsigned long lastDataMs, lastInitTryMs;

  bool     mistOn;          // 程序认为的雾化器实际状态
  bool     mistTarget;      // 希望达到的状态（由命令或自动加湿设置）
  bool     mistAfterPulses; // 当前这串按键脉冲结束后的状态
  uint8_t  mistEdgesLeft;   // 剩余电平跳变次数（按下、松开各算一次）
  unsigned long mistEdgeMs, mistLastSwitchMs;

  uint8_t  rhTarget;        // 自动加湿目标 %RH，0 = 关闭
};

Chamber cham[2];

bool muxPresent = false;
bool fanOn = false;

char    cmdBuf[48];
uint8_t cmdLen = 0;
bool    cmdOverflow = false;

unsigned long lastPollMs = 0;
unsigned long lastOledMs = 0;

// ============================ 3. 基础工具函数 ============================

void writeOutput(uint8_t pin, bool on, uint8_t onLevel) {
  digitalWrite(pin, on ? onLevel : (onLevel == HIGH ? LOW : HIGH));
}

// 先写“关”电平再设为输出，避免上电瞬间误动作
void initOutput(uint8_t pin, uint8_t onLevel) {
  writeOutput(pin, false, onLevel);
  pinMode(pin, OUTPUT);
}

bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// 打开 TCA9548A 上对应舱的通道（每次只开一路）
bool selectChamber(uint8_t i) {
  if (!muxPresent) return i == 0;          // 单传感器模式：只有 A 通道
  Wire.beginTransmission(MUX_ADDR);
  Wire.write((uint8_t)(1 << cham[i].muxCh));
  return Wire.endTransmission() == 0;
}

// 事件行的前半部分：EVT,ms,device,chamber,
void evtHead(const __FlashStringHelper *device, char chamberId) {
  Serial.print(F("EVT,"));
  Serial.print(millis());
  Serial.print(',');
  Serial.print(device);
  Serial.print(',');
  Serial.print(chamberId);
  Serial.print(',');
}

void printOnOffEvt(const __FlashStringHelper *device, char chamberId, bool on,
                   const __FlashStringHelper *note) {
  evtHead(device, chamberId);
  Serial.print(on ? F("ON,") : F("OFF,"));
  if (note) Serial.print(note);
  Serial.println();
}

// ============================ 4. 执行器：风扇 / 雾化器 ============================

void setFan(bool on) {
  if (fanOn == on) return;
  fanOn = on;
  writeOutput(PIN_FAN, on, FAN_ON_LEVEL);
  printOnOffEvt(F("FAN"), '-', on, NULL);
}

// ---- 雾化器 ----
// 按键模式下程序无法直接“看到”雾化器是否在喷，只能记住自己按了几下。
// 所以：上电默认认为是关闭的；如果实际状态和程序记录不一致，用 SYNC 命令纠正。

void startMistPulses(Chamber &c, uint8_t presses, bool stateAfter) {
  c.mistAfterPulses = stateAfter;
  c.mistEdgesLeft = presses * 2;               // 每按一次 = 按下 + 松开
  writeOutput(c.mistPin, true, MIST_ON_LEVEL); // 第一次按下
  c.mistEdgesLeft--;
  c.mistEdgeMs = millis();
}

bool anyMistBusy() {
  return cham[0].mistEdgesLeft > 0 || cham[1].mistEdgesLeft > 0;
}

// 每次 loop 调用：推进按键脉冲（不阻塞），并让实际状态追上目标状态
void updateMist(Chamber &c) {
  unsigned long now = millis();

#if MIST_MODE == MIST_MODE_BUTTON
  if (c.mistEdgesLeft > 0) {
    bool pressed = (c.mistEdgesLeft % 2 == 1);  // 剩余奇数个跳变 = 当前处于按下状态
    if (now - c.mistEdgeMs >= (pressed ? MIST_PRESS_MS : MIST_RELEASE_MS)) {
      writeOutput(c.mistPin, !pressed, MIST_ON_LEVEL);
      c.mistEdgesLeft--;
      c.mistEdgeMs = now;
      if (c.mistEdgesLeft == 0) {               // 这一串脉冲结束
        bool changed = (c.mistOn != c.mistAfterPulses);
        c.mistOn = c.mistAfterPulses;
        c.mistLastSwitchMs = now;
        if (changed) printOnOffEvt(F("MIST"), c.id, c.mistOn, NULL);
      }
    }
    return;
  }
  if (c.mistTarget != c.mistOn && now - c.mistLastSwitchMs >= MIST_MIN_SWITCH_MS) {
    startMistPulses(c, c.mistTarget ? MIST_PULSES_TO_ON : MIST_PULSES_TO_OFF, c.mistTarget);
  }
#else
  if (c.mistTarget != c.mistOn && now - c.mistLastSwitchMs >= MIST_MIN_SWITCH_MS) {
    c.mistOn = c.mistTarget;
    writeOutput(c.mistPin, c.mistOn, MIST_ON_LEVEL);
    c.mistLastSwitchMs = now;
    printOnOffEvt(F("MIST"), c.id, c.mistOn, NULL);
  }
#endif
}

// ============================ 5. 传感器 ============================

// 连接并配置传感器（不启动测量）。begin() 内部约阻塞 0.6 s。
bool initSensor(uint8_t i) {
  Chamber &c = cham[i];
  c.lastInitTryMs = millis();
  if (!muxPresent) muxPresent = i2cPresent(MUX_ADDR);   // 允许之后再插上 TCA9548A
  if (!selectChamber(i) || !i2cPresent(SCD4X_ADDR)) return false;
  return c.sensor.begin(Wire, false, SCD_AUTO_CALIBRATION);
}

bool startSensor(uint8_t i) {
  Chamber &c = cham[i];
  if (!selectChamber(i) || !c.sensor.startPeriodicMeasurement()) return false;
  c.online = true;
  c.hasData = false;
  c.lastDataMs = millis();
  return true;
}

void markLost(Chamber &c) {
  c.online = false;
  c.hasData = false;
  c.lastInitTryMs = millis();
  evtHead(F("SENSOR"), c.id);
  Serial.println(F("LOST,"));
  // 没有读数就不能做自动加湿，安全起见先关掉雾化器（自动目标保留，传感器恢复后继续）
  if (c.rhTarget) c.mistTarget = false;
}

void printData(const Chamber &c) {
  Serial.print(F("DATA,"));
  Serial.print(c.lastDataMs);
  Serial.print(',');
  Serial.print(c.id);
  Serial.print(',');
  Serial.print(c.co2);
  Serial.print(',');
  Serial.print(c.temp, 2);
  Serial.print(',');
  Serial.print(c.rh, 1);
  Serial.print(',');
  Serial.print(c.mistOn ? 1 : 0);
  Serial.print(',');
  Serial.println(fanOn ? 1 : 0);
}

void autoHumidity(Chamber &c) {
  if (c.rhTarget == 0 || !c.online || !c.hasData) return;
  if (c.rh < c.rhTarget - RH_HYSTERESIS) c.mistTarget = true;
  else if (c.rh >= c.rhTarget)           c.mistTarget = false;
}

void onNewData(Chamber &c) {
  autoHumidity(c);
}

void pollSensors() {
  unsigned long now = millis();
  uint8_t limit = muxPresent ? 2 : 1;
  for (uint8_t i = 0; i < limit; i++) {
    Chamber &c = cham[i];

    if (!c.online) {
      // 重连时 begin() 会阻塞约 0.6 s，避开雾化器按键脉冲进行中的时刻
      if (now - c.lastInitTryMs >= SENSOR_RETRY_MS && !anyMistBusy()) {
        if (initSensor(i) && startSensor(i)) {
          evtHead(F("SENSOR"), c.id);
          Serial.println(F("ONLINE,"));
        }
      }
      continue;
    }

    if (selectChamber(i) && c.sensor.readMeasurement()) {
      uint16_t co2 = c.sensor.getCO2();
      float temp = c.sensor.getTemperature();
      float rh   = c.sensor.getHumidity();
      if (co2 > 0 && !isnan(temp) && !isnan(rh)) {
        c.co2  = co2;
        c.temp = temp;
        c.rh   = rh;
        c.hasData = true;
        c.lastDataMs = now;
        printData(c);
        onNewData(c);
      }
    } else if (now - c.lastDataMs >= SENSOR_STALE_MS) {
      markLost(c);
    }
  }
}

// ============================ 6. 串口命令 ============================

void printPinsBanner() {
  Serial.print(F("# PINS,profile=" WIRING_TAG ",fan=D"));
  Serial.print(PIN_FAN);
  Serial.print(F(",mistA=D"));
  Serial.print(PIN_MIST_A);
  Serial.print(F(",mistB=D"));
  Serial.print(PIN_MIST_B);
  Serial.println(F(",i2c=A4/A5,oled=D13/D11/D9/D8"));
}

void printHeader() {
  Serial.println(F("#COLS,DATA,ms,chamber,co2_ppm,temp_C,rh_pct,mist,fan"));
  Serial.println(F("#COLS,EVT,ms,device,chamber,value,note"));
  Serial.println(F("#COLS,STATE,ms,mistA,mistB,fan,rhTargetA,rhTargetB,onlineA,onlineB"));
}

void printHelp() {
  Serial.println(F("# Commands (A/B optional, default = all active chambers):"));
  Serial.println(F("#  HELP | STATUS | SCAN | STOP"));
  Serial.println(F("#  MIST [A|B] ON|OFF"));
  Serial.println(F("#  FAN  ON|OFF"));
  Serial.println(F("#  RH   [A|B] <1-95> | OFF   auto humidify"));
#if MIST_MODE == MIST_MODE_BUTTON
  Serial.println(F("#  PULSE [A|B]          one button press (test)"));
  Serial.println(F("#  SYNC  [A|B] ON|OFF   tell real mist state"));
#endif
  printHeader();
}

void printState() {
  Serial.print(F("STATE,"));
  Serial.print(millis());
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].mistOn ? 1 : 0); }
  Serial.print(',');
  Serial.print(fanOn ? 1 : 0);
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].rhTarget); }
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].online ? 1 : 0); }
  Serial.println();
}

void scanI2c() {
  muxPresent = i2cPresent(MUX_ADDR);
  Serial.print(F("# SCAN,mux="));
  Serial.print(muxPresent ? F("0x70") : F("NONE"));
  Serial.print(F(",main="));
  uint8_t found = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    if (i2cPresent(addr)) {
      if (found++) Serial.print(' ');
      Serial.print(F("0x"));
      if (addr < 16) Serial.print('0');
      Serial.print(addr, HEX);
    }
  }
  if (!found) Serial.print(F("NONE"));
  if (muxPresent) {
    for (uint8_t ch = 0; ch < 2; ch++) {
      Wire.beginTransmission(MUX_ADDR);
      Wire.write((uint8_t)(1 << ch));
      if (Wire.endTransmission() == 0) {
        Serial.print(F(",CH"));
        Serial.print(ch);
        Serial.print('=');
        Serial.print(i2cPresent(SCD4X_ADDR) ? F("0x62") : F("NONE"));
      }
    }
    Wire.beginTransmission(MUX_ADDR);
    Wire.write((uint8_t)0);
    Wire.endTransmission();
  }
  Serial.println();
}

void replyOk(const char *cmd) {
  Serial.print(F("OK,"));
  Serial.println(cmd);
}

void replyErr(const __FlashStringHelper *msg) {
  Serial.print(F("ERR,"));
  Serial.println(msg);
}

// ON/1 → 1，OFF/0 → 0，其它 → -1
int8_t parseOnOff(const char *t) {
  if (!t) return -1;
  if (!strcmp(t, "ON") || !strcmp(t, "1")) return 1;
  if (!strcmp(t, "OFF") || !strcmp(t, "0")) return 0;
  return -1;
}

// 解析可选的舱号参数，返回位掩码：1=A，2=B，3=两舱；识别到舱号时 k 前进一位
uint8_t parseChambers(char *tok[], uint8_t n, uint8_t &k) {
  if (k >= n) return 3;
  const char *t = tok[k];
  if (!strcmp(t, "A")) { k++; return 1; }
  if (!strcmp(t, "B")) { k++; return 2; }
  if (!strcmp(t, "AB") || !strcmp(t, "BOTH") || !strcmp(t, "ALL")) { k++; return 3; }
  return 3;
}

void cancelAutoRh(Chamber &c) {
  if (c.rhTarget == 0) return;
  c.rhTarget = 0;
  evtHead(F("AUTO_RH"), c.id);
  Serial.println(F("OFF,MANUAL"));
}

void allStop() {
  setFan(false);
  for (uint8_t i = 0; i < 2; i++) {
    cancelAutoRh(cham[i]);
    cham[i].mistTarget = false;
  }
  evtHead(F("ALL"), '-');
  Serial.println(F("STOP,"));
}

void handleCommand(char *line) {
  char *tok[4];
  uint8_t n = 0;
  for (char *p = strtok(line, " ,\t"); p && n < 4; p = strtok(NULL, " ,\t")) tok[n++] = p;
  if (n == 0) return;
  const char *cmd = tok[0];
  uint8_t k = 1;

  if (!strcmp(cmd, "HELP") || !strcmp(cmd, "?")) { printHelp(); return; }
  if (!strcmp(cmd, "STATUS")) { printState(); return; }
  if (!strcmp(cmd, "SCAN"))   { scanI2c(); replyOk(cmd); return; }
  if (!strcmp(cmd, "STOP"))   { allStop(); replyOk(cmd); return; }

  if (!strcmp(cmd, "FAN")) {
    int8_t on = (n > 1) ? parseOnOff(tok[1]) : -1;
    if (on < 0) { replyErr(F("usage: FAN ON|OFF")); return; }
    setFan(on);
    replyOk(cmd);
    return;
  }

  if (!strcmp(cmd, "MIST")) {
    uint8_t mask = parseChambers(tok, n, k);
    int8_t on = (k < n) ? parseOnOff(tok[k]) : -1;
    if (on < 0) { replyErr(F("usage: MIST [A|B] ON|OFF")); return; }
    if (!muxPresent && mask == 2) {
      replyErr(F("single-sensor mode: chamber B unavailable"));
      return;
    }
    uint8_t activeMask = muxPresent ? mask : (on ? (mask & 1) : mask);
    for (uint8_t i = 0; i < 2; i++) {
      if (!(activeMask & (1 << i))) continue;
      cancelAutoRh(cham[i]);              // 手动命令优先，取消自动加湿
      cham[i].mistTarget = on;
    }
    replyOk(cmd);
    return;
  }

  if (!strcmp(cmd, "RH")) {
    uint8_t mask = parseChambers(tok, n, k);
    if (k >= n) { replyErr(F("usage: RH [A|B] <1-95> | OFF")); return; }
    long v = !strcmp(tok[k], "OFF") ? 0 : strtol(tok[k], NULL, 10);
    if (v < 0 || v > 95 || (v == 0 && strcmp(tok[k], "OFF") && strcmp(tok[k], "0"))) {
      replyErr(F("target must be 1-95 or OFF"));
      return;
    }
    if (!muxPresent && mask == 2) {
      replyErr(F("single-sensor mode: chamber B unavailable"));
      return;
    }
    uint8_t activeMask = muxPresent ? mask : (v ? (mask & 1) : mask);
    for (uint8_t i = 0; i < 2; i++) {
      if (!(activeMask & (1 << i))) continue;
      Chamber &c = cham[i];
      c.rhTarget = (uint8_t)v;
      evtHead(F("AUTO_RH"), c.id);
      if (v) { Serial.print(v); Serial.println(','); }
      else   { Serial.println(F("OFF,CMD")); }
      if (v) autoHumidity(c);
      else   c.mistTarget = false;
    }
    replyOk(cmd);
    return;
  }

#if MIST_MODE == MIST_MODE_BUTTON
  if (!strcmp(cmd, "PULSE") || !strcmp(cmd, "SYNC")) {
    bool isPulse = (cmd[0] == 'P');
    uint8_t mask = parseChambers(tok, n, k);
    if (mask == 3) {
      if (!muxPresent) mask = 1;          // 单传感器模式下默认对 A 执行
      else { replyErr(F("choose one chamber: A or B")); return; }
    }
    if (!muxPresent && mask == 2) {
      replyErr(F("single-sensor mode: chamber B unavailable"));
      return;
    }
    Chamber &c = cham[mask == 1 ? 0 : 1];
    if (c.mistEdgesLeft) { replyErr(F("mist busy, try again")); return; }
    cancelAutoRh(c);
    if (isPulse) {
      startMistPulses(c, 1, c.mistOn);       // 只按一下，不改变程序记录的状态
      c.mistTarget = c.mistOn;
      evtHead(F("MIST"), c.id);
      Serial.println(F("PULSE,use SYNC if state changed"));
    } else {
      int8_t on = (k < n) ? parseOnOff(tok[k]) : -1;
      if (on < 0) { replyErr(F("usage: SYNC [A|B] ON|OFF")); return; }
      c.mistOn = c.mistTarget = on;
      evtHead(F("MIST"), c.id);
      Serial.println(on ? F("SYNC_ON,") : F("SYNC_OFF,"));
    }
    replyOk(cmd);
    return;
  }
#endif

  replyErr(F("unknown command, type HELP"));
}

void readSerial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (cmdOverflow) {
        replyErr(F("command too long"));
      } else if (cmdLen > 0) {
        cmdBuf[cmdLen] = '\0';
        handleCommand(cmdBuf);
      }
      cmdLen = 0;
      cmdOverflow = false;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = (char)toupper(ch);
    } else {
      cmdOverflow = true;
    }
  }
}

// ============================ 8. OLED 显示 ============================
#if USE_OLED

void drawChamberColumn(const Chamber &c, uint8_t x) {
  u8g2.setCursor(x, 8);
  u8g2.print(c.id);
  if (c.rhTarget) { u8g2.print(F(" RH>")); u8g2.print(c.rhTarget); }
  else            { u8g2.print(c.id == 'A' ? F(" " LABEL_A) : F(" " LABEL_B)); }

  if (!c.online) {
    u8g2.setCursor(x, 30);
    u8g2.print(F("NO SENSOR"));
  } else if (!c.hasData) {
    u8g2.setCursor(x, 30);
    u8g2.print(F("WAIT..."));
  } else {
    u8g2.setCursor(x, 19); u8g2.print(c.temp, 2); u8g2.print(F(" C"));
    u8g2.setCursor(x, 30); u8g2.print(c.rh, 1);   u8g2.print(F(" %RH"));
    u8g2.setCursor(x, 41); u8g2.print(c.co2);     u8g2.print(F(" ppm"));
  }

  u8g2.setCursor(x, 52);
  u8g2.print(c.mistOn ? F("M:ON ") : F("M:-- "));
  u8g2.print(fanOn ? F("F:ON") : F("F:--"));
}

void drawOledSingle(const Chamber &c) {
  u8g2.firstPage();
  do {
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.setCursor(0, 9);
    u8g2.print(F("1-ZONE " LABEL_A));
    u8g2.setCursor(76, 9);
    if (c.rhTarget) { u8g2.print(F("RH>")); u8g2.print(c.rhTarget); u8g2.print('%'); }
    else            { u8g2.print(F("A4/A5")); }
    u8g2.drawHLine(0, 12, 128);

    if (!c.online) {
      u8g2.setCursor(0, 27);
      u8g2.print(F("NO SCD40 (0x62)"));
      u8g2.setCursor(0, 40);
      u8g2.print(F("Check A4/A5 & 5V"));
    } else if (!c.hasData) {
      u8g2.setCursor(0, 27);
      u8g2.print(F("SCD40 Detected"));
      u8g2.setCursor(0, 40);
      u8g2.print(F("First data ~5 s..."));
    } else {
      u8g2.setCursor(0, 24); u8g2.print(F("Temp: ")); u8g2.print(c.temp, 2); u8g2.print(F(" C"));
      u8g2.setCursor(0, 35); u8g2.print(F("Humi: ")); u8g2.print(c.rh, 1);   u8g2.print(F(" %RH"));
      u8g2.setCursor(0, 46); u8g2.print(F("CO2 : ")); u8g2.print(c.co2);     u8g2.print(F(" ppm"));
    }

    u8g2.drawHLine(0, 52, 128);
    u8g2.setCursor(0, 63);
    u8g2.print(c.mistOn ? F("MIST:ON ") : F("MIST:OFF"));
    u8g2.setCursor(72, 63);
    u8g2.print(fanOn ? F("FAN:ON") : F("FAN:OFF"));
  } while (u8g2.nextPage());
}

void drawOledDual() {
  u8g2.firstPage();
  do {
    u8g2.setFont(u8g2_font_6x10_tr);
    drawChamberColumn(cham[0], 0);
    drawChamberColumn(cham[1], 67);
    u8g2.drawVLine(63, 0, 54);
    u8g2.drawHLine(0, 54, 128);

    u8g2.setCursor(0, 63);
    u8g2.print(fanOn ? F("FAN ON") : F("FAN OFF"));
    u8g2.setCursor(74, 63);
    u8g2.print(F("DUAL MUX"));
  } while (u8g2.nextPage());
}

void drawOled() {
  if (!muxPresent) drawOledSingle(cham[0]);
  else             drawOledDual();
}

#endif

// ============================ 9. setup / loop ============================

void setupChamber(uint8_t i, char id, uint8_t muxCh, uint8_t mistPin) {
  Chamber &c = cham[i];
  c.id = id;
  c.muxCh = muxCh;
  c.mistPin = mistPin;
  c.online = c.hasData = false;
  c.mistOn = c.mistTarget = false;
  c.mistEdgesLeft = 0;
  c.mistLastSwitchMs = millis() - MIST_MIN_SWITCH_MS;  // 上电后第一次开关不用等待
  c.rhTarget = 0;
}

void setup() {
  // 1) 第一件事：所有输出置为“关”
  initOutput(PIN_FAN,    FAN_ON_LEVEL);
  initOutput(PIN_MIST_A, MIST_ON_LEVEL);
  initOutput(PIN_MIST_B, MIST_ON_LEVEL);

  setupChamber(0, 'A', MUX_CH_A, PIN_MIST_A);
  setupChamber(1, 'B', MUX_CH_B, PIN_MIST_B);

  Serial.begin(SERIAL_BAUD);
  Serial.println(F("# GreenhouseDual v1.1 booting"));
  printPinsBanner();

#if USE_OLED
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH); // 六针 OLED 无 CS，锁定硬件 SPI SS 为输出高电平防止误入从机模式
  u8g2.begin();
  if (OLED_ROTATE_180) u8g2.setDisplayRotation(U8G2_R2);
  drawOled();
#endif

  Wire.begin();
#ifdef WIRE_HAS_TIMEOUT
  Wire.setWireTimeout(25000, true);   // I2C 卡死时 25 ms 超时并复位总线，避免程序挂起
#endif
  delay(1000);                        // SCD40 上电后约需 1 s 才能通信

  muxPresent = i2cPresent(MUX_ADDR);
  if (muxPresent) Serial.println(F("# TCA9548A found at 0x70"));
  else            Serial.println(F("# TCA9548A NOT found: single-sensor mode (main bus = chamber A)"));

  // 先分别配置传感器，再紧接着同时启动测量，让双舱采样时刻尽量对齐
  uint8_t limit = muxPresent ? 2 : 1;
  bool ok[2] = {false, false};
  for (uint8_t i = 0; i < limit; i++) ok[i] = initSensor(i);
  for (uint8_t i = 0; i < limit; i++) {
    if (ok[i]) ok[i] = startSensor(i);
    Serial.print(F("# chamber "));
    Serial.print(cham[i].id);
    Serial.println(ok[i] ? F(": SCD40 OK, first data in ~5 s")
                         : F(": SCD40 NOT found, will retry every 10 s"));
  }
  if (!muxPresent) {
    Serial.println(F("# chamber B: skipped (single-sensor mode)"));
  }

#if MIST_MODE == MIST_MODE_BUTTON
  Serial.println(F("# mist mode: BUTTON (assumes atomizers are OFF at power-up; fix with SYNC)"));
#else
  Serial.println(F("# mist mode: LEVEL"));
#endif
  printHelp();
  Serial.println(F("# ready"));
}

void loop() {
  readSerial();

  unsigned long now = millis();

  updateMist(cham[0]);
  updateMist(cham[1]);

  if (now - lastPollMs >= SENSOR_POLL_MS) {
    lastPollMs = now;
    pollSensors();
  }

#if USE_OLED
  if (now - lastOledMs >= OLED_REFRESH_MS) {
    lastOledMs = now;
    drawOled();
  }
#endif
}

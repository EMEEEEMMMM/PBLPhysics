/*
 * =====================================================================
 *  双舱温室控制程序  GreenhouseDual  v0.1（初版，尚未经实物通电验证）
 * =====================================================================
 *  主板：Arduino Nano v3.0（ATmega328P，5 V，CH340 串口芯片）
 *  依据：《双舱温室电路设计 v1》、课件 greenHouse.ino、Greenhouse Project 实验方案
 *
 *  功能
 *   1. 通过 TCA9548A 分别读取左舱 A、右舱 B 两颗 SCD40（同为 0x62 地址）的
 *      CO2 / 温度 / 相对湿度，每约 5 秒一组，经 USB 串口发给电脑记录。
 *   2. 串口命令控制：两盏卤素灯同步开关（带自动关灯计时）、两台雾化器、两台风扇。
 *   3. 自动加湿：设定目标湿度后，雾化器按阈值自动启停（带回差）。
 *   4. RUN 实验模式：记录基线温度 → 开灯 N 秒 → 自动关灯 → 输出两舱温升及差值。
 *   5. 安全：舱温超过 OVERHEAT_C 自动关灯；灯最长连续开 LAMP_MAX_S 秒；
 *      传感器掉线时停止该舱的自动加湿；上电所有输出默认关闭。
 *   6. 0.96 寸 OLED 同屏显示两舱读数和设备状态（可关闭）。
 *
 *  接线（Nano 引脚）
 *   A4 / A5   → TCA9548A SDA / SCL（A0/A1/A2 接地，地址 0x70）
 *               CH0 (SD0/SC0) → 左舱 A 的 SCD40；CH1 (SD1/SC1) → 右舱 B 的 SCD40
 *   D3        → 左舱 A 风扇驱动（MOSFET 栅极，经 100 Ω，10 kΩ 下拉）
 *   D4        → 左舱 A 雾化器（按键三极管基极 或 驱动板 EN，见 MIST_MODE）
 *   D5        → 右舱 B 风扇驱动
 *   D6        → 右舱 B 雾化器
 *   D7        → 卤素灯 MOSFET（两盏灯并联，同步开关）
 *   D13/D11/D10/D9/D8 → OLED 的 D0(SCK)/D1(SDA)/CS/DC/RES（六针屏无 CS，D10 空着即可）
 *   没接 TCA9548A 时程序自动进入“单传感器模式”：主总线上的 SCD40 当作 A 舱，方便先台架测试。
 *
 *  需要的库（库管理器安装）：SparkFun SCD4x Arduino Library、U8g2（Wire、SPI 为自带库）
 *
 *  ---------------- 串口协议（115200 波特率，每条命令以换行结束） ----------------
 *  串口监视器右下角请选 “换行 / New Line”。命令不区分大小写，A/B 不写 = 两舱同时。
 *    HELP                        显示命令列表
 *    STATUS                      输出一行 STATE 状态
 *    STOP                        全部关闭：关灯、关雾化、关风扇、取消自动加湿和 RUN
 *    LAMP ON [秒] | LAMP OFF     开/关灯；不写秒数则按 LAMP_MAX_S 自动关
 *    RUN <秒>                    实验：取基线 → 开灯 <秒> → 关灯并输出 RESULT（需先关灯）
 *    MIST [A|B] ON|OFF           雾化器（手动命令会取消该舱的自动加湿）
 *    FAN  [A|B] ON|OFF           风扇
 *    RH   [A|B] <目标%> | OFF    自动加湿：低于 目标-回差 开雾化，达到目标关
 *    PULSE A|B                   （按键式雾化器）手动“按一下”，用于测试按键循环
 *    SYNC  A|B ON|OFF            （按键式雾化器）告诉程序雾化器的实际状态（不发脉冲）
 *
 *  输出行（以第一个字段区分，电脑端按逗号拆分即可；以 # 开头的是给人看的说明）
 *    DATA,ms,chamber,co2_ppm,temp_C,rh_pct,lamp,mist,fan
 *    EVT,ms,device,chamber,value,note
 *    RESULT,ms,duration_s,reason,A_T0,A_T1,A_dT,A_Tmax,B_T0,B_T1,B_dT,B_Tmax,dT_A_minus_B
 *    STATE,ms,lamp,lamp_left_s,mistA,mistB,fanA,fanB,rhTargetA,rhTargetB,onlineA,onlineB,run
 *    OK,<命令> / ERR,<原因>
 *  注意：电脑每次打开串口都会让 Nano 复位，复位后所有设备回到关闭状态。
 * =====================================================================
 */

#include <Wire.h>
#include <SPI.h>
#include <U8g2lib.h>
#include <SparkFun_SCD4x_Arduino_Library.h>

// ============================ 1. 配置区（按实物修改） ============================

// ---- 1.1 引脚：与《双舱温室电路设计 v1》接线表一致 ----
#define PIN_FAN_A     3
#define PIN_MIST_A    4
#define PIN_FAN_B     5
#define PIN_MIST_B    6
#define PIN_LAMP      7
#define PIN_OLED_CS   10
#define PIN_OLED_DC   9
#define PIN_OLED_RST  8

// ---- 1.2 输出的“开”电平 ----
// MOSFET、S9013 三极管、高电平触发继电器 → HIGH；低电平触发继电器 → 改成 LOW
#define FAN_ON_LEVEL   HIGH
#define LAMP_ON_LEVEL  HIGH
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
// 为了两颗传感器在实验期间不各自“漂移校准”，默认关闭（只改传感器 RAM，不写入 EEPROM）。
#define SCD_AUTO_CALIBRATION  false
#define SENSOR_POLL_MS   1000     // 每 1 s 查询一次是否有新数据（SCD40 每 5 s 出一组）
#define SENSOR_STALE_MS  15000    // 超过 15 s 没有新数据 → 判定该舱传感器掉线
#define SENSOR_RETRY_MS  10000    // 掉线后每 10 s 尝试重新连接

// ---- 1.5 自动加湿 ----
#define RH_HYSTERESIS    2.0      // 回差：RH < 目标-2 开雾化，RH >= 目标 关雾化

// ---- 1.6 安全 ----
#define OVERHEAT_C       50.0     // 任一舱温度 ≥ 此值，立即关灯
#define LAMP_MAX_S       3600UL   // 灯单次最长开启时间（秒）

// ---- 1.7 显示 ----
#define USE_OLED         1        // 不接 OLED 可改成 0
#define OLED_ROTATE_180  1        // 课件程序把屏幕旋转了 180°
#define OLED_REFRESH_MS  1000
#define LABEL_A          "WET"    // 屏幕上的舱名：A=湿海绵
#define LABEL_B          "DRY"    // B=干沙土 / 混凝土

#define SERIAL_BAUD      115200

// ============================ 2. 全局对象与状态 ============================

#if USE_OLED
// 与课件接线完全相同（D13=SCK，D11=MOSI），改用硬件 SPI 刷新更快；页缓冲模式只占 128 字节内存
U8G2_SSD1306_128X64_NONAME_1_4W_HW_SPI u8g2(U8G2_R0, PIN_OLED_CS, PIN_OLED_DC, PIN_OLED_RST);
#endif

struct Chamber {
  char     id;              // 'A' 或 'B'
  uint8_t  muxCh;
  uint8_t  fanPin, mistPin;
  SCD4x    sensor;

  bool     online;          // 传感器已启动周期测量且未超时
  bool     hasData;         // 已经收到至少一组有效数据
  uint16_t co2;
  float    temp, rh;
  unsigned long lastDataMs, lastInitTryMs;

  bool     fanOn;

  bool     mistOn;          // 程序认为的雾化器实际状态
  bool     mistTarget;      // 希望达到的状态（由命令或自动加湿设置）
  bool     mistAfterPulses; // 当前这串按键脉冲结束后的状态
  uint8_t  mistEdgesLeft;   // 剩余电平跳变次数（按下、松开各算一次）
  unsigned long mistEdgeMs, mistLastSwitchMs;

  uint8_t  rhTarget;        // 自动加湿目标 %RH，0 = 关闭

  float    runT0, runTmax;  // RUN 实验的基线温度和峰值温度
};

Chamber cham[2];

bool muxPresent = false;

bool lampOn = false;
unsigned long lampOffAtMs = 0;

bool runActive = false;
unsigned long runStartMs = 0;

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
  if (!muxPresent) return i == 0;          // 单传感器模式：只有 A 舱
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

void printMMSS(Print &out, unsigned long s) {
  unsigned long m = s / 60, sec = s % 60;
  if (m < 10) out.print('0');
  out.print(m);
  out.print(':');
  if (sec < 10) out.print('0');
  out.print(sec);
}

unsigned long lampSecondsLeft() {
  if (!lampOn) return 0;
  long left = (long)(lampOffAtMs - millis());
  return left > 0 ? (unsigned long)left / 1000UL : 0;
}

// ============================ 4. 执行器：风扇 / 灯 / 雾化器 ============================

void setFan(uint8_t i, bool on) {
  Chamber &c = cham[i];
  if (c.fanOn == on) return;
  c.fanOn = on;
  writeOutput(c.fanPin, on, FAN_ON_LEVEL);
  printOnOffEvt(F("FAN"), c.id, on, NULL);
}

void finishRun(const __FlashStringHelper *reason);

void lampOnFor(unsigned long seconds) {
  lampOn = true;
  writeOutput(PIN_LAMP, true, LAMP_ON_LEVEL);
  lampOffAtMs = millis() + seconds * 1000UL;
  evtHead(F("LAMP"), '-');
  Serial.print(F("ON,"));
  Serial.print(seconds);
  Serial.println('s');
}

void lampOff(const __FlashStringHelper *reason) {
  if (!lampOn) return;
  lampOn = false;
  writeOutput(PIN_LAMP, false, LAMP_ON_LEVEL);
  printOnOffEvt(F("LAMP"), '-', false, reason);
  if (runActive) finishRun(reason);
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
  Serial.print(lampOn ? 1 : 0);
  Serial.print(',');
  Serial.print(c.mistOn ? 1 : 0);
  Serial.print(',');
  Serial.println(c.fanOn ? 1 : 0);
}

void autoHumidity(Chamber &c) {
  if (c.rhTarget == 0 || !c.online || !c.hasData) return;
  if (c.rh < c.rhTarget - RH_HYSTERESIS) c.mistTarget = true;
  else if (c.rh >= c.rhTarget)           c.mistTarget = false;
}

void onNewData(Chamber &c) {
  // 过热保护
  if (lampOn && c.temp >= OVERHEAT_C) {
    evtHead(F("OVERHEAT"), c.id);
    Serial.print(c.temp, 2);
    Serial.println(F(",LAMP_OFF"));
    lampOff(F("OVERHEAT"));
  }
  // RUN 期间记录峰值温度
  if (runActive && (isnan(c.runTmax) || c.temp > c.runTmax)) c.runTmax = c.temp;

  autoHumidity(c);
}

void pollSensors() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < 2; i++) {
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
      c.co2  = c.sensor.getCO2();
      c.temp = c.sensor.getTemperature();
      c.rh   = c.sensor.getHumidity();
      c.hasData = true;
      c.lastDataMs = now;
      printData(c);
      onNewData(c);
    } else if (now - c.lastDataMs >= SENSOR_STALE_MS) {
      markLost(c);
    }
  }
}

// ============================ 6. RUN 实验 ============================

void startRun(unsigned long seconds) {
  runActive = true;
  runStartMs = millis();
  for (uint8_t i = 0; i < 2; i++) {
    Chamber &c = cham[i];
    c.runT0 = (c.online && c.hasData) ? c.temp : NAN;
    c.runTmax = c.runT0;
  }
  evtHead(F("RUN"), '-');
  Serial.print(F("START,"));
  Serial.print(seconds);
  Serial.println('s');
  Serial.print(F("# RUN baseline: A="));
  Serial.print(cham[0].runT0, 2);
  Serial.print(F(" C, B="));
  Serial.print(cham[1].runT0, 2);
  Serial.println(F(" C"));
  lampOnFor(seconds);
}

void finishRun(const __FlashStringHelper *reason) {
  runActive = false;
  unsigned long durS = (millis() - runStartMs) / 1000UL;
  float dT[2];

  Serial.print(F("RESULT,"));
  Serial.print(millis());
  Serial.print(',');
  Serial.print(durS);
  Serial.print(',');
  Serial.print(reason);
  for (uint8_t i = 0; i < 2; i++) {
    Chamber &c = cham[i];
    float t1 = (c.online && c.hasData) ? c.temp : NAN;
    dT[i] = t1 - c.runT0;                   // 任一为 NAN 结果也是 NAN
    Serial.print(',');  Serial.print(c.runT0, 2);
    Serial.print(',');  Serial.print(t1, 2);
    Serial.print(',');  Serial.print(dT[i], 2);
    Serial.print(',');  Serial.print(c.runTmax, 2);
  }
  Serial.print(',');
  Serial.println(dT[0] - dT[1], 2);

  Serial.print(F("# RUN finished ("));
  Serial.print(reason);
  Serial.print(F(") after "));
  Serial.print(durS);
  Serial.print(F(" s: rise A="));
  Serial.print(dT[0], 2);
  Serial.print(F(" K, B="));
  Serial.print(dT[1], 2);
  Serial.print(F(" K, A-B="));
  Serial.print(dT[0] - dT[1], 2);
  Serial.println(F(" K"));
}

// ============================ 7. 串口命令 ============================

void printHeader() {
  Serial.println(F("#COLS,DATA,ms,chamber,co2_ppm,temp_C,rh_pct,lamp,mist,fan"));
  Serial.println(F("#COLS,EVT,ms,device,chamber,value,note"));
  Serial.println(F("#COLS,RESULT,ms,duration_s,reason,A_T0,A_T1,A_dT,A_Tmax,B_T0,B_T1,B_dT,B_Tmax,dT_A_minus_B"));
  Serial.println(F("#COLS,STATE,ms,lamp,lamp_left_s,mistA,mistB,fanA,fanB,rhTargetA,rhTargetB,onlineA,onlineB,run"));
}

void printHelp() {
  Serial.println(F("# Commands (A/B optional, default = both chambers):"));
  Serial.println(F("#  HELP | STATUS | STOP"));
  Serial.println(F("#  LAMP ON [s] | LAMP OFF"));
  Serial.println(F("#  RUN <s>              baseline -> lamp on <s> -> RESULT"));
  Serial.println(F("#  MIST [A|B] ON|OFF"));
  Serial.println(F("#  FAN  [A|B] ON|OFF"));
  Serial.println(F("#  RH   [A|B] <1-95> | OFF   auto humidify"));
#if MIST_MODE == MIST_MODE_BUTTON
  Serial.println(F("#  PULSE A|B            one button press (test)"));
  Serial.println(F("#  SYNC A|B ON|OFF      tell real mist state"));
#endif
  printHeader();
}

void printState() {
  Serial.print(F("STATE,"));
  Serial.print(millis());
  Serial.print(',');
  Serial.print(lampOn ? 1 : 0);
  Serial.print(',');
  Serial.print(lampSecondsLeft());
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].mistOn ? 1 : 0); }
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].fanOn ? 1 : 0); }
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].rhTarget); }
  for (uint8_t i = 0; i < 2; i++) { Serial.print(','); Serial.print(cham[i].online ? 1 : 0); }
  Serial.print(',');
  Serial.println(runActive ? 1 : 0);
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
  lampOff(F("STOP"));
  for (uint8_t i = 0; i < 2; i++) {
    cancelAutoRh(cham[i]);
    cham[i].mistTarget = false;
    setFan(i, false);
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
  if (!strcmp(cmd, "STOP"))   { allStop(); replyOk(cmd); return; }

  if (!strcmp(cmd, "LAMP")) {
    int8_t on = (n > 1) ? parseOnOff(tok[1]) : -1;
    if (on < 0) { replyErr(F("usage: LAMP ON [s] | LAMP OFF")); return; }
    if (on == 0) { lampOff(F("CMD")); replyOk(cmd); return; }
    if (runActive) { replyErr(F("RUN in progress, use LAMP OFF or STOP")); return; }
    unsigned long s = (n > 2) ? strtoul(tok[2], NULL, 10) : LAMP_MAX_S;
    if (s < 1 || s > LAMP_MAX_S) { replyErr(F("seconds out of range")); return; }
    lampOnFor(s);
    replyOk(cmd);
    return;
  }

  if (!strcmp(cmd, "RUN")) {
    unsigned long s = (n > 1) ? strtoul(tok[1], NULL, 10) : 0;
    if (s < 1 || s > LAMP_MAX_S) { replyErr(F("usage: RUN <seconds>")); return; }
    if (lampOn) { replyErr(F("lamp is on, LAMP OFF and wait for baseline first")); return; }
    if (!cham[0].hasData && !cham[1].hasData) { replyErr(F("no sensor data yet")); return; }
    startRun(s);
    replyOk(cmd);
    return;
  }

  if (!strcmp(cmd, "MIST") || !strcmp(cmd, "FAN")) {
    bool isMist = (cmd[0] == 'M');
    uint8_t mask = parseChambers(tok, n, k);
    int8_t on = (k < n) ? parseOnOff(tok[k]) : -1;
    if (on < 0) { replyErr(F("usage: MIST|FAN [A|B] ON|OFF")); return; }
    for (uint8_t i = 0; i < 2; i++) {
      if (!(mask & (1 << i))) continue;
      if (isMist) {
        cancelAutoRh(cham[i]);              // 手动命令优先，取消自动加湿
        cham[i].mistTarget = on;
      } else {
        setFan(i, on);
      }
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
    for (uint8_t i = 0; i < 2; i++) {
      if (!(mask & (1 << i))) continue;
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
    if (mask == 3) { replyErr(F("choose one chamber: A or B")); return; }
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
      if (on < 0) { replyErr(F("usage: SYNC A|B ON|OFF")); return; }
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
  u8g2.print(c.fanOn ? F("F:ON") : F("F:--"));
}

void drawOled() {
  u8g2.firstPage();
  do {
    u8g2.setFont(u8g2_font_6x10_tr);
    drawChamberColumn(cham[0], 0);
    drawChamberColumn(cham[1], 67);
    u8g2.drawVLine(63, 0, 54);
    u8g2.drawHLine(0, 54, 128);

    u8g2.setCursor(0, 63);
    if (lampOn) {
      u8g2.print(runActive ? F("RUN  ") : F("LAMP "));
      printMMSS(u8g2, lampSecondsLeft());
    } else {
      u8g2.print(F("LAMP OFF"));
    }
    if (!muxPresent) {
      u8g2.setCursor(80, 63);
      u8g2.print(F("NO MUX"));
    }
  } while (u8g2.nextPage());
}

#endif

// ============================ 9. setup / loop ============================

void setupChamber(uint8_t i, char id, uint8_t muxCh, uint8_t fanPin, uint8_t mistPin) {
  Chamber &c = cham[i];
  c.id = id;
  c.muxCh = muxCh;
  c.fanPin = fanPin;
  c.mistPin = mistPin;
  c.online = c.hasData = false;
  c.fanOn = c.mistOn = c.mistTarget = false;
  c.mistEdgesLeft = 0;
  c.mistLastSwitchMs = millis() - MIST_MIN_SWITCH_MS;  // 上电后第一次开关不用等待
  c.rhTarget = 0;
  c.runT0 = c.runTmax = NAN;
}

void setup() {
  // 1) 第一件事：所有输出置为“关”
  initOutput(PIN_LAMP,   LAMP_ON_LEVEL);
  initOutput(PIN_FAN_A,  FAN_ON_LEVEL);
  initOutput(PIN_FAN_B,  FAN_ON_LEVEL);
  initOutput(PIN_MIST_A, MIST_ON_LEVEL);
  initOutput(PIN_MIST_B, MIST_ON_LEVEL);

  setupChamber(0, 'A', MUX_CH_A, PIN_FAN_A, PIN_MIST_A);
  setupChamber(1, 'B', MUX_CH_B, PIN_FAN_B, PIN_MIST_B);

  Serial.begin(SERIAL_BAUD);
  Serial.println(F("# GreenhouseDual v0.1 booting"));

#if USE_OLED
  u8g2.begin();
  if (OLED_ROTATE_180) u8g2.setDisplayRotation(U8G2_R2);
  drawOled();
#endif

  Wire.begin();
  Wire.setWireTimeout(25000, true);   // I2C 卡死时 25 ms 超时并复位总线，避免程序挂起
  delay(1000);                        // SCD40 上电后约需 1 s 才能通信

  muxPresent = i2cPresent(MUX_ADDR);
  if (muxPresent) Serial.println(F("# TCA9548A found at 0x70"));
  else            Serial.println(F("# TCA9548A NOT found: single-sensor mode (main bus = chamber A)"));

  // 先分别配置两颗传感器，再紧接着同时启动测量，让两舱的采样时刻尽量对齐
  bool ok[2];
  for (uint8_t i = 0; i < 2; i++) ok[i] = initSensor(i);
  for (uint8_t i = 0; i < 2; i++) {
    if (ok[i]) ok[i] = startSensor(i);
    Serial.print(F("# chamber "));
    Serial.print(cham[i].id);
    Serial.println(ok[i] ? F(": SCD40 OK, first data in ~5 s")
                         : F(": SCD40 NOT found, will retry every 10 s"));
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
  if (lampOn && (long)(now - lampOffAtMs) >= 0) lampOff(F("TIMER"));

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

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <PubSubClient.h>
#include <DFRobot_DHT20.h>
#include <BH1750.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "../include/secrets.h"
#include "../include/config.h"

// Disable brownout detector before RF/PSRAM power-up so cold plug-in always boots cleanly
extern "C" __attribute__((constructor(101))) void disableBrownoutEarly() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
}

namespace {

constexpr size_t MQTT_BUF_SIZE = 1024;
constexpr uint8_t LED_LEDC_CH = 2;  // Keep channel 0 / timer 0 exclusively for Camera XCLK

enum class LightMode : uint8_t { AUTO, MANUAL, ECO, EMERGENCY };
enum class CamMode : uint8_t { PERIODIC, CONTINUOUS, OFF };
enum ErrBits : uint8_t { ERR_NONE = 0, ERR_DHT = 1 << 0, ERR_LIGHT = 1 << 1, ERR_CAM = 1 << 2 };

struct JpegFrame {
  uint8_t* data = nullptr;
  size_t len = 0;
  camera_fb_t* fb = nullptr;
  bool allocated = false;
};

TwoWire& sensorWire = Wire;  // I2C_NUM_0 (GPIO13/14); Camera SCCB uses I2C_NUM_1 (GPIO26/27)
WiFiClient mqttNet;
PubSubClient mqtt(mqttNet);
DFRobot_DHT20 dht(&sensorWire, 0x38);
BH1750 light;

char gNodeId[40] = {};
char activeBackendUrl[160] = {};
char topicTelemetry[96] = {};
char topicControl[96] = {};
char otaUrl[192] = {};
char serialBuf[160] = {};
size_t serialLen = 0;

float temperature = NAN, humidity = NAN, lux = NAN;
bool presence = false, dhtReady = false, dhtOk = false;
bool lightReady = false, lightOk = false, cameraOk = false;
uint8_t bh1750Addr = 0x23;
uint16_t cameraPid = 0;
pixformat_t activePixFmt = PIXFORMAT_JPEG;

LightMode lightMode = LightMode::AUTO;
CamMode camMode = CamMode::PERIODIC;
uint8_t manualLedPct = 80;
uint8_t currentLedPct = 0;
float lightThreshLux = Defaults::DEFAULT_LIGHT_THRESHOLD_LUX;
uint32_t motionHoldMs = Defaults::DEFAULT_MOTION_HOLD_SEC * 1000UL;
uint32_t camIntervalMs = Defaults::DEFAULT_CAMERA_INTERVAL_SEC * 1000UL;

bool captureRequested = false;
bool pendingWebApproval = false;
bool otaRequested = false;
bool wifiWasConnected = false;
bool mdnsReady = false;
bool backendVerified = false;

uint32_t lastMotionAt = 0, lastSensorAt = 0, lastTelemetryAt = 0, lastOfflineLogAt = 0;
uint32_t lastCamAt = 0, lastWifiTryAt = 0, lastMqttTryAt = 0, lastDiscoveryAt = 0;

// ---------------- Helpers & NodeID ----------------

const char* modeToStr(LightMode m) {
  switch (m) {
    case LightMode::MANUAL:    return "MANUAL";
    case LightMode::ECO:       return "ECO";
    case LightMode::EMERGENCY: return "EMERGENCY";
    default:                   return "AUTO";
  }
}

bool isConfigured(const char* s) {
  return s && s[0] != '\0' && strncasecmp(s, "replace", 7) != 0 && strncasecmp(s, "your_", 5) != 0;
}

void copySafe(char* dst, size_t cap, const char* src) {
  if (!cap) return;
  if (!src) { dst[0] = '\0'; return; }
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

void initIdentityAndConfig() {
  if (isConfigured(NODE_ID) && strcasecmp(NODE_ID, "AUTO") != 0) {
    size_t j = 0;
    for (size_t i = 0; NODE_ID[i] != '\0' && j < sizeof(gNodeId) - 1; ++i) {
      const char c = NODE_ID[i];
      gNodeId[j++] = (isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-') ? c : '_';
    }
    gNodeId[j] = '\0';
  }
  if (gNodeId[0] == '\0') {
    const uint64_t mac = ESP.getEfuseMac();
    snprintf(gNodeId, sizeof(gNodeId), "node_%02x%02x%02x",
             static_cast<unsigned>((mac >> 24) & 0xFF),
             static_cast<unsigned>((mac >> 32) & 0xFF),
             static_cast<unsigned>((mac >> 40) & 0xFF));
  }

  copySafe(activeBackendUrl, sizeof(activeBackendUrl), BACKEND_URL);
  size_t n = strlen(activeBackendUrl);
  while (n > 0 && activeBackendUrl[n - 1] == '/') activeBackendUrl[--n] = '\0';

  snprintf(topicTelemetry, sizeof(topicTelemetry), "%s/feeds/viewstreet.telemetry", AIO_USERNAME);
  snprintf(topicControl, sizeof(topicControl), "%s/feeds/viewstreet.control", AIO_USERNAME);
}

// ---------------- Camera (OV2640 JPEG + RAW->JPEG Fallback) ----------------

bool tryCameraInit(pixformat_t fmt, framesize_t sz) {
  pinMode(Pins::CAM_PWDN, OUTPUT);
  digitalWrite(Pins::CAM_PWDN, HIGH);
  delay(15);
  digitalWrite(Pins::CAM_PWDN, LOW);
  delay(15);

  camera_config_t c{};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 5;  c.pin_d1 = 18; c.pin_d2 = 19; c.pin_d3 = 21;
  c.pin_d4 = 36; c.pin_d5 = 39; c.pin_d6 = 34; c.pin_d7 = 35;
  c.pin_xclk = 0; c.pin_pclk = 22; c.pin_vsync = 25; c.pin_href = 23;
  c.pin_sccb_sda = 26; c.pin_sccb_scl = 27; c.sccb_i2c_port = 1;
  c.pin_pwdn = Pins::CAM_PWDN; c.pin_reset = -1;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = fmt;
  c.frame_size = sz;
  c.jpeg_quality = 15;
  c.fb_count = (psramFound() && fmt == PIXFORMAT_JPEG) ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;

  if (esp_camera_init(&c) != ESP_OK) {
    esp_camera_deinit();
    return false;
  }
  activePixFmt = fmt;
  return true;
}

bool initCamera() {
  const framesize_t rawSz = psramFound() ? FRAMESIZE_QVGA : FRAMESIZE_QQVGA;
  const struct { pixformat_t fmt; framesize_t sz; } modes[] = {
    {PIXFORMAT_JPEG, FRAMESIZE_QVGA},
    {PIXFORMAT_RGB565, rawSz},
    {PIXFORMAT_YUV422, rawSz},
    {PIXFORMAT_GRAYSCALE, rawSz},
    {PIXFORMAT_RGB565, FRAMESIZE_QQVGA},
  };

  bool ok = false;
  for (const auto& m : modes) {
    if (tryCameraInit(m.fmt, m.sz)) { ok = true; break; }
  }
  if (!ok) return false;

  sensor_t* s = esp_camera_sensor_get();
  cameraPid = s ? s->id.PID : 0;
  for (int i = 0; i < 2; ++i) {
    if (camera_fb_t* fb = esp_camera_fb_get()) esp_camera_fb_return(fb);
    delay(25);
  }
  return true;
}

bool acquireJpeg(JpegFrame& out) {
  if (!cameraOk) return false;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return false;

  if (fb->format == PIXFORMAT_JPEG) {
    if (fb->len > 4 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8) {
      out = {fb->buf, fb->len, fb, false};
      return true;
    }
    esp_camera_fb_return(fb);
    return false;
  }

  uint8_t* buf = nullptr;
  size_t len = 0;
  const bool ok = frame2jpg(fb, 80, &buf, &len);
  esp_camera_fb_return(fb);
  if (!ok || !buf || len < 4) {
    free(buf);
    return false;
  }
  out = {buf, len, nullptr, true};
  return true;
}

void releaseJpeg(JpegFrame& out) {
  if (out.fb) esp_camera_fb_return(out.fb);
  if (out.allocated) free(out.data);
  out = {};
}

// ---------------- Sensors & Street-Light Control ----------------

bool i2cAck(uint8_t addr) {
  sensorWire.beginTransmission(addr);
  return sensorWire.endTransmission() == 0;
}

void applyLedOutput() {
  const bool recentMotion = presence || (lastMotionAt != 0 && (millis() - lastMotionAt < motionHoldMs));
  const bool isDark = !lightOk || (lux < lightThreshLux);

  switch (lightMode) {
    case LightMode::EMERGENCY: currentLedPct = 100; break;
    case LightMode::MANUAL:    currentLedPct = manualLedPct; break;
    case LightMode::ECO:       currentLedPct = isDark ? (recentMotion ? 70 : 15) : 0; break;
    default:                   currentLedPct = isDark ? (recentMotion ? 100 : 30) : 0; break;
  }
  if (Pins::STREET_LED >= 0) {
    ledcWriteChannel(LED_LEDC_CH, (static_cast<uint32_t>(currentLedPct) * 255U) / 100U);
  }
}

void initSensors() {
  sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
  sensorWire.setTimeOut(50);
  if (i2cAck(0x38)) {
    dhtReady = (dht.begin() == 0);
    sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
    sensorWire.setTimeOut(50);
  }
  if (i2cAck(0x23) || i2cAck(0x5C)) {
    bh1750Addr = i2cAck(0x23) ? 0x23 : 0x5C;
    lightReady = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, bh1750Addr, &sensorWire);
  }
}

void readSensors(uint32_t now) {
  if (lastSensorAt != 0 && now - lastSensorAt < Defaults::SENSOR_READ_INTERVAL_MS) return;
  lastSensorAt = now;

  presence = (digitalRead(Pins::PRESENCE) == (Pins::PRESENCE_ACTIVE_LOW ? LOW : HIGH));
  if (presence) lastMotionAt = now;

  if (i2cAck(0x38)) {
    if (!dhtReady) {
      dhtReady = (dht.begin() == 0);
      sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
      sensorWire.setTimeOut(50);
    }
    const float t = dht.getTemperature();
    const float rawH = dht.getHumidity();
    const float h = (isfinite(rawH) && rawH >= 0.0f && rawH <= 1.0f) ? (rawH * 100.0f) : rawH;
    dhtOk = isfinite(t) && isfinite(h) && t > -40.0f && t < 85.0f && h >= 0.0f && h <= 100.0f;
    if (dhtOk) { temperature = t; humidity = h; }
  } else {
    dhtReady = dhtOk = false;
  }

  if (i2cAck(bh1750Addr)) {
    if (!lightReady) lightReady = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, bh1750Addr, &sensorWire);
    if (lightReady) {
      const float lv = light.readLightLevel();
      lightOk = isfinite(lv) && lv >= 0.0f;
      if (lightOk) lux = lv;
    } else {
      lightOk = false;
    }
  } else {
    lightReady = lightOk = false;
  }

  applyLedOutput();
}

uint8_t currentErrorMask() {
  return (dhtOk ? 0 : ERR_DHT) | (lightOk ? 0 : ERR_LIGHT) | (cameraOk ? 0 : ERR_CAM);
}

void formatErrorStr(uint8_t mask, char* out, size_t cap) {
  if (mask == ERR_NONE) { copySafe(out, cap, "OK"); return; }
  snprintf(out, cap, "%s%s%s%s%s",
           (mask & ERR_DHT) ? "DHT20" : "",
           ((mask & ERR_DHT) && (mask & (ERR_LIGHT | ERR_CAM))) ? "," : "",
           (mask & ERR_LIGHT) ? "BH1750" : "",
           ((mask & ERR_LIGHT) && (mask & ERR_CAM)) ? "," : "",
           (mask & ERR_CAM) ? "CAMERA" : "");
}

// ---------------- Zero-Alloc JSON Field Parsers ----------------

bool jsonStr(const char* json, const char* key, char* out, size_t cap) {
  char pat[40];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  const char* p = strstr(json, pat);
  if (!p) return false;
  p = strchr(p + strlen(pat), ':');
  if (!p) return false;
  const char* q1 = strchr(p + 1, '"');
  if (!q1) return false;
  const char* q2 = strchr(q1 + 1, '"');
  if (!q2) return false;
  const size_t n = static_cast<size_t>(q2 - (q1 + 1));
  const size_t len = (n < cap - 1) ? n : (cap - 1);
  memcpy(out, q1 + 1, len);
  out[len] = '\0';
  return true;
}

bool jsonNum(const char* json, const char* key, float& outVal) {
  char pat[40];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  const char* p = strstr(json, pat);
  if (!p) return false;
  p = strchr(p + strlen(pat), ':');
  if (!p) return false;
  while (*++p == ' ' || *p == '\t') {}
  if ((*p < '0' || *p > '9') && *p != '-' && *p != '+') return false;
  outVal = strtof(p, nullptr);
  return true;
}

// ---------------- MQTT Sensor Telemetry & Control (Adafruit IO) ----------------

void applyConfigJson(const char* json) {
  char buf[128];
  if (jsonStr(json, "mode", buf, sizeof(buf))) {
    if (strcmp(buf, "MANUAL") == 0)         lightMode = LightMode::MANUAL;
    else if (strcmp(buf, "ECO") == 0)       lightMode = LightMode::ECO;
    else if (strcmp(buf, "EMERGENCY") == 0) lightMode = LightMode::EMERGENCY;
    else if (strcmp(buf, "AUTO") == 0)      lightMode = LightMode::AUTO;
  }
  if (jsonStr(json, "cameraMode", buf, sizeof(buf))) {
    if (strcmp(buf, "CONTINUOUS") == 0)    camMode = CamMode::CONTINUOUS;
    else if (strcmp(buf, "OFF") == 0)      camMode = CamMode::OFF;
    else if (strcmp(buf, "PERIODIC") == 0) camMode = CamMode::PERIODIC;
  }
  if (jsonStr(json, "backendUrl", buf, sizeof(buf)) && strncmp(buf, "http", 4) == 0) {
    copySafe(activeBackendUrl, sizeof(activeBackendUrl), buf);
    backendVerified = true;
  }

  float v = 0.0f;
  if (jsonNum(json, "ledLevel", v))       manualLedPct = static_cast<uint8_t>(constrain(v, 0.0f, 100.0f));
  if (jsonNum(json, "intervalSec", v))    camIntervalMs = static_cast<uint32_t>(constrain(v, 1.0f, 3600.0f)) * 1000UL;
  if (jsonNum(json, "lightThreshold", v) && v >= 0.0f && v <= 5000.0f) lightThreshLux = v;
  if (jsonNum(json, "motionHoldSec", v) && v >= 5.0f && v <= 600.0f)   motionHoldMs = static_cast<uint32_t>(v) * 1000UL;

  applyLedOutput();
}

void handleControl(const char* msg) {
  while (*msg == ' ') ++msg;
  if (*msg == '\0') return;

  if (*msg != '{') {
    if (strcasecmp(msg, "capture") == 0 || strcasecmp(msg, "snap") == 0) captureRequested = true;
    return;
  }

  char type[16] = {}, target[40] = {}, cmdId[40] = {}, cmd[32] = {};
  if (jsonStr(msg, "type", type, sizeof(type)) && strcmp(type, "ack") == 0) return;
  if (jsonStr(msg, "nodeId", target, sizeof(target)) && target[0] && strcmp(target, gNodeId) != 0) return;

  if (strcmp(type, "sync") == 0) {
    applyConfigJson(msg);
    return;
  }

  jsonStr(msg, "cmdId", cmdId, sizeof(cmdId));
  jsonStr(msg, "command", cmd, sizeof(cmd));
  bool ok = true;

  if (strcmp(cmd, "set_mode") == 0 || strcmp(cmd, "set_led") == 0 || strcmp(cmd, "set_threshold") == 0) {
    applyConfigJson(msg);
    lastTelemetryAt = 0;
  } else if (strcmp(cmd, "set_camera") == 0) {
    applyConfigJson(msg);
    if (camMode != CamMode::OFF) captureRequested = true;
  } else if (strcmp(cmd, "ota_update") == 0) {
    ok = jsonStr(msg, "url", otaUrl, sizeof(otaUrl)) &&
         (strncmp(otaUrl, "http://", 7) == 0 || strncmp(otaUrl, "https://", 8) == 0);
    if (ok) otaRequested = true;
  } else if (strcmp(cmd, "capture") == 0) {
    captureRequested = true;
  } else {
    ok = false;
  }

  if (cmdId[0] && mqtt.connected()) {
    char ack[160];
    snprintf(ack, sizeof(ack), "{\"type\":\"ack\",\"nodeId\":\"%s\",\"cmdId\":\"%s\",\"ok\":%s}",
             gNodeId, cmdId, ok ? "true" : "false");
    mqtt.publish(topicTelemetry, ack);
  }
}

void onMqttMessage(char* topic, uint8_t* payload, unsigned int len) {
  if (strcmp(topic, topicControl) != 0) return;
  char buf[384];
  const size_t n = (len < sizeof(buf) - 1) ? len : (sizeof(buf) - 1);
  memcpy(buf, payload, n);
  buf[n] = '\0';
  handleControl(buf);
}

bool publishTelemetry() {
  char errStr[24], sensorFields[80] = {};
  formatErrorStr(currentErrorMask(), errStr, sizeof(errStr));

  size_t off = 0;
  if (dhtOk) {
    off += snprintf(sensorFields + off, sizeof(sensorFields) - off,
                    ",\"temp\":%.1f,\"humi\":%.1f", temperature, humidity);
  }
  if (lightOk) {
    snprintf(sensorFields + off, sizeof(sensorFields) - off, ",\"light\":%.1f", lux);
  }

  const uint32_t totalHeap = ESP.getHeapSize();
  const uint8_t loadPct = totalHeap ? static_cast<uint8_t>(((totalHeap - ESP.getFreeHeap()) * 100U) / totalHeap) : 20;
  const int rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : -85;

  char json[280];
  snprintf(json, sizeof(json),
           "{\"nodeId\":\"%s\"%s,\"motion\":%u,\"bat\":100,\"rssi\":%d,"
           "\"load\":%u,\"mode\":\"%s\",\"ledLevel\":%u,\"error\":\"%s\"}",
           gNodeId, sensorFields, presence ? 1U : 0U, rssi,
           loadPct, modeToStr(lightMode), currentLedPct, errStr);

  if (!mqtt.connected()) {
    Serial.printf("[SENSOR] (offline) %s\n", json);
    return false;
  }
  const bool ok = mqtt.publish(topicTelemetry, json);
  Serial.printf("[SENSOR->AIO] %s | %s\n", ok ? "OK" : "FAIL", json);
  return ok;
}

// ---------------- Auto Backend Discovery & HTTP/HTTPS Camera Upload ----------------

bool checkBackendReachable(const char* baseUrl) {
  if (!isConfigured(baseUrl)) return false;
  char url[224];
  snprintf(url, sizeof(url), "%s/api/health", baseUrl);

  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(2500);

  WiFiClient net;
  WiFiClientSecure secNet;
  bool begun = false;
  if (strncmp(url, "https://", 8) == 0) {
    secNet.setInsecure();
    begun = http.begin(secNet, url);
  } else {
    begun = http.begin(net, url);
  }
  if (!begun) return false;

  http.addHeader("ngrok-skip-browser-warning", "1");
  const int code = http.GET();
  http.end();
  return code == 200;
}

void discoverBackendServer(bool force) {
  if (WiFi.status() != WL_CONNECTED) return;
  // Skip LAN mDNS probing if configured URL is already an external HTTPS domain (Ngrok/Cloudflare/Cloud)
  if (strncmp(activeBackendUrl, "https://", 8) == 0) {
    backendVerified = checkBackendReachable(activeBackendUrl);
    return;
  }

  const uint32_t now = millis();
  if (!force && backendVerified) return;
  if (!force && lastDiscoveryAt != 0 && (now - lastDiscoveryAt < 15000UL)) return;
  lastDiscoveryAt = now;

  if (checkBackendReachable(activeBackendUrl)) {
    backendVerified = true;
    return;
  }

  // 1. Check Gateway IP on Windows Mobile Hotspot / Phone Tethering (:3000)
  const IPAddress gw = WiFi.gatewayIP();
  if (gw[0] != 0) {
    char cand[64];
    snprintf(cand, sizeof(cand), "http://%u.%u.%u.%u:%u",
             gw[0], gw[1], gw[2], gw[3], Defaults::BACKEND_PORT);
    if (strcmp(cand, activeBackendUrl) != 0 && checkBackendReachable(cand)) {
      copySafe(activeBackendUrl, sizeof(activeBackendUrl), cand);
      backendVerified = true;
      Serial.printf("[SERVER] Found Backend at Gateway: %s\n", activeBackendUrl);
      return;
    }
  }

  // 2. Resolve Laptop Hostname via mDNS (<BACKEND_MDNS_HOST>.local, e.g. ADUY.local)
  if (!mdnsReady) mdnsReady = MDNS.begin(gNodeId);
  if (mdnsReady && Defaults::BACKEND_MDNS_HOST[0] != '\0') {
    const IPAddress ip = MDNS.queryHost(Defaults::BACKEND_MDNS_HOST, 1500);
    if (ip != INADDR_NONE && ip[0] != 0) {
      char cand[64];
      snprintf(cand, sizeof(cand), "http://%u.%u.%u.%u:%u",
               ip[0], ip[1], ip[2], ip[3], Defaults::BACKEND_PORT);
      copySafe(activeBackendUrl, sizeof(activeBackendUrl), cand);
      backendVerified = checkBackendReachable(activeBackendUrl);
      Serial.printf("[SERVER] Resolved %s.local -> %s\n", Defaults::BACKEND_MDNS_HOST, activeBackendUrl);
    }
  }
}

void uploadCameraFrame() {
  captureRequested = false;
  lastCamAt = millis();
  if (!cameraOk || WiFi.status() != WL_CONNECTED) return;

  if (!backendVerified) discoverBackendServer(false);
  if (!isConfigured(activeBackendUrl)) return;

  JpegFrame jpg;
  if (!acquireJpeg(jpg)) return;

  char url[256];
  snprintf(url, sizeof(url), "%s/api/camera/upload?nodeId=%s&type=image", activeBackendUrl, gNodeId);

  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(6000);

  WiFiClient net;
  WiFiClientSecure secNet;
  bool begun = false;
  if (strncmp(url, "https://", 8) == 0) {
    secNet.setInsecure();
    begun = http.begin(secNet, url);
  } else {
    begun = http.begin(net, url);
  }

  if (begun) {
    http.addHeader("Content-Type", "image/jpeg");
    http.addHeader("X-Node-Id", gNodeId);
    http.addHeader("ngrok-skip-browser-warning", "1");

    const int code = http.POST(jpg.data, jpg.len);
    http.end();

    if (code <= 0) {
      backendVerified = false;
      Serial.printf("[CAM->WEB] Unreachable (%s, err=%d) -> will retry/discover\n", activeBackendUrl, code);
    } else {
      backendVerified = true;
      pendingWebApproval = (code == 202);
      Serial.printf("[CAM->WEB] HTTP %d (%u B) -> %s\n", code, static_cast<unsigned>(jpg.len), activeBackendUrl);
    }
  }
  releaseJpeg(jpg);
}

// ---------------- Zero-Touch Automatic Wi-Fi & MQTT ----------------

void startWifiConnect(uint32_t now) {
  lastWifiTryAt = now;
  if (!isConfigured(WIFI_SSID)) {
    Serial.println("[WIFI] Set WIFI_SSID & WIFI_PASSWORD in include/secrets.h");
    return;
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (isConfigured(WIFI_PASSWORD) && WIFI_PASSWORD[0] != '\0') {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  } else {
    WiFi.begin(WIFI_SSID);
  }
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_15dBm);  // Called after WiFi.begin() to limit peak current on 5V supplies
  Serial.printf("[WIFI] Auto-connecting to '%s'...\n", WIFI_SSID);
}

void maintainNetwork(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.printf("[WIFI] Connected! IP=%s Gateway=%s RSSI=%d dBm\n",
                    WiFi.localIP().toString().c_str(),
                    WiFi.gatewayIP().toString().c_str(),
                    WiFi.RSSI());
      mdnsReady = MDNS.begin(gNodeId);
      discoverBackendServer(true);
      lastTelemetryAt = 0;      // Push sensor data immediately
      lastCamAt = 0;            // Push camera image immediately
      captureRequested = true;
    }

    if (!mqtt.connected() && isConfigured(AIO_USERNAME) && isConfigured(AIO_KEY) &&
        (lastMqttTryAt == 0 || now - lastMqttTryAt >= Defaults::MQTT_RETRY_INTERVAL_MS)) {
      lastMqttTryAt = now;
      char cid[64];
      snprintf(cid, sizeof(cid), "vs-%s-%04x", gNodeId, static_cast<unsigned>(random(0xFFFF)));
      if (mqtt.connect(cid, AIO_USERNAME, AIO_KEY)) {
        mqtt.subscribe(topicControl);
        lastTelemetryAt = 0;    // Immediately publish telemetry on MQTT connect
        Serial.printf("[MQTT] Connected to Adafruit IO -> %s\n", topicControl);
      } else {
        Serial.printf("[MQTT] Retry (rc=%d)\n", mqtt.state());
      }
    }
    if (mqtt.connected()) mqtt.loop();
    return;
  }

  wifiWasConnected = false;
  backendVerified = false;
  if (lastWifiTryAt == 0) {
    startWifiConnect(now);
  } else if (now - lastWifiTryAt >= Defaults::WIFI_CONNECT_TIMEOUT_MS) {
    WiFi.disconnect(false);
    delay(30);
    startWifiConnect(now);
  }
}

void pollSerial() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      serialBuf[serialLen] = '\0';
      if (strcasecmp(serialBuf, "STATUS") == 0) {
        Serial.printf("[STATUS] NodeID=%s WiFi=%s(%s) MQTT=%d Server=%s Cam=%d(0x%02X) DHT=%d LUX=%d\n",
                      gNodeId, WiFi.status() == WL_CONNECTED ? "OK" : "NO",
                      WiFi.localIP().toString().c_str(), mqtt.connected(),
                      activeBackendUrl, cameraOk, cameraPid, dhtOk, lightOk);
      } else if (strcasecmp(serialBuf, "CAPTURE") == 0) {
        captureRequested = true;
      } else if (strcasecmp(serialBuf, "TELEMETRY") == 0) {
        publishTelemetry();
      } else {
        handleControl(serialBuf);
      }
      serialLen = 0;
    } else if (serialLen < sizeof(serialBuf) - 1) {
      serialBuf[serialLen++] = c;
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  initIdentityAndConfig();
  randomSeed(static_cast<uint32_t>(ESP.getEfuseMac()) ^ micros());

  // Ensure GPIO0 internal pull-up is active before camera XCLK attaches
  pinMode(0, INPUT_PULLUP);
  pinMode(Pins::PRESENCE, INPUT_PULLUP);
  if (Pins::STREET_LED >= 0) {
    ledcAttachChannel(Pins::STREET_LED, 5000, 8, LED_LEDC_CH);
    ledcWriteChannel(LED_LEDC_CH, 0);
  }

  cameraOk = initCamera();
  initSensors();
  readSensors(millis());

  mqtt.setServer(Defaults::MQTT_HOST, Defaults::MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setSocketTimeout(4);
  mqtt.setBufferSize(MQTT_BUF_SIZE);

  Serial.printf("\n[BOOT] NodeID=%s | Cam=%s(0x%02X) | DHT20=%s | BH1750=%s\n",
                gNodeId, cameraOk ? "OK" : "FAIL", cameraPid,
                dhtOk ? "OK" : "NO", lightOk ? "OK" : "NO");

  // Immediately kick off Wi-Fi connection on power-on without waiting
  startWifiConnect(millis());
}

void loop() {
  const uint32_t now = millis();

  pollSerial();
  maintainNetwork(now);
  readSensors(now);

  // 1. Auto-publish Sensor Telemetry -> Adafruit IO (only advance lastTelemetryAt when MQTT is connected & published)
  if (mqtt.connected()) {
    if (lastTelemetryAt == 0 || (now - lastTelemetryAt >= Defaults::TELEMETRY_PUBLISH_INTERVAL_MS)) {
      if (publishTelemetry()) {
        lastTelemetryAt = now;
      } else {
        lastTelemetryAt = (now > 2000UL) ? (now - Defaults::TELEMETRY_PUBLISH_INTERVAL_MS + 2000UL) : 1UL;
      }
    }
  } else if (lastOfflineLogAt == 0 || (now - lastOfflineLogAt >= 10000UL)) {
    lastOfflineLogAt = now;
    publishTelemetry();
  }

  // 2. Auto-upload Camera JPEG -> Web Server via HTTP / HTTPS POST
  bool dueCam = captureRequested;
  if (!dueCam && cameraOk && WiFi.status() == WL_CONNECTED && camMode != CamMode::OFF) {
    const uint32_t interval = (camMode == CamMode::CONTINUOUS)
                                  ? (pendingWebApproval ? 10000UL : Defaults::CONTINUOUS_FRAME_INTERVAL_MS)
                                  : camIntervalMs;
    dueCam = (lastCamAt == 0) || (now - lastCamAt >= interval);
  }
  if (dueCam) {
    uploadCameraFrame();
  }

  if (otaRequested) {
    otaRequested = false;
    if (WiFi.status() == WL_CONNECTED && otaUrl[0]) {
      if (strncmp(otaUrl, "https://", 8) == 0) {
        WiFiClientSecure secOta;
        secOta.setInsecure();
        httpUpdate.update(secOta, otaUrl);
      } else {
        WiFiClient otaNet;
        httpUpdate.update(otaNet, otaUrl);
      }
    }
  }

  delay(5);
}

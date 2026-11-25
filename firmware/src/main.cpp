#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <PubSubClient.h>
#include <DFRobot_DHT20.h>
#include <BH1750.h>
#include "esp_camera.h"
#include "img_converters.h"
#include "mbedtls/base64.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "../include/secrets.h"
#include "../include/config.h"

namespace {

constexpr size_t MQTT_BUFFER_SIZE = 2048;
constexpr uint8_t STREET_LED_LEDC_CHANNEL = 2;  // Keep channel 0/timer 0 exclusively for Camera XCLK

// Use Wire (I2C_NUM_0) for external sensors (GPIO13/14) while Camera SCCB uses I2C_NUM_1 (GPIO26/27)
TwoWire& sensorWire = Wire;
WiFiClient mqttNetClient;
PubSubClient mqtt(mqttNetClient);
DFRobot_DHT20 dht(&sensorWire, 0x38);
BH1750 light;

// Unique identity of this ESP32 node
String gNodeId;

// Sensor states
float temperature = NAN;
float humidity = NAN;
float lux = NAN;
bool presence = false;
bool dhtReady = false;
bool dhtOk = false;
bool lightReady = false;
bool lightOk = false;
bool cameraOk = false;
uint8_t bh1750Addr = 0x23;
uint16_t cameraPid = 0;
pixformat_t activePixFormat = PIXFORMAT_JPEG;

// Control & operating states (synchronized with Backend controlService.js)
String lightingMode = "AUTO";       // AUTO | MANUAL | ECO | EMERGENCY
uint8_t manualLedLevel = 80;        // 0..100 (%)
uint8_t currentLedLevel = 0;        // Effective output 0..100 (%)
float lightThresholdLux = Defaults::DEFAULT_LIGHT_THRESHOLD_LUX;
uint32_t motionHoldMs = Defaults::DEFAULT_MOTION_HOLD_SEC * 1000UL;
uint32_t lastMotionDetectedAt = 0;

String cameraMode = "PERIODIC";     // PERIODIC | CONTINUOUS | OFF
uint32_t cameraIntervalMs = Defaults::DEFAULT_CAMERA_INTERVAL_SEC * 1000UL;
bool singleCaptureRequested = false;
bool nodePendingApprovalOnWeb = false;

// Pending OTA request
bool otaRequested = false;
String otaUrl;

// Timers
uint32_t lastSensorAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastCameraUploadAt = 0;
uint32_t lastWifiRetryAt = 0;
uint32_t lastMqttRetryAt = 0;

// ---------------- NodeID Identification ----------------

String sanitizeNodeId(const String& raw) {
  String out;
  out.reserve(raw.length());
  for (size_t i = 0; i < raw.length() && out.length() < 64; ++i) {
    const char c = raw[i];
    const bool valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '-';
    out += valid ? c : '_';
  }
  return out;
}

String resolveUniqueNodeId() {
  String configured(NODE_ID);
  configured.trim();
  if (configured.length() > 0 && !configured.equalsIgnoreCase("AUTO") &&
      !configured.equalsIgnoreCase("replace-me")) {
    String clean = sanitizeNodeId(configured);
    if (clean.length() > 0) return clean;
  }

  // Derive deterministic hardware-unique ID from ESP32 factory eFuse MAC
  const uint64_t efuseMac = ESP.getEfuseMac();
  char macSuffix[16];
  snprintf(macSuffix, sizeof(macSuffix), "node_%02x%02x%02x",
           static_cast<unsigned int>((efuseMac >> 24) & 0xFF),
           static_cast<unsigned int>((efuseMac >> 32) & 0xFF),
           static_cast<unsigned int>((efuseMac >> 40) & 0xFF));
  return String(macSuffix);
}

bool isConfiguredSecret(const char* val) {
  if (!val || strlen(val) == 0) return false;
  String s(val);
  s.trim();
  s.toLowerCase();
  return s.length() > 0 && !s.startsWith("replace") && !s.startsWith("your_");
}

String telemetryFeedTopic() {
  return String(AIO_USERNAME) + "/feeds/viewstreet.telemetry";
}

String controlFeedTopic() {
  return String(AIO_USERNAME) + "/feeds/viewstreet.control";
}

// ---------------- Street-Light LED Control ----------------

void applyLedOutput() {
  const uint32_t now = millis();
  const bool recentMotion = presence || (lastMotionDetectedAt != 0 && (now - lastMotionDetectedAt < motionHoldMs));
  const bool isDark = !lightOk || (lux < lightThresholdLux);

  if (lightingMode == "EMERGENCY") {
    currentLedLevel = 100;
  } else if (lightingMode == "MANUAL") {
    currentLedLevel = manualLedLevel;
  } else if (lightingMode == "ECO") {
    currentLedLevel = isDark ? (recentMotion ? 70 : 15) : 0;
  } else {
    // AUTO
    currentLedLevel = isDark ? (recentMotion ? 100 : 30) : 0;
  }

  if (Pins::STREET_LED >= 0) {
    const uint32_t duty = (static_cast<uint32_t>(currentLedLevel) * 255U) / 100U;
    ledcWriteChannel(STREET_LED_LEDC_CHANNEL, duty);
  }
}

// ---------------- Camera Init & JPEG Capture ----------------

struct JpegFrame {
  uint8_t* data = nullptr;
  size_t len = 0;
  size_t width = 0;
  size_t height = 0;
  camera_fb_t* fb = nullptr;
  bool allocated = false;
};

camera_config_t buildCameraConfig(pixformat_t pixFmt, framesize_t frameSize) {
  camera_config_t c{};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 5;
  c.pin_d1 = 18;
  c.pin_d2 = 19;
  c.pin_d3 = 21;
  c.pin_d4 = 36;
  c.pin_d5 = 39;
  c.pin_d6 = 34;
  c.pin_d7 = 35;
  c.pin_xclk = 0;
  c.pin_pclk = 22;
  c.pin_vsync = 25;
  c.pin_href = 23;
  c.pin_sccb_sda = 26;
  c.pin_sccb_scl = 27;
  c.sccb_i2c_port = 1;
  c.pin_pwdn = Pins::CAM_PWDN;
  c.pin_reset = -1;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = pixFmt;
  c.frame_size = frameSize;
  c.jpeg_quality = 15;
  c.fb_count = (psramFound() && pixFmt == PIXFORMAT_JPEG) ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  return c;
}

bool tryCameraMode(pixformat_t pixFmt, framesize_t frameSize) {
  pinMode(Pins::CAM_PWDN, OUTPUT);
  digitalWrite(Pins::CAM_PWDN, HIGH);
  delay(20);
  digitalWrite(Pins::CAM_PWDN, LOW);
  delay(20);

  camera_config_t cfg = buildCameraConfig(pixFmt, frameSize);
  if (esp_camera_init(&cfg) != ESP_OK) {
    esp_camera_deinit();
    return false;
  }
  activePixFormat = pixFmt;
  return true;
}

bool initCamera() {
  const bool hasPsram = psramFound();

  // 1. Hardware JPEG sensors (OV2640, OV3660, OV5640)
  bool ok = tryCameraMode(PIXFORMAT_JPEG, FRAMESIZE_QVGA);

  // 2. Fallback for sensors without hardware JPEG (GC2145, GC0308, OV7670, OV7725 -> error 0x106)
  if (!ok) {
    const framesize_t rawSize = hasPsram ? FRAMESIZE_QVGA : FRAMESIZE_QQVGA;
    ok = tryCameraMode(PIXFORMAT_RGB565, rawSize) ||
         tryCameraMode(PIXFORMAT_YUV422, rawSize) ||
         tryCameraMode(PIXFORMAT_GRAYSCALE, rawSize);
    if (!ok && rawSize != FRAMESIZE_QQVGA) {
      ok = tryCameraMode(PIXFORMAT_RGB565, FRAMESIZE_QQVGA) ||
           tryCameraMode(PIXFORMAT_YUV422, FRAMESIZE_QQVGA) ||
           tryCameraMode(PIXFORMAT_GRAYSCALE, FRAMESIZE_QQVGA);
    }
  }

  if (!ok) {
    Serial.println("[CAMERA] Init failed across all formats");
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  cameraPid = s ? s->id.PID : 0;
  Serial.printf("[CAMERA] Ready: PID=0x%02X mode=%s PSRAM=%s\n",
                cameraPid,
                activePixFormat == PIXFORMAT_JPEG ? "JPEG" : "RAW->JPEG",
                hasPsram ? "yes" : "no");

  // Discard initial frames so auto-exposure settles
  for (int i = 0; i < 2; ++i) {
    camera_fb_t* warm = esp_camera_fb_get();
    if (warm) esp_camera_fb_return(warm);
    delay(30);
  }
  return true;
}

bool acquireJpeg(JpegFrame& out) {
  if (!cameraOk) return false;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return false;

  out.width = fb->width;
  out.height = fb->height;

  if (fb->format == PIXFORMAT_JPEG) {
    if (fb->len > 4 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8) {
      out.data = fb->buf;
      out.len = fb->len;
      out.fb = fb;
      out.allocated = false;
      return true;
    }
    esp_camera_fb_return(fb);
    return false;
  }

  uint8_t* jpgBuf = nullptr;
  size_t jpgLen = 0;
  const bool converted = frame2jpg(fb, 80, &jpgBuf, &jpgLen);
  esp_camera_fb_return(fb);

  if (!converted || !jpgBuf || jpgLen < 4) {
    if (jpgBuf) free(jpgBuf);
    return false;
  }

  out.data = jpgBuf;
  out.len = jpgLen;
  out.fb = nullptr;
  out.allocated = true;
  return true;
}

void releaseJpeg(JpegFrame& out) {
  if (out.fb) {
    esp_camera_fb_return(out.fb);
    out.fb = nullptr;
  }
  if (out.allocated && out.data) {
    free(out.data);
    out.allocated = false;
  }
  out.data = nullptr;
  out.len = 0;
}

// ---------------- Sensors (DHT20, BH1750, Presence) ----------------

bool i2cDevicePresent(uint8_t addr) {
  sensorWire.beginTransmission(addr);
  return sensorWire.endTransmission() == 0;
}

void initSensors() {
  sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
  sensorWire.setTimeOut(50);

  if (i2cDevicePresent(0x38)) {
    dhtReady = (dht.begin() == 0);
    // Re-bind custom I2C pins after DFRobot_DHT20::begin() calls _pWire->begin()
    sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
    sensorWire.setTimeOut(50);
  } else {
    dhtReady = false;
  }

  if (i2cDevicePresent(0x23)) {
    bh1750Addr = 0x23;
    lightReady = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &sensorWire);
  } else if (i2cDevicePresent(0x5C)) {
    bh1750Addr = 0x5C;
    lightReady = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &sensorWire);
  } else {
    lightReady = false;
  }
}

void readSensors(uint32_t now) {
  if (lastSensorAt != 0 && now - lastSensorAt < Defaults::SENSOR_READ_INTERVAL_MS) return;
  lastSensorAt = now;

  presence = (digitalRead(Pins::PRESENCE) == (Pins::PRESENCE_ACTIVE_LOW ? LOW : HIGH));
  if (presence) {
    lastMotionDetectedAt = now;
  }

  // DHT20 temperature & humidity
  if (i2cDevicePresent(0x38)) {
    if (!dhtReady) {
      dhtReady = (dht.begin() == 0);
      sensorWire.begin(Pins::I2C_SDA, Pins::I2C_SCL, 100000);
      sensorWire.setTimeOut(50);
    }
    const float t = dht.getTemperature();
    const float rawH = dht.getHumidity();
    // DFRobot_DHT20 v1.0.0 returns 0.0..1.0 (rawData / 0x100000); convert to 0..100 %RH
    const float h = (isfinite(rawH) && rawH >= 0.0f && rawH <= 1.0f) ? (rawH * 100.0f) : rawH;
    dhtOk = isfinite(t) && isfinite(h) && t > -40.0f && t < 85.0f && h >= 0.0f && h <= 100.0f;
    if (dhtOk) {
      temperature = t;
      humidity = h;
    }
  } else {
    dhtReady = false;
    dhtOk = false;
  }

  // BH1750 ambient light sensor
  if (i2cDevicePresent(bh1750Addr)) {
    if (!lightReady) {
      lightReady = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, bh1750Addr, &sensorWire);
    }
    if (lightReady) {
      const float lv = light.readLightLevel();
      lightOk = isfinite(lv) && lv >= 0.0f;
      if (lightOk) lux = lv;
    } else {
      lightOk = false;
    }
  } else {
    lightReady = false;
    lightOk = false;
  }

  applyLedOutput();
}

// ---------------- Lightweight JSON Helpers ----------------

String jsonGetString(const String& json, const char* key) {
  String pat = String("\"") + key + "\"";
  int pos = json.indexOf(pat);
  if (pos < 0) return "";
  int colon = json.indexOf(':', pos + pat.length());
  if (colon < 0) return "";
  int q1 = json.indexOf('"', colon + 1);
  if (q1 < 0) return "";
  int q2 = json.indexOf('"', q1 + 1);
  if (q2 < 0) return "";
  return json.substring(q1 + 1, q2);
}

bool jsonGetNumber(const String& json, const char* key, float& outVal) {
  String pat = String("\"") + key + "\"";
  int pos = json.indexOf(pat);
  if (pos < 0) return false;
  int colon = json.indexOf(':', pos + pat.length());
  if (colon < 0) return false;
  int start = colon + 1;
  while (start < static_cast<int>(json.length()) && (json[start] == ' ' || json[start] == '\t')) ++start;
  if (start >= static_cast<int>(json.length())) return false;
  char c = json[start];
  if ((c < '0' || c > '9') && c != '-' && c != '+') return false;
  outVal = json.substring(start).toFloat();
  return true;
}

// ---------------- MQTT Control, ACK & Sensor Telemetry (Adafruit IO) ----------------

void publishControlAck(const String& cmdId, bool ok) {
  if (!mqtt.connected() || cmdId.length() == 0) return;
  char ackPayload[192];
  snprintf(ackPayload, sizeof(ackPayload),
           "{\"type\":\"ack\",\"nodeId\":\"%s\",\"cmdId\":\"%s\",\"ok\":%s}",
           gNodeId.c_str(), cmdId.c_str(), ok ? "true" : "false");
  mqtt.publish(telemetryFeedTopic().c_str(), ackPayload);
  Serial.printf("[MQTT] ACK sent: %s\n", ackPayload);
}

void applyDesiredConfigFields(const String& json) {
  String m = jsonGetString(json, "mode");
  if (m == "AUTO" || m == "MANUAL" || m == "ECO" || m == "EMERGENCY") {
    lightingMode = m;
  }

  float num = 0.0f;
  if (jsonGetNumber(json, "ledLevel", num)) {
    if (num < 0.0f) num = 0.0f;
    if (num > 100.0f) num = 100.0f;
    manualLedLevel = static_cast<uint8_t>(num);
  }

  String camMode = jsonGetString(json, "cameraMode");
  if (camMode == "PERIODIC" || camMode == "CONTINUOUS" || camMode == "OFF") {
    cameraMode = camMode;
  }

  if (jsonGetNumber(json, "intervalSec", num)) {
    if (num < 1.0f) num = 1.0f;
    if (num > 3600.0f) num = 3600.0f;
    cameraIntervalMs = static_cast<uint32_t>(num) * 1000UL;
  }

  if (jsonGetNumber(json, "lightThreshold", num)) {
    if (num >= 0.0f && num <= 5000.0f) lightThresholdLux = num;
  }

  if (jsonGetNumber(json, "motionHoldSec", num)) {
    if (num >= 5.0f && num <= 600.0f) motionHoldMs = static_cast<uint32_t>(num) * 1000UL;
  }

  applyLedOutput();
}

void handleControlMessage(const String& rawMsg) {
  String msg = rawMsg;
  msg.trim();
  if (msg.length() == 0) return;

  // Ignore ACK packets if echoed
  if (jsonGetString(msg, "type") == "ack") return;

  // Multi-node filter: only process messages addressed to this ESP32's NodeID (or broadcast without nodeId)
  if (msg.startsWith("{")) {
    String targetNode = jsonGetString(msg, "nodeId");
    if (targetNode.length() > 0 && targetNode != gNodeId) {
      return;
    }

    // Desired-state sync sent by backend when node wakes / reconnects
    if (jsonGetString(msg, "type") == "sync") {
      applyDesiredConfigFields(msg);
      Serial.printf("[CTRL] Synced state: mode=%s led=%u%% cam=%s(%lus)\n",
                    lightingMode.c_str(), manualLedLevel,
                    cameraMode.c_str(), static_cast<unsigned long>(cameraIntervalMs / 1000UL));
      return;
    }

    const String cmdId = jsonGetString(msg, "cmdId");
    const String command = jsonGetString(msg, "command");
    bool ok = true;

    if (command == "set_mode" || command == "set_led" || command == "set_threshold") {
      applyDesiredConfigFields(msg);
      lastTelemetryAt = 0;  // Publish updated state immediately
    } else if (command == "set_camera") {
      applyDesiredConfigFields(msg);
      if (cameraMode != "OFF") {
        singleCaptureRequested = true;
      }
    } else if (command == "ota_update") {
      String url = jsonGetString(msg, "url");
      if (url.startsWith("http://") || url.startsWith("https://")) {
        otaUrl = url;
        otaRequested = true;
      } else {
        ok = false;
      }
    } else if (command == "capture" || msg.indexOf("capture") >= 0) {
      singleCaptureRequested = true;
    } else {
      ok = false;
    }

    if (cmdId.length() > 0) {
      publishControlAck(cmdId, ok);
    }
    return;
  }

  // Plain-text fallback for manual testing on Adafruit IO feed
  String lower = msg;
  lower.toLowerCase();
  if (lower == "capture" || lower == "camera" || lower == "snap") {
    singleCaptureRequested = true;
  }
}

void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
  if (String(topic) != controlFeedTopic()) return;
  String msg;
  msg.reserve(length);
  for (unsigned int i = 0; i < length; ++i) {
    msg += static_cast<char>(payload[i]);
  }
  Serial.printf("[MQTT] Control Rx: %s\n", msg.c_str());
  handleControlMessage(msg);
}

String buildDeviceErrorString() {
  String err;
  if (!dhtOk) err += "DHT20";
  if (!lightOk) {
    if (err.length()) err += ",";
    err += "BH1750";
  }
  if (!cameraOk) {
    if (err.length()) err += ",";
    err += "CAMERA";
  }
  return err.length() > 0 ? err : String("OK");
}

uint8_t estimateNodeLoadPercent() {
  const uint32_t freeHeap = ESP.getFreeHeap();
  const uint32_t totalHeap = ESP.getHeapSize();
  if (totalHeap == 0) return 15;
  const uint32_t usedPct = ((totalHeap - freeHeap) * 100U) / totalHeap;
  return static_cast<uint8_t>(usedPct > 100U ? 100U : usedPct);
}

void publishSensorTelemetry() {
  const int rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : -85;
  const uint8_t loadPct = estimateNodeLoadPercent();
  const String errStr = buildDeviceErrorString();

  // Omit invalid sensor fields rather than sending null (so InfluxDB never converts null -> 0)
  String json = "{";
  json.reserve(280);
  json += "\"nodeId\":\"" + gNodeId + "\"";
  if (dhtOk) {
    json += ",\"temp\":" + String(temperature, 1);
    json += ",\"humi\":" + String(humidity, 1);
  }
  if (lightOk) {
    json += ",\"light\":" + String(lux, 1);
  }
  json += ",\"motion\":" + String(presence ? 1 : 0);
  json += ",\"bat\":100";
  json += ",\"rssi\":" + String(rssi);
  json += ",\"load\":" + String(loadPct);
  json += ",\"mode\":\"" + lightingMode + "\"";
  json += ",\"ledLevel\":" + String(currentLedLevel);
  json += ",\"error\":\"" + errStr + "\"";
  json += "}";

  if (!mqtt.connected()) {
    Serial.printf("[SENSOR->AIO] (MQTT offline) %s\n", json.c_str());
    return;
  }

  const String topic = telemetryFeedTopic();
  const bool ok = mqtt.publish(topic.c_str(), json.c_str());
  Serial.printf("[SENSOR->AIO] %s -> %s | %s\n", ok ? "OK" : "FAIL", topic.c_str(), json.c_str());
}

// ---------------- Direct HTTP Camera Upload to Web Server ----------------

void uploadCameraFrameToWeb() {
  singleCaptureRequested = false;
  lastCameraUploadAt = millis();

  if (!cameraOk) {
    Serial.println("[CAMERA->WEB] Skipped: camera not initialized");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CAMERA->WEB] Skipped: Wi-Fi disconnected");
    return;
  }
  if (!isConfiguredSecret(BACKEND_URL)) {
    Serial.println("[CAMERA->WEB] Skipped: set BACKEND_URL in firmware/include/secrets.h");
    return;
  }

  JpegFrame jpg;
  if (!acquireJpeg(jpg)) {
    Serial.println("[CAMERA->WEB] Failed to capture JPEG frame");
    return;
  }

  String baseUrl(BACKEND_URL);
  baseUrl.trim();
  while (baseUrl.endsWith("/")) baseUrl.remove(baseUrl.length() - 1);
  const String url = baseUrl + "/api/camera/upload?nodeId=" + gNodeId + "&type=image";

  WiFiClient httpNet;
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(5000);

  if (!http.begin(httpNet, url)) {
    releaseJpeg(jpg);
    Serial.printf("[CAMERA->WEB] Invalid URL: %s\n", url.c_str());
    return;
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Node-Id", gNodeId);

  const int status = http.POST(jpg.data, jpg.len);
  const String respBody = http.getString();
  http.end();

  if (status == 200) {
    nodePendingApprovalOnWeb = false;
    Serial.printf("[CAMERA->WEB] OK (HTTP 200): %ux%u, %u bytes -> %s\n",
                  static_cast<unsigned int>(jpg.width),
                  static_cast<unsigned int>(jpg.height),
                  static_cast<unsigned int>(jpg.len),
                  gNodeId.c_str());
  } else if (status == 202) {
    nodePendingApprovalOnWeb = true;
    Serial.printf("[CAMERA->WEB] Pending approval on Web Dashboard (HTTP 202) for NodeID='%s'\n",
                  gNodeId.c_str());
  } else {
    Serial.printf("[CAMERA->WEB] Upload failed (HTTP %d): %s\n", status, respBody.c_str());
  }

  releaseJpeg(jpg);
}

void runOtaUpdateIfRequested() {
  if (!otaRequested) return;
  otaRequested = false;
  if (WiFi.status() != WL_CONNECTED || otaUrl.length() == 0) return;

  Serial.printf("[OTA] Starting firmware update from %s ...\n", otaUrl.c_str());
  WiFiClient otaClient;
  t_httpUpdate_return ret = httpUpdate.update(otaClient, otaUrl);
  if (ret == HTTP_UPDATE_FAILED) {
    Serial.printf("[OTA] Failed (%d): %s\n",
                  httpUpdate.getLastError(),
                  httpUpdate.getLastErrorString().c_str());
  }
}

// ---------------- Network Connection Management ----------------

void maintainWifi(uint32_t now) {
  if (!isConfiguredSecret(WIFI_SSID)) {
    if (now - lastWifiRetryAt >= 10000) {
      lastWifiRetryAt = now;
      Serial.println("[WIFI] Please configure WIFI_SSID / WIFI_PASSWORD in firmware/include/secrets.h");
    }
    return;
  }
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiRetryAt != 0 && now - lastWifiRetryAt < Defaults::RECONNECT_INTERVAL_MS) return;

  lastWifiRetryAt = now;
  Serial.printf("[WIFI] Connecting to '%s'...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_15dBm);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainMqtt(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (!isConfiguredSecret(AIO_USERNAME) || !isConfiguredSecret(AIO_KEY)) {
    if (now - lastMqttRetryAt >= 10000) {
      lastMqttRetryAt = now;
      Serial.println("[MQTT] Please configure AIO_USERNAME / AIO_KEY in firmware/include/secrets.h");
    }
    return;
  }
  if (lastMqttRetryAt != 0 && now - lastMqttRetryAt < Defaults::RECONNECT_INTERVAL_MS) return;
  lastMqttRetryAt = now;

  const String clientId = "vs-" + gNodeId + "-" + String(random(0xFFFF), HEX);
  if (mqtt.connect(clientId.c_str(), AIO_USERNAME, AIO_KEY)) {
    const String ctrl = controlFeedTopic();
    mqtt.subscribe(ctrl.c_str());
    Serial.printf("[MQTT] Connected to Adafruit IO as '%s' | Subscribed: %s\n",
                  gNodeId.c_str(), ctrl.c_str());
    lastTelemetryAt = 0;  // Send initial telemetry immediately so backend registers/syncs this NodeID
  } else {
    Serial.printf("[MQTT] Connect failed (state=%d)\n", mqtt.state());
  }
}

void sendSerialTestFrame() {
  JpegFrame jpg;
  if (!acquireJpeg(jpg)) {
    Serial.println("@@JPG_ERROR message=capture_failed@@");
    return;
  }

  size_t b64Cap = 0;
  mbedtls_base64_encode(nullptr, 0, &b64Cap, jpg.data, jpg.len);
  uint8_t* b64Buf = static_cast<uint8_t*>(malloc(b64Cap + 1));
  if (!b64Buf) {
    releaseJpeg(jpg);
    Serial.println("@@JPG_ERROR message=oom_base64@@");
    return;
  }

  size_t written = 0;
  if (mbedtls_base64_encode(b64Buf, b64Cap + 1, &written, jpg.data, jpg.len) != 0) {
    free(b64Buf);
    releaseJpeg(jpg);
    Serial.println("@@JPG_ERROR message=encode_failed@@");
    return;
  }
  b64Buf[written] = '\0';

  const size_t w = jpg.width;
  const size_t h = jpg.height;
  const size_t bytes = jpg.len;
  releaseJpeg(jpg);

  Serial.printf("@@JPG_BEGIN width=%u height=%u bytes=%u seq=1 format=%s pid=0x%02X nodeId=%s@@\n",
                static_cast<unsigned int>(w),
                static_cast<unsigned int>(h),
                static_cast<unsigned int>(bytes),
                activePixFormat == PIXFORMAT_JPEG ? "JPEG" : "RAW->JPEG",
                cameraPid,
                gNodeId.c_str());
  constexpr size_t CHUNK = 512;
  for (size_t off = 0; off < written; off += CHUNK) {
    const size_t n = (written - off > CHUNK) ? CHUNK : (written - off);
    Serial.write(b64Buf + off, n);
  }
  Serial.println("\n@@JPG_END@@");
  free(b64Buf);
}

void handleSerialCommands() {
  while (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) continue;

    String upper = cmd;
    upper.toUpperCase();
    if (upper == "PING") {
      Serial.println("@@PONG@@");
    } else if (upper == "STATUS" || upper == "ID") {
      Serial.printf("@@STATUS {\"ready\":%s,\"nodeId\":\"%s\",\"sensor\":\"PID_0x%02X\",\"pid\":\"0x%02X\","
                    "\"format\":\"%s\",\"psram\":%s,\"dht20\":%s,\"bh1750\":%s,\"wifi\":%s,\"mqtt\":%s}@@\n",
                    cameraOk ? "true" : "false",
                    gNodeId.c_str(),
                    cameraPid,
                    cameraPid,
                    activePixFormat == PIXFORMAT_JPEG ? "JPEG" : "RAW->JPEG",
                    psramFound() ? "true" : "false",
                    dhtOk ? "true" : "false",
                    lightOk ? "true" : "false",
                    WiFi.status() == WL_CONNECTED ? "true" : "false",
                    mqtt.connected() ? "true" : "false");
    } else if (upper == "SNAP") {
      sendSerialTestFrame();
    } else if (upper == "CAPTURE") {
      singleCaptureRequested = true;
    } else if (upper == "TELEMETRY" || upper == "PUB") {
      publishSensorTelemetry();
    } else if (upper.startsWith("BAUD ")) {
      long newBaud = cmd.substring(5).toInt();
      if (newBaud >= 115200 && newBaud <= 921600) {
        Serial.printf("@@BAUD_ACK %ld@@\n", newBaud);
        Serial.flush();
        delay(50);
        Serial.updateBaudRate(newBaud);
      }
    } else {
      handleControlMessage(cmd);
    }
  }
}

}  // namespace

void setup() {
  // Prevent brownout resets during simultaneous camera + Wi-Fi peaks on USB-UART supplies
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(400);

  gNodeId = resolveUniqueNodeId();
  randomSeed(static_cast<uint32_t>(ESP.getEfuseMac()) ^ micros());

  pinMode(Pins::PRESENCE, INPUT_PULLUP);
  if (Pins::STREET_LED >= 0) {
    ledcAttachChannel(Pins::STREET_LED, 5000, 8, STREET_LED_LEDC_CHANNEL);
    ledcWriteChannel(STREET_LED_LEDC_CHANNEL, 0);
  }

  Serial.println("\n=== ViewStreet ESP32-CAM Node Firmware ===");
  Serial.printf("[BOOT] NodeID: %s | Chip: %s | PSRAM: %s\n",
                gNodeId.c_str(),
                ESP.getChipModel(),
                psramFound() ? "yes" : "no");

  // 1. Initialize Camera (I2C_NUM_0) first, then Sensors (I2C_NUM_1)
  cameraOk = initCamera();
  initSensors();
  readSensors(millis());

  // 2. Configure Adafruit IO MQTT client for Sensor Telemetry & Remote Control
  mqtt.setServer(Defaults::MQTT_HOST, Defaults::MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setSocketTimeout(4);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);

  // 3. Start Wi-Fi connection
  maintainWifi(millis());

  Serial.printf("[BOOT] Ready | Camera=%s DHT20=%s BH1750=%s | Serial cmds: STATUS, CAPTURE, TELEMETRY\n",
                cameraOk ? "OK" : "FAIL",
                dhtOk ? "OK" : "MISSING",
                lightOk ? "OK" : "MISSING");
}

void loop() {
  const uint32_t now = millis();

  handleSerialCommands();
  maintainWifi(now);
  maintainMqtt(now);
  if (mqtt.connected()) {
    mqtt.loop();
  }

  readSensors(now);

  // 1. Periodic sensor telemetry -> Adafruit IO (viewstreet.telemetry)
  if (lastTelemetryAt == 0 || (now - lastTelemetryAt >= Defaults::TELEMETRY_PUBLISH_INTERVAL_MS)) {
    lastTelemetryAt = now;
    publishSensorTelemetry();
  }

  // 2. Direct HTTP camera upload -> Web Backend (POST /api/camera/upload?nodeId=<NodeID>&type=image)
  bool dueCameraUpload = singleCaptureRequested;
  if (!dueCameraUpload && cameraOk && WiFi.status() == WL_CONNECTED) {
    if (cameraMode == "CONTINUOUS") {
      // If node is still waiting for admin approval (HTTP 202), throttle retries to 10s
      const uint32_t waitMs = nodePendingApprovalOnWeb ? 10000UL : Defaults::CONTINUOUS_FRAME_INTERVAL_MS;
      dueCameraUpload = (now - lastCameraUploadAt >= waitMs);
    } else if (cameraMode == "PERIODIC") {
      dueCameraUpload = (lastCameraUploadAt == 0) || (now - lastCameraUploadAt >= cameraIntervalMs);
    }
  }

  if (dueCameraUpload) {
    uploadCameraFrameToWeb();
  }

  runOtaUpdateIfRequested();
  delay(5);
}

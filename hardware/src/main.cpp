#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <DFRobot_DHT20.h>
#include <BH1750.h>
#include <esp_camera.h>
#include <mbedtls/base64.h>
#include "../include/config.h"
#include "../include/secrets.h"

namespace {
constexpr char MQTT_HOST[] = "io.adafruit.com";
constexpr uint16_t MQTT_PORT = 1883;
constexpr uint32_t SENSOR_INTERVAL_MS = 2000;
constexpr uint32_t PUBLISH_INTERVAL_MS = 5000;
constexpr uint32_t RETRY_INTERVAL_MS = 5000;
constexpr size_t MQTT_BUFFER_SIZE = 32768;

WiFiClient network;
PubSubClient mqtt(network);
DFRobot_DHT20 dht;
BH1750 light;

float temperature = NAN, humidity = NAN, lux = NAN;
bool presence = false, dhtOk = false, lightOk = false, cameraOk = false;
bool cameraRequested = false;
uint32_t lastSensorAt = 0, lastPublishAt = 0, lastWifiRetryAt = 0, lastMqttRetryAt = 0;

String feed(const char* key) { return String(AIO_USERNAME) + "/feeds/" + key; }

void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
  const String commandTopic = feed("viewstreet.control");
  if (String(topic) != commandTopic) return;
  String command;
  command.reserve(length);
  for (unsigned int i = 0; i < length; ++i) command += static_cast<char>(payload[i]);
  command.toLowerCase();
  if (command.indexOf("camera") >= 0 || command.indexOf("capture") >= 0) cameraRequested = true;
}

void connectWifi(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED || now - lastWifiRetryAt < RETRY_INTERVAL_MS) return;
  lastWifiRetryAt = now;
  if (WiFi.getMode() == WIFI_OFF) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  } else {
    WiFi.reconnect();
  }
}

void connectMqtt(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected() || now - lastMqttRetryAt < RETRY_INTERVAL_MS) return;
  lastMqttRetryAt = now;
  const String clientId = String("viewstreet-") + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
  const String statusTopic = feed("device-status");
  if (mqtt.connect(clientId.c_str(), AIO_USERNAME, AIO_KEY,
                   statusTopic.c_str(), 1, true, "offline")) {
    mqtt.subscribe(feed("viewstreet.control").c_str());
    mqtt.publish(statusTopic.c_str(), "online", true);
    Serial.println("[MQTT] Adafruit IO connected");
  } else {
    Serial.printf("[MQTT] connect failed: %d\n", mqtt.state());
  }
}

void readSensors(uint32_t now) {
  if (now - lastSensorAt < SENSOR_INTERVAL_MS) return;
  lastSensorAt = now;

  const float t = dht.getTemperature();
  const float h = dht.getHumidity();
  dhtOk = isfinite(t) && isfinite(h) && t >= -40 && t <= 80 && h >= 0 && h <= 100;
  if (dhtOk) { temperature = t; humidity = h; }

  lux = light.readLightLevel();
  lightOk = isfinite(lux) && lux >= 0;
  presence = digitalRead(Pins::PRESENCE) == (Pins::PRESENCE_ACTIVE_LOW ? LOW : HIGH);
}

void publishTelemetry() {
  if (!mqtt.connected()) return;
  char payload[256];
  char tempValue[16], humidityValue[16], lightValue[16];
  if (dhtOk) {
    snprintf(tempValue, sizeof(tempValue), "%.1f", temperature);
    snprintf(humidityValue, sizeof(humidityValue), "%.1f", humidity);
  } else {
    strcpy(tempValue, "null"); strcpy(humidityValue, "null");
  }
  if (lightOk) snprintf(lightValue, sizeof(lightValue), "%.1f", lux);
  else strcpy(lightValue, "null");
  const char* error = !dhtOk ? "DHT20" : !lightOk ? "BH1750" : !cameraOk ? "CAMERA" : "";
  snprintf(payload, sizeof(payload),
           "{\"temp\":%s,\"humi\":%s,\"light\":%s,\"motion\":%s,\"presence\":%s,\"mode\":\"NORMAL\",\"ledLevel\":0,\"bat\":null,\"error\":\"%s\"}",
           tempValue, humidityValue, lightValue, presence ? "true" : "false", presence ? "true" : "false", error);
  mqtt.publish(feed("viewstreet.telemetry").c_str(), payload);
}

void captureAndPublish() {
  cameraRequested = false;
  if (!cameraOk || !mqtt.connected()) return;
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) { Serial.println("[CAMERA] capture failed"); return; }

  const size_t capacity = 4 * ((frame->len + 2) / 3) + 1;
  auto* encoded = static_cast<unsigned char*>(malloc(capacity));
  if (!encoded) {
    esp_camera_fb_return(frame);
    Serial.println("[CAMERA] no memory for Base64 image");
    return;
  }

  size_t encodedLength = 0;
  const int result = mbedtls_base64_encode(encoded, capacity, &encodedLength, frame->buf, frame->len);
  esp_camera_fb_return(frame);
  const String imageTopic = feed("viewstreet.camera");
  const size_t topicOverhead = imageTopic.length() + 8;
  const bool fits = result == 0 && encodedLength > 0 && encodedLength + topicOverhead < MQTT_BUFFER_SIZE;
  if (fits) {
    const bool sent = mqtt.publish(imageTopic.c_str(), encoded, static_cast<unsigned int>(encodedLength), false);
    Serial.printf("[CAMERA] %s %u Base64 bytes\n", sent ? "published" : "publish failed", static_cast<unsigned>(encodedLength));
  } else {
    Serial.printf("[CAMERA] image too large for MQTT buffer: %u bytes\n", static_cast<unsigned>(encodedLength));
  }
  free(encoded);
}
}

void setup() {
  Serial.begin(115200);
  pinMode(Pins::PRESENCE, INPUT_PULLUP);
  Wire.begin(Pins::I2C_SDA, Pins::I2C_SCL);
  Wire.setTimeOut(50);

  dht.begin();
  const bool lightOkAtBoot = light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
  camera_config_t cameraConfig{};
  cameraConfig.ledc_channel = LEDC_CHANNEL_0; cameraConfig.ledc_timer = LEDC_TIMER_0;
  cameraConfig.pin_d0=5; cameraConfig.pin_d1=18; cameraConfig.pin_d2=19; cameraConfig.pin_d3=21;
  cameraConfig.pin_d4=36; cameraConfig.pin_d5=39; cameraConfig.pin_d6=34; cameraConfig.pin_d7=35;
  cameraConfig.pin_xclk=0; cameraConfig.pin_pclk=22; cameraConfig.pin_vsync=25; cameraConfig.pin_href=23;
  cameraConfig.pin_sccb_sda=26; cameraConfig.pin_sccb_scl=27; cameraConfig.pin_pwdn=32; cameraConfig.pin_reset=-1;
  cameraConfig.xclk_freq_hz=20000000; cameraConfig.pixel_format=PIXFORMAT_JPEG;
  cameraConfig.frame_size=FRAMESIZE_QVGA; cameraConfig.jpeg_quality=18; cameraConfig.fb_count=1;
  cameraConfig.fb_location=psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  cameraOk = esp_camera_init(&cameraConfig) == ESP_OK;

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setSocketTimeout(2);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[BOOT] camera=%s BH1750=%s\n", cameraOk ? "OK" : "FAIL", lightOkAtBoot ? "OK" : "FAIL");
}

void loop() {
  const uint32_t now = millis();
  connectWifi(now);
  connectMqtt(now);
  if (mqtt.connected()) mqtt.loop();
  readSensors(now);

  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publishTelemetry();
  }
  if (cameraRequested) captureAndPublish();
  yield();
}

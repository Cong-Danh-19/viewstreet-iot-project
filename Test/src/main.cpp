#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <DFRobot_DHT20.h>
#include <BH1750.h>
#include <LiquidCrystal_I2C.h>
#include "esp_camera.h"
#include "../../hardware/include/config.h"
#include "../../hardware/include/secrets.h"

namespace {
constexpr char MQTT_HOST[] = "io.adafruit.com";
constexpr uint16_t MQTT_PORT = 1883;
constexpr uint32_t WIFI_TIMEOUT_MS = 20000;
constexpr uint8_t LCD_ADDRESS = 0x27;

WiFiClient networkClient;
PubSubClient mqtt(networkClient);
DFRobot_DHT20 dht;
BH1750 light;
uint8_t passed = 0, failed = 0, manual = 0;

void report(const char* name, bool ok, const String& detail = "") {
  Serial.printf("[%s] %s", ok ? "PASS" : "FAIL", name);
  if (detail.length()) Serial.printf(" - %s", detail.c_str());
  Serial.println();
  ok ? ++passed : ++failed;
}

void reportManual(const char* name, const String& detail) {
  Serial.printf("[MANUAL] %s - %s\n", name, detail.c_str());
  ++manual;
}

bool connectWifi() {
  if (String(WIFI_SSID).length() == 0 || String(WIFI_SSID) == "replace-me") {
    report("Wi-Fi", false, "set WIFI_SSID/WIFI_PASSWORD in hardware/include/secrets.h");
    return false;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_TIMEOUT_MS) {
    delay(250);
  }
  const bool ok = WiFi.status() == WL_CONNECTED;
  report("Wi-Fi", ok, ok ? WiFi.localIP().toString() : "timeout; check SSID/password and 2.4GHz network");
  return ok;
}

bool connectAdafruit() {
  if (WiFi.status() != WL_CONNECTED) {
    report("Adafruit IO MQTT", false, "Wi-Fi is not connected");
    return false;
  }
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setSocketTimeout(5);
  const String clientId = String("viewstreet-test-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  if (!mqtt.connect(clientId.c_str(), AIO_USERNAME, AIO_KEY)) {
    report("Adafruit IO MQTT", false, String("connect failed, state=") + mqtt.state());
    return false;
  }
  const String commandFeed = String(AIO_USERNAME) + "/feeds/viewstreet.control";
  const bool subOk = mqtt.subscribe(commandFeed.c_str(), 0);
  report("Adafruit IO MQTT", subOk,
         subOk ? "authenticated; subscribed to viewstreet.control (no data published)" : "connected but feed subscribe failed");
  return subOk;
}

bool testDht20() {
  if (dht.begin() != 0) {
    report("DHT20", false, "no response at I2C 0x38");
    return false;
  }
  delay(100);
  const float t = dht.getTemperature();
  const float h = dht.getHumidity();
  const bool ok = isfinite(t) && isfinite(h) && t >= -40 && t <= 80 && h >= 0 && h <= 100;
  report("DHT20", ok, ok ? String(t, 1) + " C, " + String(h, 1) + " %RH" : "I2C ACK but reading invalid");
  return ok;
}

bool testLightSensor() {
  if (!light.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire)) {
    report("BH1750 light sensor", false, "no response at I2C 0x23");
    return false;
  }
  delay(200);
  const float lux = light.readLightLevel();
  const bool ok = isfinite(lux) && lux >= 0;
  report("BH1750 light sensor", ok, ok ? String(lux, 1) + " lux" : "I2C ACK but reading invalid");
  return ok;
}

bool testLcd() {
  Wire.beginTransmission(LCD_ADDRESS);
  const bool ok = Wire.endTransmission() == 0;
  if (ok) {
    LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
    lcd.init(); lcd.backlight(); lcd.setCursor(0, 0); lcd.print("LINK TEST PASS");
    lcd.setCursor(0, 1); lcd.print("See Serial");
  }
  report("LCD I2C", ok, ok ? String("ACK at 0x") + String(LCD_ADDRESS, HEX) : "check LCD address and voltage");
  return ok;
}

bool testCamera() {
  camera_config_t c{};
  c.ledc_channel=LEDC_CHANNEL_0; c.ledc_timer=LEDC_TIMER_0;
  c.pin_d0=5; c.pin_d1=18; c.pin_d2=19; c.pin_d3=21; c.pin_d4=36; c.pin_d5=39; c.pin_d6=34; c.pin_d7=35;
  c.pin_xclk=0; c.pin_pclk=22; c.pin_vsync=25; c.pin_href=23; c.pin_sccb_sda=26; c.pin_sccb_scl=27;
  c.pin_pwdn=32; c.pin_reset=-1; c.xclk_freq_hz=20000000; c.pixel_format=PIXFORMAT_JPEG;
  c.frame_size=FRAMESIZE_QVGA; c.jpeg_quality=16; c.fb_count=1;
  c.fb_location=psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  const esp_err_t initResult = esp_camera_init(&c);
  if (initResult != ESP_OK) {
    report("Camera init", false, String("esp_camera_init error=") + initResult);
    return false;
  }
  report("Camera init", true, "camera sensor initialized");
  camera_fb_t* frame = esp_camera_fb_get();
  const bool ok = frame && frame->format == PIXFORMAT_JPEG && frame->len > 0;
  const size_t bytes = frame ? frame->len : 0;
  if (frame) esp_camera_fb_return(frame);
  esp_camera_deinit();
  report("Camera capture", ok, ok ? String(bytes) + " JPEG bytes" : "no frame; check ribbon, camera and power");
  return ok;
}

void testPresenceInput() {
  pinMode(Pins::PRESENCE, INPUT_PULLUP);
  const int initial = digitalRead(Pins::PRESENCE);
  reportManual("Presence sensor", String("GPIO15 reads ") + (initial == HIGH ? "HIGH" : "LOW") + "; activate sensor and verify state changes");
}

void runTests() {
  Serial.println("\n=== ESP32-CAM / Wi-Fi / Adafruit / Sensor link test ===");
  connectWifi();
  connectAdafruit();

  Wire.begin(Pins::I2C_SDA, Pins::I2C_SCL);
  Wire.setTimeOut(50);
  testDht20();
  testLightSensor();
  testLcd();
  testPresenceInput();
  testCamera();

  Serial.printf("\nRESULT: %u PASS, %u FAIL, %u MANUAL\n", passed, failed, manual);
  Serial.println(failed == 0 ? "Automated checks passed." : "Resolve FAIL items and reset to retest.");
  Serial.println("MANUAL checks require activating the physical presence sensor and observing its GPIO state change.");
}
}

void setup() {
  Serial.begin(115200);
  delay(500);
  runTests();
}

void loop() { delay(1000); }

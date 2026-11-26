#pragma once
#include <Arduino.h>

namespace Pins {
// External sensor I2C bus on Wire (I2C_NUM_0); Camera SCCB uses I2C_NUM_1 (GPIO26/27)
constexpr int I2C_SDA = 13;
constexpr int I2C_SCL = 14;

// Presence / motion sensor input (GPIO15)
constexpr int PRESENCE = 15;
constexpr bool PRESENCE_ACTIVE_LOW = true;

// Camera power-down pin on AI-Thinker ESP32-CAM
constexpr int CAM_PWDN = 32;

// Optional PWM street-light output pin (-1 = software state only; set e.g. 12 or 4 if wired)
constexpr int STREET_LED = -1;
}  // namespace Pins

namespace Defaults {
constexpr char MQTT_HOST[] = "io.adafruit.com";
constexpr uint16_t MQTT_PORT = 1883;

// Auto-discover server laptop (<BACKEND_MDNS_HOST>.local) if BACKEND_URL IP changes across Wi-Fi/Hotspot
constexpr char BACKEND_MDNS_HOST[] = "ADUY";
constexpr uint16_t BACKEND_PORT = 3000;

constexpr uint32_t SENSOR_READ_INTERVAL_MS = 2000;
constexpr uint32_t TELEMETRY_PUBLISH_INTERVAL_MS = 6000;  // ~10 msg/min (<30 msg/min Adafruit Free limit)
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;       // Full 20s window for WPA2 + DHCP on hotspots
constexpr uint32_t MQTT_RETRY_INTERVAL_MS = 5000;

constexpr uint32_t DEFAULT_CAMERA_INTERVAL_SEC = 10;      // PERIODIC camera upload interval (seconds)
constexpr uint32_t CONTINUOUS_FRAME_INTERVAL_MS = 450;    // CONTINUOUS MJPEG upload pacing (~2.2 FPS)
constexpr float DEFAULT_LIGHT_THRESHOLD_LUX = 150.0f;
constexpr uint32_t DEFAULT_MOTION_HOLD_SEC = 30;
}  // namespace Defaults

#ifndef NODE_ID
#define NODE_ID "AUTO"
#endif

#pragma once
#include <Arduino.h>

namespace Pins {
constexpr int I2C_SDA = 13, I2C_SCL = 14;
constexpr int PRESENCE = 15;
constexpr bool PRESENCE_ACTIVE_LOW = true;
}

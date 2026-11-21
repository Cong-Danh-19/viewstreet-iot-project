# Device connectivity test

Standalone PlatformIO test firmware for AI Thinker ESP32-CAM. It checks Wi-Fi, Adafruit IO MQTT authentication/subscription, DHT20, BH1750, LCD I2C, presence GPIO and OV2640 initialization plus a JPEG capture. It does not publish test data to Adafruit IO.

## Configure and run

The test reads credentials from `hardware/include/secrets.h` (the same ignored local file as the main firmware). Copy `hardware/include/secrets.h.example` there and enter `WIFI_SSID`, `WIFI_PASSWORD`, `AIO_USERNAME`, and `AIO_KEY` if it does not already exist.

Run these commands from this `Test` directory:

```sh
pio run
pio run -t upload
pio device monitor -b 115200
```

The test runs once after boot and prints `[PASS]`, `[FAIL]`, or `[MANUAL]` for each check. It subscribes to `YOUR_USERNAME/feeds/viewstreet.control`, but does not publish any MQTT values. Reboot the board to run the checks again. Use the upload wiring and boot mode described in `../hardware/README.md`.

Presence sensors have no generic disconnected-state detection. Activate the sensor and confirm GPIO15 changes; the test marks this check `MANUAL` rather than claiming a stable input proves the sensor is connected. The camera check captures a JPEG locally but does not upload it to the web server.

I2C uses SDA GPIO13 and SCL GPIO14; expected addresses are DHT20 `0x38`, BH1750 `0x23`, and LCD from `hardware/include/config.h` (default `0x27`). Confirm voltage/pin constraints in `hardware/README.md` before wiring.

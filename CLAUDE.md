# Local Weather Tracker

A Node.js agent that runs on a schedule, fetches 7-day weather forecasts based on IP geolocation, stores them in a local SQLite database, detects material forecast changes, tracks location moves, scores forecast accuracy, and alerts via email with a link to a self-contained visual dashboard.

## Architecture overview

The agent follows a linear pipeline each run:

1. **Geolocate** via ip-api.com (free, no key) to get lat/lon + city/country
2. **Check location change** — haversine distance against last known position. If >50km, fetch historical actuals from Open-Meteo's archive API and compute forecast accuracy scores
3. **Fetch 7-day forecast** from Open-Meteo (free, no key)
4. **Store** forecast in SQLite
5. **Compare** against the previous forecast for the same location — detect material changes (temp swing >=5°C or precipitation type change)
6. **Alert** — store alerts in DB, send email via SMTP with categorized change summary and dashboard link
7. **Generate dashboard** — write a self-contained `weather-dashboard.html` with all data embedded and Chart.js visualizations

## File structure

```
Local Weather Tracker/
├── index.js              # Main agent script (all logic in one file)
├── package.json          # Node.js dependencies
├── .env                  # Local configuration (SMTP creds, thresholds) — NOT committed
├── .env.example          # Template showing all config options
├── .gitignore            # Excludes node_modules, .env, weather.db
├── auto-commit.sh        # Script that watches for changes and auto-commits to GitHub
├── CLAUDE.md             # This file
├── weather.db            # SQLite database (created on first run) — NOT committed
└── weather-dashboard.html # Generated dashboard (recreated every run)
```

## Dependencies

All in `package.json`, install with `npm install`:

- `better-sqlite3` — synchronous SQLite3 bindings for Node.js
- `nodemailer` — SMTP email sending
- `dotenv` — loads `.env` config

No external HTTP library needed — the agent uses Node's built-in `http`/`https` modules with a lightweight `httpFetch()` wrapper that handles redirects and JSON parsing.

## External APIs

Both APIs are free and require no API keys:

- **ip-api.com** (`http://ip-api.com/json/`) — IP geolocation. Returns lat, lon, city, country. Rate limit: 45 requests/minute (more than enough for scheduled runs).
- **Open-Meteo Forecast** (`https://api.open-meteo.com/v1/forecast`) — 7-day daily forecast. Parameters: `weather_code`, `temperature_2m_max/min`, `precipitation_sum`, `wind_speed_10m_max`.
- **Open-Meteo Archive** (`https://archive-api.open-meteo.com/v1/archive`) — Historical actual weather. Same parameters as forecast. Has a ~5 day delay (recent days not yet available). Used when a location change is detected.

## Database schema (SQLite)

### `forecasts`
Stores every forecast fetch. One row per day per fetch.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| fetched_at | TEXT | When this forecast was retrieved (datetime) |
| forecast_date | TEXT | The date this forecast is for (YYYY-MM-DD) |
| temp_max / temp_min | REAL | High/low temperature in °C |
| weather_code | INTEGER | WMO weather code |
| weather_label | TEXT | Human-readable weather description |
| precip_type | TEXT | Precipitation category: none, rain, snow, storm |
| precipitation_mm | REAL | Total precipitation in mm |
| wind_max_kmh | REAL | Max wind speed in km/h |
| location_city / location_country | TEXT | Where this forecast applies |
| lat / lon | REAL | Coordinates |

### `locations`
Tracks every detected position, one row per agent run.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| detected_at | TEXT | When this location was detected |
| lat / lon | REAL | Coordinates |
| city / country | TEXT | Resolved place name |
| distance_from_prev_km | REAL | Haversine distance from previous location |

### `actuals`
Historical actual weather, fetched when arriving at a new location (>50km move).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| fetched_at | TEXT | When the historical data was retrieved |
| actual_date | TEXT | The date this actual weather occurred |
| (same weather columns as forecasts) | | |

### `accuracy_reports`
Forecast vs actual comparison. One row per date where we have both a forecast and actual data.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| report_date | TEXT | The date being evaluated |
| forecast_temp_max/min | REAL | What was predicted |
| actual_temp_max/min | REAL | What actually happened |
| forecast_precip_type / actual_precip_type | TEXT | Predicted vs actual precipitation |
| temp_max_error / temp_min_error | REAL | Absolute error in °C |
| precip_match | INTEGER | 1 if precip type matched, 0 if not |
| days_ahead | INTEGER | How many days ahead the forecast was made |
| location_city / location_country | TEXT | Where |

### `alerts`
Log of all detected material changes.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| created_at | TEXT | When the alert was generated |
| alert_type | TEXT | temperature, precipitation, or location |
| forecast_date | TEXT | Which forecast date changed |
| details | TEXT | Human-readable description |

## Configuration (.env)

```env
TEMP_THRESHOLD=5              # °C change to trigger alert (default: 5)
LOCATION_THRESHOLD_KM=50     # km move to trigger historical fetch (default: 50)
SMTP_HOST=smtp.gmail.com      # SMTP server
SMTP_PORT=587                 # SMTP port
SMTP_USER=                    # Your email address
SMTP_PASS=                    # App password (not your regular password)
ALERT_EMAIL=you@example.com   # Where to send alerts
DB_PATH=./weather.db          # SQLite database path (default: project root)
DASHBOARD_PATH=./weather-dashboard.html  # Dashboard output path
```

For Gmail, generate an App Password at https://myaccount.google.com/apppasswords.

## Running

```bash
npm install                  # First time only
node index.js                # Normal run
node index.js --dry-run      # Fetch + store + detect, but skip sending email
```

The agent is designed to run on a schedule (every 6 hours via Cowork's scheduler). Each run is stateless — it reads the DB for history, does its work, and exits.

## Dashboard

`weather-dashboard.html` is regenerated on every run with all data embedded as JSON. It loads Chart.js from CDN and renders entirely client-side. Sections:

- **Stat cards** — week high/low, total precip, max wind, location count, average temp error
- **7-day forecast strip** — weather icons, temps, precipitation
- **Temperature trends** — line chart of highs and lows
- **Precipitation & wind** — combo bar/line chart
- **Forecast revision history** — how the high-temp forecast for each date has shifted across fetches
- **Forecast accuracy by location** — table with per-city error averages and letter grades
- **Accuracy by forecast horizon** — bar chart showing error by days-ahead (1-7)
- **Predicted vs actual scatter** — dots along the diagonal = accurate
- **Location timeline** — chronological list with move distances
- **Recent alerts** — scrollable log with color-coded badges

## Key design decisions

- **Single file (`index.js`)** — keeps the project simple and easy to understand. No framework, no build step.
- **No external HTTP library** — uses Node's built-in `http`/`https` with a thin wrapper to avoid an extra dependency.
- **Location-scoped comparisons** — forecast changes are compared within the same city, so traveling doesn't generate false alerts from comparing Sofia's weather to London's.
- **Historical fetch on location change only** — avoids hitting the archive API every run. Only triggers when you move >50km, which is the moment accuracy data becomes most useful ("how reliable is the forecast here?").
- **Self-contained dashboard** — a single HTML file with embedded data means no server needed. Open it in any browser, share it, or email it.
- **WMO weather codes** — Open-Meteo uses the WMO standard. The `WMO_CODES` map translates numeric codes to human-readable labels and precipitation categories (none/rain/snow/storm) for change detection.

## Extending

- **Add more alert types**: edit `detectChanges()` — e.g., wind threshold alerts, UV index
- **Add more dashboard charts**: edit `generateDashboard()` and `getDashboardData()` — query the DB for whatever you need, embed it as JSON
- **Change APIs**: swap `fetchForecast()` or `getLocation()` — the rest of the pipeline is API-agnostic
- **Add notification channels**: Slack, push notifications, etc. — add alongside `sendAlertEmail()`

#!/usr/bin/env node

/**
 * Local Weather Tracker
 *
 * Fetches a 7-day forecast based on IP geolocation, stores it in SQLite,
 * detects material changes compared to the previous forecast, tracks
 * location changes (>50km triggers historical data fetch for accuracy
 * analysis), sends email alerts, and generates a visual dashboard.
 *
 * Material change thresholds (configurable in .env):
 *   - Temperature swing >= 5 C for the same day
 *   - Precipitation type change (e.g. rain -> snow, dry -> rain)
 *
 * Location tracking:
 *   - Logs every detected location with timestamp
 *   - When you move >50km from your last position, fetches 7 days of
 *     actual historical weather for the new location and compares it
 *     against any forecasts we had, producing accuracy scores
 */

require("dotenv").config();
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

const CONFIG = {
  dbPath: process.env.DB_PATH || path.join(__dirname, "weather.db"),
  dashboardPath: process.env.DASHBOARD_PATH || path.join(__dirname, "weather-dashboard.html"),
  tempThreshold: parseFloat(process.env.TEMP_THRESHOLD || "5"),
  locationThresholdKm: parseFloat(process.env.LOCATION_THRESHOLD_KM || "50"),
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  alertEmail: process.env.ALERT_EMAIL || "",
  dryRun: process.argv.includes("--dry-run"),
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function httpFetch(url) {
  const lib = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    lib
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpFetch(res.headers.location).then(resolve, reject);
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

/** Haversine distance in km between two lat/lon points */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format a Date as YYYY-MM-DD */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────
// 1. IP Geolocation
// ──────────────────────────────────────────────

async function getLocation() {
  const geo = await httpFetch("http://ip-api.com/json/?fields=lat,lon,city,country");
  if (!geo.lat || !geo.lon) throw new Error("Geolocation failed: " + JSON.stringify(geo));
  console.log(`Location: ${geo.city}, ${geo.country} (${geo.lat}, ${geo.lon})`);
  return { lat: geo.lat, lon: geo.lon, city: geo.city, country: geo.country };
}

// ──────────────────────────────────────────────
// 2. Weather codes
// ──────────────────────────────────────────────

const WMO_CODES = {
  0: { label: "Clear sky", precip: "none" },
  1: { label: "Mainly clear", precip: "none" },
  2: { label: "Partly cloudy", precip: "none" },
  3: { label: "Overcast", precip: "none" },
  45: { label: "Fog", precip: "none" },
  48: { label: "Depositing rime fog", precip: "none" },
  51: { label: "Light drizzle", precip: "rain" },
  53: { label: "Moderate drizzle", precip: "rain" },
  55: { label: "Dense drizzle", precip: "rain" },
  56: { label: "Light freezing drizzle", precip: "rain" },
  57: { label: "Dense freezing drizzle", precip: "rain" },
  61: { label: "Slight rain", precip: "rain" },
  63: { label: "Moderate rain", precip: "rain" },
  65: { label: "Heavy rain", precip: "rain" },
  66: { label: "Light freezing rain", precip: "rain" },
  67: { label: "Heavy freezing rain", precip: "rain" },
  71: { label: "Slight snowfall", precip: "snow" },
  73: { label: "Moderate snowfall", precip: "snow" },
  75: { label: "Heavy snowfall", precip: "snow" },
  77: { label: "Snow grains", precip: "snow" },
  80: { label: "Slight rain showers", precip: "rain" },
  81: { label: "Moderate rain showers", precip: "rain" },
  82: { label: "Violent rain showers", precip: "rain" },
  85: { label: "Slight snow showers", precip: "snow" },
  86: { label: "Heavy snow showers", precip: "snow" },
  95: { label: "Thunderstorm", precip: "storm" },
  96: { label: "Thunderstorm with slight hail", precip: "storm" },
  99: { label: "Thunderstorm with heavy hail", precip: "storm" },
};

function decodeWeatherCode(code) {
  return WMO_CODES[code] || { label: `Unknown (${code})`, precip: "unknown" };
}

// ──────────────────────────────────────────────
// 3. Fetch forecast (Open-Meteo)
// ──────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=7`;

  const data = await httpFetch(url);
  if (!data.daily) throw new Error("Open-Meteo returned no daily data: " + JSON.stringify(data).slice(0, 300));

  return data.daily.time.map((date, i) => {
    const wmo = decodeWeatherCode(data.daily.weather_code[i]);
    return {
      date,
      temp_max: data.daily.temperature_2m_max[i],
      temp_min: data.daily.temperature_2m_min[i],
      weather_code: data.daily.weather_code[i],
      weather_label: wmo.label,
      precip_type: wmo.precip,
      precipitation_mm: data.daily.precipitation_sum[i],
      wind_max_kmh: data.daily.wind_speed_10m_max[i],
    };
  });
}

// ──────────────────────────────────────────────
// 4. Fetch historical actuals (Open-Meteo Archive)
// ──────────────────────────────────────────────

async function fetchHistoricalWeather(lat, lon, startDate, endDate) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&timezone=auto`;

  const data = await httpFetch(url);
  if (!data.daily) {
    console.log("Historical API returned no data (dates may be too recent). Skipping.");
    return [];
  }

  return data.daily.time.map((date, i) => {
    const wmo = decodeWeatherCode(data.daily.weather_code[i]);
    return {
      date,
      temp_max: data.daily.temperature_2m_max[i],
      temp_min: data.daily.temperature_2m_min[i],
      weather_code: data.daily.weather_code[i],
      weather_label: wmo.label,
      precip_type: wmo.precip,
      precipitation_mm: data.daily.precipitation_sum[i],
      wind_max_kmh: data.daily.wind_speed_10m_max[i],
    };
  });
}

// ──────────────────────────────────────────────
// 5. SQLite database
// ──────────────────────────────────────────────

function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS forecasts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      forecast_date TEXT    NOT NULL,
      temp_max      REAL,
      temp_min      REAL,
      weather_code  INTEGER,
      weather_label TEXT,
      precip_type   TEXT,
      precipitation_mm REAL,
      wind_max_kmh  REAL,
      location_city TEXT,
      location_country TEXT,
      lat           REAL,
      lon           REAL
    );

    CREATE INDEX IF NOT EXISTS idx_forecast_date ON forecasts(forecast_date);
    CREATE INDEX IF NOT EXISTS idx_fetched_at    ON forecasts(fetched_at);

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      alert_type  TEXT NOT NULL,
      forecast_date TEXT,
      details     TEXT,
      emailed     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS locations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      lat         REAL NOT NULL,
      lon         REAL NOT NULL,
      city        TEXT,
      country     TEXT,
      distance_from_prev_km REAL
    );

    CREATE TABLE IF NOT EXISTS actuals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      actual_date   TEXT    NOT NULL,
      temp_max      REAL,
      temp_min      REAL,
      weather_code  INTEGER,
      weather_label TEXT,
      precip_type   TEXT,
      precipitation_mm REAL,
      wind_max_kmh  REAL,
      location_city TEXT,
      location_country TEXT,
      lat           REAL,
      lon           REAL
    );

    CREATE INDEX IF NOT EXISTS idx_actual_date ON actuals(actual_date);

    CREATE TABLE IF NOT EXISTS accuracy_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      report_date     TEXT NOT NULL,
      location_city   TEXT,
      location_country TEXT,
      lat             REAL,
      lon             REAL,
      forecast_temp_max   REAL,
      forecast_temp_min   REAL,
      forecast_precip_type TEXT,
      actual_temp_max     REAL,
      actual_temp_min     REAL,
      actual_precip_type  TEXT,
      temp_max_error      REAL,
      temp_min_error      REAL,
      precip_match        INTEGER,
      days_ahead          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_accuracy_city ON accuracy_reports(location_city);
  `);

  return db;
}

function storeForecast(db, days, location) {
  const insert = db.prepare(`
    INSERT INTO forecasts
      (forecast_date, temp_max, temp_min, weather_code, weather_label,
       precip_type, precipitation_mm, wind_max_kmh,
       location_city, location_country, lat, lon)
    VALUES
      (@date, @temp_max, @temp_min, @weather_code, @weather_label,
       @precip_type, @precipitation_mm, @wind_max_kmh,
       @city, @country, @lat, @lon)
  `);

  const tx = db.transaction((rows) => {
    for (const day of rows) {
      insert.run({
        ...day,
        city: location.city,
        country: location.country,
        lat: location.lat,
        lon: location.lon,
      });
    }
  });

  tx(days);
  console.log(`Stored ${days.length} forecast days.`);
}

function getPreviousForecast(db, location) {
  // Get the most recent forecast fetch for this location (within ~50km)
  const row = db
    .prepare(
      `SELECT DISTINCT fetched_at FROM forecasts
       WHERE location_city = ?
       ORDER BY fetched_at DESC LIMIT 1 OFFSET 1`
    )
    .get(location.city);

  if (!row) return null;

  const rows = db
    .prepare(`SELECT * FROM forecasts WHERE fetched_at = ? ORDER BY forecast_date`)
    .all(row.fetched_at);

  const map = {};
  for (const r of rows) map[r.forecast_date] = r;
  return map;
}

// ──────────────────────────────────────────────
// 6. Location tracking
// ──────────────────────────────────────────────

function getLastKnownLocation(db) {
  return db
    .prepare(`SELECT * FROM locations ORDER BY detected_at DESC LIMIT 1`)
    .get();
}

function recordLocation(db, location, distanceKm) {
  db.prepare(`
    INSERT INTO locations (lat, lon, city, country, distance_from_prev_km)
    VALUES (?, ?, ?, ?, ?)
  `).run(location.lat, location.lon, location.city, location.country, distanceKm);
}

/**
 * Check if we've moved significantly. Returns { moved, distanceKm }.
 * On first ever run, moved = false (no previous to compare).
 */
function checkLocationChange(db, currentLocation) {
  const prev = getLastKnownLocation(db);

  if (!prev) {
    // First run ever
    recordLocation(db, currentLocation, 0);
    return { moved: false, distanceKm: 0, previousLocation: null };
  }

  const distanceKm = haversineKm(prev.lat, prev.lon, currentLocation.lat, currentLocation.lon);

  // Always record the location
  recordLocation(db, currentLocation, distanceKm);

  const moved = distanceKm >= CONFIG.locationThresholdKm;
  if (moved) {
    console.log(`Location change detected: ${prev.city} -> ${currentLocation.city} (${distanceKm.toFixed(1)} km)`);
  } else {
    console.log(`Same location area (moved ${distanceKm.toFixed(1)} km, threshold ${CONFIG.locationThresholdKm} km)`);
  }

  return {
    moved,
    distanceKm,
    previousLocation: { lat: prev.lat, lon: prev.lon, city: prev.city, country: prev.country },
  };
}

// ──────────────────────────────────────────────
// 7. Historical data + accuracy scoring
// ──────────────────────────────────────────────

function storeActuals(db, days, location) {
  const insert = db.prepare(`
    INSERT INTO actuals
      (actual_date, temp_max, temp_min, weather_code, weather_label,
       precip_type, precipitation_mm, wind_max_kmh,
       location_city, location_country, lat, lon)
    VALUES
      (@date, @temp_max, @temp_min, @weather_code, @weather_label,
       @precip_type, @precipitation_mm, @wind_max_kmh,
       @city, @country, @lat, @lon)
  `);

  const tx = db.transaction((rows) => {
    for (const day of rows) {
      insert.run({
        ...day,
        city: location.city,
        country: location.country,
        lat: location.lat,
        lon: location.lon,
      });
    }
  });

  tx(days);
  console.log(`Stored ${days.length} historical actual days.`);
}

/**
 * For each date in the actuals, find the earliest forecast we made for that
 * date at the same location, and compute accuracy.
 */
function computeAccuracy(db, actuals, location) {
  const insertReport = db.prepare(`
    INSERT INTO accuracy_reports
      (report_date, location_city, location_country, lat, lon,
       forecast_temp_max, forecast_temp_min, forecast_precip_type,
       actual_temp_max, actual_temp_min, actual_precip_type,
       temp_max_error, temp_min_error, precip_match, days_ahead)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let matched = 0;

  const tx = db.transaction(() => {
    for (const actual of actuals) {
      // Find the earliest forecast we made for this date at this location
      const forecast = db
        .prepare(
          `SELECT *, julianday(forecast_date) - julianday(fetched_at) AS days_ahead
           FROM forecasts
           WHERE forecast_date = ? AND location_city = ?
           ORDER BY fetched_at ASC LIMIT 1`
        )
        .get(actual.date, location.city);

      if (!forecast) continue; // we had no forecast for this date at this location

      const tempMaxError = Math.abs(actual.temp_max - forecast.temp_max);
      const tempMinError = Math.abs(actual.temp_min - forecast.temp_min);
      const precipMatch = actual.precip_type === forecast.precip_type ? 1 : 0;
      const daysAhead = Math.max(0, Math.round(forecast.days_ahead || 0));

      insertReport.run(
        actual.date,
        location.city,
        location.country,
        location.lat,
        location.lon,
        forecast.temp_max,
        forecast.temp_min,
        forecast.precip_type,
        actual.temp_max,
        actual.temp_min,
        actual.precip_type,
        tempMaxError,
        tempMinError,
        precipMatch,
        daysAhead
      );
      matched++;
    }
  });

  tx();
  console.log(`Computed accuracy for ${matched} date(s) with matching forecasts.`);
  return matched;
}

/**
 * When arriving at a new location (>50km move), fetch the past 7 days
 * of actual weather and compare against any forecasts we had.
 */
async function handleLocationChange(db, location) {
  const today = new Date();
  // Historical API has a ~5 day delay, so fetch up to 5 days ago
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() - 5);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6); // 7 days total

  const startStr = isoDate(startDate);
  const endStr = isoDate(endDate);

  console.log(`Fetching historical weather for ${location.city}: ${startStr} to ${endStr}`);

  try {
    const actuals = await fetchHistoricalWeather(location.lat, location.lon, startStr, endStr);
    if (actuals.length === 0) return { actuals: [], matched: 0 };

    storeActuals(db, actuals, location);
    const matched = computeAccuracy(db, actuals, location);

    return { actuals, matched };
  } catch (err) {
    console.log(`Historical fetch failed (non-fatal): ${err.message}`);
    return { actuals: [], matched: 0 };
  }
}

// ──────────────────────────────────────────────
// 8. Change detection
// ──────────────────────────────────────────────

function detectChanges(currentDays, previousMap, threshold) {
  if (!previousMap) return [];

  const changes = [];

  for (const day of currentDays) {
    const prev = previousMap[day.date];
    if (!prev) continue;

    const maxDelta = Math.abs(day.temp_max - prev.temp_max);
    const minDelta = Math.abs(day.temp_min - prev.temp_min);

    if (maxDelta >= threshold) {
      changes.push({
        type: "temperature",
        date: day.date,
        detail: `High temp changed by ${maxDelta.toFixed(1)} C: ${prev.temp_max} C -> ${day.temp_max} C`,
      });
    }
    if (minDelta >= threshold) {
      changes.push({
        type: "temperature",
        date: day.date,
        detail: `Low temp changed by ${minDelta.toFixed(1)} C: ${prev.temp_min} C -> ${day.temp_min} C`,
      });
    }

    if (day.precip_type !== prev.precip_type) {
      changes.push({
        type: "precipitation",
        date: day.date,
        detail: `Precipitation changed: ${prev.precip_type} (${prev.weather_label}) -> ${day.precip_type} (${day.weather_label})`,
      });
    }
  }

  return changes;
}

// ──────────────────────────────────────────────
// 9. Dashboard generator
// ──────────────────────────────────────────────

function getDashboardData(db) {
  const latestFetchRow = db
    .prepare(`SELECT fetched_at FROM forecasts ORDER BY fetched_at DESC LIMIT 1`)
    .get();
  const latestForecast = latestFetchRow
    ? db.prepare(`SELECT * FROM forecasts WHERE fetched_at = ? ORDER BY forecast_date`).all(latestFetchRow.fetched_at)
    : [];

  const fetchTimestamps = db
    .prepare(`SELECT DISTINCT fetched_at FROM forecasts ORDER BY fetched_at DESC LIMIT 20`)
    .all()
    .map((r) => r.fetched_at);

  const history = {};
  for (const ts of fetchTimestamps) {
    history[ts] = db
      .prepare(`SELECT * FROM forecasts WHERE fetched_at = ? ORDER BY forecast_date`)
      .all(ts);
  }

  const recentAlerts = db
    .prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50`)
    .all();

  // Location history
  const locationHistory = db
    .prepare(`SELECT * FROM locations ORDER BY detected_at DESC LIMIT 30`)
    .all();

  // Accuracy reports
  const accuracyReports = db
    .prepare(`SELECT * FROM accuracy_reports ORDER BY report_date DESC LIMIT 100`)
    .all();

  // Per-city accuracy summary
  const accuracySummary = db
    .prepare(`
      SELECT
        location_city,
        location_country,
        COUNT(*) as total_days,
        ROUND(AVG(temp_max_error), 1) as avg_temp_max_error,
        ROUND(AVG(temp_min_error), 1) as avg_temp_min_error,
        ROUND(AVG(precip_match) * 100, 0) as precip_accuracy_pct,
        ROUND(AVG(temp_max_error + temp_min_error) / 2, 1) as avg_overall_temp_error
      FROM accuracy_reports
      GROUP BY location_city
      ORDER BY total_days DESC
    `)
    .all();

  // Accuracy by days-ahead (how accuracy degrades with longer forecast horizons)
  const accuracyByHorizon = db
    .prepare(`
      SELECT
        days_ahead,
        COUNT(*) as sample_count,
        ROUND(AVG(temp_max_error), 1) as avg_temp_max_error,
        ROUND(AVG(temp_min_error), 1) as avg_temp_min_error,
        ROUND(AVG(precip_match) * 100, 0) as precip_accuracy_pct
      FROM accuracy_reports
      WHERE days_ahead IS NOT NULL
      GROUP BY days_ahead
      ORDER BY days_ahead ASC
    `)
    .all();

  return {
    latestForecast, history, fetchTimestamps, recentAlerts,
    locationHistory, accuracyReports, accuracySummary, accuracyByHorizon,
  };
}

function generateDashboard(db, location, changes, locationChangeInfo) {
  const data = getDashboardData(db);
  const dashboardDataJSON = JSON.stringify(data);
  const locationJSON = JSON.stringify(location);
  const changesJSON = JSON.stringify(changes);
  const locationChangeJSON = JSON.stringify(locationChangeInfo);
  const generatedAt = new Date().toISOString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Weather Dashboard - ${location.city}, ${location.country}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
    --text: #e2e8f0; --muted: #94a3b8; --accent: #38bdf8;
    --green: #4ade80; --red: #f87171; --amber: #fbbf24;
    --blue: #60a5fa; --purple: #a78bfa;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 1.15rem; font-weight: 600; color: var(--accent); margin-bottom: 12px; }
  .subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px; margin-bottom: 24px; }
  .card { background: var(--surface); border-radius: 12px; padding: 20px; }
  .card-full { grid-column: 1 / -1; }
  .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { background: var(--surface); border-radius: 12px; padding: 16px 20px; flex: 1; min-width: 120px; text-align: center; }
  .stat-value { font-size: 1.8rem; font-weight: 700; }
  .stat-label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .forecast-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; }
  .day-card { background: var(--surface2); border-radius: 10px; padding: 14px; min-width: 110px;
              text-align: center; flex-shrink: 0; }
  .day-card .date { font-size: 0.75rem; color: var(--muted); margin-bottom: 6px; }
  .day-card .icon { font-size: 1.8rem; margin-bottom: 4px; }
  .day-card .temps { font-size: 0.9rem; font-weight: 600; }
  .day-card .temps .lo { color: var(--muted); font-weight: 400; }
  .day-card .label { font-size: 0.7rem; color: var(--muted); margin-top: 4px; }
  .day-card .precip { font-size: 0.7rem; color: var(--blue); margin-top: 2px; }
  .alert-list { max-height: 260px; overflow-y: auto; }
  .alert-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0;
                border-bottom: 1px solid var(--surface2); font-size: 0.85rem; }
  .alert-item:last-child { border-bottom: none; }
  .alert-badge { padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 600;
                 flex-shrink: 0; text-transform: uppercase; }
  .alert-badge.temperature { background: rgba(248,113,113,0.15); color: var(--red); }
  .alert-badge.precipitation { background: rgba(96,165,250,0.15); color: var(--blue); }
  .alert-badge.location { background: rgba(167,139,250,0.15); color: var(--purple); }
  .chart-container { position: relative; height: 280px; }
  .no-data { text-align: center; color: var(--muted); padding: 40px; font-size: 0.9rem; }
  canvas { max-width: 100%; }
  .loc-timeline { display: flex; flex-direction: column; gap: 0; max-height: 300px; overflow-y: auto; }
  .loc-entry { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--surface2); font-size: 0.85rem; }
  .loc-entry:last-child { border-bottom: none; }
  .loc-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .loc-dot.move { background: var(--purple); }
  .loc-dot.stay { background: var(--surface2); }
  .accuracy-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .accuracy-table th { text-align: left; color: var(--muted); font-weight: 600; font-size: 0.75rem;
                       text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; border-bottom: 1px solid var(--surface2); }
  .accuracy-table td { padding: 8px 12px; border-bottom: 1px solid var(--surface2); }
  .accuracy-grade { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
</style>
</head>
<body>

<h1>Weather Dashboard</h1>
<p class="subtitle" id="subtitle">Loading...</p>

<div class="stat-row" id="stats"></div>

<div class="card" style="margin-bottom: 20px;">
  <h2>7-Day Forecast</h2>
  <div class="forecast-strip" id="forecastStrip"></div>
</div>

<div class="grid">
  <div class="card">
    <h2>Temperature Trends</h2>
    <div class="chart-container"><canvas id="tempChart"></canvas></div>
  </div>
  <div class="card">
    <h2>Precipitation &amp; Wind</h2>
    <div class="chart-container"><canvas id="precipChart"></canvas></div>
  </div>
  <div class="card card-full">
    <h2>Forecast Revision History</h2>
    <p style="color:var(--muted);font-size:0.8rem;margin-bottom:12px;">
      How the forecast for each date has shifted across fetches
    </p>
    <div class="chart-container" style="height:320px;"><canvas id="revisionChart"></canvas></div>
  </div>
</div>

<div class="grid" style="margin-top:4px;">
  <div class="card">
    <h2>Forecast Accuracy by Location</h2>
    <div id="accuracyTable"></div>
  </div>
  <div class="card">
    <h2>Accuracy by Forecast Horizon</h2>
    <div class="chart-container"><canvas id="horizonChart"></canvas></div>
  </div>
  <div class="card">
    <h2>Predicted vs Actual Temperatures</h2>
    <div class="chart-container"><canvas id="scatterChart"></canvas></div>
  </div>
  <div class="card">
    <h2>Location Timeline</h2>
    <div class="loc-timeline" id="locTimeline"></div>
  </div>
</div>

<div class="card card-full" style="margin-top:4px;">
  <h2>Recent Alerts</h2>
  <div class="alert-list" id="alertList"></div>
</div>

<script>
const DATA     = ${dashboardDataJSON};
const LOCATION = ${locationJSON};
const CHANGES  = ${changesJSON};
const LOC_CHANGE = ${locationChangeJSON};
const GENERATED = "${generatedAt}";

const ICONS = { none: "\\u2600\\uFE0F", rain: "\\uD83C\\uDF27\\uFE0F", snow: "\\u2744\\uFE0F", storm: "\\u26C8\\uFE0F", unknown: "\\uD83C\\uDF24\\uFE0F" };

document.getElementById("subtitle").textContent =
  LOCATION.city + ", " + LOCATION.country + "  \\u2022  Updated " + new Date(GENERATED).toLocaleString();

// ── Stats ──
(function() {
  var f = DATA.latestForecast;
  if (!f.length) return;
  var maxT = Math.max.apply(null, f.map(function(d){return d.temp_max}));
  var minT = Math.min.apply(null, f.map(function(d){return d.temp_min}));
  var totalPrecip = f.reduce(function(s,d){return s + (d.precipitation_mm||0)}, 0);
  var maxWind = Math.max.apply(null, f.map(function(d){return d.wind_max_kmh||0}));
  var avgAccuracy = DATA.accuracySummary.length > 0
    ? DATA.accuracySummary.reduce(function(s,a){return s + a.avg_overall_temp_error}, 0) / DATA.accuracySummary.length
    : null;
  var stats = [
    { value: maxT + "\\u00B0", label: "Week High", color: "var(--red)" },
    { value: minT + "\\u00B0", label: "Week Low", color: "var(--blue)" },
    { value: totalPrecip.toFixed(1) + "mm", label: "Total Precip", color: "var(--accent)" },
    { value: maxWind.toFixed(0) + " km/h", label: "Max Wind", color: "var(--purple)" },
    { value: DATA.locationHistory.length, label: "Locations", color: "var(--purple)" },
    { value: avgAccuracy !== null ? "\\u00B1" + avgAccuracy.toFixed(1) + "\\u00B0" : "N/A", label: "Avg Temp Error", color: avgAccuracy !== null && avgAccuracy <= 3 ? "var(--green)" : "var(--amber)" },
  ];
  document.getElementById("stats").innerHTML = stats.map(function(s){
    return '<div class="stat"><div class="stat-value" style="color:'+s.color+'">'+s.value+'</div><div class="stat-label">'+s.label+'</div></div>';
  }).join("");
})();

// ── 7-day strip ──
(function() {
  var el = document.getElementById("forecastStrip");
  if (!DATA.latestForecast.length) { el.innerHTML = '<div class="no-data">No forecast data yet</div>'; return; }
  el.innerHTML = DATA.latestForecast.map(function(d) {
    var dayName = new Date(d.forecast_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    var icon = ICONS[d.precip_type] || ICONS.unknown;
    return '<div class="day-card">' +
      '<div class="date">' + dayName + '</div>' +
      '<div class="icon">' + icon + '</div>' +
      '<div class="temps">' + d.temp_max + '\\u00B0 <span class="lo">' + d.temp_min + '\\u00B0</span></div>' +
      '<div class="label">' + d.weather_label + '</div>' +
      (d.precipitation_mm > 0 ? '<div class="precip">' + d.precipitation_mm + ' mm</div>' : '') +
      '</div>';
  }).join("");
})();

Chart.defaults.color = "#94a3b8";
Chart.defaults.borderColor = "rgba(148,163,184,0.1)";
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

// ── Temp chart ──
(function() {
  var f = DATA.latestForecast; if (!f.length) return;
  new Chart(document.getElementById("tempChart"), {
    type: "line",
    data: { labels: f.map(function(d){return d.forecast_date.slice(5)}),
      datasets: [
        { label:"High", data:f.map(function(d){return d.temp_max}), borderColor:"#f87171", backgroundColor:"rgba(248,113,113,0.1)", fill:"+1", tension:0.3, pointRadius:4, pointBackgroundColor:"#f87171" },
        { label:"Low", data:f.map(function(d){return d.temp_min}), borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.1)", fill:false, tension:0.3, pointRadius:4, pointBackgroundColor:"#60a5fa" },
      ] },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"top"}, tooltip:{callbacks:{label:function(ctx){return ctx.dataset.label+": "+ctx.parsed.y+" \\u00B0C"}}} },
      scales:{ y:{ticks:{callback:function(v){return v+"\\u00B0"}}} } },
  });
})();

// ── Precip+wind chart ──
(function() {
  var f = DATA.latestForecast; if (!f.length) return;
  new Chart(document.getElementById("precipChart"), {
    type: "bar",
    data: { labels: f.map(function(d){return d.forecast_date.slice(5)}),
      datasets: [
        { label:"Precip (mm)", data:f.map(function(d){return d.precipitation_mm}), backgroundColor:"rgba(56,189,248,0.5)", borderColor:"#38bdf8", borderWidth:1, yAxisID:"y", borderRadius:4 },
        { label:"Wind (km/h)", data:f.map(function(d){return d.wind_max_kmh}), type:"line", borderColor:"#a78bfa", backgroundColor:"rgba(167,139,250,0.1)", tension:0.3, pointRadius:4, pointBackgroundColor:"#a78bfa", yAxisID:"y1" },
      ] },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"top"} },
      scales:{ y:{position:"left",title:{display:true,text:"mm"},beginAtZero:true}, y1:{position:"right",title:{display:true,text:"km/h"},beginAtZero:true,grid:{drawOnChartArea:false}} } },
  });
})();

// ── Revision chart ──
(function() {
  var timestamps = DATA.fetchTimestamps.slice().reverse();
  if (timestamps.length < 2) { document.getElementById("revisionChart").parentElement.innerHTML = '<div class="no-data">Need at least 2 fetches to show revision history</div>'; return; }
  var allDates = []; timestamps.forEach(function(ts){ DATA.history[ts].forEach(function(r){ if(allDates.indexOf(r.forecast_date)===-1) allDates.push(r.forecast_date); }); }); allDates.sort();
  var colors = ["#f87171","#38bdf8","#4ade80","#fbbf24","#a78bfa","#fb923c","#e879f9","#34d399","#f472b6","#22d3ee","#facc15","#818cf8","#c084fc","#fb7185"];
  var datasets = allDates.map(function(date, i) {
    var pts = timestamps.map(function(ts){ var r = DATA.history[ts].find(function(x){return x.forecast_date===date}); return r ? r.temp_max : null; });
    return { label:date, data:pts, borderColor:colors[i%colors.length], tension:0.3, pointRadius:3, spanGaps:true };
  });
  new Chart(document.getElementById("revisionChart"), {
    type:"line", data:{ labels:timestamps.map(function(ts){return new Date(ts+"Z").toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}), datasets:datasets },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"bottom",labels:{boxWidth:12,padding:10,font:{size:11}}} },
      scales:{ x:{title:{display:true,text:"Fetch Time"}}, y:{title:{display:true,text:"High Temp (\\u00B0C)"},ticks:{callback:function(v){return v+"\\u00B0"}}} } },
  });
})();

// ── Accuracy table ──
(function() {
  var el = document.getElementById("accuracyTable");
  if (!DATA.accuracySummary.length) { el.innerHTML = '<div class="no-data">No accuracy data yet. Travel to a new location (>50km) to start collecting.</div>'; return; }
  function grade(err) {
    if (err <= 2) return { text:"Excellent", bg:"rgba(74,222,128,0.15)", color:"#4ade80" };
    if (err <= 4) return { text:"Good", bg:"rgba(56,189,248,0.15)", color:"#38bdf8" };
    if (err <= 6) return { text:"Fair", bg:"rgba(251,191,36,0.15)", color:"#fbbf24" };
    return { text:"Poor", bg:"rgba(248,113,113,0.15)", color:"#f87171" };
  }
  var html = '<table class="accuracy-table"><thead><tr><th>Location</th><th>Days</th><th>Temp Error</th><th>Precip Match</th><th>Grade</th></tr></thead><tbody>';
  DATA.accuracySummary.forEach(function(a) {
    var g = grade(a.avg_overall_temp_error);
    html += '<tr><td>' + a.location_city + ', ' + a.location_country + '</td>' +
      '<td>' + a.total_days + '</td>' +
      '<td>\\u00B1' + a.avg_overall_temp_error + '\\u00B0C</td>' +
      '<td>' + a.precip_accuracy_pct + '%</td>' +
      '<td><span class="accuracy-grade" style="background:'+g.bg+';color:'+g.color+'">'+g.text+'</span></td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
})();

// ── Accuracy by horizon chart ──
(function() {
  var h = DATA.accuracyByHorizon;
  if (!h.length) { document.getElementById("horizonChart").parentElement.innerHTML = '<div class="no-data">No horizon data yet</div>'; return; }
  new Chart(document.getElementById("horizonChart"), {
    type: "bar",
    data: { labels: h.map(function(d){return "Day "+d.days_ahead}),
      datasets: [
        { label:"Avg High Error (\\u00B0C)", data:h.map(function(d){return d.avg_temp_max_error}), backgroundColor:"rgba(248,113,113,0.5)", borderColor:"#f87171", borderWidth:1, borderRadius:4 },
        { label:"Avg Low Error (\\u00B0C)", data:h.map(function(d){return d.avg_temp_min_error}), backgroundColor:"rgba(96,165,250,0.5)", borderColor:"#60a5fa", borderWidth:1, borderRadius:4 },
      ] },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"top"} },
      scales:{ y:{beginAtZero:true, title:{display:true,text:"Error (\\u00B0C)"}} } },
  });
})();

// ── Predicted vs actual scatter ──
(function() {
  var ar = DATA.accuracyReports;
  if (!ar.length) { document.getElementById("scatterChart").parentElement.innerHTML = '<div class="no-data">No accuracy data yet</div>'; return; }
  var maxPts = ar.map(function(r){return {x:r.forecast_temp_max, y:r.actual_temp_max}});
  var minPts = ar.map(function(r){return {x:r.forecast_temp_min, y:r.actual_temp_min}});
  var allVals = ar.flatMap(function(r){return [r.forecast_temp_max,r.actual_temp_max,r.forecast_temp_min,r.actual_temp_min]});
  var lo = Math.floor(Math.min.apply(null,allVals))-2;
  var hi = Math.ceil(Math.max.apply(null,allVals))+2;
  new Chart(document.getElementById("scatterChart"), {
    type: "scatter",
    data: { datasets: [
      { label:"High Temps", data:maxPts, backgroundColor:"rgba(248,113,113,0.5)", borderColor:"#f87171", pointRadius:5 },
      { label:"Low Temps", data:minPts, backgroundColor:"rgba(96,165,250,0.5)", borderColor:"#60a5fa", pointRadius:5 },
      { label:"Perfect", data:[{x:lo,y:lo},{x:hi,y:hi}], type:"line", borderColor:"rgba(148,163,184,0.3)", borderDash:[5,5], pointRadius:0, borderWidth:1 },
    ] },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:"top"}, tooltip:{callbacks:{label:function(ctx){return ctx.dataset.label+": predicted "+ctx.parsed.x+"\\u00B0, actual "+ctx.parsed.y+"\\u00B0"}}} },
      scales:{ x:{title:{display:true,text:"Predicted (\\u00B0C)"},min:lo,max:hi}, y:{title:{display:true,text:"Actual (\\u00B0C)"},min:lo,max:hi} } },
  });
})();

// ── Location timeline ──
(function() {
  var el = document.getElementById("locTimeline");
  if (!DATA.locationHistory.length) { el.innerHTML = '<div class="no-data">No location history yet</div>'; return; }
  el.innerHTML = DATA.locationHistory.map(function(loc) {
    var isMajorMove = loc.distance_from_prev_km >= 50;
    var dotClass = isMajorMove ? "move" : "stay";
    var dist = loc.distance_from_prev_km > 0 ? " (" + Math.round(loc.distance_from_prev_km) + " km)" : "";
    var time = new Date(loc.detected_at + "Z").toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    return '<div class="loc-entry">' +
      '<span class="loc-dot ' + dotClass + '"></span>' +
      '<span style="min-width:120px;color:var(--muted);">' + time + '</span>' +
      '<span style="font-weight:' + (isMajorMove ? '600' : '400') + ';">' + loc.city + ', ' + loc.country + dist + '</span>' +
      '</div>';
  }).join("");
})();

// ── Alerts ──
(function() {
  var el = document.getElementById("alertList");
  if (!DATA.recentAlerts.length) { el.innerHTML = '<div class="no-data">No alerts recorded yet</div>'; return; }
  el.innerHTML = DATA.recentAlerts.map(function(a) {
    return '<div class="alert-item">' +
      '<span class="alert-badge ' + a.alert_type + '">' + a.alert_type + '</span>' +
      '<span class="alert-date" style="color:var(--muted);min-width:80px;">' + (a.forecast_date || "") + '</span>' +
      '<span>' + a.details + '</span></div>';
  }).join("");
})();
<\/script>
</body>
</html>`;

  fs.writeFileSync(CONFIG.dashboardPath, html, "utf-8");
  console.log(`Dashboard written to ${CONFIG.dashboardPath}`);
}

// ──────────────────────────────────────────────
// 10. Alerting — store + email with dashboard link
// ──────────────────────────────────────────────

function storeAlerts(db, changes) {
  const insert = db.prepare(`
    INSERT INTO alerts (alert_type, forecast_date, details)
    VALUES (@type, @date, @detail)
  `);
  const tx = db.transaction((rows) => {
    for (const c of rows) insert.run(c);
  });
  tx(changes);
}

async function sendAlertEmail(changes, location, locationChangeInfo) {
  if (!CONFIG.smtpUser || !CONFIG.alertEmail) {
    console.log("Email not configured -- skipping send. Set SMTP_USER, SMTP_PASS, ALERT_EMAIL in .env");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    secure: CONFIG.smtpPort === 465,
    auth: { user: CONFIG.smtpUser, pass: CONFIG.smtpPass },
  });

  const dashboardFile = path.resolve(CONFIG.dashboardPath);

  const tempChanges = changes.filter((c) => c.type === "temperature");
  const precipChanges = changes.filter((c) => c.type === "precipitation");
  const locationChanges = changes.filter((c) => c.type === "location");

  const textLines = [
    `Weather Forecast Changes -- ${location.city}, ${location.country}`,
    `${"=".repeat(50)}`,
    "",
  ];

  if (locationChangeInfo && locationChangeInfo.moved) {
    textLines.push(`LOCATION CHANGE: Moved ${locationChangeInfo.distanceKm.toFixed(0)} km from ${locationChangeInfo.previousLocation.city}`);
    textLines.push("");
  }

  textLines.push(`${changes.length} material change(s) detected:`);
  textLines.push("");
  changes.forEach((c) => textLines.push(`  [${c.date}] ${c.detail}`));
  textLines.push("");
  textLines.push(`Dashboard: file://${dashboardFile}`);
  textLines.push("");
  textLines.push("-- Local Weather Tracker");

  const locationBanner = locationChangeInfo && locationChangeInfo.moved ? `
    <div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:10px;padding:16px;margin-bottom:16px;">
      <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;color:#7c3aed;margin-bottom:6px;font-weight:600;">Location Change</div>
      <p style="margin:0;color:#4c1d95;font-size:0.9rem;">
        Moved <strong>${locationChangeInfo.distanceKm.toFixed(0)} km</strong> from ${locationChangeInfo.previousLocation.city} to <strong>${location.city}</strong>.
        Historical weather data has been fetched for accuracy analysis.
      </p>
    </div>` : "";

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f8fafc;padding:0;margin:0;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:16px;padding:28px;color:#e2e8f0;">
      <h1 style="margin:0 0 4px;font-size:1.4rem;color:#fff;">Weather Alert</h1>
      <p style="margin:0;color:#94a3b8;font-size:0.85rem;">${location.city}, ${location.country} &bull; ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
    </div>
    <div style="background:#fff;border-radius:12px;margin-top:16px;padding:24px;border:1px solid #e2e8f0;">
      ${locationBanner}
      <p style="margin:0 0 16px;color:#334155;font-size:0.95rem;">
        <strong>${changes.length}</strong> material forecast change${changes.length > 1 ? "s" : ""} detected since the last check:
      </p>
      ${tempChanges.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:8px;font-weight:600;">Temperature Changes</div>
        ${tempChanges.map((c) => `
        <div style="display:flex;align-items:center;padding:8px 12px;background:#fef2f2;border-radius:8px;margin-bottom:6px;font-size:0.85rem;color:#991b1b;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171;margin-right:10px;flex-shrink:0;"></span>
          <strong style="min-width:80px;">${c.date}</strong>
          <span style="margin-left:8px;">${c.detail}</span>
        </div>`).join("")}
      </div>` : ""}
      ${precipChanges.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:8px;font-weight:600;">Precipitation Changes</div>
        ${precipChanges.map((c) => `
        <div style="display:flex;align-items:center;padding:8px 12px;background:#eff6ff;border-radius:8px;margin-bottom:6px;font-size:0.85rem;color:#1e40af;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#60a5fa;margin-right:10px;flex-shrink:0;"></span>
          <strong style="min-width:80px;">${c.date}</strong>
          <span style="margin-left:8px;">${c.detail}</span>
        </div>`).join("")}
      </div>` : ""}
      <div style="text-align:center;margin-top:24px;">
        <a href="file://${dashboardFile}" style="display:inline-block;padding:12px 28px;background:#0f172a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.9rem;">
          Open Dashboard
        </a>
      </div>
    </div>
    <p style="text-align:center;color:#94a3b8;font-size:0.75rem;margin-top:16px;">
      Sent by Local Weather Tracker &bull; Threshold: &plusmn;${CONFIG.tempThreshold}&deg;C or precip type change
    </p>
  </div>
</body>
</html>`;

  const subject = locationChangeInfo && locationChangeInfo.moved
    ? `Weather Alert: New location ${location.city} + ${changes.length} change(s)`
    : `Weather Alert: ${changes.length} forecast change(s) -- ${location.city}`;

  await transporter.sendMail({
    from: CONFIG.smtpUser,
    to: CONFIG.alertEmail,
    subject,
    text: textLines.join("\n"),
    html: htmlBody,
  });

  console.log(`Alert email sent to ${CONFIG.alertEmail}`);
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  console.log("=".repeat(45));
  console.log(" Local Weather Tracker -- " + new Date().toISOString());
  console.log("=".repeat(45) + "\n");

  // 1. Geolocate
  const location = await getLocation();

  // 2. Init DB + check location change
  const db = initDb(CONFIG.dbPath);
  const locationChangeInfo = checkLocationChange(db, location);

  // 3. If we've moved >50km, fetch historical data for the new location
  if (locationChangeInfo.moved) {
    await handleLocationChange(db, location);
  }

  // 4. Fetch forecast
  const forecast = await fetchForecast(location.lat, location.lon);
  console.log(`Fetched 7-day forecast for ${location.city}:`);
  for (const d of forecast) {
    console.log(`   ${d.date}  ${d.temp_min} - ${d.temp_max} C  ${d.weather_label}  ${d.precipitation_mm}mm`);
  }

  // 5. Store forecast
  storeForecast(db, forecast, location);

  // 6. Compare with previous forecast
  const previous = getPreviousForecast(db, location);
  const changes = detectChanges(forecast, previous, CONFIG.tempThreshold);

  // Add location change as an alert if applicable
  if (locationChangeInfo.moved) {
    changes.unshift({
      type: "location",
      date: isoDate(new Date()),
      detail: `Moved ${locationChangeInfo.distanceKm.toFixed(0)} km: ${locationChangeInfo.previousLocation.city} -> ${location.city}`,
    });
  }

  if (changes.length === 0) {
    console.log("\nNo material changes detected.");
  } else {
    console.log(`\n${changes.length} material change(s) detected:`);
    for (const c of changes) console.log(`   [${c.date}] ${c.detail}`);

    storeAlerts(db, changes);

    if (!CONFIG.dryRun) {
      await sendAlertEmail(changes, location, locationChangeInfo);
    } else {
      console.log("Dry-run mode -- email not sent.");
    }
  }

  // 7. Generate dashboard (always)
  generateDashboard(db, location, changes, locationChangeInfo);

  db.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

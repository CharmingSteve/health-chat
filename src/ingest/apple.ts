import { SaxesParser, type SaxesTag } from "saxes";

// Apple Health export.xml, read as a stream so the 1.6 GiB file never has to fit in memory.
// Every Record and every Workout is kept, whatever its type (walking, skating, CrossFit, sleep, heart rate, ...).

export interface AppleRecord {
  owner: string;
  type: string;
  source_name: string | null;
  unit: string | null;
  creation_date: string | null;
  start_date: string | null;
  end_date: string | null;
  value_text: string | null;
  value_num: number | null;
}

export interface AppleWorkout {
  owner: string;
  activity_type: string;
  source_name: string | null;
  start_date: string | null;
  end_date: string | null;
  creation_date: string | null;
  duration: number | null;
  duration_unit: string | null;
  total_distance: number | null;
  total_distance_unit: string | null;
  total_energy: number | null;
  total_energy_unit: string | null;
  route_file: string | null;
  statistics: string; // JSON array of {type, sum, unit, average, minimum, maximum}
}

export interface AppleSinks {
  record(row: AppleRecord): void;
  workout(row: AppleWorkout): void;
}

const num = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const str = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);

/** Streams export.xml text chunks through the parser and calls the sinks for each Record and Workout. */
export function parseExport(owner: string, sinks: AppleSinks): { write(chunk: string): void; end(): { records: number; workouts: number; statisticsRows: number } } {
  const parser = new SaxesParser({ xmlns: false });
  let records = 0;
  let workouts = 0;
  let statisticsRows = 0;
  let current: { attrs: Record<string, string>; stats: object[]; route: string | null } | null = null;
  let inRoute = false;

  parser.on("opentag", (tag: SaxesTag) => {
    const a = tag.attributes as Record<string, string>;
    if (tag.name === "Record") {
      const value = a.value;
      sinks.record({
        owner,
        type: a.type ?? "",
        source_name: str(a.sourceName),
        unit: str(a.unit),
        creation_date: str(a.creationDate),
        start_date: str(a.startDate),
        end_date: str(a.endDate),
        value_text: str(value),
        value_num: num(value),
      });
      records += 1;
    } else if (tag.name === "Workout") {
      current = { attrs: a, stats: [], route: null };
    } else if (tag.name === "WorkoutStatistics" && current) {
      current.stats.push({
        type: a.type ?? null, sum: num(a.sum), unit: str(a.unit),
        average: num(a.average), minimum: num(a.minimum), maximum: num(a.maximum),
      });
      statisticsRows += 1;
    } else if (tag.name === "WorkoutRoute") {
      inRoute = true;
    } else if (tag.name === "FileReference" && current && inRoute) {
      current.route = str(a.path);
    }
  });

  parser.on("closetag", (tag: SaxesTag) => {
    if (tag.name === "WorkoutRoute") inRoute = false;
    if (tag.name === "Workout" && current) {
      const a = current.attrs;
      sinks.workout({
        owner,
        activity_type: a.workoutActivityType ?? "unknown",
        source_name: str(a.sourceName),
        start_date: str(a.startDate),
        end_date: str(a.endDate),
        creation_date: str(a.creationDate),
        duration: num(a.duration),
        duration_unit: str(a.durationUnit),
        total_distance: num(a.totalDistance),
        total_distance_unit: str(a.totalDistanceUnit),
        total_energy: num(a.totalEnergyBurned),
        total_energy_unit: str(a.totalEnergyBurnedUnit),
        route_file: current.route,
        statistics: JSON.stringify(current.stats),
      });
      workouts += 1;
      current = null;
    }
  });

  parser.on("error", (error: Error) => {
    throw error;
  });

  return {
    write(chunk: string) {
      parser.write(chunk);
    },
    end() {
      parser.close();
      return { records, workouts, statisticsRows };
    },
  };
}

// ---- GPX routes -------------------------------------------------------------------------------

export interface RouteSummary {
  owner: string;
  file: string;
  name: string | null;
  start_time: string | null;
  end_time: string | null;
  points: number;
  distance_m: number;
}

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance in metres between two lat/lon points (haversine). */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function parseGpx(owner: string, file: string, text: string): RouteSummary {
  const parser = new SaxesParser({ xmlns: false });
  const points: { lat: number; lon: number; time: string | null }[] = [];
  let name: string | null = null;
  let inName = false;
  let inTime = false;
  let pointTime: string | null = null;
  let nameBuf = "";
  let timeBuf = "";
  let pending: { lat: number; lon: number } | null = null;

  parser.on("opentag", (tag: SaxesTag) => {
    const a = tag.attributes as Record<string, string>;
    if (tag.name === "trkpt") {
      pending = { lat: Number(a.lat), lon: Number(a.lon) };
      pointTime = null;
    } else if (tag.name === "name" && name === null) {
      inName = true;
      nameBuf = "";
    } else if (tag.name === "time" && pending) {
      inTime = true;
      timeBuf = "";
    }
  });
  parser.on("text", (t: string) => {
    if (inName) nameBuf += t;
    if (inTime) timeBuf += t;
  });
  parser.on("closetag", (tag: SaxesTag) => {
    if (tag.name === "name" && inName) {
      name = nameBuf.trim() || null;
      inName = false;
    } else if (tag.name === "time" && inTime) {
      pointTime = timeBuf.trim() || null;
      inTime = false;
    } else if (tag.name === "trkpt" && pending) {
      points.push({ ...pending, time: pointTime });
      pending = null;
    }
  });
  parser.write(text);
  parser.close();

  let distance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev && cur) distance += haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
  }
  const times = points.map((p) => p.time).filter((t): t is string => t !== null);
  return {
    owner,
    file,
    name,
    start_time: times[0] ?? null,
    end_time: times[times.length - 1] ?? null,
    points: points.length,
    distance_m: Math.round(distance * 100) / 100,
  };
}

// ---- ECG recordings --------------------------------------------------------------------------

export interface EcgRecording {
  owner: string;
  file: string;
  recorded_date: string | null;
  classification: string | null;
  device: string | null;
  sample_rate_hz: number | null;
  lead: string | null;
  unit: string | null;
  sample_count: number;
}

/** Parses one Apple ECG CSV: a header of "Key,Value" lines, a blank line, then one microvolt value per line. */
export function parseEcgCsv(owner: string, file: string, text: string): { recording: EcgRecording; samples: number[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const meta: Record<string, string> = {};
  const samples: number[] = [];
  // Header lines are "Key,Value"; sample lines are a bare number; blank lines separate sections.
  // The patient name and date of birth are never read into a field, so they are never stored.
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(line)) {
      samples.push(Number(line));
      continue;
    }
    const comma = line.indexOf(",");
    if (comma > 0) meta[line.slice(0, comma).trim()] = line.slice(comma + 1).replace(/^"|"$/g, "").trim();
  }
  const rateMatch = /([\d.]+)/.exec(meta["Sample Rate"] ?? "");
  return {
    recording: {
      owner,
      file,
      recorded_date: meta["Recorded Date"] ?? null,
      classification: meta["Classification"] ?? null,
      device: meta["Device"] ?? null,
      sample_rate_hz: rateMatch?.[1] ? Number(rateMatch[1]) : null,
      lead: meta["Lead"] ?? null,
      unit: meta["Unit"] ?? null,
      sample_count: samples.length,
    },
    samples,
  };
}

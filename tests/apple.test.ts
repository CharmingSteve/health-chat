import { describe, expect, it } from "vitest";
import { parseEcgCsv, parseExport, parseGpx, haversineM, type AppleRecord, type AppleWorkout } from "../src/ingest/apple.js";

const OWNER = "owner";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Test Watch" unit="count" creationDate="2026-01-02 10:00:00 +0200" startDate="2026-01-02 09:00:00 +0200" endDate="2026-01-02 09:05:00 +0200" value="120"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" creationDate="2026-01-02 07:00:00 +0200" startDate="2026-01-01 23:00:00 +0200" endDate="2026-01-02 06:00:00 +0200" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeSkatingSports" duration="45" durationUnit="min" sourceName="Watch" creationDate="2026-01-03 18:00:00 +0200" startDate="2026-01-03 17:00:00 +0200" endDate="2026-01-03 17:45:00 +0200">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="350" unit="kcal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeCrossTraining" duration="60" durationUnit="min" sourceName="Watch" startDate="2026-01-04 07:00:00 +0200" endDate="2026-01-04 08:00:00 +0200">
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" minimum="110" maximum="172" unit="count/min"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="30" durationUnit="min" totalDistance="3.2" totalDistanceUnit="km" totalEnergyBurned="180" totalEnergyBurnedUnit="kcal" sourceName="iPhone" startDate="2026-01-05 12:00:00 +0200" endDate="2026-01-05 12:30:00 +0200">
  <WorkoutRoute><FileReference path="/workout-routes/route_2026-01-05_12.00pm.gpx"/></WorkoutRoute>
 </Workout>
</HealthData>`;

function collect(chunks: string[]) {
  const records: AppleRecord[] = [];
  const workouts: AppleWorkout[] = [];
  const parser = parseExport(OWNER, { record: (r) => records.push(r), workout: (w) => workouts.push(w) });
  for (const chunk of chunks) parser.write(chunk);
  const counts = parser.end();
  return { records, workouts, counts };
}

describe("parseExport", () => {
  it("keeps every record and every workout type, including skating, CrossFit, and walking", () => {
    const { records, workouts, counts } = collect([XML]);
    expect(records).toHaveLength(2);
    expect(workouts.map((w) => w.activity_type)).toEqual([
      "HKWorkoutActivityTypeSkatingSports",
      "HKWorkoutActivityTypeCrossTraining",
      "HKWorkoutActivityTypeWalking",
    ]);
    expect(counts).toEqual({ records: 2, workouts: 3, statisticsRows: 2 });
  });

  it("stores numeric values as numbers and category values as text only", () => {
    const { records } = collect([XML]);
    expect(records[0]).toMatchObject({ type: "HKQuantityTypeIdentifierStepCount", value_text: "120", value_num: 120, unit: "count" });
    expect(records[1]).toMatchObject({ value_text: "HKCategoryValueSleepAnalysisAsleepCore", value_num: null });
  });

  it("attaches statistics and the route file to the right workout", () => {
    const { workouts } = collect([XML]);
    expect(JSON.parse(workouts[0]!.statistics)).toEqual([
      { type: "HKQuantityTypeIdentifierActiveEnergyBurned", sum: 350, unit: "kcal", average: null, minimum: null, maximum: null },
    ]);
    expect(JSON.parse(workouts[1]!.statistics)[0]).toMatchObject({ average: 150, minimum: 110, maximum: 172 });
    expect(workouts[2]).toMatchObject({ route_file: "/workout-routes/route_2026-01-05_12.00pm.gpx", total_distance: 3.2, total_energy: 180 });
    expect(workouts[0]!.route_file).toBeNull();
  });

  it("gives the same result when the file arrives in tiny chunks (streaming must not depend on chunk size)", () => {
    const whole = collect([XML]);
    const pieces = XML.match(/[\s\S]{1,7}/g) ?? [];
    const streamed = collect(pieces);
    expect(streamed.counts).toEqual(whole.counts);
    expect(streamed.workouts).toEqual(whole.workouts);
    expect(streamed.records).toEqual(whole.records);
  });
});

describe("GPX routes", () => {
  it("measures one 0.001 degree step of latitude as about 111.19 metres", () => {
    expect(haversineM(31.746, 35.2, 31.747, 35.2)).toBeCloseTo(111.19, 1);
  });

  it("sums the segment distances and reads the start and end times", () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><name>Route test</name><trkseg>
      <trkpt lat="31.746" lon="35.2"><time>2026-09-15T17:58:00Z</time></trkpt>
      <trkpt lat="31.747" lon="35.2"><time>2026-09-15T17:58:30Z</time></trkpt>
      <trkpt lat="31.748" lon="35.2"><time>2026-09-15T17:59:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const route = parseGpx(OWNER, "route.gpx", gpx);
    expect(route).toMatchObject({ name: "Route test", points: 3, start_time: "2026-09-15T17:58:00Z", end_time: "2026-09-15T17:59:00Z" });
    expect(route.distance_m).toBeCloseTo(222.39, 1); // two steps of 111.19 m
  });
});

describe("ECG recordings", () => {
  it("reads metadata and samples, and does not keep the patient name or date of birth", () => {
    const csv = [
      "Name,Patient Name",
      'Date of Birth,"1 Jan 1900"',
      "Recorded Date,2023-05-15 16:05:09 +0200",
      "Classification,High Heart Rate",
      "Device,\"Watch6,14\"",
      "Sample Rate,512 hertz",
      "",
      "Lead,Lead I",
      "Unit,µV",
      "",
      "-13.186",
      "-12.5",
      "",
      "3.25",
      "0",
    ].join("\n");
    const { recording, samples } = parseEcgCsv(OWNER, "ecg.csv", csv);
    expect(recording).toMatchObject({
      recorded_date: "2023-05-15 16:05:09 +0200",
      classification: "High Heart Rate",
      device: "Watch6,14",
      sample_rate_hz: 512,
      lead: "Lead I",
      unit: "µV",
      sample_count: 4,
    });
    expect(samples).toEqual([-13.186, -12.5, 3.25, 0]);
    expect(JSON.stringify(recording)).not.toContain("Patient Name");
    expect(JSON.stringify(recording)).not.toContain("1900");
  });
});

import { describe, expect, it } from "vitest";
import { NAME_MAP, parseClalitExport, parseTestDate } from "../src/ingest/labs.js";

const OWNER = "owner";

// Same layout as the Clalit exports. Patient name and ID here are fake.
const FIXTURE = `﻿הופק מאתר כללית און-ליין ב-08.03.2026,
תוצאות בדיקה מספר 1234,

שם: טסט פטיינט, ת.ז: 000000000, תאריך לידה: 01.01.1970, גיל: 56, מגדר: ז,
מועד הבדיקה: 07:53 11.12.2024,

שם הבדיקה, יחידות מדידה, תוצאה, נורמה תחתון, נורמה עליון,
WBC, K/µl, 6.1, 4.5, 11,
HB, g/dL, 16.4, 13.5, 17.5,
HCT, %, 50.0, 41, 53,
HEMOGLOBIN A1C %, %, 5.9, 4, 5.7,
CHOLESTEROL-LDL calc, mg/dL, 98, , 100,
CHOLESTEROL/ HDL, mg/dL, 39, 40,
SODIUM, mmol/L, 139, 136, 145,
LIPEMIC, , 0 , ,
SOMETHING NEW, mg, 4, 1, 2,
`;

describe("parseTestDate", () => {
  it("reads the test date from the header (DD.MM.YYYY, day first)", () => {
    expect(parseTestDate(FIXTURE)).toBe("2024-12-11");
  });
  it("rejects an impossible date", () => {
    expect(() => parseTestDate("מועד הבדיקה: 07:53 31.02.2024,")).toThrow("Impossible test date");
  });
  it("rejects a file without a test date", () => {
    expect(() => parseTestDate("no date here")).toThrow("not found");
  });
});

describe("parseClalitExport", () => {
  const { rows, unknownNames } = parseClalitExport(OWNER, "blood-tests/2024/PersonList (1).csv", FIXTURE);

  it("reads every result line with its date, unit, value, and reference range", () => {
    const wbc = rows.find((r) => r.test_name === "wbc");
    expect(wbc).toMatchObject({ test_date: "2024-12-11", unit: "K/µl", value_num: 6.1, ref_low: 4.5, ref_high: 11, flag: "in_range" });
    expect(rows).toHaveLength(9); // 8 results + 1 sample flag; the unknown name is one of the 8
  });

  it("maps name variants to one test name", () => {
    expect(rows.find((r) => r.test_name_raw === "CHOLESTEROL/ HDL")?.test_name).toBe("hdl_cholesterol");
    expect(rows.find((r) => r.test_name_raw === "HEMOGLOBIN A1C %")?.test_name).toBe("hba1c");
    expect(rows.find((r) => r.test_name_raw === "CHOLESTEROL-LDL calc")?.test_name).toBe("ldl_cholesterol");
  });

  it("flags values outside the reference range, and leaves unknown ranges unflagged", () => {
    expect(rows.find((r) => r.test_name === "hba1c")?.flag).toBe("high"); // 5.9 > 5.7
    expect(rows.find((r) => r.test_name === "hematocrit")?.flag).toBe("in_range"); // 50 in 41..53
    expect(rows.find((r) => r.test_name_raw === "SODIUM")?.flag).toBe("in_range"); // 139 in 136..145
    expect(rows.find((r) => r.test_name_raw === "CHOLESTEROL-LDL calc")?.flag).toBe("in_range"); // 98 <= 100 with no low bound
  });

  it("reports names that are not in the map, and keeps them", () => {
    expect(unknownNames).toEqual(["SOMETHING NEW"]);
    const unknown = rows.find((r) => r.test_name_raw === "SOMETHING NEW");
    expect(unknown).toMatchObject({ known_name: false, test_name: "something new", value_num: 4 });
  });

  it("keeps sample-quality flags as flags, not as numeric values", () => {
    const flag = rows.find((r) => r.sample_flag === "LIPEMIC");
    expect(flag).toMatchObject({ value_num: 0, flag: null });
  });

  it("never stores the patient name or ID", () => {
    expect(JSON.stringify(rows)).not.toContain("טסט פטיינט");
    expect(JSON.stringify(rows)).not.toContain("000000000");
  });

  it("maps every name seen in the real exports", () => {
    const seen = [
      "GLUCOSE", "CREATININE", "UREA", "WBC", "SODIUM", "POTASSIUM", "HB", "HCT", "MCV", "PLT", "CHOLESTEROL",
      "TRIGLYCERIDES", "HEMOGLOBIN A1C %", "ALT (GPT)", "AST (GOT)", "GGT", "TSH", "PSA", "IRON", "FERRITIN",
    ];
    for (const name of seen) expect(NAME_MAP[name], name).toBeDefined();
  });
});

describe("dedupeLabRows", () => {
  it("keeps one copy of a repeated result and counts the removed copies", async () => {
    const { dedupeLabRows } = await import("../src/ingest/labs.js");
    const base = { owner: OWNER, test_date: "2021-12-14", test_name_raw: "HEMOGLOBIN A1C %", test_name: "hba1c", known_name: true, unit: "%", value_text: "6.1", value_num: 6.1, ref_low: null, ref_high: 5.7, flag: "high" as const, sample_flag: null, source_file: "a.csv" };
    const { rows, removed } = dedupeLabRows([base, { ...base, source_file: "b.csv" }, { ...base, test_date: "2021-12-15" }]);
    expect(removed).toBe(1);
    expect(rows).toHaveLength(2);
  });
});

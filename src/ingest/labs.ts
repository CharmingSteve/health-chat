// Clalit online lab exports ("PersonList" CSV files).
// Layout: a header block (exported date, patient line, test date "מועד הבדיקה: HH:MM DD.MM.YYYY"),
// then one line per result: NAME, unit, result, reference low, reference high.
// The patient name and ID in the header are read only to confirm the owner; they are never stored.

export interface LabRow {
  owner: string;
  test_date: string; // yyyy-mm-dd
  test_name_raw: string;
  test_name: string; // normalized name (see NAME_MAP)
  known_name: boolean;
  unit: string | null;
  value_text: string;
  value_num: number | null;
  ref_low: number | null;
  ref_high: number | null;
  flag: "low" | "high" | "in_range" | null;
  sample_flag: string | null; // LIPEMIC / ICTERIC / HEMOLYTIC are sample-quality flags, not values
  source_file: string;
}

/**
 * Raw Clalit name -> one test name. Variants of the same test map to one name.
 * Unknown names are kept with known_name=false and reported by the ingest, never dropped.
 */
export const NAME_MAP: Record<string, string> = {
  "HEMOGLOBIN A1C %": "hba1c",
  "CHOLESTEROL": "total_cholesterol",
  "CHOLESTEROL- HDL": "hdl_cholesterol",
  "CHOLESTEROL/ HDL": "hdl_cholesterol",
  "CHOLESTEROL-HDL": "hdl_cholesterol",
  "CHOLESTEROL-LDL calc": "ldl_cholesterol",
  "NON-HDL_CHOLESTEROL": "non_hdl_cholesterol",
  "TRIGLYCERIDES": "triglycerides",
  "GLUCOSE": "glucose",
  "SODIUM": "sodium",
  "POTASSIUM": "potassium",
  "CREATININE": "creatinine",
  "CREATININE- U SAMPLE": "creatinine_urine",
  "UREA": "urea",
  "ALT (GPT)": "alt",
  "AST (GOT)": "ast",
  "ALK. PHOSPHATASE": "alkaline_phosphatase",
  "GGT": "ggt",
  "LDH": "ldh",
  "ALBUMIN": "albumin",
  "PROTEIN-TOTAL": "total_protein",
  "GLOBULIN": "globulin",
  "PSA": "psa",
  "TSH": "tsh",
  "VITAMIN D (25-OH)": "vitamin_d_25oh",
  "URIC ACID": "uric_acid",
  "MAGNESIUM": "magnesium",
  "IRON": "iron",
  "FERRITIN": "ferritin",
  "TRANSFERRIN": "transferrin",
  "TRANSFERRIN SATURATI": "transferrin_saturation",
  "MICROALBUMIN/CREAT": "microalbumin_creatinine_ratio",
  "MICROALBUMIN-U SAMP": "microalbumin_urine",
  "HCT/HGB Ratio": "hct_hgb_ratio",
  "WBC": "wbc",
  "RBC": "rbc",
  "HB": "hemoglobin",
  "HCT": "hematocrit",
  "MCV": "mcv",
  "MCH": "mch",
  "MCHC": "mchc",
  "RDW-CV": "rdw",
  "PLT": "platelets",
  "MPV": "mpv",
  "NEUT%": "neutrophils_pct",
  "NEUT.abs": "neutrophils_abs",
  "LYM%": "lymphocytes_pct",
  "LYMP.abs": "lymphocytes_abs",
  "MONO%": "monocytes_pct",
  "MONO.abs": "monocytes_abs",
  "EOS %": "eosinophils_pct",
  "EOS.abs": "eosinophils_abs",
  "BASO %": "basophils_pct",
  "BASO abs": "basophils_abs",
  "SPECIFIC GRAV-U STRI": "urine_specific_gravity",
  "PH- U STRIP": "urine_ph",
  "GLUCOSE - U STRIP": "urine_glucose",
  "PROTEIN- U STRIP": "urine_protein",
  "ALPHA FETOPROTEIN TM": "alpha_fetoprotein",
  "ANISOCYTOSIS-DIF": "anisocytosis",
  "APTT-sec": "aptt_sec",
  "ASCORBIC ACID-USTRIP": "urine_ascorbic_acid",
  "ATYPICAL LYMPH.%-DIF": "atypical_lymphocytes_pct",
  "BACTERIA-SED": "urine_sediment_bacteria",
  "BASOPHILS abs-DIF": "basophils_abs",
  "BASOPHILS%-DIF": "basophils_pct",
  "BILIRUBIN- U STRIP": "urine_bilirubin",
  "C-REACTIVE PROTEIN": "crp",
  "CA-19-9": "ca_19_9",
  "CEA": "cea",
  "CLARITY-SED": "urine_sediment_clarity",
  "EOSINOPHILS abs-DIF": "eosinophils_abs",
  "EOSINOPHILS%-DIF": "eosinophils_pct",
  "ERYTHROCYTES-SED": "urine_sediment_erythrocytes",
  "ESR": "esr",
  "GRANULAR CASTS-SED": "urine_granular_casts",
  "HYALINES CASTS-SED": "urine_hyaline_casts",
  "HYPOCHROMIA-DIF": "hypochromia",
  "KETONES- U STRIP": "urine_ketones",
  "LEUCOCYTES - U STRIP": "urine_leucocytes",
  "LEUCOCYTES-SED": "urine_sediment_leucocytes",
  "LYMPHOCYTES %-DIF": "lymphocytes_pct",
  "LYMPHOCYTES abs-DIF": "lymphocytes_abs",
  "METAMYELOCYTES%-DIF": "metamyelocytes_pct",
  "MICROCYTOSIS-DIF": "microcytosis",
  "MONOCYTES abs-DIF": "monocytes_abs",
  "MONOCYTES%-DIF": "monocytes_pct",
  "MUCUS-SED": "urine_sediment_mucus",
  "NEUTROPHILS abs-DIF": "neutrophils_abs",
  "NEUTROPHILS%-DIF": "neutrophils_pct",
  "NITRITE- U STRIP": "urine_nitrite",
  "OCCULT BLOOD SCREEN": "occult_blood_screen",
  "OCCULT BLOOD STOOL": "occult_blood_stool",
  "OVALOCYTES-DIF": "ovalocytes",
  "PDW": "pdw",
  "POLYCHROMASIA-DIF": "polychromasia",
  "PT %": "prothrombin_time_pct",
  "PT-INR": "inr",
  "PT-SEC": "prothrombin_time_sec",
  "RBC calc. - U STRIP": "urine_rbc",
  "RDW": "rdw_sd",
  "ROULEAUX FORM-DIF": "rouleaux",
  "TRANSIT. EPIT.CELLS": "urine_transitional_epithelial_cells",
  "UROBILINOGEN-U STRIP": "urine_urobilinogen",
  "WHITE BL.CELL CLUMPS": "white_cell_clumps",
  "coronavirus Covid-19": "covid19_test",
};


const SAMPLE_FLAGS = new Set(["LIPEMIC", "ICTERIC", "HEMOLYTIC"]);

const dateMatch = /מועד הבדיקה:\s*\d{1,2}:\d{2}\s+(\d{2})\.(\d{2})\.(\d{4})/;

export function parseTestDate(text: string): string {
  const match = dateMatch.exec(text);
  if (!match) throw new Error("Test date (מועד הבדיקה) not found");
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.toISOString().slice(0, 10) !== iso) throw new Error(`Impossible test date: ${iso}`);
  return iso;
}

function toNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t.replace(/^[<>]/, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseClalitExport(owner: string, sourceFile: string, text: string): { rows: LabRow[]; unknownNames: string[] } {
  const clean = text.replace(/^﻿/, "");
  const testDate = parseTestDate(clean);
  const rows: LabRow[] = [];
  const unknown = new Set<string>();
  let inResults = false;
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("שם הבדיקה")) {
      inResults = true;
      continue;
    }
    if (!inResults) continue;
    const parts = line.split(",").map((p) => p.trim());
    // Trailing comma leaves an empty last field.
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    if (parts.length < 2) continue;
    const name = parts[0] ?? "";
    if (SAMPLE_FLAGS.has(name)) {
      rows.push({
        owner, test_date: testDate, test_name_raw: name, test_name: name.toLowerCase(), known_name: true,
        unit: null, value_text: parts[2] ?? "", value_num: toNumber(parts[2] ?? ""), ref_low: null, ref_high: null,
        flag: null, sample_flag: name, source_file: sourceFile,
      });
      continue;
    }
    const mapped = NAME_MAP[name];
    if (!mapped) unknown.add(name);
    const value = parts[2] ?? "";
    const low = toNumber(parts[3] ?? "");
    const high = toNumber(parts[4] ?? "");
    const num = toNumber(value);
    let flag: LabRow["flag"] = null;
    if (num !== null && low !== null && num < low) flag = "low";
    else if (num !== null && high !== null && num > high) flag = "high";
    else if (num !== null && (low !== null || high !== null)) flag = "in_range";
    rows.push({
      owner,
      test_date: testDate,
      test_name_raw: name,
      test_name: mapped ?? name.toLowerCase(),
      known_name: mapped !== undefined,
      unit: parts[1] || null,
      value_text: value,
      value_num: num,
      ref_low: low,
      ref_high: high,
      flag,
      sample_flag: null,
      source_file: sourceFile,
    });
  }
  return { rows, unknownNames: [...unknown].sort() };
}

/**
 * Removes rows that repeat the same result: same owner, date, test name, value, and unit.
 * The same report can sit in two exports (for example a re-download), so repeats are counted, not kept twice.
 */
export function dedupeLabRows(rows: LabRow[]): { rows: LabRow[]; removed: number } {
  const seen = new Set<string>();
  const kept = rows.filter((r) => {
    const key = [r.owner, r.test_date, r.test_name_raw, r.value_text, r.unit ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { rows: kept, removed: rows.length - kept.length };
}

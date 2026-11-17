import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDataTemplate } from "../src/ingest/data-template.js";
import { TABLES } from "../src/ingest/schemas.js";

describe("infra/data.yaml", () => {
  it("is exactly what the generator produces from the table schemas (regenerate with scripts/gen-data-template.ts)", () => {
    const committed = readFileSync(resolve(import.meta.dirname, "..", "infra", "data.yaml"), "utf8");
    const body = committed.split("\n").slice(2).join("\n");
    expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify(buildDataTemplate())));
  });

  it("defines one Glue table per schema, each pointing at its own warehouse folder", () => {
    const resources = (buildDataTemplate() as { Resources: Record<string, { Type: string; Properties: { TableInput?: { Name: string; StorageDescriptor: { Location: { "Fn::Sub": string } } } } }> }).Resources;
    const glue = Object.values(resources).filter((r) => r.Type === "AWS::Glue::Table");
    expect(glue).toHaveLength(TABLES.length);
    for (const table of TABLES) {
      const match = glue.find((g) => g.Properties.TableInput?.Name === table.name);
      expect(match?.Properties.TableInput?.StorageDescriptor.Location["Fn::Sub"]).toBe(`s3://\${TablesBucket}/warehouse/${table.name}/`);
    }
  });

  it("uses only the Glue types that Parquet columns map to", () => {
    for (const table of TABLES) {
      for (const type of Object.values(table.columns)) expect(["VARCHAR", "DOUBLE", "BOOLEAN"]).toContain(type);
    }
  });
});

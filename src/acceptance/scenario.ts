import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getScenarioNames } from "../../fixtures/npc-scenarios.js";

export interface SemanticCriterion { id: string; criterion: string }
export interface AcceptanceScenario {
  id: string;
  fixture: string;
  tags: string[];
  criteria: SemanticCriterion[];
}

export function parseSuite(value: unknown): AcceptanceScenario[] {
  const suite = value as { version?: unknown; scenarios?: unknown };
  if (!suite || suite.version !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length) {
    throw new Error("Acceptance suite must have version=1 and non-empty scenarios");
  }
  const identifiers = new Set<string>();
  const fixtures = new Set(getScenarioNames());
  return suite.scenarios.map((entry: unknown) => {
    const scenario = entry as AcceptanceScenario;
    if (!scenario || typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(scenario.id)) {
      throw new Error("Invalid acceptance scenario id");
    }
    if (identifiers.has(scenario.id)) throw new Error("Duplicate scenario: " + scenario.id);
    identifiers.add(scenario.id);
    if (!fixtures.has(scenario.fixture)) throw new Error("Unknown fixture: " + scenario.fixture);
    if (!Array.isArray(scenario.tags) || !scenario.tags.length || !scenario.tags.every((tag) => typeof tag === "string" && tag.trim())) {
      throw new Error("Scenario tags must be non-empty strings: " + scenario.id);
    }
    if (!Array.isArray(scenario.criteria) || !scenario.criteria.length) throw new Error("Scenario requires semantic criteria");
    const criterionIds = new Set<string>();
    for (const check of scenario.criteria) {
      if (!check || typeof check.id !== "string" || !check.id.trim() || typeof check.criterion !== "string" || !check.criterion.trim()) {
        throw new Error("Each criterion requires id and criterion");
      }
      if (criterionIds.has(check.id)) throw new Error("Duplicate criterion: " + check.id);
      criterionIds.add(check.id);
    }
    return structuredClone(scenario);
  });
}

export async function loadSuite(path: string | URL = new URL("../../acceptance/npc-reply.json", import.meta.url)) {
  return parseSuite(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

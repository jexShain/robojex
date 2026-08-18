import { SMOKE } from "../src/smoke.js";
import { expect, test } from "vitest";
test("smoke", () => { expect(SMOKE).toBe("ceo-core"); });

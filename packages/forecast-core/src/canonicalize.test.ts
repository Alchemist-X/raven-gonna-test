import { describe, expect, it } from "vitest";
import {
  ENTITY_SIMILARITY_THRESHOLD,
  canonicalizeEntity,
  clusterAnswers,
  entityFoldKey,
  entitySimilarity,
  sameEntity
} from "./canonicalize.js";

describe("canonicalizeEntity", () => {
  it("strips wrappers, markdown emphasis, list markers and sentence punctuation", () => {
    expect(canonicalizeEntity('"Real Madrid."')).toBe("Real Madrid");
    expect(canonicalizeEntity("**Federal Reserve**")).toBe("Federal Reserve");
    expect(canonicalizeEntity("[Real Madrid]")).toBe("Real Madrid");
    expect(canonicalizeEntity("- Real Madrid,")).toBe("Real Madrid");
    expect(canonicalizeEntity("`Nvidia`")).toBe("Nvidia");
    expect(canonicalizeEntity("1. Lionel Messi!")).toBe("Lionel Messi");
    expect(canonicalizeEntity("(Bank of Japan)")).toBe("Bank of Japan");
  });

  it("collapses whitespace and folds unicode punctuation to ascii", () => {
    expect(canonicalizeEntity("  Ana   Pérez ")).toBe("Ana Pérez");
    expect(canonicalizeEntity("“S&P 500”")).toBe("S&P 500");
    expect(canonicalizeEntity("Moody’s")).toBe("Moody's");
    expect(canonicalizeEntity("Sino–US trade")).toBe("Sino-US trade");
    expect(canonicalizeEntity("Tesla​, Inc.")).toBe("Tesla, Inc.");
    expect(canonicalizeEntity("Bank of Japan")).toBe("Bank of Japan");
  });

  it("returns NFC so a decomposed accent equals a composed one", () => {
    expect(canonicalizeEntity("Ana Pérez")).toBe("Ana Pérez");
  });

  it("preserves casing and diacritics — the grader lowercases, humans read this", () => {
    expect(canonicalizeEntity("FIFA World Cup")).toBe("FIFA World Cup");
    expect(canonicalizeEntity("iPhone")).toBe("iPhone");
    expect(canonicalizeEntity("Ana Pérez")).toBe("Ana Pérez");
  });

  it("keeps a period that belongs to an abbreviation, drops a sentence period", () => {
    expect(canonicalizeEntity("U.S.")).toBe("U.S.");
    expect(canonicalizeEntity("Apple Inc.")).toBe("Apple Inc.");
    expect(canonicalizeEntity("Martin Luther King Jr.")).toBe("Martin Luther King Jr.");
    expect(canonicalizeEntity("Real Madrid.")).toBe("Real Madrid");
  });

  it("keeps a leading article by default and removes it only on request", () => {
    // Default off: "The" is part of the printed name for The Hague, The Beatles,
    // The New York Times, so deleting it unconditionally would break exact match.
    expect(canonicalizeEntity("The Hague")).toBe("The Hague");
    expect(canonicalizeEntity("The Federal Reserve")).toBe("The Federal Reserve");
    expect(canonicalizeEntity("The Federal Reserve", { stripLeadingArticle: true })).toBe("Federal Reserve");
    expect(canonicalizeEntity("An Garda Síochána", { stripLeadingArticle: true })).toBe("Garda Síochána");
  });

  it("returns an empty string when nothing survives", () => {
    expect(canonicalizeEntity("   ")).toBe("");
    expect(canonicalizeEntity("**")).toBe("");
    expect(canonicalizeEntity("")).toBe("");
  });
});

describe("entityFoldKey", () => {
  it("erases everything the comparison must ignore", () => {
    expect(entityFoldKey("  The  Real Madrid. ")).toBe("real madrid");
    expect(entityFoldKey("Ana Pérez")).toBe(entityFoldKey("ana perez"));
    expect(entityFoldKey("U.S.")).toBe("u s");
  });
});

describe("sameEntity", () => {
  it("merges the same entity written differently", () => {
    expect(sameEntity("Real Madrid.", "Real Madrid")).toBe(true);
    expect(sameEntity("federal reserve", "Federal Reserve")).toBe(true);
    expect(sameEntity("  Ana   Pérez ", "Ana Perez")).toBe(true);
    expect(sameEntity("The Fed", "Fed")).toBe(true);
    expect(sameEntity("Space X", "SpaceX")).toBe(true);
    expect(sameEntity("Apple", "Apple Inc.")).toBe(true);
    expect(sameEntity("Real Madrid", "Real Madrid CF")).toBe(true);
    expect(sameEntity("United States", "United States of America")).toBe(true);
    expect(sameEntity("Barack Obama", "Barak Obama")).toBe(true);
  });

  it("refuses near neighbours, because a false merge outranks the wrong answer", () => {
    expect(sameEntity("Manchester United", "Manchester City")).toBe(false);
    expect(sameEntity("Colombia", "Columbia")).toBe(false);
    expect(sameEntity("Austria", "Australia")).toBe(false);
    expect(sameEntity("Iran", "Iraq")).toBe(false);
    expect(sameEntity("Bank of America", "Bank of England")).toBe(false);
    // One shared token is not identity: "Manchester" alone is City or United.
    expect(sameEntity("Manchester", "Manchester United")).toBe(false);
  });

  it("does not merge The Fed with Federal Reserve", () => {
    // These ARE the same institution, and they still must not merge here: no
    // string metric links "fed" to "federal reserve" without a curated alias
    // table, and the only way to make the metric reach that far is to loosen it
    // until Colombia/Columbia merge too. Aliases are knowledge, not similarity —
    // they belong in a lookup the engine owns, not in this function.
    expect(sameEntity("The Fed", "Federal Reserve")).toBe(false);
  });

  it("treats a blank as matching nothing, including another blank", () => {
    expect(sameEntity("  ", "Fed")).toBe(false);
    expect(sameEntity("", "")).toBe(false);
  });
});

describe("entitySimilarity", () => {
  it("puts the threshold above the tightest confusable pair we know", () => {
    // Colombia/Columbia is one edit in eight characters = 0.875, and they are
    // different entities. 0.88 sits just above it; single-character slips in
    // longer names (Barak/Barack Obama = 0.917) still clear it.
    expect(entitySimilarity("Colombia", "Columbia")).toBeCloseTo(0.875, 10);
    expect(entitySimilarity("Colombia", "Columbia")).toBeLessThan(ENTITY_SIMILARITY_THRESHOLD);
    expect(entitySimilarity("Barack Obama", "Barak Obama")).toBeGreaterThanOrEqual(ENTITY_SIMILARITY_THRESHOLD);
    expect(entitySimilarity("Manchester United", "Manchester City")).toBeLessThan(0.8);
    expect(entitySimilarity("Real Madrid", "real  madrid.")).toBe(1);
  });
});

describe("clusterAnswers", () => {
  it("counts written variants as one vote and sorts by size descending", () => {
    const clusters = clusterAnswers([
      "Real Madrid",
      "real madrid",
      "**Real Madrid.**",
      "Manchester City",
      "  Manchester   City  "
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.representative).toBe("Real Madrid");
    expect(clusters[0]?.size).toBe(3);
    expect(clusters[1]?.representative).toBe("Manchester City");
    expect(clusters[1]?.size).toBe(2);
  });

  it("keeps a stable representative instead of whichever trial finished last", () => {
    // aggregation.ts:116-127 overwrites the display string on every match, so a
    // single shouty trial arriving last decided the emitted casing.
    const clusters = clusterAnswers(["Federal Reserve", "Federal Reserve", "FEDERAL RESERVE"]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.representative).toBe("Federal Reserve");
    expect(clusters[0]?.size).toBe(3);
    expect(clusters[0]?.members).toEqual(["Federal Reserve", "Federal Reserve", "FEDERAL RESERVE"]);
  });

  it("breaks ties by support then by first appearance, never alphabetically", () => {
    // The old vote tie-broke on localeCompare, which hands every tie to whichever
    // answer starts closest to "A" — a bias with no forecasting meaning.
    const clusters = clusterAnswers(["Zulu Corp", "Alpha Corp"]);
    expect(clusters.map((cluster) => cluster.representative)).toEqual(["Zulu Corp", "Alpha Corp"]);
  });

  it("prefers a properly cased surface when support ties", () => {
    // The grader lowercases, so this costs nothing there; the report is read by
    // a person, and "the fed" is not how a source prints it.
    expect(clusterAnswers(["the fed", "The Fed"])[0]?.representative).toBe("The Fed");
    expect(clusterAnswers(["nato", "NATO"])[0]?.representative).toBe("NATO");
  });

  it("prefers the accented surface when support ties, since accents are lost not invented", () => {
    const clusters = clusterAnswers(["Ana Perez", "Ana Pérez"]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.representative).toBe("Ana Pérez");
    expect(clusters[0]?.size).toBe(2);
  });

  it("never merges rival entities that share a token", () => {
    const clusters = clusterAnswers(["Manchester United", "Manchester United", "Manchester City"]);
    expect(clusters.map((cluster) => cluster.size)).toEqual([2, 1]);
    expect(clusters[0]?.representative).toBe("Manchester United");
    expect(clusters[1]?.representative).toBe("Manchester City");
  });

  it("keeps The Fed and Federal Reserve apart so the majority form still wins", () => {
    const clusters = clusterAnswers(["Federal Reserve", "the federal reserve", "The Fed"]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.representative).toBe("Federal Reserve");
    expect(clusters[0]?.size).toBe(2);
    expect(clusters[1]?.representative).toBe("The Fed");
  });

  it("drops answers that canonicalize to nothing", () => {
    const clusters = clusterAnswers(["", "   ", "**", "Real Madrid."]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual(["Real Madrid"]);
    expect(clusterAnswers([])).toEqual([]);
  });

  it("reports members in input order with size equal to member count", () => {
    const clusters = clusterAnswers(["SpaceX", "Blue Origin", "Space X", "spacex"]);
    expect(clusters[0]?.members).toEqual(["SpaceX", "Space X", "spacex"]);
    expect(clusters[0]?.size).toBe(clusters[0]?.members.length);
    expect(clusters[1]?.members).toEqual(["Blue Origin"]);
  });

  it("is deterministic: the same input yields the identical result", () => {
    const answers = ["Ana Perez", "ANA PEREZ", "Ana Pérez", "Bruno Pereira"];
    expect(clusterAnswers(answers)).toEqual(clusterAnswers(answers));
  });

  it("does not chain A~B~C into one cluster when A and C are unrelated", () => {
    // Single-linkage would drag "Manchester City" in via "Manchester United CF"
    // style bridges; membership is decided against the cluster seed only.
    const clusters = clusterAnswers(["Manchester United", "Manchester", "Manchester City"]);
    expect(clusters).toHaveLength(3);
  });
});

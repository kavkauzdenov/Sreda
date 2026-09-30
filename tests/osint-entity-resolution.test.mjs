/** OSINT: entity resolution — score = matched/applicable, явные правила. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIdentityKey,
  decideCandidate,
  scoreCandidate,
} from "../src/server/intelligence/osint/entity-resolution.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { DEFAULT_MATCH_THRESHOLDS } from "../src/server/intelligence/osint/config.ts";

const profile = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description:
    "Кафе Ромашка — уютное кафе в Барнауле.\nГород: Барнаул\nул. Ленина, 10\nТелефон: 8 (3852) 55-10-10\nСайт: https://romashka.ru\nЕда и напитки: завтраки и десерты.",
  contact_info: "8 (3852) 55-10-10",
  industry: "food",
});

function decide(evidence) {
  const scored = scoreCandidate(evidence, profile);
  return { scored, decision: decideCandidate(scored, profile) };
}

test("official site with all signals is auto-accepted by domain_exact", () => {
  const { scored, decision } = decide({
    url: "https://romashka.ru/",
    title: "Кафе Ромашка — официальный сайт",
    snippet:
      "Кафе Ромашка в Барнауле, ул. Ленина, 10. Телефон 8 (3852) 55-10-10",
  });
  assert.ok(scored.score > 0.8, `score=${scored.score}`);
  assert.equal(decision.status, "accepted");
  assert.equal(decision.rule, "domain_exact");
  assert.ok(scored.reasons.includes("domain_exact"));
  assert.ok(scored.reasons.includes("phone_exact"));
});

test("phone plus strong name identity is auto-accepted", () => {
  const { scored, decision } = decide({
    url: "https://listing-maps.example.org/card/9",
    title: "Кафе Ромашка",
    snippet: "ул. Ленина, 10 — 8 (3852) 55-10-10",
  });
  assert.ok(scored.phoneMatched);
  assert.ok(scored.nameRatio >= 0.7, `nameRatio=${scored.nameRatio}`);
  assert.equal(decision.status, "accepted");
  assert.equal(decision.rule, "phone_plus_identity");
});

test("weak match goes to manual review, never auto-accepted", () => {
  const { scored, decision } = decide({
    url: "https://barnaul-life.example.net/cafes",
    title: "Кафе Ромашка Барнаул",
    snippet: "список заведений города",
  });
  assert.ok(
    scored.score >= DEFAULT_MATCH_THRESHOLDS.candidateMinScore,
    `score=${scored.score}`,
  );
  assert.ok(!scored.phoneMatched && !scored.domainMatched);
  assert.equal(decision.status, "candidate");
  assert.equal(decision.rule, null);
});

test("unrelated result is rejected below floor", () => {
  const { scored, decision } = decide({
    url: "https://blog.example.ru/digital",
    title: "Продвижение сайтов",
    snippet: "агентство digital-маркетинга",
  });
  assert.ok(scored.score < DEFAULT_MATCH_THRESHOLDS.candidateMinScore);
  assert.equal(decision.status, "rejected");
  assert.equal(decision.rule, null);
});

test("score stays within 0..1 and equals matched/applicable", () => {
  const cases = [
    { url: "https://romashka.ru/", title: "Кафе Ромашка", snippet: "Барнаул" },
    { url: "https://a.ru/", title: "x", snippet: "y" },
    { url: "", title: "", snippet: "" },
  ];
  for (const evidence of cases) {
    const scored = scoreCandidate(evidence, profile);
    assert.ok(scored.score >= 0 && scored.score <= 1, String(scored.score));
    const expected =
      scored.applicableWeight > 0
        ? Math.round((scored.matchedWeight / scored.applicableWeight) * 1000) / 1000
        : 0;
    assert.equal(scored.score, expected);
  }
});

test("empty candidate has no applicable signals and is rejected", () => {
  const { scored, decision } = decide({ url: "", title: "", snippet: "" });
  assert.equal(scored.applicableWeight, 0);
  assert.equal(scored.score, 0);
  assert.equal(decision.status, "rejected");
});

test("non-applicable features are excluded from denominator", () => {
  const minimal = buildDiscoveryProfile({ name: "Кафе Ромашка" });
  const scored = scoreCandidate(
    { url: "https://x.ru/", title: "Кафе Ромашка", snippet: "" },
    minimal,
  );
  // Только название применимо (нет телефона/города/категории/домена).
  assert.equal(scored.applicableWeight, 0.1);
  assert.ok(scored.score >= 0 && scored.score <= 1);
  for (const signal of scored.signals) {
    if (!signal.applicable) assert.equal(signal.contribution, 0);
  }
});

test("identity key prefers domain over phone", () => {
  assert.equal(buildIdentityKey(profile), "domain:romashka.ru");
  const phoneOnly = buildDiscoveryProfile({
    name: "ИП Иванов",
    contact_info: "8 (3852) 55-10-10",
  });
  assert.equal(buildIdentityKey(phoneOnly), "phone:73852551010");
});

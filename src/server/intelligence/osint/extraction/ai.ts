import {
  emptyExtraction,
  parseExtraction,
  type ExtractionResult,
} from "./contract.ts";

/**
 * AI extraction adapter (§11, §26).
 *
 * Живые вызовы AI на этом этапе отключены: `enabled` по умолчанию false,
 * а транспорт инжектируется снаружи. Контракт уже готов — включается
 * флагом, без правок схемы.
 *
 * Модель возвращает ТОЛЬКО JSON; любой другой вывод отбрасывается.
 * Ответ проходит zod — кривой JSON не роняет пайплайн.
 */

export type AiExtractionTransport = (prompt: string) => Promise<string>;

export type AiExtractionOptions = {
  /** Мастер-флаг. §26: на этом этапе реальный AI review analysis не включаем. */
  enabled?: boolean;
  /** Транспорт инжектируется снаружи — в модуле нет сетевых вызовов. */
  transport?: AiExtractionTransport;
};

export type AiExtractionResult = {
  extraction: ExtractionResult;
  used: boolean;
  issues: string[];
};

export function buildExtractionPrompt(input: {
  text: string;
  knownEntityName?: string;
}): string {
  const nameLine = input.knownEntityName
    ? `Известная сущность: ${input.knownEntityName}.\n`
    : "";
  return [
    "Ты извлекаешь структурированные OSINT-факты из текста веб-страницы.",
    "Ответь ТОЛЬКО валидным JSON без пояснений и без markdown.",
    nameLine,
    'Схема: {"entities":[{"name":string,"kind":"business"|"location"|"organization",',
    '"mentionType":"OWNER"|"PUBLISHED_BY"|"MENTIONS"|"ABOUT"|"PARTNER"|"CLIENT"|"COMPETITOR"|"LOCATION"|"EMPLOYER"|"SPONSOR"|"SUPPLIER"|"CUSTOMER"|"RELATED_TO",',
    '"evidenceKind":"text_span"|"sameAs"|"rel_author"|"explicit_claim",',
    '"evidenceText":string,"confidence":0..1}],',
    '"attributes":[{"attribute":"name"|"phone"|"website"|"address"|"email"|"city"|"region"|"country"|"category"|"description"|"social_links"|"coordinates"|"working_hours",',
    '"value":string|string[]|number|object,"evidenceText":string,"confidence":0..1}]}',
    "Правила:",
    "- evidenceText обязан быть точным фрагментом исходного текста, до 500 символов.",
    '- mentionType "OWNER" или "PUBLISHED_BY" ставь ТОЛЬКО при evidenceKind "sameAs", "rel_author" или "explicit_claim".',
    "- Не выдумывай факты, которых нет в тексте.",
    "",
    "Текст:",
    input.text.slice(0, 8000),
  ].join("\n");
}

export async function extractWithAi(
  input: { text: string; knownEntityName?: string },
  options: AiExtractionOptions = {},
): Promise<AiExtractionResult> {
  if (!options.enabled || !options.transport) {
    return { extraction: emptyExtraction(), used: false, issues: [] };
  }

  let raw: string;
  try {
    raw = await options.transport(buildExtractionPrompt(input));
  } catch (error) {
    return {
      extraction: emptyExtraction(),
      used: true,
      issues: [`transport_error: ${(error as Error).message}`],
    };
  }

  const json = extractJson(raw);
  if (json === null) {
    return {
      extraction: emptyExtraction(),
      used: true,
      issues: ["response_is_not_json"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { extraction: emptyExtraction(), used: true, issues: ["json_parse_error"] };
  }

  const result = parseExtraction(parsed);
  if (!result.ok) {
    return { extraction: emptyExtraction(), used: true, issues: result.issues };
  }
  return { extraction: result.data, used: true, issues: [] };
}

/** Достаёт первый сбалансированный JSON-объект из ответа модели. */
function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

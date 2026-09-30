/** Детерминированные текстовые утилиты для entity resolution и классификации. */

/** Нормализация: нижний регистр, ё→е, пунктуация → пробелы, сжатие пробелов. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 0);
}

/** Последовательность цифр — для телефонов и «почти телефонных» чисел. */
export function digitSequence(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Нормализованный телефон: 10–15 цифр, без ведущего 8 при 11 цифрах РФ. */
export function normalizePhone(value: string): string | null {
  const digits = digitSequence(value);
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 11 && digits.startsWith("8"))
    return "7" + digits.slice(1);
  if (digits.length === 11 && digits.startsWith("7")) return digits;
  if (digits.length < 11) return digits;
  return digits;
}

/**
 * «Телефонные» последовательности из произвольного текста (сравнение по
 * равенству — ложные срабатывания не страшны, важен recall).
 */
export function extractPhoneRuns(text: string): string[] {
  const runs = String(text ?? "").match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  const found: string[] = [];
  for (const run of runs) {
    const phone = normalizePhone(run);
    if (phone && !found.includes(phone)) found.push(phone);
  }
  return found;
}

/** Sørensen–Dice по символ-биграммам, 0..1. Работает без внешних библиотек. */
export function diceBigrams(a: string, b: string): number {
  const left = normalizeText(a).replace(/\s+/g, "");
  const right = normalizeText(b).replace(/\s+/g, "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const gramsOf = (value: string) => {
    const grams = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };
  const gramsA = gramsOf(left);
  const gramsB = gramsOf(right);
  let shared = 0;
  for (const [gram, count] of gramsA) {
    const other = gramsB.get(gram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (left.length - 1 + right.length - 1);
}

/**
 * Сходство названий: максимум из биграмм и «покрытия токенов».
 * «Стоматология Ромашка» ~ «Ромашка» даёт осмысленное, а не нулевое значение.
 */
export function nameSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  const setA = new Set(tokensA);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const containment = shared / Math.max(setA.size, setB.size);
  return Math.min(1, Math.max(diceBigrams(a, b), containment));
}

/** Стем-совпадение: «красота» находит «красоты», «салон». */
export function hasStem(text: string, token: string): boolean {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) return false;
  const stem = normalizedToken.slice(0, Math.max(4, normalizedToken.length - 2));
  return normalizeText(text).includes(stem);
}

/** Есть ли хоть один токен категории в тексте. */
export function hasCategory(text: string, category: string): boolean {
  return tokenize(category).some((token) => token.length >= 3 && hasStem(text, token));
}

/** Фраза «улица ленина» ищется как подстрока нормализованного текста. */
export function hasPhrase(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return normalizeText(text).includes(normalizedPhrase);
}

/** Целое слово в тексте (для города, чтобы «Ромашка» не матчилась в «Ромашково»). */
export function hasWord(text: string, word: string): boolean {
  const normalizedWord = normalizeText(word);
  if (!normalizedWord) return false;
  return new RegExp(`(^|[^0-9a-zа-я])${escapeRegExp(normalizedWord)}([^0-9a-zа-я]|$)`).test(
    normalizeText(text),
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

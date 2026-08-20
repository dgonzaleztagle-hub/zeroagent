const BEHAVIOR_WORDS = new Set([
  'debe', 'deber', 'aclarar', 'indicar', 'mencionar', 'explicar', 'responder',
  'informar', 'decir', 'respuesta', 'mensaje', 'forma', 'manera', 'cliente'
]);

const SPANISH_STOP_WORDS = new Set([
  'ante', 'bajo', 'cabe', 'con', 'contra', 'desde', 'durante', 'entre', 'hacia',
  'hasta', 'para', 'por', 'segun', 'sin', 'sobre', 'tras', 'del', 'las', 'los',
  'una', 'uno', 'unos', 'unas', 'como', 'esto', 'esta', 'este', 'esas', 'esos',
  'que', 'cuando', 'donde', 'cual', 'quien', 'pero', 'porque', 'tambien', 'solo'
]);

function normalize(value) {
  return String(value || '').toLocaleLowerCase('es')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function spanishStem(rawWord) {
  let word = normalize(rawWord).replace(/[^a-z0-9ñ]/g, '');
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  const suffixes = [
    'amientos', 'imientos', 'aciones', 'uciones', 'amente', 'idades', 'ancias', 'encias',
    'amiento', 'imiento', 'acion', 'ucion', 'adoras', 'adores', 'adora', 'ador',
    'iendo', 'ando', 'ados', 'adas', 'idos', 'idas', 'ando', 'iendo',
    'ar', 'er', 'ir', 'es', 'os', 'as', 'o', 'a', 'e'
  ];
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      word = word.slice(0, -suffix.length);
      break;
    }
  }
  return word;
}

function significantStems(value) {
  const words = normalize(value).match(/[a-z0-9ñ]+/g) || [];
  return [...new Set(words
    .filter(word => word.length > 3 && !SPANISH_STOP_WORDS.has(word) && !BEHAVIOR_WORDS.has(word))
    .map(spanishStem)
    .filter(stem => stem.length >= 3))];
}

export function matchExpectedBehavior(expectedBehavior, actualText) {
  const expected = normalize(expectedBehavior);
  const actual = normalize(actualText);
  const expectedTerms = significantStems(expected);
  const actualTerms = new Set(significantStems(actual));
  const matchedTerms = expectedTerms.filter(term => actualTerms.has(term));
  const expectedNumbers = [...new Set(expected.match(/\b\d+\b/g) || [])];
  const actualNumbers = new Set(actual.match(/\b\d+\b/g) || []);
  const numbersOk = expectedNumbers.every(number => actualNumbers.has(number));
  const expectsNegation = /\b(?:no|nunca|ni|sin)\b/.test(expected);
  const hasNegation = /\b(?:no|nunca|ni|sin)\b/.test(actual);
  const polarityOk = !expectsNegation || hasNegation;
  const minimumMatches = Math.max(2, Math.ceil(expectedTerms.length * 0.5));
  const passed = expectedTerms.length > 0
    && matchedTerms.length >= minimumMatches
    && numbersOk
    && polarityOk;
  return { passed, expectedTerms, matchedTerms, expectedNumbers, numbersOk, polarityOk, minimumMatches };
}

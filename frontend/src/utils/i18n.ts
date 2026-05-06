export type Locale = 'ru' | 'en';

const labels: Record<string, Record<Locale, string>> = {
  ALL: { ru: 'Все', en: 'All' },
  N_A: { ru: 'Нет данных', en: 'N/A' },
  YES: { ru: 'Да', en: 'Yes' },
  NO: { ru: 'Нет', en: 'No' },
  LONG: { ru: 'Long', en: 'Long' },
  SHORT: { ru: 'Short', en: 'Short' },
  WAIT: { ru: 'Wait', en: 'Wait' },
  NONE: { ru: 'Нет стороны', en: 'No side' },
  NEUTRAL: { ru: 'Нейтрально', en: 'Neutral' },
  BULLISH: { ru: 'Бычий', en: 'Bullish' },
  BEARISH: { ru: 'Медвежий', en: 'Bearish' },
  UPTREND: { ru: 'Восходящий тренд', en: 'Uptrend' },
  DOWNTREND: { ru: 'Нисходящий тренд', en: 'Downtrend' },
  RANGE: { ru: 'Диапазон', en: 'Range' },
  UNCLEAR: { ru: 'Неясно', en: 'Unclear' },
  BULLISH_STRUCTURE: { ru: 'Бычья структура', en: 'Bullish structure' },
  BEARISH_STRUCTURE: { ru: 'Медвежья структура', en: 'Bearish structure' },
  GOOD: { ru: 'Хорошее', en: 'Good' },
  ACCEPTABLE: { ru: 'Приемлемое', en: 'Acceptable' },
  POOR: { ru: 'Слабое', en: 'Poor' },
  CHASE: { ru: 'Поздний вход', en: 'Chase' },
  WATCHING: { ru: 'Наблюдение', en: 'Watching' },
  IN_ZONE: { ru: 'В зоне', en: 'In zone' },
  MISSED: { ru: 'Пропущен', en: 'Missed' },
  INVALID_BY_RR: { ru: 'Невалидно по R/R', en: 'Invalid by R/R' },
  INVALIDATED: { ru: 'Отменён', en: 'Invalidated' },
  EXPIRED: { ru: 'Истёк', en: 'Expired' },
  DISABLED: { ru: 'Выключен', en: 'Disabled' },
  WATCH: { ru: 'Наблюдение', en: 'Watch' },
  CONFIRMATION_PENDING: { ru: 'Ожидает подтверждения', en: 'Confirmation pending' },
  CONFIRMED: { ru: 'Подтверждён', en: 'Confirmed' },
  VALID: { ru: 'Валидно', en: 'Valid' },
  PENDING_RECALCULATION: { ru: 'Нужен пересчёт', en: 'Pending recalculation' },
  INFORMATIONAL_ONLY: { ru: 'Только справочно', en: 'Informational only' },
  CURRENT_PRICE_ATR: { ru: 'От текущей цены и ATR', en: 'Current price + ATR' },
  VOLATILITY_ADJUSTED: { ru: 'С учётом волатильности', en: 'Volatility adjusted' },
  STRUCTURAL_SUPPORT: { ru: 'Структурная поддержка', en: 'Structural support' },
  STRUCTURAL_RESISTANCE: { ru: 'Структурное сопротивление', en: 'Structural resistance' },
  BREAKOUT_RETEST_LEVEL: { ru: 'Уровень breakout/retest', en: 'Breakout/retest level' },
  RECLAIM_LEVEL: { ru: 'Уровень reclaim', en: 'Reclaim level' },
  SWING_LOW: { ru: 'Swing low', en: 'Swing low' },
  SWING_HIGH: { ru: 'Swing high', en: 'Swing high' },
  RANGE_LOW: { ru: 'Нижняя граница диапазона', en: 'Range low' },
  RANGE_HIGH: { ru: 'Верхняя граница диапазона', en: 'Range high' },
  LOCAL_REACTION: { ru: 'Локальная реакция', en: 'Local reaction' },
  NOT_IN_ZONE: { ru: 'Цена не в зоне', en: 'Not in zone' },
  RR_BELOW_MINIMUM: { ru: 'R/R ниже минимума', en: 'R/R below minimum' },
  SCENARIO_TURNED_NEUTRAL: { ru: 'Сценарий стал нейтральным', en: 'Scenario turned neutral' },
  NEW_STRUCTURE_CREATED: { ru: 'Появилась новая структура', en: 'New structure created' },
  NEW_BREAKOUT_SETUP: { ru: 'Новый breakout setup', en: 'New breakout setup' },
  TIME_EXPIRED: { ru: 'Время истекло', en: 'Time expired' },
  MARKET_FILTER_CONFLICT: { ru: 'Конфликт market filters', en: 'Market filter conflict' },
  INVALIDATION_HIT: { ru: 'Инвалидация пробита', en: 'Invalidation hit' },
  UP: { ru: 'Растёт', en: 'Up' },
  DOWN: { ru: 'Падает', en: 'Down' },
  FLAT: { ru: 'Плоско', en: 'Flat' },
  RISK_ON: { ru: 'Risk-on', en: 'Risk-on' },
  RISK_OFF: { ru: 'Risk-off', en: 'Risk-off' },
  SUPPORT: { ru: 'Поддержка', en: 'Support' },
  RESISTANCE: { ru: 'Сопротивление', en: 'Resistance' },
  MID_RANGE: { ru: 'Середина диапазона', en: 'Mid-range' },
  NO_BREAK: { ru: 'Без пробоя', en: 'No break' },
  BREAKING_UP: { ru: 'Пробой вверх', en: 'Breaking up' },
  BREAKING_DOWN: { ru: 'Пробой вниз', en: 'Breaking down' }
};

export function enumLabel(value: unknown, locale: Locale): string {
  if (value === undefined || value === null || value === '') return labels.N_A[locale];
  const key = String(value);
  return labels[key]?.[locale] || humanizeEnum(key);
}

export function pairLabel(left: unknown, right: unknown, locale: Locale): string {
  const first = enumLabel(left, locale);
  const second = right === undefined || right === null || right === 'NONE' ? '' : ` ${enumLabel(right, locale)}`;
  return `${first}${second}`;
}

function humanizeEnum(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, char => char.toUpperCase());
}

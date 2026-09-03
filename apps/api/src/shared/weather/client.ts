import type {
  CurrentWeather,
  DailyPeriod,
  DailyWeather,
  HourlyWeather,
  WeatherCondition,
  WeatherPrecipitation,
  WeatherRequest,
  WeatherWind,
} from './types.js';

export type WeatherFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type WeatherErrorKind =
  'disabled' | 'configuration' | 'request' | 'authorization' | 'rate_limit' | 'dependency' | 'timeout' | 'contract';
export class WeatherError extends Error {
  constructor(
    readonly kind: WeatherErrorKind,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Google Weather API ${kind} failure`);
  }
}
export interface WeatherClientConfig {
  enabled: boolean;
  apiKey?: string;
  timeoutMs?: number;
}

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as RecordValue) : {};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const quantity = (v: unknown) =>
  num(record(v)['degrees']) ??
  num(record(v)['value']) ??
  num(record(v)['quantity']) ??
  num(record(v)['distance']) ??
  num(record(v)['meanSeaLevelMillibars']);
const percent = (v: unknown) => num(record(v)['percent']);
const compact = <T extends RecordValue>(v: T): T =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;

export class GoogleWeatherClient {
  constructor(
    private readonly config: WeatherClientConfig,
    private readonly fetchImpl: WeatherFetch = fetch,
  ) {}

  private async lookup(path: string, request: WeatherRequest, query: Record<string, string>): Promise<RecordValue> {
    if (!this.config.enabled) throw new WeatherError('disabled', 503);
    if (!this.config.apiKey) throw new WeatherError('configuration', 503);
    const url = new URL(`https://weather.googleapis.com/v1/${path}:lookup`);
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('location.latitude', String(request.latitude));
    url.searchParams.set('location.longitude', String(request.longitude));
    url.searchParams.set('unitsSystem', 'METRIC');
    if (request.languageCode) url.searchParams.set('languageCode', request.languageCode);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      const name = record(error)['name'];
      throw new WeatherError(
        name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'dependency',
        name === 'AbortError' || name === 'TimeoutError' ? 504 : 502,
      );
    }
    if (!response.ok) {
      if (response.status === 400) throw new WeatherError('request', 502);
      if (response.status === 401 || response.status === 403) throw new WeatherError('authorization', 502);
      if (response.status === 429)
        throw new WeatherError('rate_limit', 429, parseRetryAfter(response.headers.get('retry-after')));
      throw new WeatherError('dependency', response.status >= 500 ? 502 : 502);
    }
    try {
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid');
      return value as RecordValue;
    } catch {
      throw new WeatherError('contract', 502);
    }
  }

  async current(request: WeatherRequest): Promise<{ value: CurrentWeather; timeZone?: string }> {
    const raw = await this.lookup('currentConditions', request, {});
    return { value: normalizeCurrent(raw), timeZone: str(record(raw['timeZone'])['id']) };
  }
  async hourly(request: WeatherRequest): Promise<{ values: HourlyWeather[]; timeZone?: string }> {
    const values: HourlyWeather[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    let timeZone: string | undefined;
    for (let page = 0; page < 4 && values.length < request.hours; page++) {
      const raw = await this.lookup(
        'forecast/hours',
        request,
        compact({
          hours: String(request.hours),
          pageSize: String(Math.min(24, request.hours - values.length)),
          pageToken: token,
        }) as Record<string, string>,
      );
      timeZone ??= str(record(raw['timeZone'])['id']);
      for (const item of Array.isArray(raw['forecastHours']) ? raw['forecastHours'] : [])
        values.push(normalizeHourly(record(item)));
      const next = str(raw['nextPageToken']);
      if (!next || seen.has(next)) break;
      seen.add(next);
      token = next;
    }
    return { values: values.slice(0, request.hours), timeZone };
  }
  async daily(request: WeatherRequest): Promise<{ values: DailyWeather[]; timeZone?: string }> {
    const items: unknown[] = [];
    let token: string | undefined;
    let timeZone: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 2 && items.length < request.days; page++) {
      const raw = await this.lookup(
        'forecast/days',
        request,
        compact({
          days: String(request.days),
          pageSize: String(request.days - items.length),
          pageToken: token,
        }) as Record<string, string>,
      );
      timeZone ??= str(record(raw['timeZone'])['id']);
      if (Array.isArray(raw['forecastDays'])) items.push(...raw['forecastDays']);
      const next = str(raw['nextPageToken']);
      if (!next || seen.has(next)) break;
      seen.add(next);
      token = next;
    }
    return {
      values: items.slice(0, request.days).map((v) => normalizeDaily(record(v))),
      timeZone,
    };
  }
}

function condition(v: unknown): WeatherCondition {
  const r = record(v);
  return compact({ type: str(r['type']), description: str(record(r['description'])['text']) });
}
function precipitation(v: unknown): WeatherPrecipitation | undefined {
  const r = record(v);
  const out = compact({
    probabilityPercent: percent(r['probability']),
    amountMm: quantity(r['qpf']),
    type: str(record(r['probability'])['type']),
  });
  return Object.keys(out).length ? out : undefined;
}
function wind(v: unknown): WeatherWind | undefined {
  const r = record(v);
  const d = record(r['direction']);
  const out = compact({
    speedKmh: quantity(r['speed']),
    gustKmh: quantity(r['gust']),
    directionDegrees: num(d['degrees']),
    directionCardinal: str(d['cardinal']),
  });
  return Object.keys(out).length ? out : undefined;
}
function common(raw: RecordValue) {
  return compact({
    condition: condition(raw['weatherCondition']),
    temperatureC: quantity(raw['temperature']),
    feelsLikeC: quantity(raw['feelsLikeTemperature']),
    precipitation: precipitation(raw['precipitation']),
    wind: wind(raw['wind']),
    relativeHumidityPercent: num(raw['relativeHumidity']),
    cloudCoverPercent: num(raw['cloudCover']),
    thunderstormProbabilityPercent: percent(raw['thunderstormProbability']),
    uvIndex: num(raw['uvIndex']),
    isDaytime: bool(raw['isDaytime']),
  });
}
function normalizeCurrent(raw: RecordValue): CurrentWeather {
  return compact({
    time: str(raw['currentTime']) ?? new Date().toISOString(),
    ...common(raw),
    visibilityKm: quantity(raw['visibility']),
    pressureHpa: quantity(raw['currentPressure']),
  });
}
function displayDateTime(v: unknown): string | undefined {
  const r = record(v);
  const parts = ['year', 'month', 'day', 'hours', 'minutes', 'seconds'].map((k) => num(r[k]));
  if (parts.slice(0, 5).some((x) => x === undefined)) return undefined;
  const [y, m, d, h, min, s = 0] = parts as number[];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function normalizeHourly(raw: RecordValue): HourlyWeather {
  return compact({
    startTime: str(record(raw['interval'])['startTime']) ?? '',
    localDateTime: displayDateTime(raw['displayDateTime']),
    ...common(raw),
  });
}
function dailyPeriod(v: unknown): DailyPeriod | undefined {
  const r = record(v);
  const out = compact({
    condition: condition(r['weatherCondition']),
    precipitationProbabilityPercent: percent(record(r['precipitation'])['probability']),
    precipitationAmountMm: quantity(record(r['precipitation'])['qpf']),
    windSpeedKmh: quantity(record(r['wind'])['speed']),
    windGustKmh: quantity(record(r['wind'])['gust']),
    relativeHumidityPercent: num(r['relativeHumidity']),
    cloudCoverPercent: num(r['cloudCover']),
    thunderstormProbabilityPercent: percent(r['thunderstormProbability']),
  });
  return Object.keys(out).length ? out : undefined;
}
function date(v: unknown): string {
  const r = record(v);
  return `${String(num(r['year']) ?? 0).padStart(4, '0')}-${String(num(r['month']) ?? 0).padStart(2, '0')}-${String(num(r['day']) ?? 0).padStart(2, '0')}`;
}
function normalizeDaily(raw: RecordValue): DailyWeather {
  const sun = record(raw['sunEvents']);
  return compact({
    date: date(raw['displayDate']),
    minTemperatureC: quantity(raw['minTemperature']),
    maxTemperatureC: quantity(raw['maxTemperature']),
    feelsLikeMinC: quantity(raw['feelsLikeMinTemperature']),
    feelsLikeMaxC: quantity(raw['feelsLikeMaxTemperature']),
    daytime: dailyPeriod(raw['daytimeForecast']),
    nighttime: dailyPeriod(raw['nighttimeForecast']),
    sunriseTime: str(sun['sunriseTime']),
    sunsetTime: str(sun['sunsetTime']),
  });
}
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 3_600_000);
}

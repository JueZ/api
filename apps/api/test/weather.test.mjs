import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleWeatherClient, WeatherError } from '../dist/shared/weather/client.js';
import { WeatherService } from '../dist/shared/weather/service.js';

const request = { mode: 'overview', latitude: 48.2, longitude: 16.37, hours: 25, days: 2, languageCode: 'de-AT' };
const response = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('Google weather modes use only required endpoints and normalize output', async () => {
  const urls = [];
  const fetch = async (input) => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname.includes('currentConditions'))
      return response({
        currentTime: '2026-09-03T12:00:00Z',
        timeZone: { id: 'Europe/Vienna' },
        weatherCondition: { type: 'CLEAR', description: { text: 'Clear' } },
        temperature: { degrees: 21 },
        wind: { speed: { value: 12 } },
      });
    if (url.pathname.includes('/hours'))
      return response({
        forecastHours: [
          {
            interval: { startTime: '2026-09-03T13:00:00Z' },
            displayDateTime: { year: 2026, month: 9, day: 3, hours: 15, minutes: 0 },
            temperature: { degrees: 22 },
          },
        ],
      });
    return response({
      forecastDays: [
        {
          displayDate: { year: 2026, month: 9, day: 3 },
          minTemperature: { degrees: 12 },
          maxTemperature: { degrees: 24 },
          sunEvents: { sunriseTime: '2026-09-03T04:00:00Z' },
        },
      ],
    });
  };
  for (const mode of ['current', 'hourly', 'daily']) {
    urls.length = 0;
    const service = new WeatherService(new GoogleWeatherClient({ enabled: true, apiKey: 'secret' }, fetch));
    const out = await service.forecast(
      { ...request, mode },
      { coordinateSource: 'explicit', latitude: 48.2, longitude: 16.37 },
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0].pathname, mode === 'current' ? /currentConditions/ : mode === 'hourly' ? /hours/ : /days/);
    assert.equal(urls[0].searchParams.get('key'), 'secret');
    assert.equal(urls[0].searchParams.get('unitsSystem'), 'METRIC');
    assert.equal(urls[0].searchParams.get('languageCode'), 'de-AT');
    assert.equal(out.source, 'google-weather-api');
  }
});

test('overview calls all endpoints and maps representative optional fields', async () => {
  const fetch = async (input) => {
    const p = new URL(input).pathname;
    if (p.includes('current'))
      return response({
        currentTime: 't',
        weatherCondition: { type: 'RAIN', description: { text: 'Rain' } },
        temperature: { degrees: 8 },
        precipitation: { probability: { percent: 80, type: 'RAIN' }, qpf: { quantity: 2 } },
        visibility: { distance: 9 },
      });
    if (p.includes('hours')) return response({ forecastHours: [{ interval: { startTime: 'h' } }] });
    return response({
      forecastDays: [
        {
          displayDate: { year: 2026, month: 9, day: 4 },
          daytimeForecast: { weatherCondition: { description: { text: 'Cloudy' } } },
        },
      ],
    });
  };
  const out = await new WeatherService(new GoogleWeatherClient({ enabled: true, apiKey: 'secret' }, fetch)).forecast(
    request,
    { coordinateSource: 'explicit', latitude: 1, longitude: 2 },
  );
  assert.equal(out.current.precipitation.amountMm, 2);
  assert.equal(out.hourly.length, 1);
  assert.equal(out.daily[0].date, '2026-09-04');
});

test('hourly pagination is bounded, detects repeated tokens, and truncates requested records', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return response({
      forecastHours: Array.from({ length: 24 }, (_, i) => ({ interval: { startTime: `t${calls}-${i}` } })),
      nextPageToken: 'same',
    });
  };
  const out = await new GoogleWeatherClient({ enabled: true, apiKey: 'never-leaked' }, fetch).hourly(request);
  assert.equal(calls, 2);
  assert.equal(out.values.length, 25);
});

test('provider failures are sanitized and classified', async () => {
  for (const [status, kind] of [
    [400, 'request'],
    [401, 'authorization'],
    [403, 'authorization'],
    [429, 'rate_limit'],
    [500, 'dependency'],
  ]) {
    const client = new GoogleWeatherClient({ enabled: true, apiKey: 'top-secret' }, async () =>
      response({}, status, { 'retry-after': '7' }),
    );
    await assert.rejects(
      () => client.current(request),
      (e) =>
        e instanceof WeatherError &&
        e.kind === kind &&
        !e.message.includes('top-secret') &&
        (status !== 429 || e.retryAfterMs === 7000),
    );
  }
  const malformed = new GoogleWeatherClient({ enabled: true, apiKey: 'top-secret' }, async () => response('{bad'));
  await assert.rejects(
    () => malformed.current(request),
    (e) => e.kind === 'contract',
  );
});

test('disabled, missing configuration, network, and timeout failures are deterministic', async () => {
  await assert.rejects(
    () => new GoogleWeatherClient({ enabled: false }).current(request),
    (e) => e.kind === 'disabled',
  );
  await assert.rejects(
    () => new GoogleWeatherClient({ enabled: true }).current(request),
    (e) => e.kind === 'configuration',
  );
  await assert.rejects(
    () =>
      new GoogleWeatherClient({ enabled: true, apiKey: 'x' }, async () => {
        throw new Error('network');
      }).current(request),
    (e) => e.kind === 'dependency',
  );
  await assert.rejects(
    () =>
      new GoogleWeatherClient({ enabled: true, apiKey: 'x' }, async () => {
        throw Object.assign(new Error(), { name: 'TimeoutError' });
      }).current(request),
    (e) => e.kind === 'timeout',
  );
});

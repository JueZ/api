import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { WeatherService } from '../../shared/weather/service.js';
import { WeatherError } from '../../shared/weather/client.js';
import type { WeatherLocation, WeatherMode, WeatherRequest } from '../../shared/weather/types.js';

const conditionSchema = z.object({ type: z.string().optional(), description: z.string().optional() });
const precipitationSchema = z.object({
  probabilityPercent: z.number().optional(),
  amountMm: z.number().optional(),
  type: z.string().optional(),
});
const windSchema = z.object({
  speedKmh: z.number().optional(),
  gustKmh: z.number().optional(),
  directionDegrees: z.number().optional(),
  directionCardinal: z.string().optional(),
});
const currentSchema = z.object({
  time: z.string(),
  condition: conditionSchema,
  temperatureC: z.number().optional(),
  feelsLikeC: z.number().optional(),
  precipitation: precipitationSchema.optional(),
  wind: windSchema.optional(),
  relativeHumidityPercent: z.number().optional(),
  cloudCoverPercent: z.number().optional(),
  thunderstormProbabilityPercent: z.number().optional(),
  uvIndex: z.number().optional(),
  visibilityKm: z.number().optional(),
  pressureHpa: z.number().optional(),
  isDaytime: z.boolean().optional(),
});
const hourlySchema = currentSchema
  .omit({ time: true, visibilityKm: true, pressureHpa: true })
  .extend({ startTime: z.string(), localDateTime: z.string().optional() });
const periodSchema = z.object({
  condition: conditionSchema.optional(),
  precipitationProbabilityPercent: z.number().optional(),
  precipitationAmountMm: z.number().optional(),
  windSpeedKmh: z.number().optional(),
  windGustKmh: z.number().optional(),
  relativeHumidityPercent: z.number().optional(),
  cloudCoverPercent: z.number().optional(),
  thunderstormProbabilityPercent: z.number().optional(),
});
const dailySchema = z.object({
  date: z.string(),
  minTemperatureC: z.number().optional(),
  maxTemperatureC: z.number().optional(),
  feelsLikeMinC: z.number().optional(),
  feelsLikeMaxC: z.number().optional(),
  daytime: periodSchema.optional(),
  nighttime: periodSchema.optional(),
  sunriseTime: z.string().optional(),
  sunsetTime: z.string().optional(),
});
const outputSchema = z.object({
  source: z.literal('google-weather-api'),
  fetchedAt: z.string(),
  mode: z.enum(['current', 'hourly', 'daily', 'overview']),
  location: z.object({
    coordinateSource: z.enum(['explicit', 'chatgpt_user_location']),
    latitude: z.number(),
    longitude: z.number(),
    city: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    timeZone: z.string().optional(),
  }),
  current: currentSchema.optional(),
  hourly: z.array(hourlySchema).max(72).optional(),
  daily: z.array(dailySchema).max(10).optional(),
});

type Failure = (kind: string, message: string, status?: number, retryAfterMs?: number) => CallToolResult;
interface WeatherToolOptions {
  weather: WeatherService;
  requirePrincipal: () => Promise<CallToolResult | object>;
  security: object;
  failure: Failure;
}
type Meta = Record<string, unknown>;
const isRecord = (v: unknown): v is Meta => typeof v === 'object' && v !== null && !Array.isArray(v);

export function registerWeatherTool(server: McpServer, options: WeatherToolOptions): void {
  server.registerTool(
    'weather_get_forecast',
    {
      title: 'Google weather forecast',
      description:
        'Get metric current conditions, hourly forecasts up to 72 hours, or daily forecasts up to 10 days from the Google Weather API. For “here” or “near me”, omit coordinates so ChatGPT location metadata can be used.',
      inputSchema: {
        mode: z.enum(['current', 'hourly', 'daily', 'overview']).default('overview'),
        latitude: z.number().finite().min(-90).max(90).optional(),
        longitude: z.number().finite().min(-180).max(180).optional(),
        hours: z.number().int().min(1).max(72).default(24),
        days: z.number().int().min(1).max(10).default(7),
        languageCode: z
          .string()
          .trim()
          .min(2)
          .max(35)
          .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
          .optional(),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ...options.security,
    },
    async (args, extra) => {
      const principal = await options.requirePrincipal();
      if ('isError' in principal) return principal as CallToolResult;
      const meta = isRecord(extra) && isRecord(extra['_meta']) ? extra['_meta'] : {};
      const explicitPartial = (args.latitude === undefined) !== (args.longitude === undefined);
      if (explicitPartial)
        return options.failure('invalid_arguments', 'latitude and longitude must be provided together.');
      const hint = isRecord(meta['openai/userLocation']) ? meta['openai/userLocation'] : {};
      let location: WeatherLocation | undefined;
      if (args.latitude !== undefined && args.longitude !== undefined)
        location = {
          coordinateSource: 'explicit',
          latitude: args.latitude,
          longitude: args.longitude,
          ...descriptions(hint),
        };
      else if (validCoordinates(hint['latitude'], hint['longitude']))
        location = {
          coordinateSource: 'chatgpt_user_location',
          latitude: hint['latitude'],
          longitude: hint['longitude'] as number,
          ...descriptions(hint),
        };
      if (!location)
        return options.failure(
          'location_required',
          "Ask the user to provide a location or coordinates, or enable ChatGPT location sharing. Do not guess the user's location.",
        );
      const locale = typeof meta['openai/locale'] === 'string' ? meta['openai/locale'] : undefined;
      const request: WeatherRequest = {
        mode: args.mode as WeatherMode,
        latitude: location.latitude,
        longitude: location.longitude,
        hours: args.hours,
        days: args.days,
        languageCode: args.languageCode ?? locale,
      };
      try {
        const forecast = await options.weather.forecast(request, location);
        const pieces = [];
        if (forecast.current) pieces.push('current conditions');
        if (forecast.hourly) pieces.push(`${forecast.hourly.length} hourly records`);
        if (forecast.daily) pieces.push(`${forecast.daily.length} daily records`);
        const place = forecast.location.city ?? 'the requested location';
        return {
          structuredContent: forecast as unknown as Record<string, unknown>,
          content: [{ type: 'text', text: `Returned ${pieces.join(', ')} for ${place}.` }],
        };
      } catch (error) {
        if (error instanceof WeatherError)
          return options.failure(error.kind, weatherMessage(error.kind), error.status, error.retryAfterMs);
        return options.failure('dependency', 'The Google Weather API request failed.', 502);
      }
    },
  );
}
function validCoordinates(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === 'number' &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}
function descriptions(v: Meta) {
  const out: { city?: string; region?: string; country?: string; timeZone?: string } = {};
  for (const [from, to] of [
    ['city', 'city'],
    ['region', 'region'],
    ['country', 'country'],
    ['timezone', 'timeZone'],
  ] as const) {
    if (typeof v[from] === 'string' && v[from].length <= 120) out[to] = v[from];
  }
  return out;
}
function weatherMessage(kind: string): string {
  if (kind === 'disabled') return 'The weather provider is disabled.';
  if (kind === 'configuration') return 'The weather provider is not configured.';
  if (kind === 'rate_limit') return 'The Google Weather API is rate limiting requests.';
  if (kind === 'authorization') return 'The Google Weather API rejected server credentials.';
  if (kind === 'request') return 'The Google Weather API rejected the request.';
  if (kind === 'timeout') return 'The Google Weather API request timed out.';
  if (kind === 'contract') return 'The Google Weather API returned an unexpected response.';
  return 'The Google Weather API is temporarily unavailable.';
}

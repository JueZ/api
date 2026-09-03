import { GoogleWeatherClient, type WeatherFetch } from '../../shared/weather/client.js';
import { WeatherService } from '../../shared/weather/service.js';

export function createWeatherService(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: WeatherFetch = fetch,
): WeatherService {
  return new WeatherService(
    new GoogleWeatherClient(
      { enabled: env['WEATHER_ENABLED'] === 'true', apiKey: env['GOOGLE_WEATHER_API_KEY']?.trim() || undefined },
      fetchImpl,
    ),
  );
}

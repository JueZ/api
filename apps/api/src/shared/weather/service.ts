import { GoogleWeatherClient } from './client.js';
import type { WeatherForecast, WeatherLocation, WeatherRequest } from './types.js';

export class WeatherService {
  constructor(private readonly client: GoogleWeatherClient) {}
  async forecast(request: WeatherRequest, location: WeatherLocation): Promise<WeatherForecast> {
    const result: WeatherForecast = {
      source: 'google-weather-api',
      fetchedAt: new Date().toISOString(),
      mode: request.mode,
      location,
    };
    if (request.mode === 'current') {
      const current = await this.client.current(request);
      result.current = current.value;
      result.location.timeZone ??= current.timeZone;
    } else if (request.mode === 'hourly') {
      const hourly = await this.client.hourly(request);
      result.hourly = hourly.values;
      result.location.timeZone ??= hourly.timeZone;
    } else if (request.mode === 'daily') {
      const daily = await this.client.daily(request);
      result.daily = daily.values;
      result.location.timeZone ??= daily.timeZone;
    } else {
      const [current, hourly, daily] = await Promise.all([
        this.client.current(request),
        this.client.hourly(request),
        this.client.daily(request),
      ]);
      result.current = current.value;
      result.hourly = hourly.values;
      result.daily = daily.values;
      result.location.timeZone ??= current.timeZone ?? hourly.timeZone ?? daily.timeZone;
    }
    return result;
  }
}

export type WeatherMode = 'current' | 'hourly' | 'daily' | 'overview';
export type CoordinateSource = 'explicit' | 'chatgpt_user_location';

export interface WeatherLocation {
  coordinateSource: CoordinateSource;
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  timeZone?: string;
}

export interface WeatherCondition {
  type?: string;
  description?: string;
}
export interface WeatherPrecipitation {
  probabilityPercent?: number;
  amountMm?: number;
  type?: string;
}
export interface WeatherWind {
  speedKmh?: number;
  gustKmh?: number;
  directionDegrees?: number;
  directionCardinal?: string;
}
export interface CurrentWeather {
  time: string;
  condition: WeatherCondition;
  temperatureC?: number;
  feelsLikeC?: number;
  precipitation?: WeatherPrecipitation;
  wind?: WeatherWind;
  relativeHumidityPercent?: number;
  cloudCoverPercent?: number;
  thunderstormProbabilityPercent?: number;
  uvIndex?: number;
  visibilityKm?: number;
  pressureHpa?: number;
  isDaytime?: boolean;
}
export interface HourlyWeather extends Omit<CurrentWeather, 'time' | 'visibilityKm' | 'pressureHpa'> {
  startTime: string;
  localDateTime?: string;
}
export interface DailyPeriod {
  condition?: WeatherCondition;
  precipitationProbabilityPercent?: number;
  precipitationAmountMm?: number;
  windSpeedKmh?: number;
  windGustKmh?: number;
  relativeHumidityPercent?: number;
  cloudCoverPercent?: number;
  thunderstormProbabilityPercent?: number;
}
export interface DailyWeather {
  date: string;
  minTemperatureC?: number;
  maxTemperatureC?: number;
  feelsLikeMinC?: number;
  feelsLikeMaxC?: number;
  daytime?: DailyPeriod;
  nighttime?: DailyPeriod;
  sunriseTime?: string;
  sunsetTime?: string;
}
export interface WeatherForecast {
  source: 'google-weather-api';
  fetchedAt: string;
  mode: WeatherMode;
  location: WeatherLocation;
  current?: CurrentWeather;
  hourly?: HourlyWeather[];
  daily?: DailyWeather[];
}
export interface WeatherRequest {
  mode: WeatherMode;
  latitude: number;
  longitude: number;
  hours: number;
  days: number;
  languageCode?: string;
}

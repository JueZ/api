# Google Weather MCP setup

`weather_get_forecast` is the catalogue's single read-only weather tool. It requires the delegated or application permission `weather.read` and returns compact, normalized metric-unit data sourced from the Google Weather API. It supports current conditions, 1–72 hourly records, 1–10 daily records, or an overview (current plus both forecast ranges). It is not direct WeatherNext dataset access and does not report per-response forecast-model provenance.

## Google Cloud and deployment configuration

In a billing-enabled Google Cloud project, enable **Weather API** in Google Maps Platform and create an API key. Restrict the key to the Weather API and apply appropriate application restrictions. Store a separate value in each GitHub `test` and `production` Environment as the secret `GOOGLE_WEATHER_API_KEY`; never put it in a variable, caller argument, source file, or log. Protected delivery enables weather by default, stores that environment's secret in its environment-specific Azure Key Vault, and configures the Function App with a versioned Key Vault reference. An explicit environment variable `WEATHER_ENABLED=false` disables the provider independently for that environment; no key is then required and calls return the standard provider-disabled error.

Also add `weather.read` to `OIDC_REQUIRED_SCOPES`, expose/grant that scope in the Entra API application, consent it to the ChatGPT MCP OAuth client, and reconnect the connector if fresh consent is needed. The Google project needs billing and the Weather API enabled, as described by the [Google Weather API overview](https://developers.google.com/maps/documentation/weather/overview).

## Location and locale

Explicit `latitude` and `longitude` must be supplied together, are range checked, and override ChatGPT metadata. When they are omitted, the tool best-effort reads optional, untrusted `_meta["openai/userLocation"]` coordinates. City, region, country, and timezone are descriptive only; they are never used for authorization or geocoding. ChatGPT location can be coarse. If neither source contains usable coordinates, the tool tells ChatGPT to ask for a location/coordinates or enable location sharing and never to guess. `_meta["openai/locale"]` supplies `languageCode` only when the caller did not specify one.

Examples: “What is the weather here?”, “Will it rain here tomorrow afternoon?”, and “What is the weather here this weekend?” Hour-specific questions should use `hourly`; multi-day questions should use `daily`; `overview` is for requests needing both.

## Local verification

Set `DEPLOYED_ENVIRONMENT_NAME=local`, `WEATHER_ENABLED=true`, and a local secret `GOOGLE_WEATHER_API_KEY` only when manually exercising the provider. Automated tests inject `fetch` and never contact Google:

```bash
npm run test:api
npm run ops:check-operation-drift
npm run docs:check-operations
```

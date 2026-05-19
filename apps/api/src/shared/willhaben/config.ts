function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  return value === undefined ? defaultValue : value === 'true';
}

function readNumber(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const willhabenConfig = {
  enabled: readBoolean(process.env['WILLHABEN_ENABLED'], false),
  searchTtlSeconds: readNumber(process.env['WILLHABEN_CACHE_TTL_SEARCH_SECONDS'], 600),
  detailTtlSeconds: readNumber(process.env['WILLHABEN_CACHE_TTL_DETAIL_SECONDS'], 1800),
  httpTimeoutMs: readNumber(process.env['WILLHABEN_HTTP_TIMEOUT_MS'], 8000),
  maxResultsLimit: readNumber(process.env['WILLHABEN_MAX_RESULTS_LIMIT'], 50),
  allowRawSearchUrl: readBoolean(process.env['WILLHABEN_ALLOW_RAW_SEARCH_URL'], false),
  debugDiagnostics: readBoolean(process.env['WILLHABEN_DEBUG_DIAGNOSTICS'], false),
};

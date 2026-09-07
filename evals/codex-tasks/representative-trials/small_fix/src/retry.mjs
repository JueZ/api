export function shouldRetry({ attempt, maxAttempts, status }) {
  return (status === 429 || (status >= 500 && status <= 599)) && attempt <= maxAttempts;
}

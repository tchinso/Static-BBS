const STARTUP_RETRY_DELAYS = [300, 1000, 2500];
const FETCH_NETWORK_ERROR = /^(?:failed to fetch|fetch failed|load failed|network request failed|networkerror when attempting to fetch resource\.?)$/i;

function waitForRetry(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isRetryable(error) {
  const status = error?.status;
  if (Number.isInteger(status)) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' ||
    (error?.name === 'TypeError' && FETCH_NETWORK_ERROR.test(error.message));
}

export async function retryStartup(operation, { wait = waitForRetry, delays = STARTUP_RETRY_DELAYS } = {}) {
  for (const delay of delays) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error)) throw error;
    }
    await wait(delay);
  }
  return operation();
}

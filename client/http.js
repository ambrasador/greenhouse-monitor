// Помилка HTTP зі статусом: за ним вирішують, чи повторювати запит
export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// Повторюємо лише те, що може минути саме: збій мережі (статусу немає),
// 5xx і 429. Решта 4xx — помилка самого запиту, повтор її не виправить.
// failureCount — скільки спроб уже невдалих: усього три спроби
export function shouldRetry(failureCount, error) {
  const status = error?.status;
  const transient = status === undefined || status >= 500 || status === 429;
  return transient && failureCount < 2;
}

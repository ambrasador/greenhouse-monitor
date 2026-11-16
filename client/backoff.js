// Затримка перед спробою attempt (1, 2, 3, …): стеля росте вдвічі до cap,
// сама затримка — випадкова рівномірна з [0, стеля) («повний джитер»)
export function delay(attempt, { base = 1000, cap = 30_000, rnd = Math.random } = {}) {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(rnd() * ceiling);
}

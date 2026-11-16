const f = (a) => a + 1; let s = 0; const N = 5e7;
const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) s = f(s);
console.log('виклик усередині процесу:', (Number(process.hrtime.bigint() - t) / N).toFixed(1), 'нс', s > 0);

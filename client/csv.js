// CSV за RFC 4180: поля з роздільником, лапками чи переносом беруть
// у лапки, лапки подвоюють, рядки закінчуються CRLF. Текстові клітинки,
// що починаються на = + - @, табуляцію, CR чи LF (або на повноширинні
// ＝ ＋ － ＠), табличний процесор виконав би як формулу: перед ними
// ставлять '. Числа й час не чіпаємо, щоб -3,5 лишилося числом
const DANGEROUS = /^[=+\-@\t\r\n＝＋－＠]/;

export function toCsv(rows, columns,
  { delimiter = ',', decimal = '.', bom = false } = {}) {
  const quote = (s) => (s.includes(delimiter) || /["\r\n]/.test(s)
    ? `"${s.replaceAll('"', '""')}"` : s);
  const cell = (value, type) => {
    if (value === null || value === undefined) return '';
    if (type === 'number') {
      return Number.isFinite(value)
        ? String(value).replace('.', decimal) : '';
    }
    if (type === 'time') return new Date(value).toISOString();
    const text = String(value);
    return quote(DANGEROUS.test(text) ? `'${text}` : text);
  };
  const head = columns.map((c) => quote(c.header)).join(delimiter);
  const body = rows.map(
    (r) => columns.map((c) => cell(r[c.key], c.type)).join(delimiter));
  return `${bom ? '\uFEFF' : ''}${[head, ...body].join('\r\n')}\r\n`;
}

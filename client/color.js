// Контраст за WCAG 2.2 і симуляція дальтонізму за Machado, Oliveira, Fernandes (2009).
// Кольори — рядки '#RRGGBB'

export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const hex = (c) => `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

// sRGB → лінійна яскравість компоненти (формула з означення relative luminance)
const toLinear = (c8) => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

export function luminance(color) {
  const [r, g, b] = rgb(color).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Коефіцієнт контрасту від 1 до 21
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Матриці дейтеранопії (відсутні M-колбочки) для серйозності 1,0. Застосовуються
// до лінійних компонент RGB, а не до гама-кодованих значень sRGB
const DEUTAN = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];

export function deuteranopia(color) {
  const lin = rgb(color).map(toLinear);
  return hex(DEUTAN.map((row) => toSrgb8(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
}

// Різниця кольорів ΔE*ab (CIE76) у просторі CIELAB для білої точки D65
export function deltaE(a, b) {
  const lab = (color) => {
    const [r, g, bl] = rgb(color).map(toLinear);
    const xyz = [
      0.4124564 * r + 0.3575761 * g + 0.1804375 * bl,
      0.2126729 * r + 0.7151522 * g + 0.072175 * bl,
      0.0193339 * r + 0.119192 * g + 0.9503041 * bl,
    ];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const [fx, fy, fz] = [xyz[0] / 0.95047, xyz[1], xyz[2] / 1.08883].map(f);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

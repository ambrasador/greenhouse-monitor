import { RANGES } from './history.js';

// Власні радіокнопки браузера: клавіатура й зчитувач екрана працюють
// без додаткового коду
export function RangeSwitch({ value, onChange }) {
  return (
    <fieldset className="range">
      <legend>Діапазон</legend>
      {Object.entries(RANGES).map(([key, { label }]) => (
        <label key={key}>
          <input type="radio" name="range" value={key}
                 checked={value === key} onChange={() => onChange(key)} />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

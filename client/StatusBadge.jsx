import { STATUS } from './status.js';

// Статус передають три канали: колір (клас), форма (іконка) і слово.
// Іконка прихована від зчитувача екрана: слово вже повідомляє те саме
export function StatusBadge({ level }) {
  const { label, icon } = STATUS[level];
  return (
    <span className={`badge badge--${level}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}

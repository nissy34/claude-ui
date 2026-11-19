/**
 * Shared UI components. Screens build with these instead of hand-writing class
 * names, so a control looks and behaves the same everywhere and can be changed
 * here (markup) or in ../design/components.css (look) in one place.
 *
 * Every component passes unknown props (onClick, title, disabled, aria-*, ref…)
 * through to its root element and merges `className`.
 */
import React, { forwardRef } from 'react';

export const cx = (...parts) => parts.flat().filter(Boolean).join(' ');

/**
 * Text button.
 * variant: undefined (outlined) | 'primary' | 'ghost' | 'danger' | 'dark'
 * size: undefined | 'sm'
 * on: pressed/selected state. as: element to render ('button' by default, 'a' for links).
 * Like a plain <button>, it submits a surrounding form unless you pass type="button".
 */
export const Button = forwardRef(function Button({ as: As = 'button', variant, size, on, className, ...rest }, ref) {
  const v = Array.isArray(variant) ? variant : variant ? variant.split(' ') : [];
  return <As ref={ref} className={cx('btn', size === 'sm' && 'small', v, on && 'on', className)} {...rest} />;
});

/** Square, borderless button for an icon (and optionally a short label). Give it a title or aria-label. */
export const IconButton = forwardRef(function IconButton({ as: As = 'button', size, on, danger, className, ...rest }, ref) {
  return <As ref={ref} className={cx('icon-btn', size === 'sm' && 'small', on && 'on', danger && 'danger', className)} {...rest} />;
});

/**
 * Floating menu / popover surface. Position it inside a `.menu-wrap` (position: relative).
 * place: 'up' | 'down' | 'sub'. align: 'left' | 'right'.
 */
export const Menu = forwardRef(function Menu({ place = 'down', align, className, ...rest }, ref) {
  return <div ref={ref} role="menu" className={cx('pop', place, align, className)} {...rest} />;
});

/** A row in a Menu. icon and kbd are optional; hint renders as a muted second line. */
export function MenuItem({ icon, kbd, hint, on, danger, className, children, ...rest }) {
  return (
    <button type="button" role="menuitem" className={cx(on && 'on', danger && 'danger', className)} {...rest}>
      {icon != null && <span className="check">{icon}</span>}
      <span className="menu-label">
        {children}
        {hint && <span className="desc">{hint}</span>}
      </span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

export const MenuSeparator = () => <div className="sep" role="separator" />;

/** Dialog: dims the app, closes on a click outside the card. size: undefined | 'wide'. */
export function Modal({ onClose, size, className, overlayClassName, children, ...rest }) {
  return (
    <div className={cx('modal', overlayClassName)} onClick={onClose}>
      <div role="dialog" aria-modal="true" className={cx('modal-card', size, className)} onClick={(e) => e.stopPropagation()} {...rest}>
        {children}
      </div>
    </div>
  );
}

/** Dialog header: title on the left, extra controls, then a close button when onClose is given. */
export function ModalHead({ title, onClose, className, children }) {
  return (
    <div className={cx('modal-head', className)}>
      {title != null && <span className="mtitle">{title}</span>}
      {children}
      {onClose && (
        <IconButton onClick={onClose} aria-label="Close" title="Close">
          ✕
        </IconButton>
      )}
    </div>
  );
}
export const ModalBody = ({ className, ...rest }) => <div className={cx('modal-body', className)} {...rest} />;
export const ModalFoot = ({ className, ...rest }) => <div className={cx('modal-foot', className)} {...rest} />;

/** Text inputs. size: undefined | 'sm' | 'lg'. mono: monospace text. */
const fieldClass = (size, mono, className) => cx('field', size, mono && 'mono', className);
export const Input = forwardRef(function Input({ size, mono, className, ...rest }, ref) {
  return <input ref={ref} className={fieldClass(size, mono, className)} {...rest} />;
});
export const Select = forwardRef(function Select({ size, mono, className, ...rest }, ref) {
  return <select ref={ref} className={fieldClass(size, mono, className)} {...rest} />;
});
export const Textarea = forwardRef(function Textarea({ size, mono, className, ...rest }, ref) {
  return <textarea ref={ref} className={fieldClass(size, mono, className)} {...rest} />;
});

/**
 * Small rounded label for a state or a count.
 * tone: undefined (neutral) | 'accent' | 'green' | 'red' | 'warn' | 'blue' | 'purple'. mono: monospace.
 */
export function Pill({ as: As = 'span', tone, mono, className, ...rest }) {
  return <As className={cx('pill', tone, mono && 'mono', className)} {...rest} />;
}

/** Round accent badge with a number, for tabs and menu rows. */
export const Count = ({ className, ...rest }) => <span className={cx('count', className)} {...rest} />;

/** Bordered surface for list items and grouped content. interactive: hover highlight. */
export const Card = forwardRef(function Card({ as: As = 'div', interactive, className, ...rest }, ref) {
  return <As ref={ref} className={cx('card', interactive && 'interactive', className)} {...rest} />;
});

/** On/off switch. value: boolean; onChange(next). */
export function Toggle({ value, onChange, label, className, ...rest }) {
  return <button type="button" role="switch" aria-checked={!!value} aria-label={label} className={cx('toggle', value && 'on', className)} onClick={() => onChange?.(!value)} {...rest} />;
}

/** Segmented control. options: [[value, label], …]. */
export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={cx('seg', className)} role="tablist">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const Spinner = ({ className }) => <span className={cx('spinner', className)} aria-hidden="true" />;
export const Kbd = (props) => <kbd {...props} />;

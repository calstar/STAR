import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './styles';

/**
 * A 28 px button (24 px small). `icon` sits before the label; with `iconOnly`, give `aria-label`.
 * Disabled is the native attribute, so a `disabled={readOnly}` gates it for the checkout audit.
 */
export function Button({ variant = 'ghost', size = 'md', icon, iconOnly = false, className = '', type = 'button', children, ref, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: ReactNode;
    iconOnly?: boolean;
    ref?: Ref<HTMLButtonElement>;
  }) {
  return (
    <button ref={ref} type={type} className={`${buttonClass(variant, size, iconOnly)} ${className}`} {...rest}>
      {icon && <span aria-hidden className="inline-flex shrink-0">{icon}</span>}
      {children}
    </button>
  );
}

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

const variants = cva('ui-button', { variants: {
  variant: { default: 'ui-button-primary', secondary: 'ui-button-secondary', ghost: 'ui-button-ghost', outline: 'ui-button-outline', destructive: 'ui-button-danger' },
  size: { default: '', sm: 'ui-button-sm', icon: 'ui-button-icon' },
}, defaultVariants: { variant: 'secondary', size: 'default' } });
export function Button({ className, variant, size, asChild, ...props }: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" className={cn(variants({ variant, size }), className)} {...props} />;
}

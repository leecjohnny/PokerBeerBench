import { Button as BaseButton } from '@base-ui/react/button';
import { Input as BaseInput } from '@base-ui/react/input';
import type { ComponentProps } from 'react';

const control =
  'min-h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-950 outline-none transition focus-visible:border-neutral-950 focus-visible:ring-2 focus-visible:ring-neutral-950/20 disabled:cursor-not-allowed disabled:opacity-50';

export function Button({
  className = '',
  secondary = false,
  ...props
}: Omit<ComponentProps<typeof BaseButton>, 'className'> & {
  className?: string;
  secondary?: boolean;
}) {
  return (
    <BaseButton
      className={`min-h-11 rounded-md border px-4 py-2 font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? 'border-neutral-300 bg-white text-neutral-950 hover:bg-neutral-100' : 'border-neutral-950 bg-neutral-950 text-white hover:bg-neutral-800'} ${className}`}
      {...props}
    />
  );
}

export function Input({
  className = '',
  ...props
}: Omit<ComponentProps<typeof BaseInput>, 'className'> & { className?: string }) {
  return <BaseInput className={`${control} ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea className={`${control} ${className}`} {...props} />;
}

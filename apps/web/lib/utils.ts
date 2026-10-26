import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge our font sizes, otherwise `text-md` is mistaken for a colour and merged away.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['display-xl', 'display-lg', 'display-md', 'display-sm', 'md', 'label'] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

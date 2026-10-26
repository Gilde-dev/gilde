import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { Field } from './field';
import { Input } from './input';

const error = new ApiError('bad', 400, 'bad', [
  { path: 'name', message: 'Required' },
  { path: 'slug', message: 'Too short' },
]);

describe('Field', () => {
  it('shows the zod issue for its path and links it to the control', () => {
    render(
      <Field label="Name" path="name" error={error} hint="Shown in the board">
        <Input />
      </Field>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    expect(screen.getByText('Shown in the board')).toBeInTheDocument();
  });

  it('ignores issues for other paths', () => {
    render(
      <Field label="Email" path="email" error={error}>
        <Input />
      </Field>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  });
});

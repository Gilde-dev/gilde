import { Suspense } from 'react';
import { SetupForm } from '@/components/setup-form';

export default function Page() {
  return (
    <Suspense>
      <SetupForm />
    </Suspense>
  );
}

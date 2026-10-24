import { Suspense } from 'react';
import { Dashboard } from '@/components/dashboard';

export default function Page() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}

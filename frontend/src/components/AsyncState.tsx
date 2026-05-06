import { Card } from './Card';

export function ErrorState({ title = 'Request failed', error }: { title?: string; error: unknown }) {
  return (
    <Card>
      <div className="font-display text-xl font-bold text-rose-200">{title}</div>
      <div className="mt-2 text-sm text-slate-400">{error instanceof Error ? error.message : 'Unknown error'}</div>
    </Card>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <div className="font-display text-xl font-bold text-slate-200">{title}</div>
      <div className="mt-2 text-sm text-slate-400">{description}</div>
    </Card>
  );
}

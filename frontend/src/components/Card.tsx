import { classNames } from '../utils/format';

export function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={classNames('rounded-3xl border border-white/10 bg-white/[0.045] p-5 shadow-glow backdrop-blur', className)}>
      {title && <h2 className="mb-4 font-display text-lg font-semibold text-white">{title}</h2>}
      {children}
    </section>
  );
}

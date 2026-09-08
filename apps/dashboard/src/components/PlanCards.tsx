import { planFeatures, formatPlanPrice } from '../lib/plans.js';
import { useT } from '../lib/i18n/index.js';
import type { PlanId, PlanInfo } from '../lib/types.js';

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-accent-400" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Filled when the plan is the current choice. Purely decorative: the input carries the state. */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
        checked ? 'border-accent-500 bg-accent-500' : 'border-zinc-600 bg-transparent'
      }`}
    >
      {checked && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
    </span>
  );
}

interface PlanCardsProps {
  plans: PlanInfo[];
  selected: PlanId | null;
  onSelect: (plan: PlanId) => void;
  /** Label of the per-card action button. When absent the whole card is the control (radio behaviour). */
  ctaLabel?: string;
  /** Plan whose button is currently working (redirecting to Stripe). */
  pendingPlan?: PlanId | null;
  disabled?: boolean;
  /** Name of the underlying radio group, when several selectors share a page. */
  name?: string;
}

/**
 * The two-plan selector, shared by the signup page, the paywall and the
 * "checkout canceled" page so the pricing is written in exactly one place.
 *
 * Without `ctaLabel` the card is a radio: clicking anywhere on it — title,
 * price, any feature line — picks that plan, and the arrow keys move between
 * plans. With `ctaLabel` the card is inert and its button carries the action,
 * because there a click means "pay for this plan", not "consider it".
 */
export function PlanCards({ plans, selected, onSelect, ctaLabel, pendingPlan, disabled, name = 'plan' }: PlanCardsProps) {
  const { t, locale } = useT();
  const asRadio = !ctaLabel;

  const cards = plans.map((plan) => {
    const isSelected = selected === plan.id;
    const isPending = pendingPlan === plan.id;
    const label = plan.id === 'business' ? t.plans.business : t.plans.pro;

    const body = (
      <>
        {plan.id === 'pro' && (
          <span className="absolute -top-2.5 right-4 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent-600 text-white">
            {t.plans.mostPopular}
          </span>
        )}

        <div className="flex items-center gap-2">
          {asRadio && <RadioDot checked={isSelected} />}
          <span className="text-sm font-semibold text-zinc-100">{label}</span>
          {isSelected && (
            <span className="text-[10px] font-medium text-accent-400 uppercase tracking-wider">{t.plans.selected}</span>
          )}
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-semibold text-zinc-50 tabular-nums">{formatPlanPrice(plan, locale)}</span>
          <span className="text-xs text-zinc-500">{t.plans.perMonth}</span>
        </div>
        <p className="text-[11px] text-zinc-600 mt-0.5">{t.plans.exclTax}</p>

        <ul className="mt-4 space-y-2 flex-1">
          {planFeatures(plan, t).map((feature) => (
            <li key={feature} className="flex gap-2 text-xs text-zinc-400 leading-relaxed">
              <Check />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </>
    );

    const frame = `relative flex flex-col rounded-2xl border p-5 text-left transition-colors ${
      isSelected ? 'border-accent-500/60 bg-accent-500/[0.06]' : 'border-zinc-800/60 bg-zinc-900/60'
    }`;

    // Radio mode: a label wrapping a real input, so the whole card is the hit
    // area and the browser gives us keyboard navigation and screen-reader
    // semantics for free.
    if (asRadio) {
      return (
        <label
          key={plan.id}
          data-plan={plan.id}
          data-selected={isSelected ? 'true' : 'false'}
          className={`${frame} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-zinc-700'} focus-within:ring-2 focus-within:ring-accent-500/50`}
        >
          <input
            type="radio"
            name={name}
            value={plan.id}
            checked={isSelected}
            disabled={disabled}
            onChange={() => onSelect(plan.id)}
            className="sr-only"
          />
          {body}
        </label>
      );
    }

    return (
      <div
        key={plan.id}
        data-plan={plan.id}
        data-selected={isSelected ? 'true' : 'false'}
        className={frame}
      >
        {body}
        <button
          type="button"
          onClick={() => onSelect(plan.id)}
          disabled={disabled || isPending}
          className={`mt-5 h-9 w-full text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            plan.id === 'pro'
              ? 'bg-accent-600 text-white hover:bg-accent-500'
              : 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          {isPending ? t.billing.opening : ctaLabel}
        </button>
      </div>
    );
  });

  return asRadio ? (
    <div role="radiogroup" aria-label={t.plans.choosePlan} className="grid gap-4 sm:grid-cols-2" data-testid="plan-picker">
      {cards}
    </div>
  ) : (
    <div className="grid gap-4 sm:grid-cols-2">{cards}</div>
  );
}

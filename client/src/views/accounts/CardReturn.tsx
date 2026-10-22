import type { CardReviewCard, CardReviewWindow, UnattributedRedemption } from '@shared/types';
import { formatCurrency, formatDate } from '../../lib/formatters';
import { SectionLabel } from '../../components/balance';

const ROWS: ReadonlyArray<[keyof CardReviewWindow, string]> = [
  ['redeemed', 'Redeemed'],
  ['fees', 'Fees'],
  ['net', 'Net'],
  ['spend', 'Spend'],
];

function renewalLine(card: CardReviewCard, today: string): string | null {
  if (!card.last_annual_fee_date || !card.next_annual_fee_date) return null;
  const fee = card.fees.filter((f) => f.kind === 'annual' && f.date === card.last_annual_fee_date)
    .reduce((sum, f) => sum - f.amount, 0);
  const last = formatDate(card.last_annual_fee_date);
  const next = formatDate(card.next_annual_fee_date);
  return card.next_annual_fee_date < today
    ? `Annual fee of ${formatCurrency(fee)} last charged ${last}. The next was expected around ${next} and has not posted.`
    : `Annual fee of ${formatCurrency(fee)} last charged ${last}. The next is expected around ${next}.`;
}

function unattributedLine(row: UnattributedRedemption): string {
  return `${formatCurrency(row.amount)} "${row.descriptor}" into ${row.account_name} on ${formatDate(row.date)} names no card, so it is not counted on any.`;
}

const METHOD = (
  <>
    <p>
      Redeemed counts credits on this card whose description names a reward, a statement credit or a redemption, and
      deposits into a bank account whose description names this card&rsquo;s program. Rewards earned and not yet
      redeemed are not in the ledger and are not counted. The longer column starts at this card&rsquo;s first
      recorded row, so a deposit dated before it is not counted there.
    </p>
    <p>
      Fees are the issuer&rsquo;s own charges, read from a description that begins with the charge&rsquo;s name:
      annual, foreign transaction, late, interest, returned payment, cash advance or balance transfer. A
      merchant&rsquo;s or processor&rsquo;s fee, such as one whose description names the merchant first, is spend. Net is redeemed less fees.
      Spend is what Reports counts on this card, refunds netted, fees and redemptions left out, so a statement
      credit Reports nets as a refund is counted here once, as redeemed.
    </p>
  </>
);

interface CardReturnProps {
  card: CardReviewCard;
  trailingFrom: string;
  unattributed: readonly UnattributedRedemption[];
  today: string;
}

export function CardReturn({ card, trailingFrom, unattributed, today }: CardReturnProps) {
  const renewal = renewalLine(card, today);
  const notes = unattributed.filter((row) => row.same_institution_card_ids.includes(card.account_id));
  const sinceLabel = card.ledger_from ? `Since ${formatDate(card.ledger_from)}` : 'Recorded';
  return (
    <div className="mb-8">
      <SectionLabel underline className="mb-1.5" explain={METHOD}>
        What this card returned
      </SectionLabel>
      <table className="w-full text-body-lg tabular-nums">
        <thead>
          <tr className="text-note text-muted-2">
            <th className="py-1.5 text-left font-normal" />
            <th className="py-1.5 text-right font-normal" title={`From ${formatDate(trailingFrom)}`}>Last 12 months</th>
            <th className="py-1.5 text-right font-normal">{sinceLabel}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([field, label]) => (
            <tr key={field} className="border-b border-line last:border-0">
              <td className={`py-2 ${field === 'spend' ? 'text-muted' : 'text-ink'}`}>{label}</td>
              <td className={`py-2 text-right ${field === 'spend' ? 'text-muted' : 'text-ink'}`}>{formatCurrency(card.trailing_12[field])}</td>
              <td className={`py-2 text-right ${field === 'spend' ? 'text-muted' : 'text-ink'}`}>{formatCurrency(card.life[field])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {renewal && <p className="mt-2 text-note text-muted">{renewal}</p>}
      {notes.map((row) => (
        <p key={row.transaction_id} className="mt-2 text-note text-muted">{unattributedLine(row)}</p>
      ))}
    </div>
  );
}

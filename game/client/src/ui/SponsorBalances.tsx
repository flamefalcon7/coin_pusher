interface SponsorBalance {
  campaign_id: string;
  token_symbol: string;
  balance: string;
}

interface SponsorBalancesProps {
  balances: SponsorBalance[];
}

function fmtBalance(raw: string): string {
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }) : raw;
}

export function SponsorBalances({ balances }: SponsorBalancesProps) {
  if (balances.length === 0) return null;

  return (
    <div className="sponsor-balances">
      {balances.map((b) => (
        <div key={b.campaign_id} className="sponsor-balance-row">
          <span className="sponsor-balance-symbol">{b.token_symbol}</span>
          <span className="sponsor-balance-value">{fmtBalance(b.balance)}</span>
        </div>
      ))}
    </div>
  );
}

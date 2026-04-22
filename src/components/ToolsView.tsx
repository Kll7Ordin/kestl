interface Props {
  onOpenTool: (tool: 'mortgage') => void;
}

export function ToolsView({ onOpenTool }: Props) {
  return (
    <div className="view-root">
      <div className="section-title" style={{ marginBottom: '1rem' }}>Tools</div>
      <div
        className="card"
        style={{ cursor: 'pointer', maxWidth: 380 }}
        onClick={() => onOpenTool('mortgage')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>Mortgage Tool</div>
            <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>
              Track your mortgage balance, simulate payoff scenarios, and find mortgage payments in your transactions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

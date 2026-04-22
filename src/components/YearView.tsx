import { useState, useMemo, useRef, useSyncExternalStore, useEffect } from 'react';
import { getData, subscribe, CATEGORY_PALETTE } from '../db';
import { INCOME_CATEGORY_NAMES } from '../seed';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  DoughnutController,
  Filler,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Doughnut } from 'react-chartjs-2';
import { formatAmount } from '../utils/format';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, DoughnutController, Filler, Title, Tooltip, Legend);

function mostRecentCompletedMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, '0')}`
  );
}

interface MonthData {
  month: string;
  planned: number;
  actual: number;
  income: number;
  savings: number; // Occasional group spending
}

interface YearNavFilter {
  categoryId?: number;
  groupId?: number;
  scope?: 'overall' | 'categories' | 'groups';
}

interface YearViewProps {
  navFilter?: YearNavFilter | null;
  onNavConsumed?: () => void;
  darkMode?: boolean;
}

export function YearView({ navFilter, onNavConsumed, darkMode = false }: YearViewProps) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [selectedCats, setSelectedCats] = useState<number[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<number[]>([]);
  const [scope, setScope] = useState<'overall' | 'categories' | 'groups'>('overall');
  const [showTable, setShowTable] = useState(false);
  const [pieScope, setPieScope] = useState<'ytd' | 'month'>('ytd');
  const [piePeriod, setPiePeriod] = useState<string>(mostRecentCompletedMonth);
  const [pieGrouping, setPieGrouping] = useState<'group' | 'category'>('group');
  const chartRef = useRef(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const appData = useSyncExternalStore(subscribe, getData);
  const categories = appData.categories;
  const navFilterApplied = useRef(false);

  // Apply nav filter from external navigation (e.g. clicking chart icon in Budget view)
  useEffect(() => {
    if (navFilter && !navFilterApplied.current) {
      navFilterApplied.current = true;
      if (navFilter.scope) setScope(navFilter.scope);
      if (navFilter.categoryId != null) { setSelectedCats([navFilter.categoryId]); setSelectedGroups([]); }
      if (navFilter.groupId != null) { setSelectedGroups([navFilter.groupId]); setSelectedCats([]); }
      onNavConsumed?.();
      // Scroll to line chart after React re-renders with new category selection
      setTimeout(() => {
        const el = chartContainerRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          const scrollTop = window.scrollY + rect.top - 70;
          window.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
        }
      }, 500);
    }
    if (!navFilter) navFilterApplied.current = false;
  }, [navFilter, onNavConsumed]);

  const data: MonthData[] = useMemo(() => {
    const { budgets: allBudgets, transactions: allTxns, transactionSplits: allSplits } = appData;
    const months = monthsOfYear(year);

    const splitsByTxn = new Map<number, typeof allSplits>();
    for (const s of allSplits) {
      const arr = splitsByTxn.get(s.transactionId) ?? [];
      arr.push(s);
      splitsByTxn.set(s.transactionId, arr);
    }

    const filterCats =
      scope === 'categories' && selectedCats.length > 0 ? new Set(selectedCats) :
      scope === 'groups' && selectedGroups.length > 0 ? new Set(allBudgets.filter((b) => selectedGroups.includes(b.groupId ?? -1)).map((b) => b.categoryId)) :
      null;

    // Income categories
    const incomeCatIds = new Set(
      categories
        .filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name))
        .map((c) => c.id),
    );

    // Occasional group categories (Savings spending — excluded from regular Actual)
    const spendFromSavingsGroupIds = new Set(
      (appData.budgetGroups ?? [])
        .filter((g) => g.spendFromSavings || g.name === 'Occasional')
        .map((g) => g.id)
    );
    const occasionalCatIds = new Set(
      allBudgets.filter((b) => b.groupId != null && spendFromSavingsGroupIds.has(b.groupId)).map((b) => b.categoryId)
    );

    return months.map((m) => {
      const mBudgets = allBudgets.filter((b) =>
        b.month === m && (!filterCats || filterCats.has(b.categoryId))
      );
      const budgetedExpenseCatIds = new Set(
        mBudgets.filter((b) => !incomeCatIds.has(b.categoryId)).map((b) => b.categoryId)
      );
      // Planned excludes Occasional (savings spending) so variance reflects regular budget
      const planned = mBudgets
        .filter((b) => !incomeCatIds.has(b.categoryId) && !occasionalCatIds.has(b.categoryId))
        .reduce((s, b) => s + b.targetAmount, 0);

      let actual = 0;
      let income = 0;
      let savings = 0;
      for (const t of allTxns) {
        const splits = splitsByTxn.get(t.id);
        if (splits && splits.length > 0) {
          for (const s of splits) {
            const effectiveDate = s.txnDate ?? t.txnDate;
            if (!effectiveDate.startsWith(m)) continue;
            if (incomeCatIds.has(s.categoryId)) {
              if (t.ignoreInBudget) income += s.amount;
            } else if (budgetedExpenseCatIds.has(s.categoryId)) {
              if (occasionalCatIds.has(s.categoryId)) {
                if (!t.ignoreInBudget) savings += s.amount;
              } else if (!t.ignoreInBudget) {
                actual += s.amount;
              }
            }
          }
        } else if (t.categoryId) {
          if (!t.txnDate.startsWith(m)) continue;
          if (incomeCatIds.has(t.categoryId)) {
            if (t.ignoreInBudget) income += t.amount;
          } else if (budgetedExpenseCatIds.has(t.categoryId)) {
            if (occasionalCatIds.has(t.categoryId)) {
              if (!t.ignoreInBudget) savings += t.amount;
            } else if (!t.ignoreInBudget) {
              actual += t.amount;
            }
          }
        }
      }

      return { month: m, planned, actual, income, savings };
    });
  }, [appData, year, scope, selectedCats, selectedGroups]);

  const monthLabels = data.map((d) => {
    const [yr, mo] = d.month.split('-').map(Number);
    const abbr = new Date(yr, mo - 1, 1).toLocaleString('en-CA', { month: 'short' });
    // Show year on first month of year or first data point
    return `${abbr} ${yr}`;
  });

  const todayMonth = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const isCompleted = (m: string) => m < todayMonth;

  // Determine if selected cats are savings (occasional) categories
  const spendFromSavingsGroupIds2 = new Set(
    (appData.budgetGroups ?? [])
      .filter((g) => g.spendFromSavings || g.name === 'Occasional')
      .map((g) => g.id)
  );
  const occasionalCatIds2 = new Set(
    appData.budgets.filter((b) => b.groupId != null && spendFromSavingsGroupIds2.has(b.groupId)).map((b) => b.categoryId)
  );
  const categoryFilterActive = (scope === 'categories' && selectedCats.length > 0) || (scope === 'groups' && selectedGroups.length > 0);
  const selectedAreSavings = categoryFilterActive && selectedCats.every((id) => occasionalCatIds2.has(id));
  const selectedIncludeSavings = categoryFilterActive && selectedCats.some((id) => occasionalCatIds2.has(id));

  // Last month with actual data
  const lastDataIdx = data.reduce((best, d, i) => (isCompleted(d.month) && d.actual > 0 ? i : best), -1);

  // Cap planned: only show through the last month with actual data
  const cappedPlanned = data.map((d, i) => {
    if (i > lastDataIdx) return null;
    return d.planned;
  });

  const pieChartData = useMemo(() => {
    const { budgets: allBudgets, transactions: allTxns, transactionSplits: allSplits, budgetGroups } = appData;

    const months = pieScope === 'ytd'
      ? monthsOfYear(year).filter((m) => m < todayMonth)
      : [piePeriod];
    const monthSet = new Set(months);
    if (monthSet.size === 0) return { labels: [] as string[], values: [] as number[], colors: [] as string[] };

    const incomeCatIds = new Set(
      categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id),
    );

    const splitsByTxn = new Map<number, typeof allSplits>();
    for (const s of allSplits) {
      const arr = splitsByTxn.get(s.transactionId) ?? [];
      arr.push(s);
      splitsByTxn.set(s.transactionId, arr);
    }

    const spendByCat = new Map<number, number>();
    for (const t of allTxns) {
      if (t.ignoreInBudget) continue;
      const splits = splitsByTxn.get(t.id);
      if (splits && splits.length > 0) {
        for (const s of splits) {
          const effectiveDate = s.txnDate ?? t.txnDate;
          if (!monthSet.has(effectiveDate.slice(0, 7))) continue;
          if (incomeCatIds.has(s.categoryId)) continue;
          spendByCat.set(s.categoryId, (spendByCat.get(s.categoryId) ?? 0) + s.amount);
        }
      } else if (t.categoryId) {
        if (!monthSet.has(t.txnDate.slice(0, 7))) continue;
        if (incomeCatIds.has(t.categoryId)) continue;
        spendByCat.set(t.categoryId, (spendByCat.get(t.categoryId) ?? 0) + t.amount);
      }
    }

    // Restrict to categories that appear in the most recent completed month's budget
    const recentMonth = monthsOfYear(year).filter((m) => m < todayMonth).at(-1);
    const budgetedCatIds = recentMonth
      ? new Set(allBudgets.filter((b) => b.month === recentMonth).map((b) => b.categoryId))
      : null;
    if (budgetedCatIds) {
      for (const catId of [...spendByCat.keys()]) {
        if (!budgetedCatIds.has(catId)) spendByCat.delete(catId);
      }
    }

    // Exclude categories belonging to spendFromSavings groups
    const spendFromSavingsGroupIds = new Set(
      (budgetGroups ?? []).filter((g: any) => g.spendFromSavings).map((g: any) => g.id),
    );
    if (spendFromSavingsGroupIds.size > 0) {
      const catGroupMap = new Map<number, number | null>();
      for (const b of allBudgets) {
        if (!catGroupMap.has(b.categoryId)) catGroupMap.set(b.categoryId, b.groupId ?? null);
      }
      for (const catId of [...spendByCat.keys()]) {
        const groupId = catGroupMap.get(catId);
        if (groupId != null && spendFromSavingsGroupIds.has(groupId)) spendByCat.delete(catId);
      }
    }

    if (pieGrouping === 'category') {
      const entries = [...spendByCat.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      return {
        labels: entries.map(([catId]) => categories.find((c) => c.id === catId)?.name ?? '?'),
        values: entries.map(([, v]) => v),
        colors: entries.map(([catId], i) => categories.find((c) => c.id === catId)?.color ?? CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]),
      };
    } else {
      const groupIdToName = new Map<number, string>((budgetGroups ?? []).map((g: { id: number; name: string }) => [g.id, g.name]));
      const catToGroup = new Map<number, number | null>();
      // Track first category color per group for consistent group colors
      const groupColor = new Map<number, string>();
      for (const b of allBudgets) {
        if (!catToGroup.has(b.categoryId)) catToGroup.set(b.categoryId, b.groupId ?? null);
        if (b.groupId != null && !groupColor.has(b.groupId)) {
          const cat = categories.find((c) => c.id === b.categoryId);
          if (cat?.color) groupColor.set(b.groupId, cat.color);
        }
      }
      const spendByGroup = new Map<string, { amount: number; color: string; groupId: number | null }>();
      for (const [catId, amount] of spendByCat) {
        const groupId = catToGroup.get(catId) ?? null;
        const groupName = groupId != null ? (groupIdToName.get(groupId) ?? 'Ungrouped') : 'Ungrouped';
        const color = groupId != null ? (groupColor.get(groupId) ?? '#888') : '#888';
        const existing = spendByGroup.get(groupName);
        if (existing) existing.amount += amount;
        else spendByGroup.set(groupName, { amount, color, groupId });
      }
      const entries = [...spendByGroup.entries()]
        .filter(([, v]) => v.amount > 0)
        .sort((a, b) => b[1].amount - a[1].amount);
      return {
        labels: entries.map(([name]) => name),
        values: entries.map(([, v]) => v.amount),
        colors: entries.map(([, v]) => v.color),
      };
    }
  }, [appData, year, pieScope, piePeriod, pieGrouping, categories, todayMonth]);

  // Doughnut slice labels — drawn on slices large enough to fit text
  const DONUT_LABEL_MIN_PCT = 0.05;
  const doughnutLabelsPlugin = useMemo(() => {
    function wrapLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
      if (ctx.measureText(text).width <= maxWidth) return [text];
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) lines.push(current);
      return lines.slice(0, 2);
    }

    function drawTextWithOutline(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }

    return {
      id: 'doughnutLabels',
      afterDatasetsDraw(chart: any) {
        const ctx: CanvasRenderingContext2D = chart.ctx;
        const dataset = chart.data.datasets[0];
        const meta = chart.getDatasetMeta(0);
        const total = (dataset.data as number[]).reduce((s: number, v: number) => s + v, 0);
        if (total === 0) return;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';

        meta.data.forEach((arc: any, i: number) => {
          const val = dataset.data[i] as number;
          const pct = val / total;
          if (pct < DONUT_LABEL_MIN_PCT) return;

          const midAngle = arc.startAngle + (arc.endAngle - arc.startAngle) / 2;
          const midRadius = arc.innerRadius + (arc.outerRadius - arc.innerRadius) * 0.5;
          const x = arc.x + Math.cos(midAngle) * midRadius;
          const y = arc.y + Math.sin(midAngle) * midRadius;

          const rawLabel = (chart.data.labels as string[])[i] ?? '';
          const pctText = `${Math.round(pct * 100)}%`;
          const maxLabelWidth = (arc.outerRadius - arc.innerRadius) * 1.1;

          ctx.font = `600 13px system-ui, sans-serif`;
          const lines = wrapLabel(ctx, rawLabel, maxLabelWidth);
          const lineH = 15;
          const totalH = lines.length * lineH + 14; // 14 for pct line gap
          const startY = y - totalH / 2 + lineH / 2;

          lines.forEach((line, li) => {
            drawTextWithOutline(ctx, line, x, startY + li * lineH);
          });
          ctx.font = `11px system-ui, sans-serif`;
          drawTextWithOutline(ctx, pctText, x, startY + lines.length * lineH + 2);
        });

        ctx.restore();
      },
    };
  }, []);

  // Vertical boundary plugin for Chart.js
  const verticalBoundaryPlugin = {
    id: 'verticalBoundary',
    afterDraw(chart: { ctx: CanvasRenderingContext2D; scales: { x: { getPixelForValue: (v: number) => number }; chartArea: { top: number; bottom: number } }; chartArea: { top: number; bottom: number } }) {
      if (lastDataIdx < 0) return;
      const ctx = chart.ctx;
      const xScale = chart.scales['x'] as { getPixelForValue: (v: number) => number };
      const chartArea = chart.chartArea;
      // Draw at the gap between last data month and next
      const xLeft = xScale.getPixelForValue(lastDataIdx);
      const xRight = xScale.getPixelForValue(lastDataIdx + 1);
      const x = (xLeft + xRight) / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(100,100,100,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const lineDataset = (label: string, color: string, rgbFill: string, values: (number | null)[]) => ({
    label,
    data: values,
    borderColor: color,
    backgroundColor: `rgba(${rgbFill},0.12)`,
    tension: 0.35,
    spanGaps: false,
    borderWidth: 2.5,
    fill: true,
    pointRadius: 4,
    pointHoverRadius: 6,
  });

  const chartData = {
    labels: monthLabels,
    datasets: selectedAreSavings
      ? [lineDataset('Spent from Savings', '#d97706', '217,119,6', data.map((d) => isCompleted(d.month) ? d.savings : null))]
      : [
          lineDataset('Planned', '#3b82f6', '59,130,246', cappedPlanned),
          lineDataset('Actual', '#ef4444', '239,68,68', data.map((d) => isCompleted(d.month) ? d.actual : null)),
          ...(!categoryFilterActive || selectedIncludeSavings
            ? [lineDataset('Spent from Savings', '#d97706', '217,119,6', data.map((d) => isCompleted(d.month) ? d.savings : null))]
            : []),
          ...(scope === 'overall'
            ? [lineDataset('Income', '#16a34a', '22,163,74', data.map((d) => isCompleted(d.month) ? d.income : null))]
            : []),
        ],
  };

  function toggleCat(id: number) {
    setSelectedCats((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  }

  function toggleGroup(id: number) {
    setSelectedGroups((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  }

  return (
    <div>
      <h1 className="view-title">Year View</h1>

      <div className="month-nav">
        <button className="btn btn-ghost btn-sm" onClick={() => setYear((y) => y - 1)}>&lt;</button>
        <span style={{ fontWeight: 700 }}>{year}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setYear((y) => y + 1)}>&gt;</button>
      </div>

      {/* ── Spending Trends (line chart) — always visible ── */}
      <div className="section-title">Spending Trends</div>

      <div className="row" style={{ marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <button className={`btn btn-sm ${scope === 'overall' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScope('overall')}>Overall</button>
        <button className={`btn btn-sm ${scope === 'groups' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScope('groups')}>By Group</button>
        <button className={`btn btn-sm ${scope === 'categories' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScope('categories')}>By Category</button>
      </div>

      {scope === 'groups' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
          {[...(appData.budgetGroups ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((g) => (
            <button key={g.id} className={`btn btn-sm ${selectedGroups.includes(g.id) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleGroup(g.id)}>{g.name}</button>
          ))}
        </div>
      )}

      {scope === 'categories' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
          {[...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
            <button key={c.id} className={`btn btn-sm ${selectedCats.includes(c.id) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleCat(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      <div className="card" ref={chartContainerRef}>
        <div className="chart-container">
          <Line
            ref={chartRef}
            data={chartData}
            plugins={[verticalBoundaryPlugin] as unknown as Parameters<typeof Line>[0]['plugins'] extends (infer P)[] | undefined ? P[] : never}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              scales: {
                y: {
                  beginAtZero: true,
                  ticks: { color: darkMode ? '#b0bdd0' : '#555', font: { size: 14 }, callback: (v: any) => `$${formatAmount(v, 0)}` },
                  grid: { color: darkMode ? 'rgba(255,255,255,0.08)' : '#e5e7eb' },
                },
                x: {
                  ticks: { color: darkMode ? '#b0bdd0' : '#555', font: { size: 14 }, maxRotation: 45 },
                  grid: { color: darkMode ? 'rgba(255,255,255,0.08)' : '#e5e7eb' },
                },
              },
              plugins: {
                legend: {
                  labels: { color: darkMode ? '#e8ecf4' : '#1a2332', font: { size: 14 }, padding: 20 },
                },
                tooltip: {
                  mode: 'index',
                  intersect: false,
                  backgroundColor: darkMode ? '#1a1d27' : '#fff',
                  titleColor: darkMode ? '#e8ecf4' : '#1a2332',
                  bodyColor: darkMode ? '#b0bdd0' : '#4a5568',
                  borderColor: darkMode ? '#2e3347' : '#d0d5dd',
                  borderWidth: 1,
                  padding: 10,
                  callbacks: {
                    label: (ctx) => ` ${ctx.dataset.label}: $${formatAmount(ctx.parsed.y ?? 0, 0)}`,
                  },
                },
              },
            }}
          />
        </div>
      </div>

      {/* ── Monthly table — hidden by default, togglable ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
        <div className="section-title" style={{ margin: 0 }}>Monthly Summary</div>
        <button className="btn btn-sm btn-ghost" onClick={() => setShowTable(v => !v)}>
          {showTable ? 'Hide table' : 'Show table'}
        </button>
      </div>

      {showTable && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Income</th>
                <th className="num">Planned</th>
                <th className="num">Actual</th>
                <th className="num">Variance</th>
                <th className="num">Spent from Savings</th>
              </tr>
            </thead>
            <tbody>
              {data.filter((d) => d.planned > 0 || d.actual > 0 || d.income > 0 || d.savings > 0 || d.month === todayMonth).map((d, i) => {
                const completed = isCompleted(d.month);
                const v = d.planned - d.actual;
                const [yr, mo] = d.month.split('-').map(Number);
                const monthAbbr = new Date(yr, mo - 1, 1).toLocaleString('en-CA', { month: 'short' });
                return (
                  <tr key={d.month} className={i % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'} style={!completed ? { color: 'var(--text-3)' } : undefined}>
                    <td>{monthAbbr} {yr}</td>
                    <td className="num positive" style={{ fontWeight: 'normal' }}>{completed && d.income > 0 ? `$${formatAmount(d.income, 0)}` : '—'}</td>
                    <td className="num" style={{ fontWeight: 'normal' }}>${formatAmount(d.planned, 0)}</td>
                    <td className="num" style={{ fontWeight: 'normal' }}>{completed ? `$${formatAmount(d.actual, 0)}` : '—'}</td>
                    <td className={`num ${completed ? (v >= 0 ? 'positive' : 'negative') : ''}`} style={{ fontWeight: 'normal' }}>{completed ? `$${formatAmount(v, 0)}` : '—'}</td>
                    <td className="num" style={{ color: completed ? 'var(--yellow)' : undefined, fontWeight: 'normal' }}>{completed && d.savings > 0 ? `$${formatAmount(d.savings, 0)}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Spending Breakdown (donut) — always visible ── */}
      <div className="section-title" style={{ marginTop: '1.5rem' }}>Spending Breakdown</div>

      <div className="row" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button className={`btn btn-sm ${pieScope === 'ytd' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPieScope('ytd')}>YTD</button>
          <button className={`btn btn-sm ${pieScope === 'month' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPieScope('month')}>Month</button>
        </div>
        {pieScope === 'month' && (
          <select value={piePeriod} onChange={(e) => setPiePeriod(e.target.value)} style={{ fontSize: '0.85rem', padding: '0.2rem 0.4rem' }}>
            {monthsOfYear(year).filter((m) => m < todayMonth).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button className={`btn btn-sm ${pieGrouping === 'group' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPieGrouping('group')}>By Group</button>
          <button className={`btn btn-sm ${pieGrouping === 'category' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPieGrouping('category')}>By Category</button>
        </div>
      </div>

      {pieChartData.labels.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', opacity: 0.5, padding: '2rem' }}>
          No spending data for this period.
        </div>
      ) : (
        <div className="card">
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 680, height: 680, flexShrink: 0, position: 'relative' }}>
              <Doughnut
                data={{
                  labels: pieChartData.labels,
                  datasets: [{
                    data: pieChartData.values,
                    backgroundColor: pieChartData.colors,
                    borderWidth: 2,
                    borderColor: darkMode ? '#1a1d27' : '#fff',
                    hoverOffset: 8,
                    borderRadius: 4,
                    spacing: 2,
                  }],
                }}
                plugins={[doughnutLabelsPlugin] as any}
                options={{
                  responsive: true,
                  maintainAspectRatio: true,
                  cutout: '62%',
                  layout: { padding: 32 },
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      backgroundColor: darkMode ? '#252836' : '#fff',
                      titleColor: darkMode ? '#e8ecf4' : '#1a2332',
                      bodyColor: darkMode ? '#b0bdd0' : '#4a5568',
                      borderColor: darkMode ? '#2e3347' : '#e5e7eb',
                      borderWidth: 1,
                      padding: 12,
                      cornerRadius: 8,
                      callbacks: {
                        label: (ctx) => {
                          const total = (ctx.dataset.data as number[]).reduce((s, v) => s + v, 0);
                          const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
                          return ` $${formatAmount(ctx.parsed, 0)} (${pct}%)`;
                        },
                      },
                    },
                  },
                }}
              />
              {/* Center total label */}
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ fontSize: '0.85rem', opacity: 0.55, marginBottom: 4 }}>Total</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>${formatAmount(pieChartData.values.reduce((s, v) => s + v, 0), 0)}</div>
              </div>
            </div>
            {/* Side legend — only slices too small to label on the chart */}
            {(() => {
              const total = pieChartData.values.reduce((s, v) => s + v, 0);
              const smallSlices = pieChartData.labels
                .map((label, i) => ({ label, i, pct: total > 0 ? pieChartData.values[i] / total : 0 }))
                .filter(({ pct }) => pct < DONUT_LABEL_MIN_PCT);
              if (smallSlices.length === 0) return null;
              return (
                <div style={{ minWidth: 220, maxWidth: 360, alignSelf: 'center' }}>
                  <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Other</div>
                  {smallSlices.map(({ label, i, pct }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.3rem 0', fontSize: '13px', borderBottom: '1px solid var(--border-2)' }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: pieChartData.colors?.[i] ?? '#888', flexShrink: 0, marginTop: 2 }} />
                      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>{label}</span>
                      <span style={{ opacity: 0.55, fontSize: '11px', whiteSpace: 'nowrap' }}>{Math.round(pct * 100)}%</span>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', minWidth: 55, textAlign: 'right' }}>${formatAmount(pieChartData.values[i], 0)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

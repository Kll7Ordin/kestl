import { useState, useEffect, useRef, type ReactNode } from 'react';
import { flushSync, createPortal } from 'react-dom';
import { type ColorThresholds } from '../db';
import { formatAmount } from '../utils/format';
import { formatDiff, budgetDiffColor } from '../utils/budgetFormat';
import { type BudgetRow, type TargetMode } from '../logic/budgetRows';

/** A live budget group or a sandbox group — the table treats them the same. */
export interface BudgetTableGroup {
  id: number;
  name: string;
  sortOrder: number;
  note?: string;
  spendFromSavings?: boolean;
}

function groupRows(rows: BudgetRow[], groups: BudgetTableGroup[]): { group: BudgetTableGroup | null; rows: BudgetRow[] }[] {
  const ungrouped = rows.filter((r) => !r.groupId).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const byGroup = new Map<number, BudgetRow[]>();
  for (const r of rows) {
    if (r.groupId != null) {
      const arr = byGroup.get(r.groupId) ?? [];
      arr.push(r);
      byGroup.set(r.groupId, arr);
    }
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const result: { group: BudgetTableGroup | null; rows: BudgetRow[] }[] = [];
  for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    result.push({ group: g, rows: byGroup.get(g.id) ?? [] });
  }
  result.push({ group: null, rows: ungrouped });
  return result;
}

const DragDots = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{ display: 'block', opacity: 0.4, pointerEvents: 'none' }}>
    {([2, 7, 12] as number[]).map((cy) => ([1, 6] as number[]).map((cx) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.4} />
    )))}
  </svg>
);

const COLS = 8;

interface BudgetTableProps {
  /** Expense rows only. */
  rows: BudgetRow[];
  groups: BudgetTableGroup[];
  colorThresholds: ColorThresholds;
  ytdMode: 'ytd' | 'rolling12';
  onYtdModeChange: (m: 'ytd' | 'rolling12') => void;
  ytdColumnsVisible: boolean;
  onYtdColumnsVisibleChange: (v: boolean) => void;
  /** Omit onTargetModeChange to hide the toggle (e.g. a sandbox, which only has one target). */
  targetMode?: TargetMode;
  onTargetModeChange?: (m: TargetMode) => void;
  /** Shown inside the Expenses card, above its title (e.g. copy buttons when empty). */
  aboveTable?: ReactNode;
  /** Shown between the Total card and the Expenses card. */
  betweenTotalAndTable?: ReactNode;
  /** Each change is one group's full new order; a cross-group move sends two. */
  onReorder: (changes: { groupId: number | null; categoryIds: number[] }[]) => void;
  onReorderGroups: (groupIdsInOrder: number[]) => void;
  onSaveTarget: (categoryId: number, amount: number, pastMonthsToo: boolean) => void;
  /** Show the "Past months too" checkbox when editing a target. */
  allowPastMonths?: boolean;
  onDeleteRow: (categoryId: number) => void;
  onRenameRow: (categoryId: number, name: string) => void;
  onSaveGroup: (groupId: number, patch: { name: string; spendFromSavings: boolean }) => void;
  onDeleteGroup: (groupId: number) => void;
  onGroupNote: (groupId: number, note: string | undefined) => void;
  /** Category description (🏷). Omit to hide. */
  onCategoryNote?: (categoryId: number, note: string) => void;
  /** Per-line note (📌). */
  onLineNote: (categoryId: number, note: string) => void;
  lineNoteLabel?: string;
  onOpenRow?: (categoryId: number) => void;
  onOpenAll?: () => void;
  onRowTrend?: (categoryId: number) => void;
  onGroupTrend?: (groupId: number) => void;
  /** Extra controls after a row's icons (e.g. the sandbox's tag button). */
  renderRowExtras?: (row: BudgetRow) => ReactNode;
}

export function BudgetTable(props: BudgetTableProps) {
  const {
    rows, groups, colorThresholds, ytdMode, ytdColumnsVisible, targetMode,
    onOpenRow, onOpenAll, allowPastMonths, lineNoteLabel = 'This month',
  } = props;

  // Row inline editing
  const [editId, setEditId] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState('');
  const [editPastMonths, setEditPastMonths] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editNoteId, setEditNoteId] = useState<number | null>(null);
  const [editNoteText, setEditNoteText] = useState('');
  const [editLineNoteId, setEditLineNoteId] = useState<number | null>(null);
  const [editLineNoteText, setEditLineNoteText] = useState('');
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameName, setRenameName] = useState('');

  // Group editing
  const [editGroupNoteId, setEditGroupNoteId] = useState<number | null>(null);
  const [editGroupNoteText, setEditGroupNoteText] = useState('');
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<number | null>(null);
  const [groupSettingsId, setGroupSettingsId] = useState<number | null>(null);
  const [groupSettingsName, setGroupSettingsName] = useState('');
  const [groupSettingsSavings, setGroupSettingsSavings] = useState(false);

  // Item drag state — uses direct DOM for transforms during drag (no re-renders)
  const _moveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const _upRef = useRef<((e: MouseEvent) => void) | null>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const budgetTableRef = useRef<HTMLTableElement>(null);
  const ghostElRef = useRef<HTMLDivElement>(null);
  const dragInfoRef = useRef<{
    catId: number;
    sourceGroupId: number | null;
    sourceIdx: number;
    hoverIdx: number;
    flatPositions: { catId: number; groupId: number | null; el: HTMLElement; centerY: number }[];
    rowEl: HTMLElement;
    rowHeight: number;
    zoom: number;
  } | null>(null);
  const [dragCatId, setDragCatId] = useState<number | null>(null);
  const [ghostInfo, setGhostInfo] = useState<{ label: string; target: number; spent: number } | null>(null);

  // Group drag state
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const dragGroupIdRef = useRef<number | null>(null);
  const _groupMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const _groupUpRef = useRef<((e: MouseEvent) => void) | null>(null);
  const [groupGhostLabel, setGroupGhostLabel] = useState<string | null>(null);
  const groupGhostElRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (_moveRef.current) document.removeEventListener('mousemove', _moveRef.current);
    if (_upRef.current) document.removeEventListener('mouseup', _upRef.current);
    if (_groupMoveRef.current) document.removeEventListener('mousemove', _groupMoveRef.current);
    if (_groupUpRef.current) document.removeEventListener('mouseup', _groupUpRef.current);
  }, []);

  // Keep --bar-max-overflow in sync with column positions
  const [barCapInfo, setBarCapInfo] = useState({ overflow: 600, catWidth: 400 });
  const ytdColumnsVisibleRef = useRef(ytdColumnsVisible);
  ytdColumnsVisibleRef.current = ytdColumnsVisible;
  useEffect(() => {
    function measure() {
      const table = budgetTableRef.current;
      if (!table) return;
      const catTh = table.querySelector('th[data-col="category"]') as HTMLElement | null;
      const avgTh = table.querySelector('th[data-col="avg"]') as HTMLElement | null;
      const ytdTh = table.querySelector('th[data-col="ytd"]') as HTMLElement | null;
      const ytdDiffTh = table.querySelector('th[data-col="ytd-diff"]') as HTMLElement | null;
      if (!catTh) return;
      const catRect = catTh.getBoundingClientRect();
      let midpoint: number;
      if (!ytdColumnsVisibleRef.current && ytdDiffTh) {
        // Columns hidden — bar can extend through the empty YTD space
        midpoint = ytdDiffTh.getBoundingClientRect().right - 4;
      } else if (avgTh && ytdTh) {
        // Columns visible — anchor to gap between Avg and YTD
        const avgRect = avgTh.getBoundingClientRect();
        const ytdRect = ytdTh.getBoundingClientRect();
        midpoint = (avgRect.right + ytdRect.left) / 2;
      } else {
        midpoint = catRect.right + 32;
      }
      const overflow = Math.max(0, midpoint - catRect.right + 18);
      table.style.setProperty('--bar-max-overflow', `${overflow}px`);
      setBarCapInfo({ overflow, catWidth: catRect.width });
    }
    measure();
    const ro = new ResizeObserver(measure);
    if (budgetTableRef.current) ro.observe(budgetTableRef.current);
    return () => ro.disconnect();
  }, [ytdColumnsVisible, rows.length]);

  function handleDrop(draggedCategoryId: number, targetGroupId: number | null, beforeCategoryId: number | null) {
    const draggedRow = rows.find((r) => r.categoryId === draggedCategoryId);
    if (!draggedRow) return;
    // Sort by sortOrder to match display order — critical for correct insertion
    const bySortOrder = (a: BudgetRow, b: BudgetRow) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    const rowsIn = (gid: number | null) => (gid == null ? rows.filter((r) => !r.groupId) : rows.filter((r) => r.groupId === gid)).sort(bySortOrder);
    const targetIds = rowsIn(targetGroupId).map((r) => r.categoryId);
    const oldGroupId = draggedRow.groupId ?? null;
    if (oldGroupId === targetGroupId) {
      const without = targetIds.filter((id) => id !== draggedCategoryId);
      const insertIdx = beforeCategoryId == null ? without.length : without.indexOf(beforeCategoryId);
      if (insertIdx < 0) return;
      props.onReorder([{ groupId: targetGroupId, categoryIds: [...without.slice(0, insertIdx), draggedCategoryId, ...without.slice(insertIdx)] }]);
    } else {
      const oldOrder = rowsIn(oldGroupId).map((r) => r.categoryId).filter((id) => id !== draggedCategoryId);
      const insertIdx = beforeCategoryId == null ? targetIds.length : targetIds.indexOf(beforeCategoryId);
      const safeIdx = insertIdx < 0 ? targetIds.length : insertIdx;
      props.onReorder([
        { groupId: oldGroupId, categoryIds: oldOrder },
        { groupId: targetGroupId, categoryIds: [...targetIds.slice(0, safeIdx), draggedCategoryId, ...targetIds.slice(safeIdx)] },
      ]);
    }
  }

  function startRowDrag(e: React.MouseEvent, row: BudgetRow, groupId: number | null) {
    e.preventDefault();
    e.stopPropagation();
    if (_moveRef.current) document.removeEventListener('mousemove', _moveRef.current);
    if (_upRef.current) document.removeEventListener('mouseup', _upRef.current);

    const rowEl = (e.currentTarget as HTMLElement).closest('tr') as HTMLElement;
    const rowRect = rowEl.getBoundingClientRect();
    const tableEl = tableBodyRef.current!;

    // Detect CSS zoom for transform calculations (transforms are in pre-zoom space)
    const appEl = rowEl.closest('.app') as HTMLElement | null;
    const zoom = appEl ? parseFloat(appEl.style.zoom || '1') : 1;

    // Capture positions of all category rows at drag start
    const allCatRows = Array.from(tableEl.querySelectorAll('tr[data-catid]')) as HTMLElement[];
    const flatPositions = allCatRows.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        catId: Number(el.dataset.catid),
        groupId: el.dataset.groupid === 'null' ? null : Number(el.dataset.groupid),
        el,
        centerY: rect.top + rect.height / 2,
      };
    });
    const sourceIdx = flatPositions.findIndex((p) => p.catId === row.categoryId);

    dragInfoRef.current = {
      catId: row.categoryId, sourceGroupId: groupId,
      sourceIdx, hoverIdx: sourceIdx,
      flatPositions, rowEl, rowHeight: rowRect.height, zoom,
    };

    // Prepare rows for animation
    allCatRows.forEach((el) => {
      if (el !== rowEl) {
        el.style.transition = 'transform 150ms cubic-bezier(0.25, 0.1, 0.25, 1)';
        el.style.willChange = 'transform';
      }
    });

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    // Use flushSync so the ghost DOM element exists immediately (no lag on first frame)
    flushSync(() => {
      setDragCatId(row.categoryId);
      setGhostInfo({ label: row.categoryName, target: row.target, spent: row.spent });
    });

    _moveRef.current = (me: MouseEvent) => {
      const dd = dragInfoRef.current;
      if (!dd) return;

      // Position ghost at cursor (portaled to body, outside zoom — use native coords directly)
      if (ghostElRef.current) {
        ghostElRef.current.style.left = `${me.clientX + 12}px`;
        ghostElRef.current.style.top = `${me.clientY - 18}px`;
      }

      // Compute hover index — centerY is in zoom-local coords, me.clientY is viewport
      const ghostCenterY = me.clientY / dd.zoom;
      let hoverIdx = dd.sourceIdx;
      for (let i = 0; i < dd.flatPositions.length; i++) {
        const pos = dd.flatPositions[i];
        const prevCY = i > 0 ? dd.flatPositions[i - 1].centerY : -Infinity;
        const nextCY = i < dd.flatPositions.length - 1 ? dd.flatPositions[i + 1].centerY : Infinity;
        if (ghostCenterY >= (prevCY + pos.centerY) / 2 && ghostCenterY < (pos.centerY + nextCY) / 2) {
          hoverIdx = i;
          break;
        }
      }

      if (hoverIdx !== dd.hoverIdx) {
        dd.hoverIdx = hoverIdx;
        const shiftPx = dd.rowHeight;
        for (let i = 0; i < dd.flatPositions.length; i++) {
          if (i === dd.sourceIdx) continue;
          let ty = 0;
          if (hoverIdx > dd.sourceIdx && i > dd.sourceIdx && i <= hoverIdx) ty = -shiftPx;
          else if (hoverIdx < dd.sourceIdx && i >= hoverIdx && i < dd.sourceIdx) ty = shiftPx;
          dd.flatPositions[i].el.style.transform = ty ? `translateY(${ty}px)` : '';
        }
      }
    };

    _upRef.current = () => {
      document.removeEventListener('mousemove', _moveRef.current!);
      document.removeEventListener('mouseup', _upRef.current!);
      _moveRef.current = null; _upRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';

      const dd = dragInfoRef.current;
      if (dd) {
        dd.flatPositions.forEach((p) => { p.el.style.transform = ''; p.el.style.transition = ''; p.el.style.willChange = ''; });
        const hoverIdx = dd.hoverIdx;
        if (hoverIdx !== dd.sourceIdx) {
          const targetGroupId = dd.flatPositions[hoverIdx].groupId;
          const isCrossGroup = targetGroupId !== dd.sourceGroupId;
          let beforeCatId: number | null;
          if (hoverIdx > dd.sourceIdx) {
            if (isCrossGroup) {
              // Cross-group: insert AT the hovered row's position in the target group
              beforeCatId = dd.flatPositions[hoverIdx].catId;
            } else {
              // Same-group: insert after hovered position (before the next row in same group)
              let next: number | null = null;
              for (let i = hoverIdx + 1; i < dd.flatPositions.length; i++) {
                if (i === dd.sourceIdx) continue;
                if (dd.flatPositions[i].groupId === targetGroupId) next = dd.flatPositions[i].catId;
                break;
              }
              beforeCatId = next;
            }
          } else {
            beforeCatId = dd.flatPositions[hoverIdx].catId;
          }
          handleDrop(dd.catId, targetGroupId, beforeCatId);
        }
      }
      setDragCatId(null);
      setGhostInfo(null);
      dragInfoRef.current = null;
    };

    document.addEventListener('mousemove', _moveRef.current);
    document.addEventListener('mouseup', _upRef.current);
  }

  function startGroupDrag(e: React.MouseEvent, group: BudgetTableGroup) {
    e.preventDefault();
    e.stopPropagation();
    if (_groupMoveRef.current) document.removeEventListener('mousemove', _groupMoveRef.current);
    if (_groupUpRef.current) document.removeEventListener('mouseup', _groupUpRef.current);
    dragGroupIdRef.current = group.id;
    setDragGroupId(group.id);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    // Render ghost (portaled to body, outside zoom) — position via ref using native mouse coords
    flushSync(() => setGroupGhostLabel(`⊞ ${group.name}`));

    _groupMoveRef.current = (me: MouseEvent) => {
      if (groupGhostElRef.current) {
        groupGhostElRef.current.style.left = `${me.clientX + 12}px`;
        groupGhostElRef.current.style.top = `${me.clientY - 10}px`;
      }
    };
    _groupUpRef.current = (ue: MouseEvent) => {
      document.removeEventListener('mousemove', _groupMoveRef.current!);
      document.removeEventListener('mouseup', _groupUpRef.current!);
      _groupMoveRef.current = null; _groupUpRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setGroupGhostLabel(null);
      const draggingId = dragGroupIdRef.current;
      dragGroupIdRef.current = null;
      setDragGroupId(null);
      if (!draggingId) return;
      const el = document.elementFromPoint(ue.clientX, ue.clientY);
      const targetRow = el?.closest('[data-grouphdr-id]') as HTMLElement | null;
      if (!targetRow) return;
      const targetId = Number(targetRow.dataset.grouphdrId);
      if (isNaN(targetId) || targetId === draggingId) return;
      // Reorder: move dragging group to target's position
      const sorted = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
      const fromIdx = sorted.findIndex((g) => g.id === draggingId);
      const toIdx = sorted.findIndex((g) => g.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      const reordered = [...sorted];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      props.onReorderGroups(reordered.map((g) => g.id));
    };
    document.addEventListener('mousemove', _groupMoveRef.current);
    document.addEventListener('mouseup', _groupUpRef.current);
  }

  function saveEdit(categoryId: number) {
    const amount = parseFloat(editTarget);
    if (!isNaN(amount)) props.onSaveTarget(categoryId, amount, editPastMonths);
    setEditId(null);
    setEditPastMonths(false);
  }

  function saveRename() {
    if (renameId != null && renameName.trim()) props.onRenameRow(renameId, renameName.trim());
    setRenameId(null);
  }

  function saveGroupSettings() {
    const name = groupSettingsName.trim();
    if (groupSettingsId != null && name) props.onSaveGroup(groupSettingsId, { name, spendFromSavings: groupSettingsSavings });
    setGroupSettingsId(null);
  }

  // "$X spent · $Y left/over", centred over the progress bar
  function renderSpentLabel(spent: number, avail: number, onClick?: () => void) {
    if (avail <= 0 && spent <= 0) return null;
    return (
      <span
        style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: '0.8rem', whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default', userSelect: 'none' }}
        onClick={onClick}
      >
        <strong>${formatAmount(spent, 0)}</strong>
        <span style={{ opacity: 0.5 }}>{avail > 0 ? ' spent · ' : ' spent'}</span>
        {avail > 0 && (spent > avail ? (
          <><strong style={{ color: budgetDiffColor(spent - avail, avail, colorThresholds) }}>${formatAmount(spent - avail, 0)}</strong><span style={{ opacity: 0.5 }}> over</span></>
        ) : (
          <><strong style={{ color: '#16a34a' }}>${formatAmount(avail - spent, 0)}</strong><span style={{ opacity: 0.5 }}> left</span></>
        ))}
      </span>
    );
  }

  function renderProgressBar(spent: number, avail: number, onClick?: () => void) {
    if (avail <= 0) return null;
    const ratio = spent / avail;
    const overAmt = spent - avail;
    const overPct = (ratio - 1) * 100;
    const barColor = ratio > 1 && overPct > colorThresholds.redPct && overAmt > colorThresholds.redAbs
      ? '#dc2626'
      : ratio > 1 && overPct > colorThresholds.orangePct && overAmt > colorThresholds.orangeAbs
        ? '#d97706'
        : ratio === 1.0 ? '#166534' : '#16a34a';
    const trackWidth = Math.max(100, barCapInfo.catWidth - 28);
    const maxScale = (trackWidth + barCapInfo.overflow) / trackWidth;
    const isCapped = ratio > 1 && ratio > maxScale;
    // scaleX operates at compositing stage, bypassing WebKit table-cell clipping
    const fillScale = isCapped ? maxScale : Math.max(0, ratio);
    return (
      <div
        style={{ position: 'relative', marginTop: 1, marginLeft: 32, marginRight: 10, marginBottom: 12, height: 6, cursor: onClick ? 'pointer' : 'default' }}
        onClick={onClick}
      >
        {/* Track */}
        <div style={{ position: 'absolute', inset: 0, background: 'var(--bar-track)', borderRadius: 99 }} />
        {/* Fill — always 100% wide, scaled via transform (bypasses table-cell clipping) */}
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%', width: '100%',
          background: barColor,
          borderRadius: ratio > 1 ? '99px 0 0 99px' : 99,
          transformOrigin: 'left center',
          transform: `scaleX(${fillScale})`,
        }}>
          {isCapped && (
            <div style={{
              position: 'absolute', right: -8, top: '50%',
              transform: `translateY(-50%) scaleX(${1 / fillScale})`,
              width: 0, height: 0,
              borderTop: '6px solid transparent', borderBottom: '6px solid transparent',
              borderLeft: `8px solid ${barColor}`, opacity: 0.7,
            }} />
          )}
        </div>
        {/* End marker — always visible; white overlay when over-budget so it shows above the fill */}
        <div style={{ position: 'absolute', right: -1, top: '50%', transform: 'translateY(-50%)', width: 3, height: 16, background: ratio > 1 ? 'rgba(255,255,255,0.85)' : 'var(--bar-track-end)', borderRadius: 2, zIndex: 3 }} />
      </div>
    );
  }

  // Header + period cells shared by the Total card and the Expenses table so their columns line up
  const ytdLabel = ytdMode === 'rolling12' ? '12M' : 'YTD';
  const targetBasis = targetMode === 'current' ? "this month's target applied to every past month" : 'the target set in each past month';
  const metricHeaderCells = (
    <>
      <th className="num" style={{ fontSize: '0.65rem', width: 72, padding: '0.55rem 6px' }}>Target</th>
      <th className="num" style={{ fontSize: '0.65rem', width: 64, padding: '0.55rem 6px' }} title="Average monthly spend over the last 12 months (this month excluded) compared to this month's target">12M ±/mo</th>
      <th className="num" data-col="avg" style={{ fontSize: '0.65rem', width: 64, padding: '0.55rem 14px 0.55rem 6px' }} title="Average monthly spend over the last 3 months (this month excluded) compared to this month's target">3M ±/mo</th>
      <th className="num" data-col="ytd" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px 0.55rem 12px', borderLeft: ytdColumnsVisible ? '2px solid var(--border)' : 'none' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdLabel}</span></th>
      <th className="num" data-col="ytd-target" title={`Compared against ${targetBasis}`} style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdLabel} Tgt</span></th>
      <th className="num" data-col="ytd-diff" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdLabel} Diff</span></th>
    </>
  );
  function renderPeriodCells(ytd: number, ytdTarget: number, ytdDiff: number) {
    return (
      <>
        <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0 12px', verticalAlign: 'top', width: 68, borderLeft: ytdColumnsVisible ? '2px solid var(--border)' : 'none' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>${formatAmount(ytd, 0)}</span></td>
        <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0', verticalAlign: 'top', width: 68 }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>${formatAmount(ytdTarget, 0)}</span></td>
        <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0', verticalAlign: 'top', width: 68 }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{formatDiff(ytdDiff)}</span></td>
      </>
    );
  }

  function renderAvgCells(avgDiff12: number, avgDiff3: number, target: number) {
    return (
      <>
        <td className="num" style={{ fontSize: '0.8rem', fontWeight: 600, width: 64, padding: '7px 6px 0', verticalAlign: 'top', color: budgetDiffColor(avgDiff12, target, colorThresholds) }}>
          {formatDiff(avgDiff12)}
        </td>
        <td className="num" style={{ fontSize: '0.8rem', fontWeight: 600, width: 64, padding: '7px 14px 0 6px', verticalAlign: 'top', color: budgetDiffColor(avgDiff3, target, colorThresholds) }}>
          {formatDiff(avgDiff3)}
        </td>
      </>
    );
  }

  // Total line — leaves out "spend from savings" groups, like the Budget summary's Expenses figure
  const savingsGroupIds = new Set(groups.filter((g) => g.spendFromSavings).map((g) => g.id));
  const totalRows = rows.filter((r) => r.groupId == null || !savingsGroupIds.has(r.groupId));
  const total = totalRows.reduce(
    (s, r) => ({
      target: s.target + r.target,
      spent: s.spent + r.spent,
      carry: s.carry + r.carry,
      avgDiff12: s.avgDiff12 + r.avgDiff12,
      avgDiff3: s.avgDiff3 + r.avgDiff3,
      ytd: s.ytd + r.ytd,
      ytdTarget: s.ytdTarget + r.ytdTarget,
      ytdDiff: s.ytdDiff + r.ytdDiff,
    }),
    { target: 0, spent: 0, carry: 0, avgDiff12: 0, avgDiff3: 0, ytd: 0, ytdTarget: 0, ytdDiff: 0 },
  );

  const toggleBtnStyle = { fontSize: '0.65rem', padding: '0.1rem 0.4rem', opacity: 0.55 };
  const grouped = groupRows(rows, groups);

  return (
    <>
      {/* Total budget line — all expense lines combined, laid out like a budget row */}
      {totalRows.length > 0 && (
        <div className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="section-title" style={{ marginTop: 0 }}>Total</div>
          <table className="data-table budget-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Category</th>
                {metricHeaderCells}
              </tr>
            </thead>
            <tbody>
              <tr className="budget-row-even">
                <td style={{ width: 24, paddingLeft: 4, paddingRight: 4 }}></td>
                <td style={{ overflow: 'visible', padding: 0, position: 'relative', zIndex: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px 2px 32px', position: 'relative', minHeight: 30 }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}
                      title={savingsGroupIds.size > 0 ? 'Excludes groups set to spend from savings' : undefined}>
                      All expenses
                    </span>
                    {renderSpentLabel(total.spent, total.target + total.carry, onOpenAll)}
                  </div>
                  {renderProgressBar(total.spent, total.target + total.carry, onOpenAll)}
                </td>
                <td className="num" style={{ fontSize: '0.8rem', width: 72, padding: '7px 6px 0', verticalAlign: 'top' }}>
                  <span style={{ fontWeight: 700 }}>${formatAmount(total.target, 0)}</span>
                  {total.carry !== 0 && (
                    <span title="Rollover from previous months" style={{ marginLeft: 6, fontSize: '0.7rem', fontWeight: 600, color: total.carry > 0 ? '#16a34a' : '#dc2626' }}>
                      {total.carry > 0 ? '+' : '−'}${formatAmount(Math.abs(total.carry), 0)} carried
                    </span>
                  )}
                </td>
                {renderAvgCells(total.avgDiff12, total.avgDiff3, total.target)}
                {renderPeriodCells(total.ytd, total.ytdTarget, total.ytdDiff)}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {props.betweenTotalAndTable}

      {/* Expense table — single table so columns align across all groups */}
      <div className="card">
        {props.aboveTable}
        <div className="section-title" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Expenses</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
            {props.onTargetModeChange && (
              <button
                className="btn btn-ghost btn-sm"
                title={targetMode === 'current'
                  ? "Past months are compared to this month's target, as if it applied all along. Click to use the target set at the time."
                  : "Past months are compared to the target set at the time. Click to compare against this month's target instead."}
                style={toggleBtnStyle}
                onClick={() => props.onTargetModeChange!(targetMode === 'current' ? 'atTime' : 'current')}
              >
                {targetMode === 'current' ? 'Tgt: now' : 'Tgt: then'}
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              title={ytdMode === 'rolling12' ? 'Switch to year-to-date' : 'Switch to rolling 12 months'}
              style={toggleBtnStyle}
              onClick={() => props.onYtdModeChange(ytdMode === 'rolling12' ? 'ytd' : 'rolling12')}
            >
              {ytdLabel}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              title={ytdColumnsVisible ? 'Hide period columns' : 'Show period columns'}
              style={{ ...toggleBtnStyle, opacity: ytdColumnsVisible ? 0.55 : 0.25 }}
              onClick={() => props.onYtdColumnsVisibleChange(!ytdColumnsVisible)}
            >
              👁
            </button>
          </div>
        </div>
        <table className="data-table budget-table" ref={budgetTableRef}>
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <th data-col="category">Category</th>
              {metricHeaderCells}
            </tr>
          </thead>
          <tbody ref={tableBodyRef}>
            {grouped.flatMap(({ group, rows: grpRows }) => {
              const thisGroupId = group?.id ?? null;
              const groupTarget = grpRows.reduce((s, r) => s + r.target, 0);
              // Hide ungrouped section entirely when empty and not dragging
              if (group === null && grpRows.length === 0 && !ghostInfo) return [];

              const result: ReactNode[] = [];

              result.push(
                // Group header row
                <tr key={`hdr-${group?.id ?? 'ug'}`} className="budget-group-header"
                    data-grouphdr-id={group?.id ?? undefined}
                    style={{ opacity: dragGroupId === group?.id ? 0.4 : 1 }}>
                  <td
                    style={{ width: 24, paddingLeft: 4, paddingRight: 4, background: 'var(--bg-3)', borderTop: '1px solid var(--border)',
                      cursor: group ? 'grab' : 'default', userSelect: 'none', WebkitUserSelect: 'none' } as React.CSSProperties}
                    onMouseDown={group ? (e) => startGroupDrag(e, group) : undefined}
                    title={group ? 'Drag to reorder group' : undefined}
                  >
                    {group && <DragDots />}
                  </td>
                  <td colSpan={COLS - 1} style={{ padding: '0.75rem 0.75rem 0.4rem 0.1rem', background: 'var(--bg-3)', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {group ? (
                        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{group.name}</span>
                      ) : (
                        <span style={{ opacity: 0.6, fontSize: '0.8rem' }}>Ungrouped</span>
                      )}
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.55 }}>
                        ${formatAmount(groupTarget, 0)}
                      </span>
                      {group && (
                        <span
                          className={`budget-cat-icons${confirmDeleteGroupId === group.id || editGroupNoteId === group.id ? ' budget-cat-icons-active' : ''}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}
                        >
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Group settings (rename, spend from savings)"
                            onClick={() => { setGroupSettingsId(group.id); setGroupSettingsName(group.name); setGroupSettingsSavings(group.spendFromSavings ?? false); }}
                            style={{ opacity: 0.5, fontSize: '0.8rem', padding: '0.1rem 0.3rem' }}
                          >⚙</button>
                          {props.onGroupTrend && (
                            <span
                              title={`View ${group.name} trend in Year view`}
                              style={{ cursor: 'pointer', opacity: 0.35, fontSize: '0.7rem', flexShrink: 0 }}
                              onClick={() => props.onGroupTrend!(group.id)}
                            >📈</span>
                          )}
                          {confirmDeleteGroupId === group.id ? (
                            <span style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-2)' }}>Delete?</span>
                              <button className="btn btn-danger btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => { props.onDeleteGroup(group.id); setConfirmDeleteGroupId(null); }}>Yes</button>
                              <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => setConfirmDeleteGroupId(null)}>No</button>
                            </span>
                          ) : (
                            <span
                              title="Delete group"
                              style={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.75rem', flexShrink: 0, lineHeight: 1, userSelect: 'none', padding: '0.1rem 0.15rem' }}
                              onClick={() => setConfirmDeleteGroupId(group.id)}
                            >&times;</span>
                          )}
                          {editGroupNoteId === group.id ? (
                            <input
                              autoFocus
                              type="text"
                              value={editGroupNoteText}
                              onChange={(e) => setEditGroupNoteText(e.target.value)}
                              onBlur={() => { props.onGroupNote(group.id, editGroupNoteText || undefined); setEditGroupNoteId(null); }}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') props.onGroupNote(group.id, editGroupNoteText || undefined); setEditGroupNoteId(null); } }}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="Add note..."
                              style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }}
                            />
                          ) : (
                            <span
                              title={group.note ? `Note: ${group.note}` : 'Add note'}
                              style={{ cursor: 'pointer', opacity: group.note ? 0.8 : 0.25, fontSize: '0.75rem' }}
                              onClick={(e) => { e.stopPropagation(); setEditGroupNoteId(group.id); setEditGroupNoteText(group.note ?? ''); }}
                            >
                              {group.note ? '📝' : '＋'}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );

              // Data rows
              grpRows.forEach((r, rowIdx) => {
                const isDragged = dragCatId === r.categoryId;
                const avail = r.target + r.carry;
                const openRow = onOpenRow ? () => onOpenRow(r.categoryId) : undefined;

                result.push(
                  <tr key={r.categoryId}
                    data-catid={r.categoryId}
                    data-groupid={thisGroupId ?? 'null'}
                    className={rowIdx % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}
                    style={{ opacity: isDragged ? 0 : 1 }}>
                      {/* Drag handle */}
                      <td style={{ cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none', width: 24, paddingLeft: 4, paddingRight: 4 } as React.CSSProperties}
                        onMouseDown={(e) => startRowDrag(e, r, thisGroupId)}>
                        <DragDots />
                      </td>
                      {/* Category cell — name + centered spent/left + target + avg */}
                      <td style={{ overflow: 'visible', padding: 0, position: 'relative', zIndex: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px 2px 32px', position: 'relative', minHeight: 30 }}>
                          {/* Left: name + control icons */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: '0.8rem' }} title={[r.note && `Always: ${r.note}`, r.budgetNote && `${lineNoteLabel}: ${r.budgetNote}`].filter(Boolean).join('\n') || undefined}>{r.categoryName}{r.budgetNote && <span style={{ marginLeft: 3, fontSize: '0.65rem', opacity: 0.6 }}>📌</span>}</span>
                            <span className={`budget-cat-icons${confirmDeleteId === r.categoryId || editNoteId === r.categoryId || editLineNoteId === r.categoryId ? ' budget-cat-icons-active' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span title="Rename" style={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.68rem', flexShrink: 0, lineHeight: 1 }}
                                onClick={() => { setRenameId(r.categoryId); setRenameName(r.categoryName); }}>⚙</span>
                              {props.onRowTrend && (
                                <span title={`View ${r.categoryName} trend in Year view`}
                                  style={{ cursor: 'pointer', opacity: 0.35, fontSize: '0.7rem', flexShrink: 0 }}
                                  onClick={() => props.onRowTrend!(r.categoryId)}>📈</span>
                              )}
                              {confirmDeleteId === r.categoryId ? (
                                <span style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
                                  <span style={{ fontSize: '0.65rem', color: 'var(--text-2)' }}>Delete?</span>
                                  <button className="btn btn-danger btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => { props.onDeleteRow(r.categoryId); setConfirmDeleteId(null); }}>Yes</button>
                                  <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => setConfirmDeleteId(null)}>No</button>
                                </span>
                              ) : (
                                <span title="Delete" style={{ cursor: 'pointer', opacity: 0.25, fontSize: '0.75rem', flexShrink: 0, lineHeight: 1, userSelect: 'none' }}
                                  onClick={() => setConfirmDeleteId(r.categoryId)}>×</span>
                              )}
                              {props.onCategoryNote && (editNoteId === r.categoryId ? (
                                <input autoFocus type="text" value={editNoteText}
                                  onChange={(e) => setEditNoteText(e.target.value)}
                                  onBlur={() => { props.onCategoryNote!(r.categoryId, editNoteText); setEditNoteId(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') props.onCategoryNote!(r.categoryId, editNoteText); setEditNoteId(null); } }}
                                  placeholder="Category description..." style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }} />
                              ) : (
                                <span title={r.note ? `Description: ${r.note}` : 'Add category description'}
                                  style={{ cursor: 'pointer', opacity: r.note ? 0.8 : 0.25, fontSize: '0.75rem', flexShrink: 0 }}
                                  onClick={() => { setEditNoteId(r.categoryId); setEditNoteText(r.note ?? ''); }}>
                                  {r.note ? '🏷' : '＋'}
                                </span>
                              ))}
                              {editLineNoteId === r.categoryId ? (
                                <input autoFocus type="text" value={editLineNoteText}
                                  onChange={(e) => setEditLineNoteText(e.target.value)}
                                  onBlur={() => { props.onLineNote(r.categoryId, editLineNoteText); setEditLineNoteId(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') props.onLineNote(r.categoryId, editLineNoteText); setEditLineNoteId(null); } }}
                                  placeholder={`${lineNoteLabel}...`} style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }} />
                              ) : (
                                <span title={r.budgetNote ? `${lineNoteLabel}: ${r.budgetNote}` : `Add note (${lineNoteLabel.toLowerCase()})`}
                                  style={{ cursor: 'pointer', opacity: r.budgetNote ? 0.8 : 0.2, fontSize: '0.75rem', flexShrink: 0 }}
                                  onClick={() => { setEditLineNoteId(r.categoryId); setEditLineNoteText(r.budgetNote ?? ''); }}>
                                  {r.budgetNote ? '📌' : '＋'}
                                </span>
                              )}
                            </span>
                            {props.renderRowExtras?.(r)}
                          </div>
                          {/* Centre: spent / left — absolute, centred horizontally over bar */}
                          {renderSpentLabel(r.spent, avail, openRow)}
                        </div>
                        {/* Progress bar — in flow, directly below text */}
                        {renderProgressBar(r.spent, avail, openRow)}
                      </td>
                      {/* Target column */}
                      <td className="num" style={{ fontSize: '0.8rem', width: 72, padding: '7px 6px 0', verticalAlign: 'top', position: 'relative', zIndex: 2 }}>
                        {editId === r.categoryId ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                            <input type="number" value={editTarget} onChange={(e) => setEditTarget(e.target.value)}
                              onBlur={(e) => { if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.edit-past-check')) saveEdit(r.categoryId); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(r.categoryId); if (e.key === 'Escape') { setEditId(null); setEditPastMonths(false); } }}
                              style={{ width: 68, fontSize: '0.8rem' }} autoFocus />
                            {allowPastMonths && (
                              <label className="edit-past-check" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.65rem', color: 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                <input type="checkbox" checked={editPastMonths} onChange={(e) => setEditPastMonths(e.target.checked)} style={{ width: 11, height: 11 }} />
                                Past months too
                              </label>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontWeight: 700, cursor: 'pointer' }}
                            onClick={() => { setEditId(r.categoryId); setEditTarget(String(r.target)); setEditPastMonths(false); }}>
                            ${formatAmount(r.target, 0)}
                          </span>
                        )}
                        {r.carry !== 0 && (
                          <span title="Rollover from previous months" style={{ marginLeft: 6, fontSize: '0.7rem', fontWeight: 600, color: r.carry > 0 ? '#16a34a' : '#dc2626' }}>
                            {r.carry > 0 ? '+' : '−'}${formatAmount(Math.abs(r.carry), 0)} carried
                          </span>
                        )}
                      </td>
                      {/* Avg ±/mo columns (12M and 3M), against this month's target */}
                      {renderAvgCells(r.avgDiff12, r.avgDiff3, r.target)}
                      {/* Period columns — dim when visible; full opacity when hidden so row stripe background is unaffected */}
                      {renderPeriodCells(r.ytd, r.ytdTarget, r.ytdDiff)}
                  </tr>
                );
              });

              // Empty group message (named groups only)
              if (grpRows.length === 0 && group !== null) {
                result.push(
                  <tr key={`empty-${thisGroupId}`}>
                    <td colSpan={COLS} style={{ textAlign: 'center', padding: '0.6rem', color: 'var(--text-3)', fontSize: '0.8rem' }}>
                      Drag items here or add above
                    </td>
                  </tr>
                );
              }

              return result;
            })}
          </tbody>
        </table>
      </div>

      {/* Item drag ghost — portaled to body (outside zoom), positioned via ref */}
      {ghostInfo && createPortal(
        <div ref={ghostElRef} style={{
          position: 'fixed', left: -9999, top: -9999, pointerEvents: 'none', zIndex: 9999,
          background: '#ffffff', border: '2px solid #1a9e8b', borderRadius: 8, padding: '0.45rem 0.85rem',
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)',
          color: '#1a2332', userSelect: 'none', whiteSpace: 'nowrap',
        }}>
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{ opacity: 0.3, flexShrink: 0 }}>
            {([2, 7, 12] as number[]).map((cy) => ([1, 6] as number[]).map((cx) => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.4} />
            )))}
          </svg>
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ghostInfo.label}</span>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>${formatAmount(ghostInfo.target, 0)}</span>
          <span style={{ fontSize: '0.82rem', color: ghostInfo.spent > ghostInfo.target ? '#dc2626' : '#16a34a' }}>
            spent ${formatAmount(ghostInfo.spent, 0)}
          </span>
        </div>,
        document.body,
      )}

      {/* Group drag ghost — portaled to body (outside zoom), positioned via ref */}
      {groupGhostLabel && createPortal(
        <div ref={groupGhostElRef} style={{
          position: 'fixed', left: -9999, top: -9999, pointerEvents: 'none', zIndex: 9999,
          background: '#ffffff', border: '2px solid #1a9e8b', borderRadius: 8, padding: '0.3rem 0.75rem',
          fontSize: '0.88rem', fontWeight: 600, boxShadow: '0 6px 24px rgba(0,0,0,0.22)', color: '#1a2332',
          whiteSpace: 'nowrap', transform: 'rotate(1.5deg)', opacity: 0.92, userSelect: 'none',
        }}>
          {groupGhostLabel}
        </div>,
        document.body,
      )}

      {/* Group settings modal */}
      {groupSettingsId != null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setGroupSettingsId(null)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 340, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Group Settings</h3>
            <div className="field" style={{ marginBottom: '0.75rem' }}>
              <label>Name</label>
              <input value={groupSettingsName} onChange={(e) => setGroupSettingsName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveGroupSettings()} autoFocus />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
              <input type="checkbox" checked={groupSettingsSavings} onChange={(e) => setGroupSettingsSavings(e.target.checked)} />
              Spend from Savings
              <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>
                (spending won't count against monthly budget)
              </span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setGroupSettingsId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveGroupSettings}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename modal */}
      {renameId != null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setRenameId(null)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 300, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Rename Category</h3>
            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label>Name</label>
              <input value={renameName} onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveRename()} autoFocus />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setRenameId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveRename}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

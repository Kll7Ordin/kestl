import { useState, useRef, useEffect, useCallback } from 'react';
import { getAISettings, getData } from '../db';
import {
  answerStructuredQuestion,
  type StructuredQuestionType,
  type StructuredQuestionParams,
} from '../logic/llm';
import { SearchableSelect } from './SearchableSelect';

interface UIMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

let msgId = 0;
function nextMsgId() { return ++msgId; }

function formatMonth(m: string): string {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

const QUESTION_TYPES: { key: StructuredQuestionType; label: string }[] = [
  { key: 'planned_comparison', label: 'Compare planned spending' },
  { key: 'over_budget',        label: 'What drove overspending?' },
  { key: 'category_high',      label: 'Why was a category high?' },
  { key: 'category_low',       label: 'Why was a category low?' },
];

interface Props {
  onClose: () => void;
}

export function AIPanel({ onClose }: Props) {
  const settings = getAISettings();
  const appData = getData();

  const months = [...new Set(appData.budgets.map((b) => b.month))].sort((a, b) => b.localeCompare(a));
  const categories = appData.categories
    .filter((c) => !c.isIncome)
    .sort((a, b) => a.name.localeCompare(b.name));

  const monthOptions = months.map((m) => ({ value: m, label: formatMonth(m) }));
  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }));

  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);

  const [qType, setQType] = useState<StructuredQuestionType | null>(null);
  const [monthA, setMonthA] = useState(months[0] ?? '');
  const [monthB, setMonthB] = useState(months[1] ?? months[0] ?? '');
  const [month, setMonth] = useState(months[0] ?? '');
  const [categoryId, setCategoryId] = useState<number | ''>('');

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, toolStatus]);

  const isCategoryQuestion = qType === 'category_high' || qType === 'category_low';
  const canAsk = !!qType && months.length > 0 && (!isCategoryQuestion || categoryId !== '');

  const handleAsk = useCallback(async () => {
    if (loading || !qType || !canAsk) return;

    const params: StructuredQuestionParams = {
      monthA,
      monthB,
      month,
      categoryId: categoryId !== '' ? Number(categoryId) : undefined,
    };

    const catName = categories.find((c) => c.id === categoryId)?.name ?? '?';
    let questionDisplay = '';
    if (qType === 'planned_comparison') questionDisplay = `Why is planned spending different between ${formatMonth(monthA)} and ${formatMonth(monthB)}?`;
    else if (qType === 'over_budget')   questionDisplay = `What drove overspending in ${formatMonth(month)}?`;
    else if (qType === 'category_high') questionDisplay = `Why was ${catName} so high in ${formatMonth(month)}?`;
    else if (qType === 'category_low')  questionDisplay = `Why was ${catName} so low in ${formatMonth(month)}?`;

    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'user', content: questionDisplay }]);
    setLoading(true);
    setToolStatus(null);

    try {
      const answer = await answerStructuredQuestion(qType, params, settings, setToolStatus);
      setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content: answer }]);
    } catch (e) {
      const errMsg = String(e);
      const isConnErr = errMsg.includes('fetch') || errMsg.includes('connect') || errMsg.includes('ECONNREFUSED');
      setMessages((prev) => [...prev, {
        id: nextMsgId(),
        role: 'assistant',
        content: isConnErr
          ? 'Could not connect to Ollama. Make sure Ollama is running and check Settings → AI Assistant.'
          : `Error: ${errMsg}`,
      }]);
    } finally {
      setLoading(false);
      setToolStatus(null);
    }
  }, [loading, qType, canAsk, monthA, monthB, month, categoryId, settings, categories]);

  function renderParams() {
    if (!qType) return null;

    if (qType === 'planned_comparison') {
      return (
        <div className="ai-param-fields">
          <div className="ai-form-row">
            <SearchableSelect
              options={monthOptions}
              value={monthA}
              onChange={(v) => setMonthA(String(v))}
              placeholder="Select month"
              style={{ flex: 1 }}
              disabled={loading}
            />
            <span className="ai-form-vs">vs</span>
            <SearchableSelect
              options={monthOptions}
              value={monthB}
              onChange={(v) => setMonthB(String(v))}
              placeholder="Select month"
              style={{ flex: 1 }}
              disabled={loading}
            />
          </div>
        </div>
      );
    }

    if (qType === 'over_budget') {
      return (
        <div className="ai-param-fields">
          <SearchableSelect
            options={monthOptions}
            value={month}
            onChange={(v) => setMonth(String(v))}
            placeholder="Select month"
            disabled={loading}
          />
        </div>
      );
    }

    return (
      <div className="ai-param-fields">
        <SearchableSelect
          options={categoryOptions}
          value={categoryId}
          onChange={(v) => setCategoryId(v !== '' ? Number(v) : '')}
          placeholder="Select Category"
          disabled={loading}
        />
        <SearchableSelect
          options={monthOptions}
          value={month}
          onChange={(v) => setMonth(String(v))}
          placeholder="Select month"
          disabled={loading}
        />
      </div>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <span>AI Assistant</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{settings.model}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            style={{ padding: '0.2rem 0.4rem', fontSize: '1rem' }}
          >
            ×
          </button>
        </div>
      </div>

      <div className="ai-panel-form">
        <div className="ai-question-bubbles">
          {QUESTION_TYPES.map((q) => (
            <button
              key={q.key}
              className={`ai-question-bubble ${qType === q.key ? 'active' : ''}`}
              onClick={() => {
                setQType(q.key);
                setCategoryId('');
              }}
              disabled={loading}
            >
              {q.label}
            </button>
          ))}
        </div>

        {qType && (
          <>
            {renderParams()}
            <button
              className="btn btn-primary"
              onClick={handleAsk}
              disabled={loading || !canAsk}
              style={{ width: '100%', marginTop: '0.25rem' }}
            >
              {loading ? '…' : 'Ask'}
            </button>
          </>
        )}
      </div>

      <div className="ai-panel-messages">
        {messages.length === 0 && (
          <div className="ai-msg ai-msg-assistant">
            <MessageContent content="Select a question above and I'll analyze your budget data to answer it." />
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant'}`}>
            <MessageContent content={m.content} />
          </div>
        ))}
        {loading && (
          <div className="ai-msg-tool">{toolStatus ?? 'Thinking…'}</div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts: React.ReactNode[] = [];
  const lines = content.split('\n');
  lines.forEach((line, li) => {
    if (li > 0) parts.push(<br key={`br-${li}`} />);
    const segments = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    segments.forEach((seg, si) => {
      if (seg.startsWith('**') && seg.endsWith('**')) {
        parts.push(<strong key={`${li}-${si}`}>{seg.slice(2, -2)}</strong>);
      } else if (seg.startsWith('`') && seg.endsWith('`')) {
        parts.push(<code key={`${li}-${si}`} style={{ background: 'rgba(0,0,0,0.2)', padding: '0 3px', borderRadius: 3, fontSize: '0.85em' }}>{seg.slice(1, -1)}</code>);
      } else {
        parts.push(seg);
      }
    });
  });
  return <>{parts}</>;
}

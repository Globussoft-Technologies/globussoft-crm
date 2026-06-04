
import { Reply, Forward, Smile, Trash2 } from 'lucide-react';
import { useWhatsAppThreads } from './WhatsAppThreadsContext';
import CtxMenuItem from './CtxMenuItem';

export default function MessageContextMenu() {
  const {
    ctxMenu,
    setCtxMenu,
    reactPanelOpen,
    setReactPanelOpen,
    replyToMessage,
    forwardMessage,
    reactToMessage,
    deleteMessage,
  } = useWhatsAppThreads();

  if (!ctxMenu) return null;

  // Smart positioning:
  //   • If click X is in the right half → anchor menu's RIGHT edge to click
  //     (subtract estimated width from x) so the menu opens LEFTWARD
  //   • Same for vertical: if in bottom half → anchor BOTTOM edge,
  //     opens UPWARD
  // This matches how WhatsApp / Slack / most native menus behave.
  const MENU_W = reactPanelOpen ? 220 : 200;
  const MENU_H = reactPanelOpen ? 290 : 200;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // Default: anchor top-left of menu at click
  let left = ctxMenu.x;
  let top = ctxMenu.y;
  // Flip horizontally if click is past the midpoint OR menu would overflow
  if (ctxMenu.x > vw / 2 || ctxMenu.x + MENU_W > vw - 8) {
    left = Math.max(8, ctxMenu.x - MENU_W);
  }
  // Flip vertically if click is past the midpoint OR menu would overflow
  if (ctxMenu.y > vh / 2 || ctxMenu.y + MENU_H > vh - 8) {
    top = Math.max(8, ctxMenu.y - MENU_H);
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 10001,
        background: 'var(--surface-color)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        boxShadow: '0 10px 28px rgba(0,0,0,0.3)',
        minWidth: 180,
        padding: 4,
        color: 'var(--text-primary)',
      }}
    >
      <CtxMenuItem
        icon={<Reply size={14} />}
        label="Reply"
        onClick={() => { replyToMessage(ctxMenu.message); setCtxMenu(null); }}
      />
      <CtxMenuItem
        icon={<Forward size={14} />}
        label="Forward"
        onClick={() => { forwardMessage(ctxMenu.message); setCtxMenu(null); }}
      />
      <CtxMenuItem
        icon={<Smile size={14} />}
        label={reactPanelOpen ? 'React →' : 'React'}
        onClick={() => setReactPanelOpen((v) => !v)}
      />
      {reactPanelOpen && (
        <div style={{
          display: 'flex', gap: 4, padding: '4px 8px',
          borderTop: '1px solid var(--border-color)',
          borderBottom: '1px solid var(--border-color)',
          marginBottom: 4,
        }}>
          {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((e) => (
            <button
              key={e}
              onClick={() => { reactToMessage(ctxMenu.message, e); setCtxMenu(null); }}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: '1.2rem', padding: '4px 6px', borderRadius: 4,
              }}
              title={`React ${e}`}
              onMouseEnter={(ev) => ev.currentTarget.style.background = 'var(--hover-bg)'}
              onMouseLeave={(ev) => ev.currentTarget.style.background = 'transparent'}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      <CtxMenuItem
        icon={<Trash2 size={14} />}
        label="Delete for me"
        color="#dc2626"
        onClick={() => { deleteMessage(ctxMenu.message.id); setCtxMenu(null); }}
      />
    </div>
  );
}

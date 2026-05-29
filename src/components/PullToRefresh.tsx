import { useEffect, useRef, useState } from 'react';

interface Props {
  onRefresh: () => Promise<void>;
}

const THRESHOLD = 72; // px of pull needed to trigger

export function PullToRefresh({ onRefresh }: Props) {
  const [pull, setPull]         = useState(0);       // 0 → THRESHOLD
  const [refreshing, setRefreshing] = useState(false);
  const startY  = useRef(0);
  const active  = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      if (window.scrollY <= 2) {
        startY.current = e.touches[0].clientY;
        active.current  = true;
        pending.current = false;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!active.current) return;
      const diff = e.touches[0].clientY - startY.current;
      if (diff > 0) {
        // Dampen the pull so it feels resistive
        setPull(Math.min(diff * 0.55, THRESHOLD * 1.15));
      }
    }

    async function onTouchEnd() {
      if (!active.current) return;
      active.current = false;

      setPull(prev => {
        if (prev >= THRESHOLD && !pending.current) {
          pending.current = true;
          setRefreshing(true);
          // Run async refresh outside of the state setter
          Promise.resolve().then(async () => {
            await onRefresh();
            setRefreshing(false);
            setPull(0);
            pending.current = false;
          });
          return THRESHOLD;
        }
        return 0;
      });
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove',  onTouchMove,  { passive: true });
    window.addEventListener('touchend',   onTouchEnd);

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove',  onTouchMove);
      window.removeEventListener('touchend',   onTouchEnd);
    };
  }, [onRefresh]);

  const visible = pull > 4 || refreshing;
  if (!visible) return null;

  const progress = Math.min(pull / THRESHOLD, 1);

  return (
    <div style={{
      position:   'fixed',
      top:        60,       // below mobile header
      left:       0,
      right:      0,
      display:    'flex',
      justifyContent: 'center',
      paddingTop: `${pull * 0.65}px`,
      zIndex:     150,
      pointerEvents: 'none',
      transition: refreshing ? 'none' : 'padding-top .1s linear',
    }}>
      <div style={{
        width:  36, height: 36,
        borderRadius: '50%',
        background: 'var(--surface)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border)',
        display: 'grid', placeItems: 'center',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        opacity: progress,
        transform: refreshing ? 'none' : `rotate(${progress * 200}deg)`,
        transition: refreshing ? 'none' : 'opacity .1s, transform .1s',
      }}>
        {refreshing
          ? <span className="spinner" style={{ width: 16, height: 16, borderTopColor: 'var(--accent)' }} />
          : <span style={{ fontSize: '.85rem', color: 'var(--accent)' }}>↓</span>
        }
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  /** 空 label = 一条分隔线 */
  label?: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

/**
 * 画布的应用级右键菜单。
 * 浏览器默认菜单由各处的 openMenu 里 preventDefault 干掉，这里只负责渲染与关灯。
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // 先量再摆：贴边时翻转，不让菜单跑出屏幕
  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 240;
    setPos({
      x: Math.max(6, Math.min(menu.x, window.innerWidth - w - 8)),
      y: Math.max(6, Math.min(menu.y, window.innerHeight - h - 8)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {menu.title && <div className="ctx-title">{menu.title}</div>}
      {menu.items.map((it, i) =>
        it.label ? (
          <button
            key={i}
            className={`ctx-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ) : (
          <div key={i} className="ctx-sep" />
        ),
      )}
    </div>
  );
}

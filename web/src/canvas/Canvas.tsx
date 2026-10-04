import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { inputsSummary, resolveTake, useStore, wiresOf } from '../store';
import { TakeNodeView, type TakeNodeData } from './TakeNodeView';
import type { NodeKind, Project } from '@shared/types';

const nodeTypes = { take: TakeNodeView };

function Inner({ project }: { project: Project }) {
  const setSelected = useStore((s) => s.setSelected);
  const moveNode = useStore((s) => s.moveNode);
  const connect = useStore((s) => s.connect);
  const addNode = useStore((s) => s.addNode);
  const toggleEdgePin = useStore((s) => s.toggleEdgePin);
  const deleteEdge = useStore((s) => s.deleteEdge);
  const deleteNode = useStore((s) => s.deleteNode);
  const deleteTake = useStore((s) => s.deleteTake);
  const activate = useStore((s) => s.activate);
  const run = useStore((s) => s.run);
  const sweep = useStore((s) => s.sweep);
  const replay = useStore((s) => s.replay);
  const importPath = useStore((s) => s.importPath);
  const patchNode = useStore((s) => s.patchNode);
  const releaseImage = useStore((s) => s.releaseImage);
  const refresh = useStore((s) => s.refresh);
  const selected = useStore((s) => s.selected);
  const busy = useStore((s) => s.busy);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  /** 所有右键都走这里：先掐掉浏览器默认菜单，再摆我们自己的。 */
  const openMenu = useCallback((ev: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[], title?: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, items, title });
  }, []);

  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project]);

  useEffect(() => {
    setNodes(
      project.nodes.map((n) => ({
        id: n.id,
        type: 'take',
        position: { x: n.x, y: n.y },
        selected: n.id === selected,
        data: {
          node: n,
          projectId: project.id,
          wires: wiresOf(project, n.id),
          takeInputs: Object.fromEntries(n.takes.map((t) => [t.id, inputsSummary(project, t)])),
          onTakeMenu: (ev: React.MouseEvent, takeId: string) => {
            const i = n.takes.findIndex((t) => t.id === takeId);
            const currentId = n.activeTake ?? n.takes[n.takes.length - 1]?.id;
            openMenu(
              ev,
              [
                { label: `钉为当前版本 v${i + 1}`, checked: currentId === takeId, disabled: currentId === takeId, onClick: () => void activate(n.id, takeId) },
                { label: '' },
                { label: '删除这一版', danger: true, disabled: busy, onClick: () => void deleteTake(n.id, takeId) },
              ],
              `${n.title} · v${i + 1}`,
            );
          },
        } satisfies TakeNodeData,
      })),
    );
    setEdges(
      project.edges.map((e) => {
        const up = nodeById.get(e.from);
        const pinned = e.pin !== 'active';
        const resolved = resolveTake(up, e.pin);
        const idx = resolved && up ? up.takes.findIndex((t) => t.id === resolved.id) + 1 : 0;
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          animated: !pinned,
          // 跟版也报版本号：切上游引脚，这里的数字当场变
          label: pinned ? (idx ? `钉 v${idx}` : '钉 已删版') : idx ? `跟版 v${idx}` : '跟版',
          labelShowBg: false,
          data: { pin: e.pin },
          className: pinned ? 'edge-pinned' : 'edge-live',
          style: { stroke: pinned ? '#ffb020' : '#7c5cff', strokeWidth: pinned ? 2 : 1.5 },
        };
      }),
    );
  }, [project, selected, nodeById, openMenu, activate, deleteTake, busy]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target) void connect(c.source, c.target);
  }, [connect]);

  const onNodeClick = useCallback((_: unknown, n: Node) => setSelected(n.id), [setSelected]);

  const onNodeDragStop = useCallback(
    (_: unknown, n: Node) => void moveNode(n.id, Math.round(n.position.x), Math.round(n.position.y)),
    [moveNode],
  );

  const onEdgeClick = useCallback(
    (_: unknown, e: RFEdge) => {
      const pin = (e.data as { pin?: string } | undefined)?.pin;
      const up = nodeById.get(e.source);
      if (pin === 'active') {
        const activeId = resolveTake(up, 'active')?.id;
        if (activeId) void toggleEdgePin(e.id, activeId);
      } else {
        void toggleEdgePin(e.id, 'active');
      }
    },
    [nodeById, toggleEdgePin],
  );

  const onNodeContextMenu = useCallback(
    (ev: React.MouseEvent, n: Node) => {
      const node = nodeById.get(n.id);
      if (!node) return;
      const currentId = node.activeTake ?? node.takes[node.takes.length - 1]?.id;
      const canRun = node.kind !== 'text' && node.kind !== 'note';
      setSelected(node.id);
      openMenu(
        ev,
        [
          { label: '▶ 跑一版', disabled: busy || !canRun, hint: `${node.takes.length} 版`, onClick: () => void run(node.id) },
          { label: '⚄ 抽 4 版', disabled: busy || !canRun, onClick: () => void sweep(node.id, 4) },
          { label: '⟳ 重跑下游', disabled: busy, onClick: () => void replay(node.id) },
          { label: '' },
          ...node.takes.map((t, i) => ({
            label: `引脚 → v${i + 1}`,
            checked: t.id === currentId,
            hint: t.status === 'done' ? undefined : t.status,
            onClick: () => void activate(node.id, t.id),
          })),
          { label: '' },
          {
            label: '⤓ 登记本地文件…',
            onClick: () => {
              const path = window.prompt('登记一个本地文件为 take（绝对路径）');
              if (path) void importPath(node.id, path.trim());
            },
          },
          {
            label: '✎ 重命名…',
            onClick: () => {
              const title = window.prompt('节点标题', node.title);
              if (title) void patchNode(node.id, { title });
            },
          },
          { label: '' },
          { label: '✕ 删除节点', danger: true, disabled: busy, onClick: () => void deleteNode(node.id) },
        ],
        `${node.kind} · ${node.title}`,
      );
    },
    [busy, nodeById, run, sweep, replay, activate, importPath, patchNode, deleteNode, setSelected, openMenu],
  );

  const onEdgeContextMenu = useCallback(
    (ev: React.MouseEvent, e: RFEdge) => {
      const up = nodeById.get(e.source);
      const pin = (e.data as { pin?: string } | undefined)?.pin;
      openMenu(
        ev,
        [
          { label: '跟版（跟随上游当前版本）', checked: pin === 'active', onClick: () => void toggleEdgePin(e.id, 'active') },
          { label: '' },
          ...(up?.takes ?? []).map((t, i) => ({
            label: `钉死 v${i + 1}`,
            checked: pin === t.id,
            hint: t.status === 'done' ? undefined : t.status,
            onClick: () => void toggleEdgePin(e.id, t.id),
          })),
          { label: '' },
          { label: '✕ 删除连线', danger: true, onClick: () => void deleteEdge(e.id) },
        ],
        `${up?.title ?? e.source} → ${nodeById.get(e.target)?.title ?? e.target}`,
      );
    },
    [nodeById, toggleEdgePin, deleteEdge, openMenu],
  );

  const onPaneContextMenu = useCallback(
    (ev: React.MouseEvent | MouseEvent) => {
      const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const at = (kind: NodeKind) => () => void addNode(kind, Math.round(pos.x), Math.round(pos.y));
      openMenu(
        ev,
        [
          { label: '＋ 文本节点', onClick: at('text') },
          { label: '＋ 图片节点', onClick: at('image') },
          { label: '＋ 视频节点', onClick: at('video') },
          { label: '＋ 算子节点', onClick: at('op') },
          { label: '' },
          { label: '⤢ 适应视图', onClick: () => void fitView({ padding: 0.25, maxZoom: 1, duration: 200 }) },
          { label: '⟳ 刷新画布', onClick: () => void refresh() },
          { label: '⚡ 释放 8888 显存', onClick: () => void releaseImage() },
        ],
        '画布',
      );
    },
    [screenToFlowPosition, addNode, fitView, refresh, releaseImage, openMenu],
  );

  const onPaneDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      void addNode('image', Math.round(pos.x), Math.round(pos.y));
    },
    [addNode, screenToFlowPosition],
  );

  const defaultViewport = useMemo(
    () => ({ x: project.view?.x ?? 0, y: project.view?.y ?? 0, zoom: project.view?.zoom ?? 1 }),
    [project.id],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultViewport={defaultViewport}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      onNodeDragStop={onNodeDragStop}
      onEdgeClick={onEdgeClick}
      onPaneClick={() => {
        setSelected(undefined);
        closeMenu();
      }}
      onDoubleClick={onPaneDoubleClick}
      onPaneContextMenu={onPaneContextMenu}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onMoveStart={closeMenu}
      onEdgesDelete={(eds) => eds.forEach((e) => void deleteEdge(e.id))}
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
      maxZoom={2.5}
      fitView={project.nodes.length > 0}
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#22252f" />
      <Controls position="bottom-left" />
      <MiniMap
        position="top-right"
        pannable
        zoomable
        style={{ background: '#10131a', border: '1px solid #262a35' }}
        nodeColor={(n) => {
          const d = n.data as unknown as TakeNodeData;
          return d.node?.kind === 'video' ? '#23d5ab' : d.node?.kind === 'text' ? '#ffb020' : '#7c5cff';
        }}
      />
      <ContextMenu menu={menu} onClose={closeMenu} />
    </ReactFlow>
  );
}

export function Canvas() {
  const project = useStore((s) => s.project);
  if (!project) return <div className="empty" style={{ margin: 40 }}>还没有项目——上面点「新建」。</div>;
  return (
    <ReactFlowProvider>
      <Inner project={project} />
    </ReactFlowProvider>
  );
}

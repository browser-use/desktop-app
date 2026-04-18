import React, { useState, useEffect, useCallback, useRef } from 'react';

// ── CDP type definitions ──────────────────────────────────────────────────────

interface CdpPanelProps {
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  subscribeCdp: (listener: (method: string, params: unknown) => void) => () => void;
}

interface CdpNode {
  nodeId: number;
  parentId?: number;
  backendNodeId?: number;
  nodeType: number; // 1=Element, 3=Text, 8=Comment, 9=Document, 10=DocumentType
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: CdpNode[];
  attributes?: string[]; // flat array [name, value, name, value, ...]
}

interface CdpCssProperty {
  name: string;
  value: string;
  disabled?: boolean;
  implicit?: boolean;
}

interface CdpRuleMatch {
  rule: {
    selectorList: { selectors: Array<{ text: string }> };
    style: { cssProperties: CdpCssProperty[] };
  };
}

interface CdpComputedProperty {
  name: string;
  value: string;
}

interface AXPropertyValue {
  value: unknown;
}

interface AXNode {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  properties?: Array<{ name: string; value: AXPropertyValue }>;
  childIds?: string[];
}

// ── Node type constants ───────────────────────────────────────────────────────

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_COMMENT = 8;
const NODE_TYPE_DOCUMENT = 9;
const NODE_TYPE_DOCTYPE = 10;

// ── Sub-tab types ─────────────────────────────────────────────────────────────

type StylesSubTab = 'styles' | 'computed' | 'accessibility';
const STYLES_SUB_TABS: StylesSubTab[] = ['styles', 'computed', 'accessibility'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAttributes(raw: string[] | undefined): Array<{ name: string; value: string }> {
  if (!raw || raw.length === 0) return [];
  const attrs: Array<{ name: string; value: string }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    attrs.push({ name: raw[i], value: raw[i + 1] });
  }
  return attrs;
}

function buildNodeMap(node: CdpNode, map: Map<number, CdpNode>): void {
  map.set(node.nodeId, node);
  if (node.children) {
    for (const child of node.children) buildNodeMap(child, map);
  }
}

function patchChildNodes(root: CdpNode, parentId: number, nodes: CdpNode[]): CdpNode {
  if (root.nodeId === parentId) return { ...root, children: nodes };
  if (!root.children) return root;
  return { ...root, children: root.children.map((c) => patchChildNodes(c, parentId, nodes)) };
}

// ── DomTreeNode component ─────────────────────────────────────────────────────

interface DomTreeNodeProps {
  node: CdpNode;
  depth: number;
  selectedNodeId: number | null;
  expandedNodeIds: Set<number>;
  nodeMap: Map<number, CdpNode>;
  onSelect: (nodeId: number) => void;
  onToggle: (nodeId: number) => void;
}

function DomTreeNode({
  node,
  depth,
  selectedNodeId,
  expandedNodeIds,
  nodeMap,
  onSelect,
  onToggle,
}: DomTreeNodeProps): React.ReactElement | null {
  const isSelected = node.nodeId === selectedNodeId;
  const isExpanded = expandedNodeIds.has(node.nodeId);
  const hasChildren =
    (node.childNodeCount ?? 0) > 0 || (node.children && node.children.length > 0);
  const indent: React.CSSProperties = { paddingLeft: depth * 16 };

  // Document: render children directly, no wrapper row
  if (node.nodeType === NODE_TYPE_DOCUMENT) {
    return (
      <>
        {(node.children ?? []).map((child) => (
          <DomTreeNode
            key={child.nodeId}
            node={child}
            depth={depth}
            selectedNodeId={selectedNodeId}
            expandedNodeIds={expandedNodeIds}
            nodeMap={nodeMap}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </>
    );
  }

  // Text node
  if (node.nodeType === NODE_TYPE_TEXT) {
    const text = node.nodeValue.trim();
    if (!text) return null;
    const display = text.length > 120 ? text.slice(0, 120) + '…' : text;
    return (
      <div
        className="elements-node"
        style={indent}
        data-selected={isSelected ? 'true' : 'false'}
        onClick={() => onSelect(node.nodeId)}
      >
        <span className="elements-toggle" style={{ visibility: 'hidden' }}>▶</span>
        <span className="elements-text-content">"{display}"</span>
      </div>
    );
  }

  // Comment node
  if (node.nodeType === NODE_TYPE_COMMENT) {
    const text = node.nodeValue.slice(0, 80);
    return (
      <div
        className="elements-node"
        style={indent}
        data-selected={isSelected ? 'true' : 'false'}
        onClick={() => onSelect(node.nodeId)}
      >
        <span className="elements-toggle" style={{ visibility: 'hidden' }}>▶</span>
        <span className="elements-comment">{`<!-- ${text} -->`}</span>
      </div>
    );
  }

  // DOCTYPE node
  if (node.nodeType === NODE_TYPE_DOCTYPE) {
    return (
      <div className="elements-node" style={indent}>
        <span className="elements-toggle" style={{ visibility: 'hidden' }}>▶</span>
        <span className="elements-comment">{`<!DOCTYPE ${node.nodeName}>`}</span>
      </div>
    );
  }

  // Skip unknown node types
  if (node.nodeType !== NODE_TYPE_ELEMENT) return null;

  const tagName = node.localName || node.nodeName.toLowerCase();
  const attrs = parseAttributes(node.attributes);
  const children = node.children ?? [];

  return (
    <>
      {/* Opening tag */}
      <div
        className="elements-node"
        style={indent}
        data-selected={isSelected ? 'true' : 'false'}
        onClick={() => onSelect(node.nodeId)}
      >
        {hasChildren ? (
          <span
            className="elements-toggle"
            onClick={(e) => { e.stopPropagation(); onToggle(node.nodeId); }}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className="elements-toggle" style={{ visibility: 'hidden' }}>▶</span>
        )}
        <span className="elements-tag">{'<'}{tagName}</span>
        {attrs.map((attr) => (
          <span key={attr.name}>
            {' '}
            <span className="elements-attr-name">{attr.name}</span>
            {'='}
            <span className="elements-attr-value">
              "{attr.value.length > 60 ? attr.value.slice(0, 60) + '…' : attr.value}"
            </span>
          </span>
        ))}
        {!hasChildren ? (
          <span className="elements-tag">{' />'}</span>
        ) : isExpanded ? (
          <span className="elements-tag">{'>'}</span>
        ) : (
          <span className="elements-tag">
            {'>'}<span style={{ color: 'var(--color-fg-tertiary)' }}> … </span>{'</'}{tagName}{'>'}
          </span>
        )}
      </div>

      {/* Children (rendered only when expanded) */}
      {isExpanded && children.map((child) => (
        <DomTreeNode
          key={child.nodeId}
          node={child}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          expandedNodeIds={expandedNodeIds}
          nodeMap={nodeMap}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}

      {/* Closing tag */}
      {isExpanded && hasChildren && (
        <div
          className="elements-node"
          style={indent}
          data-selected={isSelected ? 'true' : 'false'}
          onClick={() => onSelect(node.nodeId)}
        >
          <span className="elements-toggle" style={{ visibility: 'hidden' }}>▶</span>
          <span className="elements-tag">{'</'}{tagName}{'>'}</span>
        </div>
      )}
    </>
  );
}

// ── StylesPane ────────────────────────────────────────────────────────────────

interface StylesPaneProps {
  nodeId: number | null;
  sendCdp: CdpPanelProps['sendCdp'];
}

function StylesPane({ nodeId, sendCdp }: StylesPaneProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<StylesSubTab>('styles');
  const [matchedRules, setMatchedRules] = useState<CdpRuleMatch[]>([]);
  const [computedProps, setComputedProps] = useState<CdpComputedProperty[]>([]);
  const [axNodes, setAxNodes] = useState<AXNode[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (nodeId === null) {
      setMatchedRules([]);
      setComputedProps([]);
      setAxNodes([]);
      return;
    }

    let stale = false;
    setLoading(true);

    if (activeTab === 'styles') {
      console.log('[ElementsPanel] CSS.getMatchedStylesForNode nodeId:', nodeId);
      void (async () => {
        try {
          const result = (await sendCdp('CSS.getMatchedStylesForNode', { nodeId })) as {
            matchedCSSRules?: CdpRuleMatch[];
          };
          if (stale) return;
          const rules = result?.matchedCSSRules ?? [];
          console.log('[ElementsPanel] matched rules count:', rules.length, 'nodeId:', nodeId);
          setMatchedRules(rules);
        } catch (err) {
          if (stale) return;
          console.error('[ElementsPanel] CSS.getMatchedStylesForNode error nodeId:', nodeId, err);
          setMatchedRules([]);
        } finally {
          if (!stale) setLoading(false);
        }
      })();
    } else if (activeTab === 'computed') {
      console.log('[ElementsPanel] CSS.getComputedStyleForNode nodeId:', nodeId);
      void (async () => {
        try {
          const result = (await sendCdp('CSS.getComputedStyleForNode', { nodeId })) as {
            computedStyle?: CdpComputedProperty[];
          };
          if (stale) return;
          const props = result?.computedStyle ?? [];
          console.log('[ElementsPanel] computed props count:', props.length, 'nodeId:', nodeId);
          setComputedProps(props);
        } catch (err) {
          if (stale) return;
          console.error('[ElementsPanel] CSS.getComputedStyleForNode error nodeId:', nodeId, err);
          setComputedProps([]);
        } finally {
          if (!stale) setLoading(false);
        }
      })();
    } else if (activeTab === 'accessibility') {
      console.log('[ElementsPanel] Accessibility.getFullAXTree nodeId:', nodeId);
      void (async () => {
        try {
          const result = (await sendCdp('Accessibility.getFullAXTree', { nodeId })) as {
            nodes?: AXNode[];
          };
          if (stale) return;
          const nodes = result?.nodes ?? [];
          console.log('[ElementsPanel] AX nodes count:', nodes.length, 'nodeId:', nodeId);
          setAxNodes(nodes);
        } catch (err) {
          if (stale) return;
          console.error('[ElementsPanel] Accessibility.getFullAXTree error nodeId:', nodeId, err);
          setAxNodes([]);
        } finally {
          if (!stale) setLoading(false);
        }
      })();
    }

    return () => { stale = true; };
  }, [nodeId, activeTab, sendCdp]);

  const emptyMsg = (msg: string): React.ReactElement => (
    <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-xs)' }}>{msg}</div>
  );

  const renderStyles = (): React.ReactElement => {
    if (nodeId === null) return emptyMsg('Select an element to view styles.');
    if (loading) return emptyMsg('Loading…');
    if (matchedRules.length === 0) return emptyMsg('No matched CSS rules.');
    return (
      <>
        {matchedRules.map((rm, ruleIdx) => {
          const selectors = rm.rule.selectorList.selectors.map((s) => s.text).join(', ');
          const visibleProps = rm.rule.style.cssProperties.filter(
            (p) => !p.disabled && !p.implicit && p.name && p.value,
          );
          if (visibleProps.length === 0) return null;
          return (
            <div key={ruleIdx} className="elements-style-rule">
              <div className="elements-style-selector">{selectors} {'{'}</div>
              {visibleProps.map((prop, propIdx) => (
                <div key={propIdx} className="elements-style-prop">
                  <span className="elements-style-prop-name">{prop.name}</span>
                  {': '}
                  <span className="elements-style-prop-value">{prop.value}</span>
                  {';'}
                </div>
              ))}
              <div className="elements-style-selector">{'}'}</div>
            </div>
          );
        })}
      </>
    );
  };

  const renderComputed = (): React.ReactElement => {
    if (nodeId === null) return emptyMsg('Select an element to view computed styles.');
    if (loading) return emptyMsg('Loading…');
    if (computedProps.length === 0) return emptyMsg('No computed style properties.');
    return (
      <>
        {computedProps.map((prop, i) => (
          <div key={i} className="elements-style-prop">
            <span className="elements-style-prop-name">{prop.name}</span>
            {': '}
            <span className="elements-style-prop-value">{prop.value}</span>
            {';'}
          </div>
        ))}
      </>
    );
  };

  const renderAccessibility = (): React.ReactElement => {
    if (nodeId === null) return emptyMsg('Select an element to view accessibility info.');
    if (loading) return emptyMsg('Loading…');
    if (axNodes.length === 0) return emptyMsg('No accessibility data available.');
    return (
      <>
        {axNodes.map((axNode) => (
          <div
            key={axNode.nodeId}
            style={{
              marginBottom: 'var(--space-4)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-2xs)',
            }}
          >
            {axNode.role?.value && (
              <div className="elements-style-prop">
                <span className="elements-style-prop-name">role</span>
                {': '}
                <span className="elements-style-prop-value">{axNode.role.value}</span>
              </div>
            )}
            {axNode.name?.value && (
              <div className="elements-style-prop">
                <span className="elements-style-prop-name">name</span>
                {': '}
                <span className="elements-style-prop-value">"{axNode.name.value}"</span>
              </div>
            )}
            {axNode.description?.value && (
              <div className="elements-style-prop">
                <span className="elements-style-prop-name">description</span>
                {': '}
                <span className="elements-style-prop-value">"{axNode.description.value}"</span>
              </div>
            )}
            {(axNode.properties ?? []).map((prop, i) => (
              <div key={i} className="elements-style-prop">
                <span className="elements-style-prop-name">{prop.name}</span>
                {': '}
                <span className="elements-style-prop-value">{String(prop.value.value)}</span>
              </div>
            ))}
          </div>
        ))}
      </>
    );
  };

  return (
    <div
      className="elements-styles"
      style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
    >
      {/* Sub-tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--color-border-default)',
          flexShrink: 0,
        }}
      >
        {STYLES_SUB_TABS.map((tab) => (
          <button
            key={tab}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)',
              color: activeTab === tab ? 'var(--color-accent-default)' : 'var(--color-fg-secondary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab
                ? '2px solid var(--color-accent-default)'
                : '2px solid transparent',
              outline: 'none',
            }}
            onClick={() => {
              console.log('[ElementsPanel] styles sub-tab changed:', tab, 'nodeId:', nodeId);
              setActiveTab(tab);
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-4)' }}>
        {activeTab === 'styles' && (
          <>
            <div className="elements-styles-header">Matched Rules</div>
            {renderStyles()}
          </>
        )}
        {activeTab === 'computed' && (
          <>
            <div className="elements-styles-header">Computed Styles</div>
            {renderComputed()}
          </>
        )}
        {activeTab === 'accessibility' && (
          <>
            <div className="elements-styles-header">Accessibility</div>
            {renderAccessibility()}
          </>
        )}
      </div>
    </div>
  );
}

// ── ElementsPanel (main export) ───────────────────────────────────────────────

export function ElementsPanel({ sendCdp, subscribeCdp }: CdpPanelProps): React.ReactElement {
  const [rootNode, setRootNode] = useState<CdpNode | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<number, CdpNode>>(() => new Map());
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<number>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Stable ref so CDP event callbacks can read current root without stale closure
  const rootNodeRef = useRef<CdpNode | null>(null);
  rootNodeRef.current = rootNode;

  const fetchDocument = useCallback(async () => {
    console.log('[ElementsPanel] DOM.enable + CSS.enable, calling DOM.getDocument');
    setLoading(true);
    setFetchError(null);

    try {
      await sendCdp('DOM.enable');
      await sendCdp('CSS.enable');

      const result = (await sendCdp('DOM.getDocument', { depth: 2, pierce: true })) as {
        root?: CdpNode;
      };

      const root = result?.root;
      if (!root) {
        console.warn('[ElementsPanel] DOM.getDocument returned no root');
        setFetchError('No DOM data returned');
        setLoading(false);
        return;
      }

      console.log('[ElementsPanel] DOM root nodeId:', root.nodeId, 'nodeName:', root.nodeName);

      const map = new Map<number, CdpNode>();
      buildNodeMap(root, map);

      // Auto-expand document + first two levels of element children
      const initialExpanded = new Set<number>();
      initialExpanded.add(root.nodeId);
      if (root.children) {
        for (const child of root.children) {
          if (child.nodeType === NODE_TYPE_ELEMENT) {
            initialExpanded.add(child.nodeId);
            if (child.children) {
              for (const gc of child.children) {
                if (gc.nodeType === NODE_TYPE_ELEMENT) initialExpanded.add(gc.nodeId);
              }
            }
          }
        }
      }

      setRootNode(root);
      setNodeMap(map);
      setExpandedNodeIds(initialExpanded);
    } catch (err) {
      console.error('[ElementsPanel] fetchDocument error:', err);
      setFetchError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sendCdp]);

  useEffect(() => {
    void fetchDocument();

    const unsubscribe = subscribeCdp((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Page.loadEventFired' || method === 'DOM.documentUpdated') {
        console.log('[ElementsPanel] page/document updated, re-fetching. method:', method);
        void fetchDocument();
        return;
      }

      // Merge lazily-loaded child nodes pushed by CDP after DOM.requestChildNodes
      if (method === 'DOM.setChildNodes') {
        const parentId = p.parentId as number;
        const nodes = p.nodes as CdpNode[];
        console.log('[ElementsPanel] DOM.setChildNodes parentId:', parentId, 'count:', nodes.length);
        setRootNode((prevRoot) => {
          if (!prevRoot) return prevRoot;
          const newRoot = patchChildNodes(prevRoot, parentId, nodes);
          const newMap = new Map<number, CdpNode>();
          buildNodeMap(newRoot, newMap);
          setNodeMap(newMap);
          return newRoot;
        });
      }
    });

    return () => {
      unsubscribe();
      void sendCdp('CSS.disable').catch(() => {});
      void sendCdp('DOM.disable').catch(() => {});
    };
  }, [fetchDocument, subscribeCdp, sendCdp]);

  const handleToggle = useCallback(
    async (nodeId: number): Promise<void> => {
      const alreadyExpanded = expandedNodeIds.has(nodeId);

      if (alreadyExpanded) {
        console.log('[ElementsPanel] collapsing nodeId:', nodeId);
        setExpandedNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        return;
      }

      // Request children from CDP if they haven't been loaded yet
      const node = nodeMap.get(nodeId);
      const childrenLoaded = node?.children && node.children.length > 0;
      if (node && !childrenLoaded && (node.childNodeCount ?? 0) > 0) {
        console.log(
          '[ElementsPanel] DOM.requestChildNodes nodeId:',
          nodeId,
          'childNodeCount:',
          node.childNodeCount,
        );
        try {
          await sendCdp('DOM.requestChildNodes', { nodeId, depth: 1, pierce: true });
        } catch (err) {
          console.error('[ElementsPanel] DOM.requestChildNodes error nodeId:', nodeId, err);
        }
      }

      console.log('[ElementsPanel] expanding nodeId:', nodeId);
      setExpandedNodeIds((prev) => {
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      });
    },
    [expandedNodeIds, nodeMap, sendCdp],
  );

  const handleSelect = useCallback((nodeId: number): void => {
    console.log('[ElementsPanel] node selected nodeId:', nodeId);
    setSelectedNodeId(nodeId);
  }, []);

  if (loading) {
    return (
      <div className="elements-panel" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-sm)' }}>
          Loading DOM…
        </div>
      </div>
    );
  }

  if (fetchError || !rootNode) {
    return (
      <div
        className="elements-panel"
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <div style={{ color: 'var(--color-fg-tertiary)', fontSize: 'var(--font-size-sm)' }}>
          {fetchError ?? 'No DOM data'}
        </div>
        <button
          style={{
            padding: 'var(--space-2) var(--space-6)',
            background: 'var(--color-accent-default)',
            color: 'var(--color-fg-inverse)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-xs)',
            cursor: 'pointer',
            border: 'none',
          }}
          onClick={() => void fetchDocument()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="elements-panel">
      {/* Left pane: collapsible DOM tree */}
      <div className="elements-tree">
        <DomTreeNode
          node={rootNode}
          depth={0}
          selectedNodeId={selectedNodeId}
          expandedNodeIds={expandedNodeIds}
          nodeMap={nodeMap}
          onSelect={handleSelect}
          onToggle={(nodeId) => { void handleToggle(nodeId); }}
        />
      </div>

      {/* Right pane: Styles / Computed / Accessibility */}
      <StylesPane nodeId={selectedNodeId} sendCdp={sendCdp} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Panel,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { BaseNode, BaseNodeContent, BaseNodeFooter, BaseNodeHeader, BaseNodeHeaderTitle } from '@/components/base-node'

import manifest from './data/workflow-manifest.generated.json'
import type { ManifestNode, WorkflowManifest } from './types/workflow'

type ManifestNodeData = ManifestNode & {
  label: string
  sectionId: string
  sectionTitle: string
  path: string
} & Record<string, unknown>

type FlowSectionData = {
  title: string
  sectionId: string
  parentSectionId?: string
  formType?: string
  count: number
  path?: string
  sectionTitle?: string
} & Record<string, unknown>

type FlowNodeType = 'screenshotNode' | 'group'
type FlowNode = Node<ManifestNodeData | FlowSectionData, FlowNodeType>
type FlowEdge = Edge

type ScreenshotNodeProps = NodeProps<Node<ManifestNodeData, 'screenshotNode'>>
type SectionNodeProps = NodeProps<Node<FlowSectionData, 'group'>>

type FormContextGroup = {
  contextKey: string
  contextLabel: string
  nodes: FlowNode[]
  hasNew: boolean
  hasEdit: boolean
}

const workflow = manifest as unknown as WorkflowManifest

const NODE_WIDTH = 420
const NODE_IMAGE_CONTAINER_PADDING = 24
const NODE_IMAGE_WIDTH = NODE_WIDTH - NODE_IMAGE_CONTAINER_PADDING
const NODE_HEADER_HEIGHT = 34
const NODE_CONTENT_PADDING = 24
const NODE_FOOTER_GAP = 8
const SECTION_PADDING = 24
const SUBGROUP_PADDING = 16
const SUBGROUP_HEADER_HEIGHT = 28
const SUBGROUP_MARGIN_Y = 20
const SECTION_HEADER_HEIGHT = 34
const SECTION_MARGIN_X = 220
const SECTION_MARGIN_Y = 180
const SUBGROUP_GRID_COLUMNS = 3
const SUBGROUP_GRID_SPACING_X = 60
const SUBGROUP_GRID_SPACING_Y = 60
const SECTION_LAYOUT_ROWS = [['homepage', 'auth', 'other'], ['tasks', 'intervals', 'flashcards', 'tracking', 'journal']] as const

const SECOND_ROW_GROUP_PALETTE: Record<
  (typeof SECTION_LAYOUT_ROWS)[1][number],
  { bg: string; border: string; divider: string; title: string; body: string }
> = {
  tasks: {
    bg: 'rgba(59, 130, 246, 0.16)',
    border: '#3b82f6',
    divider: 'rgba(59, 130, 246, 0.6)',
    title: '#bfdbfe',
    body: '#dbeafe',
  },
  intervals: {
    bg: 'rgba(168, 85, 247, 0.16)',
    border: '#a855f7',
    divider: 'rgba(168, 85, 247, 0.6)',
    title: '#e9d5ff',
    body: '#f3e8ff',
  },
  flashcards: {
    bg: 'rgba(16, 185, 129, 0.16)',
    border: '#10b981',
    divider: 'rgba(16, 185, 129, 0.6)',
    title: '#a7f3d0',
    body: '#d1fae5',
  },
  tracking: {
    bg: 'rgba(251, 191, 36, 0.16)',
    border: '#f59e0b',
    divider: 'rgba(251, 191, 36, 0.6)',
    title: '#fde68a',
    body: '#fef3c7',
  },
  journal: {
    bg: 'rgba(239, 68, 68, 0.16)',
    border: '#ef4444',
    divider: 'rgba(239, 68, 68, 0.6)',
    title: '#fecaca',
    body: '#fee2e2',
  },
}

const DEFAULT_GROUP_PALETTE: { bg: string; border: string; divider: string; title: string; body: string } = {
  bg: 'rgba(39, 39, 42, 0.55)',
  border: '#52525b',
  divider: 'rgba(82, 82, 91, 0.75)',
  title: '#f4f4f5',
  body: '#d4d4d8',
}

function isSecondRowSection(sectionId: string): sectionId is keyof typeof SECOND_ROW_GROUP_PALETTE {
  return sectionId in SECOND_ROW_GROUP_PALETTE
}

function getSectionPalette(sectionId: string) {
  return isSecondRowSection(sectionId) ? SECOND_ROW_GROUP_PALETTE[sectionId] : DEFAULT_GROUP_PALETTE
}

const SECTION_DEFS = [
  { id: 'homepage', title: 'Homepage', match: (path: string) => path === '/' || path === '/landing' },
  {
    id: 'auth',
    title: 'Auth',
    match: (path: string) => path.startsWith('/auth') || path.startsWith('/forgot-password') || path.startsWith('/reset-password') || path.startsWith('/verify-email'),
  },
  { id: 'tasks', title: 'Tasks', match: (path: string) => path.startsWith('/tasks') },
  { id: 'intervals', title: 'Intervals', match: (path: string) => path.startsWith('/intervals') },
  { id: 'flashcards', title: 'Flashcards', match: (path: string) => path.startsWith('/flashcards') },
  { id: 'tracking', title: 'Tracking', match: (path: string) => path.startsWith('/tracking') },
  { id: 'journal', title: 'Journal', match: (path: string) => path.startsWith('/journal') },
] as const

const SECTION_ORDER = [...SECTION_DEFS.map((s) => s.id), 'other']
const OTHER_SECTION = { id: 'other', title: 'Other' } as const

function nodeLabel(routePath: string, title: string): string {
  return `${title}\n${routePath}`
}

function resolveSection(routePath: string, title: string) {
  const normalizedPath = routePath.toLowerCase()
  const normalizedTitle = (title || '').toLowerCase()

  for (const section of SECTION_DEFS) {
    if (section.match(normalizedPath)) return section
  }

  if (normalizedTitle.includes('account') || normalizedTitle.includes('settings')) return OTHER_SECTION
  if (normalizedPath.includes('home')) return getSectionDefById('homepage')

  return OTHER_SECTION
}

function formatTimestamp(value?: string | null): string {
  if (!value) return 'Awaiting screenshot'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Invalid timestamp'
  return `Updated ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
}

type FormNodeMode = 'New' | 'Edit' | 'Routes'

function getFormNodeMode(routePath: string): FormNodeMode {
  const normalizedPath = routePath.toLowerCase()
  if (normalizedPath.endsWith('/new')) return 'New'
  if (normalizedPath.match(/\/[^/]+\/edit$/)) return 'Edit'
  return 'Routes'
}

function getFormContextId(routePath: string): string | null {
  const normalizedPath = routePath.toLowerCase()

  if (normalizedPath.endsWith('/new')) {
    return normalizedPath.replace(/\/new$/, '')
  }

  const editMatch = normalizedPath.match(/^(.*)\/[^/]+\/edit$/)
  return editMatch ? editMatch[1] : null
}

function getFormContextLabel(title: string): string {
  const normalizedTitle = title.trim()
  const withoutMode = normalizedTitle.replace(/^(new|edit)\s+/i, '').trim()
  return withoutMode || normalizedTitle
}

function getFormSubGroupTitle(contextLabel: string, hasNew: boolean, hasEdit: boolean): string {
  if (hasNew && hasEdit) return `New/Edit ${contextLabel}`
  if (hasNew) return `New ${contextLabel}`
  if (hasEdit) return `Edit ${contextLabel}`
  return contextLabel
}

function sanitizeGroupId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

type ScreenshotDimensions = {
  width: number
  height: number
}

const screenshotDimensionCache = new Map<string, Promise<ScreenshotDimensions>>()

function getScreenshotDimensions(path: string): Promise<ScreenshotDimensions> {
  const existing = screenshotDimensionCache.get(path)
  if (existing) return existing

  const next = new Promise<ScreenshotDimensions>((resolve) => {
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight })
      } else {
        resolve({ width: 0, height: 0 })
      }
    }
    img.onerror = () => {
      resolve({ width: 0, height: 0 })
    }
    img.src = path
  })

  screenshotDimensionCache.set(path, next)
  return next
}

async function getScreenshotDimensionsForNodes(nodes: FlowNode[]): Promise<Map<string, ScreenshotDimensions>> {
  const screenshotNodes = nodes.filter((node) => node.type === 'screenshotNode')
  const uniquePaths = new Set(
    screenshotNodes
      .map((node) => (node as Node<ManifestNodeData>).data.screenshotPath)
      .filter((path): path is string => Boolean(path)),
  )
  const entries = await Promise.all(
    [...uniquePaths].map(async (path) => [path, await getScreenshotDimensions(path)] as const),
  )

  return new Map(entries)
}

function nodeHasFooter(data: ManifestNodeData) {
  return Boolean(data.status || data.screenshotUpdatedAt || data.capturedAt)
}

function getImageHeight(data: ManifestNodeData, screenshotDimensions: Map<string, ScreenshotDimensions>): number {
  const measured = screenshotDimensions.get(data.screenshotPath)
  if (measured?.width && measured?.height) {
    return Math.round((NODE_IMAGE_WIDTH * measured.height) / measured.width)
  }

  if (data.width && data.height && data.width > 0 && data.height > 0) {
    return Math.round((NODE_IMAGE_WIDTH * data.height) / data.width)
  }

  return Math.round(NODE_IMAGE_WIDTH * 0.5625)
}

function getScreenshotNodeHeight(data: ManifestNodeData, screenshotDimensions: Map<string, ScreenshotDimensions>): number {
  const footerHeight = nodeHasFooter(data) ? 16 : 0
  const footerGap = nodeHasFooter(data) ? NODE_FOOTER_GAP : 0
  const imageHeight = Math.max(160, getImageHeight(data, screenshotDimensions))

  return NODE_HEADER_HEIGHT + NODE_CONTENT_PADDING + imageHeight + footerGap + footerHeight
}

function getScreenshotNodeSize(data: ManifestNodeData, screenshotDimensions: Map<string, ScreenshotDimensions>) {
  return {
    width: NODE_WIDTH,
    height: getScreenshotNodeHeight(data, screenshotDimensions),
  }
}

function getScreenshotNodeLayoutMeta(data: ManifestNodeData, index: number, screenshotDimensions: Map<string, ScreenshotDimensions>) {
  const { width, height } = getScreenshotNodeSize(data, screenshotDimensions)
  return {
    nodeWidth: width,
    nodeHeight: height,
    defaultPoint: {
      x: (index % SUBGROUP_GRID_COLUMNS) * (NODE_WIDTH + SUBGROUP_GRID_SPACING_X),
      y: Math.floor(index / SUBGROUP_GRID_COLUMNS) * (height + SUBGROUP_GRID_SPACING_Y),
    },
  }
}

function getSubgroupFallbackLayoutPositions(
  groupedNodeMeta: Array<{
    nodeId: string
    index: number
    nodeWidth: number
    nodeHeight: number
    defaultPoint: { x: number; y: number }
  }>,
) {
  const rows = new Map<number, number>()

  groupedNodeMeta.forEach((entry) => {
    const row = Math.floor(entry.index / SUBGROUP_GRID_COLUMNS)
    const currentHeight = rows.get(row) ?? 0
    rows.set(row, Math.max(currentHeight, entry.nodeHeight))
  })

  const rowOffsets: number[] = []
  let cumulativeY = 0
  for (let row = 0; row < rows.size; row += 1) {
    const rowHeight = rows.get(row) ?? 0
    rowOffsets[row] = cumulativeY
    cumulativeY += rowHeight + SUBGROUP_GRID_SPACING_Y
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const entry of groupedNodeMeta) {
    const column = entry.index % SUBGROUP_GRID_COLUMNS
    const row = Math.floor(entry.index / SUBGROUP_GRID_COLUMNS)
    positions.set(entry.nodeId, {
      x: column * (NODE_WIDTH + SUBGROUP_GRID_SPACING_X),
      y: rowOffsets[row] ?? 0,
    })
  }

  return positions
}

function getSectionDefById(sectionId: string) {
  return SECTION_DEFS.find((section) => section.id === sectionId) || OTHER_SECTION
}

function buildSectionedNodes(nodes: FlowNode[]) {
  const grouped = new Map<string, FlowNode[]>()
  for (const sectionId of SECTION_ORDER) grouped.set(sectionId, [])

  for (const node of nodes) {
    const section = (node.data as ManifestNodeData).sectionId
    const list = grouped.get(section) ?? []
    list.push(node)
    grouped.set(section, list)
  }

  return grouped
}

function ScreenshotNode({ data }: ScreenshotNodeProps) {
  return (
    <BaseNode className="w-[420px]">
      <BaseNodeHeader>
        <BaseNodeHeaderTitle>{data.title}</BaseNodeHeaderTitle>
      </BaseNodeHeader>
      <BaseNodeContent>
        <img
          className="h-auto w-full rounded border border-zinc-700 object-cover"
          src={data.screenshotPath}
          alt={data.label}
          onError={(event) => {
            event.currentTarget.src = '/brand/backontrack-wordmark.png'
          }}
        />
        {(data.status || data.screenshotUpdatedAt || data.capturedAt) ? (
          <BaseNodeFooter className="border-none p-0 pt-1">
            <p className="text-xs text-zinc-400">
              {data.status === 'captured'
                ? formatTimestamp(data.screenshotUpdatedAt ?? data.capturedAt)
                : data.status}
            </p>
          </BaseNodeFooter>
        ) : null}
      </BaseNodeContent>
    </BaseNode>
  )
}

function SectionGroupNode({ data }: SectionNodeProps) {
  const palette = getSectionPalette(data.sectionId)

  return (
    <div
      className="h-full w-full rounded-lg p-2 text-xs"
      style={{
        color: palette ? palette.body : '#d4d4d8',
      }}
    >
      <div
        className="mb-2 border-b pb-2 font-semibold"
        style={{
          borderColor: palette.divider,
          color: palette.title,
        }}
      >
        {data.title} · {data.count} routes
      </div>
    </div>
  )
}

const nodeTypes: NodeTypes = {
  screenshotNode: ScreenshotNode,
  group: SectionGroupNode,
}

function buildNodes(): FlowNode[] {
  return workflow.nodes.map((node) => {
    const routePath = node.statePath || node.path
    const section = resolveSection(routePath, node.title)

    return {
      id: node.id,
      type: 'screenshotNode',
      data: {
        ...node,
        label: nodeLabel(routePath, node.title),
        path: routePath,
        sectionId: section.id,
        sectionTitle: section.title,
      },
    style: getScreenshotNodeSize({
      ...node,
      label: nodeLabel(routePath, node.title),
      path: routePath,
      sectionId: section.id,
      sectionTitle: section.title,
    }, new Map()),
      position: { x: 0, y: 0 },
    }
  })
}

function buildEdges(): FlowEdge[] {
  return []
}

async function applyElkLayout(nodes: FlowNode[], edges: FlowEdge[]): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
  const elk = new ELK()
  const screenshotDimensions = await getScreenshotDimensionsForNodes(nodes)
  const grouped = buildSectionedNodes(nodes)

  const sectionEntries = SECTION_ORDER
    .map((sectionId) => ({
      sectionId,
      nodes: grouped.get(sectionId) ?? [],
      def: getSectionDefById(sectionId),
    }))
    .filter((entry) => entry.nodes.length > 0)

  const groupedSectionNodes: FlowNode[] = []
  const layoutedLeafNodes: FlowNode[] = []
  const placedSections = new Set<string>()
  const rows = [
    ...SECTION_LAYOUT_ROWS.map((row) => row.filter((sectionId) => {
      const exists = sectionEntries.some((entry) => entry.sectionId === sectionId)
      if (exists) {
        placedSections.add(sectionId)
      }
      return exists
    })),
    ...sectionEntries
      .filter((entry) => !placedSections.has(entry.sectionId))
      .map((entry) => [entry.sectionId]),
  ].filter((row) => row.length > 0)

  let cursorY = 0

  for (const sectionRow of rows) {
    let cursorX = 0
    let rowHeight = 0
    for (const sectionId of sectionRow) {
      const sectionEntry = sectionEntries.find((entry) => entry.sectionId === sectionId)
      if (!sectionEntry) continue

      const { nodes: sectionNodes, def: sectionDef } = sectionEntry
      const sectionNodeIds = new Set(sectionNodes.map((node) => node.id))
      const sectionEdges = edges.filter((edge) => sectionNodeIds.has(edge.source) && sectionNodeIds.has(edge.target))
      const sectionGroupId = `section-group-${sectionId}`
      const formContextGroups = new Map<string, FormContextGroup>()
      const formContextOrder: string[] = []
      const routeNodes: FlowNode[] = []

      for (const sectionNode of sectionNodes) {
        const sectionNodeData = sectionNode.data as ManifestNodeData
        const formMode = getFormNodeMode(sectionNodeData.path)
        const contextId = getFormContextId(sectionNodeData.path)

        if (formMode === 'Routes' || !contextId) {
          routeNodes.push(sectionNode)
          continue
        }

        const nextGroup = formContextGroups.get(contextId)
        const contextLabel = getFormContextLabel(sectionNodeData.title)
        const isNew = formMode === 'New'
        const isEdit = formMode === 'Edit'

        if (!nextGroup) {
          formContextOrder.push(contextId)
          formContextGroups.set(contextId, {
            contextKey: contextId,
            contextLabel,
            nodes: [sectionNode],
            hasNew: isNew,
            hasEdit: isEdit,
          })
          continue
        }

        nextGroup.nodes.push(sectionNode)
        if (isNew) nextGroup.hasNew = true
        if (isEdit) nextGroup.hasEdit = true
      }

      let sectionWidth = 0
      let sectionHeight = 0
      const sectionChildren: FlowNode[] = []
      const sectionGroupChildren: FlowNode[] = []

      let sectionCursorY = 0
      let sectionMaxWidth = 0
      let sectionMaxHeight = 0
      const orderedFormGroups: Array<
        FormContextGroup & {
          id: string
          title: string
        }
      > = formContextOrder.map((contextKey) => {
        const group = formContextGroups.get(contextKey)
        if (!group) throw new Error(`Missing form context group for ${contextKey}`)

        return {
          ...group,
          id: sanitizeGroupId(contextKey),
          title: getFormSubGroupTitle(group.contextLabel, group.hasNew, group.hasEdit),
        }
      })

      if (routeNodes.length > 0) {
        const routeNodeIds = new Set(routeNodes.map((node) => node.id))
        const routeEdges = sectionEdges.filter((edge) => routeNodeIds.has(edge.source) && routeNodeIds.has(edge.target))
        const routePositionMap = new Map<string, { x: number; y: number }>()
        const routeNodeMeta = routeNodes.map((node, index) => ({
          nodeId: node.id,
          index,
          ...getScreenshotNodeLayoutMeta(node.data as ManifestNodeData, index, screenshotDimensions),
        }))

        if (routeNodes.length === 1 || routeEdges.length === 0) {
          const routePositions = getSubgroupFallbackLayoutPositions(routeNodeMeta)
          for (const { nodeId } of routeNodeMeta) {
            const fallbackPoint = routePositions.get(nodeId)
            if (!fallbackPoint) continue
            routePositionMap.set(nodeId, fallbackPoint)
          }
        } else {
          const layout = await elk.layout({
            id: `section-${sectionId}-routes`,
          layoutOptions: {
              'elk.algorithm': 'layered',
              'elk.direction': 'DOWN',
              'elk.spacing.nodeNodeBetweenLayers': '80',
              'elk.layered.spacing.nodeNodeBetweenLayers': '90',
              'elk.layered.spacing.nodeNode': '40',
              'elk.spacing.edgeNodeBetweenLayers': '60',
          },
          children: routeNodes.map((node) => ({
            id: node.id,
            ...((node.type === 'screenshotNode')
              ? getScreenshotNodeSize(node.data as ManifestNodeData, screenshotDimensions)
              : { width: NODE_WIDTH, height: NODE_WIDTH }),
          })),
          edges: routeEdges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
          })),
          })

          for (const child of layout.children || []) {
            if (child.x === undefined || child.y === undefined) continue
            routePositionMap.set(child.id, { x: child.x, y: child.y })
          }
        }

        let routeMaxX = 0
        let routeMaxY = 0
        const routesPlaced = routeNodes.map((node, idx) => {
          const pointSize = routeNodeMeta[idx]
          const point = routePositionMap.get(node.id) || {
            x: pointSize.defaultPoint.x,
            y: pointSize.defaultPoint.y,
          }

          routeMaxX = Math.max(routeMaxX, point.x + pointSize.nodeWidth)
          routeMaxY = Math.max(routeMaxY, point.y + pointSize.nodeHeight)

          return {
            ...node,
            style: getScreenshotNodeSize(node.data as ManifestNodeData, screenshotDimensions),
            position: point,
          }
        })

        routeMaxX = Math.max(480, routeMaxX)
        routeMaxY = Math.max(240, routeMaxY)

        for (const node of routesPlaced) {
          sectionChildren.push({
            ...node,
            parentId: sectionGroupId,
            extent: 'parent',
            position: {
              x: node.position.x + SECTION_PADDING,
              y: node.position.y + SECTION_HEADER_HEIGHT + SECTION_PADDING,
            },
          })
        }

        sectionCursorY += routeMaxY + SUBGROUP_MARGIN_Y
        sectionMaxWidth = Math.max(sectionMaxWidth, SECTION_PADDING + routeMaxX)
        sectionMaxHeight = Math.max(sectionMaxHeight, SECTION_HEADER_HEIGHT + SECTION_PADDING + routeMaxY)
      }

      for (const formGroup of orderedFormGroups) {
        const { nodes: groupedNodes, title: groupTitle, id: groupId } = formGroup

        if (groupedNodes.length === 0) {
          continue
        }

        const subgroupNodeIds = new Set(groupedNodes.map((node) => node.id))
        const subgroupEdges = sectionEdges.filter((edge) => subgroupNodeIds.has(edge.source) && subgroupNodeIds.has(edge.target))
        const subgroupPositionMap = new Map<string, { x: number; y: number }>()
        const groupedNodeMeta = groupedNodes.map((node, index) => ({
          nodeId: node.id,
          index,
          ...getScreenshotNodeLayoutMeta(node.data as ManifestNodeData, index, screenshotDimensions),
        }))

        if (groupedNodes.length === 1 || subgroupEdges.length === 0) {
          const positions = getSubgroupFallbackLayoutPositions(groupedNodeMeta)
          for (const { nodeId } of groupedNodeMeta) {
            const fallbackPoint = positions.get(nodeId)
            if (!fallbackPoint) continue
            subgroupPositionMap.set(nodeId, fallbackPoint)
          }
        } else {
          const layout = await elk.layout({
            id: `section-${sectionId}-${groupId}`,
          layoutOptions: {
              'elk.algorithm': 'layered',
              'elk.direction': 'DOWN',
              'elk.spacing.nodeNodeBetweenLayers': '80',
              'elk.layered.spacing.nodeNodeBetweenLayers': '90',
              'elk.layered.spacing.nodeNode': '40',
              'elk.spacing.edgeNodeBetweenLayers': '60',
          },
          children: groupedNodes.map((node) => ({
            id: node.id,
            ...((node.type === 'screenshotNode')
              ? getScreenshotNodeSize(node.data as ManifestNodeData, screenshotDimensions)
              : { width: NODE_WIDTH, height: NODE_WIDTH }),
          })),
          edges: subgroupEdges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
          })),
          })

          for (const child of layout.children || []) {
            if (child.x === undefined || child.y === undefined) continue
            subgroupPositionMap.set(child.id, { x: child.x, y: child.y })
          }
        }

        let subgroupMaxX = 0
        let subgroupMaxY = 0
        const subgroupPlaced = groupedNodes.map((node, idx) => {
          const pointSize = groupedNodeMeta[idx]
          const point = subgroupPositionMap.get(node.id) || {
            x: pointSize.defaultPoint.x,
            y: pointSize.defaultPoint.y,
          }

          subgroupMaxX = Math.max(subgroupMaxX, point.x + pointSize.nodeWidth)
          subgroupMaxY = Math.max(subgroupMaxY, point.y + pointSize.nodeHeight)

          return {
            ...node,
            style: getScreenshotNodeSize(node.data as ManifestNodeData, screenshotDimensions),
            position: point,
          }
        })

        const subgroupWidth = Math.max(500, subgroupMaxX + SUBGROUP_PADDING * 2)
        const subgroupHeight = Math.max(240, subgroupMaxY + SUBGROUP_PADDING * 2 + SUBGROUP_HEADER_HEIGHT)
        const groupY = SECTION_HEADER_HEIGHT + SECTION_PADDING + sectionCursorY
        const groupX = SECTION_PADDING
        const subgroupId = `${sectionGroupId}-${groupId}`

        sectionGroupChildren.push({
          id: subgroupId,
          type: 'group',
          data: {
            title: groupTitle,
            sectionId,
            parentSectionId: sectionId,
            formType: groupTitle,
            count: groupedNodes.length,
          },
          parentId: sectionGroupId,
          extent: 'parent',
          style: {
            ...(() => {
              const palette = getSectionPalette(sectionId)
              return {
                backgroundColor: palette.bg,
                borderColor: palette.border,
                border: '1px solid',
                color: palette.body,
              }
            })(),
            width: subgroupWidth,
            height: subgroupHeight,
          },
          position: { x: groupX, y: groupY },
        })

        for (const node of subgroupPlaced) {
          sectionChildren.push({
            ...node,
            parentId: subgroupId,
            extent: 'parent',
            position: {
              x: node.position.x + SUBGROUP_PADDING,
              y: node.position.y + SUBGROUP_HEADER_HEIGHT + SUBGROUP_PADDING,
            },
          })
        }

        sectionCursorY += subgroupHeight + SUBGROUP_MARGIN_Y
        sectionMaxWidth = Math.max(sectionMaxWidth, groupX + subgroupWidth)
        sectionMaxHeight = Math.max(sectionMaxHeight, groupY + subgroupHeight)
      }

      sectionWidth = Math.max(560, sectionMaxWidth + SECTION_PADDING)
      sectionHeight = Math.max(320, sectionMaxHeight + SECTION_PADDING)

      const sectionStyle = {
        ...(() => {
          const palette = getSectionPalette(sectionId)
          return {
            backgroundColor: palette.bg,
            borderColor: palette.border,
            border: '1px solid',
            color: palette.body,
          }
        })(),
      }

      const sectionX = cursorX
      const sectionY = cursorY

      const sectionNode: FlowNode = {
        id: sectionGroupId,
        type: 'group',
        data: {
          title: `${sectionDef.title}`,
          sectionId,
          count: sectionNodes.length,
        },
        style: {
          ...sectionStyle,
          width: sectionWidth,
          height: sectionHeight,
        },
        position: { x: sectionX, y: sectionY },
      }

      groupedSectionNodes.push(sectionNode)
      sectionGroupChildren.forEach((node) => {
        groupedSectionNodes.push(node)
      })
      layoutedLeafNodes.push(...sectionChildren)

      cursorX += sectionWidth + SECTION_MARGIN_X
      rowHeight = Math.max(rowHeight, sectionHeight)
    }
    cursorY += rowHeight + SECTION_MARGIN_Y
  }

  const positionedNodes = [...groupedSectionNodes, ...layoutedLeafNodes]
  return { nodes: positionedNodes, edges }
}

export default function App() {
  const initialNodes = useMemo(() => buildNodes(), [])
  const initialEdges = useMemo(() => buildEdges(), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initialEdges)
  const [isLoading, setIsLoading] = useState(true)
  const flowRef = useRef<any>(null)
  const isLayoutReady = useRef(false)
  const pendingFit = useRef(false)
  const [draggingLabel, setDraggingLabel] = useState<string | null>(null)

  const finishRender = useCallback(() => {
    if (!isLayoutReady.current || !flowRef.current) return false

    requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.1, maxZoom: 1.2 })
      requestAnimationFrame(() => {
        setIsLoading(false)
      })
    })
    return true
  }, [])

  const onFlowInit = useCallback((instance: any) => {
    flowRef.current = instance
    if (isLayoutReady.current && pendingFit.current) {
      pendingFit.current = false
      finishRender()
    }
  }, [])

  const handleNodeDragStart = useCallback((_event: unknown, node: FlowNode) => {
    const data = node.data as Partial<ManifestNodeData & FlowSectionData>
    const nodeType = node.type === 'group' ? 'Group' : 'Node'
    const label = data.title || data.label || node.id
    setDraggingLabel(`${nodeType}: ${label}`)
  }, [])

  const handleNodeDragStop = useCallback(() => {
    setDraggingLabel(null)
  }, [])

  const handleFitView = useCallback(() => {
    flowRef.current?.fitView({ padding: 0.1, maxZoom: 1.2 })
  }, [])

  const handleReset = useCallback(() => {
    flowRef.current?.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 })
  }, [])

  useEffect(() => {
    let cancelled = false
    isLayoutReady.current = false
    setIsLoading(true)

    applyElkLayout(initialNodes, initialEdges)
      .then((layouted) => {
        if (!cancelled) {
          setNodes(layouted.nodes)
          setEdges(layouted.edges)
          isLayoutReady.current = true
          pendingFit.current = true

          if (finishRender()) {
            pendingFit.current = false
          }
        }
      })
      .catch((error) => {
        console.error('Failed to apply ELK layout', error)
        isLayoutReady.current = false
        setNodes(initialNodes)
        setEdges(initialEdges)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
      isLayoutReady.current = false
    }
  }, [finishRender, initialNodes, initialEdges, setEdges, setNodes])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-zinc-950 text-zinc-100">
      <header className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <h1 className="text-2xl font-semibold text-zinc-100">BackOnTrack Workflow Atlas</h1>
        <p className="text-sm text-zinc-300">Playwright snapshots · React Flow nodes · ELK layered layout</p>
      </header>
      <main className="relative min-h-0 flex-1">
        {isLoading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/90">
            <div className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow">
              Loading graph…
            </div>
          </div>
        ) : null}
        <ReactFlow
          className="h-full w-full"
          fitView
          minZoom={0.1}
          colorMode="dark"
          snapToGrid
          snapGrid={[20, 20]}
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
          onInit={onFlowInit}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          attributionPosition="bottom-left"
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          selectNodesOnDrag={false}
        >
          <Background variant={BackgroundVariant.Dots} color="#2b2b2b" gap={20} size={1.5} />
          <MiniMap
            pannable
            zoomable
            nodeColor="#d4d4d8"
            nodeStrokeColor="#8b8b8b"
            bgColor="#111111"
            maskColor="rgba(0, 0, 0, 0.55)"
            style={{
              border: '1px solid #3f3f46',
              borderRadius: '8px',
            }}
          />
          <Panel position="bottom-left">
            {draggingLabel ? (
              <span className="mr-3 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200">
                Dragging {draggingLabel}
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleFitView}
              className="mr-2 rounded border border-zinc-600 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800"
            >
              Fit View
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              Reset
            </button>
          </Panel>
        </ReactFlow>
      </main>
    </div>
  )
}
